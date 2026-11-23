from ant0browser._warnings import coherence_warnings


def codes(opts, host="win32", build="149"):
    return {w["code"] for w in coherence_warnings(opts, host_platform=host, build_major=build)}


def test_coherent_default_is_silent():
    assert coherence_warnings(
        {"platform": "windows", "fingerprint": "s", "headless": False},
        host_platform="win32", build_major="149") == []


def test_proxy_without_geo():
    assert "proxy-no-geo" in codes({"proxy": {"server": "http://h:8080"}, "headless": False})
    # silent when geoip is on or manual geo is supplied
    assert "proxy-no-geo" not in codes({"proxy": {"server": "http://h:8080"}, "geoip": True, "headless": False})
    assert "proxy-no-geo" not in codes(
        {"proxy": "http://h:8080", "timezone": "America/New_York", "accept_language": "en-US,en", "headless": False})


def test_socks_geoip_cannot_resolve():
    assert "socks-geoip" in codes({"proxy": "socks5://u:p@h:1", "geoip": True, "headless": False})
    assert "socks-geoip" not in codes({"proxy": "http://h:1", "geoip": True, "headless": False})


def test_platform_vs_host_fonts():
    assert "platform-host-fonts" in codes({"platform": "macos", "headless": False})
    assert "platform-host-fonts" not in codes({"platform": "windows", "headless": False})
    assert "platform-host-fonts" not in codes(
        {"platform": "macos", "fingerprint_profile": "p.json", "headless": False})


def test_gpu_incoherent_with_platform():
    assert "gpu-platform" in codes(
        {"platform": "macos", "gpu_renderer": "ANGLE (Apple, Direct3D11)", "headless": False}, host="darwin")
    assert "gpu-platform" not in codes(
        {"platform": "windows", "gpu_renderer": "ANGLE (Intel, Intel(R) UHD Direct3D11)", "headless": False})


def test_software_gpu_string():
    assert "gpu-software" in codes({"gpu_renderer": "ANGLE (Google, Vulkan SwiftShader Device)", "headless": False})


def test_brand_and_version_vs_build():
    assert "brand-mismatch" in codes({"brand": "edge", "headless": False})
    assert "brand-mismatch" not in codes({"brand": "chrome", "headless": False})
    assert "version-mismatch" in codes({"brand_version": "146", "headless": False})
    assert "version-mismatch" not in codes({"brand_version": "149.0.1", "headless": False})


def test_disable_gpu_warns_only_in_canvas_noise_mode():
    assert "gpu-noise" in codes({"disable_gpu_fingerprint": True, "canvas": "noise", "headless": False})
    assert "gpu-noise" not in codes({"disable_gpu_fingerprint": True, "headless": False})
    assert "gpu-noise" not in codes({"disable_gpu_fingerprint": True, "canvas": "real", "headless": False})


def test_headless_render_note():
    assert "headless-render" in codes({"headless": True})
    assert "headless-render" not in codes({"headless": False})
    assert "headless-render" not in codes({"headless": True, "disable_gpu_fingerprint": True})


def test_bridge_note_is_gone():
    assert "bridge-no-gpu" not in codes({"canvas_bridge": {"url": "ws://h:1"}, "headless": False})


def test_automation_arg_readded():
    assert "automation-arg" in codes({"_user_args": ["--enable-automation"], "headless": False})
    assert "automation-arg" in codes({"_user_args": ["--remote-debugging-port=9222"], "headless": False})
    assert "automation-arg" not in codes({"_user_args": ["--no-sandbox"], "headless": False})


def _codes(opts, engine_version=None):
    return {w["code"] for w in coherence_warnings(opts, engine_version=engine_version)}


OLD, FIRST_FIXED, LATER = "158.0.8127.18-ant0.7", "158.0.8127.18-ant0.8", "158.0.8127.18-ant0.10"
REAL = {"gpu_string_spoof": False, "canvas_noise": False}
NOISE = {**REAL, "canvas": "noise"}


def _msg(opts, code, engine_version=None):
    return next(w["message"] for w in coherence_warnings(opts, engine_version=engine_version) if w["code"] == code)


def test_engine_has_gpu_canvas_fixes():
    from ant0browser._warnings import engine_has_gpu_canvas_fixes as f
    assert f(FIRST_FIXED) and f(LATER) and f("158.0.8127.19-ant0.1") and f("159.0.1.1-ant0.1")
    assert not f(OLD) and not f("158.0.8127.18-ant0.2")
    assert not f("158.0.8127.9-ant0.9")   # numeric, not lexicographic
    # dev build counts as new; missing or unparseable counts as old
    assert f("158.0.8127.18-ant0.dev")
    for unknown in (None, "", "garbage", "158.0.8127.18-ant0.8-rc1", "158.0.8127.18", 8):
        assert not f(unknown), unknown


