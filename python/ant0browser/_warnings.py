"""Launch-time coherence warnings.

The SDK already defaults the safe things (strips --enable-automation, denies WebRTC leak, disables
Privacy Sandbox, matches the persona to the build). What it CAN'T fix is an operator passing an
incoherent or missing-recommended combination - a proxy with no geo, a spoofed OS the host can't
font-match, a GPU string that contradicts the platform, etc. coherence_warnings() spots those at
launch() and emit_coherence_warnings() prints an actionable line to stderr.

Never blocks the launch; suppressible with quiet=True or ANT0_BROWSER_NO_WARN=1. coherence_warnings()
is a pure function (no I/O) so it is trivially unit-testable.
"""

import os
import re
import sys
from .chromium_version import CHROMIUM_MAJOR
from ._launchopts import _parse_engine_version
from ._canvas import canvas_mode

#: First engine release that closes the narrow-switch gaps: WebGPU, limits and shader precision follow
#: the real GPU under --disable-gpu-string-spoof, and toBlob/convertToBlob follow --disable-canvas-noise.
GPU_CANVAS_FIX_ENGINE = "158.0.8127.18-ant0.8"
_DEV_ENGINE = re.compile(r"^\d+\.\d+\.\d+\.\d+-ant0\.dev$")


def engine_has_gpu_canvas_fixes(engine_version):
    """True when the running engine is ant0.8 or later. Rules for the unknowns: a development build
    (``<chromium>-ant0.dev``, built from main) counts as NEW, so it is not nagged about gaps main has
    closed; a missing or unparseable version counts as OLD, so the operator is warned. Compared
    numerically (four-part Chromium version, then the ``-ant0.N`` build)."""
    if isinstance(engine_version, str) and _DEV_ENGINE.match(engine_version.strip()):
        return True
    have = _parse_engine_version(engine_version)
    return have is not None and have >= _parse_engine_version(GPU_CANVAS_FIX_ENGINE)


_SOFTWARE_GPU = ("swiftshader", "llvmpipe", "microsoft basic render", "software adapter", "software")
_seen_notes = set()  # fire-once per process for low-severity NOTE codes and _ONCE_WARN_CODES
_ONCE_WARN_CODES = frozenset({"gpu-string-only"})  # WARN-level, but printed once per process


def _proxy_server(proxy):
    if not proxy:
        return ""
    if isinstance(proxy, dict):
        return str(proxy.get("server") or "")
    return str(proxy)


def _is_socks(server):
    s = server.lower()
    return s.startswith("socks") or "://socks" in s


def _host_family(host):
    if host.startswith("win"):
        return "windows"
    if host == "darwin" or host.startswith("mac"):
        return "macos"
    if host.startswith("linux"):
        return "linux"
    return None


def linux_host_has_gpu(dri_dir="/dev/dri"):
    """True if this Linux host exposes a DRM/GPU device (a renderD*/card* node under /dev/dri).
    Absence strongly implies software rendering (SwiftShader/llvmpipe), so callers act only on
    ABSENCE — presence does not by itself guarantee hardware acceleration."""
    try:
        entries = os.listdir(dri_dir)
    except OSError:
        return False
    return any(e.startswith("renderD") or e.startswith("card") for e in entries)


def gpu_host_missing_for(fp, identity_mode, host_platform=None, dri_dir="/dev/dri"):
    """Return ``identity_mode`` when a persona that presents a HARDWARE GPU will in fact render on a
    software rasterizer because this Linux host has no GPU device; else ``None``. Does I/O (reads
    ``dri_dir``), so it lives outside the pure :func:`coherence_warnings` and is threaded in as
    ``_gpu_host_missing``. Silent when the operator opted into honest GPU (disable_gpu_fingerprint),
    or pinned a software renderer (the gpu-software warn covers that)."""
    host = host_platform or sys.platform
    if identity_mode not in ("captured", "synthetic") or not host.startswith("linux"):
        return None
    if fp.get("disable_gpu_fingerprint"):
        return None
    gr = str(fp.get("gpu_renderer") or "").lower()
    if any(m in gr for m in _SOFTWARE_GPU):
        return None
    if linux_host_has_gpu(dri_dir):
        return None
    return identity_mode


