"""Persona file creation, the engine probe and temporary persona directories (parity with the Node SDK)."""

import json
import os
import stat
import sys
import tempfile
import time
from pathlib import Path

import pytest

from ant0browser import _profile_file as pf
from ant0browser._profile_file import PROFILE_FILE_NAME

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="the fake engines are /bin/sh scripts")
SID = "S-1-5-21-1111111111-2222222222-3333333333-1001"


def v4():
    return {
        "schema_version": 4, "schema_revision": 1, "requires": ["display"],
        "provenance": {"source": "synthetic", "model": {"version": "population-model-v2.2", "sha256": "0" * 64}},
        "identity": {
            "os": {"family": "windows", "release": "windows-11", "platform_version": "19.0.0",
                   "architecture": "x86_64"},
            "engine": {"family": "blink", "major": 158}, "brand": {"id": "edge", "version": "158.0.4370.16"},
            "form_factor": "desktop", "device_model": "",
        },
        "surfaces": {"display": {"width": 1920}},
    }


def v2():
    return json.loads((FIXTURES / "persona-v2.json").read_text(encoding="utf-8"))


CAPABILITIES = ["navigator","navigator.ua_ch","display","input","gpu.webgl","gpu.webgpu","fonts","speech","audio","media.decoding","media.devices","network"]


def info(schemas, protocol=2, **extra):
    persona = {"schemas": schemas, "revision": 1, "engine_family": "blink", "engine_major": 158,
               "capabilities": CAPABILITIES, **extra}
    return json.dumps({"sdk_protocol": protocol, "persona": persona})


def sh(tmp_path, body, name="chrome"):
    path = tmp_path / name
    path.write_text(f"#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\n{body}\n")
    path.chmod(0o755)
    return str(path)


@pytest.fixture(autouse=True)
def _fresh_cache():
    pf.reset_engine_probe_cache()
    yield
    pf.reset_engine_probe_cache()


@pytest.fixture
def opens(monkeypatch):
    """Record every os.open the persona writer makes: path, flags, mode and the file size beforehand."""
    calls = []
    real = os.open

    def spy(path, flags, mode=0o777, *a, **k):
        try:
            size = os.stat(path).st_size
        except OSError:
            size = -1
        calls.append({"path": str(path), "flags": flags, "mode": mode, "size": size})
        return real(path, flags, mode, *a, **k)

    monkeypatch.setattr(pf.os, "open", spy)
    return calls


class TestTemporaryFileCreation:
    def test_created_exclusively_with_mode_0600_before_any_content(self, tmp_path, opens):
        pf.write_persona_profile_file(tmp_path / "udd", v4(), run=lambda f, a: "", platform="linux")
        temps = [o for o in opens if o["path"].endswith(".tmp")]
        creation = temps[0]
        assert creation["flags"] & os.O_EXCL == os.O_EXCL          # a planted file is an error
        assert creation["flags"] & os.O_CREAT == os.O_CREAT
        assert creation["mode"] == 0o600                            # private at creation, not chmod-ed after
        assert creation["size"] == -1                               # nothing existed, nothing written
        # the content goes through the descriptor of that exclusive create: the path is opened exactly once
        # (nothing to follow or swap in between, and no second open to fail on Windows)
        assert len(temps) == 1

    @posix_only
    def test_ends_as_0600_under_a_permissive_umask(self, tmp_path):
        old = os.umask(0)
        try:
            path = pf.write_persona_profile_file(tmp_path / "udd", v4(), run=lambda f, a: "", platform="linux")
        finally:
            os.umask(old)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


class TestWindowsPrivacyAtCreation:
    def test_restricts_the_empty_temp_file_by_sid_before_writing(self, tmp_path):
        udd = tmp_path / "udd"
        calls = []

        def run(file, args):
            temp = next((p for p in udd.iterdir() if p.name.endswith(".tmp")), None)
            calls.append({"file": file, "args": list(args), "size": temp.stat().st_size if temp else -1,
                          "names": sorted(p.name for p in udd.iterdir())})
            return f'"DOMAIN\\user","{SID}"\r\n' if file == "whoami" else ""

        path = pf.write_persona_profile_file(udd, v4(), run=run, platform="win32")
        assert [c["file"] for c in calls] == ["whoami", "icacls"]
        assert calls[0]["args"] == ["/user", "/fo", "csv", "/nh"]
        assert calls[1]["args"][0].endswith(".tmp")                 # the temporary file, not the final name
        assert calls[1]["args"][1:] == ["/inheritance:r", "/grant:r", f"*{SID}:F"]
        assert all(c["size"] == 0 for c in calls)                    # still empty when restricted
        assert PROFILE_FILE_NAME not in calls[1]["names"]
        assert os.stat(path).st_size > 0
        assert [p.name for p in udd.iterdir()] == [PROFILE_FILE_NAME]

    def test_grants_by_sid_not_by_account_name_and_uses_argument_lists(self, tmp_path):
        seen = []

        def run(file, args):
            seen.append([file, *args])
            return f'"A\\b","{SID}"' if file == "whoami" else ""

        pf.write_persona_profile_file(tmp_path / "udd", v4(), run=run, platform="win32")
        assert not any("\\" in part for cmd in seen for part in cmd)
        assert all(isinstance(part, str) for cmd in seen for part in cmd)

    def test_icacls_failure_fails_the_write_and_leaves_nothing(self, tmp_path):
        udd = tmp_path / "udd"

        def run(file, args):
            if file == "icacls":
                raise OSError("denied")
            return f'"A\\b","{SID}"'

        with pytest.raises(Exception) as err:
            pf.write_persona_profile_file(udd, v4(), run=run, platform="win32")
        assert err.value.code == "sdk.profile_file_unsafe"
        assert list(udd.iterdir()) == []

    @pytest.mark.parametrize("out", ["", "garbage", '"A\\b","not-a-sid"'])
    def test_no_sid_fails_the_write(self, tmp_path, out):
        udd = tmp_path / "udd"
        with pytest.raises(Exception) as err:
            pf.write_persona_profile_file(udd, v4(), run=lambda f, a: out, platform="win32")
        assert err.value.code == "sdk.profile_file_unsafe"
        assert list(udd.iterdir()) == []

    def test_whoami_failure_fails_the_write(self, tmp_path):
        def run(file, args):
            raise OSError("no whoami")

        with pytest.raises(Exception) as err:
            pf.write_persona_profile_file(tmp_path / "udd", v4(), run=run, platform="win32")
        assert err.value.code == "sdk.profile_file_unsafe"

    def test_parses_the_sid(self):
        assert pf.current_user_sid(lambda f, a: f'"CORP\\ann lee","{SID}"\r\n') == SID


