"""Engine launch ticket.

The engine refuses to start without ``--ant0-launch=<ticket>``: a licence token
signed by the Ant0 server plus a 15-minute claim the local device signed, bound to the engine's
release version. The SDK never mints tickets (it has no device key); it either passes the one the
caller hands in (``launch_ticket=``) or asks the local daemon for one
(``GET /v1/licence/ticket?engine=<version>``) when a daemon is reachable. Without either the launch
proceeds and the engine exits with code 90 and ``ant0: launch ticket invalid (<reason>)`` on stderr,
which the SDK surfaces as :class:`LaunchTicketRejectedError` (``code == "engine.launch_ticket_rejected"``).

Daemon discovery follows the CLI (``@ant0/api-client`` ``discoverDaemon``): ``ANT0_URL`` (+
``ANT0_TOKEN``) when set; else the data folder (``ANT0_HOME``, the platform default, or a legacy
``~/.ant0``) gives ``ant0d.pid`` (port/host) and ``ant0d.token``; ``ANT0D_HOST``/``ANT0D_PORT`` are
the fallbacks. No token means no daemon, and no request is made.
"""
from __future__ import annotations

import dataclasses
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from ._errors import Coded, ENVIRONMENT, EXPECTED, SdkTypeError, SdkValueError
from ._persona_rejected import PersonaFileRejectedError, persona_file_rejection, playwright_exit_code

#: The engine switch; the value is the five-segment ticket.
LAUNCH_TICKET_SWITCH = "ant0-launch"
#: The environment variable the engine child also reads the ticket from (newer engines).
LAUNCH_TICKET_ENV = "ANT0_LAUNCH"
#: Exit code of an engine that refused its ticket (or got none).
LAUNCH_TICKET_EXIT_CODE = 90
#: Error code carried by :class:`LaunchTicketRejectedError`.
LAUNCH_TICKET_REJECTED_CODE = "engine.launch_ticket_rejected"
#: Env override for the engine's release version when it cannot be inferred from the install.
ENGINE_VERSION_ENV = "ANT0_BROWSER_ENGINE_VERSION"

_STDERR_LINE = re.compile(r"ant0: launch ticket invalid \(([a-z_]+)\)")
_RELEASE_VERSION = re.compile(r"^\d+\.\d+\.\d+\.\d+-ant0\.\d+$")
# A development build (``ant0_release_version`` left empty) identifies as ``<chromium>-ant0.dev``.
_DEV_VERSION = re.compile(r"^\d+\.\d+\.\d+\.\d+-ant0\.dev$")
_DEFAULT_HOST = "127.0.0.1"
_DEFAULT_PORT = 27100
_DEFAULT_TIMEOUT = 3.0


_DAEMON_CODE = re.compile(
    r"(?:(?:licence|workspace|browser|ticket|runtime|auth|device)\.[a-z][a-z0-9_]{0,40}"
    r"|http_[1-5][0-9]{2}|bad_response)")


# Playwright's launch failure quotes the whole command line, including the ticket and the persona-file
# path; neither may reach a log through this SDK's own errors. The value runs to the next switch or the
# end of the line (a path can hold spaces). A value the exact step already replaced is left alone (it may
# sit inside quotes that must survive).
_SECRET_SWITCH = re.compile(
    r"--(ant0-launch|fingerprint-profile-file)(?:=|[ \t]+)(?![ \t]*(?:\\*[\"'])?<redacted>)"
    r"[^\r\n]*?(?=[ \t]--[A-Za-z]|[\r\n]|$)")


#: Switches whose values are launch secrets (the ticket, the persona file, the profile directory).
_SECRET_ARG_SWITCHES = ("ant0-launch", "fingerprint-profile-file", "user-data-dir")
#: A value that is not a path is replaced on its own (outside ``--switch=``) only from this length on: a short
#: bare word (``chrome``, ``exit``, ``data``) would mangle Playwright's own text. A path (it holds a separator)
#: is replaced on its own from ``_MIN_STANDALONE_PATH`` characters. Right after a secret switch any length goes.
_MIN_STANDALONE_SECRET = 16
_MIN_STANDALONE_PATH = 4
#: A ``--ant0-launch`` value is matched anywhere only from this length (real tickets are far longer); a shorter one is boundary-only.
_MIN_EXACT_TICKET = 16

