"""Engine launch ticket: daemon discovery, ticket fetch against a mock ant0d, the
``--ant0-launch=`` wiring through ``_prepare`` (shared by launch / async / serve), and the exit-90
mapping in ``serve()``."""

import json
import os
import stat
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import ant0browser
from ant0browser import _serve
from ant0browser._launch_ticket import (
    LAUNCH_TICKET_EXIT_CODE,
    LAUNCH_TICKET_REJECTED_CODE,
    LaunchTicketRejectedError,
    LaunchTicketUnavailableError,
    discover_daemon,
    fetch_launch_ticket,
    has_launch_ticket_arg,
    infer_engine_version,
    LaunchSecrets,
    launch_secret_values,
    launch_ticket_rejection,
    redact_error,
    redact_launch_secrets,
    reraise_if_ticket_rejected,
    resolve_daemon_home,
    resolve_launch_ticket_args,
)

MARKER = "ant0-browser-capabilities/persona-profile-v1"
ENGINE = "149.0.7827.114-ant0.1"
TICKET = "eyJraWQiOiJsaWMtdGVzdCIsInYiOjF9.eyJkZXYiOiJ4In0.c2ln.eyJlbmciOiIxNDkifQ.Y3NpZw"

from ant0browser import _launch_ticket as _lt


def _secrets(**fields):
    """A LaunchSecrets for a test: the private token stands in for launch_secret_values()."""
    return LaunchSecrets(_token=_lt._CONSTRUCTION_TOKEN, **fields)


# ------------------------------------------------------------------ mock ant0d
class _State:
    mode = "ok"
    seen = []


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):  # silence
        pass

    def do_GET(self):  # noqa: N802
        _State.seen.append((self.path, self.headers.get("Authorization")))
        if self.headers.get("Authorization") != "Bearer tok-123":
            return self._json(401, {"error": {"code": "auth.invalid", "message": "bad token"}})
        if _State.mode == "licence.required":
            return self._json(403, {"error": {"code": "licence.required", "message": "sign in"}})
        if _State.mode == "garbage":
            return self._json(200, {"launch": "not.a.ticket"})
        if _State.mode == "text":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"boom")
            return None
        engine = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("engine", [None])[0]
        return self._json(200, {"launch": TICKET, "engine": engine, "expires_at": "2027-01-15T08:15:05Z"})

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(scope="module")
def daemon():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield {"base_url": "http://127.0.0.1:%d" % server.server_address[1], "token": "tok-123"}
    server.shutdown()


@pytest.fixture(autouse=True)
def _reset():
    _State.mode = "ok"
    _State.seen = []


def _fake_install(tmp_path, version=ENGINE, release_json=True):
    base = tmp_path / version
    (base / "browser").mkdir(parents=True)
    exe = base / "browser" / ("chrome.exe" if sys.platform == "win32" else "chrome")
    exe.write_bytes(b"x" * 64 + MARKER.encode())
    if release_json:
        (base / ".release.json").write_text(json.dumps({"version": version, "chromium": "149.0.7827.114"}))
    return str(exe)


def _env(**extra):
    return {"PATH": os.environ.get("PATH", ""), **extra}


# ------------------------------------------------------------------ discovery
def test_discover_prefers_ant0_url_and_token():
    assert discover_daemon(_env(ANT0_URL="http://127.0.0.1:4444/", ANT0_TOKEN="t"), "linux", "/nohome") == {
        "base_url": "http://127.0.0.1:4444", "token": "t"}


def test_discover_reads_pid_and_token_like_the_cli(tmp_path):
    (tmp_path / "ant0d.pid").write_text(json.dumps({"pid": 1, "port": 27555, "started_at": "x"}))
    (tmp_path / "ant0d.token").write_text("tok-123\n")
    assert discover_daemon(_env(ANT0_HOME=str(tmp_path)), "linux", "/nohome") == {
        "base_url": "http://127.0.0.1:27555", "token": "tok-123"}


def test_discover_ignores_non_loopback_pid_host_and_falls_back(tmp_path):
    (tmp_path / "ant0d.pid").write_text(json.dumps({"pid": 1, "port": 1, "host": "evil.example"}))
    (tmp_path / "ant0d.token").write_text("tok")
    assert discover_daemon(_env(ANT0_HOME=str(tmp_path)), "linux", "/nohome")["base_url"] == "http://127.0.0.1:1"
    (tmp_path / "ant0d.pid").unlink()
    assert discover_daemon(_env(ANT0_HOME=str(tmp_path), ANT0D_PORT="28000"), "linux", "/nohome")["base_url"] \
        == "http://127.0.0.1:28000"
    assert discover_daemon(_env(ANT0_HOME=str(tmp_path)), "linux", "/nohome")["base_url"] == "http://127.0.0.1:27100"


def test_discover_none_without_token(tmp_path):
    assert discover_daemon(_env(ANT0_HOME=str(tmp_path)), "linux", "/nohome") is None
    assert discover_daemon(_env(ANT0_URL="http://127.0.0.1:1"), "linux", "/nohome") is None


def test_resolve_daemon_home_platforms(tmp_path):
    user = str(tmp_path)
    assert resolve_daemon_home(_env(), "linux", user) == os.path.join(user, ".local", "share", "ant0")
    assert resolve_daemon_home(_env(XDG_DATA_HOME="/xdg"), "linux", user) == os.path.join("/xdg", "ant0")
    assert resolve_daemon_home(_env(LOCALAPPDATA="/lad"), "win32", user) == os.path.join("/lad", "Ant0")
    assert resolve_daemon_home(_env(), "darwin", user) == os.path.join(user, "Library", "Application Support", "Ant0")
    (tmp_path / ".ant0" / "profiles").mkdir(parents=True)
    assert resolve_daemon_home(_env(), "linux", user) == os.path.join(user, ".ant0")


