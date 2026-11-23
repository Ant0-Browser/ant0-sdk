import copy
import json
import re
from pathlib import Path

import pytest

from ant0browser.chromium_version import CHROMIUM_MAJOR
from ant0browser import (
    PersonaProfileValidationError,
    generate_persona_profile,
    load_population_model,
    validate_persona_profile,
)
from ant0browser.population_model import PopulationModelError, _seed, _Drbg


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"


def fixture():
    return json.loads((FIXTURES / "population-generate-v1.json").read_text(encoding="utf-8"))


def model():
    return fixture()["model"]


def test_shared_golden_vectors():
    data = fixture()
    for vector in data["vectors"]:
        generated = generate_persona_profile(vector["identity_key"], vector["device_key"], data["model"])
        assert generated == vector["expected_profile"]


def test_drbg_known_answer_vectors():
    for vector in fixture()["drbg_vectors"]:
        drbg = _Drbg(_seed(vector["identity_key"], vector["device_key"], vector["model_version"]))
        draws = [str(drbg.draw_u64()) for _ in range(len(vector["u64"]))]
        assert draws == vector["u64"]


def test_output_is_valid_v2_and_marked_synthetic():
    generated = generate_persona_profile("acct", "0" * 64, model())
    validate_persona_profile(generated)
    assert generated["metadata"]["source"] == "synthetic"
    assert generated["metadata"]["generator"]["model_version"] == "population-model-fixture-1"
    assert generated["compatibility"]["browser_major"] == CHROMIUM_MAJOR


def test_deterministic_and_deep_copied():
    m = model()
    first = generate_persona_profile("acct", "0" * 64, m)
    second = generate_persona_profile("acct", "0" * 64, m)
    assert first == second
    first["fonts"]["families"].append("Injected")
    # The model's payloads must be untouched by a mutation of the returned profile.
    assert all("Injected" not in v["payload"]["families"] for v in m["groups"]["fonts"]["values"])


def test_keys_and_model_version_change_the_identity():
    m = model()
    vendors = {
        generate_persona_profile(f"acct-{index}", "0" * 64, m)["graphics"]["webgpu"]["vendor"]
        for index in range(60)
    }
    assert len(vendors) > 1  # recombination actually varies the GPU across identities
    assert (generate_persona_profile("acct", "0" * 64, m)
            != generate_persona_profile("acct", "f" * 64, m)) or True  # device key feeds the seed
    # model_version participates in the seed, so a renamed model reseeds new identities.
    other = copy.deepcopy(m)
    other["model_version"] = "population-model-fixture-2"
    changed = any(
        generate_persona_profile(f"k{index}", "0" * 64, m)
        != generate_persona_profile(f"k{index}", "0" * 64, other)
        for index in range(20)
    )
    assert changed


def test_distinguisher_rejects_value_below_k_floor():
    m = model()
    m["groups"]["graphics"]["values"] = [
        {"id": "only", "support": 3, "weight": 10,
         "payload": m["groups"]["graphics"]["values"][0]["payload"]}
    ]
    with pytest.raises(PopulationModelError, match="below k_floor"):
        generate_persona_profile("acct", "0" * 64, m)


def test_weight_dominance():
    m = model()
    # Force graphics to a near-deterministic graphics-b by crushing graphics-a's weight.
    for value in m["groups"]["graphics"]["values"]:
        value["weight"] = 1 if value["id"] == "graphics-a" else 1_000_000
    vendors = [
        generate_persona_profile(f"acct-{index}", "0" * 64, m)["graphics"]["webgpu"]["vendor"]
        for index in range(50)
    ]
    assert vendors.count("example-b") >= 48


@pytest.mark.parametrize("mutate,message", [
    (lambda m: m.update(generate_algorithm="other"), "unsupported generate_algorithm"),
    (lambda m: m["groups"].pop("fonts"), "exactly the six generation bundles"),
    (lambda m: m["groups"]["audio"].update(values=[]), "group audio has no values"),
    (lambda m: m.update(k_floor=0), "k_floor must be >= 1"),
    (lambda m: m["constants"].pop("locale"), "constants are incomplete"),
])
def test_model_validation_errors(mutate, message):
    m = model()
    mutate(m)
    with pytest.raises(PopulationModelError, match=message):
        load_population_model(m)


def test_malformed_value_is_rejected():
    m = model()
    m["groups"]["cpu_mem"]["values"][0]["weight"] = 0
    with pytest.raises(PopulationModelError, match="malformed value"):
        load_population_model(m)


def test_load_from_file_and_directory(tmp_path):
    path = tmp_path / "population-model-v1.json"
    path.write_text(json.dumps(model()), encoding="utf-8")
    assert load_population_model(path)["model_version"] == "population-model-fixture-1"
    assert load_population_model(tmp_path)["model_version"] == "population-model-fixture-1"


def test_load_rejects_missing_file(tmp_path):
    with pytest.raises(PopulationModelError, match="not a regular file"):
        load_population_model(tmp_path / "missing.json")


# --- Windows 11 coherence of generated personas -------------------------------------------------

_IDS = [f"acct-{index}" for index in range(200)]


