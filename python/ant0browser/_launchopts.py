"""Launch-time option helpers that are NOT fingerprint switches: unpacked-extension loading and
proxy resolution. Kept pure (input -> switches / cleaned options) so they're unit-testable and
mirror the Node SDK exactly."""

import ipaddress
import os
import re
import sys
import warnings
from ._errors import SdkValueError

_SOCKS5 = re.compile(r"^socks5", re.I)
_SOCKS = re.compile(r"^socks", re.IGNORECASE)
_USERINFO = re.compile(r"^[a-zA-Z0-9+.\-]+://[^/@]*@")

# Privacy Sandbox + intrusive web APIs a de-Googled build should not expose (a build that
# claims to be de-Googled while still answering document.browsingTopics()/navigator.runAdAuction
# is a self-contradictory, pivotable fingerprint). All are runtime base::Features, so disabling
# needs no rebuild. Verified present in the 149 source.
#
# WebUSB is deliberately NOT in this list. It is not a Privacy Sandbox feature - it is a device
# API that ships alongside Web Serial, WebHID and Web Bluetooth under identical secure-context
# gating. Disabling only WebUSB left navigator.usb absent while serial/hid/bluetooth stayed
# present, a combination no real Chromium produces; measured against stock Chrome on the same
# host, that split was the single flagged difference in the device-API family. Presence leaks
# nothing on its own - the API is permission-gated and enumerates no device without a user
# gesture - so exposing it costs no privacy and removes a hard coherence tell.
PRIVACY_SANDBOX_FEATURES = (
    "BrowsingTopics", "BrowsingTopicsDocumentAPI", "Fledge", "InterestGroupStorage",
    "PrivateAggregationApi", "SharedStorageAPI", "FencedFrames",
)


def merge_feature_flags(args):
    """Chromium honors only the LAST ``--enable-features`` / ``--disable-features`` on the command
    line (they do NOT concatenate), so multiple occurrences clobber each other. Collapse all of each
    into a single flag (order-preserving, de-duped) so defaults from different layers + the user's
    own flags coexist."""
    enabled, disabled, rest = [], [], []
    for a in args:
        if a.startswith("--enable-features="):
            enabled += [f for f in a.split("=", 1)[1].split(",") if f]
        elif a.startswith("--disable-features="):
            disabled += [f for f in a.split("=", 1)[1].split(",") if f]
        else:
            rest.append(a)

    def _dedupe(xs):
        seen, out = set(), []
        for x in xs:
            if x not in seen:
                seen.add(x)
                out.append(x)
        return out

    if enabled:
        rest.append("--enable-features=" + ",".join(_dedupe(enabled)))
    if disabled:
        rest.append("--disable-features=" + ",".join(_dedupe(disabled)))
    return rest


def privacy_sandbox_args():
    """Disable Privacy Sandbox + intrusive APIs (runtime, no rebuild)."""
    return ["--disable-features=" + ",".join(PRIVACY_SANDBOX_FEATURES)]


#: Chromium 157+ can keep localStorage/sessionStorage in SQLite instead of leveldb. Ant0 sync only
#: captures the leveldb store and a profile that switched backend would read null, so every launch
#: path pins the leveldb backend. Same list as the Node SDK.
DOM_STORAGE_SQLITE_FEATURES = ("DomStorageSqlite", "DomStorageSqliteMigration", "DomStorageSqliteNewDatabases")


def dom_storage_backend_args():
    """Keep DOM storage on leveldb (always applied; merged by ``merge_feature_flags``)."""
    return ["--disable-features=" + ",".join(DOM_STORAGE_SQLITE_FEATURES)]


def proxy_bypass_args(proxy):
    """``--proxy-bypass-list`` for a Playwright proxy dict's ``bypass`` (comma separated), for the
    direct ``serve()`` spawn. Same rule translation Playwright applies (trim, leading ``.`` ->
    ``*.``, ``;`` joined). Playwright also forces ``<-loopback>`` through the proxy; a direct spawn
    keeps Chromium's own loopback bypass, so that rule is deliberately not added. Empty without a
    proxy server or a bypass."""
    if not isinstance(proxy, dict) or not proxy.get("server") or not proxy.get("bypass"):
        return []
    rules = [t.strip() for t in str(proxy["bypass"]).split(",")]
    rules = ["*" + t if t.startswith(".") else t for t in rules if t]
    return ["--proxy-bypass-list=" + ";".join(rules)] if rules else []


def quic_args(proxy):
    """Behind a proxy, real Chrome cannot use QUIC/HTTP3 — a SOCKS5/HTTP proxy carries only TCP, so
    Chrome falls back to TCP for proxied requests. Disable QUIC when a proxy is configured so no
    HTTP/3 UDP is even attempted: coherent with proxied Chrome, and a belt-and-suspenders guarantee
    that no UDP egresses *around* the proxy. No proxy -> leave QUIC on (real Chrome
    uses it, so disabling it everywhere would itself be a tell)."""
    return ["--disable-quic"] if (isinstance(proxy, dict) and proxy.get("server")) else []


