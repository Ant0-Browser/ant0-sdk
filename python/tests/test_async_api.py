import inspect

import ant0browser
import pytest
from ant0browser import async_api
from ant0browser._humanize_async import attach_humanize, install_humanize


def test_async_surface_is_coroutines():
    for name in ("launch", "launch_persistent_context", "executable_path"):
        fn = getattr(async_api, name)
        assert inspect.iscoroutinefunction(fn), f"{name} should be async"


def test_async_api_reexports():
    for name in ("resolve_geo", "RELEASE", "__version__"):
        assert hasattr(async_api, name)
    for name in ("Profile", "list_profiles", "load_profile"):
        assert not hasattr(async_api, name)


# ---- async humanize, exercised against a fake page (no real browser) ----
class _FakeMouse:
    def __init__(self):
        self.moves, self.clicks, self.wheels = [], [], []

    async def move(self, x, y, **kw):
        self.moves.append((x, y))

    async def click(self, x, y, **kw):
        self.clicks.append((x, y))

    async def wheel(self, dx, dy):
        self.wheels.append((dx, dy))


class _FakeKeyboard:
    def __init__(self):
        self.typed, self.presses = [], []

    async def type(self, ch, **k):
        self.typed.append(ch)

    async def press(self, combo, **k):
        self.presses.append(combo)


class _FakeLocator:
    def __init__(self):
        self.clicked = 0

    @property
    def first(self):
        return self

    async def wait_for(self, **k):
        pass

    async def scroll_into_view_if_needed(self, **k):
        pass

    async def click(self, **k):
        self.clicked += 1

    async def bounding_box(self):
        return {"x": 10, "y": 10, "width": 100, "height": 20}

    async def is_enabled(self):
        return True

    async def element_handle(self):
        return object()


class _FakePage:
    def __init__(self):
        self.mouse = _FakeMouse()
        self.keyboard = _FakeKeyboard()
        self.loc = _FakeLocator()
        self.evals = []
        self.fill_fallback, self.type_fallback = [], []
        self.main_frame = object()

    async def evaluate(self, *a, **k):
        self.evals.append(a)

    async def click(self, *a, **k):
        pass

    async def hover(self, *a, **k):
        pass

    def locator(self, sel):
        return self.loc

    async def fill(self, sel, val, **k):
        self.fill_fallback.append((sel, val))   # native bulk fill (the paste-signature fallback)

    async def type(self, sel, txt, **k):
        self.type_fallback.append((sel, txt))

    def on(self, *a, **k):
        pass


async def test_humanize_glide_is_continuous_and_lands_on_target():
    page = _FakePage()
    await attach_humanize(None, page, humanize=True)
    await page.mouse.move(200, 300)   # wrapped: glides via many native moves
    moves = page.mouse.moves
    assert len(moves) > 3, "glide should emit several intermediate moves"
    assert moves[-1] == (200, 300), "must land exactly on target"
    # a second move continues from the last position (no snap back to a corner)
    await page.mouse.move(50, 50)
    assert page.mouse.moves[-1] == (50, 50)


async def test_humanize_click_presses_after_gliding():
    page = _FakePage()
    await attach_humanize(None, page, humanize=True)
    await page.mouse.click(120, 140)
    assert page.mouse.clicks == [(120, 140)]
    assert page.mouse.moves and page.mouse.moves[-1] == (120, 140)


async def test_humanize_typing_is_per_character_not_paste():
    page = _FakePage()
    await attach_humanize(None, page, humanize=True)
    await page.fill("#email", "abc")
    # per-character key events — now via keyboard.press so each key has a keydown->keyup DWELL
    # (keyboard.type has no hold). Intent unchanged: one key per char, not a bulk paste.
    assert [p for p in page.keyboard.presses if p in ("a", "b", "c")] == ["a", "b", "c"]
    assert page.fill_fallback == []                       # native bulk fill (paste) NOT used
    assert "ControlOrMeta+a" in page.keyboard.presses     # field cleared first
    assert page.loc.clicked == 1                           # field focused via a click


async def test_show_cursor_injects_overlay():
    page = _FakePage()
    await attach_humanize(None, page, humanize=False, show_cursor=True)
    assert page.evals, "show_cursor should inject the overlay script"


async def test_install_humanize_wraps_new_page():
    made = _FakePage()

    class _FakeBrowser:
        async def new_page(self, **kw):
            return made

        async def new_context(self, **kw):
            return None

    browser = _FakeBrowser()
    await install_humanize(browser, humanize=True)
    page = await browser.new_page()       # wrapped -> attaches humanize
    await page.mouse.move(300, 200)
    assert page.mouse.moves[-1] == (300, 200)


