"""The engine's fail-closed persona file (exit code 91) surfaces as ``sdk.persona_file_rejected``."""

import stat
import sys

import pytest

import ant0browser
from ant0browser import _serve
from ant0browser._launch_ticket import LaunchTicketRejectedError, reraise_if_ticket_rejected
from ant0browser._persona_rejected import (
    PERSONA_FILE_EXIT_CODE, PersonaFileRejectedError, persona_file_rejection, sanitize_reason,
)

MARKER = "ant0-browser-capabilities/persona-profile-v1"
FATAL = "fatal: --fingerprint-profile-file: "


def test_the_fatal_line_is_found_at_line_start_and_behind_playwrights_prefix():
    assert persona_file_rejection(f"noise\n{FATAL}base64 decoding failed\nmore") == "base64 decoding failed"
    assert persona_file_rejection(f"[pid=123][err] {FATAL}the path must be absolute") == "the path must be absolute"
    assert persona_file_rejection(f"x {FATAL}not at the start of a line") is None
    assert persona_file_rejection("nothing") is None and persona_file_rejection(None) is None


def test_the_exit_code_alone_is_enough_and_the_reason_is_unspecified():
    assert persona_file_rejection("", 91) == "unspecified"
    assert persona_file_rejection("", 1) is None and PERSONA_FILE_EXIT_CODE == 91


def test_the_reason_is_printable_ascii_and_at_most_200_characters():
    assert sanitize_reason("café\x00 \x1b[31mred\x7f\ttab") == "caf [31mredtab"
    assert len(sanitize_reason("a" * 500)) == 200
    assert len(PersonaFileRejectedError("b" * 500).reason) == 200
    assert PersonaFileRejectedError("éè").reason == "unspecified"
    assert persona_file_rejection(FATAL + "x" * 300) == "x" * 200


def test_playwrights_failure_is_re_raised_by_exit_code_and_line():
    text = f"Failed to launch\n<process did exit: exitCode=91, signal=null>\n[pid=7][err] {FATAL}schema_version: unsupported"
    with pytest.raises(PersonaFileRejectedError) as info:
        reraise_if_ticket_rejected(RuntimeError(text))
    assert info.value.reason == "schema_version: unsupported"
    assert info.value.code == "sdk.persona_file_rejected" and info.value.report_fields()["class"] == "expected"
    with pytest.raises(PersonaFileRejectedError) as info:
        reraise_if_ticket_rejected(RuntimeError("Failed\n<process did exit: exitCode=91, signal=null>"))
    assert info.value.reason == "unspecified"


def test_exit_code_90_stays_the_launch_ticket_error():
    with pytest.raises(LaunchTicketRejectedError) as info:
        reraise_if_ticket_rejected(RuntimeError("Failed\n<process did exit: exitCode=90, signal=null>"))
    assert info.value.reason == "missing"
    with pytest.raises(LaunchTicketRejectedError) as info:
        reraise_if_ticket_rejected(RuntimeError("<process did exit: exitCode=90, signal=null>\nant0: launch ticket invalid (past_grace)"))
    assert info.value.reason == "past_grace"
    with pytest.raises(RuntimeError, match="unrelated"):
        reraise_if_ticket_rejected(RuntimeError("unrelated <process did exit: exitCode=1, signal=null>"))


def test_a_persistent_launch_maps_playwrights_error(monkeypatch, tmp_path):
    exe = tmp_path / "chrome"
    exe.write_bytes(MARKER.encode())

    class _Chromium:
        def launch_persistent_context(self, *_a, **_k):
            raise RuntimeError(f"Browser process exited\n<process did exit: exitCode=91, signal=null>\n[pid=1][err] {FATAL}requires.8: capability is not implemented\n")

    class _PW:
        chromium = _Chromium()

    monkeypatch.setattr(ant0browser, "_playwright", lambda: _PW())
    with pytest.raises(PersonaFileRejectedError) as info:
        ant0browser.launch_persistent_context(str(tmp_path / "udd"), executable_path=str(exe),
                                              identity={"mode": "native"}, quiet=True, launch_ticket=False)
    assert info.value.reason == "requires.8: capability is not implemented"


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
class TestServe:
    def _engine(self, tmp_path, body):
        exe = tmp_path / "chrome"
        exe.write_text(f"#!/bin/sh\n# {MARKER}\n{body}\n")
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
        return str(exe)

    def _serve(self, exe):
        return _serve.serve(executable_path=exe, identity={"mode": "native"}, quiet=True, launch_ticket=False,
                            ready_timeout=5.0)

    def test_exit_91_with_the_line(self, tmp_path):
        exe = self._engine(tmp_path, f"echo '{FATAL}the file cannot be opened' >&2\nexit 91")
        with pytest.raises(PersonaFileRejectedError) as info:
            self._serve(exe)
        assert info.value.reason == "the file cannot be opened"

    def test_running_engine_with_profile_remains_inactive_is_stopped(self, tmp_path):
        import time
        line = "Invalid persona-format-v4; profile remains inactive: bad field"
        exe = self._engine(tmp_path, f"echo '{line}' >&2\nexec sleep 30")
        t0 = time.time()
        with pytest.raises(PersonaFileRejectedError) as info:
            self._serve(exe)
        assert info.value.reason == line
        assert time.time() - t0 < 10  # rejected at once, not after the readiness timeout

    def test_engine_without_the_line_is_not_a_persona_failure(self, tmp_path):
        with pytest.raises(Exception) as info:
            self._serve(self._engine(tmp_path, "echo 'some other notice' >&2\nexit 1"))
        assert not isinstance(info.value, PersonaFileRejectedError)
        assert info.value.code == "sdk.engine_not_ready"

    def test_inactive_line_matching(self):
        from ant0browser._persona_rejected import persona_inactive_reason
        assert persona_inactive_reason("x\nInvalid persona handle; profile remains inactive\n") == "Invalid persona handle; profile remains inactive"
        assert persona_inactive_reason("[1:2:ERROR:p.cc(1)] Invalid persona handle; profile remains inactive\n") is None
        assert persona_inactive_reason("persona-format-v4: 2 optional surface(s) absent\n") is None

    def test_exit_91_without_the_line(self, tmp_path):
        with pytest.raises(PersonaFileRejectedError) as info:
            self._serve(self._engine(tmp_path, "exit 91"))
        assert info.value.reason == "unspecified"

    def test_exit_90_is_still_the_ticket_error(self, tmp_path):
        with pytest.raises(LaunchTicketRejectedError):
            self._serve(self._engine(tmp_path, "echo 'ant0: launch ticket invalid (unknown_kid)' >&2\nexit 90"))
