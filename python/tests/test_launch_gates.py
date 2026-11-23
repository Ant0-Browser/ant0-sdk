"""The launch paths themselves (not just the helpers) must apply the --webrtc-ip gate, the
--webrtc-no-local-dns rule and Playwright's feature merge. The Playwright driver is stubbed at the
call, so these assert the arguments that actually reach Playwright (sync, async, incognito and
persistent)."""
import os
import tempfile

import pytest

import ant0browser
from ant0browser import async_api

OLD = "158.0.8127.18-ant0.2"
NEW = "158.0.8127.18-ant0.3"
IP = "--webrtc-ip=203.0.113.7"
DROPPED = ("HttpsUpgrades", "BoundaryEventDispatchTracksNodeRemoval", "MediaRouter")
HFM = "HttpsFirstBalancedModeAutoEnable"
PW_DEFAULTS = {"disabled_full": ["Translate", *DROPPED, "ThirdPartyStoragePartitioning"], "disabled": ["Translate", *DROPPED],
               "enabled": ["CDPScreenshotNewSurface"]}


def _exe():
    f = tempfile.NamedTemporaryFile(prefix="fake-chrome-", suffix=".exe", delete=False)
    f.write(b"ant0-browser-capabilities/persona-profile-v1")
    f.close()
    return f.name


class _Browser:
    def on(self, *a, **k):
        pass

    def new_page(self, **kw):
        return kw

    def new_context(self, **kw):
        return kw

    async def close(self):
        pass


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    from ant0browser import _launchopts
    monkeypatch.setattr(_launchopts, "_installed_defaults", [PW_DEFAULTS])


def _sync(monkeypatch):
    seen = {}

    class _C:
        def launch(self, **kw):
            seen["kw"] = kw
            return _Browser()

        def launch_persistent_context(self, *a, **kw):
            seen["kw"] = kw
            return _Browser()

    class _PW:
        chromium = _C()

    monkeypatch.setattr(ant0browser, "_playwright", lambda: _PW())
    monkeypatch.setattr(ant0browser, "install_humanize", lambda *a, **k: None)
    monkeypatch.setattr(ant0browser, "install_humanize_on_context", lambda *a, **k: None)
    return seen


def _async(monkeypatch):
    seen = {}

    class _C:
        async def launch(self, **kw):
            seen["kw"] = kw
            return _Browser()

        async def launch_persistent_context(self, *a, **kw):
            seen["kw"] = kw
            return _Browser()

    class _PW:
        chromium = _C()

        async def stop(self):
            pass

    async def _start():
        return _PW()

    async def _noop(*a, **k):
        pass

    monkeypatch.setattr(async_api, "_start_driver", _start)
    monkeypatch.setattr(async_api, "_bind_driver", lambda *a, **k: None)
    monkeypatch.setattr(async_api, "install_humanize", _noop)
    monkeypatch.setattr(async_api, "install_humanize_on_context", _noop)
    return seen


def _run_sync(path, **kw):
    kw = {"executable_path": _exe(), "quiet": True, "launch_ticket": False, **kw}
    if path == "incognito":
        return ant0browser.launch(ephemeral_profile=False, **kw)
    return ant0browser.launch_persistent_context(tempfile.mkdtemp(), **kw)


async def _run_async(path, **kw):
    kw = {"executable_path": _exe(), "quiet": True, "launch_ticket": False, **kw}
    if path == "incognito":
        return await async_api.launch(ephemeral_profile=False, **kw)
    return await async_api.launch_persistent_context(tempfile.mkdtemp(), **kw)


def _ip(args):
    import re
    return [a for a in args if re.match(r"^(?:--|-|/)webrtc-ip(?:=|$)", a, re.I)]


def _features(args, name):
    return [a for a in args if a.startswith("--%s-features=" % name)]


@pytest.fixture(params=[("sync", "incognito"), ("sync", "persistent"), ("async", "incognito"), ("async", "persistent")],
                ids=lambda p: "-".join(p))
def run(request, monkeypatch):
    mode, path = request.param
    if mode == "sync":
        seen = _sync(monkeypatch)
        return lambda **kw: (_run_sync(path, **kw), seen["kw"])[1]
    seen = _async(monkeypatch)

    import asyncio

    def go(**kw):
        asyncio.run(_run_async(path, **kw))
        return seen["kw"]
    return go


def test_gate_drops_every_spelling_on_old_or_unknown_engine_and_keeps_ant03(run):
    spellings = [IP, "-webrtc-ip=198.51.100.1", "--WEBRTC-IP=198.51.100.2", "/webrtc-ip=198.51.100.3", "--webrtc-ip"]
    for version in (OLD, None):
        assert _ip(run(engine_version=version, args=list(spellings))["args"]) == []
    assert _ip(run(engine_version=NEW, args=[IP])["args"]) == [IP]


def test_invalid_value_dropped_on_ant03_in_any_spelling(run):
    assert _ip(run(engine_version=NEW, args=["--webrtc-ip=not-an-ip", "-WebRTC-IP=", "--webrtc-ip"])["args"]) == []


