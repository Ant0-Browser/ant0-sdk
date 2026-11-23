"""Every launch path (sync/async x launch/launch_persistent_context, plus serve) runs the REAL
``_prepare`` and hands its result to a fake Playwright whose methods have Playwright's own
signatures. An internal ``_``-prefixed key that leaks through raises TypeError exactly as it does
in Playwright, and the resolved font pack must reach the font env on every path.

WHY: the async paths once passed ``_ant0_font_pack`` straight to Playwright (TypeError on every
call) and ignored the resolved pack; the earlier smoke fakes accepted ``**kw`` so nothing noticed.
"""
import inspect
import json
import sys
from pathlib import Path
import types

import pytest

import ant0browser
from ant0browser import _fonts, _serve, async_api

pw_sync = pytest.importorskip("playwright.sync_api")
pw_async = pytest.importorskip("playwright.async_api")

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures/synthetic/persona-v2.json"
SENTINEL = "/sentinel/fonts.conf"
IDENTITY = {"mode": "captured", "source": json.loads(FIXTURE.read_text(encoding="utf-8"))}
needs_linux = pytest.mark.skipif(sys.platform != "linux", reason="font pack is wired on Linux only")


def _fake_exe(tmp_path):
    p = tmp_path / "fake-chrome.exe"
    p.write_bytes(b"ant0-browser-capabilities/persona-profile-v1")
    return str(p)


class _Ctx:
    """Stands in for a Playwright browser/context (the SDK wraps new_page/new_context)."""

    def on(self, *a, **k):
        pass

    def new_page(self, **kw):
        return kw

    def new_context(self, **kw):
        return kw

    async def close(self):
        pass


def _strict(real, record, result):
    """A callable with ``real``'s signature that binds like Playwright and records the kwargs."""
    sig = inspect.signature(real)

    def bind(*a, **kw):
        sig.bind(None, *a, **kw)  # TypeError on an unknown keyword, like Playwright
        record.append(kw)
        return result
    return bind


@pytest.fixture
def env(monkeypatch, tmp_path):
    pack = tmp_path / "pack"
    pack.mkdir()
    font_calls = []
    rl = types.SimpleNamespace(executable=_fake_exe(tmp_path), ticket_args=[], release=None,
                               engine_version="ant0.3")
    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", lambda **k: rl)
    monkeypatch.setattr(ant0browser, "_guard", lambda exe: None)
    monkeypatch.setattr("ant0browser.fontpack.resolve_font_pack", lambda quiet=False, download=True: str(pack))
    monkeypatch.setattr("ant0browser.fontpack.pack_families", lambda p: [])

    def spy(exe_path, pack_dir=None):
        font_calls.append(pack_dir)
        return {"FONTCONFIG_FILE": SENTINEL}
    monkeypatch.setattr(_fonts, "linux_font_env", spy)
    return types.SimpleNamespace(pack=str(pack), fonts=font_calls, exe=rl.executable, tmp=tmp_path)


def _assert_clean(recorded, env):
    assert len(recorded) == 1
    assert not [k for k in recorded[0] if k.startswith("_")]
    assert env.fonts == [env.pack]
    assert recorded[0]["env"]["FONTCONFIG_FILE"] == SENTINEL  # the font env itself reaches Playwright


@needs_linux
@pytest.mark.parametrize("which", ["launch", "launch_persistent_context"])
def test_sync_paths(monkeypatch, env, which):
    rec = []
    S = pw_sync.BrowserType

    class Chromium:
        launch = staticmethod(_strict(S.launch, rec, _Ctx()))
        launch_persistent_context = staticmethod(_strict(S.launch_persistent_context, rec, _Ctx()))

    monkeypatch.setattr(ant0browser, "_playwright", lambda: types.SimpleNamespace(chromium=Chromium()))
    monkeypatch.setattr(ant0browser, "install_humanize", lambda *a, **k: None)
    monkeypatch.setattr(ant0browser, "install_humanize_on_context", lambda *a, **k: None)
    common = dict(identity=IDENTITY, headless=True, quiet=True, executable_path=env.exe)
    if which == "launch":
        ant0browser.launch(ephemeral_profile=False, **common)
    else:
        ant0browser.launch_persistent_context(str(env.tmp / "udd"), **common)
    _assert_clean(rec, env)


@needs_linux
@pytest.mark.parametrize("which", ["launch", "launch_persistent_context"])
async def test_async_paths(monkeypatch, env, which):
    rec = []
    A = pw_async.BrowserType

    def wrap(fn):
        async def call(*a, **kw):
            return fn(*a, **kw)
        return call

    class Chromium:
        launch = staticmethod(wrap(_strict(A.launch, rec, _Ctx())))
        launch_persistent_context = staticmethod(wrap(_strict(A.launch_persistent_context, rec, _Ctx())))

    async def start():
        return types.SimpleNamespace(chromium=Chromium(), stop=_Ctx().close)

    async def noop(*a, **k):
        pass

    monkeypatch.setattr(async_api, "_start_driver", start)
    monkeypatch.setattr(async_api, "_bind_driver", lambda *a, **k: None)
    monkeypatch.setattr(async_api, "install_humanize", noop)
    monkeypatch.setattr(async_api, "install_humanize_on_context", noop)
    common = dict(identity=IDENTITY, headless=True, quiet=True, executable_path=env.exe)
    if which == "launch":
        await async_api.launch(ephemeral_profile=False, **common)
    else:
        await async_api.launch_persistent_context(str(env.tmp / "udd"), **common)
    _assert_clean(rec, env)


@needs_linux
@pytest.mark.parametrize("headless", [True, False])
def test_serve_applies_pack_and_spawns_clean(monkeypatch, env, headless):
    spawned = {}
    seen = []
    real = ant0browser.scale_window_args

    def spy(sdk_args, dpr, is_headed, *a, **k):
        seen.append(is_headed)
        return real(sdk_args, dpr, is_headed, *a, **k)

    monkeypatch.setattr(ant0browser, "scale_window_args", spy)

    class Stop(Exception):
        pass

    def popen(cmd, **kw):
        spawned["cmd"] = cmd
        spawned["env"] = kw.get("env")
        raise Stop

    monkeypatch.setattr(_serve.subprocess, "Popen", popen)
    with pytest.raises(Stop):
        _serve.serve(identity=IDENTITY, quiet=True, executable_path=env.exe, user_data_dir=str(env.tmp / "s"),
                     headless=headless)
    assert seen == [not headless]  # serve's _ant0_headed is honoured by _prepare
    assert env.fonts == [env.pack]
    assert spawned["env"]["FONTCONFIG_FILE"] == SENTINEL  # the font env reaches the spawned process
    assert not [a for a in spawned["cmd"] if "_ant0_" in str(a)]


@pytest.mark.parametrize("headed", [True, False])
def test_ant0_headed_reaches_window_sizing(monkeypatch, env, headed):
    """``serve`` sets ``_ant0_headed``; _prepare must pop it AND use it: a headed launch gets the
    window size clamped to the display, a headless one keeps the persona size."""
    seen = []
    real = ant0browser.scale_window_args

    def spy(sdk_args, dpr, is_headed, *a, **k):
        seen.append(is_headed)
        return real(sdk_args, dpr, is_headed, *a, **k)

    monkeypatch.setattr(ant0browser, "scale_window_args", spy)
    _exe, _args, pw_kwargs, *_ = ant0browser._prepare(
        dict(identity=IDENTITY, quiet=True, resolve_fonts=False, headless=True,
             executable_path=env.exe, _ant0_headed=headed))
    assert seen == [headed]
    assert "_ant0_headed" not in pw_kwargs
