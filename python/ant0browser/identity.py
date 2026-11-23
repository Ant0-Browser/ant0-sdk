"""Public three-mode identity API and canonical template loading."""

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, TypedDict, Union

from ._errors import SdkTypeError, SdkValueError
from ._speech_coherence import builtin_speech_if_contradicting, cohere_speech
from .identity_persistence import (
    create_or_load_generated_identity, create_or_load_identity, load_persisted_identity,
)
from .persona_profile import validate_persona_profile
from .persona_profile_v4 import is_persona_v4, validate_persona_profile_v4
from ._canvas import assert_canvas_noise_key, assert_canvas_option, canvas_mode, canvas_noise_key_for
from .population_model import load_population_model
from .template_selection import PersonaTemplate


_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class NativeIdentity(TypedDict):
    mode: str


class CapturedIdentity(TypedDict):
    mode: str
    source: Any


class SyntheticIdentity(TypedDict, total=False):
    mode: str
    key: str
    template_directory: os.PathLike
    model_directory: os.PathLike
    identity_directory: os.PathLike


Identity = Union[NativeIdentity, CapturedIdentity, SyntheticIdentity]


class AudioProfileOverride(TypedDict, total=False):
    """Per-launch audio override. Fields left out keep the persona's value; the saved identity is
    never rewritten."""
    sample_rate: float   # AudioContext.sampleRate, 8000 to 384000
    base_latency: float  # AudioContext.baseLatency seconds, > 0 and <= 1
    output_latency: float  # AudioContext.outputLatency seconds, 0 to 1


_AUDIO_FIELDS = (
    ("sample_rate", lambda n: 8000 <= n <= 384000, "between 8000 and 384000"),
    ("base_latency", lambda n: 0 < n <= 1, "greater than 0 and at most 1"),
    ("output_latency", lambda n: 0 <= n <= 1, "between 0 and 1"),
)


def apply_audio_profile(profile: Dict[str, Any], value: Any) -> Dict[str, Any]:
    """Validate an ``audio_profile`` override and return a copy of ``profile`` with those ``audio``
    fields replaced. The input profile is not mutated."""
    if not isinstance(value, Mapping):
        raise SdkTypeError("sdk.identity_invalid", "audio_profile must be an object")
    names = {f[0] for f in _AUDIO_FIELDS}
    unknown = [str(k) for k in value if k not in names]
    if unknown:
        raise SdkValueError("sdk.identity_invalid", "unsupported audio_profile field(s): " + ", ".join(unknown))
    audio = dict(profile["audio"])
    for key, ok, rng in _AUDIO_FIELDS:
        n = value.get(key)
        if n is None:
            continue
        if isinstance(n, bool) or not isinstance(n, (int, float)) or n != n or n in (float("inf"), float("-inf")):
            raise SdkTypeError("sdk.identity_invalid", f"audio_profile.{key} must be a finite number")
        if not ok(n):
            raise SdkValueError("sdk.identity_invalid", f"audio_profile.{key} must be {rng}")
        # 44100.0 and 44100 must encode identically (and match the Node SDK's JSON).
        audio[key] = int(n) if isinstance(n, float) and n.is_integer() else n
    return {**profile, "audio": audio}


class NetworkOverride(TypedDict, total=False):
    """Per-launch ``navigator.connection`` override (engine >= ant0.7). ``None`` means not given. ``rtt`` and
    ``downlink`` replace the persona's BASE link values; the page still sees them through the per-host factor
    (0.90 to 1.10) and Chrome's rounding (rtt a multiple of 50 ms, downlink at most 10 in 0.05 steps), so the
    reported numbers can differ from the base (a base of 250 ms reports 250 to 300). ``effective_type`` is one
    value for the machine and follows from the base rtt (4g below 272 ms, 3g below 1420, 2g below 2010, else
    slow-2g). ``effective_type`` together with an ``rtt`` that implies another type is REJECTED. Only
    ``effective_type`` below 4g derives rtt and downlink from Chrome's typical values for it; below 4g a
    ``downlink`` is capped like Chrome's ClampKbpsBasedOnEct (0.14, 0.262, 1.4 Mbps). Launch payload only; a saved
    identity is never rewritten."""
    rtt: float            # base RTT in ms, > 0 and <= 3000
    downlink: float       # base downlink in Mbps, > 0 and <= 1000
    effective_type: str   # "slow-2g" | "2g" | "3g" | "4g"


