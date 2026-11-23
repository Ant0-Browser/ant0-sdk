"""ant0browser serve — launch the engine with a RAW CDP endpoint that any existing
automation stack attaches to over ``connect_over_cdp`` **without changing its code**:

    from ant0browser import serve
    srv = serve(identity={"mode": "native"})   # returns a Server handle
    # Playwright : p.chromium.connect_over_cdp(srv.cdp_url)
    # Puppeteer  : puppeteer.connect({ browserURL: srv.cdp_url })
    # browser-use / Crawl4AI / Stagehand : point the CDP endpoint at srv.cdp_url
    srv.close()

This is the "drop-in for CDP clients" mode: unlike ``launch()`` (which spawns and
*owns* a Playwright browser), ``serve()`` leaves a standing browser you attach to.

WHY THE PERSONA STAYS INTACT:
  * The binary is launched **directly** — NOT through Playwright/Puppeteer — so the
    ``--enable-automation`` flag those frameworks add is **never present**. That flag is what
    flips ``navigator.webdriver`` and the AutomationControlled tells; without it, webdriver stays
    ``false`` and the persona is intact.
  * Attaching a CDP client later adds **no launch flags** (you can't change flags on a running
    browser), so the persona you served with is exactly what the page sees.
  * The engine stops ``Runtime.enable`` from running page code (no console-argument
    serialization, live or replayed, so no getter, Proxy trap or ``toString`` fires). It does not
    change what an attached client adds itself (init scripts, exposed bindings, emulation
    overrides, other CDP domains).
  * The debug port binds to **loopback** with an **origin allowlist**, so a web page cannot reach
    or hijack it.
Net: an ordinary Chrome to the page, an open CDP channel to your tools.
"""
from __future__ import annotations

import atexit
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from ._errors import SdkRuntimeError
from ._profile_file import remove_stale_persona_file
from ._launch_ticket import (CALLER_ENV_KEY, retry_stale_ticket, LAUNCH_TICKET_EXIT_CODE, LaunchTicketRejectedError, apply_ticket_env, drop_partial_first_line,
                             launch_secret_values, launch_ticket_rejection, redact_launch_secrets)
from ._persona_rejected import PersonaFileRejectedError, persona_file_rejection, persona_inactive_reason


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class _StderrTail:
    """Drains a child's stderr on a daemon thread, keeping the last 8 KB."""

    def __init__(self, stream, limit=8192):
        self._chunks = bytearray()
        self._limit = limit
        self._lock = threading.Lock()
        #: Set once a complete "profile remains inactive" line has been seen.
        self.inactive_reason = None
        self._pending = b""
        self._thread = threading.Thread(target=self._drain, args=(stream,), daemon=True)
        self._thread.start()

    def _drain(self, stream):
        try:
            for chunk in iter(lambda: stream.read1(4096) if hasattr(stream, "read1") else stream.read(4096), b""):
                with self._lock:
                    self._chunks += chunk
                    del self._chunks[:-self._limit]
                self._scan(chunk)
        except (OSError, ValueError):
            pass

    def _scan(self, chunk):
        if self.inactive_reason is not None:
            return
        data = self._pending + chunk
        cut = data.rfind(b"\n")
        if cut < 0:
            self._pending = data[-self._limit:]
            return
        self._pending = data[cut + 1:][-self._limit:]
        self.inactive_reason = persona_inactive_reason(data[:cut + 1].decode("utf-8", "replace"))

    def text(self) -> str:
        self._thread.join(timeout=0.5)  # let a just-exited child's last line land
        with self._lock:
            return bytes(self._chunks).decode("utf-8", "replace")