def socks5_udp_args(socks5_udp, proxy):
    """Emit ``--socks5-udp`` for a ``socks5://`` proxy when the caller asks for it.

    WARNING: the engine does NOT implement this switch today. Neither the engine's own code nor the
    Chromium tree it builds on contains a ``--socks5-udp`` handler (two independent source reads), so
    Chromium ignores it: no UDP is relayed through the proxy, and the deny policy
    (``disable_non_proxied_udp``, see ``webrtc_default_deny_args``) still blocks peer-to-peer UDP.
    The option is kept so existing callers do not break and so engine support can land later; do not
    rely on it to make WebRTC UDP work through a proxy.

    Emitted only for a ``socks5://`` proxy (UDP ASSOCIATE, RFC 1928 section 7, is a SOCKS5 command;
    SOCKS4 and HTTP proxies have no equivalent). Off by default."""
    if socks5_udp is not True:
        return []
    server = ((proxy or {}).get("server") or "").strip() if isinstance(proxy, dict) else ""
    return ["--socks5-udp"] if _SOCKS5.match(server) else []


_UNSET = object()


def web_bluetooth_args(persona_platform=_UNSET, host_platform=None):
    """Switches to expose ``navigator.bluetooth`` for a persona that is NOT Linux, on a Linux host.

    Web Bluetooth is compiled into the engine but runtime-disabled on Linux only:
    Chromium's runtime_enabled_features.json5 gives WebBluetooth status "stable" on Win/Mac/Android/
    ChromeOS and lets Linux fall through to "default": "experimental", and content_features.cc
    declares kWebBluetooth FEATURE_DISABLED_BY_DEFAULT. So a Linux host serving a Windows or macOS
    persona reports navigator.usb, navigator.serial and navigator.hid but NOT navigator.bluetooth -
    a combination no real Windows or macOS Chrome produces, and an OS-origin tell that survives
    every string spoof. One flag restores it on the shipped binary; no rebuild is involved.

    The flag depends on the persona, not on the host alone. Real Linux Chrome has NO
    navigator.bluetooth, so a Linux persona (and a launch with no persona, which presents the real
    host) must not get it. ``persona_platform`` is the effective persona platform (``windows`` |
    ``macos`` | ``linux``); None or empty means no persona, so nothing is emitted; omitting the
    argument keeps the old public behaviour (flag on a Linux host). Every SDK launch path passes a value.
    ``host_platform`` defaults to ``sys.platform`` and is injectable for tests.

    Verified against Chromium 150's bluetooth.idl: getDevices() is gated on WebBluetoothGetDevices
    and requestLEScan()/onadvertisementreceived on WebBluetoothScanning, both "experimental", so
    real stable Chrome exposes exactly {constructor, getAvailability, requestDevice} - which is what
    this flag produces.
    """
    host = sys.platform if host_platform is None else host_platform
    if not str(host).startswith("linux"):
        return []  # Win/Mac builds ship it stable; the flag would be a no-op
    if persona_platform is _UNSET:
        return ["--enable-features=WebBluetooth"]
    persona = persona_platform.strip().lower() if isinstance(persona_platform, str) else ""
    if not persona or persona == "linux":
        return []  # real Linux Chrome has no navigator.bluetooth
    return ["--enable-features=WebBluetooth"]


def persona_platform_of(platform, profile=None):
    """Effective persona platform of a launch: the resolved ``platform`` option, else the captured
    profile's ``compatibility.os_family``. None when there is no persona (native identity)."""
    if isinstance(platform, str) and platform.strip():
        return platform.strip().lower()
    if isinstance(profile, dict) and profile.get("schema_version") == 4:
        # A schema 4 persona names its OS in the identity block.
        os_family = ((profile.get("identity") or {}).get("os") or {}).get("family")
    else:
        os_family = ((profile or {}).get("compatibility") or {}).get("os_family") if isinstance(profile, dict) else None
    return os_family.strip().lower() if isinstance(os_family, str) and os_family.strip() else None


#: Playwright default launch args this SDK always removes (a caller's own ``ignore_default_args``
#: wins). ``--enable-automation`` flips AutomationControlled and webdriver-adjacent tells;
#: ``--disable-ipc-flooding-protection`` turns off IPC flooding protection, which real Chrome keeps on.
IGNORED_PLAYWRIGHT_DEFAULTS = ("--enable-automation", "--disable-ipc-flooding-protection")

