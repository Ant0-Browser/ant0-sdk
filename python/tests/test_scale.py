"""Persona scale: --force-device-scale-factor, the viewport scale, the window clamp, the removed
canvas_bridge option, and set_content. Mirror of node/test/scale.test.ts + content.test.ts."""
import asyncio

import pytest

from ant0browser import _warnings
from ant0browser._content import set_content, set_content_async
from ant0browser._fingerprint import fingerprint_args, persona_avail, persona_dpr
from ant0browser._scale import (
    clamped_window_size, detect_display_size, parse_display_size, scale_window_args, with_device_scale,
)
from ant0browser.identity import prepare_identity_options


def flag(args):
    return [a for a in args if a.startswith("--force-device-scale-factor=")]


def test_explicit_dpr_emits_the_flag():
    assert flag(fingerprint_args({"fingerprint": "s", "device_pixel_ratio": 1.5})) == ["--force-device-scale-factor=1.5"]
    assert flag(fingerprint_args({"fingerprint": "s", "device_pixel_ratio": 2})) == ["--force-device-scale-factor=2"]


def test_no_known_dpr_no_flag():
    assert flag(fingerprint_args({"fingerprint": "s"})) == []
    assert persona_dpr({"fingerprint": "s"}) is None
    assert persona_dpr({"device_pixel_ratio": 0}) is None
    assert persona_dpr({"device_pixel_ratio": True}) is None


def test_profile_display_supplies_dpr_and_avail():
    prof = {"schema_version": 2, "display": {"device_pixel_ratio": 1.25, "available_width": 1536, "available_height": 824}}
    assert persona_dpr({"fingerprint_profile": prof}) == 1.25
    assert persona_avail({"fingerprint_profile": prof}) == (1536, 824)
    assert persona_avail({"avail_width": 1000, "fingerprint_profile": prof}) == (1000, 824)
    assert persona_avail({}) == (None, None)


def test_with_device_scale():
    vp = {"width": 800, "height": 600}
    assert with_device_scale({"viewport": vp}, 1.5) == {"viewport": vp, "device_scale_factor": 1.5}
    assert with_device_scale({"viewport": vp, "device_scale_factor": 3}, 1.5)["device_scale_factor"] == 3
    assert with_device_scale({"no_viewport": True}, 1.5) == {"no_viewport": True}
    assert with_device_scale({"viewport": vp}, None) == {"viewport": vp}
    src = {"viewport": vp}
    with_device_scale(src, 2)
    assert src == {"viewport": vp}


def test_clamp_and_scale_window_args():
    assert clamped_window_size(1.5, (1920, 1080), (1920, 1080)) == (1280, 720)
    assert clamped_window_size(1.5, (1920, 1080), (1000, 600)) is None
    assert clamped_window_size(1, (1920, 1080), (3000, 2000)) is None
    assert clamped_window_size(2, None, (1920, 1080)) is None
    disp = (1920, 1080)
    out = scale_window_args(["--x"], 1.5, True, (1920, 1080), (), disp)
    assert out == ["--x", "--window-size=1280,720"]
    # SDK's own size (Android) is clamped, not duplicated
    out = scale_window_args(["--window-size=412,915"], 3, True, None, (), (1000, 800))
    assert out == ["--window-size=333,266"]
    # headless, no dpr, or caller sizing: untouched
    assert scale_window_args(["--x"], 1.5, False, (1920, 1080), (), disp) == ["--x"]
    assert scale_window_args(["--x"], None, True, (1920, 1080), (), disp) == ["--x"]
    assert scale_window_args(["--x"], 1.5, True, (1920, 1080), ["--window-size=800,600"], disp) == ["--x"]
    assert scale_window_args(["--x"], 1.5, True, (1920, 1080), ["--start-maximized"], disp) == ["--x"]


def test_display_detection(monkeypatch):
    assert parse_display_size("Screen 0: minimum 8 x 8, current 2560 x 1440, maximum 32767 x 32767") == (2560, 1440)
    assert parse_display_size("  dimensions:    1920x1080 pixels (508x285 millimeters)") == (1920, 1080)
    assert parse_display_size("nothing") is None
    monkeypatch.setenv("ANT0_DISPLAY_SIZE", "1366x768")
    assert detect_display_size("win32") == (1366, 768)
    monkeypatch.setenv("ANT0_DISPLAY_SIZE", "junk")
    monkeypatch.delenv("DISPLAY", raising=False)
    assert detect_display_size("linux") is None


def test_canvas_bridge_is_dropped_with_one_note(capsys, monkeypatch):
    monkeypatch.delenv("ANT0_BROWSER_NO_WARN", raising=False)
    _warnings.reset_canvas_bridge_note()
    src = {"canvas_bridge": {"url": "ws://h:1"}, "args": ["--canvas-bridge-url=x", "--keep"], "overrides": {"canvas_bridge": 1}}
    for _ in range(2):
        try:
            prepare_identity_options(src, ())
        except Exception:  # noqa: BLE001 -- only the drop matters here
            pass
    assert "canvas_bridge" in src and src["args"][0] == "--canvas-bridge-url=x"  # input untouched
    err = capsys.readouterr().err
    assert err.count("canvas_bridge was removed") == 1
    _warnings.reset_canvas_bridge_note()
    _warnings.warn_canvas_bridge_removed(quiet=True)
    assert capsys.readouterr().err == ""
    _warnings.reset_canvas_bridge_note()


class FakePage:
    def __init__(self):
        self.calls = []

    def evaluate(self, js, arg=None):
        self.calls.append(("evaluate", arg))

    def wait_for_load_state(self, state, **kw):
        self.calls.append(("wait", state, kw))


class FakeAsyncPage:
    def __init__(self, delay=0):
        self.calls, self.delay = [], delay

    async def evaluate(self, js, arg=None):
        await asyncio.sleep(self.delay)
        self.calls.append(("evaluate", arg))

    async def wait_for_load_state(self, state, **kw):
        self.calls.append(("wait", state, kw))


def test_set_content_writes_document():
    p = FakePage()
    set_content(p, "<p>x</p>")
    assert p.calls == [("evaluate", {"html": "<p>x</p>", "until": "load"})]
    p = FakePage()
    set_content(p, "<p>x</p>", wait_until="networkidle", timeout=500)
    assert p.calls[0][1]["until"] == "load" and p.calls[1] == ("wait", "networkidle", {"timeout": 500})
    with pytest.raises(ValueError):
        set_content(FakePage(), "x", wait_until="bogus")


def test_set_content_async_and_timeout():
    p = FakeAsyncPage()
    asyncio.run(set_content_async(p, "<b>y</b>", wait_until="domcontentloaded"))
    assert p.calls == [("evaluate", {"html": "<b>y</b>", "until": "domcontentloaded"})]
    with pytest.raises(TimeoutError):
        asyncio.run(set_content_async(FakeAsyncPage(delay=1), "x", timeout=20))