# Where an exact value may end: whitespace, a quote (also a backslash-escaped one), a comma or closing
# bracket, or sentence punctuation before one of those or the end. Never inside a longer path or word.
_VALUE_END = r"""(?=[\s"',\]})]|\\+["']|[.;:]*(?:[\s"']|\Z))"""
# Where a bare value may start: the start, whitespace, a quote, an opening bracket, a comma or ``=``.
_VALUE_START = r"""(?<![^\s"'\[(,=])"""
_SWITCH_PREFIX = r"""(--(?:%s)(?:=|[ \t]+)(?:\\*["'])?)""" % "|".join(_SECRET_ARG_SWITCHES)


#: Private construction token: only this module hands it out, so only :func:`launch_secret_values` (and the empty
#: set below) can build a :class:`LaunchSecrets`. It is an ``InitVar``, so ``dataclasses.replace`` does not carry
#: it over and a copy made that way fails like a hand-built object (the Node SDK accepts only the object
#: ``launchSecretValues()`` returned, too).
_CONSTRUCTION_TOKEN = object()


@dataclasses.dataclass(frozen=True)
class LaunchSecrets:
    """The launch secrets to redact, as :func:`launch_secret_values` builds them. ``exact``: the ticket and the
    persona-file path, matched anywhere in a text. ``boundary``: the profile directory (as passed and absolute),
    matched only at argument boundaries. There is deliberately no list form: a plain list or tuple is rejected, so a
    caller can never silently fall back to the weaker matching. Building one by hand, or with
    ``dataclasses.replace``, raises ``TypeError``; ``copy.copy`` of a real one is fine.

    A ``--ant0-launch`` value shorter than 16 characters is not matched anywhere in a text: it is replaced only at
    an argument boundary (right after its switch, or as a whole token), so a short word does not mangle the text
    around it. Such a value is a malformed one that a user typed; a minted ticket carries a 64-byte signature and
    is about 86 characters long, so it is always matched anywhere."""
    exact: tuple = ()
    boundary: tuple = ()
    _token: dataclasses.InitVar[object] = None

    def __post_init__(self, _token):
        if _token is not _CONSTRUCTION_TOKEN:
            raise TypeError("LaunchSecrets cannot be built directly; use launch_secret_values()")


_NO_SECRETS = LaunchSecrets(_token=_CONSTRUCTION_TOKEN)


def _check_secrets(secrets):
    """Only a :class:`LaunchSecrets` or ``None`` (regex layer only); anything else is a ``TypeError``."""
    if secrets is None:
        return _NO_SECRETS
    if not isinstance(secrets, LaunchSecrets):
        raise TypeError("secrets must be the LaunchSecrets from launch_secret_values(), not %s" % type(secrets).__name__)
    return secrets


def _absolute_path(path):
    """An absolute, normalised path (Playwright logs the profile directory in that form)."""
    try:
        return os.path.abspath(path)
    except Exception:  # noqa: BLE001
        return path


