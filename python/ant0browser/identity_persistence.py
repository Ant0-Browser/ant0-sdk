"""Device-local, atomic persistence for canonical synthetic identities."""

import copy
import datetime
import hashlib
import hmac
import json
import os
import re
import secrets
from pathlib import Path
from typing import Any, Collection, Dict, Optional, TypedDict

from ._errors import Coded, ENVIRONMENT, SdkTypeError, SdkValueError
from ._canvas import is_canvas_noise_key, new_canvas_noise_key
from .persona_profile import validate_persona_profile
from .persona_profile_v4 import validate_persona_profile_v4
from .population_model import generate_persona_profile
from .template_selection import PersonaTemplate, _select_persona_template_entry


IDENTITY_WRAPPER_VERSION = 1
GENERATED_IDENTITY_WRAPPER_VERSION = 2
#: Wrapper version that stores a schema 4 persona (the new persona format).
ISSUED_IDENTITY_WRAPPER_VERSION = 3
TEMPLATE_SELECTION_ALGORITHM = "ant0/persona-template-selection/v1"
GENERATE_ALGORITHM = "ant0/persona-generate/v1"
_FILENAME_DOMAIN = b"ant0/identity-filename/v1\0"
_DEVICE_KEY_NAME = "device.key"
_WRAPPER_FIELDS = {
    "schema_version", "template_selection_algorithm", "template_id", "created_at", "profile"
}
_WRAPPER_V2_FIELDS = {"schema_version", "algorithm", "algorithm_ref", "created_at", "profile"}
_ALGORITHM_V3 = re.compile(r"ant0/persona-generate/[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
#: Optional on every wrapper version when reading. Written only by wrapper v3 (new-format identities):
#: older releases require the exact v1/v2 field set, and these files travel to them in sync bundles.
#: Without a stored key, ``canvas_noise_key_for`` derives one from the identity key.
_CANVAS_KEY_FIELD = "canvas_noise_key"
_SAFE_TEMPLATE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_RFC3339 = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


class PersistedIdentity(TypedDict):
    schema_version: int
    template_selection_algorithm: str
    template_id: str
    created_at: str
    profile: Dict[str, Any]
    # Readers accept an optional ``canvas_noise_key`` (see _CANVAS_KEY_FIELD); v1/v2 files never get one.


class IdentityPersistenceError(Coded, ValueError):
    """Persisted identity state is unsafe, corrupt, or incompatible."""

    code = "sdk.identity_state_unsafe"
    error_class = ENVIRONMENT


def _key_bytes(value: str) -> bytes:
    if not isinstance(value, str):
        raise SdkTypeError("sdk.identity_state_invalid", "identity_key must be a string")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise SdkValueError("sdk.identity_state_invalid", "identity_key must contain only Unicode scalar values")
    return value.encode("utf-8")


def resolve_identity_directory() -> Path:
    """Return the configured identity directory without creating it."""
    override = os.environ.get("ANT0_BROWSER_IDENTITY_DIR")
    return Path(override).expanduser() if override else Path.home() / ".ant0-browser" / "identities"


def identity_filename(identity_key: str, device_key: bytes) -> str:
    """Return the opaque filename for an identity key on this device."""
    if not isinstance(device_key, bytes) or len(device_key) != 32:
        raise SdkValueError("sdk.identity_state_invalid", "device_key must be exactly 32 bytes")
    digest = hmac.new(device_key, _FILENAME_DOMAIN + _key_bytes(identity_key), hashlib.sha256)
    return digest.hexdigest() + ".json"


def _private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    if not path.is_dir():
        raise IdentityPersistenceError(f"identity path is not a directory: {path}")


def _read_regular(path: Path) -> bytes:
    try:
        if path.is_symlink() or not path.is_file():
            raise IdentityPersistenceError(f"identity state is not a regular file: {path}")
        return path.read_bytes()
    except IdentityPersistenceError:
        raise
    except OSError as exc:
        raise IdentityPersistenceError(f"cannot read identity state: {path}") from exc


def _publish(path: Path, data: bytes) -> bool:
    temp = path.parent / f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    fd = None
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            fd = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            temp.chmod(0o600)
        except OSError:
            pass
        try:
            os.link(temp, path)
            return True
        except FileExistsError:
            return False
    finally:
        if fd is not None:
            os.close(fd)
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def load_or_create_device_key(identity_dir: Optional[os.PathLike] = None) -> bytes:
    """Load, or atomically create once, the installation-local 32-byte key."""
    directory = Path(identity_dir) if identity_dir is not None else resolve_identity_directory()
    _private_directory(directory)
    path = directory / _DEVICE_KEY_NAME
    if path.exists() or path.is_symlink():
        key = _read_regular(path)
    else:
        key = b""
    if not key:
        candidate = secrets.token_bytes(32)
        if _publish(path, candidate):
            key = candidate
        else:
            key = _read_regular(path)
    if len(key) != 32:
        raise IdentityPersistenceError(f"device key must contain exactly 32 bytes: {path}")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return key


def _validate_created_at(value: Any) -> None:
    if not isinstance(value, str) or _RFC3339.fullmatch(value) is None:
        raise IdentityPersistenceError("created_at must be an RFC 3339 date-time")
    try:
        datetime.datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError as exc:
        raise IdentityPersistenceError("created_at must be an RFC 3339 date-time") from exc


def validate_persisted_identity(value: Any) -> PersistedIdentity:
    """Strictly validate a persistence wrapper and its complete canonical profile.

    Wrapper v1 records template selection; wrapper v2 records population-model generation. Only a
    schema_version of exactly 2 is routed to the v2 shape, so a v1-shaped file with a mutated version
    is still rejected.
    """
    if type(value) is not dict:
        raise IdentityPersistenceError("persisted identity must contain exactly the v1 wrapper fields")
    version = value.get("schema_version")
    if type(version) is int and version == ISSUED_IDENTITY_WRAPPER_VERSION:
        return _validate_issued_wrapper(value)
    if version == GENERATED_IDENTITY_WRAPPER_VERSION:
        return _validate_generated_wrapper(value)
    return _validate_template_wrapper(value)


def _required_keys(value: Any) -> set:
    return set(value) - {_CANVAS_KEY_FIELD}


def _validate_canvas_key_field(value: Any) -> None:
    if _CANVAS_KEY_FIELD in value and not is_canvas_noise_key(value[_CANVAS_KEY_FIELD]):
        raise IdentityPersistenceError("canvas_noise_key must be 16 lowercase hex characters")


def _validate_issued_wrapper(value: Any) -> PersistedIdentity:
    if _required_keys(value) != _WRAPPER_V2_FIELDS:
        raise IdentityPersistenceError("persisted identity must contain exactly the v3 wrapper fields")
    algorithm = value["algorithm"]
    if not isinstance(algorithm, str) or _ALGORITHM_V3.fullmatch(algorithm) is None:
        raise IdentityPersistenceError("unsupported generate algorithm")
    algorithm_ref = value["algorithm_ref"]
    if not isinstance(algorithm_ref, str) or _SAFE_TEMPLATE_ID.fullmatch(algorithm_ref) is None:
        raise IdentityPersistenceError("algorithm_ref is unsafe")
    if _CANVAS_KEY_FIELD not in value:
        raise IdentityPersistenceError("canvas_noise_key is required in a v3 wrapper")
    _validate_canvas_key_field(value)
    _validate_created_at(value["created_at"])
    try:
        validate_persona_profile_v4(value["profile"])
    except (TypeError, ValueError) as exc:
        raise IdentityPersistenceError(f"invalid persisted profile: {exc}") from exc
    return value


def _validate_template_wrapper(value: Any) -> PersistedIdentity:
    if _required_keys(value) != _WRAPPER_FIELDS:
        raise IdentityPersistenceError("persisted identity must contain exactly the v1 wrapper fields")
    _validate_canvas_key_field(value)
    if type(value["schema_version"]) is not int or value["schema_version"] != IDENTITY_WRAPPER_VERSION:
        raise IdentityPersistenceError("schema_version must equal 1")
    if value["template_selection_algorithm"] != TEMPLATE_SELECTION_ALGORITHM:
        raise IdentityPersistenceError("unsupported template_selection_algorithm")
    template_id = value["template_id"]
    if not isinstance(template_id, str) or _SAFE_TEMPLATE_ID.fullmatch(template_id) is None:
        raise IdentityPersistenceError("template_id is unsafe")
    _validate_created_at(value["created_at"])
    try:
        validate_persona_profile(value["profile"])
    except (TypeError, ValueError) as exc:
        raise IdentityPersistenceError(f"invalid persisted profile: {exc}") from exc
    return value


def _validate_generated_wrapper(value: Any) -> PersistedIdentity:
    if _required_keys(value) != _WRAPPER_V2_FIELDS:
        raise IdentityPersistenceError("persisted identity must contain exactly the v2 wrapper fields")
    _validate_canvas_key_field(value)
    if value["algorithm"] != GENERATE_ALGORITHM:
        raise IdentityPersistenceError("unsupported generate algorithm")
    algorithm_ref = value["algorithm_ref"]
    if not isinstance(algorithm_ref, str) or _SAFE_TEMPLATE_ID.fullmatch(algorithm_ref) is None:
        raise IdentityPersistenceError("algorithm_ref is unsafe")
    _validate_created_at(value["created_at"])
    try:
        validate_persona_profile(value["profile"])
    except (TypeError, ValueError) as exc:
        raise IdentityPersistenceError(f"invalid persisted profile: {exc}") from exc
    return value


def _load_path(path: Path) -> PersistedIdentity:
    try:
        value = json.loads(_read_regular(path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise IdentityPersistenceError(f"invalid persisted identity JSON: {path}") from exc
    return validate_persisted_identity(value)


def load_persisted_identity(
    identity_key: str, identity_dir: Optional[os.PathLike] = None
) -> Optional[PersistedIdentity]:
    """Load an identity, returning None when no device key or identity exists."""
    _key_bytes(identity_key)
    directory = Path(identity_dir) if identity_dir is not None else resolve_identity_directory()
    key_path = directory / _DEVICE_KEY_NAME
    if not key_path.exists() and not key_path.is_symlink():
        return None
    device_key = _read_regular(key_path)
    if len(device_key) != 32:
        raise IdentityPersistenceError(f"device key must contain exactly 32 bytes: {key_path}")
    path = directory / identity_filename(identity_key, device_key)
    if not path.exists() and not path.is_symlink():
        return None
    return copy.deepcopy(_load_path(path))


def create_or_load_identity(
    identity_key: str,
    templates: Collection[PersonaTemplate],
    identity_dir: Optional[os.PathLike] = None,
) -> PersistedIdentity:
    """Load an authoritative identity or atomically select and persist its first value."""
    _key_bytes(identity_key)
    directory = Path(identity_dir) if identity_dir is not None else resolve_identity_directory()
    device_key = load_or_create_device_key(directory)
    path = directory / identity_filename(identity_key, device_key)
    if path.exists():
        return copy.deepcopy(_load_path(path))

    selected = _select_persona_template_entry(identity_key, device_key.hex(), templates)
    created_at = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    wrapper: PersistedIdentity = {
        "schema_version": IDENTITY_WRAPPER_VERSION,
        "template_selection_algorithm": TEMPLATE_SELECTION_ALGORITHM,
        "template_id": selected["id"],
        "created_at": created_at,
        "profile": selected["profile"],
    }
    validate_persisted_identity(wrapper)
    data = (json.dumps(wrapper, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if _publish(path, data):
        return copy.deepcopy(wrapper)
    return copy.deepcopy(_load_path(path))


def create_or_load_generated_identity(
    identity_key: str,
    model: Dict[str, Any],
    identity_dir: Optional[os.PathLike] = None,
) -> PersistedIdentity:
    """Load an authoritative identity or atomically generate and persist its first value.

    The population model is consulted only when a new identity is created; an existing file is
    authoritative, so a model or k_floor change never mutates an already-created identity.
    """
    _key_bytes(identity_key)
    directory = Path(identity_dir) if identity_dir is not None else resolve_identity_directory()
    device_key = load_or_create_device_key(directory)
    path = directory / identity_filename(identity_key, device_key)
    if path.exists():
        return copy.deepcopy(_load_path(path))

    profile = generate_persona_profile(identity_key, device_key.hex(), model)
    created_at = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    wrapper: PersistedIdentity = {
        "schema_version": GENERATED_IDENTITY_WRAPPER_VERSION,
        "algorithm": GENERATE_ALGORITHM,
        "algorithm_ref": model["model_version"],
        "created_at": created_at,
        "profile": profile,
        # No canvas_noise_key: wrapper v2 keeps the field set older readers require; its key is derived.
    }
    validate_persisted_identity(wrapper)
    data = (json.dumps(wrapper, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if _publish(path, data):
        return copy.deepcopy(wrapper)
    return copy.deepcopy(_load_path(path))


def create_or_load_issued_identity(
    identity_key: str,
    profile: Dict[str, Any],
    algorithm: str,
    algorithm_ref: str,
    identity_dir: Optional[os.PathLike] = None,
) -> PersistedIdentity:
    """Store, or load if one already exists, a persona issued elsewhere (the cloud, through the daemon).

    A schema 2 persona is stored in a wrapper v2 (``algorithm`` must then be
    ``"ant0/persona-generate/v1"``) and a schema 4 persona in a wrapper v3 (``algorithm`` such as
    ``"ant0/persona-generate/v2.2"``). The file is named and written like every other identity file,
    atomically, and an existing file for the key is authoritative and returned unchanged. A new
    schema 4 file (wrapper v3) gets a fresh random ``canvas_noise_key``; a schema 2 file (wrapper v2)
    gets none, and its key is derived on read.
    """
    _key_bytes(identity_key)
    directory = Path(identity_dir) if identity_dir is not None else resolve_identity_directory()
    device_key = load_or_create_device_key(directory)
    path = directory / identity_filename(identity_key, device_key)
    if path.exists():
        return copy.deepcopy(_load_path(path))
    created_at = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    is_v4 = isinstance(profile, dict) and profile.get("schema_version") == 4
    wrapper: PersistedIdentity = {
        "schema_version": ISSUED_IDENTITY_WRAPPER_VERSION if is_v4 else GENERATED_IDENTITY_WRAPPER_VERSION,
        "algorithm": algorithm,
        "algorithm_ref": algorithm_ref,
        "created_at": created_at,
        "profile": profile,
    }
    if is_v4:
        # Only the new-format (v3) wrapper stores a key; v2 keeps the field set older readers require.
        wrapper["canvas_noise_key"] = new_canvas_noise_key()
    validate_persisted_identity(wrapper)
    data = (json.dumps(wrapper, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if _publish(path, data):
        return copy.deepcopy(wrapper)
    return copy.deepcopy(_load_path(path))


__all__ = [
    "IDENTITY_WRAPPER_VERSION", "GENERATED_IDENTITY_WRAPPER_VERSION", "TEMPLATE_SELECTION_ALGORITHM",
    "GENERATE_ALGORITHM", "PersistedIdentity", "IdentityPersistenceError",
    "resolve_identity_directory", "identity_filename", "load_or_create_device_key",
    "validate_persisted_identity", "load_persisted_identity", "create_or_load_identity",
    "create_or_load_generated_identity",
    "create_or_load_issued_identity", "ISSUED_IDENTITY_WRAPPER_VERSION",
]