#: Playwright testing switches ``launch()`` / ``launch_persistent_context()`` do not pass, because a page
#: can observe them: ``--hide-scrollbars`` (``innerWidth - clientWidth`` is 0 instead of the scrollbar
#: width) and ``--disable-popup-blocking`` (``window.open()`` without a user gesture returns a Window
#: instead of null). Removing them breaks no Playwright automation (measured).
#: They go into ``ignore_default_args`` unless the caller passes the switch itself in ``args``:
#: Playwright's ``ignoreDefaultArgs`` also filters the caller's own ``args``, so ignoring it then would
#: drop the caller's switch. ``serve()`` never had them.
DROPPED_PLAYWRIGHT_SWITCHES = ("--hide-scrollbars", "--disable-popup-blocking")

#: Playwright default disabled features the launch paths stop disabling, because a page can observe them:
#: ``HttpsUpgrades`` (http: navigations upgrade to https: when TLS answers) and
#: ``BoundaryEventDispatchTracksNodeRemoval`` (extra ``mouseenter`` events after the pointed-at node is
#: removed), and ``MediaRouter`` (a launch() with it disabled can be flagged as
#: chromium_automation; serve()/launch_plan() never passed it). A caller's own ``--disable-features`` is merged
#: after the defaults and keeps them.
DROPPED_PLAYWRIGHT_DISABLED_FEATURES = ("HttpsUpgrades", "BoundaryEventDispatchTracksNodeRemoval", "MediaRouter")

#: Kept disabled on every launch path. Playwright 1.65 disables it, playwright-core 1.61 does not, and with
#: it on (and HttpsUpgrades off) ``http://`` fails ``ERR_BLOCKED_BY_CLIENT`` on a host without TLS. Off, http:
#: upgrades to https: when TLS works and falls back to http: when it does not, as in a normal Chrome.
PLAYWRIGHT_KEPT_DISABLED_FEATURE = "HttpsFirstBalancedModeAutoEnable"

#: The one feature Playwright disables by default that real Chrome does not. Disabling it makes a
#: cross-site iframe's ``localStorage`` read back UNPARTITIONED (a site can track across top-level sites
#: inside one profile) or throw ``SecurityError``, where real Chrome reads a partitioned ``null``. It is
#: not in this SDK's own lists and never was (git history): it comes from Playwright's defaults.
PLAYWRIGHT_UNWANTED_DISABLED_FEATURE = "ThirdPartyStoragePartitioning"

_DISABLED_FEATURES_RE = re.compile(r"\bdisabledFeatures\s*=\s*\[([^\]]*)\]")
# The enabled list is read only from the place Playwright builds its --enable-features switch:
#  - current layout: the switch is ``"--enable-features=" + NAME().join(",")`` (or ``NAME.join``), and NAME
#    is assigned exactly once, to ``() => [ ... ]`` (or ``[ ... ]``) holding plain quoted names or
#    ``process.env.X ? "" : "Name"`` entries;
#  - older layout: a single ``[process.env.X ? "" :] "--enable-features=A,B"`` entry directly after the
#    ``"--disable-features=" + disabledFeatures.join(",")`` entry.
# Comments are removed first. A ``--enable-features=...`` string anywhere else in the bundle (an error
# message, say) is never read, and a bundle that has one this does not recognise gives ``None``.
# Only comments that start after whitespace or punctuation (not the ``//`` of a URL or the ``/*`` of a glob
# inside a string), and block comments are capped, so a stray quote elsewhere in a large bundle cannot
# swallow code.
_JS_COMMENT_RE = re.compile(r"(?<![^\s,;(\[{])(?://[^\n]*|/\*(?:(?!\*/)[\s\S]){0,4000}\*/)")
_ENABLED_EMIT_RE = re.compile(r'"--enable-features="\s*\+\s*([A-Za-z_$][\w$]*)\s*(\(\s*\))?\s*\.join\(\s*","\s*\)')
_ENABLED_ITEM_RE = re.compile(r'(?:process\.env\.([A-Za-z0-9_]+)\s*\?\s*""\s*:\s*)?"([A-Za-z0-9_]+)"')
_ARRAY_END_RE = re.compile(r"\s*(?:\.filter\(\s*Boolean\s*\)\s*)?(?:;|,|\n|$)")
_DISABLED_EMIT_THEN_ENABLED_RE = re.compile(
    r'"--disable-features="\s*\+\s*disabledFeatures\.join\(\s*","\s*\)\s*,\s*'
    r'(?:process\.env\.([A-Za-z0-9_]+)\s*\?\s*""\s*:\s*)?"--enable-features=([A-Za-z0-9_,]+)"')


def _strip_js_comments(source):
    return _JS_COMMENT_RE.sub(" ", source)


