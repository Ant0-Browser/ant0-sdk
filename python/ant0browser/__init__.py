"""Ant0 Browser — Playwright drop-in (Python).

    from ant0browser import launch

    browser = launch(identity={"mode": "native"})
    page = browser.new_page()
    page.goto("https://example.com/")
    browser.close()

launch() returns a Playwright browser handle backed by a caller-provided Ant0 Browser binary.
Every Playwright launch option (headless, proxy, args, timeout, ...) passes through. Identity is
selected with the strict native, captured, or synthetic API.

Since 0.23.0 it launches on a throwaway PROFILE directory rather than incognito, because
incognito cannot load the Widevine CDM and its absence is itself a fingerprint on a build
branded Google Chrome. The directory is deleted on close and on interpreter exit, so no state
survives the run. ``ephemeral_profile=False`` restores the old incognito launch.
"""

import atexit
import os
import sys

from ._errors import SdkRuntimeError, SdkTypeError, SdkValueError
from ._runtime_client import RuntimeError as RuntimeClientError
from .release_fetch import ReleaseError, SignatureError
from ._fingerprint import FINGERPRINT_KEYS, PROFILE_FILE_SWITCH, fingerprint_args, persona_avail, persona_dpr
from ._profile_file import (
    cleanup_persona_temp_dir, cleanup_when_closed, remove_stale_persona_file, stage_persona_profile,
)
from ._scale import scale_window_args, with_device_scale
from ._content import set_content
from ._fontpersona import font_reachability
from ._fonts import apply_font_env
from ._shaderdialect import apply_shader_dialect
from ._geometry import apply_headless_geometry, initial_window_args
from ._humanize import install_humanize, install_humanize_on_context
from ._launch_ticket import (
    LAUNCH_TICKET_EXIT_CODE, LAUNCH_TICKET_REJECTED_CODE, LAUNCH_TICKET_SWITCH,
    LaunchTicketRejectedError, LaunchTicketUnavailableError, discover_daemon, fetch_launch_ticket,
    infer_engine_version, installed_engine_version, launch_ticket_rejection, reraise_if_ticket_rejected, resolve_launch_ticket_args, launch_secret_values,
    CALLER_ENV_KEY, LAUNCH_TICKET_ENV, retry_stale_ticket, apply_ticket_env_to_kwargs, args_for_ticket_decision,
)
from ._persona_rejected import PERSONA_FILE_EXIT_CODE, PERSONA_FILE_REJECTED_CODE, PersonaFileRejectedError
from ._runtime_client import prepare_runtime_launch
from ._launchopts import (  # noqa: F401  (web_bluetooth_args re-exported for tests)
    assert_no_reserved_args,
    dom_storage_backend_args,
    extension_args,
    merge_feature_flags,
    privacy_sandbox_args,
    quic_args,
    socks5_udp_args,
    resolve_proxy,
    web_bluetooth_args,
    persona_platform_of,
    gate_webrtc_args,
    IGNORED_PLAYWRIGHT_DEFAULTS,
    with_playwright_feature_defaults,
    merge_ignore_default_args,
    webrtc_default_deny_args,
)
from ._render import check_render_coherence
from ._warnings import emit_coherence_warnings, emit_persona_notices, gpu_host_missing_for
from ._widevine import apply_widevine_launch, fetch_widevine, seed_widevine
from .download import ensure_binary
from .geoip import resolve_geo
from .fontpack import pack_families, resolve_font_pack
from .chromium_version import CHROMIUM_MAJOR, CHROMIUM_UA_VERSION, CHROMIUM_VERSION
from .persona_profile import PersonaProfileValidationError, validate_persona_profile
from .persona_migration import (
    MIGRATED_FIELDS, PersonaMigrationError, migrate_persona_browser_major, needs_migration,
    persona_browser_major,
)
from .template_selection import PersonaTemplate, select_persona_template
from .population_model import (
    GENERATE_ALGORITHM, PopulationModelError, generate_persona_profile, load_population_model,
)
from .identity_persistence import (
    IDENTITY_WRAPPER_VERSION, GENERATED_IDENTITY_WRAPPER_VERSION, ISSUED_IDENTITY_WRAPPER_VERSION,
    TEMPLATE_SELECTION_ALGORITHM,
    IdentityPersistenceError, PersistedIdentity, create_or_load_generated_identity,
    create_or_load_issued_identity, create_or_load_identity, identity_filename, load_or_create_device_key,
    load_persisted_identity, resolve_identity_directory, validate_persisted_identity,
)
from .identity import (
    Identity, NativeIdentity, CapturedIdentity, SyntheticIdentity, IdentityOverrides, NetworkOverride,
    load_template_directory, load_captured_profile, resolve_identity, prepare_identity_options,
    canvas_noise_key_of_identity,
)
from .persona_profile_v4 import PersonaV4SchemaError, is_persona_v4, validate_persona_profile_v4
from ._canvas import (
    CANVAS_NOISE_KEY_SWITCH, canvas_mode, canvas_noise_key_for, derive_canvas_noise_key,
    is_canvas_noise_key, new_canvas_noise_key,
)
from ._profile_file import (
    PROFILE_FILE_NAME, SDK_INFO_SWITCH, engine_persona_info, engine_persona_schemas, parse_sdk_info_schemas,
    write_persona_profile_file,
)
from ._claim_hints import ClaimBrand, ClaimHints, ClaimHostGpuVendor, ClaimLocale
from .release import RELEASE
from ._serve import Server, serve