class TestEngineProbe:
    @posix_only
    def test_kills_an_engine_that_ignores_sigterm_the_process_is_gone(self, tmp_path):
        pid_file = tmp_path / "pid"
        engine = sh(tmp_path, f"trap '' TERM; echo $$ > '{pid_file}'; exec sleep 30")
        t0 = time.time()
        assert pf.probe_sdk_info(engine, timeout=0.3) == (False, "")
        assert time.time() - t0 < 3
        pid = int(pid_file.read_text().strip())

        def alive():
            try:
                os.kill(pid, 0)
            except OSError:
                return False
            # a zombie that is not reaped yet still answers kill(0); the probe waited, so it is reaped
            return True

        for _ in range(50):
            if not alive():
                break
            time.sleep(0.02)
        assert not alive()

    @posix_only
    def test_runs_the_engine_with_a_private_profile_dir_and_isolating_arguments(self, tmp_path):
        out = tmp_path / "argv"
        engine = sh(tmp_path, f"""for a in "$@"; do echo "$a"; done > '{out}'
for a in "$@"; do case "$a" in --user-data-dir=*) [ -d "${{a#--user-data-dir=}}" ] && echo EXISTS >> '{out}';; esac; done
echo '{info([2, 4])}'""")
        completed, _ = pf.probe_sdk_info(engine)
        assert completed is True
        lines = out.read_text().split("\n")
        udd = next(l for l in lines if l.startswith("--user-data-dir="))[len("--user-data-dir="):]
        assert "ant0sdk-probe-" in udd and udd.startswith(tempfile.gettempdir())
        assert "EXISTS" in lines                       # it existed while the engine ran
        for want in ("--headless=new", "--no-first-run", "--no-default-browser-check", "--ant0-sdk-info"):
            assert want in lines
        assert not os.path.exists(udd)                 # and is gone afterwards

    @posix_only
    def test_answers_when_the_process_exits_even_if_a_child_holds_stdout(self, tmp_path):
        engine = sh(tmp_path, f"echo '{info([2, 4])}'; sleep 3 &")
        t0 = time.time()
        completed, out = pf.probe_sdk_info(engine, timeout=5)
        assert completed is True
        assert pf.parse_sdk_info_schemas(out) == [2, 4]
        assert time.time() - t0 < 3

    @posix_only
    def test_caps_the_output(self, tmp_path):
        engine = sh(tmp_path, "exec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 100000")
        assert pf.probe_sdk_info(engine, timeout=5, max_bytes=4096) == (False, "")

    def test_a_missing_executable_is_not_completed(self, tmp_path):
        assert pf.probe_sdk_info(str(tmp_path / "nope")) == (False, "")

    def test_timeout_is_five_seconds(self):
        assert pf.SDK_INFO_TIMEOUT == 5

    def test_caches_by_path_size_and_mtime_modern_for_good_old_for_ten_minutes_timeout_for_30_seconds(self, tmp_path):
        engine = tmp_path / "chrome"
        engine.write_text("x")
        # (completed, timed_out, stdout)
        answers = [(False, False, ""), (False, False, ""),      # spawn errors: never cached
                   (False, True, ""),                           # timeout: cached for 30 seconds
                   (True, False, info([2])),                    # completed but old
                   (True, False, info([2, 4]))]                 # then a modern engine
        n = {"calls": 0}
        clock = {"t": 1000.0}

        def probe(_exe):
            r = answers[min(n["calls"], len(answers) - 1)]
            n["calls"] += 1
            return r

        def get():
            return pf.engine_persona_schemas(engine, probe, lambda: clock["t"])

        assert get() == [2]
        assert get() == [2]
        assert n["calls"] == 2                                   # spawn errors: asked again each time
        assert get() == [2]
        assert n["calls"] == 3
        clock["t"] += 20
        assert get() == [2]
        assert n["calls"] == 3                                   # the timeout is remembered
        clock["t"] += 20                                         # 40 s in: the 30 s entry expired
        assert get() == [2]
        assert n["calls"] == 4                                   # completed but old
        clock["t"] += 9 * 60
        get()
        assert n["calls"] == 4                                   # old-engine answer cached as well
        clock["t"] += 2 * 60
        assert get() == [2, 4]
        assert n["calls"] == 5
        clock["t"] += 24 * 3600
        assert get() == [2, 4]
        assert n["calls"] == 5                                   # a modern answer does not expire
        engine.write_text("changed binary")                      # size changes: probe again
        get()
        assert n["calls"] == 6

    @posix_only
    def test_a_first_run_slower_than_the_timeout_is_retried_after_30_seconds_and_then_seen_as_schema_4(self, tmp_path):
        marker = tmp_path / "ran"
        engine = sh(tmp_path, f"if [ ! -e '{marker}' ]; then : > '{marker}'; exec sleep 30; fi\necho '{info([2, 4])}'")
        clock = {"t": 5000.0}
        n = {"calls": 0}

        def probe(exe):
            n["calls"] += 1
            return pf.probe_sdk_info_detailed(exe, timeout=0.4)

        def get():
            return pf.engine_persona_schemas(engine, probe, lambda: clock["t"])

        assert get() == [2]                                      # timed out
        clock["t"] += 29
        assert get() == [2]                                      # cached timeout
        assert n["calls"] == 1
        clock["t"] += 2                                          # 31 s: the window is over
        assert get() == [2, 4]
        assert n["calls"] == 2
        clock["t"] += 7 * 24 * 3600
        assert get() == [2, 4]
        assert n["calls"] == 2                                   # schema 4 is kept for good

    def test_an_old_engine_that_times_out_costs_the_wait_once(self, tmp_path):
        engine = tmp_path / "chrome"
        engine.write_text("x")
        n = {"calls": 0}

        def probe(_exe):
            n["calls"] += 1
            return (False, True, "")

        persona = v4()
        for _ in range(3):
            with pytest.raises(pf.SdkRuntimeError) as err:
                pf.stage_persona_profile({"fingerprint_profile": persona}, str(engine), str(tmp_path / "udd"),
                                         probe=probe, run=lambda *_: "", platform="linux")
            assert err.value.code == "sdk.persona_requires_engine"
        assert n["calls"] == 1

    @posix_only
    def test_the_probe_disables_networking_updates_and_crash_reporting_and_points_every_home_at_the_probe_dir(self, tmp_path):
        out = tmp_path / "seen"
        engine = sh(tmp_path, f"""{{ echo "$@"; echo "$HOME|$USERPROFILE|$APPDATA|$LOCALAPPDATA|$XDG_CONFIG_HOME|$XDG_DATA_HOME|$XDG_CACHE_HOME|$XDG_STATE_HOME|$XDG_RUNTIME_DIR|$TMPDIR"; }} > '{out}'
exec sleep 30""")
        pf.probe_sdk_info_detailed(engine, timeout=0.4)
        arg_line, env_line = out.read_text().strip().split("\n")
        for sw in ("--disable-background-networking", "--disable-component-update", "--no-first-run",
                   "--disable-breakpad", "--disable-crash-reporter", "--headless=new", "--proxy-server=127.0.0.1:9",
                   "--ant0-sdk-info"):
            assert sw in arg_line.split(" "), sw
        dirs = env_line.split("|")
        assert len(dirs) == 10 and len(set(dirs)) == 1 and "ant0sdk-probe-" in dirs[0]
        assert dirs[0] != os.environ.get("HOME")
        assert f"--user-data-dir={dirs[0]}" in arg_line

    @posix_only
    def test_the_probe_dir_path_is_short_also_when_tmpdir_is_long(self, tmp_path, monkeypatch):
        short = pf.make_probe_dir()
        try:
            assert len(short) <= pf.PROBE_DIR_MAX_LENGTH + 6
        finally:
            os.rmdir(short)
        long_base = tmp_path / ("a" * 40) / ("b" * 40)
        long_base.mkdir(parents=True)
        monkeypatch.setattr(tempfile, "tempdir", str(long_base))
        d = pf.make_probe_dir()
        try:
            assert not d.startswith(str(long_base)) and len(d) <= pf.PROBE_DIR_MAX_LENGTH + 6
        finally:
            os.rmdir(d)

    @posix_only
    def test_a_timed_out_probe_takes_its_whole_process_group_with_it(self, tmp_path):
        pids = tmp_path / "pids"
        engine = sh(tmp_path, f"sleep 60 &\necho $! > '{pids}'\nexec sleep 60")
        completed, timed_out, _ = pf.probe_sdk_info_detailed(engine, timeout=0.5)
        assert (completed, timed_out) == (False, True)
        grandchild = int(pids.read_text().strip())
        alive = True
        for _ in range(40):
            try:
                os.kill(grandchild, 0)
                time.sleep(0.05)
            except OSError:
                alive = False
                break
        assert not alive

    @posix_only
    def test_probe_child_temp_dirs_are_the_probe_dir_and_leave_nothing_behind(self, tmp_path):
        marker = f"m{os.getpid()}{time.time_ns()}"
        out = tmp_path / "env"
        engine = sh(tmp_path, f"""echo "$TMPDIR|$TMP|$TEMP" > '{out}'
mkdir "$TMPDIR/org.chromium.Chromium.{marker}"; : > "$TMPDIR/org.chromium.Chromium.{marker}/SingletonSocket"
exec sleep 30""")
        assert pf.probe_sdk_info_detailed(engine, timeout=0.4) == (False, True, "")
        a, b, c = out.read_text().strip().split("|")
        assert "ant0sdk-probe-" in a and b == a and c == a
        assert not os.path.exists(a)                             # the probe dir and its contents are gone
        assert not os.path.exists(os.path.join(tempfile.gettempdir(), f"org.chromium.Chromium.{marker}"))

    def test_a_probe_that_raises_is_unknown_and_not_cached(self, tmp_path):
        engine = tmp_path / "chrome"
        engine.write_text("x")
        n = {"calls": 0}

        def probe(_exe):
            n["calls"] += 1
            raise RuntimeError("boom")

        assert pf.engine_persona_schemas(engine, probe) == [2]
        pf.engine_persona_schemas(engine, probe)
        assert n["calls"] == 2

    @posix_only
    def test_an_engine_that_exits_nonzero_is_old_and_cached(self, tmp_path):
        engine = sh(tmp_path, "exit 3")
        assert pf.engine_persona_schemas(engine) == [2]
        Path(engine).write_text("#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\ncat <<'JSON'\n" + info([2, 4]) + "\nJSON\n")  # a different binary
        assert pf.engine_persona_schemas(engine) == [2, 4]