def _parse_enabled_features(source, environ):
    """Playwright's default ``--enable-features`` names, ``[]`` when the source has none, or ``None``
    when the layout is not recognised. ``source`` has its comments removed."""
    emit = _ENABLED_EMIT_RE.search(source)
    if emit:
        name = re.escape(emit.group(1))
        if len(re.findall(r"(?<![\w$.])" + name + r"\s*=(?![=>])", source)) != 1:
            return None
        arrow = r"\(\s*\)\s*=>\s*" if emit.group(2) else ""
        arr = re.search(r"(?<![\w$.])" + name + r"\s*=\s*" + arrow + r"\[([^\]]*)\]", source)
        if not arr or not _ARRAY_END_RE.match(source, arr.end()):
            return None
        body = arr.group(1)
        if re.sub(r"[\s,]", "", _ENABLED_ITEM_RE.sub("", body)) != "":
            return None
        return [m.group(2) for m in _ENABLED_ITEM_RE.finditer(body) if not (m.group(1) and environ.get(m.group(1)))]
    legacy = _DISABLED_EMIT_THEN_ENABLED_RE.search(source)
    if legacy:
        if legacy.group(1) and environ.get(legacy.group(1)):
            return []
        return [f for f in legacy.group(2).split(",") if f]
    if "--enable-features=" in source or re.search(r"\benabledFeatures\b", source):
        return None
    return []


def parse_playwright_feature_defaults(source, environ=None):
    """Read Playwright's default feature switches out of its source text. ``None`` unless the
    ``disabledFeatures`` array is plain quoted names (comments allowed) and contains the unwanted
    feature, and the enabled list is found where Playwright builds its switch; anything else is not
    guessed at. Otherwise a dict with ``disabled_full`` (as Playwright emits it), ``disabled``
    (without the unwanted feature) and ``enabled`` (its default ``--enable-features``). ``environ``
    resolves the ``process.env.X ? "" : "Name"`` entries (default ``os.environ``)."""
    source = _strip_js_comments(source)
    m = _DISABLED_FEATURES_RE.search(source)
    if not m:
        return None
    body = m.group(1)
    names = re.findall(r'"([A-Za-z0-9_]+)"', body)
    if re.sub(r"[\s,]", "", re.sub(r'"[A-Za-z0-9_]+"', "", body)) != "":
        return None
    if PLAYWRIGHT_UNWANTED_DISABLED_FEATURE not in names:
        return None
    enabled = _parse_enabled_features(source, os.environ if environ is None else environ)
    if enabled is None:
        return None
    return {
        "disabled_full": names,
        "disabled": [n for n in names if n != PLAYWRIGHT_UNWANTED_DISABLED_FEATURE],
        "enabled": enabled,
    }


def parse_playwright_disabled_features(source):
    """Back-compat helper: the disabled list without the unwanted feature, or None."""
    parsed = parse_playwright_feature_defaults(source)
    return parsed["disabled"] if parsed else None


_installed_defaults = ["unset"]
_warned_no_defaults = [False]


def installed_playwright_feature_defaults():
    """Playwright's default feature switches derived from the Playwright that is actually installed
    (its bundled driver source), so a different resolved version cannot be silently replaced by a
    stale copy. ``None`` when it cannot be derived."""
    if _installed_defaults[0] != "unset":
        return _installed_defaults[0]
    found = None
    try:
        import playwright
        from pathlib import Path
        root = Path(playwright.__file__).parent / "driver" / "package"
        for rel in ("lib/coreBundle.js", "lib/server/chromium/chromiumSwitches.js"):
            try:
                text = (root / rel).read_text(encoding="utf8")
            except OSError:
                continue
            found = parse_playwright_feature_defaults(text)
            if found:
                break
    except Exception:  # noqa: BLE001 - unresolvable: leave Playwright's lists alone
        found = None
    _installed_defaults[0] = found
    return found


def installed_playwright_disabled_features():
    found = installed_playwright_feature_defaults()
    return found["disabled"] if found else None


def _caller_enabled_features(args):
    out = []
    for name, value, _ in _parse_switches(args):
        if name == "enable-features" and value:
            out += [f.strip() for f in value.split(",") if f.strip()]
    return out


