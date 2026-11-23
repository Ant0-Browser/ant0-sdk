import asyncio
import base64
import copy
import ctypes
import json
import os
import sys
import threading

import pytest

import ant0browser
from ant0browser import async_api
from ant0browser import _serve
from ant0browser import _runtime_client as rc

MARKER = b"ant0-browser-capabilities/persona-profile-v1"
ENGINE = "154.0.8037.57-ant0.2"
CHROMIUM = "154.0.8037.57"
TICKET = "aaa.bbb.ccc.ddd.eee"
UUID = "11111111-1111-4111-8111-111111111111"
HOME = r"C:\Ant0" if sys.platform == "win32" else "/tmp/ant0-home"
ENGINE_DIR = os.path.join(HOME, "browsers", ENGINE)
ENGINE_EXE = os.path.join(ENGINE_DIR, "chrome.exe" if sys.platform == "win32" else "chrome")
SIGN_PUB = base64.b64encode(bytes(range(32))).decode("ascii")
DEVICE_ID = "A" * 26


def _bytes(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def _request(*, operation="resolve-direct-engine", binding=None, engine_version=ENGINE, ticket_fetch=True):
    value = {
        "schema": "ant0-runtime-client/v1",
        "nonce": "A" * 43,
        "operation": operation,
        "binding": binding or {"mode": "v1", "home": HOME, "descriptor_path": None, "endpoint": None},
        "engine_version": engine_version,
    }
    if operation == "resolve-direct-engine":
        value["ticket_fetch"] = ticket_fetch
    return value


def _success(request=None):
    request = request or _request()
    resolving = request["operation"] == "resolve-direct-engine"
    target = rc._target()
    value = {
        "schema": request["schema"],
        "nonce": request["nonce"],
        "operation": request["operation"],
        "ok": True,
        "handshake": None if request["binding"].get("mode") == "legacy" else {
            "protocol": "ant0-runtime/v1",
            "nonce": "A" * 43,
            "install_id": UUID,
            "generation": UUID,
            "app_version": "0.3.15",
            "target": target,
            "pid": 1234,
            "home": request["binding"].get("home") or HOME,
            "daemon_sha256": "a" * 64,
            "auth_protocol": "ant0-native-auth/v1",
            "engine_ticket": "ant0-launch/v1",
            "capabilities": [
                "auth.loopback",
                "auth.device_code",
                "auth.install",
                "engine.status",
                "engine.install",
                "engine.ticket",
                "profiles.managed",
                "automation.scoped",
            ],
            "lifecycle": "persistent",
        },
        "ticket": {
            "launch": TICKET,
            "engine": ENGINE,
            "expires_at": "2027-01-15T08:15:05Z",
        },
        "context": {
            "device_id": DEVICE_ID,
            "sign_pub": SIGN_PUB,
            "workspace_id": UUID,
        },
    }
    if resolving:
        value["engine"] = {
            "version": ENGINE,
            "chromium": CHROMIUM,
            "target": target,
            "path": ENGINE_DIR,
            "executable": ENGINE_EXE,
            "installed_at": "2026-10-12T00:00:00Z",
            "size_bytes": 123456,
            "default": True,
        }
        if request.get("ticket_fetch") is False:
            value["ticket"] = None
            value["context"] = None
    return value


def _fake_exe(tmp_path, version=ENGINE):
    base = tmp_path / version
    browser = base / "browser"
    browser.mkdir(parents=True)
    exe = browser / ("chrome.exe" if sys.platform == "win32" else "chrome")
    exe.write_bytes(MARKER)
    (base / ".release.json").write_text(json.dumps({"version": version, "chromium": version.split("-ant0.", 1)[0]}))
    return str(exe)


class _CFunc:
    def __init__(self, func):
        self.func = func

    def __call__(self, *args):
        return self.func(*args)


class _FakeRuntimeLib:
    def __init__(self, *, code=0, response_factory=None, publish_result=True, wait_for_cancel=False):
        self.code = code
        self.response_factory = response_factory or (lambda _raw: b"{}")
        self.publish_result = publish_result
        self.wait_for_cancel = wait_for_cancel
        self.started = threading.Event()
        self.cancel_requested = threading.Event()
        self.cancel_freed = threading.Event()
        self.result_freed = threading.Event()
        self._next_result = 1000
        self._buffers = {}
        self.ant0_runtime_abi_version = _CFunc(lambda: 1)
        self.ant0_runtime_cancel_new = _CFunc(lambda: ctypes.c_void_p(77))
        self.ant0_runtime_cancel_request = _CFunc(self._cancel_request)
        self.ant0_runtime_execute_v1 = _CFunc(self._execute)
        self.ant0_runtime_result_bytes = _CFunc(self._result_bytes)
        self.ant0_runtime_result_free = _CFunc(self._result_free)
        self.ant0_runtime_cancel_free = _CFunc(lambda _cancel: self.cancel_freed.set())

    def _cancel_request(self, _cancel):
        self.cancel_requested.set()

    def _execute(self, buf, length, _cancel, out_ptr):
        raw = ctypes.string_at(buf, length)
        self.started.set()
        if self.wait_for_cancel:
            self.cancel_requested.wait(2.0)
        if self.publish_result:
            result_id = self._next_result
            self._next_result += 1
            data = self.response_factory(raw)
            self._buffers[result_id] = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
            out_ptr._obj.value = result_id
        return self.code

    def _result_bytes(self, result, length_ptr):
        result_id = result.value if hasattr(result, "value") else int(result)
        data = self._buffers[result_id]
        length_ptr._obj.value = len(data)
        return ctypes.cast(data, ctypes.POINTER(ctypes.c_uint8))

    def _result_free(self, result):
        result_id = result.value if hasattr(result, "value") else int(result)
        self._buffers.pop(result_id, None)
        self.result_freed.set()


def test_decode_runtime_result_maps_an_unexpected_engine_file_to_its_own_code():
    request = _request(ticket_fetch=True)
    failure = {
        "schema": request["schema"],
        "nonce": request["nonce"],
        "operation": request["operation"],
        "ok": False,
        "status": 409,
        "failure": {
            "error": "browser.unexpected_file",
            "message": "The engine folder has an unexpected file (debug.log); repair or reinstall the engine.",
            "details": {"next_action": "reinstall_engine"},
        },
    }
    with pytest.raises(rc.RuntimeError) as info:
        rc.decode_runtime_result(_bytes(failure), request)
    assert (info.value.code, info.value.status, info.value.next_action) == (
        "browser.unexpected_file", 409, "reinstall_engine")
    assert "debug.log" not in str(info.value)
    # The answer for a missing engine is not accepted for this code: status and action must agree.
    failure["status"] = 404
    failure["failure"]["details"]["next_action"] = "install_engine"
    with pytest.raises(rc.RuntimeError) as info:
        rc.decode_runtime_result(_bytes(failure), request)
    assert info.value.code == "runtime.invalid_response"


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
def test_runtime_binding_is_lazy_and_normalizes_loopback(monkeypatch):
    monkeypatch.setattr(rc, "_load_binding", lambda: (_ for _ in ()).throw(AssertionError("native loaded")))

    assert rc.runtime_binding({}, {}) == {"mode": "v1", "home": None, "descriptor_path": None, "endpoint": None}
    assert rc.runtime_binding({"home": HOME, "url": "http://[::1]:27123", "host": "127.0.0.1"}, {}) == {
        "mode": "v1",
        "home": HOME,
        "descriptor_path": None,
        "endpoint": {"host": "::1", "port": 27123},
    }
    assert rc.runtime_binding({"port": "27100"}, {})["endpoint"] == {"host": "127.0.0.1", "port": 27100}


@pytest.mark.parametrize(
    "options",
    [
        {"home": "relative"},
        {"descriptor_path": "relative"},
        {"url": "http://127.0.0.1:2/"},
        {"url": "https://127.0.0.1:2"},
        {"url": "http://127.0.0.2:2"},
        {"url": "http://127.0.0.1:0"},
        {"host": "example.test", "port": 27100},
        {"port": 65536},
        {"unknown": True},
    ],
)
def test_runtime_binding_rejects_malformed_explicit_selection_without_fallback(options, monkeypatch):
    monkeypatch.setattr(rc, "_load_binding", lambda: (_ for _ in ()).throw(AssertionError("native loaded")))

    with pytest.raises(rc.RuntimeError) as info:
        rc.runtime_binding(options, {})
    assert info.value.code == "runtime.invalid_request"


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
def test_decode_runtime_result_accepts_closed_direct_engine_results():
    request = _request(ticket_fetch=False)
    decoded = rc.decode_runtime_result(_bytes(_success(request)), request)

    assert decoded["engine"]["version"] == ENGINE
    assert decoded["ticket"] is None
    assert decoded["context"] is None


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
def test_decode_runtime_result_accepts_ticket_context_shape():
    request = _request(ticket_fetch=True)
    decoded = rc.decode_runtime_result(_bytes(_success(request)), request)

    assert decoded["ticket"]["launch"] == TICKET
    assert decoded["context"]["device_id"] == DEVICE_ID
    assert decoded["context"]["sign_pub"] == SIGN_PUB


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
@pytest.mark.parametrize(
    "alter",
    [
        lambda v: v.__setitem__("nonce", "B" * 43),
        lambda v: v.__setitem__("extra", True),
        lambda v: v["engine"].__setitem__("default", False),
        lambda v: v["engine"].__setitem__("version", "155.0.0.0-ant0.1"),
        lambda v: v["handshake"].__setitem__("home", os.path.join(HOME, "other")),
        lambda v: v["handshake"].__setitem__("capabilities", v["handshake"]["capabilities"][:-1]),
        lambda v: v["context"].__setitem__("device_id", "a" * 26),
        lambda v: v["context"].__setitem__("sign_pub", base64.b64encode(bytes(range(31))).decode("ascii")),
        lambda v: v["context"].__setitem__("sign_pub", SIGN_PUB.rstrip("=")),
    ],
)
def test_decode_runtime_result_rejects_bad_closed_fields(alter):
    request = _request(ticket_fetch=True)
    response = copy.deepcopy(_success(request))
    alter(response)

    with pytest.raises(rc.RuntimeError) as info:
        rc.decode_runtime_result(_bytes(response), request)
    assert info.value.code == "runtime.invalid_response"


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
def test_decode_runtime_result_rejects_duplicate_keys_and_malformed_bytes():
    request = _request(ticket_fetch=True)
    duplicate = _bytes(_success(request)).replace(b'"default":true', b'"default":true,"default":true')

    for data in (
        duplicate,
        b'{"schema":"x","schema":"y"}',
        b"\xff",
        b"\xef\xbb\xbf" + _bytes(_success(request)),
        _bytes(_success(request)) + b" null",
        b"{" + b" " * 65536 + b"}",
    ):
        with pytest.raises(rc.RuntimeError) as info:
            rc.decode_runtime_result(data, request)
        assert info.value.code == "runtime.invalid_response"


def test_decode_runtime_result_maps_known_failures_without_reflecting_message():
    request = _request(ticket_fetch=True)
    failure = {
        "schema": request["schema"],
        "nonce": request["nonce"],
        "operation": request["operation"],
        "ok": False,
        "status": 503,
        "failure": {
            "error": "runtime.not_running",
            "message": "private native/backend detail",
            "details": {"next_action": "start"},
        },
    }

    with pytest.raises(rc.RuntimeError) as info:
        rc.decode_runtime_result(_bytes(failure), request)
    assert info.value.code == "runtime.not_running"
    assert info.value.status == 503
    assert info.value.next_action == "start"
    assert "private native" not in str(info.value)

    failure["status"] = 200
    with pytest.raises(rc.RuntimeError) as info:
        rc.decode_runtime_result(_bytes(failure), request)
    assert info.value.code == "runtime.invalid_response"


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
def test_ctypes_binding_cancel_requests_running_native_call():
    lib = _FakeRuntimeLib(code=2, publish_result=False, wait_for_cancel=True)
    binding = rc._CtypesBinding(lib)
    cancellation = rc.RuntimeCancellation()
    errors = []

    def worker():
        try:
            binding.execute(b"{}", cancellation)
        except rc.RuntimeError as exc:
            errors.append(exc.code)

    thread = threading.Thread(target=worker)
    thread.start()
    assert lib.started.wait(1.0)
    cancellation.cancel()
    thread.join(1.0)

    assert not thread.is_alive()
    assert lib.cancel_requested.is_set()
    assert lib.cancel_freed.is_set()
    assert errors == ["runtime.invalid_response"]


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
def test_ctypes_binding_releases_output_pointer_on_abi_error():
    lib = _FakeRuntimeLib(code=2, response_factory=lambda _raw: b"{}", publish_result=True)
    binding = rc._CtypesBinding(lib)

    with pytest.raises(rc.RuntimeError) as info:
        binding.execute(b"{}")

    assert info.value.code == "runtime.invalid_response"
    assert lib.result_freed.is_set()
    assert lib.cancel_freed.is_set()


def test_cancel_pointer_is_not_freed_during_concurrent_cancel_request():
    lib = _FakeRuntimeLib(code=2, publish_result=False, wait_for_cancel=True)
    allow_cancel_return = threading.Event()

    def cancel_request(_pointer):
        lib.cancel_requested.set()
        assert allow_cancel_return.wait(1.0)

    lib.ant0_runtime_cancel_request = _CFunc(cancel_request)
    binding = rc._CtypesBinding(lib)
    cancellation = rc.RuntimeCancellation()

    def execute():
        with pytest.raises(rc.RuntimeError):
            binding.execute(b"{}", cancellation)

    worker = threading.Thread(target=execute)
    worker.start()
    assert lib.started.wait(1.0)
    canceller = threading.Thread(target=cancellation.cancel)
    canceller.start()
    assert lib.cancel_requested.wait(1.0)
    try:
        assert not lib.cancel_freed.wait(0.03)
    finally:
        allow_cancel_return.set()
        worker.join(1.0)
        canceller.join(1.0)
    assert not worker.is_alive() and not canceller.is_alive()
    assert lib.cancel_freed.is_set()


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
async def test_prepare_async_cancellation_requests_native_and_releases_late_result(monkeypatch, tmp_path):
    exe = _fake_exe(tmp_path)

    def response(raw):
        request = json.loads(raw.decode("utf-8"))
        body = _success(request)
        body["engine"]["path"] = os.path.dirname(exe)
        body["engine"]["executable"] = exe
        return _bytes(body)

    lib = _FakeRuntimeLib(code=0, response_factory=response, publish_result=True, wait_for_cancel=True)
    monkeypatch.setattr(rc, "_load_binding", lambda: rc._CtypesBinding(lib))

    task = asyncio.create_task(async_api._prepare_async({"identity": {"mode": "native"}, "quiet": True}))
    assert await asyncio.to_thread(lib.started.wait, 1.0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert lib.cancel_requested.is_set()
    assert lib.cancel_freed.is_set()
    assert lib.result_freed.is_set()


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
def test_execute_runtime_pins_native_result_until_release(monkeypatch):
    releases = []

    class Owned:
        def __init__(self, request):
            self.request = request

        def bytes(self):
            return _bytes(_success(self.request))

        def release(self):
            releases.append("released")

    class Binding:
        def execute(self, raw):
            return Owned(json.loads(raw.decode("utf-8")))

    monkeypatch.setattr(rc, "_load_binding", lambda: Binding())
    result = rc.execute_runtime("resolve-direct-engine", _request()["binding"], ENGINE, ticket_fetch=True)

    assert result.value["ticket"]["launch"] == TICKET
    assert releases == []
    result.release()
    result.release()
    assert releases == ["released"]


@pytest.mark.skipif(rc._target() is None, reason="runtime v1 target is defined for Linux/Windows x64")
def test_execute_runtime_releases_invalid_native_results(monkeypatch):
    releases = []

    class Owned:
        def bytes(self):
            return b"{}"

        def release(self):
            releases.append("released")

    class Binding:
        def execute(self, _raw):
            return Owned()

    monkeypatch.setattr(rc, "_load_binding", lambda: Binding())

    with pytest.raises(rc.RuntimeError) as info:
        rc.execute_runtime("resolve-direct-engine", _request()["binding"], ENGINE, ticket_fetch=True)
    assert info.value.code == "runtime.invalid_response"
    assert releases == ["released"]


def test_execute_runtime_releases_native_result_on_keyboard_interrupt(monkeypatch):
    releases = []

    class Owned:
        def bytes(self):
            raise KeyboardInterrupt()

        def release(self):
            releases.append(True)

    class Binding:
        def execute(self, _raw):
            return Owned()

    monkeypatch.setattr(rc, "_load_binding", lambda: Binding())
    with pytest.raises(KeyboardInterrupt):
        rc.execute_runtime("resolve-direct-engine", _request()["binding"], ENGINE)
    assert releases == [True]


def test_prepare_runtime_launch_manual_ticket_paths_do_not_contact_runtime(tmp_path, monkeypatch):
    exe = _fake_exe(tmp_path)
    monkeypatch.setattr(rc, "execute_runtime", lambda *a, **k: (_ for _ in ()).throw(AssertionError("runtime contacted")))
    monkeypatch.setattr(rc, "resolve_launch_ticket_args", lambda *a, **k: (_ for _ in ()).throw(AssertionError("legacy contacted")))

    assert rc.prepare_runtime_launch(executable_path=exe, launch_ticket=False, env={}).ticket_args == []
    assert rc.prepare_runtime_launch(executable_path=exe, launch_ticket=TICKET, env={}).ticket_args == ["--ant0-launch=" + TICKET]
    assert rc.prepare_runtime_launch(executable_path=exe, args=["--ant0-launch=x.y.z.w.v"], env={}).ticket_args == []


def test_prepare_runtime_launch_manual_token_keeps_legacy_raw_transport(tmp_path, monkeypatch):
    exe = _fake_exe(tmp_path)
    seen = {}
    monkeypatch.setattr(rc, "execute_runtime", lambda *a, **k: (_ for _ in ()).throw(AssertionError("runtime contacted")))

    def legacy(launch_ticket, engine_version, executable, args, quiet=False, env=None):
        seen.update(
            launch_ticket=launch_ticket,
            engine_version=engine_version,
            executable=executable,
            args=args,
            quiet=quiet,
            env=env,
        )
        return ["--ant0-launch=legacy.ticket.value.here.ok"]

    monkeypatch.setattr(rc, "resolve_launch_ticket_args", legacy)
    launch = rc.prepare_runtime_launch(
        executable_path=exe,
        engine_version=ENGINE,
        args=["--foo"],
        quiet=True,
        env={"ANT0_TOKEN": "tok"},
    )

    assert launch.executable == exe
    assert launch.ticket_args == ["--ant0-launch=legacy.ticket.value.here.ok"]
    assert seen == {
        "launch_ticket": None,
        "engine_version": ENGINE,
        "executable": exe,
        "args": ["--foo"],
        "quiet": True,
        "env": {"ANT0_TOKEN": "tok"},
    }


def test_prepare_runtime_launch_automatic_rejects_manual_token_before_binding(monkeypatch):
    monkeypatch.setattr(rc, "runtime_binding", lambda *a, **k: (_ for _ in ()).throw(AssertionError("binding evaluated")))
    monkeypatch.setattr(rc, "execute_runtime", lambda *a, **k: (_ for _ in ()).throw(AssertionError("runtime contacted")))

    with pytest.raises(rc.RuntimeError) as info:
        rc.prepare_runtime_launch(env={"ANT0_TOKEN": "tok"})
    assert info.value.code == "runtime.invalid_request"


def test_prepare_runtime_launch_explicit_malformed_runtime_does_not_fallback(tmp_path, monkeypatch):
    exe = _fake_exe(tmp_path)
    monkeypatch.setattr(rc, "execute_runtime", lambda *a, **k: (_ for _ in ()).throw(AssertionError("runtime contacted")))

    with pytest.raises(rc.RuntimeError) as info:
        rc.prepare_runtime_launch(executable_path=exe, engine_version=ENGINE, runtime={"home": "relative"}, env={})
    assert info.value.code == "runtime.invalid_request"


def test_prepare_runtime_launch_automatic_uses_v1_and_releases_once(monkeypatch):
    releases = []
    seen = {}

    class Result:
        value = {"engine": {"executable": ENGINE_EXE}, "ticket": {"launch": TICKET}}

        def release(self):
            releases.append("released")

    def execute(operation, binding, engine_version, ticket_fetch=True):
        seen.update(operation=operation, binding=binding, engine_version=engine_version, ticket_fetch=ticket_fetch)
        return Result()

    monkeypatch.setattr(rc, "execute_runtime", execute)
    launch = rc.prepare_runtime_launch(env={})

    assert launch.executable == ENGINE_EXE
    assert launch.ticket_args == ["--ant0-launch=" + TICKET]
    assert seen == {
        "operation": "resolve-direct-engine",
        "binding": {"mode": "v1", "home": None, "descriptor_path": None, "endpoint": None},
        "engine_version": None,
        "ticket_fetch": True,
    }
    assert releases == []
    launch.release()
    launch.release()
    assert releases == ["released"]


def test_prepare_releases_runtime_pin_when_post_runtime_setup_fails(monkeypatch):
    releases = []

    class Launch:
        executable = "chrome"
        ticket_args = []

        def release(self):
            releases.append("released")

    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", lambda **_kwargs: Launch())
    monkeypatch.setattr(ant0browser, "_guard", lambda _exe: (_ for _ in ()).throw(RuntimeError("guard failed")))

    with pytest.raises(RuntimeError, match="guard failed"):
        ant0browser._prepare({"identity": {"mode": "native"}, "quiet": True})
    assert releases == ["released"]

def test_sync_launch_releases_runtime_pin_when_setup_after_prepare_fails(monkeypatch):
    releases = []
    monkeypatch.setattr(
        ant0browser,
        "_prepare",
        lambda _kwargs: ("chrome", [], {"_ant0_runtime_release": lambda: releases.append("released")}, False, False, None),
    )

    with pytest.raises(ValueError, match="shader_dialect"):
        ant0browser.launch(ephemeral_profile=False, shader_dialect="spirv")
    assert releases == ["released"]


def test_sync_persistent_releases_runtime_pin_when_setup_after_prepare_fails(monkeypatch, tmp_path):
    releases = []
    monkeypatch.setattr(
        ant0browser,
        "_prepare",
        lambda _kwargs: ("chrome", [], {"_ant0_runtime_release": lambda: releases.append("released")}, False, False, None),
    )

    with pytest.raises(ValueError, match="shader_dialect"):
        ant0browser.launch_persistent_context(str(tmp_path), shader_dialect="spirv")
    assert releases == ["released"]


async def test_async_launch_releases_runtime_pin_when_setup_after_prepare_fails(monkeypatch):
    releases = []
    monkeypatch.setattr(
        async_api,
        "_prepare",
        lambda _kwargs: ("chrome", [], {"_ant0_runtime_release": lambda: releases.append("released")}, False, False, None),
    )

    with pytest.raises(ValueError, match="shader_dialect"):
        await async_api.launch(ephemeral_profile=False, shader_dialect="spirv")
    assert releases == ["released"]


async def test_async_persistent_releases_runtime_pin_when_setup_after_prepare_fails(monkeypatch, tmp_path):
    releases = []
    monkeypatch.setattr(
        async_api,
        "_prepare",
        lambda _kwargs: ("chrome", [], {"_ant0_runtime_release": lambda: releases.append("released")}, False, False, None),
    )

    with pytest.raises(ValueError, match="shader_dialect"):
        await async_api.launch_persistent_context(str(tmp_path), shader_dialect="spirv")
    assert releases == ["released"]


def test_serve_releases_runtime_pin_when_setup_after_prepare_fails(monkeypatch, tmp_path):
    releases = []
    monkeypatch.setattr(
        ant0browser,
        "_prepare",
        lambda _kwargs: ("chrome", [], {"_ant0_runtime_release": lambda: releases.append("released")}, False, False, None),
    )
    monkeypatch.setattr(_serve, "_cdp_args", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("cdp setup failed")))

    with pytest.raises(RuntimeError, match="cdp setup failed"):
        _serve.serve(user_data_dir=str(tmp_path / "udd"), quiet=True)
    assert releases == ["released"]