_NETWORK_FIELDS = (("rtt", "rtt_ms"), ("downlink", "downlink_mbps"), ("effective_type", "effective_type"))
_NETWORK_ECT = ("slow-2g", "2g", "3g", "4g")


def apply_network_override(profile: Dict[str, Any], value: Any) -> Dict[str, Any]:
    """Validate a ``network`` override and return a copy of ``profile`` with a ``network`` block.
    The input profile is not mutated."""
    if not isinstance(value, Mapping):
        raise SdkTypeError("sdk.identity_invalid", "network must be an object")
    names = {f[0] for f in _NETWORK_FIELDS}
    unknown = [str(k) for k in value if k not in names]
    if unknown:
        raise SdkValueError("sdk.identity_invalid", "unsupported network field(s): " + ", ".join(unknown))
    network: Dict[str, Any] = {}
    for key, wire in _NETWORK_FIELDS:
        v = value.get(key)
        if v is None:
            continue
        if key == "effective_type":
            if not isinstance(v, str) or v not in _NETWORK_ECT:
                raise SdkValueError("sdk.identity_invalid",
                                    "network.effective_type must be one of: " + ", ".join(_NETWORK_ECT))
        else:
            if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
                raise SdkTypeError("sdk.identity_invalid", f"network.{key} must be a finite number")
            top = 3000 if key == "rtt" else 1000
            if not (0 < v <= top):
                raise SdkValueError("sdk.identity_invalid", f"network.{key} must be greater than 0 and at most {top}")
            # 100.0 and 100 must encode identically (and match the Node SDK's JSON).
            v = int(v) if isinstance(v, float) and v.is_integer() else v
        network[wire] = v
    if not network:
        return profile
    if "rtt_ms" in network and "effective_type" in network:
        ms = network["rtt_ms"]
        implied = "slow-2g" if ms >= 2010 else "2g" if ms >= 1420 else "3g" if ms >= 272 else "4g"
        if implied != network["effective_type"]:
            raise SdkValueError(
                "sdk.identity_invalid",
                f'network.effective_type "{network["effective_type"]}" contradicts network.rtt {ms} ms, which is '
                f'"{implied}" in Chrome (slow-2g from 2010 ms, 2g from 1420, 3g from 272, else 4g); give one of '
                "them, or consistent values")
    return {**profile, "network": network}


class IdentityOverrides(TypedDict, total=False):
    audio_profile: AudioProfileOverride
    network: NetworkOverride
    platform: str
    platform_version: str
    brand: str
    brand_version: str
    gpu_vendor: str
    gpu_renderer: str
    hardware_concurrency: int
    device_memory: float
    screen_width: int
    screen_height: int
    avail_width: int
    avail_height: int
    color_depth: int
    device_pixel_ratio: float
    max_touch_points: int
    location: str
    timezone: str
    accept_language: str
    webrtc_ip: str
    webrtc_mdns: str
    disable_gpu_fingerprint: bool
    fingerprint_noise: bool
    gpu_string_spoof: bool
    canvas_noise: bool
    #: "real" (the default) or "noise"; see _canvas.py for the mapping of the legacy overrides.
    canvas: str
    #: The profile's canvas noise key, 16 lowercase hex; used only in "noise" mode.
    canvas_noise_key: str
    storage_quota: int
    tls_profile: Any


def _read_json_file(path: Path, kind: str):
    try:
        if path.is_symlink() or not path.is_file():
            raise SdkValueError("sdk.identity_source_unreadable", f"{kind} is not a regular file: {path}")
        return json.loads(path.read_bytes().decode("utf-8"))
    except ValueError as exc:
        if str(exc).startswith(kind):
            raise
        raise SdkValueError("sdk.identity_source_unreadable", f"cannot load {kind}: {path}: {exc}") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SdkValueError("sdk.identity_source_unreadable", f"cannot load {kind}: {path}: {exc}") from exc