def playwright_feature_args(args, ignore_default_args=None, defaults="installed", quiet=False):
    """Playwright's ``--disable-features`` / ``--enable-features`` defaults minus
    ThirdPartyStoragePartitioning, for a Playwright launch only (a direct spawn has no Playwright
    defaults). Put them in FRONT of the engine args and run ``merge_feature_flags``: the SDK's own and
    the caller's flags then merge with Playwright's lists instead of replacing them (Chromium honours
    only the last of each). Empty when every Playwright default is ignored, or when they cannot be
    derived from the installed Playwright (warned once; Playwright's own list then stays, and an SDK
    ``--disable-features`` replaces it). ``defaults`` is injectable for tests."""
    if defaults == "installed":
        defaults = installed_playwright_feature_defaults()
    elif isinstance(defaults, (list, tuple)):
        defaults = {"disabled_full": list(defaults), "disabled": list(defaults), "enabled": []}
    if ignore_default_args is True:
        return []
    if not defaults or not defaults["disabled"]:
        if not _warned_no_defaults[0] and not quiet and os.environ.get("ANT0_BROWSER_NO_WARN") is None:
            _warned_no_defaults[0] = True
            sys.stderr.write(
                "[ant0-browser] [features] could not read the installed Playwright's default feature lists, so they are left "
                "as Playwright sets them. A --disable-features switch passed by the SDK or the caller replaces Playwright's "
                "whole disabled list (ThirdPartyStoragePartitioning and Playwright's other disabled features are then no "
                "longer disabled), and a --enable-features switch (for example WebBluetooth) replaces Playwright's own enabled "
                "features (CDPScreenshotNewSurface, SkipListAccountsWithoutGaiaCookies). With neither switch, Playwright's "
                "lists stay in effect\n")
        return []
    # Playwright filters its defaults by EXACT string, so only a copy of the whole default argument
    # ignores it; a bare ``--disable-features`` entry ignores nothing.
    if isinstance(ignore_default_args, (list, tuple)) and (
            "--disable-features=" + ",".join(defaults["disabled_full"])) in [str(a) for a in ignore_default_args]:
        return []
    # Playwright's list minus the features the page can observe, plus HttpsFirstBalancedModeAutoEnable
    # (see the constants). Only here, i.e. only when Playwright's defaults were read: when they cannot
    # be (returned [] above) the feature lists are not touched at all, nothing added, nothing removed.
    # A feature the caller enables explicitly (--enable-features) is taken OUT of this disabled list, whether
    # Playwright's own list or our addition put it there, so it is never in both lists (disable would win).
    managed = (*DROPPED_PLAYWRIGHT_DISABLED_FEATURES, PLAYWRIGHT_KEPT_DISABLED_FEATURE)
    disabled = [n for n in defaults["disabled"] if n not in DROPPED_PLAYWRIGHT_DISABLED_FEATURES]
    if PLAYWRIGHT_KEPT_DISABLED_FEATURE not in disabled:
        disabled.append(PLAYWRIGHT_KEPT_DISABLED_FEATURE)
    caller_enabled = _caller_enabled_features(args)
    disabled = [n for n in disabled if not (n in managed and n in caller_enabled)]
    out = ["--disable-features=" + ",".join(disabled)] if disabled else []
    if defaults["enabled"]:
        out.append("--enable-features=" + ",".join(defaults["enabled"]))
    return out


def with_playwright_feature_defaults(args, ignore_default_args=None, quiet=False):
    """The engine args with Playwright's feature defaults merged in (see ``playwright_feature_args``),
    and the leveldb DOM storage pin added to the same single ``--disable-features``.

    The pin is skipped when Playwright's disabled list cannot be read (and is not ignored wholesale):
    the SDK's switch would then replace that whole list, and the pin is a no-op on the current engine,
    so the launch keeps its args exactly as they were without it. ``serve()`` always pins (no
    Playwright list to lose) from ``_prepare``."""
    lists = playwright_feature_args(args, ignore_default_args, "installed", quiet)
    found = installed_playwright_feature_defaults()
    unreadable = ignore_default_args is not True and not (found and found["disabled"])
    pin = [] if unreadable else dom_storage_backend_args()
    return merge_feature_flags(lists + list(args) + pin)


#: Playwright's chromium launcher adds ``--enable-unsafe-swiftshader`` to every launch (playwright-core 1.61).
#: On a Windows host with no GPU or a blocklisted one that forces WebGL onto SwiftShader, where a real
#: Windows Chrome falls back to D3D11 WARP: a visible difference. Dropped on a win32 host only. Linux is left
#: alone on purpose: a headless Linux server often has no GPU or GL driver and needs SwiftShader for WebGL.
WINDOWS_ONLY_IGNORED_PLAYWRIGHT_DEFAULTS = ("--enable-unsafe-swiftshader",)


def merge_ignore_default_args(caller, args=None, host_platform=None):
    """The SDK's ignored Playwright defaults plus the caller's own, so a caller's
    ``ignore_default_args`` adds to them and can never bring ``--enable-automation`` or
    ``--disable-ipc-flooding-protection`` back. ``True`` (ignore every default) is kept as is.
    ``--hide-scrollbars`` and ``--disable-popup-blocking`` are added too (see
    ``DROPPED_PLAYWRIGHT_SWITCHES``), except one the caller passes in ``args`` themselves."""
    if caller is True:
        return True
    own = [str(a) for a in caller] if isinstance(caller, (list, tuple)) else []
    given = list(args or [])
    dropped = [s for s in DROPPED_PLAYWRIGHT_SWITCHES if not _has_switch(given, s[2:])]
    host = sys.platform if host_platform is None else host_platform
    win = WINDOWS_ONLY_IGNORED_PLAYWRIGHT_DEFAULTS if host == "win32" else ()
    return list(dict.fromkeys([*IGNORED_PLAYWRIGHT_DEFAULTS, *dropped, *win, *own]))


