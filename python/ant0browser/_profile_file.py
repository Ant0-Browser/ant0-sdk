"""Transport for schema 4 personas: a private file next to the browser profile.

A schema 4 persona is far larger than the command line allows and must not sit in ``ps`` output, so it
goes through ``--fingerprint-profile-file=<absolute path>`` and never inline. The file holds the same
text the inline ``--fingerprint-profile`` switch carries today (gzip, then base64, of the persona's
JSON; see ``encode_profile``). The engine reads it once, at startup.

The SDK sends schema 4 only to an engine that says it can read it. ``--ant0-sdk-info`` reports
``persona.schemas``; an engine that reports ``sdk_protocol`` 1, prints nothing, or cannot be run is
taken to read ``[2]`` only. A schema 4 persona is then refused (``sdk.persona_requires_engine``); it
is never converted down.

Permissions. POSIX: the file is created with mode 0600 (owner read/write) through an exclusive
temporary file in the same directory and ``fchmod``ed (by handle) to 0600 again, then renamed over the target, so a
reader sees the old or the new file, never a partial one. Windows: the same temporary-file and rename
sequence, but the empty temporary file is restricted BEFORE any content is written: its inherited ACL
is removed and replaced with a single entry that grants the current user (by SID, from
``whoami /user``) full control (``icacls <file> /inheritance:r /grant:r *<SID>:F``). If that fails the
write fails: the persona is never left readable by others. Known window: the empty file is created with the
inherited ACL and restricted an instant later (no win32 binding is a dependency, so it cannot be created
restricted); it holds nothing until the restriction has succeeded, but in that instant a principal that the
inherited ACL lets read could open the empty file and keep its handle. The Node SDK has the same window. Closing
it would need the security descriptor set at creation, or a private parent directory; neither is done.

Probing the engine (``--ant0-sdk-info``) is bounded: a 5 s limit enforced with SIGKILL, a cap on the
output, and the answer is taken when the process exits (its output goes to a temporary file, so a
grandchild holding a pipe cannot keep the probe waiting). The probe child gets the private probe
directory as its TMPDIR/TMP/TEMP, so whatever an engine without the switch creates (a Chromium
singleton socket, for one) is removed with it. A probe that ran to completion is cached by executable
path, size and mtime; a completed old-engine answer (no schema 4) is cached for 10 minutes and a
timeout for 30 s only, so an old engine does not cost 5 s per launch, a slow first run is retried soon,
and a replaced or fixed engine is picked up. A spawn
error is never cached. A binary without the Ant0 capability marker is never run: it has no persona support
(a completed answer, cached like an old engine). The probe runs with a dead proxy (``--proxy-server=127.0.0.1:9``).
A probe child does not outlive the process: the ``atexit`` hook (and the signal handler, where installed) kills
running probes, and the next probe sweeps ``ant0sdk-probe-*`` directories a killed process left behind. The async
launch path runs the whole preparation in a worker thread, so the probe never blocks the event loop; signal
handlers can only be installed on the main thread (see ``install_signal_cleanup``), so a worker thread gets
the ``atexit`` cleanup only.
"""

import atexit
import copy
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from ._errors import SdkRuntimeError
from .download import _is_ant0_binary
from .persona_profile_v4 import is_persona_v4, validate_persona_profile_v4

#: Engine switch that names the persona file. One constant so the spelling is a one-line change.
PROFILE_FILE_SWITCH = "--fingerprint-profile-file"
#: Engine switch that prints the capability record.
SDK_INFO_SWITCH = "--ant0-sdk-info"
#: File name inside the user data directory.
PROFILE_FILE_NAME = "ant0-persona.profile"

#: Limits of the ``--ant0-sdk-info`` probe.
SDK_INFO_TIMEOUT = 5
SDK_INFO_MAX_BYTES = 1 << 20

#: How long a completed old-engine answer is remembered. A schema 4 answer is kept for good (it is
#: keyed by size and mtime, so a replaced binary is probed again).
OLD_ENGINE_CACHE_SECONDS = 600
#: How long a timed-out probe is remembered. Short, because a just-installed engine can be slow on its
#: first run (cold disk, antivirus) and must not be treated as old for long.
PROBE_TIMEOUT_CACHE_SECONDS = 30

_info_cache = {}  # key -> (info, expires_at); expires_at is None for good


