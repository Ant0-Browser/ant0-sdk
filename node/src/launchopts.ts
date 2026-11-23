// Launch-time option helpers that are NOT fingerprint switches: unpacked-extension loading and
// proxy resolution. Pure (input -> switches / cleaned proxy) so they're unit-testable and mirror
// the Python SDK exactly.

/** A Playwright proxy descriptor. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { SdkInputError } from "./errors.js";

export interface PwProxy {
  server?: string;
  username?: string;
  password?: string;
  bypass?: string;
}

/** Privacy Sandbox + intrusive web APIs a de-Googled build should not expose (a build that
 * claims de-Googled while still answering document.browsingTopics()/navigator.runAdAuction is a
 * self-contradictory, pivotable fingerprint). All are runtime base::Features, so disabling needs
 * no rebuild.
 *
 * WebUSB is deliberately NOT in this list. It is not a Privacy Sandbox feature - it is a device
 * API that ships alongside Web Serial, WebHID and Web Bluetooth under identical secure-context
 * gating. Disabling only WebUSB left navigator.usb absent while serial/hid/bluetooth stayed
 * present, a combination no real Chromium produces; measured against stock Chrome on the same
 * host, that split was the single flagged difference in the device-API family. Presence leaks
 * nothing on its own - the API is permission-gated and enumerates no device without a user
 * gesture - so exposing it costs no privacy and removes a hard coherence tell. */
export const PRIVACY_SANDBOX_FEATURES = [
  "BrowsingTopics", "BrowsingTopicsDocumentAPI", "Fledge", "InterestGroupStorage",
  "PrivateAggregationApi", "SharedStorageAPI", "FencedFrames",
] as const;

/** Chromium honors only the LAST --enable-features / --disable-features on the command line (they
 * do NOT concatenate), so multiple occurrences clobber each other. Collapse all of each into a
 * single flag (order-preserving, de-duped) so defaults from different layers + the user's own flags
 * coexist. */
export function mergeFeatureFlags(args: string[]): string[] {
  const enabled: string[] = [];
  const disabled: string[] = [];
  const rest: string[] = [];
  for (const a of args) {
    if (a.startsWith("--enable-features=")) enabled.push(...a.slice(18).split(",").filter(Boolean));
    else if (a.startsWith("--disable-features=")) disabled.push(...a.slice(19).split(",").filter(Boolean));
    else rest.push(a);
  }
  const dedupe = (xs: string[]) => [...new Set(xs)];
  if (enabled.length) rest.push(`--enable-features=${dedupe(enabled).join(",")}`);
  if (disabled.length) rest.push(`--disable-features=${dedupe(disabled).join(",")}`);
  return rest;
}

/** Chromium 157+ can keep localStorage/sessionStorage in SQLite (`Default/LocalStorage`) instead of
 * leveldb (`Default/Local Storage`). The features are off by default in 158 and our engine has no
 * field trials, but Chrome for Testing turns them on through its field-trial testing config. Ant0
 * sync only captures the leveldb store, and a migrated profile can't go back, so the SDK always pins
 * the leveldb backend. */
export const DOM_STORAGE_SQLITE_FEATURES = [
  "DomStorageSqlite", "DomStorageSqliteMigration", "DomStorageSqliteNewDatabases",
] as const;

/** Keep DOM storage on leveldb (always applied; merged by mergeFeatureFlags). */
export function domStorageBackendArgs(): string[] {
  return [`--disable-features=${DOM_STORAGE_SQLITE_FEATURES.join(",")}`];
}

/** Disable Privacy Sandbox + intrusive APIs (runtime, no rebuild). */
export function privacySandboxArgs(): string[] {
  return [`--disable-features=${PRIVACY_SANDBOX_FEATURES.join(",")}`];
}

/** Behind a proxy, real Chrome cannot use QUIC/HTTP3 (a SOCKS5/HTTP proxy carries only TCP), so it
 * falls back to TCP. Disable QUIC when a proxy is configured so no HTTP/3 UDP is attempted —
 * coherent with proxied Chrome, and a guarantee no UDP egresses around the proxy. No proxy -> leave
 * QUIC on (real Chrome uses it). */
export function quicArgs(proxy: PwProxy | undefined): string[] {
  return proxy && proxy.server ? ["--disable-quic"] : [];
}

/** Emit `--socks5-udp` for a `socks5://` proxy when the caller asks for it.
 *
 * WARNING: the engine does NOT implement this switch today. Neither the engine's own code nor the
 * Chromium tree it builds on contains a `--socks5-udp` handler (two independent source reads), so
 * Chromium ignores it: no UDP is relayed through the proxy, and the deny policy
 * (`disable_non_proxied_udp`, see {@link webrtcDefaultDenyArgs}) still blocks peer-to-peer UDP.
 * The option is kept so existing callers do not break and so engine support can land later; do not
 * rely on it to make WebRTC UDP work through a proxy.
 *
 * Emitted only for a `socks5://` proxy (UDP ASSOCIATE, RFC 1928 section 7, is a SOCKS5 command; SOCKS4
 * and HTTP proxies have no equivalent). Off by default. */