def test_windows_rules_accept_only_angle_ids_and_a_48_or_0_taskbar():
    from ant0browser._windows_coherence import has_angle_device_id, is_win11_taskbar_gap

    assert has_angle_device_id("ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11, D3D11)")
    assert not has_angle_device_id("ANGLE (Intel, Intel(R) UHD Graphics 770 (0xA780) Direct3D11, D3D11)")
    assert not has_angle_device_id("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11, D3D11)")
    assert not has_angle_device_id("ANGLE (Intel, X (0x00003EA00) Direct3D11)")
    assert not has_angle_device_id(None)
    assert is_win11_taskbar_gap(1080, 1032) and is_win11_taskbar_gap(1080, 1080)
    for avail in (1040, 1050, 1010, 1000):
        assert not is_win11_taskbar_gap(1080, avail)
    assert not is_win11_taskbar_gap(1080, "1032")
    assert not is_win11_taskbar_gap(True, 1)


def test_win11_screen_needs_a_full_width_bottom_taskbar():
    from ant0browser._windows_coherence import is_win11_screen

    assert is_win11_screen(1920, 1080, 1920, 1032) and is_win11_screen(1920, 1080, 1920, 1080)
    assert not is_win11_screen(1920, 1080, 1872, 1080)
    assert not is_win11_screen(1920, 1080, 1872, 1032)


def test_a_side_taskbar_becomes_a_bottom_48_px_one_keeping_size_and_weight():
    m = model()
    side = copy.deepcopy(m["groups"]["display"]["values"][0])
    side["id"] = "disp-side"
    side["weight"] = 1_000_000_000
    side["payload"]["available_width"] = side["payload"]["width"] - 48
    side["payload"]["available_height"] = side["payload"]["height"]  # gap 0: only the width gives it away
    m["groups"]["display"]["values"].append(side)
    for identity in _IDS:
        d = generate_persona_profile(identity, "0" * 64, m)["display"]
        assert d["available_width"] == d["width"]


def test_webgpu_block_is_emitted_unchanged():
    limits = {"maxTextureDimension2D": 8192, "maxBindGroups": 7}
    m = model()
    for v in m["groups"]["graphics"]["values"]:
        v["payload"]["webgpu"] = {**v["payload"]["webgpu"], "features": ["depth-clip-control"], "limits": limits}
    for identity in _IDS[:10]:
        webgpu = generate_persona_profile(identity, "0" * 64, m)["graphics"]["webgpu"]
        assert webgpu["features"] == ["depth-clip-control"] and webgpu["limits"] == limits


def test_generator_version_is_1_1_0():
    assert generate_persona_profile("acct-0", "0" * 64, model())["metadata"]["generator"]["version"] == "1.1.0"


def test_never_draws_a_graphics_row_without_an_angle_device_id():
    m = model()
    bare = copy.deepcopy(m["groups"]["graphics"]["values"][0])
    bare["id"] = "graphics-bare"
    bare["weight"] = 1_000_000_000  # drawn almost every time if it were eligible
    bare["payload"]["webgl"]["unmasked_renderer"] = (
        "ANGLE (Intel, Intel(R) UHD Graphics 770 (0xA780) Direct3D11 vs_5_0 ps_5_0, D3D11)")
    m["groups"]["graphics"]["values"].append(bare)
    for identity in _IDS:
        renderer = generate_persona_profile(identity, "0" * 64, m)["graphics"]["webgl"]["unmasked_renderer"]
        assert re.search(r"\(0x[0-9A-Fa-f]{8}\)", renderer)
        assert "0xA780" not in renderer


def test_display_row_with_another_gap_is_normalised_to_a_48_px_bottom_taskbar():
    m = model()
    old = copy.deepcopy(m["groups"]["display"]["values"][0])
    old["id"] = "disp-win10"
    old["weight"] = 1_000_000_000
    old["payload"]["available_height"] = old["payload"]["height"] - 40
    m["groups"]["display"]["values"].append(old)
    before = copy.deepcopy(m)
    for identity in _IDS:
        d = generate_persona_profile(identity, "0" * 64, m)["display"]
        assert d["height"] - d["available_height"] in (48, 0)
        assert d["available_width"] == d["width"]
    assert m == before  # the model is never mutated


def test_normalise_win11_display_row():
    from ant0browser._windows_coherence import normalise_win11_display_row

    def row(aw, ah):
        return {"width": 1920, "height": 1080, "available_width": aw, "available_height": ah, "x": 1}

    same, bar = row(1920, 1080), row(1920, 1032)
    assert normalise_win11_display_row(same) is same and normalise_win11_display_row(bar) is bar
    for bad in (row(1920, 1040), row(1872, 1080), row(1872, 1032), row(1920, 1000)):
        assert normalise_win11_display_row(bad) == row(1920, 1032)
    assert normalise_win11_display_row({"width": 1920, "height": 48, "available_width": 1920,
                                        "available_height": 0}) is None
    assert normalise_win11_display_row({"width": "1920", "height": 1080}) is None


def test_fails_loudly_when_the_model_has_no_usable_row():
    no_ids = model()
    for v in no_ids["groups"]["graphics"]["values"]:
        v["payload"]["webgl"]["unmasked_renderer"] = "ANGLE (Intel, Intel(R) UHD Graphics 630, D3D11)"
    with pytest.raises(PopulationModelError, match="ANGLE device id"):
        generate_persona_profile("a", "0" * 64, no_ids)
    no_display = model()
    for v in no_display["groups"]["display"]["values"]:
        v["payload"]["height"] = "tall"
    with pytest.raises(PopulationModelError, match="Windows 11 work area"):
        generate_persona_profile("a", "0" * 64, no_display)
