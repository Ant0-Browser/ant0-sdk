"""Map Ant0 Browser fingerprint kwargs to Chromium command-line switches.

Switch names mirror the engine's fingerprint command-line switches.
"""

import base64
import gzip
import hashlib
import json
import os
import sys

from ._canvas import CANVAS_NOISE_KEY_SWITCH, assert_canvas_noise_key, canvas_mode
from ._errors import SdkValueError
from .persona_profile import validate_persona_profile
from .persona_profile_v4 import validate_persona_profile_v4

# kwargs accepted by launch()/launch_persistent_context() that are fingerprint options
# (everything else is passed straight through to Playwright).
FINGERPRINT_KEYS = (
    "fingerprint",
    "platform",
    "platform_version",
    "brand",
    "brand_version",
    "gpu_vendor",
    "gpu_renderer",
    "hardware_concurrency",
    # ant0-browser-light-stealth: individual native metadata overrides (no persona machinery).
    "device_memory",
    "screen_width",
    "screen_height",
    "avail_width",
    "avail_height",
    "color_depth",
    "device_pixel_ratio",
    "max_touch_points",
    "light_stealth",
    "location",
    "timezone",
    "accept_language",
    "webrtc_ip",
    "webrtc_mdns",
    "disable_gpu_fingerprint",
    "fingerprint_noise",
    # The two INDEPENDENT halves of the bundles above (engine ant0.8 or later).
    "gpu_string_spoof",
    "canvas_noise",
    # Canvas mode "real" | "noise", and the profile's noise key (16 lowercase hex); see _canvas.py.
    "canvas",
    "canvas_noise_key",
    # Internal: absolute path of the private file that carries a schema 4 persona (_profile_file.py).
    "fingerprint_profile_file",
    "fingerprint_profile",
    "storage_quota",
    "tls_profile",
)

# kwarg -> switch name (without leading "--"). disable_gpu_fingerprint is a boolean flag,
# handled separately below.
_FLAGS = {
    "fingerprint": "fingerprint",
    "platform": "fingerprint-platform",
    "platform_version": "fingerprint-platform-version",
    "brand": "fingerprint-brand",
    "brand_version": "fingerprint-brand-version",
    "gpu_vendor": "fingerprint-gpu-vendor",
    "gpu_renderer": "fingerprint-gpu-renderer",
    "hardware_concurrency": "fingerprint-hardware-concurrency",
    # ant0-browser-light-stealth: direct native-override switches (flag > persona > real).
    "device_memory": "fingerprint-device-memory",
    "screen_width": "fingerprint-screen-width",
    "screen_height": "fingerprint-screen-height",
    "avail_width": "fingerprint-avail-width",
    "avail_height": "fingerprint-avail-height",
    "color_depth": "fingerprint-color-depth",
    "device_pixel_ratio": "fingerprint-device-pixel-ratio",
    "max_touch_points": "fingerprint-max-touch-points",
    "location": "fingerprint-location",
    "timezone": "timezone",
    "webrtc_ip": "webrtc-ip",
    # navigator.storage.estimate().quota in MEGABYTES (a tiny/ephemeral quota reads as a test
    # machine / incognito; set a realistic on-disk value, e.g. 250000 for ~244 GB).
    "storage_quota": "fingerprint-storage-quota",
    # Direct metadata overrides (the "light" path): each beats the persona, which beats the real
    # host value. Emitted whenever the value is not None -- including 0, which is a real value for
    # max_touch_points (a non-touch desktop) rather than "unset".
}


def clean_accept_language(value):
    """Normalize an Accept-Language value for Chromium's ``--accept-lang``: a plain comma-separated
    tag list with NO ``;q=`` weights or spaces (Chromium adds the q-weights to the header itself; a
    ``;`` in the switch value trips a DCHECK and crashes the renderer)."""
    tags = [t.split(";")[0].strip() for t in str(value).split(",")]
    return ",".join(t for t in tags if t)