#: A dead proxy: whatever a foreign build still tries to reach has nowhere to go (port 9 is "discard").
PROBE_DEAD_PROXY = "--proxy-server=127.0.0.1:9"


def sdk_info_isolation_args(user_data_dir):
    """Arguments that keep a probe of an engine without ``--ant0-sdk-info`` away from the user's profile and
    the network: a build that is not an Ant0 engine (Chrome for Testing, say) would otherwise start
    normally, reach out to the vendor and write to the real profile and certificate store within 5 s."""
    return [f"--user-data-dir={user_data_dir}", "--headless=new", "--no-first-run",
            "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
            "--disable-breakpad", "--disable-crash-reporter", PROBE_DEAD_PROXY]


def sdk_info_probe_env(probe_dir, base=None):
    """The probe child's environment: everything that points at a home or data directory is the probe dir,
    so a stock browser writes nothing under the real user's home (~/.config, ~/.local/share/pki, %APPDATA%)."""
    names = ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
             "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP")
    env = dict(os.environ if base is None else base)
    env.update({name: probe_dir for name in names})
    return env


#: A long TMPDIR makes Chromium fail with "Socket path too long" (a unix socket path holds about 100
#: characters, and the profile's singleton socket lives in the probe dir).
PROBE_DIR_MAX_LENGTH = 60
#: Distinctive enough that no unrelated directory carries it; ``tempfile.mkdtemp`` adds 8 characters of
#: ``[a-z0-9_]``, and a probe directory without a record is only recognised by exactly that shape.
PROBE_DIR_PREFIX = "ant0sdk-probe-"
_PROBE_DIR_SHAPE = re.compile(r"^" + re.escape(PROBE_DIR_PREFIX) + r"[a-z0-9_]{8}$")


def make_probe_dir():
    """A fresh private probe directory with a short path (see ``PROBE_DIR_MAX_LENGTH``)."""
    prefix = PROBE_DIR_PREFIX
    base = tempfile.gettempdir()
    # 8 random characters follow the prefix, and the socket file name adds about 20 more.
    if len(os.path.join(base, prefix)) + 8 > PROBE_DIR_MAX_LENGTH and sys.platform != "win32" \
            and os.path.isdir("/tmp"):
        base = "/tmp"
    return tempfile.mkdtemp(prefix=prefix, dir=base)


def _kill_probe_tree(proc):
    """Stop the probe and everything it started. POSIX: the child leads its own process group, so the whole
    group gets SIGKILL. Windows: ``taskkill /T /F`` takes the tree. Best effort, never raises."""
    if sys.platform == "win32":
        try:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000,
                           timeout=10)
        except Exception:  # noqa: BLE001
            pass
    else:
        try:
            os.killpg(proc.pid, 9)
            return
        except OSError:
            pass
    try:
        proc.kill()
    except OSError:
        pass


# Probes that are running now (pid -> probe dir). The exit handler (and the signal handler, where one is
# installed) kills them and removes their dirs, so a probe child never outlives the SDK process; a SIGKILL of
# the SDK cannot be caught, and ``sweep_stale_probe_dirs`` handles what that leaves behind on the next run.
_live_probes = {}
_probe_lock = threading.Lock()
_PROBE_INFO_FILE = ".ant0-probe.json"
#: A probe dir older than this belongs to a process that is gone (a probe lasts 5 s).
STALE_PROBE_DIR_SECONDS = 60
_swept = False


def _kill_live_probes():
    with _probe_lock:
        probes = list(_live_probes.items())
        _live_probes.clear()
    for pid, directory in probes:
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000,
                               timeout=3)
            else:
                os.killpg(pid, 9)
        except Exception:  # noqa: BLE001 -- already gone
            pass
        shutil.rmtree(directory, ignore_errors=True)


def _pid_runs_probe(pid, directory):
    """Whether ``pid`` still runs with exactly ``--user-data-dir=<directory>`` among its arguments (a recycled
    pid is never signalled)."""
    try:
        wanted = f"--user-data-dir={directory}"
        if sys.platform.startswith("linux"):
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                return wanted.encode() in handle.read().split(b"\0")
        if sys.platform == "win32":
            return False  # cannot be checked cheaply: the directory is removed, nothing is killed
        out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True,
                             timeout=2).stdout
        return f" {wanted} " in f" {out.strip()} "
    except Exception:  # noqa: BLE001
        return False


