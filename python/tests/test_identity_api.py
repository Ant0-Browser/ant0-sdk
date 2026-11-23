import copy
import json
import os
from pathlib import Path

import pytest

import ant0browser
from ant0browser import load_template_directory, prepare_identity_options, resolve_identity
from ant0browser._fingerprint import FINGERPRINT_KEYS
from ant0browser._errors import SdkValueError


FIXTURE = Path(__file__).resolve().parents[2] / "fixtures/synthetic/persona-v2.json"


def profile():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def write_template(directory, name="desktop-a.json"):
    path = directory / name
    path.write_text(json.dumps(profile()), encoding="utf-8")
    return path


class _PreparedRuntime:
    executable = "/bin/true"
    ticket_args = []
    engine_version = None

    def release(self):
        return None


def stub_runtime_launch(monkeypatch):
    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", lambda **_kwargs: _PreparedRuntime())
    monkeypatch.setattr(ant0browser, "_guard", lambda _exe: None)


@pytest.mark.parametrize("identity", [None, {}, {"mode": "other"}, {"mode": "native", "key": "x"}])
def test_strict_mode_validation(identity):
    with pytest.raises((TypeError, ValueError)):
        resolve_identity(identity)


def test_captured_accepts_object_json_and_path_and_preserves_locale(tmp_path):
    value = profile()
    path = tmp_path / "captured.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    for source in (value, json.dumps(value), path):
        mode, options = resolve_identity({"mode": "captured", "source": source})
        assert mode == "captured"
        assert options["fingerprint_profile"]["locale"] == value["locale"]

    broken = copy.deepcopy(value)
    broken["schema_version"] = 1
    with pytest.raises(ValueError, match="schema_version"):
        resolve_identity({"mode": "captured", "source": broken})


def test_template_directory_is_sorted_validated_and_flat(tmp_path):
    write_template(tmp_path, "z.json")
    write_template(tmp_path, "a.json")
    (tmp_path / "notes.txt").write_text("ignored", encoding="utf-8")
    assert [item["id"] for item in load_template_directory(tmp_path)] == ["a", "z"]

    (tmp_path / "nested").mkdir()
    with pytest.raises(ValueError, match="not a regular file"):
        load_template_directory(tmp_path)


def test_template_directory_rejects_unsafe_invalid_and_empty(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="no .json profiles"):
        load_template_directory(empty)

    unsafe = tmp_path / "unsafe"
    unsafe.mkdir()
    write_template(unsafe, "bad name.json")
    with pytest.raises(ValueError, match="unsafe"):
        load_template_directory(unsafe)

    invalid = tmp_path / "invalid"
    invalid.mkdir()
    (invalid / "bad.json").write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="invalid template"):
        load_template_directory(invalid)



def test_template_directory_rejects_symlink(tmp_path):
    links = tmp_path / "links"
    links.mkdir()
    target = write_template(tmp_path, "target.json")
    try:
        (links / "link.json").symlink_to(target)
    except OSError as error:
        if os.name == "nt" and getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows symlink privilege is unavailable")
        raise
    with pytest.raises(ValueError, match="not a regular file"):
        load_template_directory(links)


def test_synthetic_creates_and_reuses_persisted_profile(tmp_path):
    templates = tmp_path / "templates"
    identities = tmp_path / "identities"
    templates.mkdir()
    write_template(templates)
    option = {
        "mode": "synthetic", "key": "account-42",
        "template_directory": templates, "identity_directory": identities,
    }
    first = resolve_identity(option)[1]["fingerprint_profile"]
    (templates / "desktop-a.json").unlink()
    del option["template_directory"]
    second = resolve_identity(option)[1]["fingerprint_profile"]
    assert second == first


def test_synthetic_template_env_and_missing_source(tmp_path, monkeypatch):
    monkeypatch.delenv("ANT0_BROWSER_TEMPLATE_SOURCE", raising=False)
    with pytest.raises(ValueError, match="ANT0_BROWSER_TEMPLATE_SOURCE"):
        resolve_identity({"mode": "synthetic", "key": "x", "identity_directory": tmp_path})
    templates = tmp_path / "templates"
    templates.mkdir()
    write_template(templates)
    monkeypatch.setenv("ANT0_BROWSER_TEMPLATE_SOURCE", str(templates))
    assert resolve_identity({"mode": "synthetic", "key": "x", "identity_directory": tmp_path / "ids"})[0] == "synthetic"


def test_new_api_rejects_legacy_and_camel_case_options(monkeypatch):
    for key, value in (
        ("fingerprint", "seed"), ("fingerprint_profile", profile()),
        ("light_stealth", True), ("profile", "auto"), ("profile_select", {}),
    ):
        with pytest.raises(ValueError, match="identity.*overrides"):
            ant0browser._prepare({key: value})
    with pytest.raises(ValueError, match="directory options"):
        resolve_identity({"mode": "synthetic", "key": "x", "templateDirectory": "/tmp"})
    for removed_export in ("Profile", "list_profiles", "load_profile", "resolve_auto", "resolve_local"):
        assert not hasattr(ant0browser, removed_export)