def encode_profile(value):
    """Encode a captured ant0-browser-profile for the ``--fingerprint-profile`` switch.

    ``value`` may be a path to a ``.json`` file, a ``dict``, or a JSON string. The profile is
    gzip+base64 encoded so the full capture (≈40 KB) stays well within Chromium's command-line
    length limit (gzip ~6x). The engine base64-decodes + gunzips + parses it and overrides the
    seed-derived persona with the imported values."""
    if isinstance(value, dict):
        if value.get("schema_version") == 2:
            validate_persona_profile(value)
        if value.get("schema_version") == 4:
            validate_persona_profile_v4(value)
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    elif isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
    elif isinstance(value, str) and os.path.isfile(value):
        with open(value, "rb") as handle:
            raw = handle.read()
    else:
        raw = str(value).encode("utf-8")  # assume a JSON string
    if not isinstance(value, dict):
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError, UnicodeDecodeError):
            parsed = None
        if isinstance(parsed, dict) and parsed.get("schema_version") == 2:
            validate_persona_profile(parsed)
        elif isinstance(parsed, dict) and parsed.get("schema_version") == 4:
            validate_persona_profile_v4(parsed)
    return base64.b64encode(gzip.compress(raw, 9, mtime=0)).decode("ascii")


def _profile_locale(value):
    """Return an imported profile's language list and v2 timezone when available."""
    try:
        if isinstance(value, dict):
            obj = value
        elif isinstance(value, (bytes, bytearray)):
            obj = json.loads(value)
        elif isinstance(value, str) and os.path.isfile(value):
            with open(value, encoding="utf-8") as handle:
                obj = json.load(handle)
        else:
            obj = json.loads(value)
    except (ValueError, OSError):
        return None, None
    if isinstance(obj, dict) and obj.get("schema_version") == 2:
        langs = (obj.get("locale") or {}).get("languages")
        timezone = (obj.get("locale") or {}).get("timezone")
    else:
        langs = (obj.get("navigator") or {}).get("languages") if isinstance(obj, dict) else None
        timezone = None
    language = ",".join(str(tag) for tag in langs) if isinstance(langs, list) and langs else None
    return language, timezone if isinstance(timezone, str) and timezone else None


def _profile_accept_language(value):
    """Best-effort imported profile language list for Chromium's locale switches."""
    return _profile_locale(value)[0]


def _major_from_version(value):
    """Parse the leading integer (the major) out of a version string like '120.0.6099.109' -> 120.
    Returns None if there's no leading integer."""
    if value is None:
        return None
    head = str(value).strip().split(".")[0]
    return int(head) if head.isdigit() else None


def resolve_tls_profile(value, opts):
    """Resolve the ``tls_profile`` option to a concrete ``--fingerprint-tls-profile`` value, or None.

    Keeps the TLS ClientHello coherent with the persona's *claimed* Chromium major (the network layer
    follows the UA instead of always emitting the build's native TLS):

    - ``"match-persona"`` / ``"auto"`` (default): follow the persona's claimed Chrome major, taken
      from ``brand_version``. With no ``brand_version`` set, the persona claims the browser's native
      version, so this returns ``None`` (native TLS — already coherent).
    - ``None`` / ``""`` / ``"native"`` / ``"off"``: ``None`` (native TLS, no switch).
    - ``"chrome-<major>"`` or an int/str major (e.g. ``120``): pinned to that major.

    Any unrecognized value resolves to ``None`` — the engine never breaks the handshake on a bad
    value, and neither do we. Chromium-core only (Chrome/Edge/Brave/Opera share the ClientHello; the
    brand differs only in headers/UA-CH, not TLS), so the resolved value is always ``chrome-<major>``.
    """
    if value in (None, "", "native", "off"):
        return None
    if value in ("match-persona", "auto"):
        major = _major_from_version(opts.get("brand_version"))
        return f"chrome-{major}" if major else None
    if isinstance(value, int):
        return f"chrome-{value}"
    text = str(value).strip().lower()
    if text.startswith("chrome-") and text[len("chrome-"):].isdigit():
        return text
    if text.isdigit():
        return f"chrome-{text}"
    return None


