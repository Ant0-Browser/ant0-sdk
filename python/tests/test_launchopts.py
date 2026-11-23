import pytest

from ant0browser._launchopts import (
    FIRST_RUN_HYGIENE_ARGS,
    SOCKS_CREDENTIALS_UNSUPPORTED,
    default_start_url_args,
    extension_args,
    has_url_positional,
    merge_feature_flags,
    privacy_sandbox_args,
    quic_args,
    socks5_udp_args,
    resolve_proxy,
    webrtc_default_deny_args,
)

import ant0browser._launchopts as _lo  # module handle: web_bluetooth_args reads sys.platform


def test_merge_feature_flags_collapses_into_one_each():
    out = merge_feature_flags([
        "--enable-features=A", "--mute-audio", "--enable-features=B,C",
        "--disable-features=D", "--disable-features=D,E",
    ])
    assert [a for a in out if a.startswith("--enable-features=")] == ["--enable-features=A,B,C"]
    assert [a for a in out if a.startswith("--disable-features=")] == ["--disable-features=D,E"]
    assert "--mute-audio" in out


def test_privacy_sandbox_args():
    assert privacy_sandbox_args() == [
        "--disable-features=BrowsingTopics,BrowsingTopicsDocumentAPI,Fledge,InterestGroupStorage,"
        "PrivateAggregationApi,SharedStorageAPI,FencedFrames"
    ]


def test_webrtc_default_deny():
    assert webrtc_default_deny_args([], None) == ["--webrtc-ip-handling-policy=disable_non_proxied_udp"]
    # Regression: this used to return [] when webrtc_ip was set, on the theory that the engine's
    # srflx fabrication covered WebRTC. It does not. A page using iceTransportPolicy:"relay" forces
    # TURN; TURN prefers UDP; an HTTP/SOCKS proxy carries only TCP -- so the UDP left on the host's
    # own path and the TURN server read the real public IP off the packet, with no candidate
    # involved for the fabrication to rewrite. geoip=True sets webrtc_ip for you, so the coherent
    # configurations were the exposed ones.
    assert webrtc_default_deny_args([], "1.2.3.4") == ["--webrtc-ip-handling-policy=disable_non_proxied_udp"]
    assert webrtc_default_deny_args(["--webrtc-ip-handling-policy=default"], None) == []  # caller set it
    # An explicit caller policy still wins, even alongside a webrtc_ip.
    assert webrtc_default_deny_args(["--force-webrtc-ip-handling-policy=default"], "1.2.3.4") == []


def test_quic_args_disabled_only_when_proxied():
    # Behind any proxy (SOCKS or HTTP) QUIC can't tunnel -> disable so no UDP egresses around it.
    assert quic_args({"server": "socks5://host:1080"}) == ["--disable-quic"]
    assert quic_args({"server": "http://host:8080"}) == ["--disable-quic"]
    # No proxy -> leave QUIC on (matches real Chrome).
    assert quic_args(None) == []
    assert quic_args({}) == []  # malformed/empty proxy descriptor -> no flag


def test_extension_args_empty():
    assert extension_args(None) == []
    assert extension_args([]) == []


def test_extension_args_emits_load_and_disable_except():
    assert extension_args(["/a", "/b"]) == [
        "--load-extension=/a,/b",
        "--disable-extensions-except=/a,/b",
    ]


def test_resolve_proxy_passthrough_when_absent():
    assert resolve_proxy(None) == ([], None)


# WHY: the engine has no SOCKS5 username/password auth, and stock Chromium
# has none, so a credentialed SOCKS proxy cannot work from any layer of the stack. The SDK used to
# emit a nonexistent --socks5-credentials switch here; the proxy then refused every connection.
# Refusing to launch, with the fix spelled out, is the only honest behaviour.
def test_resolve_proxy_socks5_with_creds_raises_naming_cause_and_relay():
    proxy = {"server": "socks5://h:1080", "username": "u", "password": "p"}
    with pytest.raises(ValueError, match="RFC 1929") as info:
        resolve_proxy(proxy)
    msg = str(info.value)
    assert "relay" in msg
    assert "http(s)" in msg
    assert "--socks5-credentials" not in msg


def test_resolve_proxy_socks5_userinfo_in_url_plus_fields_raises():
    proxy = {"server": "socks5://old:secret@h:1080", "username": "u", "password": "p"}
    with pytest.raises(ValueError, match="RFC 1929"):
        resolve_proxy(proxy)


def test_resolve_proxy_socks_raises_with_only_one_credential_any_socks_scheme():
    with pytest.raises(ValueError, match="RFC 1929"):
        resolve_proxy({"server": "socks5h://h:1080", "username": "u"})
    with pytest.raises(ValueError, match="RFC 1929"):
        resolve_proxy({"server": "SOCKS4://h:1080", "password": "p"})


def test_resolve_proxy_never_emits_socks5_credentials_switch():
    # The engine has no such switch; nothing the SDK returns may reference it.
    for proxy in (
        {"server": "socks5://h:1080"},
        {"server": "http://u:p@h:8080"},
        {"server": "http://h:8080", "username": "u", "password": "p"},
    ):
        args, _ = resolve_proxy(proxy)
        assert not [a for a in args if a.startswith("--socks5-credentials")]
    assert "--socks5-credentials" not in SOCKS_CREDENTIALS_UNSUPPORTED


def test_resolve_proxy_socks5_without_creds_left_to_playwright():
    proxy = {"server": "socks5://h:1080"}
    assert resolve_proxy(proxy) == ([], proxy)


def test_resolve_proxy_http_with_creds_left_to_playwright():
    # authed HTTP proxies stay on Playwright's path (inline-cred handling needs engine support)
    proxy = {"server": "http://h:8080", "username": "u", "password": "p"}
    assert resolve_proxy(proxy) == ([], proxy)


