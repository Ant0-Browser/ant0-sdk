import copy
import json
from pathlib import Path

import pytest

from ant0browser.chromium_version import CHROMIUM_MAJOR
from ant0browser import (
    GENERATED_IDENTITY_WRAPPER_VERSION,
    IdentityPersistenceError,
    create_or_load_generated_identity,
    identity_filename,
    load_persisted_identity,
    resolve_identity,
    validate_persisted_identity,
)


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"


def model():
    return json.loads((FIXTURES / "population-generate-v1.json").read_text(encoding="utf-8"))["model"]


def model_dir(tmp_path):
    directory = tmp_path / "model"
    directory.mkdir(exist_ok=True)
    (directory / "population-model-v1.json").write_text(json.dumps(model()), encoding="utf-8")
    return directory


def test_generated_wrapper_shape_and_reuse(tmp_path):
    identities = tmp_path / "identities"
    created = create_or_load_generated_identity("account-42", model(), identities)
    assert created["schema_version"] == GENERATED_IDENTITY_WRAPPER_VERSION
    assert created["algorithm"] == "ant0/persona-generate/v1"
    assert created["algorithm_ref"] == "population-model-fixture-1"
    assert created["profile"]["metadata"]["source"] == "synthetic"

    key = (identities / "device.key").read_bytes()
    path = identities / identity_filename("account-42", key)
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert set(stored) == {"schema_version", "algorithm", "algorithm_ref", "created_at", "profile"}
    assert "account-42" not in path.read_text(encoding="utf-8")
    # A later model change never mutates an already-created identity.
    other = copy.deepcopy(model())
    other["groups"]["graphics"]["values"] = other["groups"]["graphics"]["values"][:1]
    assert create_or_load_generated_identity("account-42", other, identities) == created
    assert load_persisted_identity("account-42", identities) == created


def test_resolve_identity_uses_model_directory(tmp_path):
    identities = tmp_path / "identities"
    mode, options = resolve_identity({
        "mode": "synthetic", "key": "acct",
        "model_directory": str(model_dir(tmp_path)),
        "identity_directory": str(identities),
    })
    assert mode == "synthetic"
    assert options["fingerprint_profile"]["compatibility"]["browser_major"] == CHROMIUM_MAJOR
    # Persisted and authoritative on the second resolve.
    again, options2 = resolve_identity({
        "mode": "synthetic", "key": "acct",
        "model_directory": str(model_dir(tmp_path)),
        "identity_directory": str(identities),
    })
    assert options2["fingerprint_profile"] == options["fingerprint_profile"]


def test_resolve_identity_uses_env_model_source(tmp_path, monkeypatch):
    monkeypatch.setenv("ANT0_BROWSER_MODEL_SOURCE", str(model_dir(tmp_path)))
    mode, options = resolve_identity({
        "mode": "synthetic", "key": "env-acct",
        "identity_directory": str(tmp_path / "identities"),
    })
    assert mode == "synthetic"
    assert options["fingerprint_profile"]["metadata"]["generator"]["model_version"] \
        == "population-model-fixture-1"


def test_model_directory_takes_precedence_over_template_directory(tmp_path):
    # A model source and a (nonexistent) template dir together must choose the model without error.
    mode, options = resolve_identity({
        "mode": "synthetic", "key": "prec",
        "model_directory": str(model_dir(tmp_path)),
        "template_directory": str(tmp_path / "does-not-exist"),
        "identity_directory": str(tmp_path / "identities"),
    })
    assert options["fingerprint_profile"]["metadata"]["source"] == "synthetic"


def test_new_synthetic_requires_a_source(tmp_path):
    with pytest.raises(ValueError, match="requires model_directory or template_directory"):
        resolve_identity({
            "mode": "synthetic", "key": "nosource",
            "identity_directory": str(tmp_path / "identities"),
        })


def test_validate_accepts_v2_and_rejects_broken_v2(tmp_path):
    created = create_or_load_generated_identity("v", model(), tmp_path / "identities")
    assert validate_persisted_identity(created) is created
    broken = copy.deepcopy(created)
    broken["algorithm"] = "ant0/persona-template-selection/v1"
    with pytest.raises(IdentityPersistenceError, match="unsupported generate algorithm"):
        validate_persisted_identity(broken)
    unsafe_ref = copy.deepcopy(created)
    unsafe_ref["algorithm_ref"] = "../escape"
    with pytest.raises(IdentityPersistenceError, match="algorithm_ref is unsafe"):
        validate_persisted_identity(unsafe_ref)