def _gpu_incoherent(renderer, platform):
    r = renderer.lower()
    if platform == "macos" and ("direct3d" in r or "d3d" in r):
        return "macOS uses Metal/OpenGL, never Direct3D"
    if platform == "windows" and "metal" in r:
        return "Windows uses Direct3D/ANGLE, never Metal"
    if platform == "linux" and ("direct3d" in r or "d3d" in r or "metal" in r):
        return "Linux uses OpenGL/Vulkan, never Direct3D/Metal"
    return None


def _warned_canvas_mode(opts):
    """The canvas mode the launch resolves to; an invalid ``canvas`` value (rejected elsewhere) counts as real."""
    try:
        return canvas_mode(opts)
    except Exception:
        return "real"


def coherence_warnings(opts, host_platform=None, build_major=None, engine_version=None):
    """Return a list of {severity, code, message} for incoherent/missing-recommended options.
    `opts` is the resolved option dict (fingerprint kwargs + proxy/geoip/headless/_user_args,
    plus `_font_reach`: the (claimed, reachable) font counts _prepare measured, or None).
    `engine_version` is the running engine's release (``158.0.8127.18-ant0.8``); the GPU and canvas
    warnings that describe gaps closed in ant0.8 fire only below it (see engine_has_gpu_canvas_fixes)."""
    host = host_platform or sys.platform
    build_major = str(build_major) if build_major is not None else str(CHROMIUM_MAJOR)
    out = []
    def warn(code, msg): out.append({"severity": "warn", "code": code, "message": msg})
    def note(code, msg): out.append({"severity": "note", "code": code, "message": msg})

    server = _proxy_server(opts.get("proxy"))
    geoip = bool(opts.get("geoip"))
    tz, lang = opts.get("timezone"), opts.get("accept_language")
    platform = opts.get("platform")
    brand, bver = opts.get("brand"), opts.get("brand_version")
    gpu_r, gpu_v = opts.get("gpu_renderer"), opts.get("gpu_vendor")
    profile = opts.get("fingerprint_profile")
    dgf, noise = opts.get("disable_gpu_fingerprint"), opts.get("fingerprint_noise")
    gpu_string_spoof, canvas_noise = opts.get("gpu_string_spoof"), opts.get("canvas_noise")
    headless = opts.get("headless")
    user_args = opts.get("_user_args") or []

    # --- proxy / geo coherence ---
    if server and not geoip and not tz and not lang:
        warn("proxy-no-geo",
             "proxy set without geoip and no timezone/accept_language - the browser's timezone and "
             "language will reflect THIS host, not the proxy's exit region (a geo-mismatch tell). "
             "Resolve the proxy location and pass timezone + accept_language under overrides.")
    if server and geoip and _is_socks(server):
        warn("socks-geoip",
             "geoip cannot resolve a SOCKS proxy's exit IP - timezone/language will NOT auto-match. "
             "Set timezone + accept_language (+ webrtc_ip) manually for SOCKS proxies.")

    # --- persona / cross-signal coherence ---
    fam = _host_family(host)
    if platform and fam and platform != fam and not profile:
        warn("platform-host-fonts",
             "platform=%r but this host is %s and no fingerprint_profile supplies that OS's "
             "fonts/metrics - font, canvas and font-list hashes will be host-native and won't match a "
             "real %s Chrome. Use a fingerprint_profile captured on %s, or set platform=%r."
             % (platform, fam, platform, platform, fam))
    if gpu_r and platform:
        why = _gpu_incoherent(gpu_r, platform)
        if why:
            warn("gpu-platform",
                 "gpu_renderer is incoherent with platform=%r (%s): %r." % (platform, why, gpu_r))
    if gpu_r and any(s in gpu_r.lower() for s in _SOFTWARE_GPU):
        warn("gpu-software",
             "gpu_renderer is a SOFTWARE renderer (%r) - a real consumer machine reports a hardware "
             "GPU. Pin a real GPU string, or use a real-GPU host." % gpu_r)
    profile_v4 = isinstance(opts.get("fingerprint_profile"), dict) and opts["fingerprint_profile"].get("schema_version") == 4
    # A schema 4 persona names its own brand (chrome or edge), and the engine is built for it.
    if brand and not profile_v4 and str(brand).lower() not in ("chrome", "google chrome"):
        warn("brand-mismatch",
             "brand=%r is advertised in UA-CH, but the binary's TLS/JA4 and engine are Chrome %s - a "
             "UA-vs-transport mismatch sites can cross-check. Keep brand=chrome." % (brand, build_major))
    if bver and str(bver).split(".")[0] != build_major:
        warn("version-mismatch",
             "brand_version major %s differs from the build's Chrome %s - JA4/UA-CH version desync. "
             "Align brand_version to %s (or omit it)." % (str(bver).split(".")[0], build_major, build_major))

    # A persona's font list is bounded by what this machine can actually render: the engine
    # reports host INTERSECT list, and a listed-but-uninstalled family still measures absent.
    # That is the safety property -- but it also means a rich donor imported onto a lean host
    # quietly collapses. A 1,513-font profile on a 115-font host yields ~65 fonts and, until
    # now, said nothing, leaving the caller believing they present an identity they do not.
    reach = opts.get("_font_reach")
    if reach and reach[0] >= 40 and reach[1] < reach[0] // 2:
        warn("persona-fonts-unreachable",
             "the fingerprint_profile claims %d fonts but this host can render only %d of them - "
             "the persona's font identity is not achievable here, and what a site sees is that "
             "intersection, not the donor's list. Fonts are the highest-entropy surface measured "
             "(9.45 bits; 35%% of machines are unique on it), so this is a large divergence from "
             "the captured machine. Install the missing families, or use a profile captured on a "
             "host like this one (profile=\"auto\" selects for host coherence)."
             % (reach[0], reach[1]))

    # --- render coherence ---
    # The GPU string can be made real in two different ways, and each leaves a DIFFERENT amount of
    # noise behind, so the advice differs. Fire neither once the operator has already turned the
    # relevant noise off, or the warning contradicts the setting they just made.
    # Canvas mode (identity API: overrides canvas="real"|"noise", see _canvas.py). "real" is this
    # computer's genuine canvas output, the same for every profile on this computer; the SDK adds no
    # noise switch and nothing below warns about noise. "noise" is unique to the profile and stable
    # across launches and sites (--fingerprint-noise-key). Only noise mode can put altered pixels
    # next to a real GPU string.
    noise_mode = _warned_canvas_mode(opts) == "noise"
    real_hint = " Use canvas='real' (the default) for this computer's genuine canvas output."
    fixed = engine_has_gpu_canvas_fixes(engine_version)
    if dgf and noise_mode:
        warn("gpu-noise",
             "disable_gpu_fingerprint presents the REAL GPU, but canvas mode 'noise' makes the canvas "
             "output unique to the profile - altered pixels next to a real GPU are themselves a tell."
             + real_hint)
    # gpu_string_spoof=False. On engines before ant0.8 the switch is ignored; that case is covered by the
    # gpu-string-only warning below, so this warning is for ant0.8+ only (no two messages saying the same).
    if gpu_string_spoof is False and not dgf and noise_mode and fixed:
        warn("gpu-noise-string",
             "gpu_string_spoof=False reports the REAL WebGL vendor/renderer, but canvas mode 'noise' makes "
             "the canvas output unique to the profile - a real string over altered pixels is itself a tell."
             + real_hint)
    if gpu_string_spoof is False and not dgf and not fixed:
        warn("gpu-string-only",
             "engines before ant0.8 ignore gpu_string_spoof=False, so the setting has no effect until "
             "the engine is upgraded: this launch still reports the full persona GPU (WebGL "
             "vendor/renderer, getParameter limits, extension list, shader precision and the "
             "navigator.gpu WebGPU identity). Upgrade the engine to ant0.8 or later, or use "
             "disable_gpu_fingerprint=True to take the whole GPU surface real.")
    if canvas_noise is False and not fixed and noise_mode:
        note("canvas-noise-toblob",
             "engines before ant0.8 ignore canvas_noise=False, so the setting has no effect until the "
             "engine is upgraded; this launch is in canvas mode 'noise'. Upgrade the engine to ant0.8 "
             "or later." + real_hint)
    if noise_mode and noise is False:
        warn(CANVAS_NOISE_CONFLICT_CODE, CANVAS_NOISE_CONFLICT_MESSAGE)
    # A persona that presents a hardware GPU on a Linux host with NO GPU device renders on a software
    # rasterizer: the renderer STRING claims a real GPU while MAX_TEXTURE_SIZE, the WebGL extension
    # list and navigator.gpu (WebGPU adapter) report software-tier capabilities -- exactly what an
    # automated-traffic scorer would flag. Computed with a host device check in
    # _prepare and threaded in as _gpu_host_missing; supersedes the vaguer headless-render note.
    gpu_unreachable = opts.get("_gpu_host_missing")
    if gpu_unreachable:
        warn("persona-gpu-unreachable",
             "the %s persona presents a hardware GPU (an ANGLE/Direct3D11 discrete-GPU renderer "
             "string), but this Linux host exposes no GPU device (/dev/dri absent), so WebGL and "
             "WebGPU fall back to a software rasterizer. A site can read the "
             "contradiction directly: the renderer STRING claims a real GPU while MAX_TEXTURE_SIZE, "
             "the WebGL extension list and navigator.gpu (the WebGPU adapter) report software-tier "
             "capabilities. Run on a host with a real GPU (and drop --disable-gpu)." % gpu_unreachable)
    if headless is not False and not dgf and not profile and not gpu_unreachable:
        note("headless-render",
             "headless with no disable_gpu_fingerprint/fingerprint_profile - canvas and "
             "WebGL may render on software here while the persona claims a hardware GPU (a render-vs-"
             "string mismatch on canvas-scored sites). Use disable_gpu_fingerprint or a "
             "real-GPU host.")

    # --- automation hygiene ---
    if opts.get("_cache_dir_given"):
        note("cache-dir-ignored",
             "cache_dir is ignored on launch: the engine comes from runtime discovery. To choose the "
             "download cache, use executable_path(cache_dir=...).")
    if any("--enable-automation" in str(a) or str(a).startswith("--remote-debugging-port")
           for a in user_args):
        warn("automation-arg",
             "your args re-introduce an automation flag (--enable-automation / --remote-debugging-port) "
             "the SDK strips by default - a strong webdriver/CDP tell.")
    return out


