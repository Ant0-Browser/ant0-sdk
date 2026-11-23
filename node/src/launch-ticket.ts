// Engine launch ticket.
//
// The engine refuses to start without `--ant0-launch=<ticket>`: a licence token
// signed by the Ant0 server, plus a 15-minute claim the local device signed, bound to the engine's
// release version. The SDK never mints tickets (it has no device key); it either passes the one the
// caller hands in (`launchTicket`) or asks the local daemon for one
// (`GET /v1/licence/ticket?engine=<version>`) when a daemon is reachable. Without either the launch
// proceeds and the engine exits with code 90 and `ant0: launch ticket invalid (<reason>)` on stderr,
// which the SDK surfaces as a {@link LaunchTicketRejectedError} (`code: "engine.launch_ticket_rejected"`).
//
// Daemon discovery follows the CLI (`@ant0/api-client` `discoverDaemon`): `ANT0_URL` (+ `ANT0_TOKEN`)
// when set; else the data folder (`ANT0_HOME`, the platform default, or a legacy `~/.ant0`) gives
// `ant0d.pid` (port/host) and `ant0d.token`; `ANT0D_HOST`/`ANT0D_PORT` are the fallbacks. No token
// means no daemon, and no request is made.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve as resolvePath, win32 } from "node:path";
import { SdkTypeError } from "./errors.js";
import type { ErrorClass } from "./errors.js";
import { PersonaFileRejectedError, personaFileRejection, playwrightExitCode } from "./persona-rejected.js";

/** The engine switch; the value is the five-segment ticket. */
export const LAUNCH_TICKET_SWITCH = "ant0-launch";
/** The environment variable the engine child also reads the ticket from (newer engines). */
export const LAUNCH_TICKET_ENV = "ANT0_LAUNCH";
/** Exit code of an engine that refused its ticket (or got none). */
export const LAUNCH_TICKET_EXIT_CODE = 90;
/** Error code carried by {@link LaunchTicketRejectedError}. */
export const LAUNCH_TICKET_REJECTED_CODE = "engine.launch_ticket_rejected";
/** Env override for the engine's release version when it cannot be inferred from the install. */
export const ENGINE_VERSION_ENV = "ANT0_BROWSER_ENGINE_VERSION";

const STDERR_LINE = /ant0: launch ticket invalid \(([a-z_]+)\)/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+\.\d+-ant0\.\d+$/;
/** A development build (`ant0_release_version` left empty) identifies as `<chromium>-ant0.dev`. */
const DEV_VERSION = /^\d+\.\d+\.\d+\.\d+-ant0\.dev$/;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 27100;
const DEFAULT_TIMEOUT_MS = 3000;

/** Launch options added by the ticket check. */
export interface LaunchTicketOption {
  /** Protected runtime selection for automatic discovery or native ticket fetching. */
  runtime?: import("./runtime-client.js").RuntimeOptions;
  /**
   * The `--ant0-launch=` value. Omitted: the SDK fetches one from the local daemon when it can find
   * one (see module comment) and otherwise launches without a ticket. `false`: never contact a
   * daemon (the caller passes the switch in `args` itself, or knows the engine is a test build).
   */
  launchTicket?: string | false;
  /**
   * Release version the ticket must name (`<chromium>-ant0.<n>`). Default: the install's
   * `.release.json`, a `<version>/browser/` path component, or `ANT0_BROWSER_ENGINE_VERSION`.
   */
  engineVersion?: string;
}