__all__ = [
    "PersonaV4SchemaError", "is_persona_v4", "validate_persona_profile_v4",
    "CANVAS_NOISE_KEY_SWITCH", "canvas_mode", "canvas_noise_key_for", "derive_canvas_noise_key",
    "is_canvas_noise_key", "new_canvas_noise_key", "canvas_noise_key_of_identity",
    "PROFILE_FILE_NAME", "SDK_INFO_SWITCH", "engine_persona_info", "engine_persona_schemas", "parse_sdk_info_schemas",
    "write_persona_profile_file", "create_or_load_issued_identity", "ISSUED_IDENTITY_WRAPPER_VERSION",
    "ClaimBrand", "ClaimHints", "ClaimHostGpuVendor", "ClaimLocale",
    "launch",
    "set_content",
    "launch_persistent_context",
    "serve",
    "Server",
    "executable_path",
    "resolve_geo",
    "resolve_font_pack",
    "pack_families",
    "validate_persona_profile",
    "PersonaProfileValidationError",
    "CHROMIUM_VERSION",
    "CHROMIUM_MAJOR",
    "CHROMIUM_UA_VERSION",
    "migrate_persona_browser_major",
    "needs_migration",
    "persona_browser_major",
    "PersonaMigrationError",
    "MIGRATED_FIELDS",
    "PersonaTemplate",
    "select_persona_template",
    "GENERATE_ALGORITHM",
    "PopulationModelError",
    "generate_persona_profile",
    "load_population_model",
    "IDENTITY_WRAPPER_VERSION",
    "GENERATED_IDENTITY_WRAPPER_VERSION",
    "TEMPLATE_SELECTION_ALGORITHM",
    "IdentityPersistenceError",
    "PersistedIdentity",
    "resolve_identity_directory",
    "identity_filename",
    "load_or_create_device_key",
    "validate_persisted_identity",
    "load_persisted_identity",
    "create_or_load_identity",
    "create_or_load_generated_identity",
    "Identity",
    "NativeIdentity",
    "CapturedIdentity",
    "SyntheticIdentity",
    "IdentityOverrides",
    "NetworkOverride",
    "load_template_directory",
    "load_captured_profile",
    "resolve_identity",
    "prepare_identity_options",
    "check_render_coherence",
    "SdkRuntimeError",
    "SdkTypeError",
    "SdkValueError",
    "RuntimeClientError",
    "ReleaseError",
    "SignatureError",
    "LaunchTicketRejectedError",
    "PersonaFileRejectedError",
    "PERSONA_FILE_EXIT_CODE",
    "PERSONA_FILE_REJECTED_CODE",
    "LaunchTicketUnavailableError",
    "LAUNCH_TICKET_SWITCH",
    "LAUNCH_TICKET_ENV",
    "LAUNCH_TICKET_EXIT_CODE",
    "LAUNCH_TICKET_REJECTED_CODE",
    "discover_daemon",
    "fetch_launch_ticket",
    "infer_engine_version",
    "launch_ticket_rejection",
    "resolve_launch_ticket_args",
    "fetch_widevine",
    "seed_widevine",
    "RELEASE",
    "__version__",
]
__version__ = "0.2.2"

_pw = None  # the shared, lazily-started Playwright driver (one per process)


def _stop_quietly(pw):
    try:
        pw.stop()
    except Exception:  # noqa: BLE001
        pass


def _release_runtime_pin(release):
    if callable(release):
        try:
            release()
        except Exception:  # noqa: BLE001
            pass