# ---- Exit-time cleanup registry ---------------------------------------------------------------
# One atexit hook, installed lazily, for every live Server and every in-flight launch. It is
# SYNCHRONOUS and BOUNDED: about EXIT_DIR_BUDGET seconds per temp dir and EXIT_TOTAL_BUDGET seconds in
# all (children are signalled first and waited for against one shared deadline; dir removal retries
# sleep between tries, never spin). When the budget runs out it gives up and accepts the leak. It only
# ever removes a temp dir serve() created itself, never a caller-supplied user_data_dir.
EXIT_DIR_BUDGET = 1.0
EXIT_TOTAL_BUDGET = 3.0
_live = set()
_hook_installed = False


class _Entry:
    __slots__ = ("proc", "own_dir")

    def __init__(self, proc, own_dir):
        self.proc = proc
        self.own_dir = own_dir


def _track(proc, own_dir=None):
    global _hook_installed
    entry = _Entry(proc, own_dir)
    if not _hook_installed:
        atexit.register(_exit_cleanup)
        _hook_installed = True
    _live.add(entry)
    return entry


def _untrack(entry):
    _live.discard(entry)


def _remove_within(path, deadline, rmtree, exists, sleep, clock):
    attempt = 0
    while True:
        attempt += 1
        try:
            rmtree(path, ignore_errors=True)
            if not exists(path):
                return
        except Exception:
            pass
        left = deadline - clock()
        if left <= 0:
            return                      # budget spent: accept the leak
        sleep(min(0.05 * attempt, left))


def _exit_cleanup(rmtree=shutil.rmtree, exists=os.path.exists, sleep=time.sleep, clock=time.monotonic):
    entries = list(_live)
    start = clock()
    for e in entries:                   # signal everyone first, so shutdowns overlap
        try:
            if e.proc.poll() is None:
                # A throwaway temp profile has nothing to flush (and a graceful Chromium would write
                # files back into the dir we are about to remove): kill. Persistent / caller-supplied
                # dirs get SIGTERM so they shut down gracefully.
                e.proc.kill() if e.own_dir else e.proc.terminate()
        except Exception:
            pass
    for e in entries:                   # then wait once, against a shared deadline
        left = start + EXIT_TOTAL_BUDGET - clock()
        try:
            e.proc.wait(timeout=max(left, 0.0))
        except Exception:
            pass
    for e in entries:
        if e.own_dir:
            _remove_within(e.own_dir, min(clock() + EXIT_DIR_BUDGET, start + EXIT_TOTAL_BUDGET),
                           rmtree, exists, sleep, clock)


class Server:
    """Handle for a standing ant0browser CDP endpoint. Use ``.cdp_url`` with any CDP client."""

    def __init__(self, process, host, port, user_data_dir, own_udd):
        self.process = process
        self.host = host
        self.port = port
        self.user_data_dir = user_data_dir
        self._own_udd = own_udd
        self._closed = False
        self._entry = _track(process, user_data_dir if own_udd else None)

    @property
    def cdp_url(self) -> str:
        """The HTTP CDP base — pass to ``connect_over_cdp`` / ``puppeteer.connect({browserURL})``."""
        return "http://%s:%d" % (self.host, self.port)

    @property
    def ws_url(self):
        """The browser-level WebSocket URL (for clients that want ``connect({browserWSEndpoint})``)."""
        try:
            with urllib.request.urlopen(self.cdp_url + "/json/version", timeout=5) as r:
                return json.load(r).get("webSocketDebuggerUrl")
        except Exception:
            return None

    def is_alive(self) -> bool:
        return self.process.poll() is None

    def close(self):
        """Stop the browser (SIGTERM, SIGKILL only if it does not exit within 10 s), wait for it, then
        remove the temp profile dir ``serve()`` created. A ``user_data_dir`` you passed is never deleted.

        Ctrl+C / SIGTERM cleanup is the application's job: call ``close()`` (or use ``with serve():``).
        The SDK installs no signal handlers; an ``atexit`` hook covers a normal interpreter exit."""
        if self._closed:
            return
        self._closed = True
        try:
            self.process.terminate()
            self.process.wait(timeout=10)
        except Exception:
            try:
                self.process.kill()
                self.process.wait(timeout=5)   # reap it BEFORE removing the dir it may still write to
            except Exception:
                pass
        if self._own_udd:
            shutil.rmtree(self.user_data_dir, ignore_errors=True)
        _untrack(self._entry)

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        self.close()