def launch_secret_values(args, extra=(), env=None) -> LaunchSecrets:
    """The values of the secret switches among the argv the SDK passed (``--name=value`` and ``--name value``),
    plus ``extra`` (such as a ``user_data_dir`` handed over as a positional). A profile directory is listed as
    passed and as an absolute, normalised path. Feed the result to :func:`redact_launch_secrets` so a value is
    removed exactly, whatever it contains. ``env`` is the engine child's environment: its ``ANT0_LAUNCH`` is the
    same ticket again and is an exact secret too."""
    boundary = {}
    exact = {}

    def add(name, value):
        if name == "fingerprint-profile-file" or (name == "ant0-launch" and len(value) >= _MIN_EXACT_TICKET):
            exact[value] = None
            return
        boundary[value] = None
        if name == "user-data-dir" and value:
            boundary[_absolute_path(value)] = None

    items = [str(a) for a in (args or [])]
    for i, item in enumerate(items):
        for name in _SECRET_ARG_SWITCHES:
            flag = "--" + name
            if item.startswith(flag + "="):
                add(name, item[len(flag) + 1:])
            elif item == flag and i + 1 < len(items):
                add(name, items[i + 1])
    for e in extra or ():
        if e:
            add("user-data-dir", str(e))
    from_env = (env or {}).get(LAUNCH_TICKET_ENV)
    if isinstance(from_env, str) and from_env:
        add(LAUNCH_TICKET_SWITCH, from_env)
    return LaunchSecrets(exact=tuple(exact), boundary=tuple(boundary), _token=_CONSTRUCTION_TOKEN)


def _secret_forms(secrets):
    """Each secret raw and JSON-escaped (backslashes doubled), without duplicates, longest first."""
    forms = set()
    for value in secrets or ():
        if not isinstance(value, str) or not value:
            continue
        forms.add(value)
        forms.add(json.dumps(value, ensure_ascii=False)[1:-1])
    return sorted(forms, key=len, reverse=True)


def _standalone_secret(value):
    if "/" in value or "\\" in value:
        return len(value) >= _MIN_STANDALONE_PATH
    return len(value) >= _MIN_STANDALONE_SECRET


def redact_launch_secrets(text, secrets=None, ignore_case=None) -> str:
    """``text`` with the launch secrets replaced. First by exact match of ``secrets`` (the actual argv values, see
    :func:`launch_secret_values`), only at an argument boundary: right after ``--ant0-launch``,
    ``--fingerprint-profile-file`` or ``--user-data-dir`` (``=``, a space, a quote), or as a whole token for a long
    value or a path, and ending at a token boundary (so ``data``, ``exit`` or ``/tmp`` do not mangle
    ``--user-data-dir``, ``exitCode`` or ``/tmp/eng/chrome``). The full known value is matched, so a path holding
    `` --x`` goes whole, and quotes around it are kept. Then by the switch pattern, a second layer for values not
    passed in. ``ignore_case`` (default: on Windows) matches the values ignoring case."""
    out = str(text)
    secrets = _check_secrets(secrets)
    forms = _secret_forms(secrets.exact + secrets.boundary)
    if forms:
        flags = re.IGNORECASE if (os.name == "nt" if ignore_case is None else ignore_case) else 0
        # Ticket and persona-file path: everywhere, no boundary, whatever surrounds them (quotes stay).
        loose = "|".join(re.escape(f) for f in _secret_forms(
            [v for v in secrets.exact if len(v) >= _MIN_STANDALONE_PATH]))
        if loose:
            out = re.sub(loose, "<redacted>", out, flags=flags)
        everything = "|".join(re.escape(f) for f in forms)
        out = re.sub(_SWITCH_PREFIX + "(?:" + everything + ")" + _VALUE_END,
                     lambda m: m.group(1) + "<redacted>", out, flags=flags)
        bare = "|".join(re.escape(f) for f in forms if _standalone_secret(f))
        if bare:
            out = re.sub(_VALUE_START + "(?:" + bare + ")" + _VALUE_END, "<redacted>", out, flags=flags)
    return _SECRET_SWITCH.sub(r"--\1=<redacted>", out)


