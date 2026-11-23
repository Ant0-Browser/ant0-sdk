"""Migrate a persona profile across a Chromium engine upgrade.

An engine upgrade moves **only** the browser-version fields
and keeps the simulated machine identical. A user who upgrades the engine must look like
the same computer running a newer browser -- not like a new computer.

What this rewrites
------------------
``compatibility.browser_major`` -- and nothing else.

That is the complete set, and it is a property of the contract rather than an omission.
``persona-profile-v2`` is a *closed* schema (``additionalProperties: false`` throughout)
and carries no user-agent string, no Sec-CH-UA brand list and no full-version list: the
engine derives all of those at runtime from its own build version (it seeds the brand list from
the Chromium major version). ``browser_major`` is a compatibility assertion --
"this machine description was generated for engine major N" -- not a source of UA text.
Everything that makes the persona a *machine* (hardware, display, locale, graphics, audio,
fonts, speech, media) is version-independent and is preserved byte-for-byte.

Determinism
-----------
The result is a pure function of ``(profile, target_major)``. No randomness, no clock, no
environment. Re-running on an already-migrated profile returns an equal profile
(idempotent), and migrating to the profile's current major is an exact no-op.
"""

import copy

from .chromium_version import CHROMIUM_MAJOR
from ._errors import Coded, EXPECTED


class PersonaMigrationError(Coded, ValueError):
    """The profile cannot be migrated (wrong shape, or a refused target major)."""

    code = "sdk.persona_migration_refused"
    error_class = EXPECTED


#: Fields this migration is permitted to rewrite. Anything outside this set must come out
#: byte-identical; :func:`migrate_persona_browser_major` asserts that before returning.
MIGRATED_FIELDS = ("compatibility.browser_major",)


def _target(target_major):
    if target_major is None:
        return CHROMIUM_MAJOR
    if type(target_major) is not int or type(target_major) is bool:
        raise PersonaMigrationError("target_major must be an integer")
    if not 100 <= target_major <= 999:
        raise PersonaMigrationError(
            "target_major {} is not a plausible Chromium major".format(target_major)
        )
    return target_major


def persona_browser_major(profile):
    """The major a profile declares, or ``None`` when it does not declare one."""
    if type(profile) is not dict:
        return None
    compatibility = profile.get("compatibility")
    if type(compatibility) is not dict:
        return None
    major = compatibility.get("browser_major")
    return major if type(major) is int and type(major) is not bool else None


def needs_migration(profile, target_major=None):
    """True when *profile* targets a different major than the engine (default: the pin)."""
    current = persona_browser_major(profile)
    return current is not None and current != _target(target_major)


def migrate_persona_browser_major(profile, target_major=None):
    """Return a copy of *profile* valid for *target_major* (default: the pinned engine).

    Only ``compatibility.browser_major`` changes; every other byte is preserved. The input
    is never mutated. Raises :class:`PersonaMigrationError` if the profile does not carry a
    ``compatibility.browser_major`` integer -- that is a malformed profile, not an
    upgradable one, and silently inventing a major would fabricate a machine.
    """
    target = _target(target_major)
    if persona_browser_major(profile) is None:
        raise PersonaMigrationError(
            "profile has no integer compatibility.browser_major to migrate"
        )

    migrated = copy.deepcopy(profile)
    migrated["compatibility"]["browser_major"] = target

    # Prove the "keep the machine" guarantee rather than trusting it: with the one migrated
    # field masked out, the two profiles must be identical. This catches any future edit to
    # this function that starts touching the machine description.
    before, after = copy.deepcopy(profile), copy.deepcopy(migrated)
    before["compatibility"].pop("browser_major", None)
    after["compatibility"].pop("browser_major", None)
    if before != after:
        raise PersonaMigrationError(
            "migration altered a field outside {}".format(", ".join(MIGRATED_FIELDS))
        )
    return migrated