def sweep_stale_probe_dirs(roots=None, now=None, uid=None):
    """Remove probe directories (and kill the probe left in them) that an earlier SDK process abandoned when
    it was killed. Only our own directories named ``ant0sdk-probe-*``, owned by this user, older than
    ``STALE_PROBE_DIR_SECONDS``; one without a record (``.ant0-probe.json``) must also have exactly the shape
    ``mkdtemp`` produces, so an unrelated directory that merely starts with the prefix is never touched. Directories of earlier
    SDKs (``ant0-probe-*``) are NOT swept, record or not: they are left to the OS temp sweeper.
    Best effort, never raises; returns the directories removed. ``roots``, ``now`` (epoch seconds) and ``uid``
    exist for tests."""
    if roots is None:
        roots = [tempfile.gettempdir()] + (["/tmp"] if sys.platform != "win32" else [])
        roots = list(dict.fromkeys(roots))
    now = time.time() if now is None else now
    if uid is None and hasattr(os, "getuid"):
        uid = os.getuid()
    removed = []
    for root in roots:
        try:
            names = [n for n in os.listdir(root) if n.startswith(PROBE_DIR_PREFIX)]
        except OSError:
            continue
        for name in names:
            directory = os.path.join(root, name)
            try:
                st = os.lstat(directory)
                if not os.path.isdir(directory) or os.path.islink(directory) \
                        or (uid is not None and st.st_uid != uid):
                    continue
                started, pid, recorded = st.st_mtime, None, False
                try:
                    with open(os.path.join(directory, _PROBE_INFO_FILE), encoding="utf-8") as handle:
                        record = json.load(handle)
                    recorded = isinstance(record, dict)
                    if recorded and isinstance(record.get("pid"), int) and not isinstance(record["pid"], bool) \
                            and record["pid"] > 0:
                        pid = record["pid"]  # never 0 or negative: those would signal a whole group
                    if recorded and isinstance(record.get("startedAt"), (int, float)) \
                            and not isinstance(record["startedAt"], bool):
                        started = record["startedAt"] / 1000.0
                except (OSError, ValueError, AttributeError):
                    pass  # no record: the directory age decides
                if not recorded and not _PROBE_DIR_SHAPE.match(name):
                    continue  # not a directory this module made
                if now - started < STALE_PROBE_DIR_SECONDS:
                    continue
                if pid is not None and _pid_runs_probe(pid, directory):
                    try:
                        os.killpg(pid, 9)
                    except OSError:
                        pass
                shutil.rmtree(directory, ignore_errors=True)
                removed.append(directory)
            except OSError:
                pass
    return removed


def probe_sdk_info(executable, timeout=SDK_INFO_TIMEOUT, max_bytes=SDK_INFO_MAX_BYTES):
    """Run ``executable --ant0-sdk-info``. Returns ``(completed, stdout)``: ``completed`` is False after a
    timeout, a spawn error or too much output; ``stdout`` is empty unless it completed with exit code 0.
    Never raises. ``probe_sdk_info_detailed`` also says whether the probe timed out."""
    completed, _timed_out, stdout = probe_sdk_info_detailed(executable, timeout, max_bytes)
    return completed, stdout