def test_infer_engine_version(tmp_path):
    assert infer_engine_version(_fake_install(tmp_path), _env()) == ENGINE
    assert infer_engine_version(_fake_install(tmp_path / "b", "149.0.7827.114-ant0.7", release_json=False), _env()) \
        == "149.0.7827.114-ant0.7"
    bare = tmp_path / "chrome"
    bare.write_text(MARKER)
    assert infer_engine_version(str(bare), _env()) is None
    assert infer_engine_version(str(bare), _env(ANT0_BROWSER_ENGINE_VERSION=ENGINE)) == ENGINE
    assert infer_engine_version(str(bare), _env(ANT0_BROWSER_ENGINE_VERSION="149.0.7827.114")) is None


# ------------------------------------------------------------------ fetch
def test_fetch_launch_ticket_ok(daemon):
    assert fetch_launch_ticket(ENGINE, daemon) == TICKET
    assert _State.seen == [("/v1/licence/ticket?engine=" + urllib.parse.quote(ENGINE, safe=""), "Bearer tok-123")]


def test_fetch_launch_ticket_surfaces_daemon_error_codes(daemon):
    _State.mode = "licence.required"
    with pytest.raises(LaunchTicketUnavailableError) as info:
        fetch_launch_ticket(ENGINE, daemon)
    assert info.value.code == "licence.required"
    with pytest.raises(LaunchTicketUnavailableError) as info:
        fetch_launch_ticket(ENGINE, {**daemon, "token": "nope"})
    assert info.value.code == "auth.invalid"
    _State.mode = "text"
    with pytest.raises(LaunchTicketUnavailableError) as info:
        fetch_launch_ticket(ENGINE, daemon)
    assert info.value.code == "http_500"
    _State.mode = "garbage"
    with pytest.raises(LaunchTicketUnavailableError) as info:
        fetch_launch_ticket(ENGINE, daemon)
    assert info.value.code == "bad_response"


# ------------------------------------------------------------------ resolution
def test_resolve_explicit_ticket_and_validation(tmp_path, daemon):
    exe = _fake_install(tmp_path)
    assert resolve_launch_ticket_args(TICKET, None, exe, [], env=_env()) == ["--ant0-launch=" + TICKET]
    with pytest.raises(ValueError, match="five-segment"):
        resolve_launch_ticket_args("a.b.c", None, exe, [], env=_env())
    with pytest.raises(TypeError):
        resolve_launch_ticket_args(123, None, exe, [], env=_env())
    assert _State.seen == []


def test_resolve_skips_when_disabled_or_already_present(tmp_path, daemon):
    exe = _fake_install(tmp_path)
    env = _env(ANT0_URL=daemon["base_url"], ANT0_TOKEN="tok-123")
    assert resolve_launch_ticket_args(False, None, exe, [], env=env) == []
    assert resolve_launch_ticket_args(None, None, exe, ["--ant0-launch=x.y.z.w.v"], env=env) == []
    assert has_launch_ticket_arg(["--foo", "--ant0-launch=x"]) is True
    assert has_launch_ticket_arg(["--ant0-launch-other=x"]) is False
    assert _State.seen == []


def test_resolve_fetches_for_inferred_or_explicit_engine(tmp_path, daemon):
    exe = _fake_install(tmp_path)
    env = _env(ANT0_URL=daemon["base_url"], ANT0_TOKEN="tok-123")
    assert resolve_launch_ticket_args(None, None, exe, [], quiet=True, env=env) == ["--ant0-launch=" + TICKET]
    assert "engine=" + urllib.parse.quote(ENGINE, safe="") in _State.seen[0][0]
    resolve_launch_ticket_args(None, "149.0.7827.114-ant0.9", exe, [], quiet=True, env=env)
    assert "engine=149.0.7827.114-ant0.9" in _State.seen[1][0]


def test_resolve_launches_without_ticket_when_it_cannot_get_one(tmp_path, daemon, capsys):
    bare = tmp_path / "chrome"
    bare.write_text(MARKER)
    env = _env(ANT0_URL=daemon["base_url"], ANT0_TOKEN="tok-123")
    assert resolve_launch_ticket_args(None, None, str(bare), [], env=env) == []
    assert _State.seen == []  # no version -> no request
    exe = _fake_install(tmp_path)
    assert resolve_launch_ticket_args(None, None, exe, [], env=_env(ANT0_HOME=str(tmp_path / "empty"))) == []
    _State.mode = "licence.required"
    assert resolve_launch_ticket_args(None, None, exe, [], env=env) == []
    assert len(_State.seen) == 1
    # unreachable daemon: connection refused is tolerated
    assert resolve_launch_ticket_args(None, None, exe, [], env=_env(ANT0_URL="http://127.0.0.1:9", ANT0_TOKEN="t")) == []
    err = capsys.readouterr().err
    assert "[launch-ticket]" in err and "licence.required" in err and "unreachable" in err