SHARED = json.loads((FIXTURES / "sdk-info-parse.json").read_text(encoding="utf-8"))["cases"]


class TestParseSdkInfo:
    # The same file is run by the Node suite: both SDKs must read every output the same way.
    @pytest.mark.parametrize("case", SHARED, ids=[c["name"] for c in SHARED])
    def test_shared_case(self, case):
        assert pf.parse_sdk_info_schemas(case["output"]) == case["expected"]

    @pytest.mark.parametrize("case", [c for c in json.loads((FIXTURES / "sdk-info-parse.json").read_text())["cases"]
                                      if "expected_info" in c], ids=lambda c: c["name"])
    def test_shared_persona_member(self, case):
        assert pf.parse_sdk_info(case["output"]) == case["expected_info"]

    def test_pretty_printed_record(self):
        assert pf.parse_sdk_info_schemas(
            json.dumps({"sdk_protocol": 2, "persona": {"schemas": [2, 4]}}, indent=2)) == [2, 4]
        assert pf.parse_sdk_info_schemas(f"{info([2, 4])}\ntrailing text") == [2, 4]


class TestStaleAndTemporaryFiles:
    def test_a_launch_without_schema4_removes_the_stale_file_and_only_that(self, tmp_path):
        udd = tmp_path / "udd"
        udd.mkdir()
        (udd / PROFILE_FILE_NAME).write_text("old persona")
        (udd / "ant0-persona.profile.bak").write_text("keep")
        (udd / "Preferences").write_text("keep")
        fp = {"fingerprint_profile": v2()}
        assert pf.stage_persona_profile(fp, "/nonexistent/chrome", udd) is fp
        assert sorted(p.name for p in udd.iterdir()) == ["Preferences", "ant0-persona.profile.bak"]

    @pytest.mark.skipif(sys.platform == "win32", reason="symlinks")
    def test_a_symlink_is_unlinked_not_followed(self, tmp_path):
        udd = tmp_path / "udd"
        udd.mkdir()
        outside = tmp_path / "secret"
        outside.write_text("do not touch")
        (udd / PROFILE_FILE_NAME).symlink_to(outside)
        assert pf.remove_stale_persona_file(udd) is True
        assert not os.path.lexists(udd / PROFILE_FILE_NAME)
        assert outside.read_text() == "do not touch"

    def test_an_empty_user_data_dir_never_touches_the_current_directory(self, tmp_path, monkeypatch):
        (tmp_path / PROFILE_FILE_NAME).write_text("mine, not stale")
        monkeypatch.chdir(tmp_path)
        fp = {"fingerprint_profile": v2()}
        assert pf.stage_persona_profile(fp, "/nonexistent/chrome", "") is fp
        assert pf.remove_stale_persona_file("") is False
        assert (tmp_path / PROFILE_FILE_NAME).read_text() == "mine, not stale"
        # a schema 4 persona goes to a private temp dir (like an incognito launch), never the cwd
        out = pf.stage_persona_profile({"fingerprint_profile": v4()}, "/x/chrome", "",
                                       probe=lambda _e: (True, info([2, 4])), run=lambda f, a: "", platform="linux")
        path = out["fingerprint_profile_file"]
        assert path.startswith(tempfile.gettempdir()) and not path.startswith(str(tmp_path))
        assert (tmp_path / PROFILE_FILE_NAME).read_text() == "mine, not stale"
        assert [p.name for p in tmp_path.iterdir()] == [PROFILE_FILE_NAME]
        pf.cleanup_persona_temp_dir(os.path.dirname(path))
        assert not os.path.exists(path)

    def test_a_directory_with_that_name_and_a_missing_dir_are_left_alone(self, tmp_path):
        (tmp_path / PROFILE_FILE_NAME).mkdir()
        assert pf.remove_stale_persona_file(tmp_path) is False
        assert (tmp_path / PROFILE_FILE_NAME).is_dir()
        assert pf.remove_stale_persona_file(tmp_path / "missing") is False

    def test_incognito_uses_a_registered_temp_dir_that_cleanup_removes(self, tmp_path):
        fp = pf.stage_persona_profile({"fingerprint_profile": v4()}, "/x/chrome", None,
                                      probe=lambda _e: (True, info([2, 4])), run=lambda f, a: "", platform="linux")
        path = fp["fingerprint_profile_file"]
        directory = os.path.dirname(path)
        assert directory in pf._live_temps and os.path.isfile(path)
        pf.cleanup_persona_temp_dir(directory)
        pf.cleanup_persona_temp_dir(directory)       # twice is fine
        assert not os.path.exists(directory) and directory not in pf._live_temps
        pf.cleanup_persona_temp_dir(None)

    def test_one_process_wide_exit_handler_not_one_per_launch(self, monkeypatch):
        registered = []
        monkeypatch.setattr(pf.atexit, "register", lambda fn, *a: registered.append(fn))
        monkeypatch.setattr(pf, "_exit_handler_installed", False)
        dirs = []
        try:
            for _ in range(3):
                fp = pf.stage_persona_profile({"fingerprint_profile": v4()}, "/x/chrome", None,
                                              probe=lambda _e: (True, info([2, 4])), run=lambda f, a: "",
                                              platform="linux")
                dirs.append(os.path.dirname(fp["fingerprint_profile_file"]))
            assert registered == [pf._cleanup_all_temps]
            pf._cleanup_all_temps()                  # what the single handler does at exit
            assert not any(os.path.exists(d) for d in dirs)
            assert not pf._live_temps
        finally:
            for d in dirs:
                pf.cleanup_persona_temp_dir(d)

    def test_a_failed_write_removes_the_temp_dir(self, tmp_path):
        before = set(pf._live_temps)

        def run(f, a):
            raise OSError("boom")

        with pytest.raises(Exception):
            pf.stage_persona_profile({"fingerprint_profile": v4()}, "/x/chrome", None,
                                     probe=lambda _e: (True, info([2, 4])), run=run, platform="win32")
        assert set(pf._live_temps) == before

    def test_cleanup_when_closed_hooks_the_right_event(self, tmp_path):
        directory = tmp_path / "d"
        directory.mkdir()

        class Browser:        # a Playwright Browser: has "contexts", closes with "disconnected"
            contexts = []

            def __init__(self):
                self.handlers = {}

            def on(self, name, fn):
                self.handlers[name] = fn

        class Context(Browser):       # a BrowserContext: has "pages", closes with "close"
            pages = []

        b, c = Browser(), Context()
        pf.cleanup_when_closed(b, str(directory))
        pf.cleanup_when_closed(c, str(directory))
        assert list(b.handlers) == ["disconnected"] and list(c.handlers) == ["close"]
        b.handlers["disconnected"]()
        assert not directory.exists()


