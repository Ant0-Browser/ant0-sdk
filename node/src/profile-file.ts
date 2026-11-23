/**
 * Transport for schema 4 personas: a private file next to the browser profile.
 *
 * A schema 4 persona is far larger than the command line allows and must not sit in `ps` output, so
 * it goes through `--fingerprint-profile-file=<absolute path>` and never inline. The file holds the
 * same text the inline `--fingerprint-profile` switch carries today (gzip, then base64, of the
 * persona's JSON; see `encodeProfile`). The engine reads it once, at startup.
 *
 * The SDK sends schema 4 only to an engine that says it can read it. `--ant0-sdk-info` reports
 * `persona.schemas`; an engine that reports `sdk_protocol` 1, prints nothing, or cannot be run is
 * taken to read `[2]` only. A schema 4 persona is then refused (`sdk.persona_requires_engine`);
 * it is never converted down.
 *
 * Permissions. POSIX: the file is created with mode 0600 (owner read/write) through an exclusive
 * temporary file in the same directory and `fchmod`ed (by handle) to 0600 again, then renamed over the target, so
 * a reader sees the old or the new file, never a partial one. Windows: the same temporary-file and
 * rename sequence, but the empty temporary file is restricted BEFORE any content is written: its
 * inherited ACL is removed and replaced with a single entry that grants the current user (by SID,
 * from `whoami /user`) full control (`icacls <file> /inheritance:r /grant:r *<SID>:F`). If that
 * fails the write fails: the persona is never left readable by others. Known window: the empty file is
 * created with the inherited ACL and restricted an instant later (Node cannot create it restricted); it holds
 * nothing until the restriction has succeeded, but in that instant a principal that the inherited ACL lets read
 * could open the empty file and keep its handle. The Python SDK has the same window. Closing it would need
 * the security descriptor set at creation, or a private parent directory; neither is done.
 *
 * Probing the engine (`--ant0-sdk-info`) is asynchronous and bounded: a 5 s limit enforced with
 * SIGKILL, a cap on the output, and the answer is taken when the process exits. The probe child gets
 * the private probe directory as its TMPDIR/TMP/TEMP, so whatever an engine without the switch
 * creates (a Chromium singleton socket, for one) is removed with it. A probe that ran to completion
 * is cached by executable path, size and mtime; a completed old-engine answer (no schema 4) is
 * cached for 10 minutes and a timeout for 30 s only, so an old engine does not cost 5 s per launch, a
 * slow first run is retried soon, and a replaced or fixed engine is picked up. A spawn error is never cached.
 * A binary without the Ant0 capability marker is never run: it has no persona support (a completed answer,
 * cached like an old engine). The probe runs with a dead proxy (`--proxy-server=127.0.0.1:9`), and a probe child
 * does not outlive the process (see `killLiveProbesSync` and `sweepStaleProbeDirs`).
 */



import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isAnt0Binary } from "./download.js";
import { SdkError } from "./errors.js";
import { encodeProfile, type FingerprintOptions } from "./fingerprint.js";
import { assertPersonaProfileV4, isPersonaV4 } from "./persona-profile-v4.js";
import { debugLog } from "./warnings.js";

export { PROFILE_FILE_SWITCH } from "./fingerprint.js";
/** Engine switch that prints the capability record. */
export const SDK_INFO_SWITCH = "--ant0-sdk-info";
/** File name inside the user data directory. */
export const PROFILE_FILE_NAME = "ant0-persona.profile";
/** The persona schema this module transports. */
export const PERSONA_SCHEMA_FILE = 4;

/** Limits of the `--ant0-sdk-info` probe. */
export const SDK_INFO_TIMEOUT_MS = 5000;
export const SDK_INFO_MAX_BYTES = 1 << 20;
/** After the process exits, how long to wait for its stdout to close before using what was read. */
export const SDK_INFO_DRAIN_MS = 200;

/** Arguments that keep a probe of an engine without `--ant0-sdk-info` away from the user's profile and the
 * network: a build that is not an Ant0 engine (Chrome for Testing, say) would otherwise start normally, reach
 * out to the vendor and write to the real profile and certificate store within the 5 s. */