# ------------------------------------------------------------------ _prepare wiring
def test_prepare_appends_the_daemon_ticket(tmp_path, daemon, monkeypatch):
    exe = _fake_install(tmp_path)
    monkeypatch.setenv("ANT0_URL", daemon["base_url"])
    monkeypatch.setenv("ANT0_TOKEN", "tok-123")
    monkeypatch.delenv("ANT0_HOME", raising=False)
    _exe, args, pw_kwargs, *_rest = ant0browser._prepare(
        {"executable_path": exe, "identity": {"mode": "native"}, "quiet": True})
    assert args.count("--ant0-launch=" + TICKET) == 1
    assert "launch_ticket" not in pw_kwargs and "engine_version" not in pw_kwargs
    # A ticket in args (what ant0d passes) wins; an explicit one skips the daemon; False disables.
    _State.seen = []
    _exe, args, *_rest = ant0browser._prepare(
        {"executable_path": exe, "identity": {"mode": "native"}, "quiet": True, "args": ["--ant0-launch=a.b.c.d.e"]})
    assert [a for a in args if a.startswith("--ant0-launch=")] == ["--ant0-launch=a.b.c.d.e"]
    _exe, args, *_rest = ant0browser._prepare(
        {"executable_path": exe, "identity": {"mode": "native"}, "quiet": True, "launch_ticket": TICKET})
    assert "--ant0-launch=" + TICKET in args
    _exe, args, *_rest = ant0browser._prepare(
        {"executable_path": exe, "identity": {"mode": "native"}, "quiet": True, "launch_ticket": False})
    assert not any(a.startswith("--ant0-launch=") for a in args)
    assert _State.seen == []


# ------------------------------------------------------------------ rejection surfacing
def test_rejection_parsing_and_reraise():
    assert launch_ticket_rejection("x\nant0: launch ticket invalid (claim_expired)\ny") == "claim_expired"
    assert launch_ticket_rejection("nothing") is None
    assert launch_ticket_rejection(None) is None
    with pytest.raises(LaunchTicketRejectedError) as info:
        reraise_if_ticket_rejected(RuntimeError("Failed to launch\nant0: launch ticket invalid (wrong_engine)"))
    assert info.value.reason == "wrong_engine" and info.value.code == LAUNCH_TICKET_REJECTED_CODE
    with pytest.raises(RuntimeError, match="unrelated"):
        reraise_if_ticket_rejected(RuntimeError("unrelated"))


def test_sync_launch_maps_playwright_error_to_rejection(monkeypatch, tmp_path):
    exe = tmp_path / "chrome"
    exe.write_bytes(MARKER.encode())

    class _Chromium:
        def launch_persistent_context(self, *_a, **_k):
            raise RuntimeError("Browser process exited\n<launching>\nant0: launch ticket invalid (missing)\n")

    class _PW:
        chromium = _Chromium()

    monkeypatch.setattr(ant0browser, "_playwright", lambda: _PW())
    with pytest.raises(LaunchTicketRejectedError) as info:
        ant0browser.launch_persistent_context(str(tmp_path / "udd"), executable_path=str(exe),
                                              identity={"mode": "native"}, quiet=True, launch_ticket=False)
    assert info.value.reason == "missing"


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_serve_maps_exit_90_to_rejection(tmp_path):
    exe = tmp_path / "chrome"
    exe.write_text("#!/bin/sh\n# %s\necho 'ant0: launch ticket invalid (unknown_kid)' >&2\nexit %d\n"
                   % (MARKER, LAUNCH_TICKET_EXIT_CODE))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    with pytest.raises(LaunchTicketRejectedError) as info:
        _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True,
                     launch_ticket=False, ready_timeout=5.0)
    assert info.value.reason == "unknown_kid"
    assert info.value.code == "engine.launch_ticket_rejected"


# ------------------------------------------------------------------ the ticket never rides along on an error
SECRET_TICKET = "SECRETlic.SECRETclaim.SECRETsig.SECRETeng.SECRETcs"
SECRET_PATH = "/tmp/ant0 persona SECRET/fingerprint-profile.json"


def _boundary(*values):
    return _secrets(boundary=tuple(values))


def _exact(*values):
    return _secrets(exact=tuple(values))


def _playwright_failure(extra_lines):
    cmd = f"/x/chrome --headless --ant0-launch={SECRET_TICKET} --fingerprint-profile-file={SECRET_PATH} --no-first-run"
    return RuntimeError(
        "BrowserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n"
        f"<launching> {cmd}\n{extra_lines}")


def _full_chain(exc):
    import traceback
    text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    seen, node, parts = set(), exc, []
    while node is not None and id(node) not in seen:  # also the hidden links format_exception may skip
        seen.add(id(node))
        parts.append(f"{node!r} {node}")
        node = node.__cause__ or node.__context__
    return text + "\n".join(parts), exc


@pytest.mark.parametrize("extra", [
    "<process did exit: exitCode=90, signal=null>\nant0: launch ticket invalid (past_grace)\n",
    "<process did exit: exitCode=90, signal=null>\n",
    "<process did exit: exitCode=91, signal=null>\n[pid=1][err] fatal: --fingerprint-profile-file: bad file\n",
])
def test_rejection_errors_do_not_leak_the_ticket_or_the_persona_path(monkeypatch, tmp_path, extra):
    exe = tmp_path / "chrome"
    exe.write_bytes(MARKER.encode())

    class _Chromium:
        def launch_persistent_context(self, *_a, **_k):
            raise _playwright_failure(extra)

        launch = launch_persistent_context

    class _PW:
        chromium = _Chromium()

    monkeypatch.setattr(ant0browser, "_playwright", lambda: _PW())
    for call in (
        lambda: ant0browser.launch_persistent_context(str(tmp_path / "udd"), executable_path=str(exe),
                                                      identity={"mode": "native"}, quiet=True, launch_ticket=False),
        lambda: ant0browser.launch(executable_path=str(exe), identity={"mode": "native"}, quiet=True,
                                   launch_ticket=False),
    ):
        with pytest.raises(RuntimeError) as info:
            call()
        assert info.value.__cause__ is None and info.value.__context__ is None
        text, _ = _full_chain(info.value)
        assert "SECRET" not in text and "persona SECRET" not in text
        assert SECRET_TICKET not in text and SECRET_PATH not in text


