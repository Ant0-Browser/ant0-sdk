import pytest

import ant0browser
from ant0browser import _errors
from ant0browser._runtime_client import RuntimeError as RuntimeFailure
from ant0browser.identity import resolve_identity

CLASSES = {"defect", "environment", "expected"}


def test_plain_errors_keep_builtin_types_and_carry_a_code():
    with pytest.raises(ValueError) as info:
        resolve_identity({"mode": "nope"})
    err = info.value
    assert isinstance(err, _errors.SdkValueError)
    assert err.code.startswith("sdk.") and err.error_class in CLASSES
    assert err.report_fields() == {"code": err.code, "class": err.error_class}


def test_cause_stays_local():
    cause = OSError("/home/someone/secret")
    err = _errors.SdkRuntimeError("sdk.engine_not_found", "x", cause=cause)
    assert err.cause is cause
    assert "someone" not in str(err.report_fields())
    assert isinstance(err, RuntimeError)


@pytest.mark.parametrize("cls", [
    ant0browser.PersonaProfileValidationError, ant0browser.PersonaMigrationError,
    ant0browser.PopulationModelError, ant0browser.IdentityPersistenceError,
])
def test_existing_error_types_have_class_codes(cls):
    assert cls.code.startswith("sdk.") and cls.error_class in CLASSES
    assert issubclass(cls, ValueError)


def test_runtime_failure_class():
    err = RuntimeFailure("runtime.timeout")
    assert (err.code, err.error_class) == ("runtime.timeout", "environment")
    assert RuntimeFailure("licence.required").error_class == "expected"
    assert RuntimeFailure("runtime.invalid_request").error_class == "defect"


# --- review fixes: pickling, parity, clamp, exports ---
import copy
import glob
import os
import pickle
import re

from ant0browser._launch_ticket import LaunchTicketRejectedError, LaunchTicketUnavailableError


def _samples():
    return [
        _errors.SdkValueError("sdk.identity_invalid", "bad value /x", cause=OSError("local")),
        _errors.SdkTypeError("sdk.identity_invalid", "bad type"),
        _errors.SdkRuntimeError("sdk.engine_not_found", "no engine"),
        ant0browser.ReleaseError("release broke"),
        ant0browser.SignatureError("bad signature"),
        ant0browser.PopulationModelError("model"),
        LaunchTicketRejectedError("missing", "detail"),
        LaunchTicketUnavailableError("licence.required", "sign in"),
        RuntimeFailure("runtime.cancelled"),
    ]


@pytest.mark.parametrize("err", _samples(), ids=lambda e: type(e).__name__)
def test_errors_survive_pickle_copy_and_deepcopy(err):
    for clone in (pickle.loads(pickle.dumps(err)), copy.copy(err), copy.deepcopy(err)):
        assert type(clone) is type(err)
        assert str(clone) == str(err) and clone.args == err.args
        assert clone.code == err.code and clone.error_class == err.error_class
        assert clone.report_fields() == err.report_fields()
    assert pickle.loads(pickle.dumps(err)).cause is None  # the cause is never serialised


def test_launch_ticket_code_is_clamped_for_reports():
    ok = LaunchTicketUnavailableError("licence.required", "m")
    assert ok.report_fields()["code"] == "licence.required"
    assert LaunchTicketUnavailableError("http_503", "m").report_fields()["code"] == "http_503"
    for hostile in ("user@example.com wants /home/x", "x" * 500, "Licence.Required", ""):
        err = LaunchTicketUnavailableError(hostile, "m")
        assert err.report_fields()["code"] == "sdk.launch_ticket_unavailable"
        assert err.code == hostile  # the attribute itself is unchanged


def test_error_classes_are_exported():
    for name in ("SdkValueError", "SdkTypeError", "SdkRuntimeError", "RuntimeClientError",
                 "ReleaseError", "SignatureError", "LaunchTicketUnavailableError"):
        assert name in ant0browser.__all__ and hasattr(ant0browser, name)


def test_python_and_node_code_tables_match():
    root = os.path.dirname(os.path.dirname(os.path.abspath(ant0browser.__file__)))
    node_src = os.path.join(os.path.dirname(root), "node", "src")
    assert os.path.isdir(node_src), node_src
    pat = re.compile(r'"(sdk\.[a-z_]+)"')
    py, nd = set(), set()
    for f in glob.glob(os.path.join(root, "ant0browser", "*.py")):
        py |= set(pat.findall(open(f, encoding="utf-8").read()))
    for f in glob.glob(os.path.join(node_src, "*.ts")):
        nd |= set(pat.findall(open(f, encoding="utf-8").read()))
    assert py - nd == {"sdk.error", "sdk.playwright_missing"}  # Python-only
    assert nd - py == {"sdk.launch_plan_used"}  # Node-only


def test_a_damaged_engine_has_its_own_code_and_a_reinstall_action():
    err = RuntimeFailure("browser.proof_mismatch")
    assert (err.status, err.next_action) == (409, "reinstall_engine")
    assert err.error_class == "environment"
    assert str(err) == "ant0-browser: browser.proof_mismatch; next action: reinstall_engine"
    # A missing engine still asks for an install.
    missing = RuntimeFailure("browser.not_installed")
    assert (missing.status, missing.next_action) == (404, "install_engine")


def test_an_unexpected_engine_file_has_its_own_code_and_a_reinstall_action():
    err = RuntimeFailure("browser.unexpected_file")
    assert (err.status, err.next_action) == (409, "reinstall_engine")
    assert err.error_class == "environment"
    assert str(err) == "ant0-browser: browser.unexpected_file; next action: reinstall_engine"
    # Not a damaged engine, not a missing one.
    assert err.code != RuntimeFailure("browser.proof_mismatch").code
    assert (err.status, err.next_action) != (404, "install_engine")
