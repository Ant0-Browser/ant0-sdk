"""``cache_dir`` is accepted and ignored on launch (with a once-per-process note), and a
``socks5h://`` proxy is sent as ``socks5://`` on every launch and serve path.

Playwright and Popen are faked, as in test_launch_internal_keys.py / test_serve_option_parity.py.
"""
import types

import pytest

import ant0browser
from ant0browser import _serve, _warnings, async_api
from ant0browser._launchopts import resolve_proxy


@pytest.fixture
def rig(monkeypatch, tmp_path):
    pytest.importorskip("playwright.sync_api")  # only the launch tests need it, not the pure ones
    exe = tmp_path / "fake-chrome.exe"
    exe.write_bytes(b"ant0-browser-capabilities/persona-profile-v1")
    rl = types.SimpleNamespace(executable=str(exe), ticket_args=[], release=None, engine_version="ant0.3")
    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", lambda **k: rl)
    monkeypatch.setattr(ant0browser, "_guard", lambda e: None)
    monkeypatch.delenv("ANT0_BROWSER_NO_WARN", raising=False)
    _warnings._seen_notes.clear()
    rec = []

    class Ctx:
        def on(self, *a, **k): pass
        def new_page(self, **kw): return kw
        def new_context(self, **kw): return kw

    class Chromium:
        @staticmethod
        def launch(*a, **kw):
            rec.append(kw)
            return Ctx()

        @staticmethod
        def launch_persistent_context(*a, **kw):
            rec.append(kw)
            return Ctx()

    monkeypatch.setattr(ant0browser, "_playwright", lambda: types.SimpleNamespace(chromium=Chromium()))
    monkeypatch.setattr(ant0browser, "install_humanize", lambda *a, **k: None)
    monkeypatch.setattr(ant0browser, "install_humanize_on_context", lambda *a, **k: None)
    common = dict(identity={"mode": "native"}, headless=True, executable_path=str(exe))
    return types.SimpleNamespace(exe=str(exe), tmp=tmp_path, rec=rec, common=common)


NOTE = "cache_dir is ignored on launch"


def _notes(capsys):
    return [l for l in capsys.readouterr().err.splitlines() if NOTE in l]


def test_note_fires_once_across_two_launches(rig, capsys):
    for n in (1, 2):
        ant0browser.launch_persistent_context(str(rig.tmp / ("u%d" % n)), cache_dir=str(rig.tmp / "c"),
                                              quiet=False, **rig.common)
    lines = _notes(capsys)
    assert len(lines) == 1
    assert lines[0].startswith("ant0browser: note: ")
    assert "executable_path(cache_dir=...)" in lines[0]
    assert len(rig.rec) == 2  # launch itself still works with the option given
    assert all("cache_dir" not in kw for kw in rig.rec)


def test_note_also_fires_on_incognito_launch(rig, capsys):
    ant0browser.launch(ephemeral_profile=False, cache_dir="x", quiet=False, **rig.common)
    assert len(_notes(capsys)) == 1
    assert rig.rec and "cache_dir" not in rig.rec[0]


def test_no_note_without_the_option(rig, capsys):
    ant0browser.launch_persistent_context(str(rig.tmp / "u"), quiet=False, **rig.common)
    assert _notes(capsys) == []


def test_note_respects_quiet_and_no_warn(rig, capsys, monkeypatch):
    ant0browser.launch_persistent_context(str(rig.tmp / "u1"), cache_dir="x", quiet=True, **rig.common)
    monkeypatch.setenv("ANT0_BROWSER_NO_WARN", "1")
    ant0browser.launch_persistent_context(str(rig.tmp / "u2"), cache_dir="x", quiet=False, **rig.common)
    assert _notes(capsys) == []


def test_resolve_proxy_maps_socks5h_case_insensitively():
    assert resolve_proxy({"server": "socks5h://10.0.0.1:1080", "bypass": "a.com"})[1] == \
        {"server": "socks5://10.0.0.1:1080", "bypass": "a.com"}
    assert resolve_proxy({"server": "SOCKS5H://Host.Example:1080"})[1]["server"] == "socks5://Host.Example:1080"
    for server in ("socks5://h:1", "socks4://h:1", "http://h:1", "https://h:1", "h:1", "socks5hx://h:1"):
        assert resolve_proxy({"server": server})[1]["server"] == server