def test_the_redaction_covers_a_path_with_spaces_and_the_following_switches():
    from ant0browser._launch_ticket import redact_launch_secrets
    out = redact_launch_secrets(f"x --ant0-launch={SECRET_TICKET} --fingerprint-profile-file={SECRET_PATH} --keep=1")
    assert "SECRET" not in out and out.endswith("--keep=1")
    assert LaunchTicketRejectedError("missing", f"Playwright: --ant0-launch={SECRET_TICKET}").detail.count("SECRET") == 0


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_serve_exit_90_does_not_leak_an_echoed_command_line(tmp_path):
    exe = tmp_path / "chrome"
    exe.write_text('#!/bin/sh\n# %s\necho "launching $@" >&2\nexit %d\n' % (MARKER, LAUNCH_TICKET_EXIT_CODE))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    with pytest.raises(LaunchTicketRejectedError) as info:
        _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True,
                     launch_ticket=SECRET_TICKET, ready_timeout=5.0)
    text, _ = _full_chain(info.value)
    assert "<redacted>" in text and "SECRET" not in text


class _PlaywrightLikeError(Exception):
    """Stands in for playwright's Error: built from a message, keeps a driver stack in `stack`."""

    def __init__(self, message):
        super().__init__(message)
        self.stack = "driver stack: " + message


class _PlaywrightLikeTimeout(_PlaywrightLikeError):
    pass


def _generic_failure():
    cause = RuntimeError(f"inner --ant0-launch={SECRET_TICKET}")
    exc = _PlaywrightLikeTimeout(
        f"BrowserType.launch: Browser closed\n<launching> /x/chrome --ant0-launch={SECRET_TICKET} "
        f"--fingerprint-profile-file={SECRET_PATH} --no-first-run\n<process did exit: exitCode=1, signal=null>\n")
    exc.__cause__ = cause
    return exc


def _assert_clean(exc):
    import traceback
    blob = "\n".join([str(exc), repr(exc), "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))]
                      + [str(v) for v in getattr(exc, "__dict__", {}).values()])
    node, seen = exc, set()
    while node is not None and id(node) not in seen:
        seen.add(id(node))
        blob += f"\n{node!s} {node!r} {getattr(node, '__dict__', {})}"
        node = node.__cause__ or node.__context__
    assert "SECRET" not in blob, blob


def test_a_generic_launch_failure_is_redacted_and_keeps_its_class():
    original = _generic_failure()
    with pytest.raises(_PlaywrightLikeTimeout) as info:
        reraise_if_ticket_rejected(original)
    assert info.value is not original and info.value.__cause__ is None and info.value.__context__ is None
    assert "exitCode=1" in str(info.value) and "<redacted>" in str(info.value)
    _assert_clean(info.value)
    assert SECRET_TICKET in str(original)  # the shared object is untouched


def test_an_error_without_secrets_is_re_raised_as_is():
    original = RuntimeError("unrelated")
    with pytest.raises(RuntimeError) as info:
        reraise_if_ticket_rejected(original)
    assert info.value is original


@pytest.mark.parametrize("persistent", [True, False])
def test_sync_launch_paths_redact_a_generic_failure(monkeypatch, tmp_path, persistent):
    exe = tmp_path / "chrome"
    exe.write_bytes(MARKER.encode())

    class _Chromium:
        def launch_persistent_context(self, *_a, **_k):
            raise _generic_failure()

        launch = launch_persistent_context

    class _PW:
        chromium = _Chromium()

    monkeypatch.setattr(ant0browser, "_playwright", lambda: _PW())
    with pytest.raises(_PlaywrightLikeTimeout) as info:
        if persistent:
            ant0browser.launch_persistent_context(str(tmp_path / "udd"), executable_path=str(exe),
                                                  identity={"mode": "native"}, quiet=True, launch_ticket=False)
        else:
            ant0browser.launch(executable_path=str(exe), identity={"mode": "native"}, quiet=True, launch_ticket=False)
    _assert_clean(info.value)


@pytest.mark.parametrize("persistent", [True, False])
def test_async_launch_paths_redact_a_generic_failure(monkeypatch, tmp_path, persistent):
    import asyncio
    from ant0browser import async_api
    exe = tmp_path / "chrome"
    exe.write_bytes(MARKER.encode())

    class _Chromium:
        async def launch_persistent_context(self, *_a, **_k):
            raise _generic_failure()

        launch = launch_persistent_context

    class _PW:
        chromium = _Chromium()

    async def _driver():
        return _PW()

    monkeypatch.setattr(async_api, "_start_driver", _driver)

    async def run():
        if persistent:
            return await async_api.launch_persistent_context(
                str(tmp_path / "udd"), executable_path=str(exe), identity={"mode": "native"}, quiet=True,
                launch_ticket=False)
        return await async_api.launch(executable_path=str(exe), identity={"mode": "native"}, quiet=True,
                                      launch_ticket=False)

    with pytest.raises(_PlaywrightLikeTimeout) as info:
        asyncio.run(run())
    _assert_clean(info.value)


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
@pytest.mark.parametrize("filler", [0, 9000])
def test_serve_exit_1_with_the_command_line_leaks_nothing(tmp_path, filler):
    exe = tmp_path / "chrome"
    exe.write_text("#!/bin/sh\n# %s\nprintf '%%0%dd' 0 >&2\necho \"argv: $@ --fingerprint-profile-file=%s\" >&2\nexit 1\n"
                   % (MARKER, filler, SECRET_PATH))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    with pytest.raises(Exception) as info:
        _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True,
                     launch_ticket=SECRET_TICKET, ready_timeout=5.0)
    assert getattr(info.value, "code", None) == "sdk.engine_not_ready"
    _assert_clean(info.value)