def _playwright():
    global _pw
    if _pw is None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise SdkRuntimeError("sdk.playwright_missing", 
                "ant0browser requires Playwright. Install it with:\n    pip install playwright\n"
                "(You do NOT need 'playwright install' — Ant0 Browser uses its own browser binary.)"
            ) from exc
        _pw = sync_playwright().start()
        atexit.register(_stop_quietly, _pw)
    return _pw


def _resolve_binary(executable_path=None, cache_dir=None, quiet=False):
    from .download import check_install

    if executable_path:
        # Caller-supplied tree (often a browser bundled into a packaged app): we did not install it,
        # so validate it here — a half-copied tree otherwise CHECK-crashes during browser startup.
        check_install(executable_path)
        return executable_path
    env = os.environ.get("ANT0_BROWSER_BINARY")
    if env:
        check_install(env)
        return env
    return ensure_binary(cache_dir=cache_dir, quiet=quiet)


def executable_path(executable_path=None, cache_dir=None, quiet=False):
    """Resolve an explicit, environment-provided, or already-cached local browser binary."""
    return _resolve_binary(executable_path, cache_dir, quiet)


def _guard(exe):
    from .release import platform_release
    if platform_release() is None:
        raise SdkRuntimeError("sdk.environment_unsupported", 
            f"Ant0 Browser {RELEASE['version']} ships Windows x64 and Linux x64 binaries — there is no "
            f"build for {sys.platform!r}.\nRun on Windows or Linux, or pass executable_path=... to a "
            f"compatible binary.\n(The resolved local binary is: {exe})"
        )


def _resolve_identity_option(kwargs):
    """Resolve the authoritative identity API before any launch-side effects."""
    if "_ant0_identity_mode" in kwargs:
        return
    identity_mode, prepared = prepare_identity_options(kwargs, FINGERPRINT_KEYS)
    kwargs.clear()
    kwargs.update(prepared)
    kwargs["_ant0_identity_mode"] = identity_mode


#: Stands in for the persona file's path while the engine is not resolved yet; replaced in _prepare.
_PERSONA_FILE_PLACEHOLDER = "<ant0-persona-file>"


