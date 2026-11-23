"""The launch ticket travels in ANT0_LAUNCH of the engine child as well as in ``--ant0-launch=`` (the engine
reads the environment first; older engines read only argv). Playwright is stubbed at the call, so these assert
what actually reaches the engine."""
import asyncio
import os
import stat
import tempfile

import pytest

import ant0browser
from ant0browser import _serve, async_api
from ant0browser import _launch_ticket
from ant0browser._launch_ticket import (
    LAUNCH_TICKET_ENV, LaunchTicketRejectedError, apply_ticket_env, args_for_ticket_decision, caller_env_ticket, launch_secret_values, launch_ticket_rejection, redact_error,
    redact_launch_secrets, reraise_if_ticket_rejected,
)
from test_launch_gates import _async, _defaults, _exe, _run_async, _run_sync, _sync  # noqa: F401

MARKER = "ant0-browser-capabilities/persona-profile-v1"
TICKET = "SECRETaa.SECRETbb.SECRETcc.SECRETdd.SECRETee"
OTHER = "SECRETzz.SECRETyy.SECRETxx.SECRETww.SECRETvv"


@pytest.fixture(autouse=True)
def _no_env_ticket(monkeypatch):
    monkeypatch.delenv(LAUNCH_TICKET_ENV, raising=False)


@pytest.fixture(params=[("sync", "incognito"), ("sync", "persistent"), ("async", "incognito"), ("async", "persistent")],
                ids=lambda p: "-".join(p))
def run(request, monkeypatch):
    mode, path = request.param
    if mode == "sync":
        seen = _sync(monkeypatch)
        return lambda **kw: (_run_sync(path, **{"launch_ticket": TICKET, **kw}), seen["kw"])[1]
    seen = _async(monkeypatch)
    return lambda **kw: (asyncio.run(_run_async(path, **{"launch_ticket": TICKET, **kw})), seen["kw"])[1]


def argv_ticket(args):
    return [a[len("--ant0-launch="):] for a in args if a.startswith("--ant0-launch=")]


def test_the_same_ticket_is_in_argv_and_in_the_engine_env(run):
    kw = run()
    assert argv_ticket(kw["args"]) == [TICKET]
    assert kw["env"][LAUNCH_TICKET_ENV] == TICKET


def test_the_sdk_own_environment_is_never_written(run):
    before = dict(os.environ)
    run()
    assert LAUNCH_TICKET_ENV not in os.environ
    assert dict(os.environ) == before


def test_the_callers_other_env_entries_are_kept(run):
    kw = run(env={"KEEP_ME": "1"})
    assert kw["env"]["KEEP_ME"] == "1" and kw["env"][LAUNCH_TICKET_ENV] == TICKET


def test_a_callers_env_ticket_is_not_overwritten_and_is_mirrored_into_argv(run):
    kw = run(env={LAUNCH_TICKET_ENV: OTHER})
    assert kw["env"][LAUNCH_TICKET_ENV] == OTHER
    assert argv_ticket(kw["args"]) == [OTHER]  # the launch_ticket option adds no different second one


def test_a_callers_argv_ticket_is_mirrored_into_the_env(run):
    kw = run(launch_ticket=None, args=[f"--ant0-launch={OTHER}"])
    assert argv_ticket(kw["args"]) == [OTHER]
    assert kw["env"][LAUNCH_TICKET_ENV] == OTHER


def test_two_different_caller_tickets_are_both_left_alone(run):
    kw = run(args=[f"--ant0-launch={TICKET}"], env={LAUNCH_TICKET_ENV: OTHER})
    assert argv_ticket(kw["args"]) == [TICKET]
    assert kw["env"][LAUNCH_TICKET_ENV] == OTHER


def test_no_ticket_sets_nothing(run):
    kw = run(launch_ticket=False)
    assert argv_ticket(kw["args"]) == []
    assert LAUNCH_TICKET_ENV not in (kw.get("env") or {})


