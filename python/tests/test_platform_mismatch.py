"""A platform override that contradicts the persona's OS is refused (parity with the Node SDK)."""

import json
from pathlib import Path

import pytest

from ant0browser import prepare_identity_options
from ant0browser._errors import SdkValueError
from ant0browser._fingerprint import FINGERPRINT_KEYS

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"


def v2(os_family="windows"):
    # A schema 2 persona is always a Windows one (the validator pins compatibility.os_family to "windows").
    return json.loads((FIXTURES / "persona-v2.json").read_text(encoding="utf-8"))


def v4(os_family="windows"):
    """A small synthetic schema 4 persona (same shape as test_persona_v4_canvas.py)."""
    return {
        "schema_version": 4, "schema_revision": 1, "requires": ["display", "input"],
        "provenance": {"source": "synthetic",
                       "model": {"version": "population-model-v2.2", "sha256": "0" * 64}},
        "identity": {
            "os": {"family": os_family, "release": "windows-11", "platform_version": "19.0.0",
                   "architecture": "x86_64"},
            "engine": {"family": "blink", "major": 158},
            "brand": {"id": "edge", "version": "158.0.4370.16"},
            "form_factor": "desktop", "device_model": "",
        },
        "surfaces": {"display": {"width": 1920}},
    }


def prep(source, platform=None):
    options = {"identity": {"mode": "captured", "source": source}, "quiet": True}
    if platform is not None:
        options["overrides"] = {"platform": platform}
    return prepare_identity_options(options, FINGERPRINT_KEYS)[1]


@pytest.mark.parametrize("make", [v2, v4], ids=["schema2", "schema4"])
class TestPersonaOs:
    def test_mismatch_raises_typed_actionable_error(self, make):
        with pytest.raises(SdkValueError) as info:
            prep(make("windows"), "linux")
        assert info.value.code == "sdk.identity_platform_mismatch"
        assert "Drop the platform override or use a persona of the linux OS" in str(info.value)

    def test_match_passes_case_insensitively(self, make):
        assert prep(make("windows"), "windows")["platform"] == "windows"
        prep(make("windows"), "Windows")

    def test_no_override_passes(self, make):
        prep(make("windows"))


def test_a_schema4_persona_of_another_os_accepts_its_own_platform():
    assert prep(v4("linux"), "linux")["platform"] == "linux"
    with pytest.raises(SdkValueError):
        prep(v4("macos"), "linux")


def test_matching_platform_still_keeps_windows_voices():
    voices = prep(v2(), "windows")["fingerprint_profile"]["speech"]["voices"]
    assert voices
    assert any("Example Voice" in v["name"] for v in voices)


@pytest.mark.parametrize("platform", ["linux", "windows", "macos"])
def test_no_persona_passes_any_platform(platform):
    prepare_identity_options(
        {"identity": {"mode": "native"}, "overrides": {"platform": platform}, "quiet": True}, FINGERPRINT_KEYS)


def test_persona_without_an_os_passes():
    p = v4()
    p["identity"]["os"]["family"] = ""
    prep(p, "linux")
