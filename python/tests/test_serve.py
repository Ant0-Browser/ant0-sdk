import json
import os
import urllib.request

import pytest

from ant0browser import Server, serve
from ant0browser._serve import _cdp_args, _parse_proxy
from ant0browser._warnings import coherence_warnings


def test_parse_proxy():
    d = _parse_proxy("http://user:pass@host:8080")
    assert d == {"server": "http://host:8080", "username": "user", "password": "pass"}
    d2 = _parse_proxy("host:3128")   # bare host:port -> http, no creds
    assert d2 == {"server": "http://host:3128"}


def test_server_handle_urls():
    class FakeProc:
        def poll(self):
            return None
    s = Server(FakeProc(), "127.0.0.1", 9222, "/tmp/x", own_udd=False)
    assert s.cdp_url == "http://127.0.0.1:9222"
    assert s.is_alive() is True


# Playwright adds these on launch(); a direct spawn got none of them, so the engine opened
# chrome://ungoogled-first-run (empty body) whenever the caller
# passed no start URL.
def test_cdp_args_order_hygiene_and_about_blank():
    origins = "http://127.0.0.1:45678,http://localhost:45678"
    cdp = _cdp_args(45678, "127.0.0.1", origins, "/tmp/udd", True, None, ["--no-sandbox"])
    assert cdp == [
        "--remote-debugging-port=45678",
        "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=" + origins,
        "--user-data-dir=/tmp/udd",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
        "--headless=new",
        "about:blank",
    ]


def test_cdp_args_headed_with_proxy_keeps_hygiene_and_no_feature_flags():
    cdp = _cdp_args(9222, "127.0.0.1", "*", "/tmp/udd", False, "http://127.0.0.1:3128", [])
    assert "--headless=new" not in cdp
    assert "--proxy-server=http://127.0.0.1:3128" in cdp
    for a in ("--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen"):
        assert cdp.count(a) == 1
    # The identity layer owns feature flags; hygiene must not add any.
    assert not any(a.startswith(("--enable-features=", "--disable-features=")) for a in cdp)
    assert cdp[-1] == "about:blank"


def test_cdp_args_no_about_blank_when_caller_passed_a_url():
    cdp = _cdp_args(9222, "127.0.0.1", "*", "/tmp/udd", True, None,
                    ["--no-sandbox", "https://example.com/"])
    assert "about:blank" not in cdp
    cdp2 = _cdp_args(9222, "127.0.0.1", "*", "/tmp/udd", True, None, ["about:blank"])
    assert "about:blank" not in cdp2


def test_hygiene_switches_do_not_trigger_automation_arg_warning():
    codes = {w["code"] for w in coherence_warnings({
        "_user_args": ["--no-first-run", "--no-default-browser-check",
                       "--disable-search-engine-choice-screen", "about:blank"],
        "headless": False,
    })}
    assert "automation-arg" not in codes


@pytest.mark.skipif(not os.environ.get("ANT0_BROWSER_TEST_BINARY"),
                    reason="set ANT0_BROWSER_TEST_BINARY to run the serve smoke test against a real binary")
def test_serve_smoke():
    srv = serve(executable_path=os.environ["ANT0_BROWSER_TEST_BINARY"], headless=True, quiet=True,
                identity={"mode": "native"},
                args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
                      "--enable-unsafe-swiftshader"])
    try:
        ver = json.load(urllib.request.urlopen(srv.cdp_url + "/json/version", timeout=8))
        assert "Chrome" in ver.get("Browser", "")
        assert ver.get("webSocketDebuggerUrl")   # attachable endpoint exists
    finally:
        srv.close()


# ---- temp-dir cleanup (fake engine: carries the capability marker, never opens a CDP port) ----
import subprocess
import sys
import textwrap

import pytest

_REPO_PY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _fake_engine(tmp_path):
    exe = tmp_path / "chrome"
    exe.write_text('#!/bin/sh\necho $$ > "%s"\nexec sleep 60\n# ant0-browser-capabilities/persona-profile-v1\n'
                   % (tmp_path / "pid"))
    exe.chmod(0o755)
    return str(exe), tmp_path / "pid"


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _wait_dead(pid, secs=5):
    import time
    end = time.time() + secs
    while time.time() < end and _alive(pid):
        time.sleep(0.05)
    return not _alive(pid)


def _serve_dirs(root):
    return [n for n in os.listdir(root) if n.startswith("ant0-browser-serve-")]


@pytest.mark.skipif(sys.platform == "win32", reason="uses a /bin/sh fake engine")
def test_failed_readiness_wait_kills_child_and_removes_temp_dir(tmp_path, monkeypatch):
    exe, pidfile = _fake_engine(tmp_path)
    priv = tmp_path / "tmp"
    priv.mkdir()
    monkeypatch.setenv("TMPDIR", str(priv))
    monkeypatch.setattr("tempfile.tempdir", None)
    with pytest.raises(Exception, match="did not come up"):
        serve(executable_path=exe, quiet=True, launch_ticket=False, ready_timeout=1.0)
    assert _serve_dirs(str(priv)) == []
    assert _wait_dead(int(pidfile.read_text()))