# ---- regression: async launch must unpack _prepare's 6-tuple ----
async def test_async_launch_unpacks_prepare_sixtuple_and_threads_seed(monkeypatch):
    """_prepare returns 6 values (…, effective seed). The async launch paths must
    unpack 6 (not 5) and pass the profile-aware seed to install_humanize. Before the
    fix these unpacked 5 -> `ValueError: too many values to unpack (expected 5, got 6)`
    the moment launch()/launch_persistent_context() was actually awaited."""
    import tempfile
    captured = {}

    class _FakeBrowserObj:
        # new_page/new_context exist because the headless geometry default wraps them.
        async def new_page(self, **kw):
            return kw

        async def new_context(self, **kw):
            return kw

        async def close(self):
            pass

    def fake_prepare(kwargs):
        # exe, args, pw_kwargs, humanize, show_cursor, seed
        return ("chrome", ["--x"], {}, True, False, "eff-seed-123")

    class _FakeChromium:
        async def launch(self, **kw):
            return _FakeBrowserObj()

        async def launch_persistent_context(self, user_data_dir, **kw):
            return _FakeBrowserObj()

    class _FakePW:
        chromium = _FakeChromium()

        async def stop(self):
            pass

    async def fake_start_driver():
        return _FakePW()

    async def fake_install(browser, humanize, show_cursor, seed=None):
        captured["launch_seed"] = seed
        captured["humanize"] = humanize

    async def fake_install_ctx(context, humanize, show_cursor, seed=None):
        captured["ctx_seed"] = seed

    monkeypatch.setattr(async_api, "_prepare", fake_prepare)
    monkeypatch.setattr(async_api, "_start_driver", fake_start_driver)
    monkeypatch.setattr(async_api, "_headed_no_viewport", lambda pw_kwargs: False)
    monkeypatch.setattr(async_api, "_bind_driver", lambda *a, **k: None)
    monkeypatch.setattr(async_api, "install_humanize", fake_install)
    monkeypatch.setattr(async_api, "install_humanize_on_context", fake_install_ctx)

    # launch(): must not raise the unpack ValueError; uses the _prepare (effective) seed.
    browser = await async_api.launch(ephemeral_profile=False)
    assert browser is not None
    assert captured["launch_seed"] == "eff-seed-123"
    assert captured["humanize"] is True

    # launch_persistent_context(): same 6-unpack + seed threading.
    context = await async_api.launch_persistent_context(tempfile.mkdtemp())
    assert context is not None
    assert captured["ctx_seed"] == "eff-seed-123"


class _LifecycleContext:
    def __init__(self):
        self.close_count = 0

    async def new_page(self, **kw):
        return kw

    async def close(self):
        self.close_count += 1


async def test_async_launch_defaults_to_owned_persistent_profile(monkeypatch, tmp_path):
    generated = tmp_path / "generated"
    context = _LifecycleContext()
    seen = {}

    def make_temp(**_kwargs):
        generated.mkdir()
        return str(generated)

    async def persistent(user_data_dir, **kwargs):
        seen.update(user_data_dir=user_data_dir, kwargs=kwargs)
        return context

    monkeypatch.setattr(async_api.tempfile, "mkdtemp", make_temp)
    monkeypatch.setattr(async_api, "launch_persistent_context", persistent)

    browser = await async_api.launch(widevine=True)
    assert seen == {"user_data_dir": str(generated), "kwargs": {"widevine": True}}
    assert await browser.new_context() is context
    assert browser.contexts == [context]
    await browser.close()
    await browser.close()
    assert not generated.exists()


async def test_async_launch_explicit_profile_is_persistent_and_not_deleted(monkeypatch, tmp_path):
    user_data_dir = tmp_path / "caller-owned"
    user_data_dir.mkdir()
    context = _LifecycleContext()
    monkeypatch.setattr(
        async_api, "launch_persistent_context",
        lambda *_a, **_kw: _async_value(context),
    )

    assert await async_api.launch(user_data_dir=str(user_data_dir)) is context
    await context.close()
    assert user_data_dir.exists()


async def _async_value(value):
    return value


async def test_async_launch_ephemeral_false_uses_direct_incognito(monkeypatch):
    browser = _LifecycleContext()
    calls = []

    class Chromium:
        async def launch(self, **kwargs):
            calls.append(kwargs)
            return browser

        async def launch_persistent_context(self, *_args, **_kwargs):
            raise AssertionError("persistent launch should not be used")

    class PW:
        chromium = Chromium()

        async def stop(self):
            pass

    monkeypatch.setattr(async_api, "_prepare_async", lambda _kwargs: _async_value(
        ("chrome", [], {}, False, False, None)))
    monkeypatch.setattr(async_api, "_headless_geometry_kwargs", lambda *_args: None)
    monkeypatch.setattr(async_api, "_start_driver", lambda: _async_value(PW()))
    monkeypatch.setattr(async_api, "install_humanize", lambda *_a, **_k: _async_value(None))

    assert await async_api.launch(ephemeral_profile=False) is browser
    assert len(calls) == 1