def test_no_local_dns_with_proxy_or_raw_proxy_switch_on_ant03_only(run):
    proxy = {"server": "http://127.0.0.1:3128"}
    assert "--webrtc-no-local-dns" in run(engine_version=NEW, proxy=proxy)["args"]
    assert "--webrtc-no-local-dns" in run(engine_version=NEW, args=["--proxy-server=http://127.0.0.1:3128"])["args"]
    assert "--webrtc-no-local-dns" not in run(engine_version=OLD, proxy=proxy)["args"]
    assert "--webrtc-no-local-dns" not in run(engine_version=NEW)["args"]
    assert "--webrtc-no-local-dns" not in run(
        engine_version=NEW, proxy=proxy, args=["--webrtc-ip-handling-policy=default"])["args"]


def test_policy_in_force_decides_the_opt_out(run):
    assert _ip(run(engine_version=OLD, args=[IP, "--webrtc-ip-handling-policy=default"])["args"]) == [IP]
    for args in (
        [IP, "--webrtc-ip-handling-policy=default", "--webrtc-ip-handling-policy=disable_non_proxied_udp"],
        [IP, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=default"],
        [IP, "--webrtc-ip-handling-policy=", "--webrtc-ip-handling-policy"],
    ):
        assert _ip(run(engine_version=OLD, args=args)["args"]) == []


def test_playwright_feature_lists_merge_without_third_party_storage_partitioning(run):
    kw = run(engine_version=NEW, args=["--disable-features=BrowsingTopics", "--enable-features=Foo"])
    dis, en = _features(kw["args"], "disable"), _features(kw["args"], "enable")
    assert len(dis) == 1 and "BrowsingTopics" in dis[0] and "Translate" in dis[0]
    assert "ThirdPartyStoragePartitioning" not in dis[0]
    assert len(en) == 1 and "Foo" in en[0] and "CDPScreenshotNewSurface" in en[0]


def test_callers_ignore_default_args_adds_to_the_sdk_defaults(run):
    ign = run(engine_version=NEW, ignore_default_args=["--mute-audio"])["ignore_default_args"]
    assert {"--mute-audio", "--enable-automation", "--disable-ipc-flooding-protection"} <= set(ign)


def test_ignoring_every_default_adds_no_playwright_feature_list(run):
    kw = run(engine_version=NEW, ignore_default_args=True)
    assert not any("Translate" in a for a in _features(kw["args"], "disable"))


def _names(args, name="disable"):
    flags = _features(args, name)
    assert len(flags) == 1
    return flags[0].split("=", 1)[1].split(",")


def test_launch_never_leaves_mediarouter_disabled_but_keeps_the_other_defaults(run):
    # A page can flag a launch() whose Chromium has MediaRouter disabled as chromium_automation
    names = _names(run(engine_version=NEW)["args"])
    assert "MediaRouter" not in names
    assert "Translate" in names and HFM in names


def test_launch_stops_disabling_the_observable_features_and_keeps_hfm_disabled_once(run):
    names = _names(run(engine_version=NEW)["args"])
    assert not set(DROPPED) & set(names)
    assert names.count(HFM) == 1 and names.count("Translate") == 1


def test_launch_keeps_hfm_once_when_playwright_already_disables_it(run, monkeypatch):
    from ant0browser import _launchopts
    d = {**PW_DEFAULTS, "disabled": ["Translate", HFM, *DROPPED], "disabled_full": ["Translate", HFM, *DROPPED, "ThirdPartyStoragePartitioning"]}
    monkeypatch.setattr(_launchopts, "_installed_defaults", [d])
    assert _names(run(engine_version=NEW)["args"]).count(HFM) == 1


def test_launch_ignores_the_two_plain_switches_once(run):
    ign = run(engine_version=NEW)["ignore_default_args"]
    assert ign.count("--hide-scrollbars") == 1 and ign.count("--disable-popup-blocking") == 1
    ign = run(engine_version=NEW, ignore_default_args=["--hide-scrollbars", "--mute-audio"])["ignore_default_args"]
    assert ign.count("--hide-scrollbars") == 1 and ign.count("--disable-popup-blocking") == 1 and "--mute-audio" in ign


def test_launch_honours_a_caller_who_passes_the_plain_switches_themselves(run):
    kw = run(engine_version=NEW, args=["--hide-scrollbars", "--disable-popup-blocking"])
    assert "--hide-scrollbars" not in kw["ignore_default_args"] and "--disable-popup-blocking" not in kw["ignore_default_args"]
    assert kw["args"].count("--hide-scrollbars") == 1 and kw["args"].count("--disable-popup-blocking") == 1
    kw = run(engine_version=NEW, args=["--hide-scrollbars"])
    assert "--hide-scrollbars" not in kw["ignore_default_args"] and "--disable-popup-blocking" in kw["ignore_default_args"]


def test_launch_honours_a_caller_who_disables_the_observable_features(run):
    names = _names(run(engine_version=NEW, args=["--disable-features=HttpsUpgrades,BoundaryEventDispatchTracksNodeRemoval,MediaRouter"])["args"])
    assert names.count("HttpsUpgrades") == 1 and names.count("BoundaryEventDispatchTracksNodeRemoval") == 1 and names.count("MediaRouter") == 1 and names.count(HFM) == 1


def test_a_caller_enabling_hfm_gets_it_only_in_enable_features_with_or_without_playwright_listing_it(run, monkeypatch):
    from ant0browser import _launchopts
    with_hfm = {**PW_DEFAULTS, "disabled": ["Translate", HFM, *DROPPED], "disabled_full": ["Translate", HFM, *DROPPED, "ThirdPartyStoragePartitioning"]}
    for d in (with_hfm, PW_DEFAULTS):
        monkeypatch.setattr(_launchopts, "_installed_defaults", [d])
        for feat in (HFM, *DROPPED):
            args = run(engine_version=NEW, args=["--enable-features=" + feat])["args"]
            assert feat in _names(args, "enable")
            assert feat not in _names(args, "disable")


def test_launch_with_every_default_ignored_passes_true_and_no_feature_edit(run):
    kw = run(engine_version=NEW, ignore_default_args=True)
    assert kw["ignore_default_args"] is True
    assert not any(HFM in a for a in kw["args"])


def test_unreadable_playwright_defaults_touch_no_feature_list_but_still_ignore_the_switches(run, monkeypatch):
    from ant0browser import _launchopts
    monkeypatch.setattr(_launchopts, "_installed_defaults", [None])
    kw = run(engine_version=NEW)
    assert _features(kw["args"], "disable") == []
    assert "--hide-scrollbars" in kw["ignore_default_args"] and "--disable-popup-blocking" in kw["ignore_default_args"]
    names = _names(run(engine_version=NEW, args=["--disable-features=HttpsUpgrades"])["args"])
    assert names == ["HttpsUpgrades"]  # no HFM, nothing removed, no pin


PIN = ["DomStorageSqlite", "DomStorageSqliteMigration", "DomStorageSqliteNewDatabases"]


def test_dom_storage_pin_is_once_in_the_single_merged_disable_features(run):
    """sync, async, incognito and persistent: one --disable-features carrying Playwright's disabled
    list (minus ThirdPartyStoragePartitioning) and the leveldb pin, each name exactly once."""
    dis = _features(run(engine_version=NEW)["args"], "disable")
    assert len(dis) == 1
    names = dis[0].split("=", 1)[1].split(",")
    assert [n for n in names if n in PIN] == PIN
    assert "Translate" in names and "ThirdPartyStoragePartitioning" not in names


def test_callers_disable_features_fold_into_the_pinned_switch(run):
    dis = _features(run(engine_version=NEW, args=["--disable-features=Foo", "--disable-features=Bar"])["args"], "disable")
    assert len(dis) == 1
    names = dis[0].split("=", 1)[1].split(",")
    assert {"Foo", "Bar", "Translate", *PIN} <= set(names)


def test_callers_enable_of_dom_storage_sqlite_is_overridden_by_the_pin(run):
    args = run(engine_version=NEW, args=["--enable-features=DomStorageSqlite"])["args"]
    en, dis = _features(args, "enable"), _features(args, "disable")
    assert len(dis) == 1 and "DomStorageSqlite" in dis[0].split("=", 1)[1].split(",")
    assert len(en) == 1  # both survive; Chromium lets disable win


def test_no_pin_when_playwright_defaults_cannot_be_read(run, monkeypatch):
    """Old Playwright (parse -> None): the pin's --disable-features would replace Playwright's whole
    disabled list, so the launch keeps exactly the args it had without the pin."""
    from ant0browser import _launchopts
    monkeypatch.setattr(_launchopts, "_installed_defaults", [None])
    args = run(engine_version=NEW)["args"]
    assert not _features(args, "disable") and not any("DomStorage" in a for a in args)
    # a caller's own switch is passed through untouched (no pin folded in)
    args = run(engine_version=NEW, args=["--disable-features=Foo"])["args"]
    assert _features(args, "disable") == ["--disable-features=Foo"]


def test_pin_is_kept_when_every_playwright_default_is_ignored_and_defaults_unreadable(run, monkeypatch):
    from ant0browser import _launchopts
    monkeypatch.setattr(_launchopts, "_installed_defaults", [None])
    dis = _features(run(engine_version=NEW, ignore_default_args=True)["args"], "disable")
    assert dis == ["--disable-features=" + ",".join(PIN)]  # no Playwright list is in play to lose


def test_fallback_warning_honours_quiet(run, monkeypatch, capsys):
    from ant0browser import _launchopts
    monkeypatch.setattr(_launchopts, "_installed_defaults", [None])
    monkeypatch.delenv("ANT0_BROWSER_NO_WARN", raising=False)
    monkeypatch.setattr(_launchopts, "_warned_no_defaults", [False])
    run(engine_version=NEW, quiet=True)  # `run` defaults to quiet=True already; say it explicitly
    assert "[features]" not in capsys.readouterr().err
    run(engine_version=NEW, quiet=False)
    assert capsys.readouterr().err.count("[features]") == 1
