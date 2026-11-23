import copy
import json
from pathlib import Path

import pytest

from ant0browser import PersonaProfileValidationError, select_persona_template


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"


@pytest.fixture
def profile():
    return json.loads((FIXTURES / "persona-v2.json").read_text(encoding="utf-8"))


def templates(profile):
    vectors = json.loads((FIXTURES / "template-selection-v1.json").read_text(encoding="utf-8"))
    result = []
    for template_id in vectors["template_ids"]:
        item = copy.deepcopy(profile)
        item["metadata"]["generator"]["model_version"] = template_id
        result.append({"id": template_id, "profile": item})
    return result


def selected_id(profile):
    return profile["metadata"]["generator"]["model_version"]


def test_shared_golden_vectors(profile):
    fixture = json.loads((FIXTURES / "template-selection-v1.json").read_text(encoding="utf-8"))
    pool = templates(profile)
    for vector in fixture["vectors"]:
        selected = select_persona_template(vector["identity_key"], vector["device_key"], pool)
        assert selected_id(selected) == vector["selected_id"]


def test_order_independence_and_deep_copy(profile):
    pool = templates(profile)
    selected = select_persona_template("identity-0", "device-1", pool)
    assert selected_id(selected) == selected_id(
        select_persona_template("identity-0", "device-1", list(reversed(pool)))
    )
    selected["hardware"]["hardware_concurrency"] = 2
    assert all(item["profile"]["hardware"]["hardware_concurrency"] == 8 for item in pool)


def test_identity_and_device_keys_affect_selection(profile):
    pool = templates(profile)
    assert selected_id(select_persona_template("identity-0", "device-1", pool)) != selected_id(
        select_persona_template("identity-2", "device-1", pool)
    )
    assert selected_id(select_persona_template("alice", "device-1", pool)) != selected_id(
        select_persona_template("alice", "device-6", pool)
    )


def test_rejects_invalid_profiles_even_when_they_would_not_be_selected(profile):
    pool = templates(profile)
    pool[-1]["profile"]["schema_version"] = 1
    with pytest.raises(PersonaProfileValidationError):
        select_persona_template("identity-0", "device-1", pool)


@pytest.mark.parametrize("template_id", ["", ".", "../escape", "has space", "é"])
def test_rejects_unsafe_ids(profile, template_id):
    with pytest.raises(ValueError, match="unsafe template id"):
        select_persona_template("identity", "device", [{"id": template_id, "profile": profile}])


def test_rejects_duplicates_and_empty_pool(profile):
    with pytest.raises(ValueError, match="duplicate template id"):
        select_persona_template("identity", "device", [
            {"id": "same", "profile": profile},
            {"id": "same", "profile": profile},
        ])
    with pytest.raises(ValueError, match="must not be empty"):
        select_persona_template("identity", "device", [])
