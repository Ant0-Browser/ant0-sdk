import copy
import json
from pathlib import Path

import pytest

from ant0browser import PersonaProfileValidationError, validate_persona_profile


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"


@pytest.fixture
def valid_profile():
    return json.loads((FIXTURES / "persona-v2.json").read_text(encoding="utf-8"))


def _apply_case(profile, case):
    target = profile
    parts = case["path"].split(".")
    for part in parts[:-1]:
        target = target[part]
    if case["operation"] == "set":
        target[parts[-1]] = case["value"]
    elif case["operation"] == "append":
        target[parts[-1]].append(case["value"])
    else:
        raise AssertionError(f"unknown fixture operation: {case['operation']}")


def test_committed_valid_fixture(valid_profile):
    assert validate_persona_profile(valid_profile) is valid_profile


@pytest.mark.parametrize(
    "case",
    json.loads((FIXTURES / "invalid-cases.json").read_text(encoding="utf-8")),
    ids=lambda case: case["name"],
)
def test_committed_invalid_fixtures(valid_profile, case):
    profile = copy.deepcopy(valid_profile)
    _apply_case(profile, case)
    with pytest.raises(PersonaProfileValidationError) as caught:
        validate_persona_profile(profile)
    assert caught.value.path == case["expected_path"]
    assert str(caught.value).startswith(case["expected_path"] + ":")


@pytest.mark.parametrize(
    ("path", "value", "expected_path"),
    [
        ("display.available_height", 1200, "display.available_height"),
        ("metadata.created_at", "2026-02-30T00:00:00Z", "metadata.created_at"),
        ("hardware.hardware_concurrency", True, "hardware.hardware_concurrency"),
        ("display.device_pixel_ratio", float("nan"), "display.device_pixel_ratio"),
        ("locale.languages", ["en-US", "en-US"], "locale.languages.1"),
        ("graphics.webgl.webgl1.parameters.MAX_TEXTURE_SIZE", [1], "graphics.webgl.webgl1.parameters.MAX_TEXTURE_SIZE"),
        ("media.devices.0.kind", "printer", "media.devices.0.kind"),
    ],
)
def test_schema_constraints_and_python_type_edges(valid_profile, path, value, expected_path):
    profile = copy.deepcopy(valid_profile)
    target = profile
    parts = path.split(".")
    for part in parts[:-1]:
        target = target[int(part)] if part.isdigit() else target[part]
    target[parts[-1]] = value
    with pytest.raises(PersonaProfileValidationError) as caught:
        validate_persona_profile(profile)
    assert caught.value.path == expected_path


def test_no_default_voice_is_allowed(valid_profile):
    valid_profile["speech"]["voices"][0]["default"] = False
    validate_persona_profile(valid_profile)


def test_json_schema_numeric_enum_accepts_equivalent_float(valid_profile):
    valid_profile["hardware"]["device_memory_gb"] = 8.0
    valid_profile["hardware"]["hardware_concurrency"] = 8.0
    validate_persona_profile(valid_profile)


@pytest.mark.parametrize("mem", [16, 32])
def test_device_memory_gb_accepts_chrome_147_desktop_values(valid_profile, mem):
    """16 and 32 are valid Chrome 147+ desktop values; the old cap of 8 is lifted."""
    valid_profile["hardware"]["device_memory_gb"] = mem
    validate_persona_profile(valid_profile)


def test_webgl_and_webgpu_gpu_families_must_agree(valid_profile):
    valid_profile["graphics"]["webgl"]["unmasked_renderer"] = (
        "ANGLE (Intel, Intel(R) UHD Graphics 770 (0xA780) Direct3D11 vs_5_0 ps_5_0, D3D11)")
    valid_profile["graphics"]["webgpu"]["vendor"] = "nvidia"
    valid_profile["graphics"]["webgpu"]["architecture"] = "ampere"
    with pytest.raises(PersonaProfileValidationError) as caught:
        validate_persona_profile(valid_profile)
    assert caught.value.path == "graphics.webgpu.vendor"


def test_unknown_nested_field_is_addressed(valid_profile):
    valid_profile["media"]["codecs"]["h264"]["extra"] = True
    with pytest.raises(PersonaProfileValidationError) as caught:
        validate_persona_profile(valid_profile)
    assert caught.value.path == "media.codecs.h264.extra"


def test_missing_field_is_addressed(valid_profile):
    del valid_profile["audio"]["sample_rate"]
    with pytest.raises(PersonaProfileValidationError) as caught:
        validate_persona_profile(valid_profile)
    assert caught.value.path == "audio.sample_rate"