def probe_sdk_info_detailed(executable, timeout=SDK_INFO_TIMEOUT, max_bytes=SDK_INFO_MAX_BYTES, require_ant0=True):
    """Like ``probe_sdk_info`` but returns ``(completed, timed_out, stdout)``; ``timed_out`` is true when
    the probe was stopped for running too long or printing too much (not for a spawn error)."""
    # Every Ant0 engine answers --ant0-sdk-info and exits; only a foreign build (Chrome for Testing, say) would
    # start up. The capability marker every Ant0 binary carries tells them apart without running anything, so a
    # binary without it is never run: it has no persona support, and that is a completed answer. A path that
    # cannot be read goes on to the spawn below, which fails the usual way.
    if require_ant0 and os.path.exists(executable):
        try:
            ant0 = _is_ant0_binary(executable)
        except OSError:
            ant0 = True  # unreadable: let the spawn decide
        if not ant0:
            return True, False, ""
    global _swept
    if not _swept:
        _swept = True
        sweep_stale_probe_dirs()
    kwargs = {"creationflags": 0x08000000} if sys.platform == "win32" else {"start_new_session": True}
    # An engine that does not know --ant0-sdk-info may start a normal browser; the isolating arguments
    # keep that off the user's profile (a private, throwaway profile dir; headless; no first-run UI).
    # An engine that knows the switch exits before it reads any of them.
    probe_dir = make_probe_dir()
    # Everything the child creates in its temp or home directories lands in the probe dir and goes with it.
    env = sdk_info_probe_env(probe_dir)
    try:
        with tempfile.TemporaryFile() as out:
            proc = subprocess.Popen([str(executable), *sdk_info_isolation_args(probe_dir), SDK_INFO_SWITCH],
                                    stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.DEVNULL, env=env,
                                    **kwargs)
            with _probe_lock:
                _live_probes[proc.pid] = probe_dir
            _ensure_exit_cleanup()
            try:
                with open(os.path.join(probe_dir, _PROBE_INFO_FILE), "w", encoding="utf-8") as record:
                    json.dump({"pid": proc.pid, "startedAt": int(time.time() * 1000)}, record)
            except OSError:
                pass
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                _kill_probe_tree(proc)  # the whole group (taskkill /T on Windows), not just the leader
                proc.wait(timeout=5)
                return False, True, ""
            out.seek(0)
            data = out.read(max_bytes + 1)
            if len(data) > max_bytes:
                return False, True, ""
            return True, False, (data.decode("utf-8", "replace") if proc.returncode == 0 else "")
    except (OSError, subprocess.SubprocessError, ValueError):
        return False, False, ""
    finally:
        with _probe_lock:
            for pid in [p for p, d in _live_probes.items() if d == probe_dir]:
                del _live_probes[pid]
        shutil.rmtree(probe_dir, ignore_errors=True)
        _release_signal_cleanup()