class TestExclusiveCreateDescriptor:
    """The descriptor of the exclusive create is the only handle; every error path closes it and removes the file."""

    @pytest.fixture
    def fds(self, monkeypatch):
        seen = []
        real = os.open

        def spy(path, *a, **k):
            fd = real(path, *a, **k)
            if str(path).endswith(".tmp"):
                seen.append(fd)
            return fd

        monkeypatch.setattr(os, "open", spy)
        return seen

    @staticmethod
    def is_closed(fd):
        try:
            os.fstat(fd)
        except OSError:
            return True
        return False

    def test_the_temp_path_is_opened_exactly_once_and_closed_exactly_once(self, tmp_path, fds, monkeypatch):
        explicit = []
        real_close = os.close
        monkeypatch.setattr(os, "close", lambda fd: (explicit.append(fd), real_close(fd))[1])
        pf.write_persona_profile_file(tmp_path, v4(), run=lambda *_: "", platform="linux")
        assert len(fds) == 1 and self.is_closed(fds[0])
        assert fds[0] not in explicit  # the stream closed it; no second close of the same number

    def test_a_failing_write_closes_the_descriptor_and_leaves_nothing(self, tmp_path, fds, monkeypatch):
        def boom(_fd):
            raise OSError("disk full")

        monkeypatch.setattr(os, "fsync", boom)
        with pytest.raises(OSError, match="disk full"):
            pf.write_persona_profile_file(tmp_path, v4(), run=lambda *_: "", platform="linux")
        assert len(fds) == 1 and self.is_closed(fds[0])
        assert list(tmp_path.iterdir()) == []

    def test_a_failing_icacls_closes_the_descriptor_and_leaves_nothing(self, tmp_path, fds):
        def run(file, args):
            if file == "icacls":
                raise OSError("denied")
            return f'"A\\b","{SID}"'

        with pytest.raises(Exception) as err:
            pf.write_persona_profile_file(tmp_path, v4(), run=run, platform="win32")
        assert err.value.code == "sdk.profile_file_unsafe"
        assert len(fds) == 1 and self.is_closed(fds[0])
        assert list(tmp_path.iterdir()) == []

    def test_a_failure_before_the_stream_exists_still_closes_the_descriptor(self, tmp_path, fds, monkeypatch):
        def boom(*_a, **_k):
            raise OSError("no stream")

        monkeypatch.setattr(os, "fdopen", boom)
        with pytest.raises(OSError, match="no stream"):
            pf.write_persona_profile_file(tmp_path, v4(), run=lambda *_: "", platform="linux")
        assert len(fds) == 1 and self.is_closed(fds[0])
        assert list(tmp_path.iterdir()) == []

    def test_a_failed_rename_removes_the_temp_file(self, tmp_path, fds, monkeypatch):
        def boom(*_a):
            raise OSError("rename failed")

        monkeypatch.setattr(os, "replace", boom)
        with pytest.raises(OSError, match="rename failed"):
            pf.write_persona_profile_file(tmp_path, v4(), run=lambda *_: "", platform="linux")
        assert self.is_closed(fds[0])
        assert list(tmp_path.iterdir()) == []

    def test_a_failing_cleanup_unlink_keeps_the_original_error(self, tmp_path, fds, monkeypatch):
        # Windows: the unlink of the temporary file can fail with PermissionError (a handle is still open).
        def rename_fails(*_a):
            raise OSError("rename failed")

        def unlink_denied(_path, *_a, **_k):
            raise PermissionError("[WinError 32] in use")

        monkeypatch.setattr(os, "replace", rename_fails)
        monkeypatch.setattr(os, "unlink", unlink_denied)
        with pytest.raises(OSError, match="rename failed") as err:
            pf.write_persona_profile_file(tmp_path, v4(), run=lambda *_: "", platform="linux")
        assert not isinstance(err.value, PermissionError)

    def test_the_exclusive_create_adds_o_binary_when_the_platform_has_it(self, tmp_path, opens, monkeypatch):
        marker = os.O_CLOEXEC  # harmless stand-in bit for the Windows-only flag
        monkeypatch.setattr(os, "O_BINARY", marker, raising=False)
        pf.write_persona_profile_file(tmp_path / "udd", v4(), run=lambda f, a: "", platform="linux")
        creation = [o for o in opens if o["path"].endswith(".tmp")][0]
        assert creation["flags"] & marker == marker

    def test_the_exclusive_create_has_no_extra_flag_without_o_binary(self, tmp_path, opens, monkeypatch):
        monkeypatch.delattr(os, "O_BINARY", raising=False)
        pf.write_persona_profile_file(tmp_path / "udd", v4(), run=lambda f, a: "", platform="linux")
        creation = [o for o in opens if o["path"].endswith(".tmp")][0]
        assert creation["flags"] == os.O_WRONLY | os.O_CREAT | os.O_EXCL

    @posix_only
    def test_posix_restriction_is_by_descriptor_not_by_path(self, tmp_path, fds, monkeypatch):
        fchmods, chmods = [], []
        real_fchmod = os.fchmod
        monkeypatch.setattr(os, "fchmod", lambda fd, mode: (fchmods.append((fd, mode)), real_fchmod(fd, mode))[1])
        monkeypatch.setattr(os, "chmod", lambda path, mode, *a, **k: chmods.append(str(path)))
        pf.write_persona_profile_file(tmp_path, v4(), run=lambda *_: "", platform="linux")
        assert fchmods == [(fds[0], 0o600)]
        assert chmods == []


