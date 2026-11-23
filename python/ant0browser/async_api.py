"""Ant0 Browser — async Playwright drop-in (Python).

    import asyncio
    from ant0browser.async_api import launch

    async def main():
        browser = await launch(identity={"mode": "native"})
        page = await browser.new_page()
        await page.goto("https://example.com/")
        await browser.close()

    asyncio.run(main())

Same identity and launch API as ``ant0browser.launch``, but returns Playwright **async** objects so it works
inside an asyncio event loop, where the sync API raises
``It looks like you are using Playwright Sync API inside the asyncio loop``.

Each launched browser/context owns its Playwright driver and stops it on ``close()``.
"""

import asyncio
import atexit
import concurrent.futures
import os
import shutil
import tempfile
import threading
import time

from . import (
    _guard, _headed_no_viewport, _headless_geometry_kwargs, _prepare, _release_runtime_pin,
    _resolve_identity_option, _take_internal, _take_persona_tmp,
)
from ._profile_file import (
    cleanup_persona_temp_dir, cleanup_when_closed, install_signal_cleanup, remove_stale_persona_file,
)
from ._launchopts import merge_ignore_default_args, with_playwright_feature_defaults
from ._geometry import apply_headless_geometry, initial_window_args
from ._scale import with_device_scale
from ._content import set_content_async as set_content
from ._fonts import apply_font_env
from ._shaderdialect import apply_shader_dialect
from ._humanize_async import install_humanize, install_humanize_on_context
from ._launch_ticket import (  # noqa: F401
    LaunchTicketRejectedError, apply_ticket_env_to_kwargs, retry_stale_ticket, launch_secret_values, reraise_if_ticket_rejected,
)
from ._runtime_client import RuntimeCancellation, run_with_runtime_cancellation
from ._render_async import check_render_coherence
from .geoip import resolve_geo
from .release import RELEASE

from . import __version__ as __version__  # re-export the package version

__all__ = [
    "launch",
    "set_content",
    "launch_persistent_context",
    "executable_path",
    "resolve_geo",
    "check_render_coherence",
    "RELEASE",
    "__version__",
]


async def executable_path(executable_path=None, cache_dir=None, quiet=False):
    """Resolve a local Ant0 Browser binary. Runs the blocking
    resolve in a thread so it never stalls the event loop."""
    from . import executable_path as _sync_executable_path
    return await asyncio.to_thread(
        _sync_executable_path, executable_path, cache_dir, quiet)


async def _stop_driver(pw):
    try:
        await pw.stop()
    except Exception:  # noqa: BLE001
        pass


def _bind_driver(closable, pw):
    """Stop the owned Playwright driver when this browser/context is closed."""
    orig_close = closable.close

    stopped = False

    async def close(*args, **kwargs):
        nonlocal stopped
        try:
            return await orig_close(*args, **kwargs)
        finally:
            if not stopped:
                stopped = True
                await _stop_driver(pw)

    closable.close = close


def _install_ephemeral_profile_cleanup(context, user_data_dir):
    """Remove only the temporary profile owned by this launch, at most once."""
    removed = False
    lock = threading.Lock()

    def remove():
        nonlocal removed
        with lock:
            if removed:
                return
            for attempt in range(6):
                try:
                    shutil.rmtree(user_data_dir)
                    removed = True
                    return
                except FileNotFoundError:
                    removed = True
                    return
                except OSError:
                    if attempt < 5:
                        time.sleep(0.25 * (attempt + 1))
            shutil.rmtree(user_data_dir, ignore_errors=True)
            removed = not os.path.exists(user_data_dir)

    async def cleanup():
        await asyncio.to_thread(remove)

    orig_close = context.close

    async def close(*args, **kwargs):
        try:
            return await orig_close(*args, **kwargs)
        finally:
            await cleanup()

    context.close = close
    if hasattr(context, "on"):
        def on_close(*_args):
            try:
                asyncio.get_running_loop().create_task(cleanup())
            except RuntimeError:
                remove()
        context.on("close", on_close)
    atexit.register(remove)
    return cleanup


def _install_persistent_as_browser(context):
    """Give a persistent async context the same Browser-like surface as sync launch()."""
    if not hasattr(context, "new_context"):
        async def new_context(**_kw):
            return context
        context.new_context = new_context
    if not hasattr(context, "contexts"):
        context.contexts = [context]
    return context


_PREPARE_CANCEL_JOIN_TIMEOUT = 3.0


def _release_prepare_result(value):
    if isinstance(value, tuple) and len(value) >= 3 and isinstance(value[2], dict):
        _release_runtime_pin(value[2].pop("_ant0_runtime_release", None))
        cleanup_persona_temp_dir(value[2].pop("_ant0_persona_tmp", None))


