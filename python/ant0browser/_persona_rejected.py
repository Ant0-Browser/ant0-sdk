"""The engine refuses a persona file it cannot use (fail-closed).

When ``--fingerprint-profile-file`` names a file that is missing, unreadable or rejected, the browser
process exits with code 91 before any profile directory, window or network activity, after writing one
line to stderr::

    fatal: --fingerprint-profile-file: <reason>

The reason is printable ASCII, at most 200 characters, and never carries a path or profile data. The SDK
raises it as :class:`PersonaFileRejectedError` (``code == "sdk.persona_file_rejected"``). Exit code 90 is
the launch ticket's (see ``_launch_ticket``); Chromium's own codes stay below 43.
"""
import re

from ._errors import Coded, EXPECTED

#: Exit code of an engine that refused its persona file.
PERSONA_FILE_EXIT_CODE = 91
#: Error code carried by :class:`PersonaFileRejectedError`.
PERSONA_FILE_REJECTED_CODE = "sdk.persona_file_rejected"
#: The longest reason the engine prints, and the longest the SDK keeps.
REASON_MAX_LENGTH = 200

# Raw stderr has the line at the start; Playwright quotes it in its message behind a "[pid=N][err] " prefix.
_FATAL_LINE = re.compile(r"(?m)^(?:\[pid=\d+\]\[err\] ?)?fatal: --fingerprint-profile-file: ([^\r\n]*)$")
_EXIT_CODE = re.compile(r"process did exit: exitCode=(\d+)")


def sanitize_reason(text):
    """Printable ASCII only (anything else is dropped), trimmed, at most ``REASON_MAX_LENGTH`` characters."""
    kept = "".join(ch for ch in str(text) if " " <= ch <= "~").strip()
    return kept[:REASON_MAX_LENGTH].rstrip()


class PersonaFileRejectedError(Coded, RuntimeError):
    """The engine exited with code 91: its persona file was missing, unreadable or rejected."""

    code = PERSONA_FILE_REJECTED_CODE
    error_class = EXPECTED

    def __init__(self, reason):
        #: The engine's reason, sanitised (printable ASCII, at most 200 characters).
        self.reason = sanitize_reason(reason) or "unspecified"
        super().__init__(f"ant0-browser: the engine rejected the persona file ({self.reason}).")


def playwright_exit_code(text):
    """The exit code Playwright quotes in a launch failure (``process did exit: exitCode=N``), or None."""
    match = _EXIT_CODE.search(str(text or ""))
    return int(match.group(1)) if match else None


def persona_file_rejection(text, exit_code=None):
    """The engine's (sanitised) reason if ``text`` carries the fatal line, ``"unspecified"`` if only the exit
    code 91 is known, else None. ``exit_code`` is the process exit code when the caller has it."""
    match = _FATAL_LINE.search(str(text or ""))
    if match:
        return sanitize_reason(match.group(1)) or "unspecified"
    if exit_code == PERSONA_FILE_EXIT_CODE:
        return "unspecified"
    return None


# The engine keeps running with host values when an inline persona is invalid and writes one line (engine
# output), e.g. ``Invalid persona-format-v4; profile remains inactive: <error>``. Renderer-process LOG()
# lines start with "[pid:..." and never match.
_INACTIVE_LINE = re.compile(r"(?m)^(?:\[pid=\d+\]\[err\] ?)?(Invalid [^\r\n]*profile remains inactive[^\r\n]*)$")


def persona_inactive_reason(text):
    """The sanitised line (used as the reason) if ``text`` carries the "profile remains inactive" line, else None.
    Only complete lines count: pass text up to the last newline when scanning a stream."""
    match = _INACTIVE_LINE.search(str(text or ""))
    return (sanitize_reason(match.group(1)) or "profile remains inactive") if match else None