export function socks5UdpArgs(socks5Udp: boolean | undefined, proxy: PwProxy | undefined): string[] {
  if (socks5Udp !== true) return [];
  const server = (proxy?.server ?? "").trim();
  return /^socks5/i.test(server) ? ["--socks5-udp"] : [];
}

/**
 * Switches to expose `navigator.bluetooth` for a persona that is NOT Linux, on a Linux host.
 *
 * Web Bluetooth is compiled into the engine but runtime-disabled on Linux only:
 * Chromium's runtime_enabled_features.json5 gives WebBluetooth status "stable" on Win/Mac/Android/
 * ChromeOS and lets Linux fall through to "default": "experimental", and content_features.cc
 * declares kWebBluetooth FEATURE_DISABLED_BY_DEFAULT. So a Linux host serving a Windows or macOS
 * persona reports navigator.usb, navigator.serial and navigator.hid but NOT navigator.bluetooth -
 * a combination no real Windows or macOS Chrome produces, and an OS-origin tell that survives every
 * string spoof. One flag restores it on the shipped binary; no rebuild is involved.
 *
 * The flag depends on the persona, not on the host alone. Real Linux Chrome has NO
 * navigator.bluetooth, so a Linux persona (and a launch with no persona, which presents the real
 * host) must not get it: adding it there would itself be the tell. `personaPlatform` is the
 * effective persona platform (`windows` | `macos` | `linux`); `null` or empty means no persona, so
 * nothing is emitted; omitting the argument keeps the old public behaviour (flag on a Linux host). `hostPlatform` is injectable for tests.
 *
 * Verified against Chromium 150's bluetooth.idl: getDevices() is gated on WebBluetoothGetDevices
 * and requestLEScan()/onadvertisementreceived on WebBluetoothScanning, both "experimental", so
 * real stable Chrome exposes exactly {constructor, getAvailability, requestDevice} - which is what
 * this flag produces. getAvailability() resolves false and requestDevice() rejects NotFoundError
 * on a machine with no adapter, matching a real desktop without Bluetooth hardware.
 */
export function webBluetoothArgs(
  personaPlatform?: string | null,
  hostPlatform: string = process.platform,
): string[] {
  if (hostPlatform !== "linux") return []; // Win/Mac ship it stable; the flag would be a no-op
  // Called with no argument (the public pre-persona signature) the old contract holds: a Linux
  // host gets the flag. Every SDK launch path passes a string, or null for "no persona".
  if (personaPlatform === undefined) return ["--enable-features=WebBluetooth"];
  const persona = typeof personaPlatform === "string" ? personaPlatform.trim().toLowerCase() : "";
  if (!persona || persona === "linux") return []; // real Linux Chrome has no navigator.bluetooth
  return ["--enable-features=WebBluetooth"];
}

/** Effective persona platform of a launch: the resolved `platform` option, else the captured
 * profile's `compatibility.os_family`. Undefined when there is no persona (native identity). */
export function personaPlatformOf(platform: unknown, profile?: unknown): string | undefined {
  if (typeof platform === "string" && platform.trim()) return platform.trim().toLowerCase();
  const p = profile as { compatibility?: { os_family?: unknown }; schema_version?: unknown; identity?: { os?: { family?: unknown } } } | undefined;
  // A schema 4 persona names its OS in the identity block.
  const os = p?.schema_version === 4 ? p.identity?.os?.family : p?.compatibility?.os_family;
  return typeof os === "string" && os.trim() ? os.trim().toLowerCase() : undefined;
}

/** Playwright default launch args this SDK always removes (a caller's own `ignoreDefaultArgs` wins).
 *
 * - `--enable-automation` flips the AutomationControlled feature and webdriver-adjacent tells.
 * - `--disable-ipc-flooding-protection` turns off Chromium's IPC flooding protection, which real
 *   Chrome keeps on (`ipcFloodingProtection` in the self-check). With it off, a burst of
 *   renderer-to-browser IPC is not throttled as it is in a real browser. */
export const IGNORED_PLAYWRIGHT_DEFAULTS: readonly string[] = ["--enable-automation", "--disable-ipc-flooding-protection"];

/** Playwright testing switches `launch()` / `launchPersistentContext()` do not pass, because a page can
 * observe them: `--hide-scrollbars` (`innerWidth - clientWidth` is 0 instead of the scrollbar width) and
 * `--disable-popup-blocking` (`window.open()` without a user gesture returns a Window instead of null).
 * Removing them breaks no Playwright automation (measured). They go into
 * `ignoreDefaultArgs` unless the caller passes the switch itself in `args`: Playwright's
 * `ignoreDefaultArgs` also filters the caller's own `args`, so ignoring it then would drop the caller's
 * switch. `serve()` / `launchPlan()` never had them. */
export const DROPPED_PLAYWRIGHT_SWITCHES: readonly string[] = ["--hide-scrollbars", "--disable-popup-blocking"];

/** Playwright default disabled features the launch paths stop disabling, because a page can observe
 * them: `HttpsUpgrades` (http: navigations upgrade to https: when TLS answers) and
 * `BoundaryEventDispatchTracksNodeRemoval` (extra `mouseenter` events after the pointed-at node is
 * removed), and `MediaRouter` (a launch() page whose Chromium has it disabled is flagged by Fingerprint's bot
 * automation; serve()/launchPlan() never passed it). A caller's own `--disable-features`
 * is merged after the defaults and keeps them. */
