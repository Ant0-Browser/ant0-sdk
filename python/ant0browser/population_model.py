"""Deterministic population-model generator for synthetic mode (ant0/persona-generate/v1).

Recombines validated real hardware bundles into an ordinary-looking persona-profile-v2. The runtime
performs integer arithmetic only; all float weight blending happened once in the offline builder.
The same identity key, device key, and model always produce the same profile, byte for byte, and the
Node SDK implements the identical algorithm.
"""

import copy
import hashlib
import json
import os
import struct
from pathlib import Path
from typing import Any, Dict, List, Mapping, Union

from ._errors import Coded, EXPECTED, SdkTypeError, SdkValueError
from .chromium_version import CHROMIUM_MAJOR
from .persona_profile import validate_persona_profile
from ._speech_coherence import builtin_speech_voices, speech_values_for_locale
from ._windows_coherence import has_angle_device_id, normalise_win11_display_row


GENERATE_ALGORITHM = "ant0/persona-generate/v1"
GENERATOR_NAME = "ant0-population-generator"
GENERATOR_VERSION = "1.1.0"
_DOMAIN = b"ant0/persona-generate/v1\0"

# Fixed sampling order; each group is drawn exactly once.
GENERATION_ORDER = ("graphics", "cpu_mem", "display", "audio", "fonts", "speech")
_CONSTANT_KEYS = ("js_heap_size_limit", "desktop_display", "codecs", "devices", "locale")
_DISPLAY_VARIABLE_KEYS = (
    "width", "height", "available_width", "available_height",
    "color_depth", "pixel_depth", "device_pixel_ratio",
)


class PopulationModelError(Coded, ValueError):
    """The population model is structurally invalid or unusable."""

    code = "sdk.population_model_invalid"
    error_class = EXPECTED


def _key_bytes(value: str, name: str) -> bytes:
    if not isinstance(value, str):
        raise SdkTypeError("sdk.population_invalid", f"{name} must be a string")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise SdkValueError("sdk.population_invalid", f"{name} must contain only Unicode scalar values")
    return value.encode("utf-8")


class _Drbg:
    """SHA-256 counter DRBG. Block i is SHA256(seed || u64be(i)); bytes are drawn in order."""

    __slots__ = ("_seed", "_counter", "_buffer", "_offset")

    def __init__(self, seed: bytes) -> None:
        self._seed = seed
        self._counter = 0
        self._buffer = b""
        self._offset = 0

    def draw_u64(self) -> int:
        while len(self._buffer) - self._offset < 8:
            self._buffer += hashlib.sha256(self._seed + struct.pack(">Q", self._counter)).digest()
            self._counter += 1
        chunk = self._buffer[self._offset:self._offset + 8]
        self._offset += 8
        return int.from_bytes(chunk, "big")


def _seed(identity_key: str, device_key: str, model_version: str) -> bytes:
    identity = _key_bytes(identity_key, "identity_key")
    device = _key_bytes(device_key, "device_key")
    version = model_version.encode("ascii")
    return hashlib.sha256(
        _DOMAIN
        + struct.pack(">Q", len(identity)) + identity
        + struct.pack(">Q", len(device)) + device
        + struct.pack(">Q", len(version)) + version
    ).digest()


def _choose(values: List[Dict[str, Any]], drbg: _Drbg) -> Dict[str, Any]:
    total = sum(value["weight"] for value in values)
    target = drbg.draw_u64() % total
    cumulative = 0
    for value in values:
        cumulative += value["weight"]
        if target < cumulative:
            return value
    return values[-1]  # only reachable through float rounding, which cannot occur on integers


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PopulationModelError(message)