# --------------------------------------------------------------------------- web bluetooth
# WHY THESE EXIST: Web Bluetooth is compiled into the engine but runtime-disabled on Linux only
# (Chromium marks WebBluetooth "stable" on Win/Mac and lets Linux fall to "experimental"), so a
# Linux host serving a Windows persona exposed navigator.usb/serial/hid but NOT
# navigator.bluetooth -- a combination no real Windows Chrome produces. The flag restores it.
@pytest.mark.parametrize("persona", ["windows", "macos", "Windows"])
def test_web_bluetooth_args_for_non_linux_persona_on_linux_host(persona):
    assert _lo.web_bluetooth_args(persona, "linux") == ["--enable-features=WebBluetooth"]


@pytest.mark.parametrize("persona", [None, "", "linux", "Linux"])
def test_web_bluetooth_args_absent_for_linux_persona_or_no_persona(persona):
    # Real Linux Chrome has no navigator.bluetooth, so adding it would itself be the tell.
    assert _lo.web_bluetooth_args(persona, "linux") == []


def test_web_bluetooth_args_noop_off_linux_host():
    for plat in ("win32", "darwin"):
        assert _lo.web_bluetooth_args("windows", plat) == [], plat


def test_web_bluetooth_args_default_host_is_sys_platform(monkeypatch):
    monkeypatch.setattr(_lo.sys, "platform", "linux")
    assert _lo.web_bluetooth_args("windows") == ["--enable-features=WebBluetooth"]
    monkeypatch.setattr(_lo.sys, "platform", "win32")
    assert _lo.web_bluetooth_args("windows") == []


def test_persona_platform_of_prefers_option_then_profile_os_family():
    assert _lo.persona_platform_of("Windows", {"compatibility": {"os_family": "linux"}}) == "windows"
    assert _lo.persona_platform_of(None, {"compatibility": {"os_family": "macos"}}) == "macos"
    assert _lo.persona_platform_of(None, None) is None
    assert _lo.persona_platform_of("", {}) is None


def test_web_bluetooth_folds_into_one_enable_features():
    """The flag must survive merge_feature_flags: Chromium honours only the LAST
    --enable-features, so a second occurrence would silently drop WebBluetooth."""
    merged = _lo.merge_feature_flags(
        _lo.web_bluetooth_args("windows", "linux") + ["--enable-features=SomethingElse"])
    enables = [a for a in merged if a.startswith("--enable-features=")]
    assert len(enables) == 1
    assert "WebBluetooth" in enables[0] and "SomethingElse" in enables[0]


# --------------------------------------------------------------------------- webrtc-ip engine gate
# WHY: engines through 158.0.8127.18-ant0.2 re-enable non-proxied UDP when --webrtc-ip is set,
# leaking the host's real public IP to a page's own TURN server (133 packets measured vs 0 without).
IP = "--webrtc-ip=203.0.113.7"
DENY = "--webrtc-ip-handling-policy=disable_non_proxied_udp"


@pytest.mark.parametrize("version,ok", [
    ("158.0.8127.18-ant0.3", True),
    ("158.0.8127.18-ant0.10", True),   # numeric, not lexicographic
    ("158.0.8127.18-ant0.2", False),
    ("158.0.8127.18-ant0.1", False),
    ("154.0.8037.57-ant0.2", False),
    ("154.0.8037.57-ant0.9", False),
    ("158.0.8127.19-ant0.1", True),    # later Chromium build
    ("159.0.1.1-ant0.1", True),
    ("158.0.8127.9-ant0.9", False),    # 9 < 18 numerically
    (None, False), ("", False), ("158.0.8127.18", False), ("garbage", False),
    ("158.0.8127.18-ant0.3-rc1", False), (3, False),
])
def test_engine_supports_webrtc_ip(version, ok):
    assert _lo.engine_supports_webrtc_ip(version) is ok


def test_gate_omits_flag_for_old_engine(capsys):
    out = _lo.gate_webrtc_ip_args(["--a", IP, DENY], "158.0.8127.18-ant0.2")
    assert out == ["--a", DENY]
    err = capsys.readouterr().err
    assert "webrtc-ip" in err and "203.0.113.7" not in err


def test_gate_emits_flag_for_ant0_3():
    args = ["--a", IP, DENY]
    assert _lo.gate_webrtc_ip_args(args, "158.0.8127.18-ant0.3") == args


def test_gate_omits_flag_for_unknown_version():
    assert _lo.gate_webrtc_ip_args([IP, DENY], None) == [DENY]
    assert _lo.gate_webrtc_ip_args([IP, DENY], "not-a-version") == [DENY]


def test_gate_drops_raw_caller_arg_on_old_engine():
    assert _lo.gate_webrtc_ip_args(["--webrtc-ip=1.2.3.4", DENY], "154.0.8037.57-ant0.2") == [DENY]


def test_gate_quiet_and_no_warn_env(capsys, monkeypatch):
    _lo.gate_webrtc_ip_args([IP], None, quiet=True)
    monkeypatch.setenv("ANT0_BROWSER_NO_WARN", "1")
    _lo.gate_webrtc_ip_args([IP], None)
    assert capsys.readouterr().err == ""


def test_gate_no_warning_when_nothing_dropped(capsys):
    assert _lo.gate_webrtc_ip_args([DENY], None) == [DENY]
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("policy", [
    "--webrtc-ip-handling-policy=default",
    "--force-webrtc-ip-handling-policy=default_public_interface_only",
    "--webrtc-ip-handling-policy=default_public_and_private_interfaces",
])
def test_gate_keeps_flag_when_caller_policy_allows_udp(policy):
    args = [IP, policy]
    assert _lo.gate_webrtc_ip_args(args, "158.0.8127.18-ant0.2") == args