#: First engine release that holds ``--webrtc-ip`` without re-enabling non-proxied UDP.
WEBRTC_IP_MIN_ENGINE = "158.0.8127.18-ant0.3"

_ENGINE_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)\.(\d+)-ant0\.(\d+)$")


def _parse_engine_version(value):
    m = _ENGINE_VERSION.match(value.strip()) if isinstance(value, str) else None
    return tuple(int(x) for x in m.groups()) if m else None


def engine_supports_webrtc_ip(engine_version):
    """True only for a parseable engine release at or after ``WEBRTC_IP_MIN_ENGINE``, compared
    numerically field by field (four-part Chromium version, then the ``-ant0.N`` build). Unknown,
    missing or unparseable counts as old: the safe path is to omit the flag."""
    have = _parse_engine_version(engine_version)
    return have is not None and have >= _parse_engine_version(WEBRTC_IP_MIN_ENGINE)


def is_valid_webrtc_ip(value):
    """True for a plain IPv4 or IPv6 address (no brackets, zone id, port or whitespace)."""
    if not isinstance(value, str) or re.search(r"[\s%\[\]/]", value):
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


_SAFE_POLICY = "disable_non_proxied_udp"
_SWITCH_RE = re.compile(r"^(?:--|-|/)([^=\s\-/][^=]*)(?:=([\s\S]*))?$")


def _parse_switches(args):
    """The switches Chromium would parse out of ``args``, in order, as ``(name, value, arg)``. It
    accepts ``--name``, ``-name`` and (Windows) ``/name``, lowercases names on Windows and stops at a
    bare ``--``. Matching is deliberately a superset (every prefix, any case) so no spelling slips
    through on any host. ``value`` is None for a bare switch."""
    out = []
    for arg in args:
        if arg == "--":
            break
        m = _SWITCH_RE.match(arg)
        if m:
            out.append((m.group(1).lower(), m.group(2), arg))
    return out


def effective_webrtc_policy(args):
    """The WebRTC IP handling policy in force from the switches: the last non-empty
    ``--force-webrtc-ip-handling-policy``, else the last non-empty ``--webrtc-ip-handling-policy``
    (the force variant wins in Chromium). An empty or bare switch sets nothing."""
    switches = _parse_switches(args)
    for name in ("force-webrtc-ip-handling-policy", "webrtc-ip-handling-policy"):
        values = [(v or "").strip() for n, v, _ in switches if n == name and (v or "").strip()]
        if values:
            return values[-1]
    return None


def _caller_allows_udp(args):
    """True only when the policy in force lets non-proxied UDP out (anything but
    ``disable_non_proxied_udp``): they chose to leave the protection."""
    policy = effective_webrtc_policy(args)
    return policy is not None and policy != _SAFE_POLICY


def has_raw_proxy_server(args):
    """True when the switches themselves configure a proxy (``--proxy-server=...``, any spelling)
    and no ``--no-proxy-server`` cancels it. ``direct://`` is no proxy."""
    switches = _parse_switches(args)
    if any(n == "no-proxy-server" for n, _, _ in switches):
        return False
    values = [(v or "").strip() for n, v, _ in switches if n == "proxy-server"]
    last = values[-1] if values else ""
    return last != "" and not last.lower().startswith("direct://")


def _has_switch(args, name):
    return any(n == name for n, _, _ in _parse_switches(args))