def _as_int(value):
    """An integer, or a float with an integral value (``2.0``, as a JavaScript JSON.parse reads it, where
    ``2`` and ``2.0`` are the same number); None for anything else, including booleans and strings."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _parse_info_object(text):
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _string_list(value):
    return [x for x in value if isinstance(x, str)] if isinstance(value, list) else None


def parse_sdk_info(output):
    """Read the persona member out of ``--ant0-sdk-info`` output. Protocol 1 or a missing ``persona``
    block means ``{"schemas": [2]}`` and nothing else. The record is one JSON object: the whole trimmed
    output, else the last line that is a complete JSON object (an engine may print a banner first).
    ``sdk_protocol`` and the numbers must be integers; an integral float (``2.0``) counts, as it does
    for the Node SDK (whose supported versions cannot tell ``2.0`` from ``2``), and a string such as
    ``"2"`` does not. Unknown fields are ignored; fields the engine does not give are absent from the
    result (``revision``, ``engine_family``, ``engine_major``, ``os``, ``arch``, ``brands``,
    ``capabilities``)."""
    # A leading byte order mark (a Windows tool that writes UTF-8 with one) is not part of the record.
    text = output.lstrip("\ufeff").strip()
    info = _parse_info_object(text)
    if info is None:
        for line in reversed(re.split(r"\r?\n", text)):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                info = _parse_info_object(line)
                if info is not None:
                    break
    if info is None:
        return {"schemas": [2]}
    protocol = _as_int(info.get("sdk_protocol"))
    if protocol is None or protocol < 2:
        return {"schemas": [2]}
    persona = info.get("persona")
    schemas = persona.get("schemas") if isinstance(persona, dict) else None
    if not isinstance(schemas, list):
        return {"schemas": [2]}
    ints = [i for i in (_as_int(n) for n in schemas) if i is not None]
    if not ints:
        return {"schemas": [2]}
    out = {"schemas": ints}
    revision, major = _as_int(persona.get("revision")), _as_int(persona.get("engine_major"))
    if revision is not None:
        out["revision"] = revision
    if isinstance(persona.get("engine_family"), str):
        out["engine_family"] = persona["engine_family"]
    if major is not None:
        out["engine_major"] = major
    for field in ("os", "arch", "brands", "capabilities"):
        items = _string_list(persona.get(field))
        if items is not None:
            out[field] = items
    return out


def parse_sdk_info_schemas(output):
    """Read the accepted persona schemas out of ``--ant0-sdk-info`` output (see ``parse_sdk_info``)."""
    return parse_sdk_info(output)["schemas"]


def _run_probe(probe, executable):
    """``(completed, timed_out, stdout)`` from a probe: the default one, or an injected two-tuple
    ``(completed, stdout)`` (a timeout is then a plain ``completed`` False)."""
    if probe is None:
        return probe_sdk_info_detailed(executable)
    result = probe(executable)
    if len(result) == 3:
        return result
    return result[0], False, result[1]


def engine_persona_info(executable, probe=None, now=None):
    """What the engine at ``executable`` says about persona support (``parse_sdk_info``). Never raises:
    unknown means ``{"schemas": [2]}``. The answer is cached per executable path, size and modification
    time: an engine that serves schema 4 for good, a completed old-engine answer for
    ``OLD_ENGINE_CACHE_SECONDS``, a timeout for ``PROBE_TIMEOUT_CACHE_SECONDS``. A spawn error is not cached and is retried. ``now`` (a function
    returning seconds) exists for tests."""
    now = now or time.monotonic
    key = str(executable)
    try:
        st = os.stat(executable)
        key = f"{executable}\0{st.st_size}\0{st.st_mtime_ns}"
    except OSError:
        pass
    hit = _info_cache.get(key)
    if hit is not None:
        if hit[1] is None or hit[1] > now():
            return copy.deepcopy(hit[0])
        _info_cache.pop(key, None)
    try:
        completed, timed_out, stdout = _run_probe(probe, executable)
    except Exception:  # noqa: BLE001 -- an unusable probe is an unknown engine
        return {"schemas": [2]}
    info = parse_sdk_info(stdout) if completed else {"schemas": [2]}
    if completed or timed_out:
        modern = completed and 4 in info["schemas"]
        ttl = OLD_ENGINE_CACHE_SECONDS if completed else PROBE_TIMEOUT_CACHE_SECONDS
        _info_cache[key] = (info, None if modern else now() + ttl)
    return copy.deepcopy(info)


def engine_persona_schemas(executable, probe=None, now=None):
    """Persona schemas the engine at ``executable`` can load. Never raises: unknown means ``[2]``."""
    return engine_persona_info(executable, probe, now)["schemas"]


def reset_engine_probe_cache():
    """Test hook: forget every cached probe answer."""
    _info_cache.clear()


def assert_engine_accepts_schema4(executable, probe=None):
    """Raise ``sdk.persona_requires_engine`` unless the engine at ``executable`` can load schema 4.
    Returns what the engine said (``engine_persona_info``), for the checks that follow."""
    info = engine_persona_info(executable, probe)
    if 4 not in info["schemas"]:
        raise SdkRuntimeError(
            "sdk.persona_requires_engine",
            "this identity uses the new persona format (schema_version 4), which this engine does not "
            "advertise in --ant0-sdk-info (persona.schemas). Use an engine that supports it; the persona "
            "is not converted to the older format.")
    return info


def _require_is_served(identifier, served, info):
    """Identity ids are implicit in the engine (``CapabilityIsKnown``): ``os:*``, ``engine:*``,
    ``brand:*`` and ``arch:*`` are accepted when the value is one the engine supports, and are not listed
    in persona.capabilities. Checked against the identity support the engine advertises, accepted when it
    does not advertise that list. An empty value is never known. Anything else must be a listed capability."""
    if identifier in served:
        return True
    m = re.match(r"^(os|engine|brand|arch):(.*)$", identifier, re.DOTALL) if isinstance(identifier, str) else None
    if not m or m.group(2) == "":
        return False
    kind, value = m.groups()
    if kind == "engine":
        family = info.get("engine_family")
        advertised = None if family is None else [family]
    else:
        advertised = info.get({"os": "os", "arch": "arch", "brand": "brands"}[kind])
    return advertised is None or value in advertised


def assert_engine_serves_requires(requires, info):
    """Raise ``sdk.persona_capability_missing`` unless the engine serves every id the persona
    ``requires``. An engine that takes schema 4 but lists no capabilities cannot be checked and is
    refused too: it would otherwise run without the profile and say so only in a log line."""
    capabilities = info.get("capabilities")
    if capabilities is None:
        raise SdkRuntimeError(
            "sdk.persona_capability_missing",
            "this engine accepts the new persona format (schema_version 4) but does not list its "
            "capabilities in --ant0-sdk-info (persona.capabilities), so the persona's requirements cannot "
            "be checked. Use an engine that reports them.")
    served = set(capabilities)
    missing = [r for r in requires if not _require_is_served(r, served, info)]
    if missing:
        raise SdkRuntimeError(
            "sdk.persona_capability_missing",
            "this persona requires capabilities the engine does not serve: " + ", ".join(missing) + ". The "
            "engine would run without the profile. Use an engine that serves them, or a persona that does "
            "not require them.")


#: The engine refuses a persona file larger than this.
PERSONA_FILE_MAX_BYTES = 1 << 20


def assert_persona_file_size(text):
    """Raise ``sdk.persona_too_large`` when the encoded persona would not be accepted from a file."""
    size = len(text.encode("utf-8"))
    if size > PERSONA_FILE_MAX_BYTES:
        raise SdkRuntimeError(
            "sdk.persona_too_large",
            f"the encoded persona is {size} bytes; the engine accepts a persona file of at most "
            f"{PERSONA_FILE_MAX_BYTES} bytes (1 MiB) and would run without the profile.")


#: Code of the brand-version warning (same code and text in the Node SDK).
BRAND_VERSION_MAJOR_CODE = "persona-brand-version-major"


def brand_version_notice(profile, info):
    """A ``{"code", "message"}`` notice when the persona's brand version major differs from the engine's
    advertised major, else None. Not an error."""
    brand = (profile.get("identity") or {}).get("brand") or {}
    version = brand.get("version")
    major = info.get("engine_major")
    # The engine compares the major for Chrome and Edge only; other brands carry their own version.
    if brand.get("id") not in ("chrome", "edge"):
        return None
    if not isinstance(version, str) or major is None:
        return None
    persona_major = version.split(".")[0]
    if persona_major == str(major):
        return None
    return {"code": BRAND_VERSION_MAJOR_CODE, "message": (
        f"the persona's brand version {version} has major {persona_major}, but this engine's major is "
        f"{major}. For Chrome and Edge the engine presents the brand version only when the majors match, "
        "so the page will not show it. Use a persona issued for this engine's major.")}


def _run_command(file, args):
    """Run one command (an argument list, no shell) and return its stdout; raises when it fails."""
    done = subprocess.run([file, *args], check=True, capture_output=True, timeout=15, text=True,
                          creationflags=0x08000000)
    return done.stdout


def current_user_sid(run=None):
    """The current user's SID from ``whoami /user /fo csv /nh`` (one line: "DOMAIN\\user","S-1-5-...")."""
    out = (run or _run_command)("whoami", ["/user", "/fo", "csv", "/nh"])
    lines = out.strip().splitlines()
    fields = re.findall(r'"([^"]*)"', lines[0]) if lines else []
    sid = fields[1] if len(fields) > 1 else ""
    if not re.fullmatch(r"S-1-\d+(-\d+)+", sid):
        raise ValueError("whoami did not return a SID")
    return sid