export const PROBE_DEAD_PROXY = "--proxy-server=127.0.0.1:9";
export const SDK_INFO_ISOLATION_ARGS = (userDataDir: string): string[] => [
  `--user-data-dir=${userDataDir}`, "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-breakpad", "--disable-crash-reporter",
  // A dead proxy: whatever a foreign build still tries to reach has nowhere to go (port 9 is "discard").
  PROBE_DEAD_PROXY,
];

/** The probe child's environment: everything that points at a home or data directory is the probe dir, so a
 * stock browser writes nothing under the real user's home (~/.config, ~/.local/share/pki, %APPDATA%). */
export function sdkInfoProbeEnv(probeDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dirs = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"];
  return { ...base, ...Object.fromEntries(dirs.map((k) => [k, probeDir])) };
}

/** A fresh private probe directory with a short path: a long TMPDIR makes Chromium fail with "Socket path
 * too long" (a unix socket path holds about 100 characters, and the profile's singleton socket lives in it). */
export const PROBE_DIR_MAX_LENGTH = 60;
/** Distinctive enough that no unrelated directory carries it; `mkdtemp` adds 6 characters of `[A-Za-z0-9]`, and a
 * probe directory without a record is only recognised by exactly that shape. */
export const PROBE_DIR_PREFIX = "ant0sdk-probe-";
const PROBE_DIR_SHAPE = new RegExp(`^${PROBE_DIR_PREFIX}[A-Za-z0-9]{6}$`);
export function makeProbeDir(): string {
  const prefix = PROBE_DIR_PREFIX;
  const base = tmpdir();
  // 6 random characters follow the prefix, and the socket file name adds about 20 more.
  const fits = (b: string) => join(b, prefix).length + 6 <= PROBE_DIR_MAX_LENGTH;
  const root = fits(base) ? base : process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : base;
  return mkdtempSync(join(root, prefix));
}

/** How long to wait for `taskkill /T` on Windows before going on. */
export const TASKKILL_BOUND_MS = 3000;

/**
 * KNOWN LIMITATION (Windows, not verified on Windows): on the drain path the probe's leader has already
 * exited (a descendant still holds the stdout pipe), so `taskkill /T /F /PID <leader>` names a process that is
 * gone. `taskkill /T` walks the tree from a live process, so it may report "not found" and leave the orphaned
 * descendant running; the pid may even have been reused. The probe dir is still removed (a still-open file in
 * it can make that removal incomplete), and a later `sweepStaleProbeDirs` retries it. Needs a check on a
 * Windows machine before the behaviour is relied on. POSIX is not affected: the group id outlives the leader.
 */
/** Stop the probe and everything it started. POSIX: the child leads its own process group, so the whole
 * group gets SIGKILL (synchronous). Windows: `taskkill /T /F` takes the tree; the returned promise settles
 * when it has finished or after `boundMs`, whichever is first. Best effort, never rejects. */
export function killProbeTree(child: ReturnType<typeof spawn>, boundMs = TASKKILL_BOUND_MS): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    // The tree first (taskkill, awaited with a bound), then the leader: killing the leader first would
    // orphan the children taskkill walks the tree from.
    return new Promise<void>((done) => {
      let over = false;
      const end = () => {
        if (over) return;
        over = true;
        clearTimeout(bound);
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        done();
      };
      const bound = setTimeout(end, boundMs);
      try {
        const k = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        k.once("error", end);
        k.once("exit", end);
      } catch { end(); }
    });
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  return Promise.resolve();
}

// Probes that are running now (pid -> probe dir). A process exit or a terminate request kills them and
// removes their dirs, so a probe child never outlives the SDK process; a SIGKILL of the SDK cannot be
// caught, and `sweepStaleProbeDirs` handles what that leaves behind on the next run.
const liveProbes = new Map<number, string>();
const PROBE_INFO_FILE = ".ant0-probe.json";

function killLiveProbesSync(): void {
  for (const [pid, dir] of liveProbes) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: TASKKILL_BOUND_MS });
      } else process.kill(-pid, "SIGKILL");
    } catch { /* already gone */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  liveProbes.clear();
}

/** A probe dir older than this belongs to a process that is gone (a probe lasts 5 s). */
export const STALE_PROBE_DIR_MS = 60 * 1000;
let swept = false;

/** Whether `pid` still runs with exactly `--user-data-dir=<dir>` among its arguments (so a recycled pid is
 * never signalled). */
