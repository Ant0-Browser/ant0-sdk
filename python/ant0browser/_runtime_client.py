"""Trusted runtime discovery consumer for the Python SDK.

This module is deliberately inert on import: no filesystem inspection, token reads, native loads,
network calls, process checks or downloads happen until a launch path explicitly asks for runtime
contact. The native binding path is fixed relative to this package and is loaded lazily with
``ctypes`` for the closed ``ant0-runtime-client/v1`` ABI.
"""
from __future__ import annotations

import base64
import contextvars
import ctypes
import json
import os
import platform as _platform
import re
import socket
import sys
import threading
import time as _time
from dataclasses import dataclass
from secrets import token_urlsafe
from typing import Any, Mapping, Optional

from ._errors import Coded, DEFECT, ENVIRONMENT, EXPECTED, SdkTypeError
from ._launch_ticket import (
    ENGINE_VERSION_ENV,
    LAUNCH_TICKET_SWITCH,
    has_launch_ticket_arg,
    infer_engine_version,
    installed_engine_version,
    resolve_daemon_home,
    resolve_launch_ticket_args,
)
from .download import check_install

_SCHEMA = "ant0-runtime-client/v1"
_RELEASE = re.compile(r"^\d+\.\d+\.\d+\.\d+-ant0\.\d+$")
_UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_R32 = re.compile(r"^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
_B32_DEVICE = re.compile(r"^[A-Z2-7]{26}$")
_SIGN_PUB = re.compile(r"^[A-Za-z0-9+/]{43}=$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_TIME = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$")
_APP_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
_URL = re.compile(r"^http://(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$")
_CAPABILITIES = [
    "auth.loopback",
    "auth.device_code",
    "auth.install",
    "engine.status",
    "engine.install",
    "engine.ticket",
    "profiles.managed",
    "automation.scoped",
]
_FAILURES = {
    "runtime.absent": (404, "setup"),
    "runtime.not_running": (503, "start"),
    "runtime.untrusted": (403, "select_home"),
    "runtime.incompatible": (426, "update_runtime"),
    "runtime.conflict": (409, "stop_explicitly"),
    "runtime.invalid_request": (400, "select_home"),
    "runtime.storage": (500, "retry"),
    "runtime.bootstrap_unavailable": (503, "setup"),
    "runtime.timeout": (504, "retry"),
    "runtime.cancelled": (499, "retry"),
    "runtime.transport": (502, "retry"),
    "runtime.invalid_response": (502, "update_runtime"),
    "unauthorized": (401, "login"),
    "licence.required": (403, "login"),
    "licence.profile_limit": (403, "login"),
    "workspace.suspended": (403, "login"),
    "browser.not_found": (404, "install_engine"),
    "browser.not_installed": (404, "install_engine"),
    "browser.proof_mismatch": (409, "reinstall_engine"),
    "browser.unexpected_file": (409, "reinstall_engine"),
    "ticket.invalid": (403, "retry"),
}


def _error_class(code: str) -> str:
    if code in ("runtime.invalid_request", "runtime.invalid_response"):
        return DEFECT
    if code.startswith(("runtime.", "browser.")) and code != "runtime.cancelled":
        return ENVIRONMENT
    return EXPECTED


class RuntimeError(Coded, Exception):
    """Closed runtime failure surfaced by the SDK wrapper."""

    def __init__(self, code: str, cause: Optional[BaseException] = None):
        status, next_action = _FAILURES.get(code, _FAILURES["runtime.invalid_response"])
        super().__init__(f"ant0-browser: {code}; next action: {next_action}")
        self.code = code
        self.status = status
        self.next_action = next_action
        self.error_class = _error_class(code)
        if cause is not None:
            self.__cause__ = cause


def _invalid() -> None:
    raise RuntimeError("runtime.invalid_request")


def _bad() -> None:
    raise RuntimeError("runtime.invalid_response")


_RUNTIME_CANCELLATION: contextvars.ContextVar[Optional["RuntimeCancellation"]] = contextvars.ContextVar(
    "ant0_runtime_cancellation", default=None
)


class RuntimeCancellation:
    """Thread-safe cancellation fanout for one runtime operation tree."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled = False
        self._calls: set[Any] = set()

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    def register(self, call: Any) -> None:
        cancel_now = False
        with self._lock:
            if self._cancelled:
                cancel_now = True
            else:
                self._calls.add(call)
        if cancel_now:
            cancel = getattr(call, "cancel", None)
            if callable(cancel):
                cancel()

    def unregister(self, call: Any) -> None:
        with self._lock:
            self._calls.discard(call)

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True
            calls = list(self._calls)
        for call in calls:
            cancel = getattr(call, "cancel", None)
            if callable(cancel):
                cancel()


def run_with_runtime_cancellation(cancellation: RuntimeCancellation, func, *args, **kwargs):
    token = _RUNTIME_CANCELLATION.set(cancellation)
    try:
        return func(*args, **kwargs)
    finally:
        _RUNTIME_CANCELLATION.reset(token)


def _target() -> Optional[str]:
    if _platform.machine().lower() not in {"x86_64", "amd64"}:
        return None
    if sys.platform == "win32":
        return "windows-x64"
    if sys.platform.startswith("linux"):
        return "linux-x64"
    return None


def _target_file() -> Optional[str]:
    target = _target()
    if target == "windows-x64":
        return os.path.join(os.path.dirname(__file__), "_native", target, "ant0_runtime.dll")
    if target == "linux-x64":
        return os.path.join(os.path.dirname(__file__), "_native", target, "libant0_runtime.so")
    return None


def _is_abs_path(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value.encode("utf-8")) <= 4096 and "\0" not in value and os.path.isabs(value)


def _integer(value: Any, lo: int, hi: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi


def _iso_time(value: Any) -> bool:
    if not isinstance(value, str) or not _TIME.match(value):
        return False
    try:
        # Parse enough to reject impossible dates while preserving the contract's UTC Z form.
        from datetime import datetime
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _exact(value: Any, keys: list[str]) -> bool:
    return isinstance(value, dict) and not isinstance(value, list) and set(value.keys()) == set(keys) and len(value) == len(keys)


def _parse_json_bytes(data: bytes) -> Any:
    if not data or len(data) > 65536:
        _bad()
    if data.startswith(b"\xef\xbb\xbf"):
        _bad()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        _bad()

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in items:
            if key in out:
                _bad()
            out[key] = value
        return out

    decoder = json.JSONDecoder(object_pairs_hook=pairs)
    try:
        value, end = decoder.raw_decode(text)
    except ValueError:
        _bad()
    if text[end:].strip():
        _bad()
    return value


def _runtime_options(options: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    if options is None:
        return {}
    if not isinstance(options, Mapping):
        _invalid()
    allowed = {"home", "descriptor_path", "descriptorPath", "url", "host", "port"}
    if any(key not in allowed for key in options):
        _invalid()
    return options


def _env_get(env: Mapping[str, str], key: str) -> Optional[str]:
    value = env.get(key)
    return value if value is not None else None


def _parse_port(value: Any) -> int:
    if isinstance(value, str):
        if not re.match(r"^[1-9][0-9]{0,4}$", value):
            _invalid()
        value = int(value)
    if not _integer(value, 1, 65535):
        _invalid()
    return int(value)


def _numeric_host(host: str) -> str:
    if host == "localhost":
        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except OSError:
            _invalid()
        addresses = []
        for info in infos:
            address = info[4][0]
            if address not in addresses:
                addresses.append(address)
        if not addresses or any(address not in {"127.0.0.1", "::1"} for address in addresses):
            _invalid()
        return addresses[0]
    if host not in {"127.0.0.1", "::1"}:
        _invalid()
    return host


def runtime_binding(options: Optional[Mapping[str, Any]] = None, env: Optional[Mapping[str, str]] = None) -> dict[str, Any]:
    """Normalize explicit runtime selection without loading native code or reading credentials."""
    opts = _runtime_options(options)
    env = os.environ if env is None else env
    home = opts.get("home", _env_get(env, "ANT0_HOME"))
    descriptor_path = opts.get("descriptor_path", opts.get("descriptorPath", _env_get(env, "ANT0_RUNTIME_DESCRIPTOR")))
    if home is not None and not _is_abs_path(home):
        _invalid()
    if descriptor_path is not None and not _is_abs_path(descriptor_path):
        _invalid()

    url = opts.get("url", _env_get(env, "ANT0_URL"))
    host: Any = opts.get("host", _env_get(env, "ANT0D_HOST"))
    port: Any = opts.get("port", _env_get(env, "ANT0D_PORT"))
    if url is not None:
        if not isinstance(url, str):
            _invalid()
        match = _URL.match(url)
        if not match:
            _invalid()
        host = "::1" if match.group(1) == "[::1]" else match.group(1)
        port = int(match.group(2))

    endpoint = None
    if host is not None or port is not None:
        if host is None:
            host = "127.0.0.1"
        if port is None:
            port = 27100
        if not isinstance(host, str):
            _invalid()
        endpoint = {"host": _numeric_host(host), "port": _parse_port(port)}
    return {"mode": "v1", "home": home, "descriptor_path": descriptor_path, "endpoint": endpoint}


class _NativeResult:
    def __init__(self, lib: ctypes.CDLL, ptr: ctypes.c_void_p):
        self._lib = lib
        self._ptr = ptr
        self._released = False

    def bytes(self) -> bytes:
        if self._released:
            _bad()
        length = ctypes.c_uint64(0)
        data = self._lib.ant0_runtime_result_bytes(self._ptr, ctypes.byref(length))
        if not data or length.value > 65536:
            _bad()
        return ctypes.string_at(data, length.value)

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._lib.ant0_runtime_result_free(self._ptr)


class _CtypesCall:
    def __init__(self, lib: ctypes.CDLL, request: bytes):
        self._lib = lib
        self._request = request
        self._lock = threading.Lock()
        self._cancel = lib.ant0_runtime_cancel_new()
        self._cancel_freed = False
        if not self._cancel:
            raise RuntimeError("runtime.invalid_response")

    def cancel(self) -> None:
        with self._lock:
            cancel = None if self._cancel_freed else self._cancel
            # Keep the pointer alive through the C call: execute may return and free it
            # concurrently while ctypes has released the GIL.
            if cancel:
                self._lib.ant0_runtime_cancel_request(cancel)

    def _free_cancel(self) -> None:
        with self._lock:
            if self._cancel_freed:
                return
            cancel = self._cancel
            self._cancel_freed = True
            self._cancel = None
        if cancel:
            self._lib.ant0_runtime_cancel_free(cancel)

    def _release_out(self, out: ctypes.c_void_p) -> None:
        if out.value:
            self._lib.ant0_runtime_result_free(out)
            out.value = None

    def run(self) -> _NativeResult:
        out = ctypes.c_void_p()
        returned = False
        try:
            buf = (ctypes.c_uint8 * len(self._request)).from_buffer_copy(self._request)
            code = self._lib.ant0_runtime_execute_v1(buf, len(self._request), self._cancel, ctypes.byref(out))
            if code == 1:
                self._release_out(out)
                raise RuntimeError("runtime.invalid_request")
            if code == 2:
                self._release_out(out)
                raise RuntimeError("runtime.invalid_response")
            if code != 0 or not out.value:
                self._release_out(out)
                raise RuntimeError("runtime.invalid_response")
            returned = True
            return _NativeResult(self._lib, out)
        except BaseException:
            if not returned:
                self._release_out(out)
            raise
        finally:
            self._free_cancel()


class _CtypesBinding:
    def __init__(self, lib: ctypes.CDLL):
        self._lib = lib
        self._configure()

    def _configure(self) -> None:
        lib = self._lib
        lib.ant0_runtime_abi_version.argtypes = []
        lib.ant0_runtime_abi_version.restype = ctypes.c_uint32
        lib.ant0_runtime_cancel_new.argtypes = []
        lib.ant0_runtime_cancel_new.restype = ctypes.c_void_p
        lib.ant0_runtime_cancel_request.argtypes = [ctypes.c_void_p]
        lib.ant0_runtime_cancel_request.restype = None
        lib.ant0_runtime_execute_v1.argtypes = [ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint64, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        lib.ant0_runtime_execute_v1.restype = ctypes.c_uint32
        lib.ant0_runtime_result_bytes.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint64)]
        lib.ant0_runtime_result_bytes.restype = ctypes.POINTER(ctypes.c_uint8)
        lib.ant0_runtime_result_free.argtypes = [ctypes.c_void_p]
        lib.ant0_runtime_result_free.restype = None
        lib.ant0_runtime_cancel_free.argtypes = [ctypes.c_void_p]
        lib.ant0_runtime_cancel_free.restype = None
        if lib.ant0_runtime_abi_version() != 1:
            raise RuntimeError("runtime.incompatible")

    def execute(self, request: bytes, cancellation: Optional[RuntimeCancellation] = None) -> _NativeResult:
        if not request or len(request) > 16384:
            raise RuntimeError("runtime.invalid_request")
        call = _CtypesCall(self._lib, request)
        if cancellation is not None:
            cancellation.register(call)
        try:
            return call.run()
        finally:
            if cancellation is not None:
                cancellation.unregister(call)


def _load_binding() -> _CtypesBinding:
    path = _target_file()
    if path is None:
        raise RuntimeError("runtime.bootstrap_unavailable")
    try:
        if sys.platform == "win32":
            lib = ctypes.WinDLL(path, winmode=0x00000800)  # LOAD_LIBRARY_SEARCH_SYSTEM32 for deps.
        else:
            lib = ctypes.CDLL(path)
        return _CtypesBinding(lib)
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError("runtime.bootstrap_unavailable") from None


def _nonce() -> str:
    return token_urlsafe(32)


def _request_bytes(request: Mapping[str, Any]) -> bytes:
    data = json.dumps(request, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(data) > 16384:
        raise RuntimeError("runtime.invalid_request")
    return data


def decode_runtime_result(data: bytes, request: Mapping[str, Any]) -> dict[str, Any]:
    value = _parse_json_bytes(data)
    base = ["schema", "nonce", "operation", "ok"]
    if not isinstance(value, dict) or value.get("schema") != request.get("schema") or value.get("nonce") != request.get("nonce") or value.get("operation") != request.get("operation"):
        _bad()
    if value.get("ok") is False:
        if not _exact(value, base + ["status", "failure"]):
            _bad()
        failure = value.get("failure")
        if not _exact(failure, ["error", "message", "details"]) or not _exact(failure.get("details"), ["next_action"]):
            _bad()
        expected = _FAILURES.get(failure.get("error"))
        message = failure.get("message")
        if (expected is None or value.get("status") != expected[0]
                or failure["details"].get("next_action") != expected[1]
                or not isinstance(message, str) or not 1 <= len(message) <= 240):
            _bad()
        raise RuntimeError(failure["error"])

    resolving = request.get("operation") == "resolve-direct-engine"
    expected_keys = base + ["handshake"] + (["engine"] if resolving else []) + ["ticket", "context"]
    if value.get("ok") is not True or not _exact(value, expected_keys):
        _bad()
    handshake = value["handshake"]
    binding = request.get("binding")
    if isinstance(binding, dict) and binding.get("mode") == "legacy":
        if handshake is not None or resolving:
            _bad()
    else:
        _validate_handshake(handshake, binding)
    if resolving:
        _validate_engine(value["engine"], handshake, request.get("engine_version"))
    if resolving and request.get("ticket_fetch") is False:
        if value["ticket"] is not None or value["context"] is not None:
            _bad()
    else:
        _validate_ticket(value["ticket"], value["context"], value["engine"]["version"] if resolving else request.get("engine_version"))
    return value


def _validate_handshake(handshake: Any, binding: Any) -> None:
    keys = ["protocol", "nonce", "install_id", "generation", "app_version", "target", "pid", "home", "daemon_sha256", "auth_protocol", "engine_ticket", "capabilities", "lifecycle"]
    if not _exact(handshake, keys):
        _bad()
    target = _target()
    if (handshake["protocol"] != "ant0-runtime/v1" or not _R32.match(handshake["nonce"])
            or not _UUID_V4.match(handshake["install_id"]) or not _UUID_V4.match(handshake["generation"])
            or not isinstance(handshake["app_version"], str) or not _APP_VERSION.match(handshake["app_version"])
            or handshake["target"] != target or not _integer(handshake["pid"], 1, 2147483647)
            or not _is_abs_path(handshake["home"]) or not _SHA256.match(handshake["daemon_sha256"])
            or handshake["auth_protocol"] != "ant0-native-auth/v1" or handshake["engine_ticket"] != "ant0-launch/v1"
            or handshake["lifecycle"] not in {"desktop", "manual", "persistent"}
            or not isinstance(handshake["capabilities"], list)
            or len(handshake["capabilities"]) != len(_CAPABILITIES)
            or any(cap not in handshake["capabilities"] for cap in _CAPABILITIES)):
        _bad()
    if isinstance(binding, dict) and binding.get("home") is not None and handshake["home"] != binding.get("home"):
        _bad()


def _validate_engine(engine: Any, handshake: Any, requested_version: Any) -> None:
    keys = ["version", "chromium", "target", "path", "executable", "installed_at", "size_bytes", "default"]
    if not _exact(engine, keys):
        _bad()
    if (not isinstance(engine["version"], str) or not _RELEASE.match(engine["version"])
            or engine["chromium"] != engine["version"].split("-ant0.", 1)[0]
            or engine["target"] != handshake.get("target") or not _is_abs_path(engine["path"])
            or not _is_abs_path(engine["executable"]) or not _iso_time(engine["installed_at"])
            or not _integer(engine["size_bytes"], 0, 8589934592) or engine["default"] is not True
            or requested_version is not None and engine["version"] != requested_version):
        _bad()


def _validate_ticket(ticket: Any, context: Any, engine_version: Any) -> None:
    if not _exact(ticket, ["launch", "engine", "expires_at"]):
        _bad()
    launch = ticket.get("launch")
    if (not isinstance(launch, str) or len(launch.encode("utf-8")) > 16384
            or launch.count(".") != 4 or ticket.get("engine") != engine_version or not _iso_time(ticket.get("expires_at"))):
        _bad()
    if not _exact(context, ["device_id", "sign_pub", "workspace_id"]):
        _bad()
    sign_pub = context.get("sign_pub")
    try:
        decoded = base64.b64decode(sign_pub, validate=True) if isinstance(sign_pub, str) else b""
    except Exception:
        decoded = b""
    if (not isinstance(context.get("device_id"), str) or not _B32_DEVICE.match(context["device_id"])
            or not isinstance(sign_pub, str) or not _SIGN_PUB.match(sign_pub) or len(decoded) != 32
            or base64.b64encode(decoded).decode("ascii") != sign_pub
            or not isinstance(context.get("workspace_id"), str) or not _UUID_V4.match(context["workspace_id"])):
        _bad()


@dataclass
class RuntimeExecution:
    value: dict[str, Any]
    _native_result: Any
    _released: bool = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            release = getattr(self._native_result, "release", None)
            if callable(release):
                release()


def execute_runtime(operation: str, binding: Mapping[str, Any], engine_version: Optional[str],
                    ticket_fetch: bool = True, cancellation: Optional[RuntimeCancellation] = None) -> RuntimeExecution:
    if cancellation is None:
        cancellation = _RUNTIME_CANCELLATION.get()
    if cancellation is not None and cancellation.cancelled:
        raise RuntimeError("runtime.cancelled")
    if operation not in {"resolve-direct-engine", "fetch-ticket"}:
        raise RuntimeError("runtime.invalid_request")
    if engine_version is not None and not _RELEASE.match(engine_version):
        raise RuntimeError("runtime.invalid_request")
    if operation == "fetch-ticket" and engine_version is None:
        raise RuntimeError("runtime.invalid_request")
    request = {
        "schema": _SCHEMA,
        "nonce": _nonce(),
        "operation": operation,
        "binding": binding,
        "engine_version": engine_version,
    }
    if operation == "resolve-direct-engine":
        request["ticket_fetch"] = bool(ticket_fetch)
    raw = _request_bytes(request)
    started = _time.monotonic()
    native = _load_binding()
    if _time.monotonic() - started >= 180:
        raise RuntimeError("runtime.timeout")
    if cancellation is not None and cancellation.cancelled:
        raise RuntimeError("runtime.cancelled")
    result = None
    try:
        result = native.execute(raw, cancellation) if cancellation is not None else native.execute(raw)
        data = result.bytes() if hasattr(result, "bytes") else bytes(result.bytes)
        value = decode_runtime_result(data, request)
        return RuntimeExecution(value, result)
    except RuntimeError:
        if result is not None:
            release = getattr(result, "release", None)
            if callable(release):
                release()
        raise
    except BaseException as exc:
        if result is not None:
            release = getattr(result, "release", None)
            if callable(release):
                release()
        if not isinstance(exc, Exception):
            raise
        raise RuntimeError("runtime.invalid_response") from None


def _warn(quiet: bool, env: Mapping[str, str], message: str) -> None:
    if not quiet and env.get("ANT0_BROWSER_NO_WARN") is None:
        sys.stderr.write(f"[ant0-browser] [launch-ticket] {message}\n")


@dataclass
class RuntimeLaunch:
    executable: str
    ticket_args: list[str]
    _release: Any
    _released: bool = False
    #: Release the resolved engine identifies as; None when unknown (a bare binary).
    engine_version: Optional[str] = None

    def release(self) -> None:
        if not self._released:
            self._released = True
            if callable(self._release):
                self._release()


def _noop() -> None:
    return None


def _manual_binary(executable_path: Optional[str], env: Mapping[str, str]) -> Optional[str]:
    if executable_path:
        return executable_path
    value = env.get("ANT0_BROWSER_BINARY")
    return value.strip() if isinstance(value, str) and value.strip() else None


def prepare_runtime_launch(*, executable_path: Optional[str] = None, launch_ticket: Any = None,
                           engine_version: Optional[str] = None, runtime: Optional[Mapping[str, Any]] = None,
                           args: Optional[list[str]] = None, quiet: bool = False,
                           env: Optional[Mapping[str, str]] = None) -> RuntimeLaunch:
    """Resolve executable and launch-ticket args for one immediate launch attempt."""
    env = os.environ if env is None else env
    args = list(args or [])
    suppressed = launch_ticket is False or has_launch_ticket_arg(args)
    supplied = (not suppressed) and isinstance(launch_ticket, str)
    if supplied and launch_ticket.count(".") != 4:
        raise SdkTypeError("sdk.launch_ticket_invalid", "launch_ticket must be the five-segment value the daemon issues")
    if (not suppressed) and launch_ticket is not None and not isinstance(launch_ticket, str):
        raise SdkTypeError("sdk.launch_ticket_invalid", "launch_ticket must be a str, False or None")
    ticket_args = [f"--{LAUNCH_TICKET_SWITCH}={launch_ticket}"] if supplied else []
    executable = _manual_binary(executable_path, env)
    if executable:
        check_install(executable)
        engine = engine_version or infer_engine_version(executable, env)
        # What the --webrtc-ip gate may trust: the caller's explicit word (the daemon passes its
        # verified install record) or the release record beside the executable. Not the path or env.
        trusted = engine_version or installed_engine_version(executable)
        if suppressed or supplied:
            return RuntimeLaunch(executable, ticket_args, _noop, engine_version=trusted)
        if not engine:
            return RuntimeLaunch(executable, ticket_args, _noop, engine_version=trusted)
        if "ANT0_TOKEN" in env:
            return RuntimeLaunch(
                executable,
                resolve_launch_ticket_args(None, engine, executable, args, quiet=quiet, env=env),
                _noop,
                engine_version=trusted,
            )
        binding = runtime_binding(runtime, env)
        try:
            try:
                result = execute_runtime("fetch-ticket", binding, engine)
            except RuntimeError as exc:
                if exc.code != "runtime.absent" or binding.get("mode") != "v1" or binding.get("descriptor_path") is not None:
                    raise
                home = binding.get("home") or resolve_daemon_home(env)
                endpoint = binding.get("endpoint")
                if endpoint is None:
                    pid_path = os.path.join(home, "ant0d.pid")
                    try:
                        with open(pid_path, "rb") as handle:
                            raw = handle.read(16385)
                        if len(raw) > 16384:
                            raise ValueError()
                        pid = json.loads(raw.decode("utf-8"))
                    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
                        raise RuntimeError("runtime.not_running") from None
                    normalized = runtime_binding({"home": home, "host": pid.get("host"), "port": pid.get("port")}, {})
                    endpoint = normalized.get("endpoint")
                    if endpoint is None:
                        raise RuntimeError("runtime.invalid_request")
                result = execute_runtime("fetch-ticket", {"mode": "legacy", "home": home, "endpoint": endpoint}, engine)
            return RuntimeLaunch(executable, [f"--{LAUNCH_TICKET_SWITCH}={result.value['ticket']['launch']}"], result.release, engine_version=trusted)
        except RuntimeError as exc:
            explicit_descriptor = binding.get("mode") == "v1" and binding.get("descriptor_path") is not None
            fatal = exc.code in {"runtime.invalid_request", "runtime.untrusted", "runtime.incompatible", "runtime.invalid_response"}
            if explicit_descriptor or fatal:
                raise
            _warn(quiet, env, f"{exc.code}; launching without a ticket")
            return RuntimeLaunch(executable, [], _noop, engine_version=trusted)

    if "ANT0_TOKEN" in env:
        raise RuntimeError("runtime.invalid_request")
    binding = runtime_binding(runtime, env)
    requested_engine = engine_version or env.get(ENGINE_VERSION_ENV) or None
    result = execute_runtime("resolve-direct-engine", binding, requested_engine, (not suppressed) and (not supplied))
    ticket = result.value.get("ticket")
    return RuntimeLaunch(
        result.value["engine"]["executable"],
        [f"--{LAUNCH_TICKET_SWITCH}={ticket['launch']}"] if ticket else ticket_args,
        result.release,
        engine_version=result.value["engine"].get("version"),
    )