def load_population_model(source: Union[str, os.PathLike, Mapping[str, Any]]) -> Dict[str, Any]:
    """Load and structurally validate a population model from a path, directory, or object."""
    if isinstance(source, Mapping):
        model = source
    else:
        path = Path(source).expanduser()
        if path.is_dir():
            path = path / "population-model-v1.json"
        if path.is_symlink() or not path.is_file():
            raise PopulationModelError(f"population model is not a regular file: {path}")
        try:
            model = json.loads(path.read_bytes().decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PopulationModelError(f"cannot load population model: {path}: {exc}") from exc
    _validate_model(model)
    return model


def _validate_model(model: Any) -> None:
    _require(isinstance(model, Mapping), "model must be an object")
    _require(model.get("generate_algorithm") == GENERATE_ALGORITHM, "unsupported generate_algorithm")
    _require(isinstance(model.get("model_version"), str) and model["model_version"],
             "model_version must be a nonempty string")
    _require(isinstance(model.get("created_at"), str) and model["created_at"],
             "created_at must be a nonempty string")
    _require(isinstance(model.get("k_floor"), int) and model["k_floor"] >= 1, "k_floor must be >= 1")
    constants = model.get("constants")
    _require(isinstance(constants, Mapping)
             and all(key in constants for key in _CONSTANT_KEYS), "constants are incomplete")
    source = model.get("source")
    _require(isinstance(source, Mapping) and isinstance(source.get("files"), Mapping),
             "source provenance is incomplete")
    groups = model.get("groups")
    _require(isinstance(groups, Mapping) and set(groups) == set(GENERATION_ORDER),
             "groups must be exactly the six generation bundles")
    for name in GENERATION_ORDER:
        values = groups[name].get("values") if isinstance(groups[name], Mapping) else None
        _require(isinstance(values, list) and values, f"group {name} has no values")
        for value in values:
            _require(isinstance(value, Mapping)
                     and isinstance(value.get("id"), str)
                     and isinstance(value.get("weight"), int) and value["weight"] >= 1
                     and isinstance(value.get("support"), int)
                     and isinstance(value.get("payload"), (dict, list)),
                     f"group {name} has a malformed value")


def _source_references(source: Mapping[str, Any]) -> List[Dict[str, str]]:
    revision = source.get("revision", "")
    files = source["files"]
    return [
        {"name": name, "revision": revision, "sha256": files[name]["sha256"]}
        for name in sorted(files)
    ]


def _coherent_rows(group: str, values: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Rows a generated persona may draw from. Every persona claims Windows 11, so a graphics row must
    carry ANGLE's 8-digit device id (a row without one is not drawn; ids are never filled in) and a
    display row a full-width bottom taskbar of 48 px or none: a display row with another work area is
    normalised to a 48 px bottom taskbar, keeping its size and weight. Raises when a group has no
    usable row."""
    if group not in ("graphics", "display"):
        return values
    if group == "graphics":
        kept = [v for v in values
                if has_angle_device_id(((v["payload"].get("webgl") or {}).get("unmasked_renderer")))]
        _require(bool(kept), "no graphics value carries an ANGLE device id")
    else:
        kept = []
        for v in values:
            payload = normalise_win11_display_row(v["payload"])
            if payload is not None:
                kept.append(v if payload is v["payload"] else {**v, "payload": payload})
        _require(bool(kept), "no display value can be given a Windows 11 work area")
    return kept


def generate_persona_profile(
    identity_key: str,
    device_key: str,
    model: Mapping[str, Any],
) -> Dict[str, Any]:
    """Deterministically generate and validate one persona-profile-v2 from the model."""
    _validate_model(model)
    k_floor = model["k_floor"]
    constants = model["constants"]
    drbg = _Drbg(_seed(identity_key, device_key, model["model_version"]))

    chosen: Dict[str, Dict[str, Any]] = {}
    for group in GENERATION_ORDER:
        values = _coherent_rows(group, sorted(model["groups"][group]["values"], key=lambda value: value["id"]))
        if group == "speech":
            # Draw only from sets whose default voice is in the persona's language
            # (constants.locale.primary_language); with none, the engine's built-in Windows set,
            # which the engine localises by Accept-Language. One draw either way.
            pool = speech_values_for_locale(values, (constants.get("locale") or {}).get("primary_language"))
            picked = _choose(pool or values, drbg)
            if pool:
                if picked["support"] < k_floor:
                    raise PopulationModelError(f"group {group} selected a value below k_floor")
                chosen[group] = copy.deepcopy(picked["payload"])
            else:
                chosen[group] = {"voices": builtin_speech_voices()}
            continue
        selected = _choose(values, drbg)
        if selected["support"] < k_floor:
            raise PopulationModelError(f"group {group} selected a value below k_floor")
        chosen[group] = copy.deepcopy(selected["payload"])
    # Note: the model's WebGPU block (features, limits) is emitted unchanged. A stub that blanked features to []
    # and shrank limits was removed: engines older than ant0.8 read features [] as "no features", a strong tell,
    # and only ant0.8 serves the real adapter set for it. It can return once old engines are gone.

    cpu_mem = chosen["cpu_mem"]
    display = chosen["display"]
    profile = {
        "schema_version": 2,
        "metadata": {
            "source": "synthetic",
            "created_at": model["created_at"],
            "generator": {
                "name": GENERATOR_NAME,
                "version": GENERATOR_VERSION,
                "model_version": model["model_version"],
            },
            "source_references": _source_references(model["source"]),
        },
        "compatibility": {
            "os_family": "windows", "architecture": "x86_64",
            "browser_family": "chromium", "browser_major": CHROMIUM_MAJOR,
        },
        "hardware": {
            "hardware_concurrency": cpu_mem["hardware_concurrency"],
            "device_memory_gb": cpu_mem["device_memory_gb"],
            "js_heap_size_limit": constants["js_heap_size_limit"],
        },
        "display": {
            **{key: display[key] for key in _DISPLAY_VARIABLE_KEYS},
            **copy.deepcopy(constants["desktop_display"]),
        },
        "locale": copy.deepcopy(constants["locale"]),
        "graphics": chosen["graphics"],
        "audio": chosen["audio"],
        "fonts": chosen["fonts"],
        "speech": chosen["speech"],
        "media": {
            "codecs": copy.deepcopy(constants["codecs"]),
            "devices": copy.deepcopy(constants["devices"]),
        },
    }
    validate_persona_profile(profile)
    return profile


__all__ = [
    "GENERATE_ALGORITHM", "GENERATOR_NAME", "GENERATOR_VERSION", "GENERATION_ORDER",
    "PopulationModelError", "load_population_model", "generate_persona_profile",
]