def restrict_to_current_user_windows(path, run=None):
    """Remove inherited access from ``path`` and grant the current user, by SID, full control."""
    run = run or _run_command
    try:
        sid = current_user_sid(run)
        run("icacls", [str(path), "/inheritance:r", "/grant:r", f"*{sid}:F"])
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise SdkRuntimeError("sdk.profile_file_unsafe",
                              f"cannot restrict the persona file to the current user: {path}", cause=exc)


def _restrict_to_current_user(path, fd, run=None, platform=None):
    if (platform or sys.platform) != "win32":
        os.fchmod(fd, 0o600)  # by handle: no second path lookup
        return
    restrict_to_current_user_windows(path, run)


def _write_private_atomic(target, text, run=None, platform=None):
    """Write ``text`` to ``target`` through a private temporary file in the same directory, then rename.
    The temporary file is created exclusively (O_EXCL never follows or reuses a planted path) and
    restricted to the current user before any content is written. The content goes through the
    descriptor of that exclusive create: the path is never opened again (nothing to follow or swap in
    between). Every error path closes the descriptor once and removes the temporary file."""
    directory, name = os.path.split(target)
    temp = os.path.join(directory, f".{name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
    created = False
    fd = None
    try:
        # O_BINARY (Windows only, absent elsewhere): no newline translation of the persona text
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        created = True
        _restrict_to_current_user(temp, fd, run, platform)
        stream = os.fdopen(fd, "wb")
        fd = None  # the stream owns the descriptor now and closes it exactly once
        with stream:
            stream.write(text.encode("ascii"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
        created = False
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if created:
            try:
                os.unlink(temp)
            except OSError:
                pass  # incl. a Windows PermissionError: never hide the error that is already propagating


def write_persona_profile_file(user_data_dir, profile, run=None, platform=None):
    """Write a schema 4 persona to ``<user_data_dir>/ant0-persona.profile``; return its absolute path.
    ``run`` and ``platform`` exist for tests."""
    from ._fingerprint import encode_profile  # late: _fingerprint imports this module's siblings
    validate_persona_profile_v4(profile)
    text = encode_profile(profile)
    assert_persona_file_size(text)  # before anything is created
    directory = os.path.abspath(os.fspath(user_data_dir))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    path = os.path.join(directory, PROFILE_FILE_NAME)
    _write_private_atomic(path, text, run, platform)
    return path


def remove_stale_persona_file(user_data_dir):
    """Remove a stale ``ant0-persona.profile`` from ``user_data_dir``: only that exact name, and a symlink
    is unlinked itself, never followed. Best effort; returns whether something was removed."""
    if not user_data_dir:
        return False  # "" means "no profile dir" (Playwright uses a temp dir); never the cwd
    path = os.path.join(os.path.abspath(os.fspath(user_data_dir)), PROFILE_FILE_NAME)
    try:
        os.lstat(path)
        os.unlink(path)
        return True
    except OSError:
        return False


# Temporary persona directories still alive; one process-wide exit handler removes what is left.
_live_temps = set()
_live_lock = threading.Lock()
_exit_handler_installed = False
_signals_installed = False
_signal_handlers = {}  # signum -> (our handler, the handler it replaced)


def _ensure_exit_cleanup():
    """Register the process-wide ``atexit`` cleanup once (temporary persona directories, running probes), and
    try to add the signal handlers (see ``install_signal_cleanup``)."""
    global _exit_handler_installed
    with _live_lock:
        first = not _exit_handler_installed
        _exit_handler_installed = True
    if first:
        atexit.register(_cleanup_all_temps)
    install_signal_cleanup()


def _register_temp(directory):
    with _live_lock:
        _live_temps.add(directory)
    _ensure_exit_cleanup()


def install_signal_cleanup():
    """Best effort: clean the temporary persona directories and running probes on SIGINT and SIGTERM too,
    where ``atexit`` does not run (SIGTERM). Python only allows a signal handler to be set from the main
    thread, so this does nothing (returns False) anywhere else; ``atexit`` is then the only cleanup. The async
    launch functions call it from the event loop thread (normally the main thread) once a temporary persona
    directory exists, because their preparation runs in a worker thread, which cannot install one. Idempotent.
    The previous handler still runs afterwards (also Python's default SIGINT handler, which raises
    ``KeyboardInterrupt``), ``SIG_IGN`` stays ignored, and a default action is restored and the signal
    re-raised, so the process ends the way it would have. The handlers are removed again, and the previous
    ones put back, once no temporary directory and no probe is left (see ``_release_signal_cleanup``), so
    an idle SDK never changes how the host reacts to Ctrl+C. Returns whether the handlers are installed."""
    global _signals_installed
    import signal
    if _signals_installed:
        return True
    if threading.current_thread() is not threading.main_thread():
        return False
    installed = False
    for name in ("SIGINT", "SIGTERM"):
        signum = getattr(signal, name, None)
        if signum is None:
            continue
        try:
            previous = signal.getsignal(signum)
            if previous is None:
                # Installed outside Python (a C extension, an embedding host): Python can neither call it
                # nor put it back (signal.signal(signum, None) is a TypeError), so replacing it would leave
                # our handler behind after the release, and every later install would stack on top of it.
                # Leave it alone; atexit remains the cleanup for this signal.
                continue

            def handler(received, frame, previous=previous):
                _cleanup_all_temps()  # also puts the previous handlers back: nothing is left to clean
                if callable(previous):
                    previous(received, frame)  # also Python's default SIGINT handler (KeyboardInterrupt)
                elif previous == signal.SIG_IGN:
                    return
                else:
                    signal.signal(received, signal.SIG_DFL)
                    os.kill(os.getpid(), received)

            signal.signal(signum, handler)
            _signal_handlers[signum] = (handler, previous)
            installed = True
        except (ValueError, OSError):  # not supported here
            pass
    _signals_installed = installed
    return installed


def _release_signal_cleanup():
    """Put the previous SIGINT/SIGTERM handlers back once nothing needs cleaning (no temporary persona
    directory, no running probe). A signal's handler is only replaced when it is still ours (a host that
    installed its own since keeps it), and only on the main thread: from another thread this does nothing
    and the handlers stay until a later release on the main thread. Never raises."""
    global _signals_installed
    import signal
    with _live_lock:
        if _live_temps:
            return
    with _probe_lock:
        if _live_probes:
            return
    if not _signal_handlers or threading.current_thread() is not threading.main_thread():
        return
    for signum, (handler, previous) in list(_signal_handlers.items()):
        try:
            if signal.getsignal(signum) is handler and previous is not None:
                signal.signal(signum, previous)  # SIG_IGN stays SIG_IGN, a host handler stays a host handler
        except (ValueError, OSError, TypeError):
            pass
    _signal_handlers.clear()
    _signals_installed = False


def _cleanup_all_temps():
    with _live_lock:
        directories = list(_live_temps)
        _live_temps.clear()
    for directory in directories:
        shutil.rmtree(directory, ignore_errors=True)
    _kill_live_probes()
    _release_signal_cleanup()


def cleanup_persona_temp_dir(directory):
    """Remove a temporary persona directory made by ``stage_persona_profile``. Safe to call twice, and
    with None."""
    if not directory:
        return
    with _live_lock:
        _live_temps.discard(directory)
    shutil.rmtree(directory, ignore_errors=True)
    _release_signal_cleanup()


def remove_persona_file(directory):
    """Delete ``ant0-persona.profile`` from ``directory`` (the engine reads it once, at startup). Safe when
    it is gone; never raises."""
    if directory:
        try:
            os.unlink(os.path.join(directory, PROFILE_FILE_NAME))
        except OSError:
            pass


def cleanup_when_closed(target, directory):
    """The browser (or context) ``target`` is up, so the engine has read the persona file: delete it now,
    and remove the temporary persona ``directory`` when the target disconnects or closes. The exit handler
    is the fallback. Never raises."""
    remove_persona_file(directory)
    try:
        target.on("close" if hasattr(target, "pages") else "disconnected",
                  lambda *_: cleanup_persona_temp_dir(directory))
    except Exception:  # noqa: BLE001 -- the exit handler still removes it
        pass


def stage_persona_profile(fingerprint, executable, user_data_dir=None, probe=None, run=None, platform=None,
                          notices=None):
    """Prepare the persona transport for one launch and return the options for ``fingerprint_args``.

    A schema 2 or absent persona is returned untouched, and a stale persona file in ``user_data_dir``
    is removed. A schema 4 persona is checked against the engine and written to a private file in
    ``user_data_dir``; with no profile directory of its own (``launch(ephemeral_profile=False)``) it goes
    to a private temporary directory, which the launch code removes when the browser closes
    (``cleanup_when_closed``) and a single process-wide exit handler removes otherwise.

    The persona's ``requires`` are checked against the engine's advertised capabilities first
    (``sdk.persona_capability_missing``). ``notices``, a list, receives ``{"code", "message"}`` items for
    things worth telling the user (see ``emit_persona_notices``).
    """
    profile = fingerprint.get("fingerprint_profile")
    if not isinstance(profile, dict) or not is_persona_v4(profile):
        if user_data_dir:
            remove_stale_persona_file(user_data_dir)
        return fingerprint
    validate_persona_profile_v4(profile)
    info = assert_engine_accepts_schema4(executable, probe)
    assert_engine_serves_requires(profile.get("requires") or [], info)
    notice = brand_version_notice(profile, info)
    if "noise_key" not in (profile.get("provenance") or {}):
        from ._warnings import debug_log
        debug_log("the persona has no provenance.noise_key; the engine derives one from the document")
    if notice is not None and notices is not None:
        notices.append(notice)
    directory = user_data_dir
    temp = None
    if not directory:  # None or "": no profile directory of its own (an empty path is never the cwd)
        temp = directory = tempfile.mkdtemp(prefix="ant0-persona-")
        _register_temp(temp)
    try:
        path = write_persona_profile_file(directory, profile, run, platform)
    except BaseException:
        if temp is not None:
            cleanup_persona_temp_dir(temp)
        raise
    return {**fingerprint, "fingerprint_profile_file": path}


__all__ = [
    "PROFILE_FILE_SWITCH", "SDK_INFO_SWITCH", "PROFILE_FILE_NAME", "parse_sdk_info_schemas",
    "engine_persona_schemas", "assert_engine_accepts_schema4", "write_persona_profile_file",
    "stage_persona_profile", "remove_stale_persona_file", "cleanup_persona_temp_dir",
    "cleanup_when_closed", "remove_persona_file", "install_signal_cleanup",
]