def test_gate_still_drops_when_caller_policy_is_the_safe_one():
    out = _lo.gate_webrtc_ip_args([IP, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
                                  "158.0.8127.18-ant0.2")
    assert IP not in out


SOCKS5 = {"server": "socks5://gw.example.com:1080", "username": "u", "password": "p"}


def test_socks5_udp_emitted_only_when_opted_in():
    assert socks5_udp_args(True, SOCKS5) == ["--socks5-udp"]
    assert socks5_udp_args(False, SOCKS5) == []
    assert socks5_udp_args(None, SOCKS5) == []


def test_socks5_udp_silent_for_transports_that_cannot_carry_datagrams():
    # UDP ASSOCIATE is a SOCKS5 command. Emitting the switch for a transport that cannot relay a
    # datagram would be accepted and silently do nothing -- the failure mode this guards against.
    for server in ("http://p:8080", "https://p:8443", "socks4://p:1080"):
        assert socks5_udp_args(True, {"server": server}) == []


def test_socks5_udp_silent_without_a_proxy():
    assert socks5_udp_args(True, None) == []
    assert socks5_udp_args(True, {}) == []
    assert socks5_udp_args(True, {"server": ""}) == []


def test_socks5_udp_accepts_socks5h_and_is_case_insensitive():
    assert socks5_udp_args(True, {"server": "socks5h://p:1080"}) == ["--socks5-udp"]
    assert socks5_udp_args(True, {"server": "SOCKS5://p:1080"}) == ["--socks5-udp"]


def test_socks5_udp_composes_with_the_webrtc_deny_default():
    # Verified against the proxy's own log: the association is established with the deny policy in
    # force, so enabling UDP does not mean weakening the leak default.
    args = socks5_udp_args(True, SOCKS5)
    combined = args + webrtc_default_deny_args(args, None)
    assert "--socks5-udp" in combined
    assert "--webrtc-ip-handling-policy=disable_non_proxied_udp" in combined


def test_resolve_proxy_userinfo_in_socks_url_raises():
    from ant0browser._launchopts import resolve_proxy

    with pytest.raises(ValueError, match="RFC 1929"):
        resolve_proxy({"server": "socks5://u:p@h:1080"})
    with pytest.raises(ValueError, match="relay"):
        resolve_proxy({"server": "socks5h://u@h:1080"})
    assert resolve_proxy({"server": "http://u:p@h:3128"}) == ([], {"server": "http://u:p@h:3128"})


# Direct launches (serve) get the first-run hygiene Playwright adds for launch(); without it the
# engine opens chrome://ungoogled-first-run in the first tab.
def test_first_run_hygiene_is_three_plain_switches_no_feature_flags():
    assert list(FIRST_RUN_HYGIENE_ARGS) == [
        "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen",
    ]
    assert not any("features=" in a for a in FIRST_RUN_HYGIENE_ARGS)


def test_has_url_positional():
    assert has_url_positional([]) is False
    assert has_url_positional(["--no-sandbox", "--window-size=1,2"]) is False
    assert has_url_positional(["--no-sandbox", "https://example.com/"]) is True
    assert has_url_positional(["about:blank"]) is True
    assert has_url_positional(["--"]) is False
    assert has_url_positional(["--", "--looks-like-a-switch"]) is True


def test_default_start_url_args_only_when_no_url():
    assert default_start_url_args(["--no-sandbox"]) == ["about:blank"]
    assert default_start_url_args(["--no-sandbox", "https://example.com/"]) == []
    assert default_start_url_args(["about:blank"]) == []


@pytest.mark.parametrize("value,ok", [
    ("203.0.113.7", True), ("2001:db8::1", True), ("::1", True),
    ("", False), ("not-an-ip", False), ("203.0.113.7:80", False), ("[2001:db8::1]", False), ("fe80::1%eth0", False),
    ("999.1.1.1", False), ("1.2.3", False), (" 1.2.3.4", False), ("1.2.3.4/24", False), (None, False),
])
def test_is_valid_webrtc_ip(value, ok):
    assert _lo.is_valid_webrtc_ip(value) is ok


@pytest.mark.parametrize("engine", ["158.0.8127.18-ant0.3", "158.0.8127.18-ant0.2", None])
def test_gate_drops_invalid_value_on_every_engine_without_repeating_it(engine, capsys):
    assert _lo.gate_webrtc_ip_args(["--webrtc-ip=secret-host.example", DENY], engine) == [DENY]
    err = capsys.readouterr().err
    assert "not an IP address" in err and "secret-host" not in err


def test_gate_drops_invalid_value_even_when_caller_policy_allows_udp():
    pol = "--webrtc-ip-handling-policy=default"
    assert _lo.gate_webrtc_ip_args(["--webrtc-ip=nope", pol], "158.0.8127.18-ant0.2") == [pol]


SW = "--webrtc-no-local-dns"
NEW = "158.0.8127.18-ant0.3"


def test_no_local_dns_added_on_ant0_3_with_proxy():
    assert _lo.gate_webrtc_args([DENY], NEW, quiet=True, has_proxy=True) == [DENY, SW]
    assert SW in _lo.gate_webrtc_args([DENY], "158.0.8127.18-ant0.11", quiet=True, has_proxy=True)


def test_no_local_dns_absent_without_proxy_or_on_old_or_unknown_engine():
    assert SW not in _lo.gate_webrtc_args([DENY], NEW, quiet=True, has_proxy=False)
    assert SW not in _lo.gate_webrtc_args([DENY], "158.0.8127.18-ant0.2", quiet=True, has_proxy=True)
    assert SW not in _lo.gate_webrtc_args([DENY], None, quiet=True, has_proxy=True)


def test_no_local_dns_absent_with_udp_policy_and_not_repeated():
    assert SW not in _lo.gate_webrtc_args(["--webrtc-ip-handling-policy=default"], NEW, quiet=True, has_proxy=True)
    assert _lo.gate_webrtc_args([DENY, SW], NEW, quiet=True, has_proxy=True).count(SW) == 1


def test_gate_webrtc_args_also_gates_the_ip():
    assert _lo.gate_webrtc_args([IP, DENY], "158.0.8127.18-ant0.2", quiet=True, has_proxy=True) == [DENY]
    assert _lo.gate_webrtc_args([IP, DENY], NEW, quiet=True, has_proxy=True) == [IP, DENY, SW]


_PW_SRC = 'disabledFeatures = [\n // See x\n "AvoidX",\n "ThirdPartyStoragePartitioning",\n // y\n "Translate"\n ].filter(Boolean);'


def test_parse_playwright_disabled_features_minus_third_party_storage_partitioning():
    assert _lo.parse_playwright_disabled_features(_PW_SRC) == ["AvoidX", "Translate"]


def test_parse_playwright_disabled_features_refuses_unknown_layouts():
    assert _lo.parse_playwright_disabled_features('disabledFeatures = [ c ? "A" : "B", "ThirdPartyStoragePartitioning" ]') is None
    assert _lo.parse_playwright_disabled_features('disabledFeatures = [ "A" ]') is None
    assert _lo.parse_playwright_disabled_features("nothing") is None


def test_playwright_feature_args_emits_derived_list_or_nothing():
    assert _lo.playwright_feature_args([], ["--enable-automation"], ["AvoidX", "Translate"]) == [
        "--disable-features=AvoidX,Translate,HttpsFirstBalancedModeAutoEnable"]
    assert _lo.playwright_feature_args([], None, None) == []
    assert _lo.playwright_feature_args([], None, []) == []


def test_installed_playwright_list_when_playwright_is_present():
    pytest.importorskip("playwright")
    live = _lo.installed_playwright_disabled_features()
    if live is not None:  # None = an unrecognised layout: the SDK then adds nothing
        # Playwright's own list changes between releases (newer ones dropped "Translate"),
        # so only check what the SDK guarantees: a non-empty list without TSP.
        assert live and "ThirdPartyStoragePartitioning" not in live


def test_playwright_feature_args_ignores_only_an_exact_copy_of_the_default():
    d = {"disabled_full": ["A", "ThirdPartyStoragePartitioning", "B"], "disabled": ["A", "B"], "enabled": ["Cdp"]}
    assert _lo.playwright_feature_args([], True, d) == []
    assert _lo.playwright_feature_args([], ["--disable-features=A,ThirdPartyStoragePartitioning,B"], d) == []
    both = ["--disable-features=A,B,HttpsFirstBalancedModeAutoEnable", "--enable-features=Cdp"]
    assert _lo.playwright_feature_args([], ["--disable-features"], d) == both  # a bare entry ignores nothing
    assert _lo.playwright_feature_args([], ["--disable-features=X"], d) == both


def test_playwright_feature_args_merge_with_sdk_and_caller_lists(monkeypatch):
    monkeypatch.setattr(_lo, "_installed_defaults", [{"disabled_full": ["A", "ThirdPartyStoragePartitioning"], "disabled": ["A"], "enabled": ["Cdp"]}])
    merged = _lo.with_playwright_feature_defaults(["--disable-features=BrowsingTopics", "--enable-features=WebBluetooth", "--x"])
    dis = [a for a in merged if a.startswith("--disable-features=")]
    en = [a for a in merged if a.startswith("--enable-features=")]
    assert dis == ["--disable-features=A,HttpsFirstBalancedModeAutoEnable,BrowsingTopics," + ",".join(_lo.DOM_STORAGE_SQLITE_FEATURES)]  # launch paths pin here
    assert en == ["--enable-features=Cdp,WebBluetooth"]


def test_merge_ignore_default_args_drops_unsafe_swiftshader_on_windows_only():
    flag = "--enable-unsafe-swiftshader"
    assert flag not in _lo.merge_ignore_default_args(None, None, "linux")
    assert flag not in _lo.merge_ignore_default_args(None, None, "darwin")
    win = _lo.merge_ignore_default_args(["--mute-audio", flag], None, "win32")
    assert win.count(flag) == 1 and "--mute-audio" in win
    assert _lo.merge_ignore_default_args(True, None, "win32") is True


def test_merge_ignore_default_args_swiftshader_host_defaults_to_sys_platform(monkeypatch):
    monkeypatch.setattr(_lo.sys, "platform", "win32")
    assert "--enable-unsafe-swiftshader" in _lo.merge_ignore_default_args(None)
    monkeypatch.setattr(_lo.sys, "platform", "linux")
    assert "--enable-unsafe-swiftshader" not in _lo.merge_ignore_default_args(None)


def test_merge_ignore_default_args_adds_to_the_sdk_defaults():
    sdk = [*_lo.IGNORED_PLAYWRIGHT_DEFAULTS, "--hide-scrollbars", "--disable-popup-blocking"]
    assert _lo.merge_ignore_default_args(["--mute-audio"]) == [*sdk, "--mute-audio"]
    assert _lo.merge_ignore_default_args(None) == sdk
    assert _lo.merge_ignore_default_args(True) is True


# --- launch() stops passing four Playwright testing switches a page can observe -------------------
_DROPPED = ("HttpsUpgrades", "BoundaryEventDispatchTracksNodeRemoval", "MediaRouter")
_HFM = "HttpsFirstBalancedModeAutoEnable"


def _defaults(*disabled):
    full = [*disabled, "ThirdPartyStoragePartitioning"]
    return {"disabled_full": full, "disabled": list(disabled), "enabled": ["Cdp"]}


def test_hide_scrollbars_and_popup_blocking_are_ignored_exactly_once():
    for caller in (None, [], ["--mute-audio"], ["--hide-scrollbars", "--disable-popup-blocking", "--mute-audio"]):
        got = _lo.merge_ignore_default_args(caller)
        assert got.count("--hide-scrollbars") == 1 and got.count("--disable-popup-blocking") == 1
        assert len(got) == len(set(got))
    assert _lo.merge_ignore_default_args(True) is True  # nothing to merge into


def test_a_switch_the_caller_passes_in_args_is_not_ignored_so_it_survives():
    # Playwright's ignoreDefaultArgs also filters the caller's own args: ignoring it would drop theirs.
    got = _lo.merge_ignore_default_args(None, ["--hide-scrollbars"])
    assert "--hide-scrollbars" not in got and "--disable-popup-blocking" in got
    got = _lo.merge_ignore_default_args(["--mute-audio"], ["-disable-popup-blocking", "--x"])
    assert "--disable-popup-blocking" not in got and "--hide-scrollbars" in got and "--mute-audio" in got
    got = _lo.merge_ignore_default_args(None, ["--hide-scrollbars", "--disable-popup-blocking"])
    assert got == list(_lo.IGNORED_PLAYWRIGHT_DEFAULTS)
    assert _lo.merge_ignore_default_args(True, ["--hide-scrollbars"]) is True


def test_http_upgrade_and_boundary_event_features_are_no_longer_disabled():
    out = _lo.playwright_feature_args([], None, _defaults("A", *_DROPPED, "B"))
    names = out[0].split("=", 1)[1].split(",")
    assert names == ["A", "B", _HFM]  # exactly the two dropped, HttpsFirstBalancedModeAutoEnable added once
    assert not set(_DROPPED) & set(names)


def test_hfm_stays_disabled_exactly_once_whether_playwright_lists_it_or_not():
    for d in (_defaults("A", "HttpsUpgrades"), _defaults("A", _HFM, "HttpsUpgrades")):  # playwright-core 1.61 / Playwright 1.65
        merged = _lo.merge_feature_flags(_lo.playwright_feature_args(["--x"], None, d) + ["--x"])
        dis = [a for a in merged if a.startswith("--disable-features=")]
        assert len(dis) == 1 and dis[0].split("=", 1)[1].split(",").count(_HFM) == 1


def test_a_caller_who_disables_or_enables_these_features_is_honoured():
    d = _defaults("A", *_DROPPED)
    own = ["--disable-features=HttpsUpgrades,BoundaryEventDispatchTracksNodeRemoval,MediaRouter"]
    merged = _lo.merge_feature_flags(_lo.playwright_feature_args(own, None, d) + own)
    dis = [a for a in merged if a.startswith("--disable-features=")]
    assert len(dis) == 1
    names = dis[0].split("=", 1)[1].split(",")
    assert all(names.count(n) == 1 for n in (*_DROPPED, _HFM))
    # a caller who enables HttpsFirstBalancedModeAutoEnable is not contradicted
    en = ["--enable-features=" + _HFM]
    out = _lo.playwright_feature_args(en, None, _defaults("A", *_DROPPED))
    assert _HFM not in out[0]
    merged = _lo.merge_feature_flags(out + en)
    assert [a for a in merged if _HFM in a] == ["--enable-features=Cdp," + _HFM]


def test_unreadable_playwright_defaults_leave_the_feature_lists_untouched(monkeypatch):
    # No add, no remove, no pin, whatever the caller passed; the plain switches are separate (ignore list).
    for own in ([], ["--x"], ["--disable-features=HttpsUpgrades"], ["--enable-features=Foo", "--disable-features=Foo"]):
        assert _lo.playwright_feature_args(own, None, None, quiet=True) == []
    monkeypatch.setattr(_lo, "_installed_defaults", [None])
    for own in ([], ["--x"], ["--disable-features=HttpsUpgrades"], ["--enable-features=Foo"]):
        assert _lo.with_playwright_feature_defaults(list(own), None, quiet=True) == _lo.merge_feature_flags(list(own))
    assert "--hide-scrollbars" in _lo.merge_ignore_default_args(None)


_PW_OLD_LAYOUT = (
    'disabledFeatures = ["ThirdPartyStoragePartitioning", "T"];\n'
    'chromiumSwitches = [\n  "--disable-extensions",\n  "--disable-features=" + disabledFeatures.join(","),\n'
    '  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? "" : "--enable-features=CDPScreenshotNewSurface",\n  "--allow-pre-commit-input",\n];')
_PW_NEW_LAYOUT = (
    'disabledFeatures = [\n "ThirdPartyStoragePartitioning",\n "T"\n].filter(Boolean);\n'
    'enabledFeatures = () => [\n  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? "" : "CDPScreenshotNewSurface",\n'
    '  // why\n  "SkipListAccountsWithoutGaiaCookies"\n].filter(Boolean);\n'
    'chromiumSwitches = (o) => [\n  "--disable-features=" + disabledFeatures.join(","),\n'
    '  "--enable-features=" + enabledFeatures().join(","),\n];')
_PW_DECOY = ('throw new Error(\'WebMCP is not enabled. Launch the browser with the "--enable-features=WebMCP" argument.\');\n')


def test_parse_playwright_feature_defaults_reads_enable_features_older_layout():
    assert _lo.parse_playwright_feature_defaults(_PW_OLD_LAYOUT, {})["enabled"] == ["CDPScreenshotNewSurface"]
    assert _lo.parse_playwright_feature_defaults(_PW_OLD_LAYOUT, {"PLAYWRIGHT_LEGACY_SCREENSHOT": "1"})["enabled"] == []


def test_parse_playwright_feature_defaults_reads_enable_features_current_layout():
    d = _lo.parse_playwright_feature_defaults(_PW_NEW_LAYOUT, {})
    assert d["enabled"] == ["CDPScreenshotNewSurface", "SkipListAccountsWithoutGaiaCookies"]
    assert d["disabled"] == ["T"]
    assert _lo.parse_playwright_feature_defaults(_PW_NEW_LAYOUT, {"PLAYWRIGHT_LEGACY_SCREENSHOT": "1"})["enabled"] == [
        "SkipListAccountsWithoutGaiaCookies"]


@pytest.mark.parametrize("layout", [_PW_OLD_LAYOUT, _PW_NEW_LAYOUT])
def test_parse_ignores_an_enable_features_string_that_is_not_the_default_switch(layout):
    """An error message elsewhere in the bundle quotes ``--enable-features=WebMCP``. Reading it made
    every Python launch end with that switch, replacing Playwright's own enabled list."""
    real = _lo.parse_playwright_feature_defaults(layout, {})["enabled"]
    assert _lo.parse_playwright_feature_defaults(_PW_DECOY + layout, {})["enabled"] == real
    assert _lo.parse_playwright_feature_defaults(layout + "\n" + _PW_DECOY, {})["enabled"] == real
    assert "WebMCP" not in real


def test_parse_returns_none_when_the_enabled_list_is_not_recognisable():
    bad_array = _PW_NEW_LAYOUT.replace('"SkipListAccountsWithoutGaiaCookies"', 'cond() ? "X" : "Y"')
    assert _lo.parse_playwright_feature_defaults(bad_array, {}) is None
    no_emit = _PW_NEW_LAYOUT.replace('"--enable-features=" + enabledFeatures().join(",")', '"--other"')
    assert _lo.parse_playwright_feature_defaults(no_emit, {}) is None
    # only a decoy string and no enabled list at all: nothing is read from it and the layout is unknown
    assert _lo.parse_playwright_feature_defaults('disabledFeatures = ["ThirdPartyStoragePartitioning"];\n' + _PW_DECOY, {}) is None
    # no --enable-features= string and no enabledFeatures identifier: an old Playwright with none
    assert _lo.parse_playwright_feature_defaults('disabledFeatures = ["ThirdPartyStoragePartitioning"];', {})["enabled"] == []
    # the enabledFeatures identifier alone (no switch string to anchor on) is not guessed at
    assert _lo.parse_playwright_feature_defaults(
        'disabledFeatures = ["ThirdPartyStoragePartitioning"];\nenabledFeatures = ["A"];', {}) is None


_REAL = ["CDPScreenshotNewSurface", "SkipListAccountsWithoutGaiaCookies"]


def _enabled(src):
    d = _lo.parse_playwright_feature_defaults(src, {})
    return None if d is None else d["enabled"]


def test_parse_layout_variants_give_the_right_list_or_none():
    # a "]" inside a comment in the array
    assert _enabled(_PW_NEW_LAYOUT.replace("// why", "// why [x] ]")) == _REAL
    assert _enabled(_PW_NEW_LAYOUT.replace("// why", "/* why ] */")) == _REAL
    # the enable entry is not directly after the disable entry
    far = _PW_OLD_LAYOUT.replace('  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT', '  "--other",\n  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT')
    assert far != _PW_OLD_LAYOUT and _enabled(far) is None
    # an inline array in the switch
    inline = 'disabledFeatures = ["ThirdPartyStoragePartitioning"];\nx = ["--enable-features=" + ["A"].join(",")];'
    assert _enabled(inline) is None
    # a renamed variable still resolves through the switch that is emitted
    assert _enabled(_PW_NEW_LAYOUT.replace("enabledFeatures", "enabledFeatureList")) == _REAL
    # an unrelated earlier enabledFeatures array is not the one emitted
    renamed = _PW_NEW_LAYOUT.replace("enabledFeatures", "enabledFeatureList")
    assert _enabled('enabledFeatures = ["Unrelated"];\n' + renamed) == _REAL
    # ... and two assignments to the emitted name are ambiguous
    assert _enabled('enabledFeatures = ["Unrelated"];\n' + _PW_NEW_LAYOUT) is None
    # a computed array tail is not a plain list
    assert _enabled(_PW_NEW_LAYOUT.replace('.filter(Boolean);\nchromiumSwitches', '.concat(extra);\nchromiumSwitches')) is None


def test_parse_reads_the_checked_in_playwright_1_65_1_excerpt():
    from pathlib import Path
    text = (Path(__file__).resolve().parents[2] / "fixtures" / "playwright-1.65.1-chromium-switches.js").read_text(encoding="utf8")
    d = _lo.parse_playwright_feature_defaults(text, {})
    assert d["enabled"] == _REAL
    assert "ThirdPartyStoragePartitioning" in d["disabled_full"] and "ThirdPartyStoragePartitioning" not in d["disabled"]
    assert "WebMCP" not in d["enabled"] + d["disabled"]


def _final_enable_features(defaults):
    """The --enable-features value of the final merged args for a launch whose persona adds features."""
    own = _lo.web_bluetooth_args("windows", "linux")
    assert own == ["--enable-features=WebBluetooth"]
    if defaults == "installed":
        merged = _lo.with_playwright_feature_defaults(own + ["--x"], None, quiet=True)
    else:
        merged = _lo.merge_feature_flags(_lo.playwright_feature_args(own, None, defaults, quiet=True) + own + ["--x"])
    enables = [a for a in merged if a.startswith("--enable-features=")]
    assert len(enables) == 1
    return enables[0].split("=", 1)[1].split(",")


def _fixture_cases():
    from pathlib import Path
    excerpt = (Path(__file__).resolve().parents[2] / "fixtures" / "playwright-1.65.1-chromium-switches.js").read_text(encoding="utf8")
    return [_PW_OLD_LAYOUT, _PW_NEW_LAYOUT, _PW_DECOY + _PW_OLD_LAYOUT, _PW_DECOY + _PW_NEW_LAYOUT, excerpt]


def test_the_sdks_own_enable_features_never_contain_webmcp():
    pytest.importorskip("playwright")
    got = _final_enable_features("installed")
    assert "WebBluetooth" in got and "WebMCP" not in got and "DeclarativeWebMCP" not in got
    for src in _fixture_cases():
        defaults = _lo.parse_playwright_feature_defaults(src, {})
        assert defaults is not None
        got = _final_enable_features(defaults)
        assert "WebBluetooth" in got and "WebMCP" not in got and "DeclarativeWebMCP" not in got
        assert set(defaults["enabled"]) <= set(got)
    # the fallback: nothing is read, nothing is added
    got = _final_enable_features(None)
    assert got == ["WebBluetooth"]


def test_the_fallback_warning_names_what_gets_replaced(capsys, monkeypatch):
    monkeypatch.delenv("ANT0_BROWSER_NO_WARN", raising=False)
    monkeypatch.setattr(_lo, "_warned_no_defaults", [False])
    assert _lo.playwright_feature_args([], None, None) == []
    assert _lo.playwright_feature_args([], None, None) == []
    err = capsys.readouterr().err
    assert err.count("[features]") == 1
    assert "--enable-features" in err and "CDPScreenshotNewSurface" in err
    assert "replaces Playwright's whole disabled list" in err and "no longer disabled" in err
    assert "ThirdPartyStoragePartitioning" in err and "stays disabled" not in err  # that clause was false
    assert "With neither switch, Playwright's lists stay in effect" in err
    # identical text in the Node SDK
    from pathlib import Path
    import re
    node = (Path(__file__).resolve().parents[2] / "node" / "src" / "launchopts.ts").read_text(encoding="utf8")
    i = node.index('process.stderr.write("[ant0-browser] [features]')
    j = node.index(");", i)
    js = "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', node[i:j])).replace("\\n", "\n")
    assert js == err.strip("") or js == err


def test_dom_storage_names_match_the_node_sdk():
    import re
    from pathlib import Path
    src = (Path(__file__).resolve().parents[2] / "node" / "src" / "launchopts.ts").read_text(encoding="utf8")
    m = re.search(r"DOM_STORAGE_SQLITE_FEATURES\s*(?::[^=]+)?=\s*\[(.*?)\]", src, re.S)
    assert m is not None, "DOM_STORAGE_SQLITE_FEATURES not found in node/src/launchopts.ts"
    block = m.group(1)
    assert tuple(re.findall(r'"(\w+)"', block)) == _lo.DOM_STORAGE_SQLITE_FEATURES
    assert _lo.dom_storage_backend_args() == [
        "--disable-features=DomStorageSqlite,DomStorageSqliteMigration,DomStorageSqliteNewDatabases"]


def _installed_pw_source():
    import playwright
    from pathlib import Path
    root = Path(playwright.__file__).parent / "driver" / "package"
    return root, (root / "lib" / "coreBundle.js").read_text(encoding="utf8")


def test_parse_matches_the_real_defaults_of_the_installed_playwright():
    """Read the real list a different way from the parse: run Playwright's own chromiumSwitches
    through node and take what it emits."""
    import json
    import shutil
    import subprocess
    pytest.importorskip("playwright")
    root, text = _installed_pw_source()
    node = shutil.which("node") or str(root.parent / "node")
    if "chromiumSwitches = " not in text or not node:
        pytest.skip("installed Playwright layout has no inline chromiumSwitches")
    start = text.find("var disabledFeatures, enabledFeatures, chromiumSwitches;")
    first = text.find("disabledFeatures = [", start) if start >= 0 else -1
    if first < 0 or text.find("\n  }\n});", first) < 0:
        pytest.skip("installed Playwright layout is not one this check can evaluate")
    block = text[first:]
    end = block.index("\n  }\n});")  # end of the module initialiser that holds the three definitions
    js = "let disabledFeatures, enabledFeatures, chromiumSwitches;\n" + block[:end] + \
        "\nconst a = chromiumSwitches({});\nconsole.log(JSON.stringify(a.filter(x => x.startsWith('--enable-features=') || x.startsWith('--disable-features='))));"
    try:
        out = subprocess.run([node, "-"], input=js, capture_output=True, text=True, timeout=30, check=True).stdout
    except (subprocess.SubprocessError, OSError) as exc:  # noqa: BLE001
        pytest.skip(f"cannot evaluate the installed Playwright switches: {exc}")
    real = json.loads(out)
    real_enabled = next(a for a in real if a.startswith("--enable-features=")).split("=", 1)[1].split(",")
    real_disabled = next(a for a in real if a.startswith("--disable-features=")).split("=", 1)[1].split(",")
    got = _lo.parse_playwright_feature_defaults(text)
    assert got is not None
    assert got["enabled"] == real_enabled
    assert got["disabled_full"] == real_disabled
    assert "WebMCP" not in got["enabled"]
    import importlib.metadata as md
    if md.version("playwright") == "1.65.1":
        assert real_enabled == ["CDPScreenshotNewSurface", "SkipListAccountsWithoutGaiaCookies"]


def test_web_bluetooth_args_with_no_argument_keeps_the_old_public_behaviour():
    assert _lo.web_bluetooth_args(host_platform="linux") == ["--enable-features=WebBluetooth"]
    assert _lo.web_bluetooth_args(None, "linux") == []


@pytest.mark.parametrize("arg", ["-webrtc-ip=203.0.113.7", "/webrtc-ip=203.0.113.7", "--WebRTC-IP=203.0.113.7", "--webrtc-ip"])
def test_gate_drops_every_spelling_on_an_old_engine(arg):
    assert _lo.gate_webrtc_ip_args([arg, "--x"], "158.0.8127.18-ant0.2", quiet=True) == ["--x"]


def test_gate_drops_invalid_values_on_ant03_in_any_spelling_and_stops_at_double_dash():
    new = "158.0.8127.18-ant0.3"
    ok = "--webrtc-ip=203.0.113.7"
    assert _lo.gate_webrtc_ip_args(["--webrtc-ip", "-webrtc-ip=", "/WEBRTC-IP=nope", ok], new, quiet=True) == [ok]
    assert _lo.gate_webrtc_ip_args(["--", ok], "158.0.8127.18-ant0.2", quiet=True) == ["--", ok]


def test_policy_in_force_last_wins_force_wins_empty_sets_nothing():
    p = _lo.effective_webrtc_policy
    assert p(["--webrtc-ip-handling-policy=default", "--webrtc-ip-handling-policy=disable_non_proxied_udp"]) == "disable_non_proxied_udp"
    assert p(["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=default"]) == "disable_non_proxied_udp"
    assert p(["--webrtc-ip-handling-policy=", "--webrtc-ip-handling-policy", "-FORCE-webrtc-ip-handling-policy="]) is None
    assert _lo._caller_allows_udp(["-webrtc-ip-handling-policy=default"]) is True
    assert _lo._caller_allows_udp(["--webrtc-ip-handling-policy="]) is False


def test_raw_proxy_server_detection_and_no_local_dns():
    new = "158.0.8127.18-ant0.3"
    assert _lo.has_raw_proxy_server(["-proxy-server=http://h:1"]) is True
    assert _lo.has_raw_proxy_server(["--proxy-server=direct://"]) is False
    assert _lo.has_raw_proxy_server(["--proxy-server=http://h:1", "--no-proxy-server"]) is False
    assert "--webrtc-no-local-dns" in _lo.gate_webrtc_args(["--proxy-server=http://h:1"], new, quiet=True)
    both = ["--proxy-server=http://h:1", "-WEBRTC-NO-LOCAL-DNS"]
    assert _lo.gate_webrtc_args(both, new, quiet=True) == both


def test_installed_engine_version_is_strict(tmp_path, monkeypatch):
    from ant0browser._launch_ticket import installed_engine_version
    base = tmp_path / "inst"
    (base / "browser").mkdir(parents=True)
    exe = base / "browser" / "chrome"
    exe.write_text("x")
    (base / ".release.json").write_text('{"version": "158.0.8127.18-ant0.3"}')
    assert installed_engine_version(str(exe)) == "158.0.8127.18-ant0.3"
    # stale env, a version in the path and a far-ancestor record are not evidence
    other = tmp_path / "far" / "158.0.8127.18-ant0.3"
    other.mkdir(parents=True)
    (tmp_path / "far" / ".release.json").write_text('{"version": "158.0.8127.18-ant0.3"}')
    (other / "chrome").write_text("x")
    monkeypatch.setenv("ANT0_BROWSER_ENGINE_VERSION", "158.0.8127.18-ant0.3")
    assert installed_engine_version(str(other / "chrome")) is None


def test_installed_engine_version_dev_label_only_when_allowed(tmp_path):
    from ant0browser._launch_ticket import installed_engine_version
    base = tmp_path / "inst"
    (base / "browser").mkdir(parents=True)
    exe = base / "browser" / "chrome"
    exe.write_text("x")
    (base / ".release.json").write_text('{"version": "158.0.8127.18-ant0.dev"}')
    assert installed_engine_version(str(exe)) is None                      # the strict gate value
    assert installed_engine_version(str(exe), allow_dev=True) == "158.0.8127.18-ant0.dev"
    (base / ".release.json").write_text('{"version": "nonsense"}')
    assert installed_engine_version(str(exe), allow_dev=True) is None


def test_a_caller_who_enables_a_managed_feature_gets_it_only_in_enable_features():
    # defaults that CONTAIN HFM (Playwright 1.65 shape) and defaults that do not (playwright-core 1.61 shape)
    for d in (_defaults("A", _HFM, *_DROPPED), _defaults("A", *_DROPPED)):
        for feat in (_HFM, "HttpsUpgrades", "BoundaryEventDispatchTracksNodeRemoval"):
            own = ["--enable-features=" + feat]
            merged = _lo.merge_feature_flags(_lo.playwright_feature_args(own, None, d) + own)
            dis = [a for a in merged if a.startswith("--disable-features=")]
            en = [a for a in merged if a.startswith("--enable-features=")]
            assert len(en) == 1 and feat in en[0].split("=", 1)[1].split(",")
            assert all(feat not in x.split("=", 1)[1].split(",") for x in dis)
        # a caller who enables nothing still gets HFM disabled exactly once
        merged = _lo.merge_feature_flags(_lo.playwright_feature_args([], None, d))
        dis = [a for a in merged if a.startswith("--disable-features=")]
        assert len(dis) == 1 and dis[0].split("=", 1)[1].split(",").count(_HFM) == 1