function pidRunsProbe(pid: number, dir: string): boolean {
  const wanted = `--user-data-dir=${dir}`;
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(wanted);
    if (process.platform === "win32") return false; // cannot be checked cheaply: the dir is removed, no kill
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    return ` ${out} `.includes(` ${wanted} `);
  } catch { return false; }
}

/** Remove probe directories (and kill the probe left in them) that an earlier SDK process abandoned when
 * it was killed. Only our own `ant0sdk-probe-*` directories, owned by this user, older than
 * `STALE_PROBE_DIR_MS`; one without a record (`.ant0-probe.json`) must also have exactly the shape `mkdtemp`
 * produces, so an unrelated directory that merely starts with the prefix is never touched. Directories of earlier
 * SDKs (`ant0-probe-*`) are NOT swept, record or not: they are left to the OS temp sweeper. Best effort,
 * never throws; returns the directories removed. `roots`, `now` and `uid` exist for tests. */
export function sweepStaleProbeDirs(
  roots: string[] = [...new Set([tmpdir(), ...(process.platform !== "win32" ? ["/tmp"] : [])])],
  now: number = Date.now(),
  uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): string[] {
  const removed: string[] = [];
  for (const root of roots) {
    let names: string[];
    try { names = readdirSync(root).filter((n) => n.startsWith(PROBE_DIR_PREFIX)); } catch { continue; }
    for (const name of names) {
      const dir = join(root, name);
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
        let startedAt = st.mtimeMs;
        let pid: number | undefined;
        let recorded = false;
        try {
          const info = JSON.parse(readFileSync(join(dir, PROBE_INFO_FILE), "utf8"));
          recorded = typeof info === "object" && info !== null;
          // never 0 or negative: `process.kill(-pid)` of those would signal a whole group
          if (recorded && Number.isInteger(info.pid) && info.pid > 0) pid = info.pid;
          if (recorded && Number.isFinite(info.startedAt)) startedAt = info.startedAt;
        } catch { /* no record: the directory age decides */ }
        if (!recorded && !PROBE_DIR_SHAPE.test(name)) continue; // not a directory this module made
        if (now - startedAt < STALE_PROBE_DIR_MS) continue;
        if (pid !== undefined && pidRunsProbe(pid, dir)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch { /* best effort */ }
    }
  }
  return removed;
}

export interface SdkInfoProbeResult {
  /** The process ran to completion by itself: false after a timeout, a spawn error or too much output. */
  completed: boolean;
  /** The probe was stopped for running too long or printing too much (not a spawn error). */
  timedOut?: boolean;
  /** The binary is not an Ant0 engine (no capability marker), so it was not run at all. */
  notAnt0?: boolean;
  /** What it printed; empty unless it completed with exit code 0. */
  stdout: string;
}
export type SdkInfoProbe = (executable: string) => Promise<SdkInfoProbeResult>;

/** Run `executable --ant0-sdk-info` without blocking the event loop. Never rejects. */
export function probeSdkInfo(
  executable: string,
  limits: { timeoutMs?: number; maxBytes?: number; drainMs?: number; requireAnt0?: boolean } = {},
): Promise<SdkInfoProbeResult> {
  const timeoutMs = limits.timeoutMs ?? SDK_INFO_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? SDK_INFO_MAX_BYTES;
  const drainMs = limits.drainMs ?? SDK_INFO_DRAIN_MS;
  // Every Ant0 engine answers --ant0-sdk-info and exits; only a foreign build (Chrome for Testing, say) would
  // start up. The capability marker every Ant0 binary carries tells them apart without running anything, so a
  // binary without it is never run: it has no persona support. A path that cannot be read goes on to the
  // spawn below, which fails the usual way.
  if (limits.requireAnt0 !== false && existsSync(executable)) {
    let ant0 = true;
    try { ant0 = isAnt0Binary(executable); } catch { /* unreadable: let the spawn decide */ }
    if (!ant0) return Promise.resolve({ completed: true, notAnt0: true, stdout: "" });
  }
  if (!swept) { swept = true; sweepStaleProbeDirs(); }
  return new Promise((resolvePromise) => {
    // An engine that does not know --ant0-sdk-info may start a normal browser; the isolating arguments
    // keep that off the user's profile (a private, throwaway profile dir; headless; no first-run UI).
    // An engine that knows the switch exits before it reads any of them.
    let probeDir: string;
    try { probeDir = makeProbeDir(); } catch {
      resolvePromise({ completed: false, stdout: "" });
      return;
    }
    const removeProbeDir = () => { try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ } };
    let child: ReturnType<typeof spawn>;
    try {
      // Everything the child creates in its temp directory lands in the probe dir and goes with it.
      child = spawn(executable, [...SDK_INFO_ISOLATION_ARGS(probeDir), SDK_INFO_SWITCH],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32",
          env: sdkInfoProbeEnv(probeDir) });
    } catch {
      removeProbeDir();
      resolvePromise({ completed: false, stdout: "" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let exitCode: number | null | undefined;
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    if (child.pid !== undefined) {
      liveProbes.set(child.pid, probeDir);
      try { writeFileSync(join(probeDir, PROBE_INFO_FILE), JSON.stringify({ pid: child.pid, startedAt: Date.now() })); } catch { /* best effort */ }
      ensureProcessHooks();
    }
    const kill = () => killProbeTree(child);
    const finish = (completed: boolean, timedOut = false, reapGroup = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      // A grandchild may still hold the pipe; stop reading it, and stop whatever the probe left running.
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      // Only when something may still be running (the drain timer fired because a descendant holds the
      // pipe): after a clean close the group is empty and its id may already belong to someone else.
      const killed = reapGroup ? kill() : Promise.resolve();
      const ok = completed && exitCode === 0;
      const result = { completed, ...(timedOut ? { timedOut } : {}), stdout: ok ? Buffer.concat(chunks).toString("utf8") : "" };
      // On Windows the tree must be gone (taskkill awaited, with a bound) before its directory is removed.
      void killed.then(() => {
        if (child.pid !== undefined) liveProbes.delete(child.pid);
        removeProbeDir();
        releaseProcessHooks();
        resolvePromise(result);
      });
    };
    const timer = setTimeout(() => finish(false, true, true), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { finish(false, true, true); return; }
      chunks.push(chunk);
    });
    child.once("error", () => finish(false));
    child.once("exit", (code) => {
      exitCode = code;
      drainTimer = setTimeout(() => finish(true, false, true), drainMs);
    });
    child.once("close", (code) => { exitCode = code; finish(true); });
  });
}

/** What `--ant0-sdk-info` says about persona support (the `persona` member of protocol 2). Every field
 * but `schemas` is absent when the engine does not say; unknown extra fields are ignored. */
export interface EnginePersonaInfo {
  schemas: number[];
  revision?: number;
  engineFamily?: string;
  engineMajor?: number;
  os?: string[];
  arch?: string[];
  brands?: string[];
  /** The capability ids the engine serves from a schema 4 persona; undefined when not advertised. */
  capabilities?: string[];
}

/** How long a completed old-engine answer is remembered. A schema 4 answer is kept for good (it is keyed
 * by size and mtime, so a replaced binary is probed again). */
export const OLD_ENGINE_CACHE_MS = 10 * 60 * 1000;
/** How long a timed-out probe is remembered. Short, because a just-installed engine can be slow on its
 * first run (cold disk, antivirus) and must not be treated as old for long. */
export const PROBE_TIMEOUT_CACHE_MS = 30 * 1000;
const infoCache = new Map<string, { info: EnginePersonaInfo; expiresAt: number }>();
const copyInfo = (i: EnginePersonaInfo): EnginePersonaInfo => JSON.parse(JSON.stringify(i));

/** What the engine at `executable` says about persona support. Never throws: unknown means schemas
 * `[2]` and nothing else. The answer is cached per executable path, size and modification time: an
 * engine that serves schema 4 for good, a completed old-engine answer for `OLD_ENGINE_CACHE_MS`, a
 * timeout for `PROBE_TIMEOUT_CACHE_MS`. A spawn error is not cached and is retried on the next call. `now` exists for tests. */
export async function enginePersonaInfo(
  executable: string, probe: SdkInfoProbe = probeSdkInfo, now: () => number = Date.now,
): Promise<EnginePersonaInfo> {
  let key = executable;
  try {
    const st = statSync(executable);
    key = `${executable}\0${st.size}\0${st.mtimeMs}`;
  } catch { /* the probe below fails the same way */ }
  const hit = infoCache.get(key);
  if (hit && hit.expiresAt > now()) return copyInfo(hit.info);
  if (hit) infoCache.delete(key);
  let result: SdkInfoProbeResult;
  try { result = await probe(executable); } catch { return { schemas: [2] }; }
  const info = result.completed ? parseSdkInfo(result.stdout) : { schemas: [2] };
  if (result.completed || result.timedOut) {
    const modern = result.completed && info.schemas.includes(4);
    const ttl = modern ? Infinity : result.completed ? OLD_ENGINE_CACHE_MS : PROBE_TIMEOUT_CACHE_MS;
    infoCache.set(key, { info, expiresAt: modern ? Infinity : now() + ttl });
  }
  return copyInfo(info);
}

/** Persona schemas the engine at `executable` can load. Never throws: unknown means `[2]`. */
export async function enginePersonaSchemas(
  executable: string, probe: SdkInfoProbe = probeSdkInfo, now: () => number = Date.now,
): Promise<number[]> {
  return (await enginePersonaInfo(executable, probe, now)).schemas;
}

/** Test hook: forget every cached probe answer. */
export function resetEngineProbeCache(): void { infoCache.clear(); }

function parseInfoObject(text: string): any {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch { return undefined; }
}

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** Read the persona member out of `--ant0-sdk-info` output. Protocol 1 or a missing `persona` block
 * means schemas `[2]` and nothing else. The record is one JSON object: the whole trimmed output, else
 * the last line that is a complete JSON object (an engine may print a banner first). `sdk_protocol`
 * and the numbers must be integers; a string such as "2" does not count. Unknown fields are ignored. */
export function parseSdkInfo(output: string): EnginePersonaInfo {
  // A leading byte order mark (a Windows tool that writes UTF-8 with one) is not part of the record.
  const text = output.trim(); // trim() also strips a leading U+FEFF (byte order mark)
  let info = parseInfoObject(text);
  if (info === undefined) {
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && info === undefined; i--) {
      const line = lines[i].trim();
      if (line.startsWith("{") && line.endsWith("}")) info = parseInfoObject(line);
    }
  }
  if (info === undefined) return { schemas: [2] };
  const protocol = info.sdk_protocol;
  if (!Number.isInteger(protocol) || protocol < 2) return { schemas: [2] };
  const persona = info.persona;
  if (persona === null || typeof persona !== "object" || !Array.isArray(persona.schemas)) return { schemas: [2] };
  const ints = persona.schemas.filter((n: unknown): n is number => Number.isInteger(n));
  if (!ints.length) return { schemas: [2] };
  const out: EnginePersonaInfo = { schemas: ints };
  if (Number.isInteger(persona.revision)) out.revision = persona.revision;
  if (typeof persona.engine_family === "string") out.engineFamily = persona.engine_family;
  if (Number.isInteger(persona.engine_major)) out.engineMajor = persona.engine_major;
  for (const [wire, field] of [["os", "os"], ["arch", "arch"], ["brands", "brands"], ["capabilities", "capabilities"]] as const) {
    const list = stringList(persona[wire]);
    if (list !== undefined) out[field] = list;
  }
  return out;
}