def test_native_has_no_identity_defaults_but_keeps_network_policy(monkeypatch):
    stub_runtime_launch(monkeypatch)
    forbidden = ("--fingerprint-platform=", "--fingerprint-brand=", "--accept-lang=", "--lang=", "--timezone=")
    for options in ({"identity": {"mode": "native"}}, {}):
        _exe, args, _kwargs, *_rest = ant0browser._prepare({**options, "quiet": True})
        assert not any(arg.startswith(forbidden) for arg in args)
    assert "--webrtc-ip-handling-policy=disable_non_proxied_udp" in args


def test_privacy_sandbox_remains_opt_in(monkeypatch):
    stub_runtime_launch(monkeypatch)
    assert not any("BrowsingTopics" in arg for arg in ant0browser._prepare({})[1])
    assert any(
        "BrowsingTopics" in arg
        for arg in ant0browser._prepare({"disable_privacy_sandbox": True})[1]
    )


def test_overrides_are_namespaced_and_win_over_captured_profile(monkeypatch):
    stub_runtime_launch(monkeypatch)
    _exe, args, _kwargs, *_rest = ant0browser._prepare({
        "identity": {"mode": "captured", "source": profile()},
        "overrides": {"timezone": "Europe/London", "brand": "Edge"},
        "quiet": True,
    })
    assert "--timezone=Europe/London" in args
    assert "--fingerprint-brand=Edge" in args
    with pytest.raises(ValueError, match="unsupported identity override"):
        ant0browser._prepare({"overrides": {"fingerprint": "seed"}})
    with pytest.raises(ValueError, match="not supported in args"):
        ant0browser._prepare({"args": ["--fingerprint-brand=Edge"]})

    mode, prepared = prepare_identity_options({
        "identity": {"mode": "captured", "source": profile()},
        "overrides": {"timezone": "Europe/London"},
    }, FINGERPRINT_KEYS)
    assert mode == "captured"
    assert prepared["timezone"] == "Europe/London"
    assert prepared["fingerprint_profile"]["locale"]["timezone"] != "Europe/London"


def test_persona_os_drives_platform_switch_for_cross_host_coherence():
    # The persona's compatibility.os_family must drive the platform, so a Windows persona presents
    # Windows even when the SDK drives the Linux binary (else: Linux UA next to a Windows GPU).
    options = resolve_identity({"mode": "captured", "source": profile()})[1]
    assert options["platform"] == "windows"
    # Personas are plain-Chrome captures, so they present as Google Chrome (not the build's Chromium
    # brand), else navigator.userAgentData mismatches the UA (a UA/UA-CH mismatch).
    assert options["brand"] == "chrome"
    # native carries no persona, so no platform/brand is derived (native must emit no identity defaults).
    native = resolve_identity({"mode": "native"})[1]
    assert "platform" not in native and "brand" not in native


def test_persona_platform_and_brand_switches_emitted_and_overrides_win(monkeypatch):
    stub_runtime_launch(monkeypatch)
    _exe, args, *_rest = ant0browser._prepare(
        {"identity": {"mode": "captured", "source": profile()}, "quiet": True})
    assert "--fingerprint-platform=windows" in args
    assert "--fingerprint-brand=chrome" in args
    _exe, args, *_rest = ant0browser._prepare({
        "identity": {"mode": "captured", "source": profile()},
        "overrides": {"platform": "windows", "brand": "Edge"}, "quiet": True})
    assert "--fingerprint-platform=windows" in args
    assert "--fingerprint-brand=Edge" in args and "--fingerprint-brand=chrome" not in args


def test_captured_preparation_uses_canonical_profile_without_seed(monkeypatch):
    stub_runtime_launch(monkeypatch)
    _exe, args, _kwargs, *_rest = ant0browser._prepare(
        {"identity": {"mode": "captured", "source": profile()}, "quiet": True}
    )
    assert any(arg.startswith("--fingerprint-profile=") for arg in args)
    assert not any(arg.startswith("--fingerprint=") for arg in args)
    assert "--accept-lang=en-US,en" in args
    assert "--lang=en-US" in args


# ------------------------------------------------------- webrtc-ip engine gate through _prepare
def _prepare_with_engine(monkeypatch, version, options):
    class Runtime(_PreparedRuntime):
        engine_version = version
    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", lambda **_k: Runtime())
    monkeypatch.setattr(ant0browser, "_guard", lambda _exe: None)
    return ant0browser._prepare({"quiet": True, "identity": {"mode": "native"}, **options})[1]