def emit_coherence_warnings(opts, quiet=False, host_platform=None, build_major=None, engine_version=None):
    """Print coherence warnings to stderr (unless quiet=True or ANT0_BROWSER_NO_WARN is set).
    NOTE-level lines (and gpu-string-only) fire at most once per process; other WARN-level lines fire every launch."""
    if quiet or os.environ.get("ANT0_BROWSER_NO_WARN"):
        return
    for w in coherence_warnings(opts, host_platform=host_platform, build_major=build_major,
                           engine_version=engine_version):
        if w["severity"] == "note" or w["code"] in _ONCE_WARN_CODES:
            if w["code"] in _seen_notes:
                continue
            _seen_notes.add(w["code"])
        label = "warning" if w["severity"] == "warn" else "note"
        print("ant0browser: %s: %s" % (label, w["message"]), file=sys.stderr, flush=True)


_canvas_bridge_noted = False


def warn_canvas_bridge_removed(quiet=False):
    """One-time note that ``canvas_bridge`` was removed and its value is ignored. Never raises."""
    global _canvas_bridge_noted
    if _canvas_bridge_noted:
        return
    _canvas_bridge_noted = True
    if quiet or os.environ.get("ANT0_BROWSER_NO_WARN"):
        return
    print("ant0browser: note: canvas_bridge was removed and is ignored. Use a host with a real GPU "
          "for hardware canvas/WebGL.", file=sys.stderr, flush=True)