def gate_webrtc_ip_args(args, engine_version, quiet=False):
    """Drop ``--webrtc-ip=...`` from the final engine args when the engine is older than
    ``WEBRTC_IP_MIN_ENGINE``.

    Engines through 158.0.8127.18-ant0.2 turn non-proxied UDP back on whenever ``--webrtc-ip`` is
    set, even with ``--webrtc-ip-handling-policy=disable_non_proxied_udp``: a page that points ICE
    at its own TURN server or peer then gets UDP from the host's real public address (measured: 133
    packets to a test range with the flag, 0 without). ant0.3 fixes it in the engine.

    Applied to the final list, so it covers the option, a geo-derived value and a raw
    ``--webrtc-ip=`` in caller args alike. A caller policy that allows UDP opts out. A warning is
    written when a value is dropped; it never contains the address."""
    args = list(args)
    warn = (lambda msg: sys.stderr.write("[ant0-browser] [webrtc-ip] %s\n" % msg)
            if not quiet and os.environ.get("ANT0_BROWSER_NO_WARN") is None else None)
    # A value that is not an IP address is dropped on every engine; the warning never repeats it.
    ip_args = {arg: value for name, value, arg in _parse_switches(args) if name == "webrtc-ip"}
    valid = [a for a in args if a not in ip_args or is_valid_webrtc_ip(ip_args[a] or "")]
    if len(valid) != len(args):
        warn("dropped webrtc_ip: the value is not an IP address")
    args = valid
    if engine_supports_webrtc_ip(engine_version) or _caller_allows_udp(args):
        return args
    remaining = {arg for name, _v, arg in _parse_switches(args) if name == "webrtc-ip"}
    kept = [a for a in args if a not in remaining]
    if len(kept) != len(args) and not quiet and os.environ.get("ANT0_BROWSER_NO_WARN") is None:
        known = engine_version if _parse_engine_version(engine_version) else "version unknown"
        sys.stderr.write(
            "[ant0-browser] [webrtc-ip] dropped webrtc_ip: this engine (%s) would let real-IP UDP out "
            "with it set; needs %s or later\n" % (known, WEBRTC_IP_MIN_ENGINE))
    return kept


#: Switch (engine 158.0.8127.18-ant0.3 and later) that stops WebRTC looking up page-chosen hostnames
#: (TURN/STUN servers, ``.local`` candidates) on the host's own resolver, outside the proxy.
WEBRTC_NO_LOCAL_DNS = "--webrtc-no-local-dns"


def gate_webrtc_args(args, engine_version, quiet=False, has_proxy=False):
    """``gate_webrtc_ip_args`` plus ``--webrtc-no-local-dns`` on every launch that has a proxy (the
    daemon's credential relay included) when the engine is at ``WEBRTC_IP_MIN_ENGINE`` or later (the
    same version check as ``--webrtc-ip``; unknown counts as old). Not added without a proxy, when the
    caller's own WebRTC policy allows UDP, or when it is already in the args."""
    out = gate_webrtc_ip_args(args, engine_version, quiet=quiet)
    if (not (has_proxy or has_raw_proxy_server(out)) or not engine_supports_webrtc_ip(engine_version)
            or _caller_allows_udp(out) or _has_switch(out, "webrtc-no-local-dns")):
        return out
    return out + [WEBRTC_NO_LOCAL_DNS]


def webrtc_default_deny_args(args, webrtc_ip=None):
    """Default WebRTC to disable_non_proxied_udp, so no UDP can egress around the proxy.

    This used to be skipped whenever ``webrtc_ip`` was set, on the theory that the engine's srflx
    fabrication already covered WebRTC. It does not -- the two defend different things:

      * fabrication rewrites what the browser *reports*, which beats a page reading the candidate;
      * this policy stops UDP *leaving the machine*, which beats a server watching where packets
        arrive from.

    A page that sets ``iceTransportPolicy: "relay"`` forces the browser to talk to its own TURN
    server. TURN prefers UDP and an HTTP/SOCKS proxy carries only TCP, so that UDP left on the
    host's own path and the TURN server read the real public address straight off the packet -- no
    candidate involved, so fabricating one changed nothing.

    CAVEAT (measured): on engines older than 158.0.8127.18-ant0.3 this policy is NOT enough on its
    own. Setting ``--webrtc-ip`` makes those engines re-enable non-proxied UDP, overriding the
    policy. So the SDK omits ``--webrtc-ip`` for them (see ``gate_webrtc_ip_args``) and the policy
    then holds. ant0.3 and later keep the policy in force with ``--webrtc-ip`` set.

    This is a real trade-off, not a free win: denying non-proxied UDP means peer connections that
    genuinely need UDP will not establish. Callers who need working WebRTC can set their own policy
    to opt out; a policy that allows UDP also keeps ``--webrtc-ip`` on any engine.
    ``webrtc_ip`` is accepted and ignored, for call-site compatibility.
    """
    if any(a.startswith("--webrtc-ip-handling-policy") or a.startswith("--force-webrtc-ip-handling-policy")
           for a in args):
        return []
    return ["--webrtc-ip-handling-policy=disable_non_proxied_udp"]


def extension_args(paths):
    """Switches to load unpacked extensions. Chromium needs BOTH --load-extension=<dirs> and
    --disable-extensions-except=<dirs> (the latter keeps the listed extensions enabled while
    everything else stays off). ``paths`` is a list of unpacked-extension directories."""
    if not paths:
        return []
    joined = ",".join(str(p) for p in paths)
    return ["--load-extension=" + joined, "--disable-extensions-except=" + joined]