@pytest.mark.parametrize("version,expect", [
    ("158.0.8127.18-ant0.2", False), ("154.0.8037.57-ant0.2", False), (None, False),
    ("158.0.8127.18-ant0.3", True), ("158.0.8127.18-ant0.4", True),
])
def test_prepare_webrtc_ip_follows_engine_version(monkeypatch, version, expect):
    args = _prepare_with_engine(monkeypatch, version, {"overrides": {"webrtc_ip": "203.0.113.7"}})
    assert ("--webrtc-ip=203.0.113.7" in args) is expect
    assert "--webrtc-ip-handling-policy=disable_non_proxied_udp" in args


def test_prepare_old_engine_keeps_ip_when_caller_policy_allows_udp(monkeypatch):
    args = _prepare_with_engine(monkeypatch, "158.0.8127.18-ant0.2", {
        "overrides": {"webrtc_ip": "203.0.113.7"}, "args": ["--webrtc-ip-handling-policy=default"]})
    assert "--webrtc-ip=203.0.113.7" in args


def _persona_args(monkeypatch, platform, host):
    # Captured profiles are always os_family "windows"; a Linux persona is a platform override.
    import ant0browser._launchopts as lo
    monkeypatch.setattr(lo.sys, "platform", host)
    return _prepare_with_engine(monkeypatch, "158.0.8127.18-ant0.3", {
        "identity": {"mode": "captured", "source": profile()},
        "overrides": {"platform": platform} if platform else {}})


def test_prepare_bluetooth_only_for_non_linux_persona_on_linux_host(monkeypatch):
    assert any("WebBluetooth" in a for a in _persona_args(monkeypatch, None, "linux"))      # windows profile
    # Captured profiles are windows personas, so a macos or linux platform override is refused.
    for other in ("macos", "linux"):
        with pytest.raises(SdkValueError, match="sdk.identity_platform_mismatch|contradicts"):
            _persona_args(monkeypatch, other, "linux")
    assert not any("WebBluetooth" in a for a in _prepare_with_engine(monkeypatch, None, {}))  # native
    assert not any("WebBluetooth" in a for a in _persona_args(monkeypatch, None, "win32"))


def test_prepare_strips_ipc_flooding_protection_default(monkeypatch):
    stub = {}
    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", lambda **_k: _PreparedRuntime())
    monkeypatch.setattr(ant0browser, "_guard", lambda _exe: None)
    kwargs = ant0browser._prepare({"quiet": True})[2]
    assert "--disable-ipc-flooding-protection" in kwargs["ignore_default_args"]
    assert "--enable-automation" in kwargs["ignore_default_args"]


@pytest.mark.parametrize("version,proxy,expect", [
    ("158.0.8127.18-ant0.3", {"server": "http://127.0.0.1:3128"}, True),
    ("158.0.8127.18-ant0.3", None, False),
    ("158.0.8127.18-ant0.2", {"server": "http://127.0.0.1:3128"}, False),
    (None, {"server": "http://127.0.0.1:3128"}, False),
])
def test_prepare_passes_no_local_dns_only_with_proxy_on_new_engine(monkeypatch, version, proxy, expect):
    args = _prepare_with_engine(monkeypatch, version, {"proxy": proxy} if proxy else {})
    assert ("--webrtc-no-local-dns" in args) is expect


def _warn_text(monkeypatch, capsys, version, exe=None):
    class Runtime(_PreparedRuntime):
        engine_version = version
        executable = exe or "/bin/true"
    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", lambda **_k: Runtime())
    monkeypatch.setattr(ant0browser, "_guard", lambda _exe: None)
    monkeypatch.delenv("ANT0_BROWSER_NO_WARN", raising=False)
    opts = {"quiet": False, "identity": {"mode": "native"}, "overrides": {"canvas": "noise", "canvas_noise_key": "2092fc8be8f13c86", "gpu_string_spoof": False}}
    if exe:
        opts["executable_path"] = exe
    ant0browser._prepare(opts)
    return capsys.readouterr().err


def test_prepare_passes_engine_version_to_coherence_warnings(monkeypatch, capsys):
    # gpu-noise-string fires only on an engine that honours gpu_string_spoof=False (ant0.8 or later)
    fires = "real string over altered pixels"
    assert fires not in _warn_text(monkeypatch, capsys, "158.0.8127.18-ant0.7")
    assert fires not in _warn_text(monkeypatch, capsys, None)
    assert fires in _warn_text(monkeypatch, capsys, "158.0.8127.18-ant0.8")


def test_prepare_treats_a_dev_build_as_new(monkeypatch, capsys, tmp_path):
    base = tmp_path / "inst"
    (base / "browser").mkdir(parents=True)
    exe = base / "browser" / "chrome"
    exe.write_bytes(b"x" * 64 + b"ant0-browser-capabilities/persona-profile-v1")
    (base / ".release.json").write_text('{"version": "158.0.8127.18-ant0.dev"}')
    text = _warn_text(monkeypatch, capsys, None, str(exe))
    assert "real string over altered pixels" in text