class TestRequiresSizeAndBrand:
    """Requires negotiation, the 1 MiB limit and the brand version warning."""

    def probe_with(self, drop=(), **extra):
        def probe(_exe):
            o = json.loads(info([2, 4], **extra))
            for k in drop:
                del o["persona"][k]
            return True, json.dumps(o)
        return probe

    def stage(self, profile, udd, probe, notices=None):
        pf.reset_engine_probe_cache()
        return pf.stage_persona_profile({"fingerprint_profile": profile}, "/x/chrome", udd, probe=probe,
                                        run=lambda f, a: "", platform="linux", notices=notices)

    def test_served_requires_are_staged(self, tmp_path):
        p = v4()
        p["requires"] = ["display", "input", "gpu.webgl", "network"]
        out = self.stage(p, tmp_path, self.probe_with())
        assert out["fingerprint_profile_file"] == str(tmp_path / PROFILE_FILE_NAME)

    def test_names_every_missing_capability_and_writes_nothing(self, tmp_path):
        p = v4()
        p["requires"] = ["display", "appearance.system_colors", "keyboard.map"]
        with pytest.raises(Exception) as err:
            self.stage(p, tmp_path, self.probe_with())
        assert err.value.code == "sdk.persona_capability_missing"
        assert "appearance.system_colors, keyboard.map" in str(err.value)
        assert list(tmp_path.iterdir()) == []

    def test_accepts_identity_ids_the_engine_accepts_although_capabilities_does_not_list_them(self, tmp_path):
        p = v4()
        p["requires"] = ["display", "os:windows", "os:macos", "engine:blink", "brand:edge", "brand:vivaldi", "arch:arm64"]
        advertised = {"os": ["windows", "linux", "macos", "android"], "arch": ["x86_64", "arm64"],
                      "brands": ["chrome", "edge", "opera", "vivaldi"]}
        for extra in (advertised, {}):       # advertised, or not advertised at all: accepted
            out = self.stage(p, tmp_path / str(len(extra)), self.probe_with(**extra))
            assert "fingerprint_profile_file" in out

    def test_refuses_identity_ids_outside_the_advertised_support_and_plain_ids_not_in_capabilities(self, tmp_path):
        advertised = {"os": ["windows", "linux"], "arch": ["x86_64"], "brands": ["chrome", "edge"], "engine_family": "blink"}
        for ident in ("os:macos", "arch:arm64", "brand:opera", "engine:gecko", "os:", "os", "brand:",
                      "gpu.webgl2", "navigator.nope"):
            p = v4()
            p["requires"] = [ident]
            with pytest.raises(Exception) as err:
                self.stage(p, tmp_path / "u", self.probe_with(**advertised))
            assert err.value.code == "sdk.persona_capability_missing", ident
            assert ident in str(err.value)

    def test_refuses_an_engine_without_a_capabilities_list_even_for_an_empty_requires(self, tmp_path):
        p = v4()
        p["requires"] = []
        with pytest.raises(Exception) as err:
            self.stage(p, tmp_path, self.probe_with(drop=("capabilities",)))
        assert err.value.code == "sdk.persona_capability_missing"
        with pytest.raises(Exception, match="does not list its capabilities"):
            pf.assert_engine_serves_requires([], {"schemas": [2, 4]})

    def test_a_missing_capability_leaves_no_temp_dir_behind(self):
        p = v4()
        p["requires"] = ["battery"]
        before = set(pf._live_temps)
        with pytest.raises(Exception) as err:
            self.stage(p, None, self.probe_with())
        assert err.value.code == "sdk.persona_capability_missing"
        assert set(pf._live_temps) == before

    def test_refuses_a_persona_over_1_mib_before_creating_anything(self, tmp_path):
        import base64
        p = v4()
        p["surfaces"]["noise"] = base64.b64encode(os.urandom(900_000)).decode()
        udd = tmp_path / "new-dir"
        with pytest.raises(Exception) as err:
            pf.write_persona_profile_file(udd, p, run=lambda f, a: "", platform="linux")
        assert err.value.code == "sdk.persona_too_large"
        assert not udd.exists()
        with pytest.raises(Exception) as err:
            self.stage(p, udd, self.probe_with())
        assert err.value.code == "sdk.persona_too_large"

    def test_a_persona_just_under_the_limit_is_written(self, tmp_path):
        import base64
        p = v4()
        p["surfaces"]["noise"] = base64.b64encode(os.urandom(500_000)).decode()
        path = pf.write_persona_profile_file(tmp_path, p, run=lambda f, a: "", platform="linux")
        assert os.path.getsize(path) <= 1 << 20

    MSG = ("the persona's brand version 158.0.4370.16 has major 158, but this engine's major is 159. "
           "For Chrome and Edge the engine presents the brand version only when the majors match, so the page "
           "will not show it. Use a persona issued for this engine's major.")

    def test_warns_with_one_code_and_text_in_both_sdks_when_the_brand_major_differs(self, tmp_path):
        notices = []
        self.stage(v4(), tmp_path, self.probe_with(engine_major=159), notices)
        assert notices == [{"code": "persona-brand-version-major", "message": self.MSG}]
        for probe in (self.probe_with(), self.probe_with(drop=("engine_major",))):
            notices = []
            self.stage(v4(), tmp_path, probe, notices)
            assert notices == []                       # 158 = 158, or the engine major is unknown
        assert pf.brand_version_notice(v4(), {"schemas": [2, 4], "engine_major": 159})["message"] == self.MSG
        # the engine compares the major for Chrome and Edge only
        for brand, expected in (("chrome", 1), ("edge", 1), ("opera", 0), ("vivaldi", 0)):
            p = v4()
            p["identity"]["brand"] = {"id": brand, "version": "158.0.4370.16"}
            notices = []
            self.stage(p, tmp_path, self.probe_with(engine_major=159), notices)
            assert len(notices) == expected, brand

    def test_the_notice_prints_as_a_warning_and_not_when_quiet(self, capsys, monkeypatch):
        from ant0browser._warnings import emit_persona_notices
        monkeypatch.delenv("ANT0_BROWSER_NO_WARN", raising=False)
        note = {"code": "persona-brand-version-major", "message": self.MSG}
        emit_persona_notices([note], quiet=False)
        emit_persona_notices([note], quiet=True)
        assert capsys.readouterr().err == f"ant0browser: warning: [persona-brand-version-major] {self.MSG}\n"

    def test_reads_the_persona_member_and_ignores_unknown_fields(self):
        i = pf.engine_persona_info("/x/chrome", lambda _e: (True, info([2, 4], future={"a": 1}, brands=["edge", 3])))
        assert i["schemas"] == [2, 4] and i["revision"] == 1 and i["engine_family"] == "blink"
        assert i["engine_major"] == 158 and i["brands"] == ["edge"] and "gpu.webgl" in i["capabilities"]

    def test_the_sdk_never_lets_a_caller_pass_the_persona_handle(self):
        from ant0browser._launchopts import assert_no_reserved_args
        assert_no_reserved_args(["--no-sandbox", "--ant0-persona-handler=1", "--x=--ant0-persona-handle"])
        for a in ("--ant0-persona-handle", "--ant0-persona-handle=3:abc", "-ant0-persona-handle=1",
                  "-ant0-persona-handle", "--ANT0-PERSONA-HANDLE=1", "/ant0-persona-handle=1",
                  "/Ant0-Persona-Handle", "-Ant0-Persona-Handle=1:2"):
            with pytest.raises(Exception) as err:
                assert_no_reserved_args(["--no-sandbox", a])
            assert err.value.code == "sdk.launch_option_unsupported", a