# ------------------------------------------------- exact-value redaction of the argv the SDK passed
_UDD = "/tmp/ant0 udd --xSECRETtail/profile dir"
_WIN_UDD = "C:\\Users\\a b\\SECRETwin\\profile"
_ARGV = [f"--user-data-dir={_UDD}", f"--fingerprint-profile-file={SECRET_PATH}", f"--ant0-launch={SECRET_TICKET}",
         "--keep=1"]


def test_launch_secret_values_takes_the_ticket_and_both_paths():
    assert launch_secret_values(_ARGV) == _secrets(exact=(SECRET_PATH, SECRET_TICKET), boundary=(_UDD,))
    assert launch_secret_values(["--user-data-dir", "/p/q q"], ["/extra/dir"]) == _secrets(boundary=("/p/q q", "/extra/dir"))


def test_a_profile_path_containing_space_dash_dash_x_is_removed_whole():
    out = redact_launch_secrets("<launching> /x/chrome " + " ".join(_ARGV), launch_secret_values(_ARGV))
    assert "SECRET" not in out and "tail/profile" not in out and out.endswith("--keep=1")


def test_a_persona_path_containing_space_dash_dash_x_is_removed_whole():
    path = "/tmp/p SECRETa --xSECRETb/f.json"
    argv = [f"--fingerprint-profile-file={path}", "--keep=1"]
    assert redact_launch_secrets("chrome " + " ".join(argv), launch_secret_values(argv)) \
        == "chrome --fingerprint-profile-file=<redacted> --keep=1"


def test_the_switch_pattern_still_runs_as_the_second_layer():
    assert redact_launch_secrets(f"chrome --ant0-launch={SECRET_TICKET} --keep=1") \
        == "chrome --ant0-launch=<redacted> --keep=1"


def test_a_quoted_secret_keeps_both_quotes():
    secrets = _boundary(_WIN_UDD)
    escaped = _WIN_UDD.replace("\\", "\\\\")
    assert redact_launch_secrets(f'chrome --user-data-dir="{_WIN_UDD}" --keep=1', secrets) == 'chrome --user-data-dir="<redacted>" --keep=1'
    assert redact_launch_secrets(f'chrome --user-data-dir="{escaped}" --keep=1', secrets) == 'chrome --user-data-dir="<redacted>" --keep=1'
    assert redact_launch_secrets(f"chrome --user-data-dir='{_WIN_UDD}' --keep=1", secrets) == "chrome --user-data-dir='<redacted>' --keep=1"
    assert redact_launch_secrets(f'chrome "--user-data-dir={_WIN_UDD}" --keep=1', secrets) == 'chrome "--user-data-dir=<redacted>" --keep=1'
    assert redact_launch_secrets(f'chrome "{_WIN_UDD}" --keep=1', secrets) == 'chrome "<redacted>" --keep=1'
    assert redact_launch_secrets('{"args":["--user-data-dir=%s","--keep=1"]}' % escaped, secrets) \
        == '{"args":["--user-data-dir=<redacted>","--keep=1"]}'


def test_the_switch_pattern_does_not_eat_the_closing_quote_of_an_already_redacted_value():
    persona = "C:\\a b\\SECRETp --x\\f.json"
    assert redact_launch_secrets(f'chrome --fingerprint-profile-file="{persona}" --keep=1', _exact(persona)) \
        == 'chrome --fingerprint-profile-file="<redacted>" --keep=1'
    assert redact_launch_secrets(f"chrome --fingerprint-profile-file '{persona}' --keep=1", _exact(persona)) \
        == "chrome --fingerprint-profile-file '<redacted>' --keep=1"
    # without the exact values the pattern layer still redacts
    assert "SECRET" not in redact_launch_secrets(f'chrome --ant0-launch="{SECRET_TICKET}" --keep=1')


def test_the_longest_value_goes_first_when_one_secret_contains_another():
    assert redact_launch_secrets("a /tmp/SECRETdir/persona.json b", _boundary("/tmp/SECRETdir", "/tmp/SECRETdir/persona.json")) == "a <redacted> b"


def test_reraise_removes_a_path_with_space_dash_dash_x_from_a_generic_failure():
    original = _PlaywrightLikeError("launch failed\n<launching> /x/chrome " + " ".join(_ARGV) + "\n")
    with pytest.raises(_PlaywrightLikeError) as info:
        reraise_if_ticket_rejected(original, launch_secret_values(_ARGV))
    assert "SECRET" not in str(info.value) and "SECRET" not in info.value.stack