/** Read the accepted persona schemas out of `--ant0-sdk-info` output (see `parseSdkInfo`). */
export function parseSdkInfoSchemas(output: string): number[] {
  return parseSdkInfo(output).schemas;
}

/** Throw `sdk.persona_requires_engine` unless the engine at `executable` can load schema 4. Returns
 * what the engine said, for the checks that follow. */
export async function assertEngineAcceptsSchema4(
  executable: string, probe: SdkInfoProbe = probeSdkInfo,
): Promise<EnginePersonaInfo> {
  const info = await enginePersonaInfo(executable, probe);
  if (!info.schemas.includes(4)) {
    throw new SdkError("sdk.persona_requires_engine",
      "this identity uses the new persona format (schema_version 4), which this engine does not " +
      "advertise in --ant0-sdk-info (persona.schemas). Use an engine that supports it; the persona " +
      "is not converted to the older format.");
  }
  return info;
}

/** Identity ids are implicit in the engine (`CapabilityIsKnown`): `os:*`, `engine:*`, `brand:*`
 * and `arch:*` are accepted when the value is one the engine supports, and are not listed in
 * persona.capabilities. Checked against the identity support the engine advertises; accepted when it
 * does not advertise that list. An empty value is never known. Anything else must be a listed capability. */
function requireIsServed(id: string, served: ReadonlySet<string>, info: EnginePersonaInfo): boolean {
  if (served.has(id)) return true;
  const m = /^(os|engine|brand|arch):(.*)$/.exec(id);
  if (!m || m[2] === "") return false;
  const advertised = m[1] === "os" ? info.os : m[1] === "arch" ? info.arch : m[1] === "brand" ? info.brands
    : info.engineFamily === undefined ? undefined : [info.engineFamily];
  return advertised === undefined || advertised.includes(m[2]);
}