# Primary Accept-Language tag -> a plausible IANA timezone, so the default persona's timezone is
# coherent with its locale instead of leaking the host's (often UTC on servers/containers). Not
# geo-truth — resolve the proxy exit-IP and pass an explicit timezone override for accuracy.
_LOCALE_TZ = {
    "en-US": "America/New_York", "en-CA": "America/Toronto", "en-GB": "Europe/London",
    "en-AU": "Australia/Sydney", "en-NZ": "Pacific/Auckland", "en-IE": "Europe/Dublin",
    "de-DE": "Europe/Berlin", "de-AT": "Europe/Vienna", "fr-FR": "Europe/Paris",
    "es-ES": "Europe/Madrid", "es-MX": "America/Mexico_City", "it-IT": "Europe/Rome",
    "nl-NL": "Europe/Amsterdam", "pt-BR": "America/Sao_Paulo", "pt-PT": "Europe/Lisbon",
    "pl-PL": "Europe/Warsaw", "sv-SE": "Europe/Stockholm", "ja-JP": "Asia/Tokyo",
    "ko-KR": "Asia/Seoul", "zh-CN": "Asia/Shanghai", "zh-TW": "Asia/Taipei",
    "ru-RU": "Europe/Moscow", "tr-TR": "Europe/Istanbul", "ar-SA": "Asia/Riyadh",
    "hi-IN": "Asia/Kolkata", "id-ID": "Asia/Jakarta",
}


def _default_timezone(primary_lang):
    """A plausible IANA timezone for a primary Accept-Language tag (``en-US`` -> ``America/New_York``),
    so the default persona's timezone is coherent with its locale rather than leaking the host's UTC.
    Falls back by language subtag, then to America/New_York (matching the en-US Accept-Language default)."""
    if not primary_lang:
        return None
    tag = primary_lang.strip()
    if tag in _LOCALE_TZ:
        return _LOCALE_TZ[tag]
    lang = tag.split("-")[0].lower()
    for key, tz in _LOCALE_TZ.items():
        if key.lower().startswith(lang + "-"):
            return tz
    return "America/New_York"


# Coherent Windows-plausible desktop/laptop metadata bundles:
# (screen_w, screen_h, avail_w, avail_h, dpr, color_depth, device_memory_gb, hw_concurrency).
# screen_* are LOGICAL (CSS) px; avail_h subtracts a ~40px taskbar; dpr matches the
# scaling that produces that logical size; all mouse-only desktops (max_touch=0).
_LIGHT_STEALTH_PROFILES = (
    (1920, 1080, 1920, 1040, 1.0, 24, 8, 8),     # FHD desktop
    (1920, 1080, 1920, 1040, 1.0, 24, 16, 12),   # FHD desktop, mid
    (1920, 1080, 1920, 1040, 1.0, 24, 16, 16),   # FHD desktop, high
    (2560, 1440, 2560, 1400, 1.0, 24, 16, 16),   # QHD desktop
    (2560, 1440, 2560, 1400, 1.5, 24, 16, 12),   # 4K @150% -> logical QHD
    (1536, 864, 1536, 824, 1.25, 24, 8, 8),      # FHD laptop @125%
    (1536, 864, 1536, 824, 1.25, 24, 16, 12),    # FHD laptop @125%, mid
    (1366, 768, 1366, 728, 1.0, 24, 8, 4),       # HD laptop
    (1366, 768, 1366, 728, 1.0, 24, 4, 4),       # HD laptop, budget
    (1440, 900, 1440, 860, 1.0, 24, 8, 8),       # 16:10 laptop
    (1600, 900, 1600, 860, 1.0, 24, 8, 8),       # HD+ desktop
    (1680, 1050, 1680, 1010, 1.0, 24, 8, 8),     # 16:10 desktop
    (1920, 1200, 1920, 1160, 1.0, 24, 16, 12),   # 16:10 FHD+ desktop
    (3840, 2160, 3840, 2120, 1.0, 24, 32, 16),   # 4K native @100%
)