def reset_canvas_bridge_note():
    """Test hook: forget that the note was shown."""
    global _canvas_bridge_noted
    _canvas_bridge_noted = False


#: Code and text of the warning for ``canvas="noise"`` together with ``fingerprint_noise=False``. The
#: args are unchanged (both switches are sent); the combination just contradicts itself.
CANVAS_NOISE_CONFLICT_CODE = "canvas-noise-conflict"
CANVAS_NOISE_CONFLICT_MESSAGE = (
    "canvas mode 'noise' is combined with fingerprint noise switched off (fingerprintNoise:false in Node, "
    "fingerprint_noise=False in Python). The SDK sends both the noise key and --disable-fingerprint-noise, "
    "and the combination contradicts itself. Drop the fingerprint noise override, or use canvas \"real\" for "
    "this computer's genuine canvas output.")

#: The text of the ``canvas-noise-no-key`` warning.
CANVAS_NOISE_NO_KEY_MESSAGE = (
    "canvas_noise / fingerprint_noise: True no longer turn canvas noise on; this launch uses real readback. "
    "To get a per-profile canvas, set overrides canvas to \"noise\" (with overrides canvas_noise_key, or a "
    "synthetic identity, which has a key).")


def warn_canvas_noise_no_key(quiet=False):
    """Warn (every launch, to stderr) that legacy canvas_noise/fingerprint_noise=True does not enable noise
    and the launch stays real."""
    if quiet or os.environ.get("ANT0_BROWSER_NO_WARN"):
        return
    print("ant0browser: warning: [canvas-noise-no-key] " + CANVAS_NOISE_NO_KEY_MESSAGE,
          file=sys.stderr, flush=True)