# Q11: the top-level message is clean, the secret sits only in the chain: the chain must not survive.
@pytest.mark.parametrize("link", ["__cause__", "__context__"])
def test_redact_error_drops_a_chain_link_that_holds_the_secret_when_the_message_is_clean(link):
    top = RuntimeError("launch failed")
    setattr(top, link, RuntimeError(f"inner --ant0-launch={SECRET_TICKET}"))
    safe = redact_error(top)
    assert safe is not top and str(safe) == "launch failed"
    assert safe.__cause__ is None and safe.__context__ is None
    with pytest.raises(RuntimeError) as info:
        reraise_if_ticket_rejected(top)
    assert info.value.__cause__ is None and info.value.__context__ is None
    assert info.value.__suppress_context__
    _assert_clean(info.value)


_LT = "AAAAtkLIC0123456789.BBBBtkCLAIM0123456789.CCCCtkSIG0123.DDDDtkENG.EEEEtkCS"
_LP = "/home/u/My Prof --x/ant0-persona.profile"
_AFTER = [": denied", "'", ")", ">", "|", ";x", "#", "\t", "\r\n", "&", "!", "?", "*", "+", "/", "~", "@", "-", "_x", "%", "`", "$", "^"]
_BEFORE = ["<", "file://", ":", "/", "\\", "`", "|", "@", "*", "-", "x", "\\\\?\\"]


def _lvals():
    return launch_secret_values(["--fingerprint-profile-file=" + _LP, "--ant0-launch=" + _LT])


def _gone(out):
    import re
    return not re.search(r"(?i)tk(lic|claim|sig|eng|cs)|ant0-persona|my prof", out)


@pytest.mark.parametrize("c", _AFTER)
def test_a_ticket_and_persona_path_followed_by_anything_are_removed(c):
    assert _gone(redact_launch_secrets("ticket=%s%s end open [%s%s end" % (_LT, c, _LP, c), _lvals()))


@pytest.mark.parametrize("c", _BEFORE)
def test_a_ticket_and_persona_path_preceded_by_anything_are_removed(c):
    assert _gone(redact_launch_secrets("t %s%s end open %s%s end" % (c, _LT, c, _LP), _lvals()))


def test_a_quoted_standalone_ticket_keeps_both_quotes():
    assert redact_launch_secrets('x "%s" y \'%s\' z' % (_LT, _LP), _lvals()) == 'x "<redacted>" y \'<redacted>\' z'


def test_standalone_matching_covers_the_json_form_and_ignores_case_when_asked():
    w = "C:\\Users\\A B\\ant0-persona.profile"
    wv = launch_secret_values(["--fingerprint-profile-file=" + w])
    assert redact_launch_secrets(json.dumps({"p": w}), wv) == '{"p": "<redacted>"}'
    assert redact_launch_secrets("cannot open>%s|" % w.lower(), wv, ignore_case=True) == "cannot open><redacted>|"


def test_a_quoted_short_profile_directory_after_the_switch_is_redacted():
    assert redact_launch_secrets('chrome --user-data-dir="data" --x exitCode=7', launch_secret_values(["--user-data-dir=data"])) \
        == 'chrome --user-data-dir="<redacted>" --x exitCode=7'
    assert redact_launch_secrets("chrome --user-data-dir 'data' --x", _boundary("data")) == "chrome --user-data-dir '<redacted>' --x"


def test_launch_secrets_is_frozen_with_tuples():
    import dataclasses
    v = launch_secret_values(_ARGV, ["/x/udd"])
    assert isinstance(v.exact, tuple) and isinstance(v.boundary, tuple)
    with pytest.raises(dataclasses.FrozenInstanceError):
        v.exact = ()


@pytest.mark.parametrize("bad", [[SECRET_TICKET], (SECRET_TICKET,), SECRET_TICKET, {SECRET_TICKET}, ["a"], ()])
def test_a_plain_list_or_tuple_is_rejected_with_a_type_error(bad):
    with pytest.raises(TypeError):
        redact_launch_secrets("x", bad)
    with pytest.raises(TypeError):
        redact_error(RuntimeError("x"), bad)
    with pytest.raises(TypeError):
        reraise_if_ticket_rejected(RuntimeError("x"), bad)


def test_a_duck_typed_lookalike_is_rejected_by_isinstance():
    import types
    real = launch_secret_values(_ARGV)
    for fake in (types.SimpleNamespace(exact=real.exact, boundary=real.boundary),
                 {"exact": real.exact, "boundary": real.boundary}):
        with pytest.raises(TypeError):
            redact_launch_secrets("x", fake)
        with pytest.raises(TypeError):
            redact_error(RuntimeError("x"), fake)
        with pytest.raises(TypeError):
            reraise_if_ticket_rejected(RuntimeError("x"), fake)


def test_a_short_ticket_value_is_boundary_only_and_a_long_one_is_removed_anywhere():
    for short in ("abc", "true", "1234567890abcde"):
        v = launch_secret_values(["--ant0-launch=" + short])
        assert v == _secrets(boundary=(short,))
        text = f"{short}ing is true, abcdef trueish {short}x --ant0-launch={short} --keep=1"
        assert redact_launch_secrets(text, v) == f"{short}ing is true, abcdef trueish {short}x --ant0-launch=<redacted> --keep=1"
    long = launch_secret_values(["--ant0-launch=0123456789abcdef"])
    assert long == _secrets(exact=("0123456789abcdef",))
    assert redact_launch_secrets("a&0123456789abcdef|b", long) == "a&<redacted>|b"


def test_no_secrets_means_the_regex_layer_only():
    assert redact_launch_secrets(f"chrome --ant0-launch={SECRET_TICKET} --keep=1", None) == "chrome --ant0-launch=<redacted> --keep=1"