def redact_error(exc: BaseException, secrets=None) -> BaseException:
    """``exc`` itself when nothing in it needs redacting, else a new error of the same class (callers may
    catch Playwright's own) with redacted text, string attributes (Playwright keeps its driver stack in
    ``stack``) and no ``__cause__``. ``exc`` is not modified. If the class cannot be built from a message,
    a plain ``RuntimeError`` with the redacted text stands in. The caller raises it ``from None``."""
    secrets = _check_secrets(secrets)
    text = str(exc)
    clean = redact_launch_secrets(text, secrets)
    attrs = {k: redact_launch_secrets(v, secrets) for k, v in getattr(exc, "__dict__", {}).items() if isinstance(v, str)}
    # An ``env`` attribute would hold the whole environment (the ticket is in it): it is never kept.
    unchanged = clean == text and all(attrs[k] == exc.__dict__[k] for k in attrs) and "env" not in getattr(exc, "__dict__", {})
    if unchanged and exc.__cause__ is None and exc.__context__ is None:
        return exc
    try:
        fresh = type(exc)(clean)
    except Exception:  # noqa: BLE001 -- a class with a different constructor
        fresh = RuntimeError(clean)
    if str(fresh) != clean:  # e.g. a class that decorates its message: keep the redacted text as is
        fresh = RuntimeError(clean)
    for key, value in attrs.items():
        try:
            setattr(fresh, key, value)
        except Exception:  # noqa: BLE001 -- read-only attribute
            pass
    return fresh


def drop_partial_first_line(text: str, truncated: bool) -> str:
    """A tail cut at a byte limit may start inside a switch and so hide its name from the redaction: drop
    the partial first line."""
    if not truncated:
        return text
    head, sep, rest = text.partition("\n")
    return rest if sep else ""


class LaunchTicketRejectedError(Coded, RuntimeError):
    """The engine exited with code 90 because its launch ticket was missing or invalid."""

    code = LAUNCH_TICKET_REJECTED_CODE
    error_class = EXPECTED

    def __init__(self, reason: str, detail: str = ""):
        hint = ("Start it through ant0d, pass launch_ticket=, or run a daemon the SDK can reach "
                "(ANT0_URL / ANT0_HOME)." if reason == "missing" else
                "Ask the daemon for a fresh ticket (GET /v1/licence/ticket) for this exact engine version.")
        detail = redact_launch_secrets(detail) if detail else ""
        super().__init__(f"ant0-browser: the engine rejected its launch ticket ({reason}). {hint}"
                         + (f"\n{detail}" if detail else ""))
        #: missing, malformed, unknown_kid, bad_signature, past_grace, bad_claim_signature,
        #: claim_mismatch, claim_expired, claim_stale (engine 949+), wrong_engine
        self.reason = reason
        self.detail = detail


class LaunchTicketUnavailableError(Coded, RuntimeError):
    """The daemon answered but would not issue a ticket (``code`` = its error code, e.g. ``licence.required``)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"ant0-browser: the daemon did not issue a launch ticket ({code}): {message}")
        self.code = code
        self.error_class = EXPECTED if code.startswith(("licence.", "workspace.")) else ENVIRONMENT

    def report_fields(self) -> dict:
        # The code comes from the daemon's reply, so only a known shape is passed on.
        code = self.code if isinstance(self.code, str) and _DAEMON_CODE.fullmatch(self.code) \
            else "sdk.launch_ticket_unavailable"
        return {"code": code, "class": self.error_class}


def launch_ticket_rejection(text):
    """The engine's reason if ``text`` (stderr, or an error message quoting it) carries the rejection line."""
    if not text:
        return None
    match = _STDERR_LINE.search(str(text))
    return match.group(1) if match else None


