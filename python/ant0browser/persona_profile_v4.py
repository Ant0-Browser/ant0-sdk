"""Structural validator for the new persona format (``schema_version`` 4).

Mirrors the cloud's persona validator. Same lenient policy as the
format spec section 3.2: unknown keys are ignored, known fields keep strict type checks. This is a
structural check only; the engine validates the surfaces. A schema 4 persona is never converted to
schema 2 and never travels inline: it goes through ``--fingerprint-profile-file`` (see
``_profile_file.py``).
"""

import re

from ._errors import Coded, EXPECTED


class PersonaV4SchemaError(Coded, ValueError):
    """A schema 4 persona that breaks the structural invariants."""

    code = "sdk.persona_profile_invalid"
    error_class = EXPECTED

    def __init__(self, problems):
        self.problems = list(problems)
        super().__init__(
            "persona violates the new persona format (schema_version 4): " + "; ".join(self.problems))


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def is_persona_v4(value):
    """True for a value that claims to be a schema 4 persona (before any validation)."""
    return isinstance(value, dict) and value.get("schema_version") == 4


def validate_persona_profile_v4(value):
    """Raise ``PersonaV4SchemaError`` unless ``value`` is a structurally valid schema 4 persona."""
    if not isinstance(value, dict):
        raise PersonaV4SchemaError(["<root> must be an object"])
    problems = []
    if value.get("schema_version") != 4 or isinstance(value.get("schema_version"), bool):
        problems.append("schema_version must be 4")
    if not _is_int(value.get("schema_revision")):
        problems.append("schema_revision must be an integer")
    req = value.get("requires")
    if not isinstance(req, list) or not all(isinstance(r, str) for r in req):
        problems.append("requires must be an array of strings")
    elif len(set(req)) != len(req):
        problems.append("requires must not contain duplicates")
    prov = value.get("provenance")
    if not isinstance(prov, dict):
        problems.append("provenance must be an object")
    else:
        if prov.get("source") != "synthetic":
            problems.append("provenance.source must be synthetic")
        model = prov.get("model")
        if not isinstance(model, dict) or not isinstance(model.get("version"), str) \
                or not isinstance(model.get("sha256"), str):
            problems.append("provenance.model must carry version and sha256")
        if "attempt" in prov:
            problems.append("provenance.attempt must not be present")
        # Optional: a document without a key is valid (the engine hashes it). A key that is present must
        # be exactly what the engine's ParseNoiseKey accepts: 16 lowercase hex characters.
        if "noise_key" in prov and not (isinstance(prov["noise_key"], str)
                                        and re.fullmatch(r"[0-9a-f]{16}", prov["noise_key"])):
            problems.append("provenance.noise_key must be 16 lowercase hex characters")
    ident = value.get("identity")
    if not isinstance(ident, dict):
        problems.append("identity must be an object")
    else:
        os_ = ident.get("os")
        if not isinstance(os_, dict) or not isinstance(os_.get("family"), str):
            problems.append("identity.os.family must be a string")
        engine = ident.get("engine")
        if not isinstance(engine, dict) or engine.get("family") != "blink" or not _is_int(engine.get("major")):
            problems.append("identity.engine must be blink with an integer major")
        brand = ident.get("brand")
        if not isinstance(brand, dict) or not isinstance(brand.get("id"), str):
            problems.append("identity.brand.id must be a string")
    if not isinstance(value.get("surfaces"), dict):
        problems.append("surfaces must be an object")
    if problems:
        raise PersonaV4SchemaError(problems)
    return value


__all__ = ["PersonaV4SchemaError", "is_persona_v4", "validate_persona_profile_v4"]