async def test_async_generated_profile_removed_when_startup_fails(monkeypatch, tmp_path):
    generated = tmp_path / "failed"

    def make_temp(**_kwargs):
        generated.mkdir()
        return str(generated)

    async def fail(*_args, **_kwargs):
        raise RuntimeError("startup failed")

    monkeypatch.setattr(async_api.tempfile, "mkdtemp", make_temp)
    monkeypatch.setattr(async_api, "launch_persistent_context", fail)
    with pytest.raises(RuntimeError, match="startup failed"):
        await async_api.launch()
    assert not generated.exists()


async def test_async_post_launch_failure_closes_context_and_stops_driver(monkeypatch, tmp_path):
    context = _LifecycleContext()
    stopped = []
    generated = tmp_path / "post-launch-failure"

    def make_temp(**_kwargs):
        generated.mkdir()
        return str(generated)

    class Chromium:
        async def launch_persistent_context(self, *_args, **_kwargs):
            return context

    class PW:
        chromium = Chromium()

        async def stop(self):
            stopped.append(True)

    monkeypatch.setattr(async_api, "_prepare_async", lambda _kwargs: _async_value(
        ("chrome", [], {}, False, False, None)))
    monkeypatch.setattr(async_api, "_start_driver", lambda: _async_value(PW()))
    monkeypatch.setattr(async_api.tempfile, "mkdtemp", make_temp)

    async def fail_setup(*_args, **_kwargs):
        raise RuntimeError("setup failed")

    monkeypatch.setattr(async_api, "install_humanize_on_context", fail_setup)
    with pytest.raises(RuntimeError, match="setup failed"):
        await async_api.launch()
    assert context.close_count == 1
    assert stopped == [True]
    assert not generated.exists()


async def test_async_startup_failure_stops_driver(monkeypatch, tmp_path):
    stopped = []

    class Chromium:
        async def launch_persistent_context(self, *_args, **_kwargs):
            raise RuntimeError("browser failed")

    class PW:
        chromium = Chromium()

        async def stop(self):
            stopped.append(True)

    monkeypatch.setattr(async_api, "_prepare_async", lambda _kwargs: _async_value(
        ("chrome", [], {}, False, False, None)))
    monkeypatch.setattr(async_api, "_start_driver", lambda: _async_value(PW()))
    with pytest.raises(RuntimeError, match="browser failed"):
        await async_api.launch(user_data_dir=str(tmp_path))
    assert stopped == [True]


async def test_async_default_routes_widevine_through_persistent_launch(monkeypatch, tmp_path):
    from ant0browser import _widevine

    generated = tmp_path / "widevine-profile"
    context = _LifecycleContext()
    seeded = []
    stopped = []

    def make_temp(**_kwargs):
        generated.mkdir()
        return str(generated)

    def apply(user_data_dir, kwargs, quiet=False):
        seeded.append((user_data_dir, kwargs.get("widevine"), quiet))

    class Chromium:
        async def launch_persistent_context(self, *_args, **_kwargs):
            return context

    class PW:
        chromium = Chromium()

        async def stop(self):
            stopped.append(True)

    monkeypatch.setattr(async_api.tempfile, "mkdtemp", make_temp)
    monkeypatch.setattr(async_api, "_prepare_async", lambda _kwargs: _async_value(
        ("chrome", [], {}, False, False, None)))
    monkeypatch.setattr(async_api, "_start_driver", lambda: _async_value(PW()))
    monkeypatch.setattr(async_api, "install_humanize_on_context", lambda *_a, **_k: _async_value(None))
    monkeypatch.setattr(_widevine, "apply_widevine_launch", apply)

    browser = await async_api.launch(widevine=True, quiet=True)
    assert seeded == [(str(generated), True, True)]
    await browser.close()
    await browser.close()
    assert stopped == [True]
    assert not generated.exists()


async def test_async_auto_profile_is_rejected_before_launch():
    with pytest.raises(ValueError, match="identity.*overrides"):
        await async_api._prepare_async({"profile": "auto", "profile_select": {"mode": "best"}})