def reraise_if_ticket_rejected(exc: BaseException, secrets=None):
    """Re-raise a launch failure as the engine's own refusal when Playwright's message quotes it: the launch
    ticket (exit code 90, :class:`LaunchTicketRejectedError`) or the persona file (exit code 91, the fatal
    line, :class:`~ant0browser._persona_rejected.PersonaFileRejectedError`); otherwise re-raise ``exc``
    unchanged. The new errors carry no ``__cause__``/``__context__`` (call this outside the
    ``except`` block so there is no implicit context either). Playwright's message carries the exit code and the stderr lines; the process itself is not
    visible here."""
    secrets = _check_secrets(secrets)
    text = str(exc)
    exit_code = playwright_exit_code(text)
    reason = launch_ticket_rejection(text) or ("missing" if exit_code == LAUNCH_TICKET_EXIT_CODE else None)
    if reason:
        # `from None`: Playwright's error (and its command line) must not ride along as __cause__.
        raise LaunchTicketRejectedError(reason, redact_launch_secrets(
            "Playwright: " + (text.splitlines() or [""])[0], secrets)) from None
    persona = persona_file_rejection(text, exit_code)
    if persona:
        raise PersonaFileRejectedError(persona) from None
    # Any other launch failure: Playwright's message (and driver stack) quotes the command line too.
    safe = redact_error(exc, secrets)
    if safe is exc:
        raise exc
    raise safe from None


#: Engine exit-90 reasons that mean "this ticket went stale before it was used": worth one fresh ticket.
RETRYABLE_TICKET_REASONS = frozenset({"claim_expired", "claim_stale"})


def _fresh_attempt_kwargs(kwargs):
    fresh = dict(kwargs)
    if isinstance(fresh.get("args"), (list, tuple)):
        fresh["args"] = list(fresh["args"])
    if isinstance(fresh.get("env"), dict):
        fresh["env"] = dict(fresh["env"])
    return fresh


def _sdk_may_fetch_ticket(kwargs) -> bool:
    """True when the caller supplied no ticket of their own (``launch_ticket=`` str or False, ``--ant0-launch=``,
    or an ``ANT0_LAUNCH`` in the ``env`` they passed), so any ticket the engine saw was fetched by the SDK."""
    launch_ticket = kwargs.get("launch_ticket")
    return not (isinstance(launch_ticket, str) or launch_ticket is False
                or has_launch_ticket_arg(kwargs.get("args")) or caller_env_ticket(kwargs.get("env")))


def retry_stale_ticket(func):
    """Run a launch; if the engine rejects the ticket as ``claim_expired`` or ``claim_stale`` and the SDK fetched
    it, run it ONE more time (it fetches a fresh ticket right before the respawn). A caller's own ticket and every
    other reason surface as is, and so does the second failure: there is never a third attempt."""
    import functools
    import inspect

    def retryable(error, kwargs):
        return (isinstance(error, LaunchTicketRejectedError) and error.reason in RETRYABLE_TICKET_REASONS
                and _sdk_may_fetch_ticket(kwargs))

    if inspect.iscoroutinefunction(func):
        @functools.wraps(func)
        async def awrapper(*args, **kwargs):
            try:
                return await func(*args, **_fresh_attempt_kwargs(kwargs))
            except LaunchTicketRejectedError as error:
                if not retryable(error, kwargs):
                    raise
            return await func(*args, **_fresh_attempt_kwargs(kwargs))
        return awrapper

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **_fresh_attempt_kwargs(kwargs))
        except LaunchTicketRejectedError as error:
            if not retryable(error, kwargs):
                raise
        return func(*args, **_fresh_attempt_kwargs(kwargs))
    return wrapper


def has_launch_ticket_arg(args) -> bool:
    """True when the caller already put ``--ant0-launch=`` in the engine args."""
    flag = "--" + LAUNCH_TICKET_SWITCH
    return any(a == flag or a.startswith(flag + "=") for a in (args or []))


def _non_empty(value):
    return value if isinstance(value, str) and value else None


def launch_ticket_arg_value(args):
    """The value of the last ``--ant0-launch=<v>`` in ``args``, or ``None``. The space form
    (``--ant0-launch <v>``) is not parsed: Chromium does not read it, so it is left to the engine like any
    other caller argument."""
    flag = "--" + LAUNCH_TICKET_SWITCH + "="
    found = None
    for item in (str(a) for a in (args or [])):
        if item.startswith(flag):
            found = _non_empty(item[len(flag):])
    return found


def _is_ticket_key(key, windows):
    return str(key).upper() == LAUNCH_TICKET_ENV if windows else key == LAUNCH_TICKET_ENV