def test_a_copied_launch_secrets_keeps_both_tuples():
    import copy as copy_module
    for dup in (copy_module.copy(launch_secret_values(_ARGV)), copy_module.deepcopy(launch_secret_values(_ARGV))):
        assert redact_launch_secrets(f"ticket={SECRET_TICKET}&x", dup) == "ticket=<redacted>&x"


def test_a_hand_built_launch_secrets_is_a_type_error():
    real = launch_secret_values(_ARGV)
    for build in (lambda: LaunchSecrets(exact=real.exact, boundary=real.boundary),
                  lambda: LaunchSecrets(),
                  lambda: LaunchSecrets(real.exact, real.boundary, object()),
                  lambda: LaunchSecrets(exact=real.exact, _token=None)):
        with pytest.raises(TypeError):
            build()


def test_launch_secrets_made_with_dataclasses_replace_is_a_type_error():
    import dataclasses
    with pytest.raises(TypeError):
        dataclasses.replace(launch_secret_values(_ARGV))
    with pytest.raises(TypeError):
        dataclasses.replace(launch_secret_values(_ARGV), exact=(SECRET_TICKET,))


def test_only_launch_secret_values_and_the_empty_default_hold_the_token():
    assert launch_secret_values(_ARGV) == _secrets(exact=(SECRET_PATH, SECRET_TICKET), boundary=(_UDD,))
    assert redact_launch_secrets("x", None) == "x"  # the module's own empty set is built with the token


# Playwright's launch failure: the command line on one `<launching>` line, then the process's stderr and exit.
def _pw_failure(argv_udd):
    return ("Target page, context or browser has been closed\nBrowser logs:\n\n"
            "<launching> /tmp/eng/chrome --headless --user-data-dir=%s --metadata-x --no-first-run\n"
            "[pid=1][err] chrome: exit 7 data\n<process did exit: exitCode=7, signal=null>" % argv_udd)


@pytest.mark.parametrize("udd", ["data", "exit", "/tmp", "chrome", "./data", "sub/exit"])
def test_a_short_or_common_profile_directory_does_not_mangle_the_text_around_it(udd):
    absolute = os.path.abspath(udd)
    out = redact_launch_secrets(_pw_failure(absolute), launch_secret_values([], [udd]))
    assert "--user-data-dir=<redacted> --metadata-x" in out
    assert "<launching> /tmp/eng/chrome --headless" in out
    assert "[pid=1][err] chrome: exit 7 data" in out
    assert "<process did exit: exitCode=7, signal=null>" in out
    assert "Target page, context or browser has been closed" in out
    assert "=" + absolute not in out


@pytest.mark.parametrize("udd", ["data", "exit", "/tmp", "chrome"])
def test_a_short_profile_directory_in_argv_goes_only_where_it_is_the_switch_value(udd):
    argv = ["--user-data-dir=" + udd, "--keep=1"]
    out = redact_launch_secrets("argv: %s exitCode=7 chrome exit /tmp/eng/chrome data" % " ".join(argv), launch_secret_values(argv))
    assert out == "argv: --user-data-dir=<redacted> --keep=1 exitCode=7 chrome exit /tmp/eng/chrome data"


def test_a_relative_profile_directory_is_redacted_in_the_absolute_form_playwright_logs():
    absolute = os.path.abspath("rel-profile")
    assert launch_secret_values([], ["rel-profile"]) == _secrets(boundary=("rel-profile", absolute))
    assert launch_secret_values(["--user-data-dir", "rel-profile"]) == _secrets(boundary=("rel-profile", absolute))
    assert redact_launch_secrets("--user-data-dir=%s x" % absolute, launch_secret_values([], ["rel-profile"])) \
        == "--user-data-dir=<redacted> x"


def test_the_longest_value_wins_when_one_secret_is_a_prefix_of_another_with_a_space():
    assert redact_launch_secrets("x /tmp/SECRETdir sub y", _boundary("/tmp/SECRETdir", "/tmp/SECRETdir sub")) == "x <redacted> y"


def test_a_secret_inside_a_longer_token_is_kept():
    assert redact_launch_secrets("a /opt/x/tmp b xABCDEFGHIJKLMNOP c", _boundary("/tmp", "ABCDEFGHIJKLMNOP")) == "a /opt/x/tmp b xABCDEFGHIJKLMNOP c"


def test_a_path_that_merely_starts_with_the_secret_is_kept():
    assert redact_launch_secrets("a /home/u/profile-2/x b /home/u/profile. c", _boundary("/home/u/profile")) \
        == "a /home/u/profile-2/x b <redacted>. c"


def test_a_short_bare_word_is_redacted_after_a_secret_switch_only():
    assert redact_launch_secrets("chrome exited --user-data-dir chrome --x", _boundary("chrome")) \
        == "chrome exited --user-data-dir <redacted> --x"
    assert redact_launch_secrets("tok ABCDEFGHIJKLMNOP end", _boundary("ABCDEFGHIJKLMNOP")) == "tok <redacted> end"


def test_matching_ignores_case_on_windows_only():
    secret = "C:\\Users\\A B\\ant0-persona.profile"
    text = "[err] cannot open c:\\users\\a b\\ant0-persona.profile"
    assert redact_launch_secrets(text, _exact(secret), ignore_case=True) == "[err] cannot open <redacted>"
    assert redact_launch_secrets(text, _exact(secret), ignore_case=False) == text