def load_template_directory(directory) -> List[PersonaTemplate]:
    """Load a deterministic, strictly validated pool of flat JSON templates."""
    path = Path(directory).expanduser()
    if path.is_symlink() or not path.is_dir():
        raise SdkValueError("sdk.identity_source_unreadable", f"template source is not a regular directory: {path}")
    templates = []
    try:
        entries = sorted(path.iterdir(), key=lambda entry: entry.name)
    except OSError as exc:
        raise SdkValueError("sdk.identity_source_unreadable", f"cannot read template directory: {path}: {exc}") from exc
    for entry in entries:
        if entry.is_symlink() or not entry.is_file():
            raise SdkValueError("sdk.identity_source_unreadable", f"template directory entry is not a regular file: {entry}")
        if entry.suffix != ".json":
            continue
        template_id = entry.stem
        if _SAFE_ID.fullmatch(template_id) is None:
            raise SdkValueError("sdk.identity_source_unreadable", f"unsafe template filename stem: {template_id!r}")
        profile = _read_json_file(entry, "template")
        try:
            validate_persona_profile(profile)
        except (TypeError, ValueError) as exc:
            raise SdkValueError("sdk.identity_source_unreadable", f"invalid template {entry}: {exc}") from exc
        templates.append({"id": template_id, "profile": profile})
    if not templates:
        raise SdkValueError("sdk.identity_source_unreadable", f"template directory contains no .json profiles: {path}")
    return templates


def load_captured_profile(source):
    """Load and validate a canonical captured profile from a path, object, or JSON string."""
    if isinstance(source, Mapping):
        profile = source
    elif isinstance(source, os.PathLike):
        profile = _read_json_file(Path(source).expanduser(), "captured profile")
    elif isinstance(source, str):
        if source.lstrip().startswith(("{", "[")):
            try:
                profile = json.loads(source)
            except json.JSONDecodeError as exc:
                raise SdkValueError("sdk.identity_invalid", "captured identity source must be a profile object, JSON, or existing path") from exc
        else:
            candidate = Path(source).expanduser()
            if not candidate.exists() and not candidate.is_symlink():
                raise SdkValueError("sdk.identity_invalid", "captured identity source must be a profile object, JSON, or existing path")
            profile = _read_json_file(candidate, "captured profile")
    else:
        raise SdkTypeError("sdk.identity_invalid", "captured identity source must be a profile object, JSON, or path")
    if is_persona_v4(profile):
        validate_persona_profile_v4(profile)
        return profile
    validate_persona_profile(profile)
    return profile


_OS_FAMILY_TO_PLATFORM = {"windows": "windows", "linux": "linux", "macos": "macos"}