def _is_windows():
    return os.name == "nt"


def caller_env_ticket(caller_env=None, windows=None):
    """The ticket the caller put in the ``env`` they passed. An ``ANT0_LAUNCH`` in the SDK's own environment
    (``os.environ``) is NOT the caller's ticket: it is inherited ambient state and is never read here."""
    windows = _is_windows() if windows is None else windows
    found = None
    for key, value in (caller_env or {}).items():
        if _is_ticket_key(key, windows):
            found = _non_empty(value) or found
    return found


def args_for_ticket_decision(args, caller_env=None, windows=None):
    """``args`` for the "did the caller already provide a ticket" decision: a ticket in the caller's ``env``
    counts like a caller's own ``--ant0-launch=``."""
    from_env = caller_env_ticket(caller_env, windows)
    if not from_env or has_launch_ticket_arg(args):
        return args
    return list(args or []) + [f"--{LAUNCH_TICKET_SWITCH}={from_env}"]


def apply_ticket_env(args, env, caller_env=None, windows=None):
    """Put the launch ticket in both places the engine reads it, with the same value: ``--ant0-launch=<t>`` in the
    args (all engines) and ``ANT0_LAUNCH=<t>`` in the ENGINE CHILD's environment (newer engines; the
    engine reads the environment first).

    ``env`` is the child's environment as built so far (``None``: inherited from ``os.environ``); ``caller_env``
    is the ``env`` the caller passed, if any. Returns ``(args, env)`` where env is ALWAYS a fresh copy
    (``os.environ`` itself is never written) and an ``ANT0_LAUNCH`` that was merely inherited never reaches the
    engine:

    * the caller put a ticket in ``caller_env``: nothing is overwritten and nothing is refused. If the args hold
      one too, both stay as they are; otherwise the env value is mirrored into the args;
    * otherwise the env value is the resolved argv ticket, or the key is deleted when there is none.

    On Windows the key is matched case-insensitively, so the copy never holds two spellings of it."""
    windows = _is_windows() if windows is None else windows
    args = list(args or [])
    in_args = launch_ticket_arg_value(args)
    in_caller = caller_env_ticket(caller_env, windows)
    source = os.environ if env is None else env
    child = {k: v for k, v in source.items() if not _is_ticket_key(k, windows)}
    if in_caller and not in_args:
        args = args + [f"--{LAUNCH_TICKET_SWITCH}={in_caller}"]
    ticket = in_caller or in_args
    if ticket:
        child[LAUNCH_TICKET_ENV] = ticket
    return args, child


#: Where ``_prepare`` leaves the env the caller passed, until the launch applies the ticket (it is never sent on).
CALLER_ENV_KEY = "_ant0_caller_env"


def apply_ticket_env_to_kwargs(args, pw_kwargs):
    """:func:`apply_ticket_env` for a Playwright launch: returns the args and always stores the env copy in
    ``pw_kwargs["env"]``. The caller's own env was left under ``_ant0_caller_env`` by ``_prepare``."""
    caller_env = pw_kwargs.pop(CALLER_ENV_KEY, None)
    args, env = apply_ticket_env(args, pw_kwargs.get("env"), caller_env)
    pw_kwargs["env"] = env
    return args


def infer_engine_version(executable, env=None):
    """The release version an installed engine identifies as: ``.release.json`` above its
    ``browser/`` directory (what the SDK installer and ant0d write), else a ``<version>`` path
    component, else ``ANT0_BROWSER_ENGINE_VERSION``. ``None`` for a bare binary (tests, hand builds)."""
    env = os.environ if env is None else env
    directory = os.path.dirname(os.path.abspath(executable))
    for _ in range(6):
        marker = os.path.join(directory, ".release.json")
        if os.path.isfile(marker):
            try:
                with open(marker, "r", encoding="utf-8") as handle:
                    version = json.load(handle).get("version")
                if isinstance(version, str) and _RELEASE_VERSION.match(version):
                    return version
            except (OSError, ValueError):
                pass
        if _RELEASE_VERSION.match(os.path.basename(directory)):
            return os.path.basename(directory)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    from_env = (env.get(ENGINE_VERSION_ENV) or "").strip()
    return from_env if _RELEASE_VERSION.match(from_env) else None