/** Throw `sdk.persona_capability_missing` unless the engine serves every id the persona `requires`.
 * An engine that takes schema 4 but lists no capabilities cannot be checked and is refused too: it
 * would otherwise run without the profile and say so only in a log line. */
export function assertEngineServesRequires(requires: readonly string[], info: EnginePersonaInfo): void {
  if (info.capabilities === undefined) {
    throw new SdkError("sdk.persona_capability_missing",
      "this engine accepts the new persona format (schema_version 4) but does not list its capabilities " +
      "in --ant0-sdk-info (persona.capabilities), so the persona's requirements cannot be checked. " +
      "Use an engine that reports them.");
  }
  const served = new Set(info.capabilities);
  const missing = requires.filter((id) => !requireIsServed(id, served, info));
  if (missing.length > 0) {
    throw new SdkError("sdk.persona_capability_missing",
      `this persona requires capabilities the engine does not serve: ${missing.join(", ")}. The engine would ` +
      "run without the profile. Use an engine that serves them, or a persona that does not require them.");
  }
}

/** The engine refuses a persona file larger than this. */
export const PERSONA_FILE_MAX_BYTES = 1 << 20;

/** Throw `sdk.persona_too_large` when the encoded persona would not be accepted from a file. */
export function assertPersonaFileSize(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > PERSONA_FILE_MAX_BYTES) {
    throw new SdkError("sdk.persona_too_large",
      `the encoded persona is ${bytes} bytes; the engine accepts a persona file of at most ` +
      `${PERSONA_FILE_MAX_BYTES} bytes (1 MiB) and would run without the profile.`);
  }
}