def _prepare(kwargs):
    _resolve_identity_option(kwargs)
    identity_mode = kwargs.pop("_ant0_identity_mode", None)
    # The profile directory the persona file (schema 4) is written to; None for a launch with no
    # profile of its own. Set by the launch functions, never by a caller.
    persona_dir = kwargs.pop("_ant0_user_data_dir", None) or None  # "" is no directory
    humanize = kwargs.pop("humanize", False)
    show_cursor = kwargs.pop("show_cursor", False)
    # widevine= is seeded into a persistent profile by launch_persistent_context; pop it here so it
    # never leaks to Playwright from launch()/the async path (incognito can't load the component CDM).
    kwargs.pop("widevine", None)
    fp = {k: kwargs.pop(k) for k in list(kwargs) if k in FINGERPRINT_KEYS}
    exe_path = kwargs.pop("executable_path", None)
    extra_args = kwargs.pop("args", None)
    extensions = kwargs.pop("extensions", None)
    # Keep these APIs enabled unless the caller explicitly requests the de-Googled policy.
    disable_privacy_sandbox = kwargs.pop("disable_privacy_sandbox", False)
    socks5_udp = kwargs.pop("socks5_udp", False)  # --socks5-udp: not implemented by the engine yet (see socks5_udp_args)
    cache_dir = kwargs.pop("cache_dir", None)  # accepted but ignored on launch; noted below
    quiet = kwargs.pop("quiet", False)
    runtime = kwargs.pop("runtime", None)
    resolve_fonts = kwargs.pop("resolve_fonts", True)  # deprecated, no effect (look-alike fonts are always used)
    # A ticket string, False (never ask a daemon), or None (fetch from ant0d).
    launch_ticket = kwargs.pop("launch_ticket", None)
    engine_version = kwargs.pop("engine_version", None)
    proxy_opt = kwargs.get("proxy")  # captured before resolve_proxy runs (for quic + warnings)
    # resolve_proxy raises ValueError for a credentialed SOCKS proxy (nothing in the stack can
    # authenticate to one; use a relay). Every other shape is left to Playwright unchanged.
    proxy_args, proxy = resolve_proxy(kwargs.get("proxy"))
    if proxy is None:
        kwargs.pop("proxy", None)
    else:
        kwargs["proxy"] = proxy
    # Persona scale: --force-device-scale-factor comes from fingerprint_args; a headed window is kept
    # on the real display (the caller's own args are appended later and win).
    dpr = persona_dpr(fp)
    headed_launch = kwargs.pop("_ant0_headed", False) or kwargs.get("headless") is False
    persona_v4 = isinstance(fp.get("fingerprint_profile"), dict) and fp["fingerprint_profile"].get("schema_version") == 4
    args_fp = {**fp, "fingerprint_profile_file": _PERSONA_FILE_PLACEHOLDER} if persona_v4 else fp
    sdk_args = scale_window_args(fingerprint_args(args_fp, identity_api=True), dpr, headed_launch,
                                 persona_avail(fp), extra_args or [])
    base = sdk_args + extension_args(extensions) + proxy_args
    base += quic_args(proxy_opt)  # behind a proxy, disable QUIC so no HTTP/3 UDP egresses around it
    # Opt-in switch; the engine ignores it today, so UDP stays denied (see socks5_udp_args).
    base += socks5_udp_args(socks5_udp, proxy_opt)
    # Linux hosts hide navigator.bluetooth while exposing usb/serial/hid — an OS-origin tell on a
    # Windows persona. Restore it (no-op off Linux). See web_bluetooth_args.
    base += web_bluetooth_args(persona_platform_of(fp.get("platform"), fp.get("fingerprint_profile")) or "")
    if disable_privacy_sandbox:
        base += privacy_sandbox_args()
    # serve() pins here; the Playwright launch paths pin in with_playwright_feature_defaults, only when
    # Playwright's own disabled list is known (else this switch would wipe it).
    if kwargs.pop("_ant0_dom_storage_pin", False):
        base += dom_storage_backend_args()  # Ant0 profile sync captures only the leveldb DOM storage backend
    user = list(extra_args or [])
    assert_no_reserved_args(user)
    # default WebRTC to leak-proof unless the user wired a webrtc_ip / policy themselves
    base += webrtc_default_deny_args(base + user, fp.get("webrtc_ip"))
    # collapse all --enable-features/--disable-features (ours + the user's) into one of each, else
    # Chromium keeps only the last occurrence and the rest are silently dropped.
    args = merge_feature_flags(base + user)
    # Fonts: the real Windows font pack is retired; resolve_font_pack always returns None, so a
    # persona on Linux uses the bundled look-alike fonts (+ the warning below).
    font_pack = None
    pack_fams = None
    if resolve_fonts and identity_mode in ("captured", "synthetic") and sys.platform == "linux":
        from .fontpack import pack_families, resolve_font_pack
        font_pack = resolve_font_pack(quiet=quiet)
        if font_pack:
            pack_fams = pack_families(font_pack)
    kwargs["_ant0_font_pack"] = font_pack
    # --ant0-launch=<ticket>: the caller's, one fetched for an explicit binary, or the runtime
    # result for automatic discovery. Runtime pins are private and released by the immediate
    # launch/serve spawn path, so _prepare's public six-tuple shape stays stable.
    kwargs[CALLER_ENV_KEY] = dict(kwargs["env"]) if kwargs.get("env") else None  # the caller's own env, for the ticket rule
    runtime_launch = prepare_runtime_launch(
        executable_path=exe_path,
        launch_ticket=launch_ticket,
        engine_version=engine_version,
        runtime=runtime,
        args=args_for_ticket_decision(args, kwargs.get("env")),
        quiet=quiet,
    )
    try:
        exe = runtime_launch.executable
        _guard(exe)
        if persona_v4:
            # Schema 4 personas travel in a private file inside the profile directory, and only to an
            # engine that advertises the format (sdk.persona_requires_engine otherwise).
            notices = []
            staged = stage_persona_profile(fp, exe, persona_dir, notices=notices)
            emit_persona_notices(notices, quiet=quiet)
            if not persona_dir:
                # A temporary directory was made: the launch step removes it when the browser closes.
                kwargs["_ant0_persona_tmp"] = os.path.dirname(staged["fingerprint_profile_file"])
            args = [f"{PROFILE_FILE_SWITCH}={staged['fingerprint_profile_file']}"
                    if a == f"{PROFILE_FILE_SWITCH}={_PERSONA_FILE_PLACEHOLDER}" else a for a in args]
        elif persona_dir is not None:
            # This launch has no schema 4 persona: a persona file left in the profile by an earlier one goes.
            remove_stale_persona_file(persona_dir)
        # Engines older than ant0.3 turn non-proxied UDP back on when --webrtc-ip is set; only now
        # is the engine release known, so the flag is dropped here (unknown version counts as old).
        args = gate_webrtc_args(args, getattr(runtime_launch, "engine_version", None), quiet=quiet,
                                has_proxy=bool(proxy_opt and proxy_opt.get("server")))
        args += runtime_launch.ticket_args
        # Drop Playwright's default automation flag so the engine's AutomationControlled feature stays
        # OFF (it otherwise flips navigator.webdriver-adjacent tells). The control transport
        # (--remote-debugging-pipe) is left intact. Caller can override via their own ignore_default_args.
        # NOTE: launch_persistent_context sets this BEFORE the Widevine helper so that helper appends
        # --disable-component-update rather than clobbering the automation strip.
        kwargs["ignore_default_args"] = merge_ignore_default_args(kwargs.get("ignore_default_args"), extra_args)
        # Surface incoherent / missing-recommended option combos the SDK can't auto-fix (stderr; gated
        # by quiet / ANT0_BROWSER_NO_WARN).
        kwargs["_ant0_runtime_release"] = runtime_launch.release
        # _font_reach is computed HERE, not inside coherence_warnings, because enumerating the
        # host's installed families is I/O and that function is documented (and tested) as pure. It
        # folds in the wired pack so the warning reflects what the browser will actually render.
        emit_coherence_warnings(
            {**fp, "proxy": proxy_opt, "geoip": False, "headless": kwargs.get("headless"),
             "_user_args": user, "_cache_dir_given": cache_dir is not None,
             "_font_reach": font_reachability(fp.get("fingerprint_profile"), pack_fams),
             "_gpu_host_missing": gpu_host_missing_for(fp, identity_mode)},
            quiet=quiet, build_major=str(RELEASE["version"]).split(".")[0],
            # The release the engine we are about to start identifies as; a dev build's label is
            # allowed here (advisory only), the strict gate value above is not.
            engine_version=(getattr(runtime_launch, "engine_version", None)
                            or installed_engine_version(exe, allow_dev=True)))
        # The motor-persona seed is the EFFECTIVE fingerprint (after the profile= merge above), i.e. the
        # same value that becomes --fingerprint — not the raw pre-merge kwarg. A profile-based launch
        # thus gets the profile's stable persona instead of a random one.
        kwargs["_ant0_native_identity"] = identity_mode == "native"
        kwargs["_ant0_dpr"] = dpr
        return exe, args, kwargs, humanize, show_cursor, fp.get("fingerprint")
    except BaseException:
        _release_runtime_pin(runtime_launch.release)
        cleanup_persona_temp_dir(kwargs.pop("_ant0_persona_tmp", None))
        raise