def _light_stealth_values(seed):
    """Deterministic, coherent metadata bundle applied via the NATIVE override switches only
    (never --fingerprint), so the persona machinery and farbling hooks
    stay dormant and rendering surfaces (canvas / WebGL / audio / fonts) stay at the real host
    values.

    Spoofs ONLY the metadata axes that stay consistent with the real browser: hardware_concurrency,
    device_memory, color_depth, device_pixel_ratio, max_touch_points. It deliberately does NOT
    spoof screen / avail dimensions -- a faked screen size cannot be reconciled with the real
    window/render surface -- so screen stays REAL by default.
    Opt into a screen spoof by passing screen_width=/screen_height=/avail_width=/avail_height=
    explicitly (best when the host's real display actually matches)."""
    # Default seed string for seedless calls: the same persona every time unless an explicit seed is passed.
    key = str(seed if seed not in (None, "") else "ant0-light-stealth")
    h = int(hashlib.sha256(key.encode("utf-8")).hexdigest(), 16)
    _sw, _sh, _aw, _ah, dpr, depth, mem, hw = _LIGHT_STEALTH_PROFILES[h % len(_LIGHT_STEALTH_PROFILES)]
    # Present the browser's REAL version -- do NOT spoof brand_version. A Chrome-major lie moves
    # the UA-CH version AND (via tls_profile="match-persona") the TLS ClientHello off the genuine
    # binary, while the binary's real JS/engine surface still reflects its true version -- another
    # coherence mismatch. Callers can still pass brand_version= to opt into it.
    return {
        "device_pixel_ratio": dpr, "color_depth": depth, "device_memory": mem,
        "hardware_concurrency": hw, "max_touch_points": 0,
        "brand": "chrome",
    }


def _num(value):
    """1.0 -> "1", 1.25 -> "1.25": the same text the Node SDK writes."""
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def _ok_dpr(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and value == value and 0 < value <= 8)


def _profile_display(value):
    """A v2 profile's ``display`` block, or None (no profile, unreadable, or the legacy format)."""
    if value is None or value == "":
        return None
    try:
        if isinstance(value, dict):
            obj = value
        elif isinstance(value, (bytes, bytearray)):
            obj = json.loads(value)
        elif isinstance(value, str) and os.path.isfile(value):
            with open(value, encoding="utf-8") as handle:
                obj = json.load(handle)
        else:
            obj = json.loads(value)
    except (ValueError, OSError, TypeError):
        return None
    if isinstance(obj, dict) and obj.get("schema_version") == 4:
        # Schema 4 (spec 2.4): surfaces.display names the available area avail_width/avail_height;
        # present it under the v2 key names so both formats yield the same flags for the same numbers.
        surfaces = obj.get("surfaces")
        d = surfaces.get("display") if isinstance(surfaces, dict) else None
        if not isinstance(d, dict):
            return None
        return {"device_pixel_ratio": d.get("device_pixel_ratio"),
                "available_width": d.get("avail_width"), "available_height": d.get("avail_height")}
    if not isinstance(obj, dict) or obj.get("schema_version") != 2:
        return None
    display = obj.get("display")
    return display if isinstance(display, dict) else None


def persona_dpr(opts):
    """The persona's device pixel ratio when the SDK knows it, else None (a native identity, or an
    engine-picked persona, leaves the real display scale alone). Order: the explicit
    ``device_pixel_ratio``, the ``light_stealth`` bundle's value, then a v2 profile's
    ``display.device_pixel_ratio``."""
    if _ok_dpr(opts.get("device_pixel_ratio")):
        return opts["device_pixel_ratio"]
    if opts.get("device_pixel_ratio") is None and opts.get("light_stealth"):
        value = _light_stealth_values(opts.get("fingerprint"))["device_pixel_ratio"]
        if _ok_dpr(value):
            return value
    display = _profile_display(opts.get("fingerprint_profile"))
    value = display.get("device_pixel_ratio") if display else None
    return value if _ok_dpr(value) else None


def persona_avail(opts):
    """The persona's available screen in CSS px as ``(width, height)`` (either may be None): the
    explicit ``avail_width``/``avail_height``, else a v2 profile's."""
    def num(value):
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 else None
    display = _profile_display(opts.get("fingerprint_profile")) or {}
    return (num(opts.get("avail_width")) or num(display.get("available_width")),
            num(opts.get("avail_height")) or num(display.get("available_height")))


#: Engine switch that names a persona file (schema 4). One constant, one-line change.
PROFILE_FILE_SWITCH = "--fingerprint-profile-file"