/** A notice for the caller to print (respecting quiet): a persona that works but not as written. */
export interface PersonaNotice { code: string; message: string }

/** Code and text of the brand-version warning (same in the Python SDK). */
export const BRAND_VERSION_MAJOR_CODE = "persona-brand-version-major";
export function brandVersionNotice(profile: unknown, info: EnginePersonaInfo): PersonaNotice | undefined {
  const brand = (profile as { identity?: { brand?: { id?: unknown; version?: unknown } } })?.identity?.brand;
  const version = brand?.version;
  // The engine compares the major for Chrome and Edge only; other brands carry their own version.
  if (brand?.id !== "chrome" && brand?.id !== "edge") return undefined;
  if (typeof version !== "string" || info.engineMajor === undefined) return undefined;
  const major = version.split(".")[0];
  if (major === String(info.engineMajor)) return undefined;
  return {
    code: BRAND_VERSION_MAJOR_CODE,
    message: `the persona's brand version ${version} has major ${major}, but this engine's major is ` +
      `${info.engineMajor}. For Chrome and Edge the engine presents the brand version only when the majors match, ` +
      "so the page will not show it. Use a persona issued for this engine's major.",
  };
}

/** Runs one command and resolves with its stdout; rejects when it cannot run or exits non-zero.
 * Injected in tests; the default uses execFile with an argument array (no shell). */
export type CommandRunner = (file: string, args: string[]) => Promise<string>;

const runCommand: CommandRunner = (file, args) => new Promise((res, rej) => {
  execFile(file, args, { windowsHide: true, timeout: 15000, encoding: "utf8" },
    (error, stdout) => (error ? rej(error) : res(String(stdout))));
});