def installed_engine_version(executable, allow_dev=False):
    """STRICT engine version for security gates (such as ``--webrtc-ip``): only the release record the
    installer wrote for THIS executable counts, i.e. ``.release.json`` in the install base directly
    above its ``browser/`` directory. A path component, an environment variable or a record in some far
    ancestor is not evidence about this binary, so those give ``None`` (treated as an old engine).
    ``infer_engine_version`` stays as is for the launch ticket. ``allow_dev=True`` also returns a
    development build's ``<chromium>-ant0.dev`` label (for advisory warnings only, never for a gate)."""
    try:
        directory = os.path.dirname(os.path.realpath(executable))
    except (OSError, ValueError):
        return None
    for _ in range(4):
        if os.path.basename(directory) == "browser":
            marker = os.path.join(os.path.dirname(directory), ".release.json")
            try:
                with open(marker, "r", encoding="utf-8") as handle:
                    version = json.load(handle).get("version")
            except (OSError, ValueError, AttributeError):
                return None
            if not isinstance(version, str):
                return None
            if _RELEASE_VERSION.match(version) or (allow_dev and _DEV_VERSION.match(version)):
                return version
            return None
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return None


def _home_exists(directory: str) -> bool:
    return os.path.exists(os.path.join(directory, "ant0.db")) or os.path.exists(os.path.join(directory, "profiles"))


def resolve_daemon_home(env=None, platform=None, user_home=None) -> str:
    """The data folder as ant0d/CLI resolve it: ``ANT0_HOME``, the platform default, or a populated legacy ``~/.ant0``."""
    env = os.environ if env is None else env
    platform = platform or sys.platform
    user_home = user_home or os.path.expanduser("~")
    explicit = (env.get("ANT0_HOME") or "").strip()
    if explicit:
        return explicit
    if platform == "win32":
        local = env.get("LOCALAPPDATA")
        default = os.path.join(local, "Ant0") if local else os.path.join(user_home, "AppData", "Local", "Ant0")
    elif platform == "darwin":
        default = os.path.join(user_home, "Library", "Application Support", "Ant0")
    else:
        xdg = env.get("XDG_DATA_HOME")
        default = os.path.join(xdg, "ant0") if xdg else os.path.join(user_home, ".local", "share", "ant0")
    legacy = os.path.join(user_home, ".ant0")
    return legacy if not _home_exists(default) and _home_exists(legacy) else default


def _is_loopback(host: str) -> bool:
    h = host.strip("[]").lower()
    return h == "localhost" or h == "::1" or h.startswith("127.")


def _read_token(path: str):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            token = handle.read().strip()
        return token or None
    except OSError:
        return None


def _valid_port(value):
    try:
        port = int(str(value))
    except (TypeError, ValueError):
        return None
    return port if 0 < port <= 65535 else None


def discover_daemon(env=None, platform=None, user_home=None):
    """``{"base_url", "token"}`` of a running daemon, or ``None`` when there is no token to send."""
    env = os.environ if env is None else env
    home = resolve_daemon_home(env, platform, user_home)
    token = (env.get("ANT0_TOKEN") or "").strip() or _read_token(os.path.join(home, "ant0d.token"))
    if not token:
        return None
    url = (env.get("ANT0_URL") or "").strip()
    if url:
        return {"base_url": url.rstrip("/"), "token": token}
    host = port = None
    try:
        with open(os.path.join(home, "ant0d.pid"), "r", encoding="utf-8") as handle:
            pid = json.load(handle)
        if isinstance(pid, dict):
            port = _valid_port(pid.get("port")) if isinstance(pid.get("port"), int) else None
            pid_host = pid.get("host")
            if isinstance(pid_host, str) and pid_host and _is_loopback(pid_host):
                host = pid_host
    except (OSError, ValueError):
        pass
    if port is None:
        port = _valid_port(env.get("ANT0D_PORT")) or _DEFAULT_PORT
    if host is None:
        env_host = env.get("ANT0D_HOST") or ""
        host = env_host if env_host and _is_loopback(env_host) else _DEFAULT_HOST
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return {"base_url": f"http://{host}:{port}", "token": token}