def debug_log(message):
    """A debug-level line: printed only when ANT0_BROWSER_DEBUG is set."""
    if os.environ.get("ANT0_BROWSER_DEBUG"):
        print(f"ant0browser: debug: {message}", file=sys.stderr, flush=True)


#: Code and text of the warning for a platform or brand override on a schema 4 persona (same in the Node SDK).
PERSONA_IDENTITY_OVERRIDE_CODE = "persona-identity-override"
PERSONA_IDENTITY_OVERRIDE_MESSAGE = (
    "a platform or brand override is mixed with a schema 4 persona. The override wins over the persona's "
    "identity and only the value you set is passed (the persona's versions are not carried along), so the "
    "page can show an identity the persona does not describe. Drop the override to present the persona as issued.")


def warn_persona_identity_override(quiet=False):
    if quiet or os.environ.get("ANT0_BROWSER_NO_WARN"):
        return
    print(f"ant0browser: warning: [{PERSONA_IDENTITY_OVERRIDE_CODE}] {PERSONA_IDENTITY_OVERRIDE_MESSAGE}",
          file=sys.stderr, flush=True)


def emit_persona_notices(notices, quiet=False):
    """Print persona notices (``{"code", "message"}``, see ``_profile_file``) to stderr as warnings, every
    launch, unless quiet or ANT0_BROWSER_NO_WARN."""
    if quiet or os.environ.get("ANT0_BROWSER_NO_WARN"):
        return
    for n in notices:
        print("ant0browser: warning: [%s] %s" % (n["code"], n["message"]), file=sys.stderr, flush=True)