def _take_persona_tmp(pw_kwargs):
    """Remove and return the temporary persona directory ``_prepare`` made for a launch with no profile
    directory (None otherwise). Called by the launch steps that own a browser to close."""
    return pw_kwargs.pop("_ant0_persona_tmp", None)


def _take_internal(pw_kwargs):
    """Remove the keys ``_prepare`` adds for the launch step and return them as
    ``(native_identity, dpr, font_pack, runtime_release)``.

    Every launch path (sync, async, serve) calls this on ``_prepare``'s kwargs, so none of the
    ``_ant0_`` keys reaches Playwright and every path gets the same resolved font pack."""
    return (
        pw_kwargs.pop("_ant0_native_identity", False),
        pw_kwargs.pop("_ant0_dpr", None),
        pw_kwargs.pop("_ant0_font_pack", None),
        pw_kwargs.pop("_ant0_runtime_release", None),
    )


def _headed_no_viewport(pw_kwargs):
    """A headed launch with Playwright's default emulated viewport (1280x720) sitting on the real
    OS window makes window.innerWidth/Height disagree with the actual window — an impossible-window
    tell that defeats the engine's coherence. True when headed and no viewport was requested, so we
    default new pages/contexts to no_viewport (innerWidth then tracks the real window)."""
    return (pw_kwargs.get("headless") is False
            and not any(k in pw_kwargs for k in ("viewport", "no_viewport", "screen")))


def _install_headed_viewport(browser, dpr=None):
    """Default a headed browser's new pages/contexts to no_viewport (unless the caller sets one).
    A caller viewport gets the persona's scale (a viewport alone emulates scale 1)."""
    orig_new_page, orig_new_context = browser.new_page, browser.new_context

    def new_page(**kw):
        if not any(k in kw for k in ("viewport", "no_viewport", "screen")):
            kw["no_viewport"] = True
        return orig_new_page(**with_device_scale(kw, dpr))

    def new_context(**kw):
        if not any(k in kw for k in ("viewport", "no_viewport", "screen")):
            kw["no_viewport"] = True
        return orig_new_context(**with_device_scale(kw, dpr))

    browser.new_page, browser.new_context = new_page, new_context


