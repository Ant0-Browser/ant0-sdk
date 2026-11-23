"""serve() applies the launch options launch() applies. Popen is stubbed, so each test asserts the
effect on the spawned command line or environment, not on a helper in isolation.

WHY: serve() once never called apply_shader_dialect, dropped a caller ``env``, never forwarded its
own ``quiet``, ignored ``widevine``, ``proxy.bypass`` and ``chromium_sandbox``, An invalid ``shader_dialect`` was accepted silently.
"""
import os
import sys
import types

import pytest

import ant0browser
from ant0browser import _fonts, _serve, _widevine
from ant0browser._errors import SdkValueError
from ant0browser._launchopts import proxy_bypass_args
from ant0browser._shaderdialect import ENV_VAR, apply_shader_dialect

SENTINEL = "/sentinel/fonts.conf"


class Spawned(Exception):
    pass


@pytest.fixture
def rig(monkeypatch, tmp_path):
    exe = tmp_path / "fake-chrome.exe"
    exe.write_bytes(b"ant0-browser-capabilities/persona-profile-v1")
    state = types.SimpleNamespace(cmd=None, env=None, prepare_kw=[], released=[], exe=str(exe), tmp=tmp_path)

    def runtime(**k):
        state.prepare_kw.append(k)
        return types.SimpleNamespace(executable=str(exe), ticket_args=[], engine_version="ant0.3",
                                     release=lambda: state.released.append(1))

    def popen(cmd, **kw):
        state.cmd, state.env = cmd, kw.get("env")
        raise Spawned

    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", runtime)
    monkeypatch.setattr(ant0browser, "_guard", lambda e: None)
    monkeypatch.setattr(_serve.subprocess, "Popen", popen)
    monkeypatch.setattr(_fonts, "linux_font_env", lambda e, pack=None: {"FONTCONFIG_FILE": SENTINEL})

    def run(**kw):
        kw.setdefault("identity", {"mode": "native"})
        kw.setdefault("executable_path", str(exe))
        kw.setdefault("user_data_dir", str(tmp_path / "udd"))
        kw.setdefault("quiet", True)
        with pytest.raises(Spawned):
            _serve.serve(**kw)
        return state

    state.run = run
    return state


def test_shader_dialect_reaches_spawned_env(rig):
    rig.run(shader_dialect="hlsl")
    assert rig.env[ENV_VAR] == "hlsl"
    assert rig.env["FONTCONFIG_FILE"] == SENTINEL


def test_font_helper_runs_before_shader_helper(rig, monkeypatch):
    # apply_font_env rebuilds the env from os.environ; run second it would let a FONTCONFIG_FILE in
    # os.environ beat the font wiring (the shader helper's merged env counts as the caller's env).
    monkeypatch.setenv("FONTCONFIG_FILE", "/os/fonts.conf")
    rig.run(shader_dialect="hlsl")
    assert rig.env["FONTCONFIG_FILE"] == SENTINEL
    assert rig.env[ENV_VAR] == "hlsl"


def test_shader_dialect_is_normalised_like_launch(rig):
    rig.run(shader_dialect="  HLSL ")
    assert rig.env[ENV_VAR] == "hlsl"


def test_shader_dialect_absent_leaves_env_unset(rig, monkeypatch):
    monkeypatch.delenv(ENV_VAR, raising=False)
    rig.run()
    assert ENV_VAR not in rig.env


@pytest.mark.parametrize("bad", ["glsl", "bogus"])
def test_invalid_shader_dialect_raises_launch_error_and_cleans_up(rig, monkeypatch, bad):
    with pytest.raises(SdkValueError) as ref:
        apply_shader_dialect(bad, {})
    # the real launch path raises before it ever touches Playwright
    with pytest.raises(SdkValueError) as via_launch:
        ant0browser.launch_persistent_context(
            str(rig.tmp / "l"), identity={"mode": "native"}, executable_path=rig.exe, quiet=True,
            shader_dialect=bad)
    rig.released.clear()  # the launch call above released its own pin; count only serve's
    seen = []
    orig = _serve.tempfile.mkdtemp

    def mk(**k):
        d = orig(**k)
        seen.append(d)
        return d
    monkeypatch.setattr(_serve.tempfile, "mkdtemp", mk)
    with pytest.raises(SdkValueError) as exc:
        _serve.serve(identity={"mode": "native"}, executable_path=rig.exe, quiet=True, shader_dialect=bad)
    assert type(exc.value) is type(via_launch.value) is type(ref.value)
    assert str(exc.value) == str(via_launch.value) == str(ref.value)
    assert exc.value.code == via_launch.value.code == "sdk.shader_dialect_invalid"
    assert rig.cmd is None  # nothing spawned
    assert seen and not os.path.exists(seen[0])  # temp profile removed
    assert rig.released == [1]  # serve's own runtime pin released exactly once


def test_caller_env_reaches_spawned_env_with_launch_precedence(rig, monkeypatch):
    monkeypatch.setenv("SERVE_PARITY_BASE", "from-os")
    rig.run(env={"SERVE_PARITY_MINE": "1", "FONTCONFIG_FILE": "/mine/fonts.conf"}, shader_dialect="hlsl")
    assert rig.env["SERVE_PARITY_MINE"] == "1"
    assert rig.env["SERVE_PARITY_BASE"] == "from-os"            # extends os.environ, as launch does
    assert rig.env["FONTCONFIG_FILE"] == "/mine/fonts.conf"      # caller env beats the font wiring
    assert rig.env[ENV_VAR] == "hlsl"