async def _prepare_async(kwargs):
    _resolve_identity_option(kwargs)
    cancellation = RuntimeCancellation()
    future: concurrent.futures.Future = concurrent.futures.Future()

    def discard_cancelled_result(done):
        if cancellation.cancelled:
            try:
                value = done.result()
            except BaseException:  # noqa: BLE001
                pass
            else:
                _release_prepare_result(value)

    # Covers completion after the bounded join, including cancellation between the
    # worker's cancelled check and its result publication.
    future.add_done_callback(discard_cancelled_result)

    def worker():
        try:
            value = run_with_runtime_cancellation(cancellation, _prepare, kwargs)
            if cancellation.cancelled:
                _release_prepare_result(value)
                if not future.done():
                    future.set_exception(asyncio.CancelledError())
            elif not future.done():
                future.set_result(value)
        except BaseException as exc:  # noqa: BLE001
            if not future.done():
                future.set_exception(exc)

    thread = threading.Thread(target=worker, name="ant0-runtime-prepare", daemon=True)
    thread.start()
    wrapped = asyncio.wrap_future(future)
    def observe_completion(done):
        if not done.cancelled():
            done.exception()
    wrapped.add_done_callback(observe_completion)
    try:
        return await asyncio.shield(wrapped)
    except asyncio.CancelledError:
        cancellation.cancel()
        if not future.done():
            await asyncio.to_thread(thread.join, _PREPARE_CANCEL_JOIN_TIMEOUT)
        if future.done():
            try:
                value = future.result()
            except BaseException:  # noqa: BLE001
                pass
            else:
                _release_prepare_result(value)
        raise


def _install_headed_viewport(browser, dpr=None):
    """Default a headed browser's new pages/contexts to no_viewport (async)."""
    orig_new_page, orig_new_context = browser.new_page, browser.new_context

    async def new_page(**kw):
        if not any(k in kw for k in ("viewport", "no_viewport", "screen")):
            kw["no_viewport"] = True
        return await orig_new_page(**with_device_scale(kw, dpr))

    async def new_context(**kw):
        if not any(k in kw for k in ("viewport", "no_viewport", "screen")):
            kw["no_viewport"] = True
        return await orig_new_context(**with_device_scale(kw, dpr))

    browser.new_page, browser.new_context = new_page, new_context


def _install_headless_geometry(browser, geom, dpr=None):
    """Default a headless browser's new pages/contexts to ``geom`` (async mirror of the sync
    installer). It supplies context options only and performs no post-launch window fixup."""
    defaults = {"no_viewport": True} if geom.get("mode") == "native" else {
        k: v for k, v in geom.items() if k in ("screen", "viewport")}
    orig_new_page, orig_new_context = browser.new_page, browser.new_context

    def _merge(kw):
        if not any(k in kw for k in ("viewport", "no_viewport", "screen")):
            kw.update(defaults)
        return with_device_scale(kw, dpr)

    async def new_page(**kw):
        return await orig_new_page(**_merge(kw))

    async def new_context(**kw):
        return await orig_new_context(**_merge(kw))

    browser.new_page, browser.new_context = new_page, new_context


async def _start_driver():
    from playwright.async_api import async_playwright
    return await async_playwright().start()


async def launch(**kwargs):
    """Launch Ant0 Browser and return a Playwright **async** ``Browser``. Same kwargs as the sync
    ``ant0browser.launch`` (identity, overrides, proxy, humanize, and Playwright launch options)."""
    ephemeral = kwargs.pop("ephemeral_profile", True)
    explicit_dir = kwargs.pop("user_data_dir", None)
    if explicit_dir is not None:
        return await launch_persistent_context(explicit_dir, **kwargs)
    if ephemeral:
        user_data_dir = tempfile.mkdtemp(prefix="ant0-browser-run-")
        context = None
        try:
            context = await launch_persistent_context(user_data_dir, **kwargs)
            _install_ephemeral_profile_cleanup(context, user_data_dir)
            return _install_persistent_as_browser(context)
        except BaseException:
            if context is not None:
                try:
                    await context.close()
                except Exception:  # noqa: BLE001
                    pass
            shutil.rmtree(user_data_dir, ignore_errors=True)
            raise

    return await _launch_incognito(**kwargs)