def foreign(tmp_path, body, name="chrome"):
    path = tmp_path / name
    path.write_text(f"#!/bin/sh\n{body}\n")  # no capability marker
    path.chmod(0o755)
    return str(path)


@posix_only
class TestProbeSkipsForeignBinaries:
    def test_a_binary_without_the_capability_marker_is_never_run_and_has_no_persona_support(self, tmp_path):
        ran = tmp_path / "ran"
        engine = foreign(tmp_path, f": > '{ran}'\nexec sleep 30")
        t0 = time.time()
        assert pf.probe_sdk_info_detailed(engine) == (True, False, "")
        assert time.time() - t0 < 2
        assert not ran.exists()
        assert pf.engine_persona_schemas(engine) == [2]
        assert not ran.exists()

    def test_the_answer_is_cached_as_a_completed_one_not_a_timeout(self, tmp_path):
        engine = foreign(tmp_path, "exit 0")
        calls, clock = [], [0.0]

        def probe(executable):
            calls.append(1)
            return pf.probe_sdk_info_detailed(executable)

        pf.engine_persona_info(engine, probe, lambda: clock[0])
        pf.engine_persona_info(engine, probe, lambda: clock[0])
        clock[0] = 60.0  # past a timeout's 30 s, inside an old engine's 10 minutes
        pf.engine_persona_info(engine, probe, lambda: clock[0])
        assert len(calls) == 1

    def test_a_schema4_persona_is_refused_for_it_without_running_it(self, tmp_path):
        ran = tmp_path / "ran"
        engine = foreign(tmp_path, f": > '{ran}'")
        fp = {"fingerprint_profile": v4()}
        with pytest.raises(Exception) as err:
            pf.stage_persona_profile(fp, engine, str(tmp_path / "udd"))
        assert err.value.code == "sdk.persona_requires_engine"
        assert not ran.exists()

    def test_a_missing_path_still_goes_to_the_spawn(self, tmp_path):
        assert pf.probe_sdk_info(str(tmp_path / "nope")) == (False, "")


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _wait(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end and not cond():
        time.sleep(0.05)


@posix_only
class TestProbeChildrenDoNotOutliveTheProcess:
    def test_the_exit_cleanup_kills_a_running_probe_group_and_removes_its_dir(self, tmp_path):
        import threading
        pids = tmp_path / "pids"
        engine = sh(tmp_path, f'sleep 60 &\necho "$$ $!" > \'{pids}\'\nexec sleep 60')
        worker = threading.Thread(target=pf.probe_sdk_info_detailed, args=(engine, 20))
        worker.start()
        _wait(lambda: pids.exists() and " " in pids.read_text().strip())
        leader, grandchild = (int(x) for x in pids.read_text().split())
        assert _alive(leader) and _alive(grandchild)
        pf._cleanup_all_temps()  # what the atexit hook (and the signal handler) runs
        _wait(lambda: not _alive(leader) and not _alive(grandchild))
        assert not _alive(leader) and not _alive(grandchild)
        worker.join(10)
        assert not worker.is_alive()

    def test_sweeping_removes_a_stale_probe_dir_and_kills_the_probe_in_it_and_leaves_the_rest(self, tmp_path):
        import subprocess
        stale, fresh, other, stale2 = (tmp_path / n for n in ("ant0sdk-probe-stale1", "ant0sdk-probe-fresh1", "other-dir",
                                                              "ant0sdk-probe-stale2"))
        for d in (stale, fresh, other, stale2):
            d.mkdir()
        child = subprocess.Popen(["sh", "-c", "sleep 60; :", f"--user-data-dir={stale}"], start_new_session=True)
        bystander = subprocess.Popen(["sleep", "60"], start_new_session=True)
        started = (time.time() - 2 * pf.STALE_PROBE_DIR_SECONDS) * 1000
        (stale / ".ant0-probe.json").write_text(json.dumps({"pid": child.pid, "startedAt": started}))
        (fresh / ".ant0-probe.json").write_text(json.dumps({"pid": 1, "startedAt": time.time() * 1000}))
        (stale2 / ".ant0-probe.json").write_text(json.dumps({"pid": bystander.pid, "startedAt": started}))
        try:
            removed = pf.sweep_stale_probe_dirs([str(tmp_path)])
            assert sorted(removed) == sorted([str(stale), str(stale2)])
            assert not stale.exists() and fresh.exists() and other.exists()
            _wait(lambda: child.poll() is not None)
            assert child.poll() is not None
            assert bystander.poll() is None  # a recycled pid is never signalled
        finally:
            for proc in (child, bystander):
                try:
                    os.killpg(proc.pid, 9)
                except OSError:
                    pass
                proc.wait()


class TestSignalCleanupInstall:
    @pytest.fixture
    def restore(self):
        import signal
        saved = {n: signal.getsignal(getattr(signal, n)) for n in ("SIGINT", "SIGTERM")}
        pf._signals_installed = False
        pf._signal_handlers.clear()
        yield
        for n, h in saved.items():
            signal.signal(getattr(signal, n), h)
        pf._signals_installed = False
        pf._signal_handlers.clear()

    def test_a_worker_thread_installs_nothing_and_the_main_thread_installs_once(self, restore):
        import signal
        import threading
        before = signal.getsignal(signal.SIGTERM)
        result = []
        thread = threading.Thread(target=lambda: result.append(pf.install_signal_cleanup()))
        thread.start()
        thread.join()
        assert result == [False]
        assert signal.getsignal(signal.SIGTERM) is before and pf._signals_installed is False
        assert pf.install_signal_cleanup() is True       # the main thread (pytest runs tests there)
        installed = signal.getsignal(signal.SIGTERM)
        assert installed is not before
        assert pf.install_signal_cleanup() is True       # idempotent
        assert signal.getsignal(signal.SIGTERM) is installed

    def test_a_handler_installed_outside_python_is_left_alone_and_repeated_installs_do_not_stack(self, restore, monkeypatch):
        import signal
        real_get, real_set = signal.getsignal, signal.signal
        set_calls = []
        # SIGTERM looks like a C-level handler: getsignal returns None, and signal.signal(.., None) would raise.
        monkeypatch.setattr(signal, "getsignal", lambda n: None if n == signal.SIGTERM else real_get(n))
        monkeypatch.setattr(signal, "signal", lambda n, h: (set_calls.append((n, h)), real_set(n, h))[1])
        sigint_before = real_get(signal.SIGINT)
        for _ in range(3):
            assert pf.install_signal_cleanup() is True       # SIGINT is still taken
            assert real_get(signal.SIGINT) is not sigint_before
            pf._release_signal_cleanup()                      # nothing live: everything put back
            assert real_get(signal.SIGINT) is sigint_before   # a stack would leave our old handler here
            assert pf._signals_installed is False and pf._signal_handlers == {}
        assert all(n != signal.SIGTERM for n, _ in set_calls)  # the foreign SIGTERM handler is never replaced

    def test_only_a_foreign_handler_installs_nothing_at_all(self, restore, monkeypatch):
        import signal
        monkeypatch.setattr(signal, "getsignal", lambda n: None)
        monkeypatch.setattr(signal, "signal", lambda n, h: pytest.fail("must not set any handler"))
        assert pf.install_signal_cleanup() is False
        assert pf._signals_installed is False and pf._signal_handlers == {}

    def test_registering_a_temp_dir_from_a_worker_thread_still_registers_atexit_cleanup(self, restore, tmp_path):
        import threading
        directory = str(tmp_path / "d")
        os.mkdir(directory)
        thread = threading.Thread(target=lambda: pf._register_temp(directory))
        thread.start()
        thread.join()
        assert pf._signals_installed is False and directory in pf._live_temps
        pf._cleanup_all_temps()
        assert not os.path.exists(directory)


class TestByteOrderMark:
    def test_a_leading_bom_is_ignored_as_in_the_node_sdk(self):
        assert pf.parse_sdk_info_schemas("\ufeff" + info([2, 4])) == [2, 4]
        assert pf.parse_sdk_info_schemas("\ufeffbanner\n" + info([2, 4]) + "\n") == [2, 4]


@posix_only
class TestSweepOfAbandonedProbeDirs:
    @staticmethod
    def _age(path, seconds=None):
        old = time.time() - 2 * (seconds or pf.STALE_PROBE_DIR_SECONDS)
        os.utime(path, (old, old))

    def test_new_probe_dirs_have_the_distinctive_prefix_and_the_shape_the_sweep_recognises(self):
        import re
        directory = pf.make_probe_dir()
        try:
            assert pf.PROBE_DIR_PREFIX == "ant0sdk-probe-"
            assert re.fullmatch(r"ant0sdk-probe-[a-z0-9_]{8}", os.path.basename(directory))
        finally:
            os.rmdir(directory)

    def test_an_unrelated_directory_is_never_touched(self, tmp_path):
        names = ["ant0-probe-cache-keep", "ant0-probe-abcd1234", "ant0sdk-probe-cache-keep", "ant0sdk-probe-abc1234",
                 "ant0sdk-probe-abc123456", "ant0sdk-probe-ABCD1234", "ant0sdk-probe-abc-1234"]
        for name in names:
            (tmp_path / name).mkdir()
            (tmp_path / name / "keep.txt").write_text("x")
            self._age(tmp_path / name)
        assert pf.sweep_stale_probe_dirs([str(tmp_path)]) == []
        assert all((tmp_path / n / "keep.txt").exists() for n in names)

    def test_a_recorded_old_directory_without_the_exact_prefix_is_never_swept(self, tmp_path):
        # A record does not make a directory ours: only names starting with PROBE_DIR_PREFIX are looked at,
        # so widening the prefix match (or dropping it) deletes these. `ant0-probe-*` is the pre-rename
        # prefix of earlier SDKs; those directories are deliberately left to the OS temp sweeper.
        names = ["ant0-probe-abcd1234", "ant0-probe-recorded", "ant0sdk-probe", "ant0sdk-prob-abcd1234",
                 "xant0sdk-probe-abcd1234", "Ant0sdk-probe-abcd1234"]
        for name in names:
            d = tmp_path / name
            d.mkdir()
            (d / "keep.txt").write_text("x")
            (d / ".ant0-probe.json").write_text(json.dumps({"pid": 2 ** 22 + 1, "startedAt": 1000}))
            self._age(d)
        assert pf.sweep_stale_probe_dirs([str(tmp_path)]) == []
        assert all((tmp_path / n / "keep.txt").exists() for n in names)

    def test_an_old_unrecorded_directory_of_exactly_the_mkdtemp_shape_goes_and_a_young_one_stays(self, tmp_path):
        old, young = tmp_path / "ant0sdk-probe-ab3_xyz9", tmp_path / "ant0sdk-probe-zz9yxw8q"
        old.mkdir()
        young.mkdir()
        self._age(old)
        assert pf.sweep_stale_probe_dirs([str(tmp_path)]) == [str(old)]
        assert young.exists()

    def test_a_recorded_pid_of_zero_or_below_is_never_signalled(self, tmp_path, monkeypatch):
        killed = []
        monkeypatch.setattr(pf.os, "killpg", lambda pid, sig: killed.append(pid))
        monkeypatch.setattr(pf, "_pid_runs_probe", lambda pid, directory: True)  # even if a process claimed to match
        for i, pid in enumerate((0, -1, -5, True)):
            d = tmp_path / f"ant0sdk-probe-pid{i}x"
            d.mkdir()
            (d / ".ant0-probe.json").write_text(json.dumps({"pid": pid, "startedAt": 1000}))
        assert len(pf.sweep_stale_probe_dirs([str(tmp_path)])) == 4
        assert killed == []

    def test_a_directory_owned_by_someone_else_is_left_alone(self, tmp_path):
        d = tmp_path / "ant0sdk-probe-own3rxyz"
        d.mkdir()
        self._age(d)
        assert pf.sweep_stale_probe_dirs([str(tmp_path)], uid=os.getuid() + 1) == []
        assert d.exists()
        assert pf.sweep_stale_probe_dirs([str(tmp_path)], uid=os.getuid()) == [str(d)]

    def test_the_recorded_process_is_signalled_only_for_exactly_the_user_data_dir_argument(self, tmp_path):
        import subprocess
        d = tmp_path / "ant0sdk-probe-exact1xx"
        d.mkdir()
        lookalike = subprocess.Popen(["sh", "-c", "sleep 60; :", f"--user-data-dir={d}-other"],
                                     start_new_session=True)
        (d / ".ant0-probe.json").write_text(json.dumps({"pid": lookalike.pid, "startedAt": 1000}))
        try:
            assert pf.sweep_stale_probe_dirs([str(tmp_path)]) == [str(d)]
            assert lookalike.poll() is None
        finally:
            os.killpg(lookalike.pid, 9)
            lookalike.wait()


@posix_only
class TestSignalHandlersAreReleased:
    @pytest.fixture
    def restore(self):
        import signal
        saved = {n: signal.getsignal(getattr(signal, n)) for n in ("SIGINT", "SIGTERM")}
        pf._signals_installed = False
        pf._signal_handlers.clear()
        yield
        for n, h in saved.items():
            signal.signal(getattr(signal, n), h)
        pf._signals_installed = False
        pf._signal_handlers.clear()

    def test_the_previous_handlers_come_back_once_nothing_needs_cleaning(self, restore, tmp_path):
        import signal
        before = {n: signal.getsignal(getattr(signal, n)) for n in ("SIGINT", "SIGTERM")}
        first, second = str(tmp_path / "a"), str(tmp_path / "b")
        os.mkdir(first)
        os.mkdir(second)
        pf._register_temp(first)
        pf._register_temp(second)
        assert signal.getsignal(signal.SIGINT) is not before["SIGINT"]
        pf.cleanup_persona_temp_dir(first)
        assert signal.getsignal(signal.SIGINT) is not before["SIGINT"]  # one directory is still alive
        pf.cleanup_persona_temp_dir(second)
        assert {n: signal.getsignal(getattr(signal, n)) for n in ("SIGINT", "SIGTERM")} == before
        assert pf._signals_installed is False

    def test_sig_ign_stays_ignored(self, restore, tmp_path):
        import signal
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        directory = str(tmp_path / "a")
        os.mkdir(directory)
        pf._register_temp(directory)
        assert signal.getsignal(signal.SIGINT) is not signal.SIG_IGN  # ours, while a directory is alive
        pf.cleanup_persona_temp_dir(directory)
        assert signal.getsignal(signal.SIGINT) == signal.SIG_IGN

    def test_a_handler_the_host_installed_since_is_left_alone(self, restore, tmp_path):
        import signal
        directory = str(tmp_path / "a")
        os.mkdir(directory)
        pf._register_temp(directory)

        def host(*_):
            pass

        signal.signal(signal.SIGINT, host)
        pf.cleanup_persona_temp_dir(directory)
        assert signal.getsignal(signal.SIGINT) is host

    def test_a_probe_that_ends_while_a_temp_dir_lives_keeps_the_handlers_until_that_goes(self, restore, tmp_path):
        import signal
        before = signal.getsignal(signal.SIGINT)
        directory = str(tmp_path / "a")
        os.mkdir(directory)
        pf._register_temp(directory)
        ours = signal.getsignal(signal.SIGINT)
        assert pf.probe_sdk_info_detailed(sh(tmp_path, f"echo '{info([2, 4])}'", "eng"))[0] is True
        assert signal.getsignal(signal.SIGINT) is ours
        pf.cleanup_persona_temp_dir(directory)
        assert signal.getsignal(signal.SIGINT) is before

    def test_a_probe_on_the_main_thread_leaves_the_handlers_as_they_were(self, restore, tmp_path):
        import signal
        before = {n: signal.getsignal(getattr(signal, n)) for n in ("SIGINT", "SIGTERM")}
        assert pf.probe_sdk_info_detailed(sh(tmp_path, f"echo '{info([2, 4])}'", "eng"))[0] is True
        assert {n: signal.getsignal(getattr(signal, n)) for n in ("SIGINT", "SIGTERM")} == before


class TestUnreadableBinary:
    def test_a_read_error_is_not_taken_for_a_foreign_build(self, tmp_path):
        from ant0browser.download import _is_ant0_binary
        with pytest.raises(OSError):
            _is_ant0_binary(str(tmp_path))  # a directory: opening it fails, as a locked file would

    def test_the_probe_goes_to_the_spawn_and_nothing_is_cached_as_a_completed_old_engine(self, tmp_path):
        assert pf.probe_sdk_info_detailed(str(tmp_path)) == (False, False, "")
        calls = []

        def probe(executable):
            calls.append(executable)
            return pf.probe_sdk_info_detailed(executable)

        pf.reset_engine_probe_cache()
        pf.engine_persona_info(str(tmp_path), probe, lambda: 0.0)
        pf.engine_persona_info(str(tmp_path), probe, lambda: 0.0)
        assert len(calls) == 2