export const DROPPED_PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = ["HttpsUpgrades", "BoundaryEventDispatchTracksNodeRemoval", "MediaRouter"];

/** Kept disabled on every launch path. playwright-core 1.61 does not disable it (1.65 does), and with it
 * on (and HttpsUpgrades off) `http://` fails `ERR_BLOCKED_BY_CLIENT` on a host without TLS. Off, http:
 * upgrades to https: when TLS works and falls back to http: when it does not, as in a normal Chrome. */
export const PLAYWRIGHT_KEPT_DISABLED_FEATURE = "HttpsFirstBalancedModeAutoEnable";

/** The one feature Playwright disables by default that real Chrome does not. Disabling it makes a
 * cross-site iframe's `localStorage` read back UNPARTITIONED (a site can track across top-level
 * sites inside one profile) or throw `SecurityError`, where real Chrome reads a partitioned `null`.
 * It is not in this SDK's own lists and never was (git history): it comes from Playwright's defaults. */
export const PLAYWRIGHT_UNWANTED_DISABLED_FEATURE = "ThirdPartyStoragePartitioning";

export interface PlaywrightFeatureDefaults {
  /** Playwright's whole default `--disable-features` list, as it emits it. */
  disabledFull: string[];
  /** The same list without {@link PLAYWRIGHT_UNWANTED_DISABLED_FEATURE}. */
  disabled: string[];
  /** Playwright's default `--enable-features` (for example `CDPScreenshotNewSurface`). */
  enabled: string[];
}