@retry_stale_ticket
async def _launch_incognito(**kwargs):
    """The pre-0.23 incognito launch, reached via ``ephemeral_profile=False``."""
    # seed reflects the merged/effective fingerprint (profile-aware) -> stable motor persona
    shader_dialect = kwargs.pop("shader_dialect", None)  # popped before _prepare: not a PW option
    quiet = kwargs.get("quiet", False)  # _prepare pops it; the feature-default fallback warning honours it
    exe, args, pw_kwargs, humanize, show_cursor, seed = await _prepare_async(kwargs)
    native_identity, dpr, font_pack, runtime_release = _take_internal(pw_kwargs)
    persona_tmp = _take_persona_tmp(pw_kwargs)
    if persona_tmp:
        install_signal_cleanup()  # _prepare ran in a worker thread, which cannot install a signal handler
    pw = None
    browser = None
    try:
        try:
            await asyncio.to_thread(apply_font_env, exe, pw_kwargs, font_pack)  # Linux: FONTCONFIG_FILE -> real font pack (or clones)
            apply_shader_dialect(shader_dialect, pw_kwargs)  # after fonts: that helper rebuilds the env
            headed = _headed_no_viewport(pw_kwargs)  # launch() takes no viewport kwarg -> wrap new_page/context
            # Headless: screen.* rides on new_page/new_context with the viewport (see _geometry).
            geom = None if headed else (
                None if native_identity and any(k in pw_kwargs for k in ("viewport", "no_viewport", "screen"))
                else {"mode": "native"} if native_identity
                else _headless_geometry_kwargs(pw_kwargs, seed, args)
            )
            args = initial_window_args(args, geom)
            args = with_playwright_feature_defaults(args, pw_kwargs.get("ignore_default_args"), quiet=quiet)  # merge Playwright's feature lists, minus ThirdPartyStoragePartitioning
            args = apply_ticket_env_to_kwargs(args, pw_kwargs)  # The same ticket in ANT0_LAUNCH of the engine child only
            pw = await _start_driver()
            try:
                browser = await pw.chromium.launch(executable_path=exe, args=args, **pw_kwargs)
            except Exception as exc:  # noqa: BLE001 -- exit 90 + stderr line -> LaunchTicketRejectedError
                failure = exc
            else:
                failure = None
            if failure is not None:
                # Raised outside the handler: no implicit __context__ carries Playwright's error (its message
                # quotes the whole command line, ticket and persona-file path included).
                reraise_if_ticket_rejected(failure, launch_secret_values(args, [], pw_kwargs.get("env")))
        finally:
            _release_runtime_pin(runtime_release)
        if headed:
            _install_headed_viewport(browser, dpr)
        elif geom:
            _install_headless_geometry(browser, geom, dpr)
        await install_humanize(browser, humanize, show_cursor, seed=seed)
        _bind_driver(browser, pw)
        if persona_tmp:
            cleanup_when_closed(browser, persona_tmp)  # the persona file goes now (the engine has read it), its directory when the browser closes
        return browser
    except BaseException:
        cleanup_persona_temp_dir(persona_tmp)
        if browser is not None:
            try:
                await browser.close()
            except Exception:  # noqa: BLE001
                pass
        if pw is not None:
            await _stop_driver(pw)
        raise


@retry_stale_ticket
async def launch_persistent_context(user_data_dir, **kwargs):
    """Launch Ant0 Browser with a persistent profile dir; returns a Playwright **async**
    ``BrowserContext`` (cookies/storage persist in ``user_data_dir``).

    Pass ``widevine=True`` to seed + enable the (opt-in) Widevine CDM so DRM/EME works."""
    # Automation strip before the Widevine helper (it appends --disable-component-update rather than
    # clobbering ['--enable-automation']) — mirrors the sync path.
    kwargs["_ant0_user_data_dir"] = os.fspath(user_data_dir)
    _resolve_identity_option(kwargs)
    kwargs["ignore_default_args"] = merge_ignore_default_args(kwargs.get("ignore_default_args"), kwargs.get("args"))
    if kwargs.get("widevine"):
        from ._widevine import apply_widevine_launch
        await asyncio.to_thread(apply_widevine_launch, user_data_dir, kwargs, kwargs.get("quiet", False))
    # seed reflects the merged/effective fingerprint (profile-aware) -> stable motor persona
    shader_dialect = kwargs.pop("shader_dialect", None)  # popped before _prepare: not a PW option
    quiet = kwargs.get("quiet", False)  # _prepare pops it; the feature-default fallback warning honours it
    exe, args, pw_kwargs, humanize, show_cursor, seed = await _prepare_async(kwargs)
    native_identity, dpr, font_pack, runtime_release = _take_internal(pw_kwargs)
    persona_tmp = _take_persona_tmp(pw_kwargs)
    if persona_tmp:
        install_signal_cleanup()  # _prepare ran in a worker thread, which cannot install a signal handler
    pw = None
    context = None
    try:
        try:
            await asyncio.to_thread(apply_font_env, exe, pw_kwargs, font_pack)  # Linux: FONTCONFIG_FILE -> real font pack (or clones)
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
            pw = await _start_driver()
            try:
                context = await pw.chromium.launch_persistent_context(
                    user_data_dir, executable_path=exe, args=args, **pw_kwargs)
            except Exception as exc:  # noqa: BLE001 -- exit 90 + stderr line -> LaunchTicketRejectedError
                failure = exc
            else:
                failure = None
            if failure is not None:
                # Raised outside the handler: no implicit __context__ carries Playwright's error (its message
                # quotes the whole command line, ticket and persona-file path included).
                reraise_if_ticket_rejected(failure, launch_secret_values(args, [user_data_dir], pw_kwargs.get("env")))
        finally:
            _release_runtime_pin(runtime_release)
        remove_stale_persona_file(user_data_dir)  # the engine read it at startup; nothing stays in the kept profile
        await install_humanize_on_context(context, humanize, show_cursor, seed=seed)
        _bind_driver(context, pw)
        if persona_tmp:
            cleanup_when_closed(context, persona_tmp)
        return context
    except BaseException:
        cleanup_persona_temp_dir(persona_tmp)
        remove_stale_persona_file(user_data_dir)
        if context is not None:
            try:
                await context.close()
            except Exception:  # noqa: BLE001
                pass
        if pw is not None:
            await _stop_driver(pw)
        raise