@pytest.mark.skipif(os.name == "nt", reason="the fake engine is a /bin/sh script")
def test_serve_child_sees_the_same_ticket_in_env_and_argv(tmp_path):
    out = tmp_path / "out"
    exe = tmp_path / "chrome"
    exe.write_text("#!/bin/sh\n# %s\nprintf '%%s' \"$ANT0_LAUNCH\" > '%s.env'\n"
                   "for a in \"$@\"; do case \"$a\" in --ant0-launch=*) printf '%%s' \"${a#--ant0-launch=}\" > '%s.argv';; esac; done\n"
                   "echo \"env dump: ANT0_LAUNCH=$ANT0_LAUNCH $*\" >&2\nexit 90\n" % (MARKER, out, out))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    with pytest.raises(LaunchTicketRejectedError) as info:
        _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True,
                     launch_ticket=TICKET, ready_timeout=5.0)
    assert (tmp_path / "out.env").read_text() == TICKET
    assert (tmp_path / "out.argv").read_text() == TICKET
    assert LAUNCH_TICKET_ENV not in os.environ
    # The engine echoed its environment on exit 90: nothing of the ticket reaches the error.
    assert "SECRET" not in str(info.value) and "SECRET" not in repr(vars(info.value))


@pytest.mark.skipif(os.name == "nt", reason="the fake engine is a /bin/sh script")
def test_serve_exit_90_redacts_the_env_ticket_when_no_argv_copy_carries_it(tmp_path):
    # Two different caller tickets are both left alone: the argv one is TICKET, the env one is OTHER. The engine
    # prints only the env value, so it can only be hidden by knowing the env value.
    exe = tmp_path / "chrome"
    exe.write_text("#!/bin/sh\n# %s\necho \"ANT0_LAUNCH=$ANT0_LAUNCH\" >&2\nexit 90\n" % MARKER)
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    with pytest.raises(LaunchTicketRejectedError) as info:
        _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True, launch_ticket=False,
                     ready_timeout=5.0, args=[f"--ant0-launch={TICKET}"], env={LAUNCH_TICKET_ENV: OTHER})
    assert "ANT0_LAUNCH=<redacted>" in str(info.value)
    assert "SECRET" not in str(info.value) and "SECRET" not in repr(vars(info.value))


class TestRedaction:
    def test_launch_secret_values_takes_the_env_ticket_as_an_exact_secret(self):
        secrets = launch_secret_values([], [], {LAUNCH_TICKET_ENV: OTHER})
        assert OTHER in secrets.exact
        assert redact_launch_secrets(f"env: ANT0_LAUNCH={OTHER}; PATH=/bin", secrets) == "env: ANT0_LAUNCH=<redacted>; PATH=/bin"
        assert launch_secret_values([], [], {}).exact == ()

    def test_an_env_dump_in_an_error_is_redacted_and_the_env_attribute_dropped(self):
        err = RuntimeError(f"launch failed\nenv: {{'ANT0_LAUNCH': '{TICKET}'}}")
        err.env = {LAUNCH_TICKET_ENV: TICKET}
        fresh = redact_error(err, launch_secret_values([], [], {LAUNCH_TICKET_ENV: TICKET}))
        assert "SECRET" not in str(fresh)
        assert not hasattr(fresh, "env")
        assert err.env[LAUNCH_TICKET_ENV] == TICKET  # the original is not modified

    def test_an_error_with_only_an_env_attribute_is_still_replaced(self):
        err = RuntimeError("spawn failed")
        err.env = {LAUNCH_TICKET_ENV: TICKET}
        assert not hasattr(redact_error(err, launch_secret_values([], [], {LAUNCH_TICKET_ENV: TICKET})), "env")

    @pytest.mark.parametrize("persistent", [False, True])
    def test_a_launch_failure_that_carries_the_env_is_rethrown_without_it(self, monkeypatch, persistent):
        boom = RuntimeError(f"Browser closed\nANT0_LAUNCH={TICKET}")
        boom.env = {LAUNCH_TICKET_ENV: TICKET}

        def fail(*_a, **_k):
            raise boom

        class _C:
            launch = staticmethod(fail)
            launch_persistent_context = staticmethod(fail)

        class _PW:
            chromium = _C()

        monkeypatch.setattr(ant0browser, "_playwright", lambda: _PW())
        with pytest.raises(RuntimeError) as info:
            if persistent:
                ant0browser.launch_persistent_context(tempfile.mkdtemp(), executable_path=_exe(), quiet=True, launch_ticket=TICKET)
            else:
                ant0browser.launch(executable_path=_exe(), quiet=True, launch_ticket=TICKET, ephemeral_profile=False)
        assert "SECRET" not in str(info.value)
        assert not hasattr(info.value, "env")