def test_caller_env_beats_os_environ_of_the_same_name(rig, monkeypatch):
    monkeypatch.setenv("SERVE_PARITY_SAME", "from-os")
    rig.run(env={"SERVE_PARITY_SAME": "from-caller"})
    assert rig.env["SERVE_PARITY_SAME"] == "from-caller"


def test_non_string_env_values_follow_playwright(rig, monkeypatch):
    monkeypatch.setenv("SERVE_PARITY_DROP", "x")
    rig.run(env={"SERVE_PARITY_NUM": 1, "SERVE_PARITY_NONE": None, "SERVE_PARITY_STR": "s"})
    assert rig.env["SERVE_PARITY_NUM"] == "1"
    assert "SERVE_PARITY_NONE" not in rig.env
    assert rig.env["SERVE_PARITY_STR"] == "s"
    assert all(isinstance(k, str) and isinstance(v, str) for k, v in rig.env.items())


def test_serve_quiet_reaches_prepare(rig):
    rig.run(quiet=True)
    assert rig.prepare_kw[-1]["quiet"] is True
    rig.run(quiet=False)
    assert rig.prepare_kw[-1]["quiet"] is False


def test_widevine_is_seeded_into_the_served_profile(rig, monkeypatch):
    seeded = []
    monkeypatch.setattr(_widevine, "seed_widevine", lambda d, quiet=False: seeded.append(d))
    udd = str(rig.tmp / "wv")
    order = []
    monkeypatch.setattr(_widevine, "seed_widevine", lambda d, quiet=False: (seeded.append(d), order.append("seed")))
    inner = ant0browser.prepare_runtime_launch
    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", lambda **k: (order.append("prepare"), inner(**k))[1])
    rig.run(widevine=True, user_data_dir=udd)
    assert seeded == [udd]
    assert order == ["seed", "prepare"]  # seeded (and its args set) BEFORE _prepare reads them, on every OS
    if sys.platform != "linux":
        assert "--component-updater=fast-update" in rig.cmd
    rig.run(user_data_dir=udd)  # not asked for -> not seeded
    assert seeded == [udd]


def test_widevine_seeds_the_temp_profile_serve_creates(rig, monkeypatch):
    seeded = []
    monkeypatch.setattr(_widevine, "seed_widevine", lambda d, quiet=False: seeded.append(d))
    rig.run(widevine=True, user_data_dir=None)
    flag = [a for a in rig.cmd if a.startswith("--user-data-dir=")][0]
    assert seeded == [flag.split("=", 1)[1]]


def test_proxy_bypass_reaches_command_line(rig):
    rig.run(proxy={"server": "http://127.0.0.1:3128", "bypass": ".corp.example, localhost ,10.0.0.1"})
    assert "--proxy-server=http://127.0.0.1:3128" in rig.cmd
    assert "--proxy-bypass-list=*.corp.example;localhost;10.0.0.1" in rig.cmd


def test_caller_proxy_bypass_list_wins(rig):
    rig.run(proxy={"server": "http://127.0.0.1:3128", "bypass": "sdk.example"},
            args=["--proxy-bypass-list=caller.example"])
    flags = [a for a in rig.cmd if a.startswith("--proxy-bypass-list")]
    assert flags == ["--proxy-bypass-list=caller.example"]


def test_no_bypass_flag_without_bypass(rig):
    rig.run(proxy={"server": "http://127.0.0.1:3128"})
    assert not [a for a in rig.cmd if a.startswith("--proxy-bypass-list")]


def test_chromium_sandbox_false_adds_no_sandbox(rig):
    rig.run(chromium_sandbox=False)
    assert rig.cmd.count("--no-sandbox") == 1
    rig.run(args=["--no-sandbox"], chromium_sandbox=False)
    assert rig.cmd.count("--no-sandbox") == 1  # not duplicated
    for kw in ({}, {"chromium_sandbox": True}):
        rig.run(**kw)
        assert "--no-sandbox" not in rig.cmd


def test_helpers():
    assert proxy_bypass_args(None) == []
    assert proxy_bypass_args({"server": "http://p:1"}) == []
    assert proxy_bypass_args({"bypass": "a.com"}) == []  # no server -> nothing to bypass
    assert proxy_bypass_args({"server": "http://p:1", "bypass": " , "}) == []


def test_dom_storage_pin_is_once_in_serves_single_disable_features(rig):
    rig.run(args=["--disable-features=Foo"], disable_privacy_sandbox=True)  # a list appended later would make two
    flags = [a for a in rig.cmd if a.startswith("--disable-features=")]
    assert len(flags) == 1
    got = flags[0].split("=", 1)[1].split(",")
    assert "BrowsingTopics" in got
    assert [n for n in got if n.startswith("DomStorage")] == [
        "DomStorageSqlite", "DomStorageSqliteMigration", "DomStorageSqliteNewDatabases"]
    assert "Foo" in got
    rig.run()
    flags = [a for a in rig.cmd if a.startswith("--disable-features=")]
    assert len(flags) == 1 and "DomStorageSqlite" in flags[0]


def test_serve_still_matches_stock_on_the_switches_launch_stopped_passing(rig):
    """serve() never passed Playwright's testing switches; the launch() change must not add or remove any."""
    rig.run()
    assert not {"--hide-scrollbars", "--disable-popup-blocking"} & set(rig.cmd)
    flags = [a for a in rig.cmd if a.startswith("--disable-features=")]
    assert len(flags) == 1
    assert flags[0].split("=", 1)[1].split(",") == ["DomStorageSqlite", "DomStorageSqliteMigration", "DomStorageSqliteNewDatabases"]
    assert not any(a.startswith("--enable-features=") for a in rig.cmd)