def _headless_geometry_kwargs(pw_kwargs, seed, args=None):
    """The headless geometry defaults for this launch, or None if they don't apply.

    ``apply_headless_geometry`` mutates, and ``chromium.launch()`` accepts neither ``viewport`` nor
    ``screen`` (they are context options), so probe a copy and carry the result to the context.
    """
    return apply_headless_geometry(dict(pw_kwargs), seed, args)


def _install_headless_geometry(browser, geom, dpr=None):
    """Default a headless browser's new pages/contexts to ``geom``.

    ``chromium.launch()`` accepts no context options, so defaults ride on new pages/contexts. This
    only supplies context options; native browser geometry is never changed after launch.
    """
    defaults = {"no_viewport": True} if geom.get("mode") == "native" else {
        k: v for k, v in geom.items() if k in ("screen", "viewport")}
    orig_new_page, orig_new_context = browser.new_page, browser.new_context

    def _merge(kw):
        if not any(k in kw for k in ("viewport", "no_viewport", "screen")):
            kw.update(defaults)
        return with_device_scale(kw, dpr)

    def new_page(**kw):
        return orig_new_page(**_merge(kw))

    def new_context(**kw):
        return orig_new_context(**_merge(kw))

    browser.new_page, browser.new_context = new_page, new_context


def _install_ephemeral_profile_cleanup(context, user_data_dir):
    """Delete the throwaway profile directory once the context closes.

    THE DIRECTORY IS THE COST OF THE PERSISTENT DEFAULT, so it has to be paid back reliably.
    A Chromium profile is 5-50MB and this session's audit found 570 leaked browser directories
    on one developer machine from earlier tooling — the failure mode is silent until a disk
    fills, which is exactly when it is most expensive.

    Two triggers, because neither alone is enough:
      * ``close`` fires on an orderly ``context.close()``;
      * the atexit hook covers the interpreter exiting with the context still open, which is what
        a crashing script or a KeyboardInterrupt actually does.
    Both funnel through one idempotent remove, so running twice is harmless.

    THE RETRY IS NOT DEFENSIVE PADDING — a single attempt measurably does not work. On Windows the
    browser process still holds handles under the profile directory for a short window after
    ``close()`` returns, so the first rmtree hits "being used by another process" and, with
    ignore_errors=True, fails SILENTLY. Measured on the first build of this change: the directory
    survived a close plus a 1.5s wait, reported clean, and leaked.

    So: retry with a short backoff, and only swallow the error once the attempts are spent. A
    failed cleanup must never raise into the caller's teardown — the directory is disposable,
    their traceback is not — but it must not be swallowed on the first try either, which is how
    570 directories accumulate without anyone noticing.
    """
    import atexit
    import shutil
    import time

    done = {"v": False}

    def cleanup(*_a):
        if done["v"]:
            return
        for attempt in range(6):
            try:
                shutil.rmtree(user_data_dir)
                done["v"] = True
                return
            except FileNotFoundError:
                done["v"] = True  # already gone: someone else won the race, which is success
                return
            except OSError:
                if attempt == 5:
                    break
                time.sleep(0.25 * (attempt + 1))  # 0.25→1.5s, ~5s total
        # Out of attempts. Leave it for the atexit pass (the browser is usually gone by then);
        # if that fails too the OS temp sweeper reclaims it, and `done` stays False so the
        # atexit hook genuinely retries rather than short-circuiting.
        shutil.rmtree(user_data_dir, ignore_errors=True)

    context.on("close", cleanup)
    atexit.register(cleanup)
    return cleanup


def _install_persistent_as_browser(context):
    """Make a persistent BrowserContext satisfy the code written against ``launch()``'s Browser.

    launch() has always returned a Playwright ``Browser`` and is documented as a drop-in, so the
    persistent default cannot simply hand back a ``BrowserContext``: ``browser.new_context()`` is
    ordinary Playwright and would break at the call site.

    ``new_context()`` therefore returns THE PERSISTENT CONTEXT ITSELF rather than a fresh incognito
    one. That is the deliberate part: a real incognito context would silently leave the profile
    behind and take the Widevine CDM, the component-updated state and the cookies with it — the
    caller would get back exactly the browser this change exists to stop handing them. Two calls
    returning the same context is a visible, documented compromise; quietly returning a browser
    without a profile is not.
    """
    if not hasattr(context, "new_context"):
        context.new_context = lambda **_kw: context
    if not hasattr(context, "contexts"):
        context.contexts = [context]
    return context