async def test_async_incognito_installs_signal_cleanup_on_the_loop_thread(monkeypatch):
    """_prepare runs in a worker thread, which cannot install a signal handler; the async launch installs it
    on the event loop thread once a temporary persona directory exists, and not otherwise."""
    import threading
    calls = []

    class _Browser:
        async def new_page(self, **kw):
            return kw

        async def new_context(self, **kw):
            return kw

        async def close(self):
            pass

    class _Chromium:
        async def launch(self, **kw):
            return _Browser()

    class _PW:
        chromium = _Chromium()

        async def stop(self):
            pass

    async def fake_start_driver():
        return _PW()

    async def noop(*a, **k):
        pass

    def make_prepare(tmp):
        return lambda kwargs: ("chrome", ["--x"], {"_ant0_persona_tmp": tmp} if tmp else {}, False, False, None)

    monkeypatch.setattr(async_api, "_start_driver", fake_start_driver)
    monkeypatch.setattr(async_api, "_headed_no_viewport", lambda pw_kwargs: False)
    monkeypatch.setattr(async_api, "_bind_driver", lambda *a, **k: None)
    monkeypatch.setattr(async_api, "install_humanize", noop)
    monkeypatch.setattr(async_api, "cleanup_when_closed", lambda *a, **k: None)
    monkeypatch.setattr(async_api, "install_signal_cleanup",
                        lambda: calls.append(threading.current_thread() is threading.main_thread()))
    monkeypatch.setattr(async_api, "_prepare", make_prepare("/tmp/ant0-persona-x"))
    await async_api.launch(ephemeral_profile=False)
    monkeypatch.setattr(async_api, "_prepare", make_prepare(None))
    await async_api.launch(ephemeral_profile=False)
    assert calls == [True]


def _fake_async_launch(monkeypatch, tmp):
    """Patches the async launch so it runs without a browser, with a real temporary persona directory."""
    class _Browser:
        async def new_page(self, **kw):
            return kw

        async def new_context(self, **kw):
            return kw

        async def close(self):
            pass

    class _Chromium:
        async def launch(self, **kw):
            return _Browser()

    class _PW:
        chromium = _Chromium()

        async def stop(self):
            pass

    async def fake_start_driver():
        return _PW()

    async def noop(*a, **k):
        pass

    monkeypatch.setattr(async_api, "_start_driver", fake_start_driver)
    monkeypatch.setattr(async_api, "_headed_no_viewport", lambda pw_kwargs: False)
    monkeypatch.setattr(async_api, "_bind_driver", lambda *a, **k: None)
    monkeypatch.setattr(async_api, "install_humanize", noop)
    monkeypatch.setattr(async_api, "cleanup_when_closed", lambda *a, **k: None)  # the test closes it itself
    monkeypatch.setattr(async_api, "_prepare",
                        lambda kwargs: ("chrome", ["--x"], {"_ant0_persona_tmp": tmp}, False, False, None))


@pytest.fixture
def _clean_signals():
    import signal
    from ant0browser import _profile_file as pf
    saved = {n: signal.getsignal(getattr(signal, n)) for n in ("SIGINT", "SIGTERM")}
    pf._signals_installed = False
    pf._signal_handlers.clear()
    yield
    for n, h in saved.items():
        signal.signal(getattr(signal, n), h)
    pf._signals_installed = False
    pf._signal_handlers.clear()


def test_the_signal_handler_does_not_outlive_the_launch_into_the_next_asyncio_run(monkeypatch, tmp_path, _clean_signals):
    """The handler installed for an incognito launch is removed once its persona directory is gone, so the next
    asyncio.run sees the default handler again and Ctrl+C is not left to a stale one."""
    import asyncio
    import os
    import signal
    from ant0browser import _profile_file as pf
    directory = str(tmp_path / "persona")
    os.mkdir(directory)
    pf._register_temp(directory)  # what staging does (a worker thread cannot install the handlers)
    _fake_async_launch(monkeypatch, directory)
    during = []

    async def first():
        await async_api.launch(ephemeral_profile=False)
        during.append(signal.getsignal(signal.SIGINT))
        pf.cleanup_persona_temp_dir(directory)  # the browser closing

    asyncio.run(first())
    assert signal.getsignal(signal.SIGINT) is signal.default_int_handler

    async def second():
        # asyncio's own handler is in charge here; Ctrl+C must reach it, not ours
        return signal.getsignal(signal.SIGINT)

    assert asyncio.run(second()) is not during[0]
    assert signal.getsignal(signal.SIGINT) is signal.default_int_handler


def test_sig_ign_is_preserved_across_an_async_launch(monkeypatch, tmp_path, _clean_signals):
    import asyncio
    import os
    import signal
    from ant0browser import _profile_file as pf
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    directory = str(tmp_path / "persona")
    os.mkdir(directory)
    pf._register_temp(directory)
    _fake_async_launch(monkeypatch, directory)

    async def run():
        await async_api.launch(ephemeral_profile=False)
        pf.cleanup_persona_temp_dir(directory)

    asyncio.run(run())
    assert signal.getsignal(signal.SIGINT) == signal.SIG_IGN