def _identity_fingerprint_options(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Fingerprint options for a resolved persona profile.

    The persona's OS (``compatibility.os_family``) drives the platform switch so the browser
    presents the profile's OS — UA, UA-CH, ``navigator.platform`` — regardless of which host binary
    the SDK is driving. Without this, a Windows persona run on the Linux binary keeps the host's
    Linux UA while advertising a Windows (Direct3D11) GPU: an incoherent, trivially detectable
    contradiction.

    The brand defaults to Google Chrome: the personas are plain-Chrome captures (UA says
    ``Chrome/<v>``), so ``navigator.userAgentData`` must advertise ``Google Chrome`` — otherwise it
    reports only the build's native ``Chromium`` brand, a UA/UA-CH mismatch.
    Native mode is unaffected (it has no persona and never
    calls this). A caller ``overrides={"platform"/"brand": ...}`` still wins (applied after this).
    """
    if is_persona_v4(profile):
        # Schema 4: the profile file is the only source of the machine's identity (the engine applies the
        # OS, brand, versions and the brand major rule from it). No identity switch is derived from it here.
        return {"fingerprint_profile": profile}
    options: Dict[str, Any] = {"fingerprint_profile": profile, "brand": "chrome"}
    platform = _OS_FAMILY_TO_PLATFORM.get(profile.get("compatibility", {}).get("os_family"))
    if platform is not None:
        options["platform"] = platform
    return options


def canvas_noise_key_of_identity(identity):
    """The canvas noise key stored with (or derived for) a synthetic identity, or None for any other
    identity or one that is not stored yet. Reads the identity file; call it after ``resolve_identity``."""
    if not isinstance(identity, Mapping) or identity.get("mode") != "synthetic":
        return None
    persisted = load_persisted_identity(identity["key"], identity.get("identity_directory"))
    return canvas_noise_key_for(persisted, identity["key"]) if persisted is not None else None


def resolve_identity(identity: Identity) -> tuple[str, Dict[str, Any]]:
    """Validate a public identity option and return its mode and fingerprint options."""
    if not isinstance(identity, Mapping):
        raise SdkTypeError("sdk.identity_invalid", "identity must be an object")
    mode = identity.get("mode")
    fields = set(identity)
    if mode == "native":
        if fields != {"mode"}:
            raise SdkValueError("sdk.identity_invalid", "native identity must contain exactly 'mode'")
        return mode, {}
    if mode == "captured":
        if fields != {"mode", "source"}:
            raise SdkValueError("sdk.identity_invalid", "captured identity must contain exactly 'mode' and 'source'")
        return mode, _identity_fingerprint_options(load_captured_profile(identity["source"]))
    if mode == "synthetic":
        allowed = {"mode", "key", "template_directory", "model_directory", "identity_directory"}
        if "key" not in fields or not fields <= allowed:
            raise SdkValueError("sdk.identity_invalid", "synthetic identity requires 'key' and only supports directory options")
        key = identity["key"]
        if not isinstance(key, str) or not key:
            raise SdkValueError("sdk.identity_invalid", "synthetic identity key must be a nonempty string")
        identity_dir = identity.get("identity_directory")
        if identity_dir is not None and not os.fspath(identity_dir):
            raise SdkValueError("sdk.identity_invalid", "identity_directory must not be empty")
        model_dir = identity.get("model_directory")
        if model_dir is not None and not os.fspath(model_dir):
            raise SdkValueError("sdk.identity_invalid", "model_directory must not be empty")
        template_dir = identity.get("template_directory")
        if template_dir is not None and not os.fspath(template_dir):
            raise SdkValueError("sdk.identity_invalid", "template_directory must not be empty")
        # A persisted identity is authoritative and never re-reads a model or template source.
        persisted = load_persisted_identity(key, identity_dir)
        if persisted is not None:
            return mode, _identity_fingerprint_options(persisted["profile"])
        # Precedence: explicit model_directory > explicit template_directory > env model > env template.
        env_model = os.environ.get("ANT0_BROWSER_MODEL_SOURCE")
        env_template = os.environ.get("ANT0_BROWSER_TEMPLATE_SOURCE")
        if model_dir:
            model = load_population_model(model_dir)
            persisted = create_or_load_generated_identity(key, model, identity_dir)
        elif template_dir:
            persisted = create_or_load_identity(key, load_template_directory(template_dir), identity_dir)
        elif env_model:
            persisted = create_or_load_generated_identity(key, load_population_model(env_model), identity_dir)
        elif env_template:
            persisted = create_or_load_identity(key, load_template_directory(env_template), identity_dir)
        else:
            raise SdkValueError("sdk.identity_invalid", 
                "new synthetic identity requires model_directory or template_directory "
                "(or ANT0_BROWSER_MODEL_SOURCE / ANT0_BROWSER_TEMPLATE_SOURCE)"
            )
        return mode, _identity_fingerprint_options(persisted["profile"])
    raise SdkValueError("sdk.identity_invalid", "identity.mode must be one of: native, captured, synthetic")


def _drop_canvas_bridge(options: Mapping[str, Any]) -> Mapping[str, Any]:
    """``canvas_bridge`` was removed with the engine's canvas bridge. An old caller's value (top-level,
    under ``overrides``, or as a ``--canvas-bridge-*`` argument) is ignored with a one-time note; it
    never fails a launch. Returns a copy; the caller's mapping is untouched."""
    def is_arg(arg):
        return str(arg).startswith("--canvas-bridge-")
    overrides = options.get("overrides")
    has_override = isinstance(overrides, dict) and "canvas_bridge" in overrides
    has_arg = any(is_arg(a) for a in (options.get("args") or []))
    if "canvas_bridge" not in options and not has_override and not has_arg:
        return options
    clean = {k: v for k, v in options.items() if k != "canvas_bridge"}
    if has_override:
        clean["overrides"] = {k: v for k, v in overrides.items() if k != "canvas_bridge"}
    if has_arg:
        clean["args"] = [a for a in options["args"] if not is_arg(a)]
    from ._warnings import warn_canvas_bridge_removed
    warn_canvas_bridge_removed(quiet=bool(options.get("quiet")))
    return clean


def _persona_os_family(profile) -> "str | None":
    """The OS a persona names: ``identity.os.family`` (schema 4) or ``compatibility.os_family`` (schema 2)."""
    if not isinstance(profile, dict):
        return None
    if profile.get("schema_version") == 4:
        os_family = ((profile.get("identity") or {}).get("os") or {}).get("family")
    else:
        os_family = (profile.get("compatibility") or {}).get("os_family")
    return os_family.strip().lower() if isinstance(os_family, str) and os_family.strip() else None


def assert_platform_matches_persona(platform, profile) -> None:
    """Raise ``sdk.identity_platform_mismatch`` when an explicit platform override names another OS than
    the persona. A matching platform, no override, or a persona with no known OS passes."""
    if not isinstance(platform, str) or not platform.strip():
        return
    persona = _persona_os_family(profile)
    wanted = platform.strip().lower()
    if persona is None or persona == wanted:
        return
    raise SdkValueError(
        "sdk.identity_platform_mismatch",
        f"overrides platform {wanted!r} contradicts the persona's OS {persona!r}; the engine would present a "
        f"mixed identity (UA, GPU and fonts of different systems). Drop the platform override or use a "
        f"persona of the {wanted} OS")


def prepare_identity_options(options: Mapping[str, Any], fingerprint_keys) -> tuple[str, Dict[str, Any]]:
    """Replace public identity options with validated internal fingerprint options."""
    options = _drop_canvas_bridge(options)
    removed = [key for key in ("profile", "profile_select", "geoip", *fingerprint_keys) if key in options]
    if removed:
        raise SdkValueError("sdk.identity_invalid", 
            "legacy top-level identity options were removed; use identity=... and overrides={...}: "
            + ", ".join(removed)
        )
    identity_switches = (
        "--fingerprint", "--accept-lang", "--lang", "--timezone",
        "--disable-fingerprint", "--disable-gpu-fingerprint", "--disable-gpu-string-spoof",
        "--disable-canvas-noise",
    )
    raw_override = next(
        (arg for arg in (options.get("args") or []) if str(arg).startswith(identity_switches)), None
    )
    if raw_override is not None:
        raise SdkValueError("sdk.identity_invalid", 
            f"identity switch {raw_override!r} is not supported in args; use identity=... and overrides={{...}}"
        )
    overrides = options.get("overrides", {})
    if type(overrides) is not dict:
        raise SdkTypeError("sdk.identity_invalid", "overrides must be an object")
    allowed = (set(fingerprint_keys) - {"fingerprint", "fingerprint_profile", "fingerprint_profile_file", "light_stealth"}) | {"audio_profile", "network"}
    unsupported = [key for key in overrides if key not in allowed]
    if unsupported:
        raise SdkValueError("sdk.identity_invalid", "unsupported identity override(s): " + ", ".join(unsupported))
    mode, identity_options = resolve_identity(options.get("identity", {"mode": "native"}))
    prepared = {key: value for key, value in options.items() if key not in ("identity", "overrides")}
    prepared.update(identity_options)
    prepared.update({k: v for k, v in overrides.items() if k not in ("audio_profile", "network")})
    # A platform override that contradicts the persona's OS yields a mixed identity (for example a Linux
    # UA with a Windows GPU and fonts). Refuse it here, before any browser starts.
    assert_platform_matches_persona(overrides.get("platform"), identity_options.get("fingerprint_profile"))
    # A schema 4 persona carries its own identity. An explicit platform or brand value still wins as a
    # switch, but only the value the caller set is passed (never the persona's versions) and the mix is
    # said out loud.
    if is_persona_v4(identity_options.get("fingerprint_profile") or {}) and any(
            overrides.get(k) is not None for k in ("platform", "brand", "platform_version", "brand_version")):
        from ._warnings import warn_persona_identity_override
        warn_persona_identity_override(quiet=bool(options.get("quiet")))
    # Canvas mode (see _canvas.py). Noise needs a key: the option, else the one stored with the
    # identity, else the launch fails here, before any browser starts.
    assert_canvas_option(prepared.get("canvas"))
    assert_canvas_noise_key(prepared.get("canvas_noise_key"))
    if prepared.get("canvas") == "noise" and prepared.get("canvas_noise_key") is None:
        stored = canvas_noise_key_of_identity(options.get("identity", {"mode": "native"}))
        if stored is None:
            raise SdkValueError(
                "sdk.canvas_key_missing",
                "canvas noise needs a key: pass overrides canvas_noise_key (16 lowercase hex characters) "
                "or use a synthetic identity, which has one")
        prepared["canvas_noise_key"] = stored
    # The legacy True flags never enable noise (an absent canvas is real); they only say so.
    if prepared.get("canvas") != "noise" and (
            prepared.get("canvas_noise") is True or prepared.get("fingerprint_noise") is True):
        from ._warnings import warn_canvas_noise_no_key
        warn_canvas_noise_no_key(quiet=bool(options.get("quiet")))
    if overrides.get("audio_profile") is not None:
        fp = prepared.get("fingerprint_profile")
        if not isinstance(fp, dict) or fp.get("schema_version") != 2:
            raise SdkValueError("sdk.identity_invalid",
                                "audio_profile requires a captured or synthetic identity with a v2 persona profile")
        prepared["fingerprint_profile"] = apply_audio_profile(fp, overrides["audio_profile"])
    if overrides.get("network") is not None:
        fp = prepared.get("fingerprint_profile")
        if not isinstance(fp, dict) or fp.get("schema_version") != 2:
            raise SdkValueError("sdk.identity_invalid",
                                "network requires a captured or synthetic identity with a v2 persona profile")
        prepared["fingerprint_profile"] = apply_network_override(fp, overrides["network"])
    # The population model draws voices independently of platform and language. Now that both are
    # known, rebuild them by rule: no Windows voices on Linux, default voice in the persona's
    # language (see _speech_coherence.py). A profile whose list already fits is left untouched.
    profile = prepared.get("fingerprint_profile")
    if isinstance(profile, dict) and profile.get("schema_version") != 4:
        coherent, _fallback = cohere_speech(
            profile, prepared.get("platform"), prepared.get("accept_language"), prepared.get("brand"))
        # Safety net, launch payload only (the saved identity is never rewritten): a default voice whose
        # language contradicts the launch Accept-Language gets the engine's built-in set, which it localises.
        prepared["fingerprint_profile"] = builtin_speech_if_contradicting(
            coherent, prepared.get("platform"), prepared.get("accept_language"))
    return mode, prepared


__all__ = [
    "Identity", "NativeIdentity", "CapturedIdentity", "SyntheticIdentity", "IdentityOverrides", "AudioProfileOverride", "apply_audio_profile", "NetworkOverride", "apply_network_override",
    "load_template_directory", "load_captured_profile", "resolve_identity", "prepare_identity_options",
    "canvas_noise_key_of_identity",
]