def launch(**kwargs):
    """Launch Ant0 Browser and return a Playwright browser handle backed by a REAL Chrome profile.

    ``identity`` selects native, captured, or synthetic behavior and defaults to native when
    omitted. Explicit supported identity switches belong under ``overrides``. Other kwargs
    (headless, proxy, args, timeout, ...) pass through to Playwright.

    PROFILE-BACKED BY DEFAULT (changed in 0.23.0). This used to be ``chromium.launch()`` —
    incognito, no profile directory. Incognito cannot load a component-updated CDM, so
    ``requestMediaKeySystemAccess('com.widevine.alpha')`` rejected and the EME surface was a
    no-Widevine tell on a build branded Google Chrome (measured against the live audit on
    150-r10). It now launches a persistent context on a throwaway directory, so ``widevine=True``
    works here and the profile-shaped surface matches a real Chrome.

    The directory is deleted when the context closes AND on interpreter exit — nothing is left
    behind, and no state survives to the next launch, so the incognito-like isolation callers
    relied on is preserved. Pass ``user_data_dir=`` to keep a profile instead (or call
    ``launch_persistent_context`` directly), and ``ephemeral_profile=False`` to opt back out.
    """
    # ephemeral_profile=False restores the pre-0.23 incognito launch. Kept because the persistent
    # path costs a directory create+delete per launch, which a caller spawning hundreds of
    # short-lived browsers may reasonably not want to pay for a CDM they never touch.
    ephemeral = kwargs.pop("ephemeral_profile", True)
    explicit_dir = kwargs.pop("user_data_dir", None)
    if explicit_dir is not None:
        return launch_persistent_context(explicit_dir, **kwargs)
    if ephemeral:
        import tempfile
        import shutil

        udd = tempfile.mkdtemp(prefix="ant0-browser-run-")
        try:
            context = launch_persistent_context(udd, **kwargs)
        except BaseException:
            shutil.rmtree(udd, ignore_errors=True)
            raise
        _install_ephemeral_profile_cleanup(context, udd)
        return _install_persistent_as_browser(context)

    return _launch_incognito(**kwargs)


@retry_stale_ticket
def _launch_incognito(**kwargs):
    """The pre-0.23 incognito launch, reached via ``ephemeral_profile=False``."""
    shader_dialect = kwargs.pop("shader_dialect", None)  # popped before _prepare: not a PW option

    quiet = kwargs.get("quiet", False)  # _prepare pops it; the feature-default fallback warning honours it
    # seed reflects the merged/effective fingerprint (profile-aware) -> stable motor persona
    exe, args, pw_kwargs, humanize, show_cursor, seed = _prepare(kwargs)
    native_identity, dpr, font_pack, runtime_release = _take_internal(pw_kwargs)
    persona_tmp = _take_persona_tmp(pw_kwargs)
    try:
        apply_font_env(exe, pw_kwargs, font_pack)  # Linux: FONTCONFIG_FILE -> real font pack (or clones)
        apply_shader_dialect(shader_dialect, pw_kwargs)  # after fonts: that helper rebuilds the env
        headed = _headed_no_viewport(pw_kwargs)  # launch() takes no viewport kwarg -> wrap new_page/context
        # Headless: screen.* has to be overridden alongside the viewport or the window reports
        # outer > screen (see _geometry). Also a context option, so it rides on new_page/new_context.
        geom = None if headed else (
            None if native_identity and any(k in pw_kwargs for k in ("viewport", "no_viewport", "screen"))
            else {"mode": "native"} if native_identity
            else _headless_geometry_kwargs(pw_kwargs, seed, args)
        )
        args = initial_window_args(args, geom)
        args = with_playwright_feature_defaults(args, pw_kwargs.get("ignore_default_args"), quiet=quiet)  # merge Playwright's feature lists, minus ThirdPartyStoragePartitioning
        args = apply_ticket_env_to_kwargs(args, pw_kwargs)  # The same ticket in ANT0_LAUNCH of the engine child only
        try:
            browser = _playwright().chromium.launch(executable_path=exe, args=args, **pw_kwargs)
        except Exception as exc:  # noqa: BLE001 -- exit 90 + stderr line -> LaunchTicketRejectedError
            failure = exc
        else:
            failure = None
        if failure is not None:
            # Raised outside the handler: no implicit __context__ carries Playwright's error (its message
            # quotes the whole command line, ticket and persona-file path included).
            reraise_if_ticket_rejected(failure, launch_secret_values(args, [], pw_kwargs.get("env")))
    except BaseException:
        cleanup_persona_temp_dir(persona_tmp)
        raise
    finally:
        _release_runtime_pin(runtime_release)
    if persona_tmp:
        cleanup_when_closed(browser, persona_tmp)  # the persona file goes now (the engine has read it), its directory when the browser closes
    if headed:
        _install_headed_viewport(browser, dpr)
    elif geom:
        _install_headless_geometry(browser, geom, dpr)
    install_humanize(browser, humanize, show_cursor, seed=seed)
    return browser