def test_gap_warnings_follow_engine_version():
    for v in (OLD, None, "garbage"):          # old and unknown engines: the switch is ignored, in either mode
        for o in (REAL, NOISE):
            c = _codes(o, v)
            assert "gpu-string-only" in c, v
            assert "gpu-noise-string" not in c, v  # would repeat gpu-string-only
        assert "canvas-noise-toblob" in _codes(NOISE, v), v
        assert "canvas-noise-toblob" not in _codes(REAL, v), v   # real mode: no noise to keep
    for v in (FIRST_FIXED, LATER, "158.0.8127.18-ant0.dev"):   # ant0.8, later and dev builds
        for o in (REAL, NOISE):
            c = _codes(o, v)
            assert "gpu-string-only" not in c and "canvas-noise-toblob" not in c, v
        assert "gpu-noise-string" in _codes(NOISE, v), v
        assert "gpu-noise-string" not in _codes(REAL, v), v


def test_gpu_string_only_is_warn_severity():
    for v in (OLD, None, "garbage"):
        w = next(w for w in coherence_warnings(REAL, engine_version=v) if w["code"] == "gpu-string-only")
        assert w["severity"] == "warn", v


def test_old_engine_text_says_switches_are_ignored():
    assert "engines before ant0.8 ignore gpu_string_spoof=False" in _msg(NOISE, "gpu-string-only", OLD)
    assert "full persona GPU" in _msg(NOISE, "gpu-string-only", OLD)
    assert "engines before ant0.8 ignore canvas_noise=False" in _msg(NOISE, "canvas-noise-toblob", OLD)
    assert "canvas mode 'noise'" in _msg(NOISE, "canvas-noise-toblob", OLD)


def test_gpu_string_only_stands_down_with_disable_gpu_fingerprint():
    assert "gpu-string-only" not in _codes(
        {"gpu_string_spoof": False, "disable_gpu_fingerprint": True, "headless": False}, OLD)


def test_emit_passes_engine_version(capsys):
    from ant0browser import _warnings as w
    w._seen_notes.clear()
    w.emit_coherence_warnings(NOISE, engine_version=FIRST_FIXED)
    assert "ignore canvas_noise=False" not in capsys.readouterr().err
    w.emit_coherence_warnings(NOISE, engine_version=OLD)
    assert "ignore canvas_noise=False" in capsys.readouterr().err
    w._seen_notes.clear()


NOISY = ("gpu-noise", "gpu-noise-string", "canvas-noise-toblob", "canvas-noise-conflict")
DGF = {"disable_gpu_fingerprint": True, "headless": False}


def test_real_mode_fires_no_noise_warning():
    for v in (FIRST_FIXED, OLD, None):
        for o in (
            DGF, {**DGF, "canvas": "real"}, {**DGF, "canvas": "real", "fingerprint_noise": True, "canvas_noise": True},
            {**DGF, "canvas_noise": False}, {**DGF, "fingerprint_noise": False},
            {"gpu_string_spoof": False, "canvas_noise": False, "headless": False},
        ):
            c = _codes(o, v)
            for code in NOISY:
                assert code not in c, (o, v, code)


def test_noise_mode_with_real_gpu_says_what_the_noise_does_and_the_way_out():
    for o in ({**DGF, "canvas": "noise"},):
        w = next((w for w in coherence_warnings(o, engine_version=FIRST_FIXED) if w["code"] == "gpu-noise"), None)
        assert w is not None, o
        assert w["severity"] == "warn"
        assert "canvas mode 'noise'" in w["message"]
        assert "unique to the profile" in w["message"]
        assert "canvas='real'" in w["message"]
    for v in (OLD, None):
        assert "gpu-noise" in _codes({**DGF, "canvas": "noise"}, v)


def test_canvas_real_wins_over_the_legacy_true_overrides():
    assert "gpu-noise" not in _codes({**DGF, "canvas": "real", "canvas_noise": True}, FIRST_FIXED)