@retry_stale_ticket
def serve(port=None, host="127.0.0.1", allow_origins=None, user_data_dir=None,
          headless=True, ready_timeout=30.0, quiet=False, **kwargs):
    """Launch ant0browser and expose a raw CDP endpoint; return a :class:`Server`.

    ``port``          bound port (default: a free ephemeral port; pass 9222 for the conventional one).
    ``host``          bind address — keep it loopback (default 127.0.0.1) for safety.
    ``allow_origins`` CDP ``--remote-allow-origins`` value (default: the loopback origins only). Pass
                      ``"*"`` only for trusted local use.
    ``user_data_dir`` persistent profile dir (default: a fresh temp dir, removed on close).
    ``headless``      run headless (default True; pass False for a visible window).
    All other kwargs use the same identity and engine options as ``launch()``: ``overrides``, ``args``,
    ``extensions``, ``shader_dialect`` (validated exactly as ``launch()`` does), ``widevine`` (seeded
    into the served profile), ``resolve_fonts``, ``env`` (over ``os.environ``; ``None`` values dropped,
    others ``str()``-ed), ``quiet``, the launch ticket / runtime options, and a ``proxy`` dict's
    ``server`` and ``bypass`` (a ``--proxy-bypass-list`` in ``args`` wins). ``chromium_sandbox=False``
    adds ``--no-sandbox``.

    Differences from ``launch()``: the binary is spawned directly, WITHOUT Playwright's default
    switches (for example ``--disable-field-trial-config``,
    ``--disable-back-forward-cache``, ``--force-color-profile=srgb`` and Playwright's feature lists),
    so some browser defaults differ. The sandbox stays on unless you pass ``chromium_sandbox=False``.
    Loopback: ``launch()`` forces ``<-loopback>`` into the proxy bypass list, so ``http://localhost``
    goes through the proxy; ``serve()`` does not, which matches stock Chrome (localhost is direct).
    Playwright-only options are ignored: ``humanize``, ``show_cursor``, ``timeout``,
    ``ignore_default_args``, ``downloads_path``, ``slow_mo``, ``traces_dir`` and every browser-context
    option (``viewport``, ``locale``, ``user_agent``, ...). The attached client sets those. Proxy
    ``username``/``password`` cannot be applied without Playwright.

    First-run hygiene: Playwright's ``launch()`` passes ``--no-first-run``,
    ``--no-default-browser-check`` and ``--disable-search-engine-choice-screen`` on its own;
    ``serve()`` adds the same three switches (plain UI switches, no ``base::Feature`` toggles,
    nothing a page can observe) and, when ``args`` carries no URL positional, opens ``about:blank``.
    Without them the engine opens ``chrome://ungoogled-first-run`` in the first tab.
    """
    # Lazy import to avoid a circular import at module load (this module is imported by __init__).
    from . import _prepare, _resolve_identity_option, _take_internal
    from ._fonts import apply_font_env
    from ._launchopts import proxy_bypass_args
    from ._shaderdialect import apply_shader_dialect
    from ._widevine import apply_widevine_launch

    kwargs.pop("headless", None)  # serve() drives headless directly via --headless=new
    kwargs["_ant0_headed"] = not headless  # lets _prepare keep a visible window on the real display
    kwargs["_ant0_dom_storage_pin"] = True  # no Playwright disabled list to lose: always pin leveldb
    kwargs["quiet"] = quiet  # `quiet` is a named parameter here, so _prepare would never see it
    shader_dialect = kwargs.pop("shader_dialect", None)  # not a Playwright option; validated below
    # Playwright adds --no-sandbox unless chromium_sandbox is True; a direct spawn keeps Chromium's
    # sandbox on by default and drops it only when the caller says chromium_sandbox=False.
    no_sandbox = kwargs.pop("chromium_sandbox", None) is False

    own_udd = False
    runtime_release = None
    try:
        port = int(port) if port else _free_port()
        own_udd = user_data_dir is None
        if own_udd:
            user_data_dir = tempfile.mkdtemp(prefix="ant0-browser-serve-")
        origins = allow_origins if allow_origins is not None else \
            "http://%s:%d,http://localhost:%d" % (host, port, port)

        # Build the full launch policy exactly like launch_persistent_context(), then launch the
        # binary ourselves. widevine=True seeds the CDM into this profile before _prepare reads args.
        kwargs["_ant0_user_data_dir"] = os.fspath(user_data_dir)
        _resolve_identity_option(kwargs)
        if kwargs.get("widevine"):
            apply_widevine_launch(user_data_dir, kwargs, quiet=quiet)
        exe, args, pw_kwargs, _humanize, _show, _seed = _prepare(kwargs)
        _native, _dpr, font_pack, runtime_release = _take_internal(pw_kwargs)

        prox = pw_kwargs.get("proxy")
        proxy_server = prox.get("server") if isinstance(prox, dict) else None
        cdp = _cdp_args(port, host, origins, user_data_dir, headless, proxy_server, args,
                        proxy_bypass=proxy_bypass_args(prox), no_sandbox=no_sandbox)

        # Same env helpers as launch(): os.environ < font wiring < caller env, then the shader
        # dialect (validated here, so a bad value raises the same error launch() raises).
        env_kw = {"env": pw_kwargs["env"]} if pw_kwargs.get("env") else {}
        apply_font_env(exe, env_kw, font_pack)  # Linux: FONTCONFIG_FILE -> real font pack or clones (no-op elsewhere)
        apply_shader_dialect(shader_dialect, env_kw)  # after fonts: that helper rebuilds the env
        # Playwright drops None values and str()s the rest; Popen would raise TypeError instead.
        env = {k: str(v) for k, v in (env_kw.get("env") or os.environ).items() if v is not None}

        # Launched directly, without an automation framework or --enable-automation. stderr is piped
        # and drained into a bounded tail so an exit-90 launch-ticket rejection
        # can be named; the drain thread outlives the readiness loop so the pipe never fills up.
        # The same ticket also in ANT0_LAUNCH of the engine child (a copy of the env).
        full_args, env = apply_ticket_env(list(args) + list(cdp), env, pw_kwargs.pop(CALLER_ENV_KEY, None))
        proc = subprocess.Popen([exe] + full_args, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except BaseException:
        if own_udd and user_data_dir is not None:
            shutil.rmtree(user_data_dir, ignore_errors=True)
        elif user_data_dir is not None:
            remove_stale_persona_file(user_data_dir)
        raise
    finally:
        if callable(runtime_release):
            try:
                runtime_release()
            except Exception:
                pass
    stderr_tail = _StderrTail(proc.stderr)

    def _abort():
        # Kill the child and wait for it BEFORE removing the profile dir it may still be writing to.
        try:
            proc.kill()
            proc.wait(timeout=5)
        except Exception:
            pass
        remove_stale_persona_file(user_data_dir)
        if own_udd:
            shutil.rmtree(user_data_dir, ignore_errors=True)

    # Covers an interpreter exit during the readiness wait. Synchronous only (atexit cannot await),
    # and it removes only the temp dir serve() created, never a caller-supplied user_data_dir.
    launch = _track(proc, user_data_dir if own_udd else None)
    deadline = time.time() + ready_timeout
    ready = False
    try:
        while time.time() < deadline:
            if proc.poll() is not None or stderr_tail.inactive_reason is not None:
                break
            try:
                urllib.request.urlopen("http://%s:%d/json/version" % (host, port), timeout=1)
                ready = True
                break
            except Exception:
                time.sleep(0.25)
    except BaseException:  # e.g. KeyboardInterrupt while waiting: no Server exists to clean up
        _abort()
        _untrack(launch)
        raise
    if stderr_tail.inactive_reason is not None:
        # The engine runs on host values: stop it rather than hand back a browser with no persona.
        _abort()
        _untrack(launch)
        raise PersonaFileRejectedError(stderr_tail.inactive_reason)
    if not ready:
        _abort()
        _untrack(launch)
        tail = stderr_tail.text()
        tail = drop_partial_first_line(tail, len(tail.encode("utf-8", "replace")) >= stderr_tail._limit)
        secrets = launch_secret_values(full_args, [user_data_dir], env)
        reason = launch_ticket_rejection(tail)
        if reason or proc.poll() == LAUNCH_TICKET_EXIT_CODE:
            raise LaunchTicketRejectedError(reason or "missing", redact_launch_secrets(tail.strip(), secrets))
        persona = persona_file_rejection(tail, proc.poll())
        if persona:
            raise PersonaFileRejectedError(persona)
        raise SdkRuntimeError("sdk.engine_not_ready", 
            "ant0browser serve: CDP endpoint at http://%s:%d did not come up within %.0fs%s%s"
            % (host, port, ready_timeout,
               " (engine exited with code %s)" % proc.returncode if proc.poll() is not None else "",
               "\n" + redact_launch_secrets(tail.strip(), secrets) if tail.strip() else ""))

    remove_stale_persona_file(user_data_dir)  # the engine read it at startup; nothing stays in the profile
    srv = Server(proc, host, port, user_data_dir, own_udd)
    _untrack(launch)                    # the Server's own registry entry takes over
    if not quiet:
        sys.stderr.write(
            "[ant0-browser] CDP endpoint ready: %s\n"
            "            attach any client: connect_over_cdp(%r) / puppeteer.connect({browserURL})\n"
            % (srv.cdp_url, srv.cdp_url))
    return srv


def _cdp_args(port, host, origins, user_data_dir, headless, proxy_server, engine_args,
              proxy_bypass=(), no_sandbox=False):
    """The switches ``serve()`` appends after the engine args: CDP endpoint, profile dir, the
    first-run hygiene switches, headless, the proxy server, and finally ``about:blank`` when
    ``engine_args`` carries no URL positional. Pure, so the arg set is testable without a binary;
    mirrors the Node SDK's ``launchPlan()`` tail exactly."""
    from ._launchopts import FIRST_RUN_HYGIENE_ARGS, default_start_url_args

    # Playwright's launch() adds the first-run hygiene switches itself; a direct spawn must add
    # them, or the first tab is chrome://ungoogled-first-run (see FIRST_RUN_HYGIENE_ARGS).
    cdp = [
        "--remote-debugging-port=%d" % port,
        "--remote-debugging-address=%s" % host,
        "--remote-allow-origins=%s" % origins,
        "--user-data-dir=%s" % user_data_dir,
    ]
    cdp.extend(FIRST_RUN_HYGIENE_ARGS)
    if headless:
        cdp.append("--headless=new")
    # A Playwright proxy dict can't be applied without Playwright; forward the server as
    # --proxy-server for the direct launch (authed proxies: answer Fetch.authRequired over CDP,
    # or use launch()/launch_persistent_context() which handle proxy auth for you).
    if proxy_server:
        cdp.append("--proxy-server=%s" % proxy_server)
        # A caller's own --proxy-bypass-list wins, as it does under Playwright (args come last).
        if not any(str(a).startswith("--proxy-bypass-list") for a in engine_args):
            cdp.extend(proxy_bypass)
    if no_sandbox and "--no-sandbox" not in engine_args:
        cdp.append("--no-sandbox")
    # Chromium opens every positional as a URL; with none from the caller, open about:blank so the
    # first tab is neutral. Appended last so a caller's URL positionals (in engine_args) win.
    cdp.extend(default_start_url_args(engine_args))
    return cdp


def _parse_proxy(s):
    """Parse ``[scheme://][user:pass@]host:port`` into Playwright's proxy dict."""
    from urllib.parse import urlparse
    u = urlparse(s if "://" in s else "http://" + s)
    server = "%s://%s%s" % (u.scheme or "http", u.hostname or "", ":%d" % u.port if u.port else "")
    d = {"server": server}
    if u.username:
        d["username"] = u.username
    if u.password:
        d["password"] = u.password
    return d


def _cli_main(argv=None):
    """``ant0-browser-serve`` — start a standing CDP endpoint and block until Ctrl-C.
    Prints the CDP URL to stdout (scriptable); logs go to stderr."""
    import argparse

    ap = argparse.ArgumentParser(
        prog="ant0-browser-serve",
        description="Launch ant0browser with a raw CDP endpoint any Playwright / Puppeteer / "
                    "browser-use / Crawl4AI client attaches to over connect_over_cdp. The "
                    "browser is launched directly (no --enable-automation), navigator.webdriver=false, "
                    "Runtime.enable runs no page code, port bound to loopback with an origin allowlist.")
    ap.add_argument("--port", type=int, default=9222, help="CDP port (default 9222; use 0 for an ephemeral port)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default loopback — keep it local for safety)")
    ap.add_argument("--allow-origins", default=None,
                    help="--remote-allow-origins value (default: the loopback origins only; '*' for trusted local use)")
    ap.add_argument("--headed", action="store_true", help="show a visible window (default: headless)")
    ap.add_argument("--user-data-dir", default=None, help="persistent profile dir (default: a temp dir removed on exit)")
    ap.add_argument("--identity-mode", choices=["native", "captured", "synthetic"], default="native")
    ap.add_argument("--identity-source", default=None, help="captured persona-profile-v2 path")
    ap.add_argument("--identity-key", default=None, help="nonempty synthetic identity key")
    ap.add_argument("--template-directory", default=None, help="synthetic persona template directory")
    ap.add_argument("--identity-directory", default=None, help="synthetic identity persistence directory")
    ap.add_argument("--platform", default=None, choices=["windows", "linux", "macos", "android"])
    ap.add_argument("--brand", default=None, help="Chrome | Edge | Opera | Vivaldi")
    ap.add_argument("--proxy", default=None, help="proxy, e.g. http://user:pass@host:port")
    ap.add_argument("--timezone", default=None, help="IANA timezone, e.g. America/New_York")
    ap.add_argument("--accept-language", dest="accept_language", default=None, help="e.g. en-US,en")
    ap.add_argument("--executable", default=None, help="path to the locally built ant0browser chrome binary")
    a = ap.parse_args(argv)

    overrides = {}
    for k in ("platform", "brand", "timezone", "accept_language"):
        v = getattr(a, k)
        if v is not None:
            overrides[k] = v
    if a.identity_mode == "native":
        identity = {"mode": "native"}
    elif a.identity_mode == "captured":
        identity = {"mode": "captured", "source": a.identity_source}
    else:
        identity = {"mode": "synthetic", "key": a.identity_key}
        if a.template_directory is not None:
            identity["template_directory"] = a.template_directory
        if a.identity_directory is not None:
            identity["identity_directory"] = a.identity_directory
    launch_options = {"identity": identity}
    if overrides:
        launch_options["overrides"] = overrides
    if a.executable:
        launch_options["executable_path"] = a.executable
    if a.proxy:
        launch_options["proxy"] = _parse_proxy(a.proxy)

    srv = serve(port=(a.port or None), host=a.host, allow_origins=a.allow_origins,
                user_data_dir=a.user_data_dir, headless=not a.headed, **launch_options)
    print(srv.cdp_url, flush=True)  # stdout: just the URL, so callers can capture it
    sys.stderr.write("[ant0-browser] serving — press Ctrl-C to stop.\n")
    try:
        while srv.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        srv.close()
    return 0