# The call sites hand the secrets over: launch() has the ticket, launch_persistent_context() also the profile
# directory (Playwright adds `--user-data-dir=<abs>` itself, so only the call site knows it). A ticket and a
# directory holding ' --x' are not caught by the switch pattern: only the exact values remove them whole.
SPACEY_TICKET = "SECRETlic.SECRETclaim --xSECRETsig.SECRETeng.SECRETcs.SECRETlast"


def _echo_engine(tmp_path):
    return _fake_engine(tmp_path, 'echo "argv: $@" >&2\nexit 1\n')


# A real Playwright driver is started: in a subprocess, so no driver or event loop outlives the test.
_CALL_SITE_SCRIPT = r"""
import asyncio, json, sys
exe, udd, ticket, kind = sys.argv[1:5]
common = dict(executable_path=exe, identity={"mode": "native"}, quiet=True, launch_ticket=ticket, headless=True)
try:
    if kind == "sync-launch":
        import ant0browser
        ant0browser.launch(ephemeral_profile=False, **common)
    elif kind == "sync-persistent":
        import ant0browser
        ant0browser.launch_persistent_context(udd, **common)
    elif kind == "async-launch":
        from ant0browser import async_api
        asyncio.run(async_api.launch(ephemeral_profile=False, **common))
    else:
        from ant0browser import async_api
        asyncio.run(async_api.launch_persistent_context(udd, **common))
except BaseException as exc:
    text = "\n".join([str(exc), repr(exc)] + [str(v) for v in getattr(exc, "__dict__", {}).values()])
    print(json.dumps({"text": text, "cause": exc.__cause__ is not None}))
else:
    print(json.dumps({"text": "NO ERROR", "cause": False}))
"""


def _call_site_failure(tmp_path, kind):
    import json
    import subprocess
    exe = _echo_engine(tmp_path)
    done = subprocess.run([sys.executable, "-c", _CALL_SITE_SCRIPT, str(exe), str(tmp_path / "udd --xSECRETtail"),
                           SPACEY_TICKET, kind], capture_output=True, text=True, timeout=120)
    return json.loads(done.stdout.strip().splitlines()[-1])


def _assert_redacted_cleanly(result, switch):
    text = result["text"]
    assert not result["cause"]
    assert switch in text and "SECRET" not in text and "--xSECRET" not in text and "exitCode=1" in text


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_sync_launch_without_ephemeral_profile_passes_the_ticket_to_the_redaction(tmp_path):
    _assert_redacted_cleanly(_call_site_failure(tmp_path, "sync-launch"), "--ant0-launch=<redacted>")


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_sync_launch_persistent_context_passes_the_profile_directory_to_the_redaction(tmp_path):
    _assert_redacted_cleanly(_call_site_failure(tmp_path, "sync-persistent"), "--user-data-dir=<redacted>")


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_async_launch_without_ephemeral_profile_passes_the_ticket_to_the_redaction(tmp_path):
    _assert_redacted_cleanly(_call_site_failure(tmp_path, "async-launch"), "--ant0-launch=<redacted>")


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_async_launch_persistent_context_passes_the_profile_directory_to_the_redaction(tmp_path):
    _assert_redacted_cleanly(_call_site_failure(tmp_path, "async-persistent"), "--user-data-dir=<redacted>")


def _fake_engine(tmp_path, body):
    exe = tmp_path / "chrome"
    exe.write_text("#!/bin/sh\n# %s\n%s" % (MARKER, body))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe


def _serve_fail(exe, **extra):
    with pytest.raises(Exception) as info:
        _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True,
                     launch_ticket=SECRET_TICKET, ready_timeout=5.0, **extra)
    return info.value, _full_chain(info.value)[0]


@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_serve_redacts_a_profile_directory_with_space_dash_dash_x(tmp_path):
    exe = _fake_engine(tmp_path, 'echo "argv: $@" >&2\nexit 1\n')
    error, text = _serve_fail(exe, user_data_dir=str(tmp_path / "udd --xSECRETtail"))
    assert error.code == "sdk.engine_not_ready"
    assert "<redacted>" in text and "SECRET" not in text


# Stderr shorter than the window is not truncated: the first line stays and is still redacted.
@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_serve_short_stderr_keeps_its_first_line_and_redacts_it(tmp_path):
    exe = _fake_engine(tmp_path, 'echo "FIRSTLINE argv: $@" >&2\necho SECONDLINE >&2\nexit 1\n')
    error, text = _serve_fail(exe)
    assert error.code == "sdk.engine_not_ready"
    assert "FIRSTLINE argv:" in text and "SECONDLINE" in text
    assert "<redacted>" in text and "SECRET" not in text


# The 8 KiB window starts inside the ticket's value; the partial first line must go.
@pytest.mark.skipif(sys.platform == "win32", reason="shell-script fake engine")
def test_serve_tail_cut_inside_a_switch_value_leaves_no_fragment(tmp_path):
    inside = 12
    head = "x" * 300 + f" --ant0-launch={SECRET_TICKET}"
    rest = "TAILMARK" + "z" * (8192 + inside - len(SECRET_TICKET) - 1 - len("TAILMARK"))
    dump = tmp_path / "stderr.txt"
    dump.write_text(head + "\n" + rest)
    exe = _fake_engine(tmp_path, "cat '%s' >&2\nexit 1\n" % dump)
    error, text = _serve_fail(exe)
    assert error.code == "sdk.engine_not_ready"
    assert "TAILMARK" in text and "SECRET" not in text and SECRET_TICKET[inside:] not in text