@retry_stale_ticket
def launch_persistent_context(user_data_dir, **kwargs):
    """Launch Ant0 Browser with a persistent profile directory; returns a Playwright
    ``BrowserContext`` (cookies/storage persist in ``user_data_dir``).

    Pass ``widevine=True`` to seed + enable the (opt-in, user-fetched) Widevine CDM so DRM/EME works
    (``requestMediaKeySystemAccess('com.widevine.alpha')`` resolves) and the EME surface matches a
    real Chrome instead of being a no-Widevine tell."""
    # Set the automation strip BEFORE the Widevine helper so it appends --disable-component-update to
    # ['--enable-automation'] rather than replacing it (which would lose the AutomationControlled
    # strip on Widevine launches).
    kwargs["_ant0_user_data_dir"] = os.fspath(user_data_dir)
    _resolve_identity_option(kwargs)
    kwargs["ignore_default_args"] = merge_ignore_default_args(kwargs.get("ignore_default_args"), kwargs.get("args"))
    if kwargs.get("widevine"):
        apply_widevine_launch(user_data_dir, kwargs, quiet=kwargs.get("quiet", False))
    shader_dialect = kwargs.pop("shader_dialect", None)  # popped before _prepare: not a PW option
    quiet = kwargs.get("quiet", False)  # _prepare pops it; the feature-default fallback warning honours it
    # seed reflects the merged/effective fingerprint (profile-aware) -> stable motor persona
    exe, args, pw_kwargs, humanize, show_cursor, seed = _prepare(kwargs)
    native_identity, dpr, font_pack, runtime_release = _take_internal(pw_kwargs)
    persona_tmp = _take_persona_tmp(pw_kwargs)  # only for user_data_dir="" (no directory of its own)
    try:
        apply_font_env(exe, pw_kwargs, font_pack)  # Linux: FONTCONFIG_FILE -> real font pack (or clones)
        apply_shader_dialect(shader_dialect, pw_kwargs)  # after fonts: that helper rebuilds the env
        geom = None
        headed = _headed_no_viewport(pw_kwargs)
        if headed:  # no_viewport IS a valid persistent-context option
            pw_kwargs["no_viewport"] = True
        else:  # headless: native displays use no_viewport; seedless launches use corpus context geometry
            if native_identity and not any(k in pw_kwargs for k in ("viewport", "no_viewport", "screen")):
                pw_kwargs["no_viewport"] = True
                geom = {"mode": "native"}
            elif not native_identity:
                geom = apply_headless_geometry(pw_kwargs, seed, args)
        args = initial_window_args(args, geom)
        pw_kwargs.update(with_device_scale(pw_kwargs, dpr))  # a viewport emulates scale 1: give it the persona's
        args = with_playwright_feature_defaults(args, pw_kwargs.get("ignore_default_args"), quiet=quiet)  # merge Playwright's feature lists, minus ThirdPartyStoragePartitioning
        args = apply_ticket_env_to_kwargs(args, pw_kwargs)  # The same ticket in ANT0_LAUNCH of the engine child only
        try:
            context = _playwright().chromium.launch_persistent_context(
                user_data_dir, executable_path=exe, args=args, **pw_kwargs
            )
        except Exception as exc:  # noqa: BLE001 -- exit 90 + stderr line -> LaunchTicketRejectedError
            failure = exc
        else:
            failure = None
        if failure is not None:
            # Raised outside the handler: no implicit __context__ carries Playwright's error (its message
            # quotes the whole command line, ticket and persona-file path included).
            reraise_if_ticket_rejected(failure, launch_secret_values(args, [user_data_dir], pw_kwargs.get("env")))
    except BaseException:
        cleanup_persona_temp_dir(persona_tmp)
        remove_stale_persona_file(user_data_dir)  # a failed launch leaves no persona file in the kept profile
        raise
    finally:
        _release_runtime_pin(runtime_release)
    remove_stale_persona_file(user_data_dir)  # the engine read it at startup; nothing stays in the kept profile
    if persona_tmp:
        cleanup_when_closed(context, persona_tmp)
    install_humanize_on_context(context, humanize, show_cursor, seed=seed)
    return context