// The enabled list is read only from the place Playwright builds its --enable-features switch:
//  - current layout: the switch is `"--enable-features=" + NAME().join(",")` (or `NAME.join`), and NAME is
//    assigned exactly once, to `() => [ ... ]` (or `[ ... ]`) holding plain quoted names or
//    `process.env.X ? "" : "Name"` entries;
//  - older layout: a single `[process.env.X ? "" :] "--enable-features=A,B"` entry directly after the
//    `"--disable-features=" + disabledFeatures.join(",")` entry.
// Comments are removed first. An `--enable-features=...` string anywhere else in the bundle (an error
// message, say) is never read, and a bundle that has one this does not recognise gives undefined.
// Only comments that start after whitespace or punctuation (not the `//` of a URL or the `/*` of a glob
// inside a string), and block comments are capped, so a stray quote elsewhere in a large bundle cannot
// swallow code.
const JS_COMMENT_RE = /(?<![^\s,;(\[{])(?:\/\/[^\n]*|\/\*(?:(?!\*\/)[\s\S]){0,4000}\*\/)/g;
const ENABLED_EMIT_RE = /"--enable-features="\s*\+\s*([A-Za-z_$][\w$]*)\s*(\(\s*\))?\s*\.join\(\s*","\s*\)/;
const ENABLED_ITEM_SRC = '(?:process\\.env\\.([A-Za-z0-9_]+)\\s*\\?\\s*""\\s*:\\s*)?"([A-Za-z0-9_]+)"';
const ARRAY_END_RE = /^\s*(?:\.filter\(\s*Boolean\s*\)\s*)?(?:;|,|\n|$)/;
const DISABLED_EMIT_THEN_ENABLED_RE =
  /"--disable-features="\s*\+\s*disabledFeatures\.join\(\s*","\s*\)\s*,\s*(?:process\.env\.([A-Za-z0-9_]+)\s*\?\s*""\s*:\s*)?"--enable-features=([A-Za-z0-9_,]+)"/;

function stripJsComments(source: string): string {
  return source.replace(JS_COMMENT_RE, " ");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEnabledFeatures(source: string, env: Record<string, string | undefined>): string[] | undefined {
  const emit = ENABLED_EMIT_RE.exec(source);
  if (emit) {
    const name = escapeRe(emit[1]);
    if ((source.match(new RegExp(`(?<![\\w$.])${name}\\s*=(?![=>])`, "g")) ?? []).length !== 1) return undefined;
    const arrow = emit[2] ? "\\(\\s*\\)\\s*=>\\s*" : "";
    const arr = new RegExp(`(?<![\\w$.])${name}\\s*=\\s*${arrow}\\[([^\\]]*)\\]`).exec(source);
    if (!arr || !ARRAY_END_RE.test(source.slice(arr.index + arr[0].length))) return undefined;
    const body = arr[1];
    if (body.replace(new RegExp(ENABLED_ITEM_SRC, "g"), "").replace(/[\s,]/g, "") !== "") return undefined;
    return [...body.matchAll(new RegExp(ENABLED_ITEM_SRC, "g"))].filter((m) => !(m[1] && env[m[1]])).map((m) => m[2]);
  }
  const legacy = DISABLED_EMIT_THEN_ENABLED_RE.exec(source);
  if (legacy) {
    if (legacy[1] && env[legacy[1]]) return [];
    return legacy[2].split(",").filter(Boolean);
  }
  if (source.includes("--enable-features=") || /\benabledFeatures\b/.test(source)) return undefined;
  return [];
}

/** Read Playwright's default feature switches out of its source text. Undefined unless the
 * `disabledFeatures` array is plain quoted names (comments allowed) and contains
 * {@link PLAYWRIGHT_UNWANTED_DISABLED_FEATURE}, and the enabled list is found where Playwright builds
 * its switch; anything else (another layout, conditional entries) is not guessed at. `env` resolves the
 * `process.env.X ? "" : "Name"` entries (default `process.env`). */
export function parsePlaywrightFeatureDefaults(
  source: string,
  env: Record<string, string | undefined> = process.env,
): PlaywrightFeatureDefaults | undefined {
  source = stripJsComments(source);
  const m = /\bdisabledFeatures\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!m) return undefined;
  const body = m[1];
  const names = [...body.matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]);
  if (body.replace(/"[A-Za-z0-9_]+"/g, "").replace(/[\s,]/g, "") !== "") return undefined;
  if (!names.includes(PLAYWRIGHT_UNWANTED_DISABLED_FEATURE)) return undefined;
  const enabled = parseEnabledFeatures(source, env);
  if (enabled === undefined) return undefined;
  return {
    disabledFull: names,
    disabled: names.filter((n) => n !== PLAYWRIGHT_UNWANTED_DISABLED_FEATURE),
    enabled,
  };
}

/** Back-compat helper: the disabled list without the unwanted feature, or undefined. */
export function parsePlaywrightDisabledFeatures(source: string): string[] | undefined {
  return parsePlaywrightFeatureDefaults(source)?.disabled;
}

let resolvedDefaults: PlaywrightFeatureDefaults | undefined | null = null;

/** Playwright's default feature switches derived from the Playwright that is actually installed (its
 * source, `lib/coreBundle.js` or `lib/server/chromium/chromiumSwitches.js`), so a different resolved
 * version cannot be silently replaced by a stale copy. Undefined when it cannot be derived. */
export function installedPlaywrightFeatureDefaults(): PlaywrightFeatureDefaults | undefined {
  if (resolvedDefaults !== null) return resolvedDefaults;
  resolvedDefaults = undefined;
  try {
    const dir = dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
    for (const rel of ["lib/coreBundle.js", "lib/server/chromium/chromiumSwitches.js"]) {
      let text: string;
      try { text = readFileSync(join(dir, rel), "utf8"); } catch { continue; }
      const parsed = parsePlaywrightFeatureDefaults(text);
      if (parsed) { resolvedDefaults = parsed; break; }
    }
  } catch { /* unresolvable */ }
  return resolvedDefaults;
}

export function installedPlaywrightDisabledFeatures(): string[] | undefined {
  return installedPlaywrightFeatureDefaults()?.disabled;
}

let warnedNoDefaults = false;

/** True when Playwright will still add its own `--disable-features=<list>`: not when every default
 * is ignored, nor when the caller's `ignoreDefaultArgs` holds that exact default argument (Playwright
 * filters by exact string, so a bare `--disable-features` entry ignores nothing). */
function playwrightKeepsFeatureDefaults(ignoreDefaultArgs: unknown, d: PlaywrightFeatureDefaults): boolean {
  if (ignoreDefaultArgs === true) return false;
  if (Array.isArray(ignoreDefaultArgs) && ignoreDefaultArgs.includes(`--disable-features=${d.disabledFull.join(",")}`)) return false;
  return true;
}

function callerEnabledFeatures(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const x of parseSwitches(args)) {
    if (x.name === "enable-features" && x.value) out.push(...x.value.split(",").map((f) => f.trim()).filter(Boolean));
  }
  return out;
}

/** Playwright's `--disable-features` / `--enable-features` defaults, minus
 * ThirdPartyStoragePartitioning, for a Playwright launch only (a direct spawn has no Playwright
 * defaults). Put them in FRONT of the engine args and run {@link mergeFeatureFlags}: the SDK's own
 * and the caller's flags then merge with Playwright's lists instead of replacing them (Chromium
 * honours only the last of each). Empty when Playwright's defaults are ignored, or when they cannot
 * be derived from the installed Playwright (warned once; Playwright's own list then stays, and an
 * SDK or caller `--disable-features` replaces it, so the launch paths skip the DOM storage pin then). `defaults` is injectable for tests. */
export function playwrightFeatureArgs(
  args: readonly string[],
  ignoreDefaultArgs?: unknown,
  defaults: PlaywrightFeatureDefaults | string[] | null | undefined = installedPlaywrightFeatureDefaults(),
  quiet?: boolean,
): string[] {
  const d: PlaywrightFeatureDefaults | null | undefined = Array.isArray(defaults)
    ? { disabledFull: [...defaults], disabled: defaults, enabled: [] }
    : defaults;
  if (ignoreDefaultArgs === true) return [];
  if (!d || d.disabled.length === 0) {
    if (!warnedNoDefaults && !quiet && process.env.ANT0_BROWSER_NO_WARN === undefined) {
      warnedNoDefaults = true;
      process.stderr.write("[ant0-browser] [features] could not read the installed Playwright's default feature lists, so they are left " +
        "as Playwright sets them. A --disable-features switch passed by the SDK or the caller replaces Playwright's " +
        "whole disabled list (ThirdPartyStoragePartitioning and Playwright's other disabled features are then no " +
        "longer disabled), and a --enable-features switch (for example WebBluetooth) replaces Playwright's own enabled " +
        "features (CDPScreenshotNewSurface, SkipListAccountsWithoutGaiaCookies). With neither switch, Playwright's " +
        "lists stay in effect\n");
    }
    return [];
  }
  if (!playwrightKeepsFeatureDefaults(ignoreDefaultArgs, d)) return [];
  // Playwright's list minus the features the page can observe, plus HttpsFirstBalancedModeAutoEnable (see
  // the constants). Only here, i.e. only when Playwright's defaults were read: when they cannot be
  // (returned [] above) the feature lists are not touched at all, nothing added, nothing removed.
  // A feature the caller enables explicitly (--enable-features) is taken OUT of this disabled list, whether
  // Playwright's own list or our addition put it there, so it is never in both lists (disable would win).
  const managed = [...DROPPED_PLAYWRIGHT_DISABLED_FEATURES, PLAYWRIGHT_KEPT_DISABLED_FEATURE];
  let disabled = d.disabled.filter((n) => !DROPPED_PLAYWRIGHT_DISABLED_FEATURES.includes(n));
  if (!disabled.includes(PLAYWRIGHT_KEPT_DISABLED_FEATURE)) disabled.push(PLAYWRIGHT_KEPT_DISABLED_FEATURE);
  const callerEnabled = callerEnabledFeatures(args);
  disabled = disabled.filter((n) => !(managed.includes(n) && callerEnabled.includes(n)));
  const out = disabled.length ? [`--disable-features=${disabled.join(",")}`] : [];
  if (d.enabled.length) out.push(`--enable-features=${d.enabled.join(",")}`);
  return out;
}

/** The engine args with Playwright's feature defaults merged in (see {@link playwrightFeatureArgs}). */
export function withPlaywrightFeatureDefaults(
  args: string[],
  ignoreDefaultArgs?: unknown,
  quiet?: boolean,
  defaults: PlaywrightFeatureDefaults | string[] | null | undefined = installedPlaywrightFeatureDefaults(),
): string[] {
  const lists = playwrightFeatureArgs(args, ignoreDefaultArgs, defaults, quiet);
  // The leveldb DOM storage pin is skipped when Playwright's disabled list cannot be read (and is not
  // ignored wholesale): the SDK's --disable-features would then replace that whole list, and the pin
  // is a no-op on the current engine, so the launch keeps its args exactly as they were without it.
  // serve()/launchPlan() always pin (no Playwright list to lose) from assembleArgs.
  const found = Array.isArray(defaults) ? { disabled: defaults } : defaults;
  const unreadable = ignoreDefaultArgs !== true && !(found && found.disabled.length > 0);
  const pin = unreadable ? [] : domStorageBackendArgs();
  return mergeFeatureFlags([...lists, ...args, ...pin]);
}

/** `--proxy-bypass-list` for a Playwright proxy's `bypass` (comma separated), for the direct
 * `serve()` / `launchPlan()` spawn. Same rule translation Playwright applies (trim, leading `.` ->
 * `*.`, `;` joined). Playwright also forces `<-loopback>` through the proxy; a direct spawn keeps
 * Chromium's own loopback bypass, so that rule is deliberately not added. Empty without a proxy
 * server or a bypass. */
export function proxyBypassArgs(proxy: { server?: string; bypass?: string } | undefined): string[] {
  if (!proxy || typeof proxy !== "object" || !proxy.server || !proxy.bypass) return [];
  const rules = String(proxy.bypass).split(",").map((t) => t.trim()).filter(Boolean)
    .map((t) => (t.startsWith(".") ? "*" + t : t));
  return rules.length ? [`--proxy-bypass-list=${rules.join(";")}`] : [];
}

/** Playwright's chromium launcher adds `--enable-unsafe-swiftshader` to every launch (playwright-core
 * 1.61). On a Windows host with no GPU or a blocklisted one that forces WebGL onto SwiftShader, where a
 * real Windows Chrome falls back to D3D11 WARP: a visible difference. Dropped on a win32 host only. Linux is
 * left alone on purpose: a headless Linux server often has no GPU or GL driver at all and needs
 * SwiftShader for WebGL to work. */
export const WINDOWS_ONLY_IGNORED_PLAYWRIGHT_DEFAULTS: readonly string[] = ["--enable-unsafe-swiftshader"];

function windowsOnlyIgnoredDefaults(hostPlatform: string): readonly string[] {
  return hostPlatform === "win32" ? WINDOWS_ONLY_IGNORED_PLAYWRIGHT_DEFAULTS : [];
}

/** The SDK's ignored Playwright defaults plus the caller's own, so a caller's `ignoreDefaultArgs`
 * adds to them and can never bring `--enable-automation` or `--disable-ipc-flooding-protection` back.
 * `true` (ignore every default) is kept as is. `--hide-scrollbars` and `--disable-popup-blocking` are added
 * too (see {@link DROPPED_PLAYWRIGHT_SWITCHES}), except one the caller passes in `args` themselves. */
export function mergeIgnoreDefaultArgs(caller: unknown, args?: readonly string[], hostPlatform: string = process.platform): string[] | true {
  if (caller === true) return true;
  const own = Array.isArray(caller) ? caller.map(String) : [];
  const dropped = DROPPED_PLAYWRIGHT_SWITCHES.filter((sw) => !hasSwitch(args ?? [], sw.slice(2)));
  return [...new Set([...IGNORED_PLAYWRIGHT_DEFAULTS, ...dropped, ...windowsOnlyIgnoredDefaults(hostPlatform), ...own])];
}

/** First engine release that holds `--webrtc-ip` without re-enabling non-proxied UDP. */
export const WEBRTC_IP_MIN_ENGINE = "158.0.8127.18-ant0.3";

const ENGINE_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)\.(\d+)-ant0\.(\d+)$/;