def test_claim_stale_maps_like_claim_expired():
    assert launch_ticket_rejection("x\nant0: launch ticket invalid (claim_stale)\ny") == "claim_stale"
    stale, expired = LaunchTicketRejectedError("claim_stale"), LaunchTicketRejectedError("claim_expired")
    assert (stale.code, stale.error_class) == (expired.code, expired.error_class)
    assert stale.reason == "claim_stale"
    assert str(stale).replace("claim_stale", "X") == str(expired).replace("claim_expired", "X")
    with pytest.raises(LaunchTicketRejectedError) as info:
        reraise_if_ticket_rejected(RuntimeError("Browser closed\nant0: launch ticket invalid (claim_stale)\n"))
    assert info.value.reason == "claim_stale"


# ------------------------------------------------------------------ an inherited ANT0_LAUNCH is not the caller's ticket
STALE = "STALE-INHERITED-TICKET"
FETCHED = "SECRETfa.SECRETfb.SECRETfc.SECRETfd.SECRETfe"
ENGINE = "149.0.7827.114-ant0.9"


@pytest.fixture
def stale_env(monkeypatch):
    """ANT0_LAUNCH=STALE in the SDK's own environment, a reachable (fake) daemon, and a record of its fetches."""
    monkeypatch.setenv(LAUNCH_TICKET_ENV, STALE)
    monkeypatch.setenv("ANT0_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("ANT0_TOKEN", "tok-test")
    fetches = []

    def fake_fetch(engine, daemon, *a, **k):
        fetches.append(engine)
        return FETCHED

    monkeypatch.setattr(_launch_ticket, "fetch_launch_ticket", fake_fetch)
    return fetches


def _clean(kw):
    return repr((kw["args"], kw.get("env")))


def test_stale_no_ticket_option_asks_the_daemon_and_carries_the_fetched_ticket(run, stale_env):
    kw = run(launch_ticket=None, engine_version=ENGINE)
    assert stale_env == [ENGINE]
    assert argv_ticket(kw["args"]) == [FETCHED]
    assert kw["env"][LAUNCH_TICKET_ENV] == FETCHED
    assert STALE not in _clean(kw)


def test_stale_with_no_ticket_at_all_leaves_the_engine_without_one(run, stale_env):
    kw = run(launch_ticket=False)
    assert stale_env == []
    assert argv_ticket(kw["args"]) == []
    assert kw["env"] is not None and LAUNCH_TICKET_ENV not in kw["env"]
    assert STALE not in _clean(kw)


def test_stale_with_an_explicit_launch_ticket_carries_that_ticket(run, stale_env):
    kw = run(launch_ticket=TICKET, engine_version=ENGINE)
    assert stale_env == []
    assert argv_ticket(kw["args"]) == [TICKET]
    assert kw["env"][LAUNCH_TICKET_ENV] == TICKET
    assert STALE not in _clean(kw)


def test_stale_with_an_argv_ticket_carries_that_ticket_and_does_not_fetch(run, stale_env):
    kw = run(launch_ticket=None, engine_version=ENGINE, args=[f"--ant0-launch={OTHER}"])
    assert stale_env == []
    assert argv_ticket(kw["args"]) == [OTHER]
    assert kw["env"][LAUNCH_TICKET_ENV] == OTHER
    assert STALE not in _clean(kw)


def test_stale_loses_to_an_explicit_env_ticket(run, stale_env):
    kw = run(launch_ticket=None, env={LAUNCH_TICKET_ENV: OTHER})
    assert stale_env == []
    assert argv_ticket(kw["args"]) == [OTHER]
    assert kw["env"][LAUNCH_TICKET_ENV] == OTHER
    assert STALE not in _clean(kw)


def test_stale_with_an_explicit_empty_env_ticket_is_no_ticket(run, stale_env):
    kw = run(launch_ticket=False, env={LAUNCH_TICKET_ENV: ""})
    assert LAUNCH_TICKET_ENV not in kw["env"]
    assert STALE not in _clean(kw)


def test_stale_is_left_in_the_sdk_own_environment(run, stale_env):
    run(launch_ticket=TICKET)
    assert os.environ[LAUNCH_TICKET_ENV] == STALE


def _fake_engine(tmp_path):
    out = tmp_path / "out"
    exe = tmp_path / "chrome"
    exe.write_text("#!/bin/sh\n# %s\nprintf '%%s' \"${ANT0_LAUNCH-UNSET}\" > '%s.env'\n"
                   "for a in \"$@\"; do case \"$a\" in --ant0-launch=*) printf '%%s' \"${a#--ant0-launch=}\" > '%s.argv';; esac; done\n"
                   "exit 90\n" % (MARKER, out, out))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe, out


@pytest.mark.skipif(os.name == "nt", reason="the fake engine is a /bin/sh script")
@pytest.mark.parametrize("kwargs, want_env, want_argv", [
    ({"launch_ticket": TICKET}, TICKET, TICKET),
    ({"launch_ticket": False}, "UNSET", None),
    ({"launch_ticket": False, "args": [f"--ant0-launch={OTHER}"]}, OTHER, OTHER),
], ids=["explicit", "none", "argv"])
def test_serve_with_stale_in_the_sdk_environment(tmp_path, stale_env, kwargs, want_env, want_argv):
    exe, out = _fake_engine(tmp_path)
    with pytest.raises(LaunchTicketRejectedError):
        _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True, ready_timeout=5.0, **kwargs)
    assert (tmp_path / "out.env").read_text() == want_env
    assert ((tmp_path / "out.argv").read_text() if (tmp_path / "out.argv").exists() else None) == want_argv