@pytest.mark.skipif(sys.platform == "win32", reason="uses a /bin/sh fake engine")
def test_interpreter_exit_during_readiness_wait_cleans_up(tmp_path):
    exe, pidfile = _fake_engine(tmp_path)
    priv = tmp_path / "tmp"
    priv.mkdir()
    code = textwrap.dedent("""
        import sys, threading, time
        sys.path.insert(0, %r)
        from ant0browser import serve
        threading.Thread(target=lambda: serve(executable_path=%r, quiet=True, launch_ticket=False,
                                              ready_timeout=30), daemon=True).start()
        time.sleep(2.5)
        import os
        print(len([n for n in os.listdir(os.environ["TMPDIR"]) if n.startswith("ant0-browser-serve-")]))
    """ % (_REPO_PY, exe))
    r = subprocess.run([sys.executable, "-c", code], env={**os.environ, "TMPDIR": str(priv)},
                       capture_output=True, text=True, timeout=60)
    assert r.stdout.strip().splitlines()[-1] == "1", r.stderr      # control: the dir existed at exit
    assert _wait_dead(int(pidfile.read_text()))
    assert _serve_dirs(str(priv)) == []


def test_close_never_removes_a_caller_supplied_dir_and_reaps_before_rmtree(tmp_path):
    udd = tmp_path / "persistent"
    udd.mkdir()
    (udd / "marker").write_text("keep")
    proc = subprocess.Popen([sys.executable, "-c", "import signal,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)"])
    import time
    time.sleep(0.5)
    srv = Server(proc, "127.0.0.1", 9222, str(udd), False)
    orig = proc.wait
    calls = []

    def fake_wait(timeout=None):
        calls.append(timeout)
        if timeout == 10:
            raise subprocess.TimeoutExpired("x", 10)
        return orig(timeout=timeout)
    proc.wait = fake_wait
    srv.close()                         # SIGTERM ignored -> wait(10) times out -> kill -> wait again
    assert calls == [10, 5] and proc.poll() is not None
    assert (udd / "marker").read_text() == "keep"


# ---- exit hook: SIGKILL for temp dirs, bounded budget ----
class _FakeProc:
    def __init__(self):
        self.signals = []

    def poll(self):
        return None

    def kill(self):
        self.signals.append("KILL")

    def terminate(self):
        self.signals.append("TERM")

    def wait(self, timeout=None):
        pass


def test_exit_hook_kills_temp_dir_children_and_terminates_persistent_ones():
    from ant0browser import _serve as s
    own, kept = _FakeProc(), _FakeProc()
    entries = {s._Entry(own, "/nonexistent/own"), s._Entry(kept, None)}
    saved = set(s._live)
    s._live.clear()
    s._live.update(entries)
    try:
        s._exit_cleanup(rmtree=lambda *a, **k: None, exists=lambda p: False)
    finally:
        s._live.clear()
        s._live.update(saved)
    assert own.signals == ["KILL"] and kept.signals == ["TERM"]


def test_exit_hook_budget_is_bounded_and_sleeps_between_tries():
    import time
    from ant0browser import _serve as s
    calls = []
    saved = set(s._live)

    def run(n):
        s._live.clear()
        s._live.update(s._Entry(_FakeProc(), "/nonexistent/stuck-%d" % i) for i in range(n))
        calls.clear()
        t0 = time.monotonic()
        # a dir that can never be removed
        s._exit_cleanup(rmtree=lambda *a, **k: calls.append(1), exists=lambda p: True)
        return time.monotonic() - t0

    try:
        one = run(1)
        assert s.EXIT_DIR_BUDGET - 0.1 <= one < s.EXIT_DIR_BUDGET + 0.6
        assert 2 < len(calls) < 60            # sleeps between tries; a spin loop would make thousands
        many = run(6)
        assert s.EXIT_TOTAL_BUDGET - 0.2 <= many < s.EXIT_TOTAL_BUDGET + 0.6
    finally:
        s._live.clear()
        s._live.update(saved)


def test_exit_hook_waits_for_children_against_one_shared_deadline():
    import time
    from ant0browser import _serve as s

    class Slow(_FakeProc):
        def wait(self, timeout=None):
            time.sleep(min(timeout, 5))       # never exits on its own
            raise subprocess.TimeoutExpired("x", timeout)
    saved = set(s._live)
    s._live.clear()
    s._live.update(s._Entry(Slow(), None) for _ in range(5))
    try:
        t0 = time.monotonic()
        s._exit_cleanup()
        assert time.monotonic() - t0 < s.EXIT_TOTAL_BUDGET + 0.6
    finally:
        s._live.clear()
        s._live.update(saved)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
def test_exit_hook_sigkill_stops_a_child_that_rewrites_its_dir_on_sigterm(tmp_path):
    priv = tmp_path / "tmp"
    priv.mkdir()
    code = textwrap.dedent("""
        import os, subprocess, sys, tempfile, time
        sys.path.insert(0, %r)
        from ant0browser._serve import Server
        d = tempfile.mkdtemp(prefix="ant0-browser-serve-")
        script = ("import signal,time,os\\n"
                  "def h(*a):\\n"
                  "    time.sleep(0.1); os.makedirs(%%r, exist_ok=True); open(os.path.join(%%r, 'Local State'), 'w').write('{}'); os._exit(0)\\n"
                  "signal.signal(signal.SIGTERM, h)\\n"
                  "time.sleep(60)\\n") %% (d, d)
        p = subprocess.Popen([sys.executable, "-c", script])
        time.sleep(0.6)
        Server(p, "127.0.0.1", 9222, d, True)
        print(p.pid, d)
    """ % _REPO_PY)
    r = subprocess.run([sys.executable, "-c", code], env={**os.environ, "TMPDIR": str(priv)},
                       capture_output=True, text=True, timeout=60)
    pid, d = r.stdout.split()
    assert _wait_dead(int(pid))
    import time
    time.sleep(0.5)
    assert not os.path.exists(d), r.stderr
