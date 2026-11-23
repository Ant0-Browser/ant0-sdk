"""persona_profile.py is also loaded by file path (no package) by path."""

import importlib.util
from pathlib import Path

import ant0browser
from ant0browser import persona_profile as packaged

PATH = Path(packaged.__file__)


def _load_standalone():
    spec = importlib.util.spec_from_file_location("standalone_persona_profile", PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_loads_outside_the_package_with_the_same_error_contract():
    standalone = _load_standalone()
    try:
        standalone.validate_persona_profile({})
    except standalone.PersonaProfileValidationError as error:
        assert isinstance(error, ValueError)
        assert error.code == "sdk.persona_profile_invalid"
        assert error.error_class == "expected"
        assert error.report_fields() == {"code": "sdk.persona_profile_invalid", "class": "expected"}
    else:
        raise AssertionError("empty profile must be rejected")


def test_package_import_still_uses_the_package_error_module():
    assert packaged.PersonaProfileValidationError is ant0browser.PersonaProfileValidationError
    assert issubclass(packaged.PersonaProfileValidationError, ant0browser._errors.Coded)
