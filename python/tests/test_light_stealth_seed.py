"""The default light-stealth seed string is ant0-light-stealth (parity with the Node SDK)."""

from ant0browser._fingerprint import _light_stealth_values


def test_seedless_uses_default_seed_string():
    assert _light_stealth_values(None) == _light_stealth_values("ant0-light-stealth")
    assert _light_stealth_values("") == _light_stealth_values("ant0-light-stealth")


def test_default_persona_pinned():
    assert _light_stealth_values(None) == {
        "device_pixel_ratio": 1.0, "color_depth": 24, "device_memory": 8,
        "hardware_concurrency": 4, "max_touch_points": 0, "brand": "chrome",
    }