def test_no_canvas_warning_talks_about_a_seed_path():
    for o in ({**DGF, "canvas": "noise"}, {"gpu_string_spoof": False, "canvas": "noise", "headless": False},
              {"canvas": "noise", "canvas_noise": False, "headless": False},
              {"canvas": "noise", "fingerprint_noise": False, "headless": False}):
        for v in (FIRST_FIXED, OLD):
            for w in coherence_warnings(o, engine_version=v):
                assert "seed path" not in w["message"].lower(), w["code"]
                assert "exact fix" not in w["message"], w["code"]


def test_canvas_noise_with_fingerprint_noise_false_warns_once_and_only_in_noise_mode():
    found = [w for w in coherence_warnings({"canvas": "noise", "fingerprint_noise": False, "headless": False})
             if w["code"] == "canvas-noise-conflict"]
    assert len(found) == 1
    assert found[0]["severity"] == "warn"
    assert "fingerprintNoise:false" in found[0]["message"] and "fingerprint_noise=False" in found[0]["message"]
    assert "canvas-noise-conflict" not in _codes({"canvas": "real", "fingerprint_noise": False, "headless": False})
    assert "canvas-noise-conflict" not in _codes({"fingerprint_noise": False, "headless": False})
    assert "canvas-noise-conflict" not in _codes({"canvas": "noise", "headless": False})


def test_invalid_canvas_is_treated_as_real_by_the_warnings():
    assert "gpu-noise" not in _codes({**DGF, "canvas": "weird"}, FIRST_FIXED)


def test_linux_host_has_gpu(tmp_path):
    from ant0browser._warnings import linux_host_has_gpu
    dri = tmp_path / "dri"
    assert linux_host_has_gpu(str(dri)) is False          # dir missing -> no GPU
    dri.mkdir()
    assert linux_host_has_gpu(str(dri)) is False          # empty -> no GPU
    (dri / "renderD128").write_text("")
    assert linux_host_has_gpu(str(dri)) is True           # a render node -> GPU present
    dri2 = tmp_path / "dri2"; dri2.mkdir(); (dri2 / "card0").write_text("")
    assert linux_host_has_gpu(str(dri2)) is True          # a card node also counts


def test_gpu_host_missing_for(tmp_path):
    from ant0browser._warnings import gpu_host_missing_for
    empty = tmp_path / "nogpu"; empty.mkdir()             # a Linux host with no GPU device
    real = tmp_path / "gpu"; real.mkdir(); (real / "renderD128").write_text("")

    # synthetic/captured persona on a GPU-less Linux host -> flagged with the mode
    assert gpu_host_missing_for({}, "synthetic", host_platform="linux", dri_dir=str(empty)) == "synthetic"
    assert gpu_host_missing_for({}, "captured", host_platform="linux", dri_dir=str(empty)) == "captured"
    # native persona never claims a spoofed GPU -> silent
    assert gpu_host_missing_for({}, "native", host_platform="linux", dri_dir=str(empty)) is None
    # a real GPU present -> silent
    assert gpu_host_missing_for({}, "synthetic", host_platform="linux", dri_dir=str(real)) is None
    # Windows/mac hosts have GPUs; only Linux is checked -> silent
    assert gpu_host_missing_for({}, "synthetic", host_platform="win32", dri_dir=str(empty)) is None
    # explicit escape hatches -> silent
    assert gpu_host_missing_for({"disable_gpu_fingerprint": True}, "synthetic", host_platform="linux", dri_dir=str(empty)) is None
    assert gpu_host_missing_for({"gpu_renderer": "SwiftShader"}, "synthetic", host_platform="linux", dri_dir=str(empty)) is None
    # the removed canvas_bridge option no longer silences the warning
    assert gpu_host_missing_for({"canvas_bridge": {"url": "ws://h/x"}}, "synthetic", host_platform="linux", dri_dir=str(empty)) == "synthetic"


def test_persona_gpu_unreachable_warning():
    # the threaded flag surfaces the render-vs-string contradiction; supersedes headless-render note
    c = codes({"_gpu_host_missing": "synthetic", "headless": True}, host="linux")
    assert "persona-gpu-unreachable" in c
    assert "headless-render" not in c
    # absent flag -> no gpu-unreachable warning
    assert "persona-gpu-unreachable" not in codes({"headless": False}, host="linux")


def test_gpu_string_only_prints_once_per_process(capsys):
    from ant0browser import _warnings as w
    w._seen_notes.clear()
    for _ in range(3):
        w.emit_coherence_warnings({"gpu_string_spoof": False}, engine_version=OLD)
    err = capsys.readouterr().err
    assert err.count("ignore gpu_string_spoof=False") == 1 and "warning:" in err
    w._seen_notes.clear()