function parseEngineVersion(v: unknown): number[] | undefined {
  if (typeof v !== "string") return undefined;
  const m = ENGINE_VERSION_RE.exec(v.trim());
  return m ? m.slice(1).map(Number) : undefined;
}

/** True only for a parseable engine release at or after {@link WEBRTC_IP_MIN_ENGINE}, compared
 * numerically field by field (the four-part Chromium version, then the `-ant0.N` build). Unknown,
 * missing or unparseable counts as old: the safe path is to omit the flag. */
export function engineSupportsWebrtcIp(engineVersion: unknown): boolean {
  const have = parseEngineVersion(engineVersion);
  if (!have) return false;
  const need = parseEngineVersion(WEBRTC_IP_MIN_ENGINE) as number[];
  for (let i = 0; i < need.length; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** True for a plain IPv4 or IPv6 address (no brackets, zone id, port or whitespace). */
export function isValidWebrtcIp(value: unknown): boolean {
  return typeof value === "string" && !/[\s%\[\]/]/.test(value) && isIP(value) !== 0;
}

const SAFE_POLICY = "disable_non_proxied_udp";

interface ParsedSwitch { name: string; value: string | undefined; arg: string }

/** The switches Chromium would parse out of `args`, in order. Chromium accepts `--name`, `-name` and
 * (Windows) `/name`, lowercases names on Windows, and stops at a bare `--`. Matching is deliberately
 * a superset (every prefix, any case) so no spelling slips through on any host. */
function parseSwitches(args: readonly string[]): ParsedSwitch[] {
  const out: ParsedSwitch[] = [];
  for (const arg of args) {
    if (arg === "--") break;
    const m = /^(?:--|-|\/)([^=\s\-/][^=]*)(?:=([\s\S]*))?$/.exec(arg);
    if (m) out.push({ name: m[1].toLowerCase(), value: m[2], arg });
  }
  return out;
}

function lastSwitchValue(args: readonly string[], name: string): string | undefined {
  const all = parseSwitches(args).filter((x) => x.name === name);
  return all.length ? all[all.length - 1].value : undefined;
}

/** The WebRTC IP handling policy that is actually in force from the switches: the last non-empty
 * `--force-webrtc-ip-handling-policy`, else the last non-empty `--webrtc-ip-handling-policy`
 * (the force variant wins in Chromium). An empty or bare switch sets nothing. */
export function effectiveWebrtcPolicy(args: readonly string[]): string | undefined {
  for (const name of ["force-webrtc-ip-handling-policy", "webrtc-ip-handling-policy"]) {
    const nonEmpty = parseSwitches(args).filter((x) => x.name === name && (x.value ?? "").trim() !== "");
    if (nonEmpty.length) return (nonEmpty[nonEmpty.length - 1].value as string).trim();
  }
  return undefined;
}

/** True only when the policy in force lets non-proxied UDP out (anything but
 * `disable_non_proxied_udp`). They chose to leave the protection, so a dropped `--webrtc-ip` is not
 * ours to enforce there: today's behaviour is kept. */
export function callerAllowsUdp(args: readonly string[]): boolean {
  const policy = effectiveWebrtcPolicy(args);
  return policy !== undefined && policy !== SAFE_POLICY;
}

/** True when the switches themselves configure a proxy (`--proxy-server=...`, any spelling) and no
 * `--no-proxy-server` cancels it. `direct://` is no proxy. */
export function hasRawProxyServer(args: readonly string[]): boolean {
  if (parseSwitches(args).some((x) => x.name === "no-proxy-server")) return false;
  const v = (lastSwitchValue(args, "proxy-server") ?? "").trim();
  return v !== "" && !/^direct:\/\//i.test(v);
}

function hasSwitch(args: readonly string[], name: string): boolean {
  return parseSwitches(args).some((x) => x.name === name);
}

/**
 * Drop `--webrtc-ip=...` from the final engine args when the engine is older than
 * {@link WEBRTC_IP_MIN_ENGINE}.
 *
 * Why: engines through 158.0.8127.18-ant0.2 turn non-proxied UDP back on whenever `--webrtc-ip`
 * is set, even with `--webrtc-ip-handling-policy=disable_non_proxied_udp`. A page that points ICE
 * at its own TURN server or peer then gets UDP from the host's real public address (measured: 133
 * packets to a test range with the flag, 0 without). ant0.3 fixes it in the engine.
 *
 * Applied to the final list, so it covers the option, a geo-derived value and a raw
 * `--webrtc-ip=` in caller args alike. A caller policy that allows UDP opts out (see
 * callerAllowsUdp). A warning is written when a value is dropped; it never contains the address.
 */
export function gateWebrtcIpArgs(
  args: string[],
  engineVersion: string | null | undefined,
  quiet?: boolean,
): string[] {
  const warn = (msg: string) => {
    if (!quiet && process.env.ANT0_BROWSER_NO_WARN === undefined) process.stderr.write(`[ant0-browser] [webrtc-ip] ${msg}\n`);
  };
  // A value that is not an IP address (empty and bare included, any spelling or case of the switch)
  // is dropped on every engine; the warning never repeats it.
  const ipSwitches = new Set(parseSwitches(args).filter((x) => x.name === "webrtc-ip").map((x) => x.arg));
  const valid = args.filter((a) => {
    if (!ipSwitches.has(a)) return true;
    const sw = parseSwitches([a])[0];
    return sw !== undefined && isValidWebrtcIp(sw.value ?? "");
  });
  if (valid.length !== args.length) warn("dropped webrtcIp: the value is not an IP address");
  args = valid;
  if (engineSupportsWebrtcIp(engineVersion)) return args;
  if (callerAllowsUdp(args)) return args;
  const remaining = new Set(parseSwitches(args).filter((x) => x.name === "webrtc-ip").map((x) => x.arg));
  const kept = args.filter((a) => !remaining.has(a));
  if (kept.length !== args.length && !quiet && process.env.ANT0_BROWSER_NO_WARN === undefined) {
    const known = parseEngineVersion(engineVersion) ? String(engineVersion) : "version unknown";
    process.stderr.write(
      `[ant0-browser] [webrtc-ip] dropped webrtcIp: this engine (${known}) would let real-IP UDP ` +
      `out with it set; needs ${WEBRTC_IP_MIN_ENGINE} or later\n`);
  }
  return kept;
}

/** Switch (engine 158.0.8127.18-ant0.3 and later) that stops WebRTC looking up page-chosen hostnames
 * (TURN/STUN servers, `.local` candidates) on the host's own resolver, which would otherwise happen
 * outside the proxy. */
export const WEBRTC_NO_LOCAL_DNS = "--webrtc-no-local-dns";

/**
 * {@link gateWebrtcIpArgs}, plus `--webrtc-no-local-dns` on every launch that has a proxy (the
 * daemon's credential relay included) when the engine is at {@link WEBRTC_IP_MIN_ENGINE} or later
 * (the same version check as `--webrtc-ip`; unknown counts as old). Not added without a proxy, or
 * when the caller's own WebRTC policy allows UDP, or when it is already in the args, or in UDP
 * relay mode (`--webrtc-udp-relay`; the engine ignores it there).
 */
export function gateWebrtcArgs(
  args: string[],
  engineVersion: string | null | undefined,
  quiet: boolean | undefined,
  hasProxy: boolean,
): string[] {
  const out = gateWebrtcIpArgs(args, engineVersion, quiet);
  if (!(hasProxy || hasRawProxyServer(out)) || !engineSupportsWebrtcIp(engineVersion) || callerAllowsUdp(out) || hasSwitch(out, "webrtc-no-local-dns") || hasSwitch(out, "webrtc-udp-relay")) return out;
  return [...out, WEBRTC_NO_LOCAL_DNS];
}

/** Default WebRTC to disable_non_proxied_udp, so no UDP can egress around the proxy.
 *
 * This used to be skipped whenever `webrtcIp` was set, on the theory that the engine's srflx
 * fabrication already covered WebRTC. It does not - the two defend different things:
 *
 *   - fabrication rewrites what the browser *reports*, which beats a page that reads the candidate;
 *   - this policy stops UDP *leaving the machine*, which beats a server that watches where packets
 *     arrive from.
 *
 * A page that sets `iceTransportPolicy: "relay"` forces the browser to talk to its own TURN server.
 * TURN prefers UDP and an HTTP/SOCKS proxy carries only TCP, so that UDP left on the host's own
 * path and the TURN server read the real public address straight off the packet - no candidate
 * involved, so fabricating one changed nothing.
 *
 * CAVEAT (measured): on engines older than 158.0.8127.18-ant0.3 this policy is NOT enough on its
 * own. Setting `--webrtc-ip` makes those engines re-enable non-proxied UDP, overriding the policy.
 * So the SDK omits `--webrtc-ip` for them (see gateWebrtcIpArgs) and the policy then holds.
 * ant0.3 and later keep the policy in force with `--webrtc-ip` set.
 *
 * This is a real trade-off, not a free win: denying non-proxied UDP means peer connections that
 * genuinely need UDP will not establish. Callers who need working WebRTC can set their own policy
 * to opt out; a policy that allows UDP also keeps `--webrtc-ip` on any engine. */
export function webrtcDefaultDenyArgs(args: string[], _webrtcIp?: unknown): string[] {
  if (args.some((a) => a.startsWith("--webrtc-ip-handling-policy") || a.startsWith("--force-webrtc-ip-handling-policy"))) {
    return [];
  }
  return ["--webrtc-ip-handling-policy=disable_non_proxied_udp"];
}

/** Switches to load unpacked extensions. Chromium needs BOTH --load-extension=<dirs> and
 * --disable-extensions-except=<dirs> (the latter keeps the listed extensions enabled while
 * everything else stays off). `paths` is a list of unpacked-extension directories. */
export function extensionArgs(paths?: string[]): string[] {
  if (!paths || paths.length === 0) return [];
  const joined = paths.join(",");
  return [`--load-extension=${joined}`, `--disable-extensions-except=${joined}`];
}

/** First-run/UX hygiene switches for a DIRECT launch (`serve()` / `launchPlan()`).
 *
 * Playwright adds these itself on `launch()`, so a Playwright-driven browser never shows the
 * first-run UI. A direct spawn gets none of that, and the engine then opens
 * `chrome://ungoogled-first-run` (empty body) in the first
 * tab whenever the caller passes no start URL, plus the default-browser prompt and the search
 * engine choice screen in headed mode. These are plain UI switches, not `base::Feature` toggles:
 * they change nothing a page can observe, so the identity layer (which owns
 * `--enable-features`/`--disable-features`) is not affected and the coherence checker does not
 * flag them. */
export const FIRST_RUN_HYGIENE_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-search-engine-choice-screen",
] as const;

/** True when `args` carries a positional (non-switch) argument, which Chromium opens as a URL.
 * Everything after a literal `--` is positional by Chromium's command-line rules. */
export function hasUrlPositional(args: readonly string[]): boolean {
  let afterSeparator = false;
  for (const a of args) {
    if (afterSeparator) return true;
    if (a === "--") { afterSeparator = true; continue; }
    if (!a.startsWith("-")) return true;
  }
  return false;
}

/** The neutral start page for a direct launch with no caller URL: `about:blank` as the final
 * positional, so the first tab is blank instead of the engine's first-run page. Empty when the
 * caller already supplied a URL positional (Chromium would open both otherwise). */
export function defaultStartUrlArgs(args: readonly string[]): string[] {
  return hasUrlPositional(args) ? [] : ["about:blank"];
}

/** Message thrown for a SOCKS proxy descriptor that carries `username`/`password`. Exported so the
 * tests and the Python SDK's mirror can assert on the same wording. */
export const SOCKS_CREDENTIALS_UNSUPPORTED =
  "SOCKS proxy with username/password is not supported: the engine does not authenticate to " +
  "SOCKS5 proxies (Chromium has no RFC 1929 username/password client), and Playwright rejects " +
  "credentials in a SOCKS proxy descriptor. Either use an http(s):// proxy with credentials " +
  "(Playwright handles those), a SOCKS5 proxy that allows this client's IP without credentials, " +
  "or run a local relay (as ant0d does) that authenticates upstream and point `proxy.server` at " +
  "it without credentials.";

/** Resolve a Playwright proxy descriptor into `{ args, proxy }`.
 *
 * Every proxy shape is left to Playwright unchanged, except a SOCKS proxy WITH credentials, which
 * throws: neither Playwright (it rejects credentials in a SOCKS descriptor) nor the engine (stock
 * Chromium has no RFC 1929 client, and the engine adds none) can authenticate to it, so
 * a launch would silently produce a proxy that refuses every connection. Callers needing a
 * credentialed SOCKS5 upstream run a local relay and hand the SDK its unauthenticated loopback
 * address instead. Userinfo inside the URL (`socks5://user:pass@host:port`) counts as credentials
 * too: Chromium would drop it silently. */
export function resolveProxy(proxy: PwProxy | undefined): { args: string[]; proxy: PwProxy | undefined } {
  if (!proxy || typeof proxy !== "object") return { args: [], proxy };
  const server = (proxy.server ?? "").trim();
  // Credentials as fields, or as userinfo inside the URL: Chromium ignores the latter silently.
  const hasCreds = !!(proxy.username || proxy.password) || /^[a-zA-Z0-9+.-]+:\/\/[^/@]*@/.test(server);
  if (server && /^socks/i.test(server) && hasCreds) {
    throw new SdkInputError("sdk.launch_option_unsupported", SOCKS_CREDENTIALS_UNSUPPORTED);
  }
  // The engine rejects socks5h:// (ERR_NO_SUPPORTED_PROXIES); its socks5:// already resolves hostnames
  // at the proxy, which is what socks5h asks for. Only the scheme changes.
  if (/^\s*socks5h:\/\//i.test(server)) {
    return { args: [], proxy: { ...proxy, server: proxy.server!.replace(/^(\s*)socks5h:\/\//i, "$1socks5://") } };
  }
  return { args: [], proxy };
}

/** Switches only the engine sets. `--ant0-persona-handle` carries the accepted persona to renderer
 * processes; a browser-process value would be ignored at best, so the SDK neither emits it
 * nor lets a caller's own args do so. */
export const RESERVED_ENGINE_SWITCHES = ["--ant0-persona-handle"] as const;

/** Throw `sdk.launch_option_unsupported` when `args` contains an engine-reserved switch, in any spelling
 * Chromium parses: `--name`, `-name` or `/name` (any case), with or without `=value`. */
export function assertNoReservedArgs(args: readonly unknown[]): void {
  const reserved = new Set(RESERVED_ENGINE_SWITCHES.map((n) => n.replace(/^--/, "")));
  for (const sw of parseSwitches(args.map(String))) {
    if (reserved.has(sw.name)) {
      throw new SdkInputError("sdk.launch_option_unsupported",
        `--${sw.name} is set by the engine for its own processes and cannot be passed in args.`);
    }
  }
}