class TestApplyTicketEnv:
    ARG = f"--ant0-launch={TICKET}"

    def test_a_fresh_copy_is_always_returned_and_the_inherited_ticket_never_is(self, monkeypatch):
        monkeypatch.setenv(LAUNCH_TICKET_ENV, STALE)
        args, env = apply_ticket_env([], None)
        assert env is not os.environ and LAUNCH_TICKET_ENV not in env and args == []
        assert apply_ticket_env([self.ARG], None)[1][LAUNCH_TICKET_ENV] == TICKET
        given = {"KEEP": "1", LAUNCH_TICKET_ENV: STALE}
        _, out = apply_ticket_env([], given)
        assert out is not given and out == {"KEEP": "1"}
        assert given[LAUNCH_TICKET_ENV] == STALE and os.environ[LAUNCH_TICKET_ENV] == STALE

    def test_only_the_callers_explicit_env_counts(self, monkeypatch):
        monkeypatch.setenv(LAUNCH_TICKET_ENV, STALE)
        assert caller_env_ticket(None) is None and caller_env_ticket({}) is None
        assert caller_env_ticket({LAUNCH_TICKET_ENV: OTHER}) == OTHER
        assert args_for_ticket_decision(["--x"], None) == ["--x"]
        assert args_for_ticket_decision([], {LAUNCH_TICKET_ENV: OTHER}) == [f"--ant0-launch={OTHER}"]

    def test_on_windows_the_key_is_matched_case_insensitively(self):
        env = {"ant0_launch": STALE, "Path": "C:\\x", "ANT0_Launch": STALE}
        _, out = apply_ticket_env([self.ARG], env, None, True)
        assert [k for k in out if k.upper() == LAUNCH_TICKET_ENV] == [LAUNCH_TICKET_ENV]
        assert out[LAUNCH_TICKET_ENV] == TICKET and out["Path"] == "C:\\x"
        assert [k for k in apply_ticket_env([], env, None, True)[1] if k.upper() == LAUNCH_TICKET_ENV] == []
        caller = {"ant0_launch": OTHER}
        assert caller_env_ticket(caller, True) == OTHER
        args, mirrored = apply_ticket_env([], {**caller, "Path": "p"}, caller, True)
        assert args == [f"--ant0-launch={OTHER}"]
        assert [k for k in mirrored if k.upper() == LAUNCH_TICKET_ENV] == [LAUNCH_TICKET_ENV] and mirrored[LAUNCH_TICKET_ENV] == OTHER

    def test_elsewhere_a_lower_case_spelling_is_another_variable(self):
        _, out = apply_ticket_env([self.ARG], {"ant0_launch": "x"}, {"ant0_launch": OTHER}, False)
        assert out["ant0_launch"] == "x" and out[LAUNCH_TICKET_ENV] == TICKET
        assert caller_env_ticket({"ant0_launch": OTHER}, False) is None

    def test_the_space_form_is_not_parsed_or_mirrored(self):
        args, env = apply_ticket_env(["--ant0-launch", OTHER], None)
        assert LAUNCH_TICKET_ENV not in env and args == ["--ant0-launch", OTHER]

    def test_the_space_form_reaches_the_engine_unchanged_and_is_not_mirrored(self, run):
        kw = run(launch_ticket=None, args=["--ant0-launch", OTHER])
        assert "--ant0-launch" in kw["args"] and OTHER in kw["args"]
        assert argv_ticket(kw["args"]) == []
        assert LAUNCH_TICKET_ENV not in kw["env"]