def _profile_schema(value):
    """The ``schema_version`` of a profile given as a dict, JSON text or a path; None if unreadable."""
    try:
        if isinstance(value, dict):
            obj = value
        elif isinstance(value, (bytes, bytearray)):
            obj = json.loads(bytes(value))
        elif isinstance(value, str) and os.path.isfile(value):
            with open(value, "rb") as handle:
                obj = json.loads(handle.read())
        else:
            obj = json.loads(str(value))
        return obj.get("schema_version") if isinstance(obj, dict) else None
    except (TypeError, ValueError, OSError):
        return None


def fingerprint_args(opts, identity_api=False):
    """Build the Chromium switches for a dict of fingerprint options."""
    args = []
    opts = dict(opts)  # ant0-browser-light-stealth: never mutate the caller's fp dict
    if opts.get("light_stealth"):
        # Fill in a coherent metadata bundle via native override switches. setdefault
        # semantics: an explicit caller kwarg (e.g. device_memory=16) wins over the preset.
        for _k, _v in _light_stealth_values(opts.get("fingerprint")).items():
            if opts.get(_k) in (None, ""):
                opts[_k] = _v
        # CRITICAL: never emit --fingerprint, so CurrentPersona()/farble never engage;
        # every value then takes the C++ flag > real path (no persona machinery).
        opts.pop("fingerprint", None)
        # Size the REAL window to fit the spoofed screen so inner <= outer <= avail <=
        # screen (window.outer*/screenX/Y stay coherent). Emitted in base args -> a
        # user-supplied --window-size still wins (merged after these).
        try:
            args.append("--window-size={},{}".format(int(opts["avail_width"]), int(opts["avail_height"])))
        except (KeyError, TypeError, ValueError):
            pass
    # The seed makes the engine noise canvas readback on its own, so ``canvas`` cannot be honoured with it:
    # "real" would still be noised, and a noise key is ignored.
    if opts.get("canvas") is not None and opts.get("fingerprint") not in (None, ""):
        raise SdkValueError(
            "sdk.canvas_invalid",
            'canvas cannot be combined with the fingerprint seed: with a seed the engine noises canvas readback by '
            'itself ("real" would still be noised and a noise key is ignored). Use an identity, which has no seed.')
    for key, flag in _FLAGS.items():
        value = opts.get(key)
        if value is not None and value != "":
            args.append(f"--{flag}={value}")
    # Persona scale: make the REAL scale the persona's. Without it a host at scale 2 shows through
    # (0.5px borders, 0.5 pointer steps, 2x screenshots) while the persona claims 1. Measured on
    # Linux: the flag closes the gap without engine support. A caller's own --force-device-scale-factor
    # in `args` comes later on the command line and wins.
    scale = persona_dpr(opts)
    if scale is not None:
        args.append(f"--force-device-scale-factor={_num(scale)}")
    # Only "off" is meaningful: concealment ON is both the Chromium default and real Chrome's
    # behaviour, so there is nothing to emit for "on".
    #
    # This uses Chromium's OWN feature flag rather than a ant0browser switch. The mDNS responder is
    # created in PeerConnectionDependencyFactory behind kWebRtcHideLocalIpsWithMdns; disabling the
    # feature means no responder is built and host candidates are signalled as raw IPs. Verified
    # end-to-end: with the flag, host candidates come back as 192.168.x.x; without it, <uuid>.local.
    # merge_feature_flags folds this into any other --disable-features value.
    if str(opts.get("webrtc_mdns") or "").lower() == "off":
        args.append("--disable-features=WebRtcHideLocalIpsWithMdns")
    # Default the persona platform to the HOST OS, so it's coherent with the binary the SDK ships for
    # this machine (Windows binary -> windows persona, Linux binary -> linux persona) rather than a
    # seed-derived OS that could vary. Override explicitly via platform="windows"/"linux"/"macos".
    if not identity_api and not opts.get("platform"):
        host = {"win32": "windows", "linux": "linux", "darwin": "macos"}.get(sys.platform, "windows")
        args.append(f"--fingerprint-platform={host}")
    # ant0browser presents as Google Chrome (its UA string says "Chrome/<v>"), so default the
    # UA-CH brand to "chrome" — otherwise navigator.userAgentData advertises only "Chromium",
    # a UA/UA-CH mismatch some sites flag. Override via brand="edge" etc.
    if not identity_api and not opts.get("brand"):
        args.append("--fingerprint-brand=chrome")
    profile_language = None
    profile_timezone = None
    if opts.get("fingerprint_profile"):
        profile_language, profile_timezone = _profile_locale(opts["fingerprint_profile"])
    accept_language = opts.get("accept_language") or profile_language
    if not accept_language and not identity_api:
        # Always send a coherent Accept-Language. Without --accept-lang Chromium falls back to the
        # build/OS locale, which can leak a language that mismatches the proxy's country/timezone
        # (e.g. en-GB on a US IP) — a geo-inconsistency tell. en-US,en is the common Chrome default;
        # set accept_language (or geoip) to match the proxy region.
        accept_language = "en-US,en"
    clean_lang = clean_accept_language(accept_language) if accept_language else ""
    if clean_lang:
        args.append(f"--accept-lang={clean_lang}")
    # Also pin the UI/ICU locale to the PRIMARY Accept-Language tag, so Intl.DateTimeFormat /
    # NumberFormat / Collator (main thread AND workers) resolve to the same locale as
    # navigator.language. Without --lang, Chromium falls back to the build/OS locale (e.g. en-GB on an
    # en-US persona) -- a locale-incoherence tell (navigator.language=en-US but Intl=en-GB).
    primary_lang = clean_lang.split(",")[0]
    if primary_lang:
        args.append(f"--lang={primary_lang}")
    # Default the timezone to one coherent with the persona locale when none is set (and geoip didn't
    # resolve one), so a server/container run doesn't leak the host's UTC (a datacenter tell) while
    # navigator.language says e.g. en-US. An explicit timezone override takes precedence.
    if not opts.get("timezone"):
        default_tz = profile_timezone or (None if identity_api else _default_timezone(primary_lang))
        if default_tz:
            args.append(f"--timezone={default_tz}")
    # disable_gpu_fingerprint=True presents the machine's REAL GPU instead of a spoofed one: WebGL
    # UNMASKED_VENDOR/RENDERER, the getParameter table, and the canvas/WebGL render all report the
    # genuine host backend. The most coherent setting: the GPU
    # string and the rendered pixels match, so nothing disagrees. Composes with
    # fingerprint_profile (the profile still supplies screen/fonts/audio/hardware, but the real host
    # GPU is kept, not the profile's GPU which the host can't render); pair with fingerprint_noise=
    # False so the readback isn't perturbed. Trade-off: personas on one machine share the GPU/canvas
    # identity (linkable) — best for single-identity/per-host use.
    if opts.get("disable_gpu_fingerprint"):
        args.append("--disable-gpu-fingerprint")
    # fingerprint_noise=False turns OFF the per-eTLD+1 farbling noise (canvas/WebGL/audio/
    # client-rects) so those surfaces return natural, unperturbed values — useful when a site
    # treats the noise pattern as "tampered". Identity spoofs
    # (UA/screen/GPU/persona) stay on. Default (unset/True) keeps the noise.
    if opts.get("fingerprint_noise") is False:
        args.append("--disable-fingerprint-noise")
    # gpu_string_spoof=False presents the machine's REAL GPU. With real GPU strings, every GPU value
    # (the card name, the WebGL limits and extensions, shader precision, the WebGPU adapter info,
    # limits and features) comes from this machine's graphics stack, and only the readback noise
    # stays; so on a Linux computer a Windows persona shows a Linux GPU. The difference from
    # disable_gpu_fingerprint=True is that the noise is kept. Because the card is the real one, the
    # Windows-only Direct3D11 answers (shader precision, MAX_ELEMENT_INDEX, hidden ASTC/ETC, a
    # bgra8unorm preferred format) are the backend's too. An explicit gpu_renderer / gpu_vendor
    # (or a webgpu override) loses to it. Default (unset/True) keeps the spoofed GPU.
    # Requires engine ant0.8 or later; inert on older.
    if opts.get("gpu_string_spoof") is False:
        args.append("--disable-gpu-string-spoof")
    # canvas_noise=False turns OFF the per-eTLD+1 farble on the canvas READBACKS: getImageData and
    # toDataURL of a 2D canvas (also bitmaprenderer and OffscreenCanvas), and the toBlob /
    # convertToBlob encode path (WebP, and anything made in a worker). WebGL and WebGPU canvases,
    # gl.readPixels, audio and client rects keep their noise -- unlike fingerprint_noise=False, which
    # is the process-wide off switch for all of them. Default (unset/True) keeps the noise.
    # Requires engine ant0.8 or later; inert on older builds.
    if opts.get("canvas_noise") is False:
        args.append("--disable-canvas-noise")
    # Canvas mode (see _canvas.py). Real sends nothing. Noise sends the profile's key, once. A noise
    # mode that came from the legacy True overrides and has no key sends nothing, as those overrides
    # always did when called directly; the identity path (prepare_identity_options) supplies the key or
    # fails the launch. An explicit canvas="noise" without a key is an error.
    if canvas_mode(opts) == "noise":
        assert_canvas_noise_key(opts.get("canvas_noise_key"))
        if opts.get("canvas_noise_key") is not None:
            args.append(f"{CANVAS_NOISE_KEY_SWITCH}={opts['canvas_noise_key']}")
        elif opts.get("canvas") == "noise":
            raise SdkValueError("sdk.canvas_key_missing",
                                'canvas="noise" needs a canvas_noise_key (16 lowercase hex characters)')
    # fingerprint_profile transports a profile to the native parser. Canonical v2 profiles are
    # complete and activate atomically; only the deprecated unversioned format has partial-field
    # fallback semantics.
    profile = opts.get("fingerprint_profile")
    if profile:
        if _profile_schema(profile) == 4:
            # Schema 4 never goes inline: the launch code writes it to a private file first.
            if isinstance(profile, str):
                raise SdkValueError(
                    "sdk.persona_profile_invalid",
                    "a schema_version 4 persona cannot be given to fingerprint_profile as a path or JSON text (that "
                    "supports schema 2 only); pass it through identity={'mode': 'captured', 'source': ...}, which "
                    "accepts a path or JSON text and writes the private file")
            if not opts.get("fingerprint_profile_file"):
                raise SdkValueError("sdk.persona_file_missing",
                                    "a schema_version 4 persona travels in a private file; launch through the SDK launch functions")
            args.append(f"{PROFILE_FILE_SWITCH}={opts['fingerprint_profile_file']}")
        else:
            args.append(f"--fingerprint-profile={encode_profile(profile)}")
    # tls_profile keeps the TLS ClientHello coherent with the persona's claimed Chrome version
    # (the network layer follows the UA). Default "match-persona" follows brand_version; an explicit
    # "chrome-<major>" pins it; "native"/off/unset leaves the build's native TLS. Only the
    # version-variant ClientHello fields (post-quantum key-share group, ALPS codepoint) change —
    # cipher list, version bounds, and per-connection extension permutation stay real-Chrome.
    tls_switch = resolve_tls_profile(opts.get("tls_profile", "match-persona"), opts)
    if tls_switch:
        args.append(f"--fingerprint-tls-profile={tls_switch}")
    # platform="android" is a best-effort MOBILE persona (Android UA + Sec-CH-UA-Mobile, touch,
    # pointer:coarse, mobile screen/DPR, Mali/Adreno WebGL, plugins=0, mobile viewport). The mobile
    # viewport needs a phone-sized window (Chromium's ~500px min width floor still applies); auto-set
    # one — a caller-supplied --window-size (in args) overrides it. On a desktop engine the GPU
    # render + fine geometry stay desktop (documented residual tells).
    # A schema 4 persona names its OS in the profile; no platform switch is derived from it.
    profile = opts.get("fingerprint_profile")
    v4_family = (((profile.get("identity") or {}).get("os") or {}).get("family")
                 if isinstance(profile, dict) and profile.get("schema_version") == 4 else None)
    if (opts.get("platform") or v4_family) == "android":
        args.append("--window-size=412,915")
    return args