def fetch_launch_ticket(engine: str, daemon: dict, timeout: float = _DEFAULT_TIMEOUT, opener=None) -> str:
    """``GET /v1/licence/ticket?engine=<engine>`` with the daemon token; returns the ``launch`` value."""
    url = f"{daemon['base_url']}/v1/licence/ticket?engine={urllib.parse.quote(engine, safe='')}"
    request = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {daemon['token']}", "Accept": "application/json"})
    open_fn = opener or urllib.request.urlopen
    try:
        with open_fn(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            envelope = json.loads(exc.read().decode("utf-8")).get("error") or {}
        except (ValueError, AttributeError, OSError):
            envelope = {}
        code = envelope.get("code") if isinstance(envelope.get("code"), str) else f"http_{exc.code}"
        message = envelope.get("message") if isinstance(envelope.get("message"), str) else str(exc.reason)
        raise LaunchTicketUnavailableError(code, message) from None
    launch = body.get("launch") if isinstance(body, dict) else None
    if not isinstance(launch, str) or launch.count(".") != 4:
        raise LaunchTicketUnavailableError("bad_response", "response has no five-segment `launch`")
    return launch


def resolve_launch_ticket_args(launch_ticket, engine_version, executable, args, quiet=False, env=None,
                               timeout: float = _DEFAULT_TIMEOUT):
    """The ``--ant0-launch=`` arg to append (a one-item list) or ``[]``.

    ``launch_ticket``: a ticket string (passed through), ``False`` (never contact a daemon), or
    ``None`` (fetch one from the local daemon for the engine's release version). Empty when the
    caller already passed the switch in ``args``, no version can be inferred, no daemon is
    reachable, or the daemon refuses (a note goes to stderr unless ``quiet``; the engine's own
    exit-90 then names the outcome).
    """
    env = os.environ if env is None else env
    if launch_ticket is False or has_launch_ticket_arg(args):
        return []
    if isinstance(launch_ticket, str):
        if launch_ticket.count(".") != 4:
            raise SdkValueError("sdk.launch_ticket_invalid", "launch_ticket must be the five-segment `lic.claim.csig` value the daemon issues")
        return [f"--{LAUNCH_TICKET_SWITCH}={launch_ticket}"]
    if launch_ticket is not None:
        raise SdkTypeError("sdk.launch_ticket_invalid", "launch_ticket must be a str, False or None")

    def note(message):
        if not quiet and not env.get("ANT0_BROWSER_NO_WARN"):
            sys.stderr.write(f"[ant0-browser] [launch-ticket] {message}\n")

    engine = engine_version or infer_engine_version(executable, env)
    if not engine:
        return []  # bare binary: nothing to bind a ticket to (tests, hand-built trees)
    daemon = discover_daemon(env)
    if daemon is None:
        note(f"no ant0d found (no token under {resolve_daemon_home(env)}); launching {engine} without a ticket")
        return []
    try:
        launch = fetch_launch_ticket(engine, daemon, timeout=timeout)
    except LaunchTicketUnavailableError as exc:
        note(f"{daemon['base_url']} issued no ticket for {engine} ({exc.code}); launching without one")
        return []
    except (OSError, ValueError) as exc:  # connection refused, timeout, bad JSON
        note(f"{daemon['base_url']} unreachable ({exc.__class__.__name__}); launching {engine} without a ticket")
        return []
    return [f"--{LAUNCH_TICKET_SWITCH}={launch}"]