# ------------------------------------------------------------------ one retry when a fetched ticket went stale
def _exit90(reason):
    return RuntimeError(f"BrowserType.launch: Browser closed\nant0: launch ticket invalid ({reason})\n<process did exit: exitCode=90>")


def _ticket_n(n):
    return f"SECRETf{n}.SECRETfb.SECRETfc.SECRETfd.SECRETfe"


@pytest.fixture
def daemon(monkeypatch):
    monkeypatch.setenv("ANT0_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("ANT0_TOKEN", "tok-test")
    state = {"fetches": 0}

    def fake_fetch(engine, daemon, *a, **k):
        state["fetches"] += 1
        return _ticket_n(state["fetches"])

    monkeypatch.setattr(_launch_ticket, "fetch_launch_ticket", fake_fetch)
    return state


@pytest.fixture(params=[("sync", "incognito"), ("sync", "persistent"), ("async", "incognito"), ("async", "persistent")],
                ids=lambda p: "-".join(p))
def failing(request, monkeypatch, daemon):
    """Run a launch whose engine always exits 90 with the given reasons (one per attempt, the last repeating)."""
    mode, path = request.param
    calls = []

    def build(reasons):
        def fail(**kw):
            calls.append(kw)
            raise _exit90(reasons[min(len(calls), len(reasons)) - 1])

        class _C:
            def launch(self, **kw):
                return fail(**kw)

            def launch_persistent_context(self, *a, **kw):
                return fail(**kw)

        class _AC:
            async def launch(self, **kw):
                return fail(**kw)

            async def launch_persistent_context(self, *a, **kw):
                return fail(**kw)

        class _PW:
            chromium = _C() if mode == "sync" else _AC()

            async def stop(self):
                pass

        if mode == "sync":
            monkeypatch.setattr(ant0browser, "_playwright", lambda: _PW())
        else:
            async def _start():
                return _PW()
            monkeypatch.setattr(async_api, "_start_driver", _start)
            monkeypatch.setattr(async_api, "_bind_driver", lambda *a, **k: None)

    def run(reasons, **kw):
        build(reasons)
        kw = {"launch_ticket": None, "engine_version": ENGINE, **kw}
        with pytest.raises(LaunchTicketRejectedError) as info:
            if mode == "sync":
                _run_sync(path, **kw)
            else:
                asyncio.run(_run_async(path, **kw))
        return info.value, calls

    return run


@pytest.mark.parametrize("reason", ["claim_expired", "claim_stale"])
def test_a_stale_fetched_ticket_is_retried_exactly_once_with_a_fresh_one(failing, daemon, reason):
    error, calls = failing([reason])
    assert len(calls) == 2 and daemon["fetches"] == 2
    assert argv_ticket(calls[0]["args"]) == [_ticket_n(1)]
    assert argv_ticket(calls[1]["args"]) == [_ticket_n(2)]
    assert calls[1]["env"][LAUNCH_TICKET_ENV] == _ticket_n(2)
    assert error.reason == reason  # the second failure surfaces as today


def test_there_is_never_a_third_attempt(failing):
    error, calls = failing(["claim_expired", "claim_stale"])
    assert len(calls) == 2 and error.reason == "claim_stale"


@pytest.mark.parametrize("reason", ["bad_signature", "wrong_engine", "missing", "past_grace", "claim_mismatch"])
def test_other_reasons_are_not_retried(failing, daemon, reason):
    error, calls = failing([reason])
    assert len(calls) == 1 and daemon["fetches"] == 1


@pytest.mark.parametrize("extra", [
    {"launch_ticket": TICKET},
    {"args": [f"--ant0-launch={OTHER}"]},
    {"env": {LAUNCH_TICKET_ENV: OTHER}},
], ids=["launch_ticket", "argv", "env"])
def test_a_ticket_the_caller_provided_is_not_retried(failing, daemon, extra):
    error, calls = failing(["claim_expired"], **extra)
    assert len(calls) == 1 and daemon["fetches"] == 0


@pytest.mark.skipif(os.name == "nt", reason="the fake engine is a /bin/sh script")
class TestServeRetry:
    def engine(self, tmp_path, reason):
        counter = tmp_path / "runs"
        exe = tmp_path / "chrome"
        exe.write_text("#!/bin/sh\n# %s\necho run >> '%s'\nfor a in \"$@\"; do case \"$a\" in --ant0-launch=*) echo \"${a#--ant0-launch=}\" >> '%s.tickets';; esac; done\n"
                       "echo 'ant0: launch ticket invalid (%s)' >&2\nexit 90\n" % (MARKER, counter, counter, reason))
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
        return exe, counter

    def serve(self, tmp_path, reason, **kw):
        exe, counter = self.engine(tmp_path, reason)
        with pytest.raises(LaunchTicketRejectedError) as info:
            _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True, ready_timeout=5.0,
                         engine_version=ENGINE, **{"launch_ticket": None, **kw})
        runs = counter.read_text().split() if counter.exists() else []
        tickets = (tmp_path / "runs.tickets").read_text().split() if (tmp_path / "runs.tickets").exists() else []
        return info.value, runs, tickets

    @pytest.mark.parametrize("reason", ["claim_expired", "claim_stale"])
    def test_retried_once_with_a_fresh_ticket(self, tmp_path, daemon, reason):
        error, runs, tickets = self.serve(tmp_path, reason)
        assert len(runs) == 2 and tickets == [_ticket_n(1), _ticket_n(2)] and error.reason == reason

    def test_other_reason_not_retried(self, tmp_path, daemon):
        _, runs, _ = self.serve(tmp_path, "bad_signature")
        assert len(runs) == 1

    @pytest.mark.parametrize("extra", [
        {"launch_ticket": TICKET}, {"launch_ticket": False, "args": [f"--ant0-launch={OTHER}"]},
        {"launch_ticket": False, "env": {LAUNCH_TICKET_ENV: OTHER}},
    ], ids=["launch_ticket", "argv", "env"])
    def test_caller_ticket_not_retried(self, tmp_path, daemon, extra):
        _, runs, _ = self.serve(tmp_path, "claim_expired", **extra)
        assert len(runs) == 1


