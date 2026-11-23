import copy
import json
import os
import stat
from pathlib import Path

import pytest

from ant0browser import (
    IdentityPersistenceError,
    create_or_load_identity,
    identity_filename,
    load_or_create_device_key,
    load_persisted_identity,
    resolve_identity_directory,
    validate_persisted_identity,
)


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def templates(ids=("desktop-a", "laptop-b", "workstation-c")):
    profile = fixture("persona-v2.json")
    result = []
    for template_id in ids:
        item = copy.deepcopy(profile)
        item["metadata"]["generator"]["model_version"] = template_id
        result.append({"id": template_id, "profile": item})
    return result


def test_shared_filename_vectors_hide_identity_keys():
    vectors = fixture("identity-persistence-v1.json")
    key = bytes.fromhex(vectors["device_key_hex"])
    for vector in vectors["vectors"]:
        assert identity_filename(vector["identity_key"], key) == vector["filename"]
        if vector["identity_key"]:
            assert vector["identity_key"] not in vector["filename"]


def test_directory_override_and_default(monkeypatch, tmp_path):
    monkeypatch.setenv("ANT0_BROWSER_IDENTITY_DIR", str(tmp_path / "override"))
    assert resolve_identity_directory() == tmp_path / "override"
    monkeypatch.delenv("ANT0_BROWSER_IDENTITY_DIR")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert resolve_identity_directory() == tmp_path / ".ant0-browser" / "identities"


def test_device_key_is_stable_private_and_exact(tmp_path):
    first = load_or_create_device_key(tmp_path)
    second = load_or_create_device_key(tmp_path)
    assert first == second
    assert len(first) == 32
    if os.name == "posix":
        assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700
        assert stat.S_IMODE((tmp_path / "device.key").stat().st_mode) == 0o600


def test_corrupt_device_key_is_rejected(tmp_path):
    (tmp_path / "device.key").write_bytes(b"short")
    with pytest.raises(IdentityPersistenceError, match="exactly 32 bytes"):
        create_or_load_identity("identity", templates(), tmp_path)


def test_create_serializes_shared_shape_and_reuses_after_pool_change(tmp_path):
    created = create_or_load_identity("account-42", templates(), tmp_path)
    key = (tmp_path / "device.key").read_bytes()
    path = tmp_path / identity_filename("account-42", key)
    encoded = path.read_text(encoding="utf-8")
    stored = json.loads(encoded)
    vectors = fixture("identity-persistence-v1.json")
    assert list(stored) == sorted(vectors["wrapper_fields"])
    assert stored == created
    assert "account-42" not in encoded
    assert created["schema_version"] == vectors["wrapper_schema_version"]
    assert created["template_selection_algorithm"] == vectors["template_selection_algorithm"]
    assert create_or_load_identity("account-42", [], tmp_path) == created
    assert load_persisted_identity("account-42", tmp_path) == created
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_existing_valid_file_is_authoritative(tmp_path):
    load_or_create_device_key(tmp_path)
    winner = create_or_load_identity("shared", templates(("desktop-a",)), tmp_path)
    loaded = create_or_load_identity("shared", templates(("workstation-c",)), tmp_path)
    assert loaded == winner
    assert loaded["template_id"] == "desktop-a"


@pytest.mark.parametrize("mutation", ["json", "version", "profile", "unknown"])
def test_corrupt_identity_is_rejected(tmp_path, mutation):
    create_or_load_identity("broken", templates(), tmp_path)
    key = (tmp_path / "device.key").read_bytes()
    path = tmp_path / identity_filename("broken", key)
    value = json.loads(path.read_text(encoding="utf-8"))
    if mutation == "json":
        path.write_text("{", encoding="utf-8")
    else:
        if mutation == "version":
            value["schema_version"] = 2
        elif mutation == "profile":
            value["profile"]["schema_version"] = 1
        else:
            value["identity_key"] = "broken"
        path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(IdentityPersistenceError):
        create_or_load_identity("broken", templates(), tmp_path)


def test_validation_returns_complete_wrapper_copy_safe_input():
    value = {
        "schema_version": 1,
        "template_selection_algorithm": "ant0/persona-template-selection/v1",
        "template_id": "desktop-a",
        "created_at": "2026-08-24T12:34:56Z",
        "profile": templates(("desktop-a",))[0]["profile"],
    }
    assert validate_persisted_identity(value) is value