/** The current user's SID from `whoami /user /fo csv /nh` (one line: "DOMAIN\\user","S-1-5-..."). */
export async function currentUserSid(run: CommandRunner = runCommand): Promise<string> {
  const out = await run("whoami", ["/user", "/fo", "csv", "/nh"]);
  const fields = out.trim().split(/\r?\n/)[0]?.match(/"([^"]*)"/g)?.map((f) => f.slice(1, -1)) ?? [];
  const sid = fields[1];
  if (!sid || !/^S-1-\d+(-\d+)+$/.test(sid)) throw new Error("whoami did not return a SID");
  return sid;
}

/** Remove inherited access from `path` and grant the current user, by SID, full control. */
export async function restrictToCurrentUserWindows(path: string, run: CommandRunner = runCommand): Promise<void> {
  try {
    const sid = await currentUserSid(run);
    await run("icacls", [path, "/inheritance:r", "/grant:r", `*${sid}:F`]);
  } catch (cause) {
    throw new SdkError("sdk.profile_file_unsafe",
      `cannot restrict the persona file to the current user: ${path}`, { cause });
  }
}

async function restrictToCurrentUser(path: string, fd: number, run: CommandRunner, platform: string): Promise<void> {
  if (platform !== "win32") {
    fchmodSync(fd, 0o600); // by handle: no second path lookup
    return;
  }
  await restrictToCurrentUserWindows(path, run);
}

/** Write `text` to `target` through a private temporary file in the same directory, then rename.
 * The temporary file is created exclusively (O_EXCL never follows or reuses a planted path) and
 * restricted to the current user before any content is written. The content goes through the handle
 * from that exclusive create: re-opening the path is not needed, and on Windows a second open with
 * O_TRUNC failed (EINVAL). A permission change does not affect a handle that is already open. */
async function writePrivateAtomic(
  target: string, text: string, run: CommandRunner = runCommand, platform: string = process.platform,
): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let created = false;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    await restrictToCurrentUser(temp, fd, run, platform);
    const data = Buffer.from(text, "utf8");
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
    const done = fd; // clear first: if closeSync throws, the finally must not close this number again
    fd = undefined;
    closeSync(done);
    renameSync(temp, target);
    created = false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    if (created) { try { unlinkSync(temp); } catch { /* already gone */ } }
  }
}

/** Write a schema 4 persona to `<userDataDir>/ant0-persona.profile` and return its absolute path.
 * `run` and `platform` exist for tests. */
export async function writePersonaProfileFile(
  userDataDir: string, profile: unknown, run: CommandRunner = runCommand, platform: string = process.platform,
): Promise<string> {
  assertPersonaProfileV4(profile);
  const text = encodeProfile(profile as unknown as Record<string, unknown>);
  assertPersonaFileSize(text); // before anything is created
  const dir = resolve(userDataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, PROFILE_FILE_NAME);
  await writePrivateAtomic(path, text, run, platform);
  return path;
}

/** Remove a stale `ant0-persona.profile` from `userDataDir`: only that exact name, and a symlink is
 * unlinked itself, never followed. Best effort; returns whether something was removed. */
export function removeStalePersonaFile(userDataDir: string): boolean {
  if (!userDataDir) return false; // "" means "no profile dir" (Playwright uses a temp dir); never the cwd
  const path = join(resolve(userDataDir), PROFILE_FILE_NAME);
  try {
    lstatSync(path);
    unlinkSync(path);
    return true;
  } catch { return false; }
}

export interface StagedPersona {
  /** Things worth telling the user about this persona and engine; print them with `emitPersonaNotices`. */
  notices: PersonaNotice[];
  /** The options to hand to `fingerprintArgs`: for schema 4, `fingerprintProfileFile` is set. */
  fingerprint: FingerprintOptions;
  /** Remove the temporary directory created for the file, if any. Safe to call twice. */
  cleanup(): void;
  /** Delete the persona file itself, wherever it is (also in a profile directory the caller keeps). The
   * engine reads it once at startup, so call this once the browser is up, or when the launch failed.
   * Safe to call twice and when no file was written. */
  removeFile(): void;
}