class TestCallerEnvKeyNeverLeaves:
    """``_prepare`` parks the caller's env (it may hold a ticket) under ``_ant0_caller_env``; every launch path
    must consume it and never hand it to Playwright or leave it in an object a repr could show."""

    KEY = _launch_ticket.CALLER_ENV_KEY

    @pytest.mark.parametrize("mode,path", [("sync", "incognito"), ("sync", "persistent"), ("async", "incognito"),
                                            ("async", "persistent")])
    def test_launch_paths_do_not_pass_the_key_on(self, monkeypatch, mode, path):
        seen = _sync(monkeypatch) if mode == "sync" else _async(monkeypatch)
        env = {LAUNCH_TICKET_ENV: OTHER, "KEEP_ME": "1"}
        if mode == "sync":
            _run_sync(path, env=env)
        else:
            asyncio.run(_run_async(path, env=env))
        kw = seen["kw"]
        assert self.KEY not in kw and self.KEY not in repr(kw)
        assert kw["env"][LAUNCH_TICKET_ENV] == OTHER  # the ticket reaches the engine child through env only

    @pytest.mark.parametrize("mode", ["sync", "async"])
    def test_default_ephemeral_launch_does_not_pass_the_key_on(self, monkeypatch, mode):
        seen = _sync(monkeypatch) if mode == "sync" else _async(monkeypatch)
        kw = {"executable_path": _exe(), "quiet": True, "launch_ticket": False, "env": {LAUNCH_TICKET_ENV: OTHER}}
        if mode == "sync":
            ant0browser.launch(**kw)
        else:
            asyncio.run(async_api.launch(**kw))
        assert self.KEY not in seen["kw"] and self.KEY not in repr(seen["kw"])

    @pytest.mark.parametrize("mode,path", [("sync", "incognito"), ("sync", "persistent"), ("async", "incognito"),
                                            ("async", "persistent")])
    def test_a_failing_launch_error_does_not_show_the_key(self, monkeypatch, mode, path):
        class Boom(Exception):
            pass

        def fail(*_a, **_k):
            raise Boom("spawn failed")

        async def afail(*_a, **_k):
            raise Boom("spawn failed")

        seen = _sync(monkeypatch) if mode == "sync" else _async(monkeypatch)
        target = ant0browser._playwright().chromium if mode == "sync" else None
        if mode == "sync":
            monkeypatch.setattr(type(target), "launch", fail)
            monkeypatch.setattr(type(target), "launch_persistent_context", fail)
        else:
            pw = asyncio.run(async_api._start_driver())
            monkeypatch.setattr(type(pw.chromium), "launch", afail)
            monkeypatch.setattr(type(pw.chromium), "launch_persistent_context", afail)
        env = {LAUNCH_TICKET_ENV: OTHER}
        with pytest.raises(Boom) as err:
            _run_sync(path, env=env) if mode == "sync" else asyncio.run(_run_async(path, env=env))
        chain, e = [], err.value
        while e is not None:
            chain.append(e)
            e = e.__cause__ or e.__context__
        for e in chain:
            assert self.KEY not in repr(e) and self.KEY not in str(e) and self.KEY not in repr(vars(e))
        assert seen == {}

    @pytest.mark.skipif(os.name == "nt", reason="the fake engine is a /bin/sh script")
    def test_serve_does_not_pass_the_key_to_the_child_or_leave_it_in_the_error(self, tmp_path, monkeypatch):
        import subprocess
        popen_calls = []
        real = subprocess.Popen

        def spy(argv, **kw):
            popen_calls.append((list(argv), dict(kw.get("env") or {})))
            return real(argv, **kw)

        monkeypatch.setattr(_serve.subprocess, "Popen", spy)
        exe = tmp_path / "chrome"
        exe.write_text("#!/bin/sh\n# %s\necho 'ant0: launch ticket invalid (bad_signature)' >&2\nexit 90\n" % MARKER)
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
        with pytest.raises(LaunchTicketRejectedError) as info:
            _serve.serve(executable_path=str(exe), identity={"mode": "native"}, quiet=True, launch_ticket=False,
                         ready_timeout=5.0, env={LAUNCH_TICKET_ENV: OTHER})
        assert len(popen_calls) == 1
        argv, env = popen_calls[0]
        assert self.KEY not in env and not any(self.KEY in a for a in argv)
        assert self.KEY not in str(info.value) and self.KEY not in repr(vars(info.value))