#: First-run/UX hygiene switches for a DIRECT launch (``serve()``). Playwright adds these itself on
#: ``launch()``, so a Playwright-driven browser never shows the first-run UI. A direct spawn gets
#: none of that, and the engine then opens ``chrome://ungoogled-first-run``
#: (the engine's first-run page, empty body) in the first tab whenever the caller passes no
#: start URL, plus the default-browser prompt and the search engine choice screen in headed mode.
#: Plain UI switches, not ``base::Feature`` toggles: nothing a page can observe changes, so the
#: identity layer (which owns --enable-features/--disable-features) is untouched and the coherence
#: checker does not flag them. Mirrors the Node SDK's ``FIRST_RUN_HYGIENE_ARGS``.
FIRST_RUN_HYGIENE_ARGS = (
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
)


def has_url_positional(args):
    """True when ``args`` carries a positional (non-switch) argument, which Chromium opens as a
    URL. Everything after a literal ``--`` is positional by Chromium's command-line rules."""
    after_separator = False
    for a in args:
        a = str(a)
        if after_separator:
            return True
        if a == "--":
            after_separator = True
            continue
        if not a.startswith("-"):
            return True
    return False


def default_start_url_args(args):
    """``["about:blank"]`` when the caller supplied no URL positional, so a direct launch's first
    tab is neutral instead of the engine's first-run page; ``[]`` when a URL is already present
    (Chromium would open both otherwise)."""
    return [] if has_url_positional(args) else ["about:blank"]


#: Message raised for a SOCKS proxy descriptor that carries ``username``/``password``. Same wording
#: as the Node SDK's ``SOCKS_CREDENTIALS_UNSUPPORTED``.
SOCKS_CREDENTIALS_UNSUPPORTED = (
    "SOCKS proxy with username/password is not supported: the engine does not authenticate to "
    "SOCKS5 proxies (Chromium has no RFC 1929 username/password client), and Playwright rejects "
    "credentials in a SOCKS proxy descriptor. Either use an http(s):// proxy with credentials "
    "(Playwright handles those), a SOCKS5 proxy that allows this client's IP without credentials, "
    "or run a local relay (as ant0d does) that authenticates upstream and point ``proxy.server`` "
    "at it without credentials."
)


_SOCKS5H = re.compile(r"^(\s*)socks5h://", re.IGNORECASE)


def resolve_proxy(proxy):
    """Return ``(extra_args, proxy_for_playwright)`` for a Playwright proxy descriptor.

    Every proxy shape is left to Playwright unchanged, except a SOCKS proxy WITH credentials, which
    raises ``ValueError``: neither Playwright (it rejects credentials in a SOCKS descriptor) nor the
    engine (stock Chromium has no RFC 1929 client, and the engine adds none) can
    authenticate to it, so a launch would silently produce a proxy that refuses every connection.
    Callers needing a credentialed SOCKS5 upstream run a local relay and hand the SDK its
    unauthenticated loopback address instead. Userinfo inside the URL
    (``socks5://user:pass@host:port``) counts as credentials too: Chromium would drop it silently."""
    if not isinstance(proxy, dict):
        return [], proxy
    server = (proxy.get("server") or "").strip()
    # Credentials as fields, or as userinfo inside the URL: Chromium ignores the latter silently.
    has_creds = bool(proxy.get("username") or proxy.get("password")) or bool(
        _USERINFO.match(server)
    )
    if server and _SOCKS.match(server) and has_creds:
        raise SdkValueError("sdk.launch_option_unsupported", SOCKS_CREDENTIALS_UNSUPPORTED)
    # The engine rejects socks5h:// (ERR_NO_SUPPORTED_PROXIES); its socks5:// already resolves hostnames
    # at the proxy, which is what socks5h asks for. Only the scheme changes.
    if _SOCKS5H.match(proxy.get("server") or ""):
        proxy = dict(proxy, server=_SOCKS5H.sub(r"\1socks5://", proxy["server"], count=1))
    return [], proxy


#: Switches only the engine sets. ``--ant0-persona-handle`` carries the accepted persona to renderer
#: processes; the SDK neither emits it nor lets a caller's own args do so.
RESERVED_ENGINE_SWITCHES = ("--ant0-persona-handle",)


def assert_no_reserved_args(args):
    """Raise ``sdk.launch_option_unsupported`` when ``args`` contains an engine-reserved switch, in any
    spelling Chromium parses: ``--name``, ``-name`` or ``/name`` (any case), with or without ``=value``."""
    reserved = {n[2:] for n in RESERVED_ENGINE_SWITCHES}
    for name, _value, _arg in _parse_switches([str(a) for a in (args or ())]):
        if name in reserved:
            raise SdkValueError("sdk.launch_option_unsupported",
                                f"--{name} is set by the engine for its own processes and cannot be passed in args.")
