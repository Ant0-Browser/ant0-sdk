"""SDK geometry policy tests; Chromium owns persona/profile window geometry."""

import pytest

import ant0browser
from ant0browser._geometry import (
    _DEFAULT_HEADLESS_GEOMETRY_SEED,
    _hash_point,
    ENGINE_FRAME_HEIGHT,
    ENGINE_FRAME_WIDTH,
    HEADLESS_SCREEN_PROFILES,
    apply_headless_geometry,
    geometry_is_coherent,
    headless_geometry,
    initial_window_args,
    native_display_active,
)


def test_corpus_geometry_fits_the_headless_screen():
    for width, height, _weight, _os in HEADLESS_SCREEN_PROFILES:
        inner = (width - ENGINE_FRAME_WIDTH, height - ENGINE_FRAME_HEIGHT)
        assert geometry_is_coherent((width, height), (width, height), inner, (width, height))


PARITY = [
    (None, 1920, 1080),
    ("", 1920, 1080),
    ("seed-1", 1920, 1200),
    ("acct-42", 1366, 768),
    ("ant0", 1366, 768),
    ("x", 2560, 1440),
    ("y", 3440, 1440),
    ("z", 1920, 1080),
    ("12345", 1920, 1080),
]


@pytest.mark.parametrize("seed,width,height", PARITY)
def test_cross_sdk_corpus_parity(seed, width, height):
    assert headless_geometry(seed) == {
        "screen": {"width": width, "height": height},
        "viewport": {
            "width": width - ENGINE_FRAME_WIDTH,
            "height": height - ENGINE_FRAME_HEIGHT,
        },
    }


def test_native_display_detection_includes_profiles_and_direct_avail_geometry():
    assert native_display_active(["--fingerprint=seed"])
    assert native_display_active(["--fingerprint-profile=encoded"])
    assert native_display_active([
        "--fingerprint-avail-width=1600", "--fingerprint-avail-height=860"])
    assert not native_display_active(["--fingerprint-avail-width=1600"])
    assert not native_display_active(["--fingerprint-screen-width=1600"])


@pytest.mark.parametrize("args", [
    ["--fingerprint=seed"],
    ["--fingerprint-profile=encoded"],
    ["--fingerprint-avail-width=1600", "--fingerprint-avail-height=860"],
])
def test_native_display_uses_no_viewport_without_sdk_geometry(args):
    kwargs = {"headless": True}
    assert apply_headless_geometry(kwargs, "seed", args) == {"mode": "native"}
    assert kwargs == {"headless": True, "no_viewport": True}


def test_corpus_headless_uses_context_geometry_and_initial_origin():
    kwargs = {"headless": True}
    applied = apply_headless_geometry(kwargs, None, ["--no-sandbox"])
    expected = headless_geometry(None)
    assert kwargs == {"headless": True, **expected}
    assert initial_window_args(["--no-sandbox"], applied) == [
        "--no-sandbox", "--window-position=0,0"]


@pytest.mark.parametrize("flag", [
    "--window-position=31,47", "--window-size=1111,777", "--start-maximized",
])
def test_explicit_caller_window_geometry_suppresses_default_origin(flag):
    applied = apply_headless_geometry({}, None, [flag])
    assert initial_window_args([flag], applied) == [flag]


@pytest.mark.parametrize("explicit", [
    {"viewport": {"width": 800, "height": 600}},
    {"viewport": None},
    {"no_viewport": True},
    {"screen": {"width": 1024, "height": 768}},
])
def test_explicit_context_geometry_wins(explicit):
    kwargs = {"headless": True, **explicit}
    assert apply_headless_geometry(kwargs, "seed", ["--fingerprint=seed"]) is None
    assert kwargs == {"headless": True, **explicit}


def _fake_exe(tmp_path):
    exe = tmp_path / "fake-chrome"
    exe.write_bytes(b"ant0-browser-capabilities/persona-profile-v1")
    return str(exe)


class _Capture:
    def __init__(self):
        self.kwargs = None
        self.cdp_calls = 0

    def install(self, monkeypatch):
        capture = self

        class Page:
            class Context:
                def new_cdp_session(self, _page):
                    capture.cdp_calls += 1
                    raise AssertionError("geometry must not open a CDP session")

            context = Context()

        class Context:
            pages = [Page()]

            def on(self, *_args, **_kwargs):
                pass

            def new_page(self, **kwargs):
                page = Page()
                page.kwargs = kwargs
                return page

        class Chromium:
            def launch_persistent_context(self, _user_data_dir, **kwargs):
                capture.kwargs = kwargs
                return Context()

        class Playwright:
            chromium = Chromium()

        monkeypatch.setattr(ant0browser, "_playwright", lambda: Playwright())
        monkeypatch.setattr(ant0browser, "install_humanize_on_context", lambda *_a, **_k: None)
        return self


@pytest.mark.parametrize("launch_kwargs", [
    {},
    {"identity": {"mode": "native"}},
    {"overrides": {"avail_width": 1600, "avail_height": 860}},
])
def test_native_geometry_launches_without_post_launch_cdp(monkeypatch, tmp_path, launch_kwargs):
    capture = _Capture().install(monkeypatch)
    ant0browser.launch_persistent_context(
        str(tmp_path / "profile"), executable_path=_fake_exe(tmp_path), quiet=True,
        **launch_kwargs)
    assert capture.kwargs["no_viewport"] is True
    assert capture.cdp_calls == 0


def test_seedless_launch_adds_origin_but_preserves_explicit_window_geometry(monkeypatch, tmp_path):
    capture = _Capture().install(monkeypatch)
    ant0browser.launch_persistent_context(
        str(tmp_path / "profile"), executable_path=_fake_exe(tmp_path), quiet=True,
        args=["--window-position=31,47", "--window-size=1111,777"])
    assert "--window-position=0,0" not in capture.kwargs["args"]
    assert "--window-position=31,47" in capture.kwargs["args"]
    assert "--window-size=1111,777" in capture.kwargs["args"]
    assert capture.cdp_calls == 0


def test_default_seed_constant():
    assert _DEFAULT_HEADLESS_GEOMETRY_SEED == "ant0-headless-geometry"


def test_seedless_uses_default_seed_string():
    assert headless_geometry(None) == headless_geometry(_DEFAULT_HEADLESS_GEOMETRY_SEED)
    assert headless_geometry("") == headless_geometry(_DEFAULT_HEADLESS_GEOMETRY_SEED)
    assert _hash_point(None) == _hash_point(_DEFAULT_HEADLESS_GEOMETRY_SEED)


def test_default_geometry_pinned():
    assert _hash_point(None) == 8
    assert headless_geometry() == {
        "screen": {"width": 1920, "height": 1080},
        "viewport": {
            "width": 1920 - ENGINE_FRAME_WIDTH,
            "height": 1080 - ENGINE_FRAME_HEIGHT,
        },
    }