// Playwright's launch failure quotes the whole command line, including the ticket and the persona-file
// path; neither may reach a log through this SDK's own errors. The value runs to the next switch or the
// end of the line (a path can hold spaces). A value the exact step already replaced is left alone (it may
// sit inside quotes that must survive).
const SECRET_SWITCH = /--(ant0-launch|fingerprint-profile-file)(?:=|[ \t]+)(?![ \t]*(?:\\*["'])?<redacted>)[^\r\n]*?(?=[ \t]--[A-Za-z]|[\r\n]|$)/g;

/** Switches whose values are launch secrets (the ticket, the persona file, the profile directory). */
const SECRET_ARG_SWITCHES = ["ant0-launch", "fingerprint-profile-file", "user-data-dir"];
/**
 * A value that is not a path is replaced on its own (outside `--switch=`) only from this length on: a short
 * bare word (`chrome`, `exit`, `data`) would mangle Playwright's own text. A path (it holds a separator) is
 * replaced on its own from 4 characters. Right after a secret switch any length is replaced.
 */
const MIN_STANDALONE_SECRET = 16;
const MIN_STANDALONE_PATH = 4;
/** A `--ant0-launch` value is matched anywhere only from this length; a shorter one is boundary-only. Only a malformed value a user typed is that short: a minted ticket carries a 64-byte signature (about 86 characters). */
const MIN_EXACT_TICKET = 16;

// Where an exact value may end: whitespace, a quote (also a backslash-escaped one), a comma or closing
// bracket, or sentence punctuation before one of those or the end. Never inside a longer path or word.
const VALUE_END = String.raw`(?=[\s"',\]})]|\\+["']|[.;:]*(?:[\s"']|$))`;
// Where a bare value may start: the start, whitespace, a quote, an opening bracket, a comma or `=`.
const VALUE_START = String.raw`(?<![^\s"'\[(,=])`;
const SWITCH_PREFIX = String.raw`(--(?:${SECRET_ARG_SWITCHES.join("|")})(?:=|[ \t]+)(?:\\*["'])?)`;

/**
 * The launch secrets to redact, as {@link launchSecretValues} builds them. `exact`: the ticket and the persona-file
 * path, matched anywhere in a text. `boundary`: the profile directory (as passed and absolute), matched only at
 * argument boundaries. There is deliberately no array form: a plain array (or a copy of one) is rejected, so a
 * caller can never silently fall back to the weaker matching.
 */
export interface LaunchSecrets {
  readonly exact: readonly string[];
  readonly boundary: readonly string[];
}

// Only objects built by launchSecretValues() are accepted: a hand-built lookalike is rejected.
const PRODUCED = new WeakSet<object>();
const NO_SECRETS: LaunchSecrets = Object.freeze({ exact: Object.freeze([]) as readonly string[], boundary: Object.freeze([]) as readonly string[] });

/** Runtime guard (JS callers bypass the types): only a {@link LaunchSecrets} or nothing (regex layer only). */
function checkSecrets(secrets: unknown): LaunchSecrets {
  if (secrets === undefined) return NO_SECRETS;
  if (secrets === null || typeof secrets !== "object" || !PRODUCED.has(secrets)) {
    throw new TypeError("secrets must be the LaunchSecrets from launchSecretValues(), not an array or a hand-built object");
  }
  return secrets as LaunchSecrets;
}

/** Options of {@link redactLaunchSecrets}. */
export interface RedactOptions {
  /** Match the exact values ignoring case (Windows paths). Default: on Windows. */
  caseInsensitive?: boolean;
}

/** An absolute, normalised path (Playwright logs the profile directory in that form). */
function absolutePath(p: string): string {
  try { return resolvePath(p); } catch { return p; }
}

/**
 * The values of the secret switches among the argv the SDK passed (`--name=value` and `--name value`), plus
 * `extra` (such as a `userDataDir` handed over as a positional). A profile directory is listed as passed
 * and as an absolute, normalised path. Feed the result to {@link redactLaunchSecrets} so a value is removed
 * exactly, whatever it contains.
 */
export function launchSecretValues(
  args: readonly unknown[], extra: readonly (string | undefined)[] = [], env?: Record<string, string | undefined>,
): LaunchSecrets {
  const boundary = new Set<string>();
  const exact = new Set<string>();
  const add = (name: string, value: string): void => {
    if (name === "fingerprint-profile-file" || (name === "ant0-launch" && value.length >= MIN_EXACT_TICKET)) { exact.add(value); return; }
    boundary.add(value);
    if (name === "user-data-dir" && value) boundary.add(absolutePath(value));
  };
  const list = args.map((a) => String(a));
  for (let i = 0; i < list.length; i++) {
    for (const name of SECRET_ARG_SWITCHES) {
      const flag = `--${name}`;
      if (list[i].startsWith(`${flag}=`)) add(name, list[i].slice(flag.length + 1));
      else if (list[i] === flag && i + 1 < list.length) add(name, list[i + 1]);
    }
  }
  for (const e of extra) if (e) add("user-data-dir", e);
  // The same ticket also travels in ANT0_LAUNCH of the engine's environment: an exact secret like the argv one.
  const fromEnv = env?.[LAUNCH_TICKET_ENV];
  if (typeof fromEnv === "string" && fromEnv) add(LAUNCH_TICKET_SWITCH, fromEnv);
  const result: LaunchSecrets = Object.freeze({ exact: Object.freeze([...exact]), boundary: Object.freeze([...boundary]) });
  PRODUCED.add(result);
  return result;
}

/** Each secret raw and JSON-escaped (backslashes doubled), without duplicates, longest first. */
function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const v of secrets) {
    if (typeof v !== "string" || v.length === 0) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const standaloneSecret = (v: string): boolean => /[\\/]/.test(v) ? v.length >= MIN_STANDALONE_PATH : v.length >= MIN_STANDALONE_SECRET;

/**
 * `text` with the launch secrets replaced. First by exact match of the `secrets` (the actual argv values, see
 * {@link launchSecretValues}), only at an argument boundary: right after `--ant0-launch`, `--fingerprint-profile-file`
 * or `--user-data-dir` (`=`, a space, a quote), or as a whole token for a long value or a path, and ending at a
 * token boundary (so `data`, `exit` or `/tmp` do not mangle `--user-data-dir`, `exitCode` or `/tmp/eng/chrome`).
 * The full known value is matched, so a path holding ` --x` goes whole, and quotes around it are kept. Then by
 * the switch pattern, a second layer for values not passed in.
 */
export function redactLaunchSecrets(text: string, secrets?: LaunchSecrets, options: RedactOptions = {}): string {
  let out = String(text);
  const { exact, boundary } = checkSecrets(secrets);
  const forms = secretForms([...exact, ...boundary]);
  if (forms.length > 0) {
    const flags = (options.caseInsensitive ?? process.platform === "win32") ? "gi" : "g";
    // Ticket and persona-file path: everywhere, no boundary, whatever surrounds them (quotes stay).
    const loose = secretForms(exact.filter((v) => v.length >= MIN_STANDALONE_PATH)).map(escapeRegExp).join("|");
    if (loose) out = out.replace(new RegExp(loose, flags), "<redacted>");
    const all = forms.map(escapeRegExp).join("|");
    out = out.replace(new RegExp(`${SWITCH_PREFIX}(?:${all})${VALUE_END}`, flags), (_m, prefix: string) => `${prefix}<redacted>`);
    const bare = forms.filter(standaloneSecret).map(escapeRegExp).join("|");
    if (bare) out = out.replace(new RegExp(`${VALUE_START}(?:${bare})${VALUE_END}`, flags), "<redacted>");
  }
  return out.replace(SECRET_SWITCH, "--$1=<redacted>");
}

/**
 * `error` itself when nothing in it needs redacting, else a new Error of the same class carrying the redacted
 * `message` and `stack`, the original `name` and own string/number properties (such as `code`), and no `cause`.
 * The original object is not modified. Everything that can quote a command line goes through here.
 */
export function redactError(error: unknown, secrets?: LaunchSecrets): unknown {
  checkSecrets(secrets);
  if (!(error instanceof Error)) {
    if (typeof error !== "string") return error;
    const clean = redactLaunchSecrets(error, secrets);
    return clean === error ? error : clean;
  }
  const message = redactLaunchSecrets(error.message, secrets);
  const stack = error.stack === undefined ? undefined : redactLaunchSecrets(error.stack, secrets);
  const own = Object.getOwnPropertyNames(error).filter((k) => k !== "message" && k !== "stack" && k !== "cause");
  const props: Record<string, unknown> = {};
  // A child_process spawn error lists the whole argument vector (`spawnargs`): it is dropped.
  // `spawnargs` lists the whole argument vector and `env` the whole environment (the ticket is in both): both are dropped.
  let changed = "spawnargs" in error || "env" in error || message !== error.message || stack !== error.stack || (error as { cause?: unknown }).cause !== undefined;
  for (const k of own) {
    const v = (error as unknown as Record<string, unknown>)[k];
    if (typeof v === "string") { const c = redactLaunchSecrets(v, secrets); if (c !== v) changed = true; props[k] = c; }
    else if (typeof v === "number" || typeof v === "boolean") props[k] = v;
  }
  if (!changed) return error;
  const fresh = Object.create(Object.getPrototypeOf(error)) as Error;
  Object.defineProperty(fresh, "message", { value: message, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(fresh, "stack", { value: stack, writable: true, configurable: true, enumerable: false });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(fresh, k, { value: v, writable: true, configurable: true, enumerable: true });
  if (!own.includes("name") && error.name !== fresh.name) Object.defineProperty(fresh, "name", { value: error.name, writable: true, configurable: true, enumerable: false });
  return fresh;
}

/** A tail cut at a byte limit may start inside a switch and so hide its name from the redaction: drop the partial first line. */
export function dropPartialFirstLine(text: string, truncated: boolean): string {
  if (!truncated) return text;
  const i = text.indexOf("\n");
  return i < 0 ? "" : text.slice(i + 1);
}

/** The engine exited with code 90 because its launch ticket was missing or invalid. */
export class LaunchTicketRejectedError extends Error {
  readonly code = LAUNCH_TICKET_REJECTED_CODE;
  readonly errorClass: ErrorClass = "expected";
  constructor(
    /** The engine's reason: missing, malformed, unknown_kid, bad_signature, past_grace, bad_claim_signature, claim_mismatch, claim_expired, claim_stale (engine 949+), wrong_engine. */
    readonly reason: string,
    detail?: string,
  ) {
    super(
      `ant0-browser: the engine rejected its launch ticket (${reason}). ` +
        (reason === "missing"
          ? "Start it through ant0d, pass launchTicket, or run a daemon the SDK can reach (ANT0_URL / ANT0_HOME)."
          : "Ask the daemon for a fresh ticket (GET /v1/licence/ticket) for this exact engine version.") +
        (detail ? `\n${redactLaunchSecrets(detail)}` : ""),
    );
    this.name = "LaunchTicketRejectedError";
  }
}

/** The engine's reason if `text` (stderr, or an error message quoting it) contains the rejection line. */
export function launchTicketRejection(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const m = STDERR_LINE.exec(text);
  return m ? m[1] : undefined;
}

/**
 * Rethrow a launch failure as the engine's own refusal when Playwright's message quotes it: the launch
 * ticket (exit code 90, {@link LaunchTicketRejectedError}) or the persona file (exit code 91, the fatal line,
 * {@link PersonaFileRejectedError}); otherwise rethrow as is. Playwright's message carries the exit code and
 * the stderr lines; the process itself is not visible here. The new errors carry no `cause` and their detail
 * is redacted: Playwright's message quotes the command line, ticket and persona-file path included.
 */
export function rethrowIfTicketRejected(error: unknown, secrets?: LaunchSecrets): never {
  checkSecrets(secrets);
  const text = error instanceof Error ? error.message : String(error);
  const exitCode = playwrightExitCode(text);
  const reason = launchTicketRejection(text) ?? (exitCode === LAUNCH_TICKET_EXIT_CODE ? "missing" : undefined);
  if (reason) throw new LaunchTicketRejectedError(reason, redactLaunchSecrets(`Playwright: ${text.split("\n")[0]}`, secrets));
  const persona = personaFileRejection(text, exitCode);
  if (persona) throw new PersonaFileRejectedError(persona);
  // Any other launch failure: Playwright's message and stack quote the command line too.
  throw redactError(error, secrets);
}

/** Engine exit-90 reasons that mean "this ticket went stale before it was used": worth one fresh ticket. */
const RETRYABLE_TICKET_REASONS = new Set(["claim_expired", "claim_stale"]);

/** Called by a launch attempt once it knows whether the ticket it is about to use was fetched by the SDK itself. */
export type TicketNote = (fetchedBySdk: boolean) => void;

/** True when `ticketArgs` carry a ticket the SDK fetched from the daemon: not the caller's `launchTicket`, argv or `env` one. */
export function sdkFetchedTicket(launchTicket: unknown, ticketArgs: readonly string[]): boolean {
  return typeof launchTicket !== "string" && launchTicket !== false && ticketArgs.length > 0;
}

/**
 * Run a launch attempt; if the engine rejects the ticket as `claim_expired` or `claim_stale` and the SDK itself
 * fetched that ticket, run it ONE more time (it fetches a fresh ticket right before the respawn). A caller's own
 * ticket (the `launchTicket` option, an argv ticket, an explicit `env` one) and every other reason surface as is,
 * and so does the second failure: there is never a third attempt.
 */
export async function withTicketRetry<T>(attempt: (note: TicketNote) => Promise<T>): Promise<T> {
  let fetchedBySdk = false;
  try {
    return await attempt((value) => { fetchedBySdk = value; });
  } catch (error) {
    if (fetchedBySdk && error instanceof LaunchTicketRejectedError && RETRYABLE_TICKET_REASONS.has(error.reason)) {
      return await attempt(() => {});
    }
    throw error;
  }
}

/** True when the caller already put `--ant0-launch=` in the engine args. */
export function hasLaunchTicketArg(args: readonly string[]): boolean {
  return args.some((a) => a === `--${LAUNCH_TICKET_SWITCH}` || a.startsWith(`--${LAUNCH_TICKET_SWITCH}=`));
}

type EnvMap = Record<string, string | undefined>;
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * The value of the last `--ant0-launch=<v>` in `args`, if any. The space form (`--ant0-launch <v>`) is not
 * parsed: Chromium does not read it, so it is left to the engine like any other caller argument.
 */
export function launchTicketArgValue(args: readonly unknown[]): string | undefined {
  let found: string | undefined;
  for (const a of args) {
    const text = String(a);
    if (text.startsWith(`--${LAUNCH_TICKET_SWITCH}=`)) found = nonEmpty(text.slice(LAUNCH_TICKET_SWITCH.length + 3));
  }
  return found;
}

/** The environment key that names the ticket: exact everywhere, case-insensitive on Windows. */
const isTicketKey = (key: string, windows: boolean): boolean => (windows ? key.toUpperCase() === LAUNCH_TICKET_ENV : key === LAUNCH_TICKET_ENV);

/**
 * The ticket the caller put in the `env` option they passed. An `ANT0_LAUNCH` in the SDK's own environment
 * (`process.env`) is NOT the caller's ticket: it is inherited ambient state and is never read here.
 */
export function callerEnvTicket(callerEnv?: EnvMap, windows: boolean = process.platform === "win32"): string | undefined {
  let found: string | undefined;
  for (const [key, value] of Object.entries(callerEnv ?? {})) if (isTicketKey(key, windows)) found = nonEmpty(value) ?? found;
  return found;
}

/** `args` for the "did the caller already provide a ticket" decision: a ticket in the caller's `env` option counts like a caller's `--ant0-launch=`. */
export function argsForTicketDecision(args: readonly string[] | undefined, callerEnv?: EnvMap, windows: boolean = process.platform === "win32"): readonly string[] | undefined {
  const fromEnv = callerEnvTicket(callerEnv, windows);
  if (!fromEnv || hasLaunchTicketArg(args ?? [])) return args;
  return [...(args ?? []), `--${LAUNCH_TICKET_SWITCH}=${fromEnv}`];
}

/**
 * Put the launch ticket in both places the engine reads it, with the same value: `--ant0-launch=<t>` in the
 * args (all engines) and `ANT0_LAUNCH=<t>` in the ENGINE CHILD's environment (newer engines; the
 * engine reads the environment first).
 *
 * `env` is the child's environment as built so far (undefined: inherited from `process.env`); `callerEnv` is
 * the `env` option the caller passed, if any. The result's env is ALWAYS a fresh copy (`process.env` itself is
 * never written) and an `ANT0_LAUNCH` that was merely inherited never reaches the engine:
 * - the caller put a ticket in `callerEnv`: nothing is overwritten and nothing is refused. If the args hold
 *   one too, both stay as they are; otherwise the env value is mirrored into the args;
 * - otherwise the env value is the resolved argv ticket, or the key is deleted when there is none.
 * On Windows the key is matched case-insensitively, so the copy never holds two spellings of it.
 */
export function applyTicketEnv(
  args: readonly string[],
  env: EnvMap | undefined,
  callerEnv?: EnvMap,
  windows: boolean = process.platform === "win32",
): { args: string[]; env: EnvMap } {
  const inArgs = launchTicketArgValue(args);
  const inCaller = callerEnvTicket(callerEnv, windows);
  const child: EnvMap = {};
  for (const [key, value] of Object.entries(env ?? process.env)) if (!isTicketKey(key, windows)) child[key] = value;
  const outArgs = [...args];
  const ticket = inCaller ?? inArgs;
  if (inCaller && !inArgs) outArgs.push(`--${LAUNCH_TICKET_SWITCH}=${inCaller}`);
  if (ticket) child[LAUNCH_TICKET_ENV] = ticket;
  return { args: outArgs, env: child };
}

/**
 * The release version an installed engine identifies as: `.release.json` next to its `browser/`
 * directory (what the SDK's installer and ant0d write), else a `<version>` path component, else
 * `ANT0_BROWSER_ENGINE_VERSION`. Undefined for a bare binary (tests, hand-built trees).
 */
export function inferEngineVersion(executable: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let dir = dirname(executable);
  for (let depth = 0; depth < 6; depth++) {
    const file = join(dir, ".release.json");
    if (existsSync(file)) {
      try {
        const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
        if (typeof version === "string" && RELEASE_VERSION.test(version)) return version;
      } catch {
        /* fall through to the path heuristics */
      }
    }
    if (RELEASE_VERSION.test(basename(dir))) return basename(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromEnv = env[ENGINE_VERSION_ENV]?.trim();
  return fromEnv && RELEASE_VERSION.test(fromEnv) ? fromEnv : undefined;
}

/**
 * STRICT engine version for security gates (such as `--webrtc-ip`): only the release record the
 * installer wrote for THIS executable counts. The executable's own directory and each parent up to
 * and including the install's `browser/` directory are not searched for anything but that record,
 * which must sit in the install base directly above `browser/`. A path component, an environment
 * variable or a `.release.json` in some far ancestor is not evidence about this binary, so those give
 * undefined (treated as an old engine). {@link inferEngineVersion} stays as is for the ticket.
 * `allowDev` also returns a development build's `<chromium>-ant0.dev` label (advisory warnings
 * only, never a gate).
 */
export function installedEngineVersion(executable: string, allowDev = false): string | undefined {
  let dir: string;
  try { dir = dirname(realpathSync(executable)); } catch { return undefined; }
  for (let depth = 0; depth < 4; depth++) {
    if (basename(dir) === "browser") {
      const file = join(dirname(dir), ".release.json");
      try {
        const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
        return typeof version === "string" && (RELEASE_VERSION.test(version) || (allowDev && DEV_VERSION.test(version))) ? version : undefined;
      } catch { return undefined; }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface DaemonLocation {
  baseUrl: string;
  token: string;
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

function homeExists(dir: string): boolean {
  return existsSync(join(dir, "ant0.db")) || existsSync(join(dir, "profiles"));
}

function readToken(file: string): string | undefined {
  try {
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The data folder, as ant0d/CLI resolve it (explicit env, platform default, legacy `~/.ant0`). */
export function resolveDaemonHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string {
  const explicit = env.ANT0_HOME?.trim();
  if (explicit) return explicit;
  const p = platform === "win32" ? win32 : posix;
  let def: string;
  if (platform === "win32") {
    def = env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "Ant0") : win32.join(userHome, "AppData", "Local", "Ant0");
  } else if (platform === "darwin") {
    def = posix.join(userHome, "Library", "Application Support", "Ant0");
  } else {
    def = env.XDG_DATA_HOME ? posix.join(env.XDG_DATA_HOME, "ant0") : posix.join(userHome, ".local", "share", "ant0");
  }
  const legacy = p.join(userHome, ".ant0");
  return !homeExists(def) && homeExists(legacy) ? legacy : def;
}

/** Where a running daemon is, or undefined when there is no token to send (= not running). */
export function discoverDaemon(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): DaemonLocation | undefined {
  const home = resolveDaemonHome(env, platform, userHome);
  const token = env.ANT0_TOKEN?.trim() || readToken(join(home, "ant0d.token"));
  if (!token) return undefined;
  const url = env.ANT0_URL?.trim();
  if (url) return { baseUrl: url.replace(/\/+$/, ""), token };
  let host: string | undefined;
  let port: number | undefined;
  try {
    const pid = JSON.parse(readFileSync(join(home, "ant0d.pid"), "utf8")) as { port?: unknown; host?: unknown };
    if (typeof pid.port === "number" && Number.isInteger(pid.port) && pid.port > 0 && pid.port <= 65535) port = pid.port;
    if (typeof pid.host === "string" && pid.host.length > 0 && isLoopback(pid.host)) host = pid.host;
  } catch {
    /* no pid file: fall back to the environment */
  }
  const envPort = Number(env.ANT0D_PORT);
  port ??= Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : DEFAULT_PORT;
  host ??= env.ANT0D_HOST && isLoopback(env.ANT0D_HOST) ? env.ANT0D_HOST : DEFAULT_HOST;
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { baseUrl: `http://${h}:${port}`, token };
}

const DAEMON_CODE =
  /^(?:(?:licence|workspace|browser|ticket|runtime|auth|device)\.[a-z][a-z0-9_]{0,40}|http_[1-5][0-9]{2}|bad_response)$/;

/** Thrown by {@link fetchLaunchTicket} when the daemon answers but will not issue a ticket. */
export class LaunchTicketUnavailableError extends Error {
  readonly errorClass: ErrorClass;
  constructor(
    /** Daemon error code, e.g. `licence.required`, `workspace.suspended`, or `http_<status>`. */
    readonly code: string,
    message: string,
  ) {
    super(`ant0-browser: the daemon did not issue a launch ticket (${code}): ${message}`);
    this.name = "LaunchTicketUnavailableError";
    this.errorClass = /^(licence|workspace)\./.test(code) ? "expected" : "environment";
  }

  /** The daemon's code when it has a known shape, else a fixed code. Safe to report. */
  get reportCode(): string {
    return DAEMON_CODE.test(this.code) ? this.code : "sdk.launch_ticket_unavailable";
  }
}

export interface FetchLaunchTicketOptions {
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/** `GET /v1/licence/ticket?engine=<engine>` with the daemon token; resolves to the `launch` value. */
export async function fetchLaunchTicket(
  engine: string,
  daemon: DaemonLocation,
  opts: FetchLaunchTicketOptions = {},
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(`${daemon.baseUrl}/v1/licence/ticket?engine=${encodeURIComponent(engine)}`, {
      headers: { Authorization: `Bearer ${daemon.token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => undefined)) as
      | { launch?: unknown; error?: { code?: unknown; message?: unknown } }
      | undefined;
    if (!res.ok) {
      const code = typeof body?.error?.code === "string" ? body.error.code : `http_${res.status}`;
      const message = typeof body?.error?.message === "string" ? body.error.message : res.statusText;
      throw new LaunchTicketUnavailableError(code, message);
    }
    if (typeof body?.launch !== "string" || body.launch.split(".").length !== 5) {
      throw new LaunchTicketUnavailableError("bad_response", "response has no five-segment `launch`");
    }
    return body.launch;
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolveLaunchTicketOptions extends LaunchTicketOption {
  /** Resolved engine binary (for {@link inferEngineVersion}). */
  executable: string;
  /** Engine args assembled so far (a caller-supplied `--ant0-launch=` wins). */
  args: readonly string[];
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The `--ant0-launch=` arg to append: the caller's ticket, or one fetched from the local daemon for
 * the engine's release version. Empty when the caller disabled it, already passed the switch, no
 * version can be inferred, no daemon is reachable, or the daemon refused (a note goes to stderr
 * unless `quiet`; the engine's own exit-90 then names the outcome).
 */
export async function resolveLaunchTicketArgs(opts: ResolveLaunchTicketOptions): Promise<string[]> {
  if (opts.launchTicket === false || hasLaunchTicketArg(opts.args)) return [];
  if (typeof opts.launchTicket === "string") {
    if (opts.launchTicket.split(".").length !== 5) {
      throw new SdkTypeError("sdk.launch_ticket_invalid", "launchTicket must be the five-segment `lic.claim.csig` value the daemon issues");
    }
    return [`--${LAUNCH_TICKET_SWITCH}=${opts.launchTicket}`];
  }
  const env = opts.env ?? process.env;
  const note = (msg: string) => {
    if (!opts.quiet && env.ANT0_BROWSER_NO_WARN === undefined) process.stderr.write(`[ant0-browser] [launch-ticket] ${msg}\n`);
  };
  const engine = opts.engineVersion ?? inferEngineVersion(opts.executable, env);
  if (!engine) return []; // bare binary: nothing to bind a ticket to (tests, hand-built trees)
  const daemon = discoverDaemon(env);
  if (!daemon) {
    note(`no ant0d found (no token under ${resolveDaemonHome(env)}); launching ${engine} without a ticket`);
    return [];
  }
  try {
    const launch = await fetchLaunchTicket(engine, daemon, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
    return [`--${LAUNCH_TICKET_SWITCH}=${launch}`];
  } catch (error) {
    const why = error instanceof LaunchTicketUnavailableError ? error.code : (error as Error)?.name === "AbortError" ? "timeout" : String(error);
    note(`${daemon.baseUrl} issued no ticket for ${engine} (${why}); launching without one`);
    return [];
  }
}