def test_resolve_proxy_leaves_the_callers_dict_alone_and_still_rejects_credentials():
    given = {"server": "socks5h://h:1"}
    resolve_proxy(given)
    assert given["server"] == "socks5h://h:1"
    with pytest.raises(Exception):
        resolve_proxy({"server": "socks5h://u:p@h:1"})
    with pytest.raises(Exception):
        resolve_proxy({"server": "socks5h://h:1", "username": "u"})


def test_launch_paths_hand_playwright_socks5(rig):
    ant0browser.launch(ephemeral_profile=False, proxy={"server": "SOCKS5H://h.test:1080", "bypass": "a.com"},
                       quiet=True, **rig.common)
    ant0browser.launch_persistent_context(str(rig.tmp / "u"), proxy={"server": "socks5h://h.test:1080"},
                                          quiet=True, **rig.common)
    assert rig.rec[0]["proxy"] == {"server": "socks5://h.test:1080", "bypass": "a.com"}
    assert rig.rec[1]["proxy"]["server"] == "socks5://h.test:1080"


def test_serve_spawns_with_socks5(rig, monkeypatch):
    class Spawned(Exception):
        pass

    got = {}

    def popen(cmd, **kw):
        got["cmd"] = cmd
        raise Spawned

    monkeypatch.setattr(_serve.subprocess, "Popen", popen)
    with pytest.raises(Spawned):
        _serve.serve(proxy={"server": "socks5h://h.test:1080"}, user_data_dir=str(rig.tmp / "udd"),
                     quiet=True, **{k: v for k, v in rig.common.items() if k != "headless"})
    assert "--proxy-server=socks5://h.test:1080" in got["cmd"]
    assert not any("socks5h" in a for a in got["cmd"])


def test_font_cache_dir_is_named_ant0_fc_cache(monkeypatch, tmp_path):
    from ant0browser import _fonts
    monkeypatch.setattr(_fonts.tempfile, "gettempdir", lambda: str(tmp_path))
    d = _fonts._cache_dir()
    assert d == str(tmp_path / "ant0-fc-cache")
    assert not (tmp_path / "cc-fc-cache").exists()


@pytest.fixture
def arig(rig, monkeypatch):
    pytest.importorskip("playwright.async_api")
    rec = []

    class Ctx:
        def on(self, *a, **k): pass
        def new_page(self, **kw): return kw
        def new_context(self, **kw): return kw
        async def close(self): pass

    class Chromium:
        @staticmethod
        async def launch(*a, **kw):
            rec.append(kw)
            return Ctx()

        @staticmethod
        async def launch_persistent_context(*a, **kw):
            rec.append(kw)
            return Ctx()

    async def start():
        return types.SimpleNamespace(chromium=Chromium(), stop=Ctx().close)

    async def noop(*a, **k):
        pass

    monkeypatch.setattr(async_api, "_start_driver", start)
    monkeypatch.setattr(async_api, "_bind_driver", lambda *a, **k: None)
    monkeypatch.setattr(async_api, "install_humanize", noop)
    monkeypatch.setattr(async_api, "install_humanize_on_context", noop)
    rig.arec = rec
    return rig


async def test_async_paths_map_socks5h(arig):
    await async_api.launch(ephemeral_profile=False, proxy={"server": "SOCKS5H://h.test:1080", "bypass": "a.com"},
                           quiet=True, **arig.common)
    await async_api.launch_persistent_context(str(arig.tmp / "u"), proxy={"server": "socks5h://h.test:1080"},
                                              quiet=True, **arig.common)
    assert arig.arec[0]["proxy"] == {"server": "socks5://h.test:1080", "bypass": "a.com"}
    assert arig.arec[1]["proxy"]["server"] == "socks5://h.test:1080"


async def test_async_paths_note_cache_dir_once(arig, capsys):
    await async_api.launch(ephemeral_profile=False, cache_dir="x", quiet=False, **arig.common)
    await async_api.launch_persistent_context(str(arig.tmp / "u"), cache_dir="x", quiet=False, **arig.common)
    assert len(_notes(capsys)) == 1
    assert len(arig.arec) == 2 and all("cache_dir" not in kw for kw in arig.arec)