// Temporary persona directories still alive; removed at process exit as a last resort.
const liveTemps = new Set<string>();
let exitHandlerInstalled = false;
function removeLiveTemps(): void {
  for (const d of liveTemps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  liveTemps.clear();
}
function cleanupEverything(): void {
  removeLiveTemps();
  killLiveProbesSync();
}

// Signal handlers exist only while something needs cleaning (a temp persona dir or a running probe), so an
// idle SDK never changes how the host app reacts to SIGINT or SIGTERM. A handler cleans up and then:
//  - other listeners exist: does nothing more; they run, the host decides (the signal is not swallowed: it
//    was delivered to them);
//  - none exist: re-raises the signal, so the process ends the way it would have.
// Either way the handlers are removed once nothing needs cleaning.
const signalHandlers = new Map<NodeJS.Signals, () => void>();
function ensureProcessHooks(): void {
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on("exit", cleanupEverything);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const installed = signalHandlers.get(signal);
    if (installed && process.listeners(signal).includes(installed)) continue; // (a host may have cleared its listeners)
    const handler = () => {
      cleanupEverything();
      const others = process.listeners(signal).filter((l) => l !== handler);
      // Nothing is left to clean, so no handler of ours stays: the host's own listeners (if any) run on their own.
      releaseProcessHooks();
      if (others.length === 0) {
        try { process.kill(process.pid, signal); } catch { /* best effort */ }
      }
    };
    try { process.on(signal, handler); signalHandlers.set(signal, handler); } catch { /* not supported on this platform */ }
  }
}
function releaseProcessHooks(): void {
  if (liveTemps.size > 0 || liveProbes.size > 0) return;
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  signalHandlers.clear();
}
function registerTemp(dir: string): void {
  liveTemps.add(dir);
  ensureProcessHooks();
}

/** Throw unless the engine at `executable` can load the persona and serves what it requires (a schema 2 or
 * absent persona passes). For the binary a launch plan actually spawns when it is not the one staged for. */
export async function assertPersonaFitsEngine(
  profile: unknown, executable: string, probe: SdkInfoProbe = probeSdkInfo,
): Promise<void> {
  if (typeof profile !== "object" || profile === null || !isPersonaV4(profile)) return;
  const info = await assertEngineAcceptsSchema4(executable, probe);
  assertEngineServesRequires((profile as { requires: string[] }).requires, info);
}

/** Prepare the persona transport for one launch. A schema 2 or absent persona is returned
 * untouched, and a stale persona file in `userDataDir` is removed. A schema 4 persona is checked
 * against the engine and written to a private file in `userDataDir`, or, when the launch has no
 * profile directory of its own (an incognito launch), in a private temporary directory that
 * `cleanup()` removes (an empty `userDataDir` counts as none; callers run it when the browser closes; a process-exit handler is the
 * fallback). */
export async function stagePersonaProfile(
  fingerprint: FingerprintOptions, executable: string, userDataDir?: string,
  deps: { probe?: SdkInfoProbe; run?: CommandRunner; platform?: string } = {},
): Promise<StagedPersona> {
  const profile = fingerprint.fingerprintProfile;
  if (typeof profile !== "object" || profile === null || !isPersonaV4(profile)) {
    if (userDataDir) removeStalePersonaFile(userDataDir);
    return { fingerprint, notices: [], cleanup() {}, removeFile() {} };
  }
  assertPersonaProfileV4(profile);
  const info = await assertEngineAcceptsSchema4(executable, deps.probe);
  assertEngineServesRequires((profile as { requires: string[] }).requires, info);
  const notice = brandVersionNotice(profile, info);
  if ((profile as { provenance?: { noise_key?: unknown } }).provenance?.noise_key === undefined) {
    debugLog("the persona has no provenance.noise_key; the engine derives one from the document");
  }
  let temp: string | undefined;
  // An empty path means "no profile directory of its own" (as Playwright reads it), never the cwd.
  if (!userDataDir) { temp = mkdtempSync(join(tmpdir(), "ant0-persona-")); registerTemp(temp); }
  const dir = userDataDir || temp!;
  const cleanup = () => {
    if (!temp) return;
    const d = temp;
    temp = undefined;
    liveTemps.delete(d);
    try { rmSync(d, { recursive: true, force: true }); } finally { releaseProcessHooks(); }
  };
  try {
    const path = await writePersonaProfileFile(dir, profile, deps.run, deps.platform);
    const removeFile = () => { try { unlinkSync(path); } catch { /* already gone */ } };
    return { fingerprint: { ...fingerprint, fingerprintProfileFile: path }, notices: notice ? [notice] : [], cleanup, removeFile };
  } catch (error) {
    cleanup();
    throw error;
  }
}
