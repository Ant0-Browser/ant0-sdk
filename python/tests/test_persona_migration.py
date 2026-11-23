"""Persona migration across a Chromium engine upgrade.

The contract under test ("profiles keep their machine"): an engine
upgrade rewrites only the browser-version fields and leaves the simulated machine identical.
"""

import copy
import json
from pathlib import Path

from ant0browser.chromium_version import CHROMIUM_MAJOR

# The pinned engine major and an older one a stored persona may still declare.
NEW_MAJOR = CHROMIUM_MAJOR
OLD_MAJOR = CHROMIUM_MAJOR - 1

import pytest

from ant0browser import (
    MIGRATED_FIELDS,
    PersonaMigrationError,
    migrate_persona_browser_major,
    needs_migration,
    persona_browser_major,
    validate_persona_profile,
)
from ant0browser.chromium_version import CHROMIUM_MAJOR

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"


def profile():
    return json.loads((FIXTURES / "persona-v2.json").read_text(encoding="utf-8"))


def test_migrated_fields_is_exactly_the_browser_major():
    assert MIGRATED_FIELDS == ("compatibility.browser_major",)


def test_migration_keeps_the_machine_byte_identical():
    """Every field except the one migrated field must survive unchanged."""
    old = profile()
    old["compatibility"]["browser_major"] = OLD_MAJOR

    migrated = migrate_persona_browser_major(old, NEW_MAJOR)

    assert migrated["compatibility"]["browser_major"] == NEW_MAJOR
    # Mask the one permitted change; everything else must be byte-identical.
    a, b = copy.deepcopy(old), copy.deepcopy(migrated)
    a["compatibility"].pop("browser_major")
    b["compatibility"].pop("browser_major")
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    # Spot-check the identity-bearing groups a user would notice changing.
    for group in ("hardware", "display", "locale", "graphics", "audio", "fonts", "speech", "media"):
        assert migrated[group] == old[group]


def test_migration_does_not_mutate_its_input():
    old = profile()
    old["compatibility"]["browser_major"] = OLD_MAJOR
    snapshot = copy.deepcopy(old)
    migrate_persona_browser_major(old, NEW_MAJOR)
    assert old == snapshot


def test_migration_is_deterministic_and_idempotent():
    old = profile()
    old["compatibility"]["browser_major"] = OLD_MAJOR
    once = migrate_persona_browser_major(old, NEW_MAJOR)
    again = migrate_persona_browser_major(old, NEW_MAJOR)
    assert once == again
    assert migrate_persona_browser_major(once, NEW_MAJOR) == once


def test_migration_to_the_same_major_is_a_no_op():
    old = profile()
    assert migrate_persona_browser_major(old, old["compatibility"]["browser_major"]) == old


def test_old_persona_loads_unchanged():
    """browser_major is informational: an old persona is valid as is, and after migration."""
    old = profile()
    old["compatibility"]["browser_major"] = OLD_MAJOR
    validate_persona_profile(old)
    validate_persona_profile(migrate_persona_browser_major(old))


def test_default_target_is_the_pinned_engine():
    old = profile()
    old["compatibility"]["browser_major"] = OLD_MAJOR
    assert migrate_persona_browser_major(old)["compatibility"]["browser_major"] == CHROMIUM_MAJOR


def test_needs_migration_tracks_the_pin():
    old = profile()
    old["compatibility"]["browser_major"] = OLD_MAJOR
    assert needs_migration(old) is True
    assert needs_migration(migrate_persona_browser_major(old)) is False


def test_persona_browser_major_reads_the_declared_major():
    assert persona_browser_major(profile()) == CHROMIUM_MAJOR
    assert persona_browser_major({}) is None
    assert persona_browser_major({"compatibility": {}}) is None
    assert persona_browser_major(None) is None
    # bool is an int subclass in Python; it must not be mistaken for a major.
    assert persona_browser_major({"compatibility": {"browser_major": True}}) is None


def test_malformed_profile_is_refused_rather_than_invented():
    with pytest.raises(PersonaMigrationError):
        migrate_persona_browser_major({"compatibility": {}})
    with pytest.raises(PersonaMigrationError):
        migrate_persona_browser_major({})


@pytest.mark.parametrize("bad", [0, 99, 1000, "154", 154.0, True, None.__class__])
def test_implausible_target_major_is_refused(bad):
    old = profile()
    with pytest.raises(PersonaMigrationError):
        migrate_persona_browser_major(old, bad)
