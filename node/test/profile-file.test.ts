// Persona file creation and engine probe: the file system calls and the probe are observed directly.

import * as realFs from "node:fs";
let procCmdline: ((path: string) => string | undefined) | undefined;
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoReservedArgs } from "../src/launchopts.js";
import { emitPersonaNotices } from "../src/warnings.js";

const opens: { path: string; flags: number; mode: number | undefined; contentAtOpen: number }[] = [];
// Descriptors the persona writer opened and closed, and hooks that make a handle call fail.
const fdLog: { opened: number[]; closed: number[]; fchmod: [number, number][]; chmodPaths: string[] } =
  { opened: [], closed: [], fchmod: [], chmodPaths: [] };
let writeHook: (() => void) | undefined;
let closeHook: ((fd: number) => void) | undefined;
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeSync: ((...a: any[]) => { writeHook?.(); return (real.writeSync as any)(...a); }) as typeof real.writeSync,
    closeSync: ((fd: number) => {
      fdLog.closed.push(fd);
      const hook = closeHook; closeHook = undefined;
      try { real.closeSync(fd); } finally { hook?.(fd); }
    }) as typeof real.closeSync,
    fchmodSync: ((fd: number, mode: number) => { fdLog.fchmod.push([fd, mode]); return real.fchmodSync(fd, mode); }) as typeof real.fchmodSync,
    chmodSync: ((path: any, mode: any) => { fdLog.chmodPaths.push(String(path)); return real.chmodSync(path, mode); }) as typeof real.chmodSync,
    readFileSync: ((path: any, ...rest: any[]) => {
      const faked = typeof path === "string" ? procCmdline?.(path) : undefined;
      return faked !== undefined ? faked : (real.readFileSync as any)(path, ...rest);
    }) as typeof real.readFileSync,
    openSync: (path: any, flags: any, mode?: any) => {
      let contentAtOpen = -1;
      try { contentAtOpen = real.statSync(path).size; } catch { /* does not exist yet */ }
      opens.push({ path: String(path), flags, mode, contentAtOpen });
      const fd = real.openSync(path, flags, mode);
      if (String(path).endsWith(".tmp")) fdLog.opened.push(fd);
      return fd;
    },
  };
});

type SpawnFn = typeof import("node:child_process").spawn;
let taskkillHook: ((...args: Parameters<SpawnFn>) => unknown) | undefined;
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: ((command: any, ...rest: any[]) =>
      command === "taskkill" && taskkillHook ? taskkillHook(command, ...(rest as [any])) : (real.spawn as any)(command, ...rest)) as SpawnFn,
  };
});

import { isAnt0Binary } from "../src/download.js";
import {
  PROFILE_FILE_NAME, assertEngineServesRequires, brandVersionNotice, currentUserSid,
  enginePersonaInfo, enginePersonaSchemas, parseSdkInfo, parseSdkInfoSchemas, probeSdkInfo,
  PROBE_DIR_MAX_LENGTH, PROBE_DIR_PREFIX, STALE_PROBE_DIR_MS, killProbeTree, makeProbeDir, sweepStaleProbeDirs, removeStalePersonaFile, resetEngineProbeCache, stagePersonaProfile, writePersonaProfileFile,
  type CommandRunner, type SdkInfoProbe,
} from "../src/profile-file.js";

const v4 = () => ({
  schema_version: 4, schema_revision: 1, requires: ["display"],
  provenance: { source: "synthetic", model: { version: "population-model-v2.2", sha256: "0".repeat(64) } },
  identity: {
    os: { family: "windows", release: "windows-11", platform_version: "19.0.0", architecture: "x86_64" },
    engine: { family: "blink", major: 158 }, brand: { id: "edge", version: "158.0.4370.16" },
    form_factor: "desktop", device_model: "",
  },
  surfaces: { display: { width: 1920 } },
});
const v2 = () => JSON.parse(readFileSync(
  new URL("../../fixtures/synthetic/persona-v2.json", import.meta.url), "utf8"));
const CAPABILITIES = ["navigator","navigator.ua_ch","display","input","gpu.webgl","gpu.webgpu","fonts","speech","audio","media.decoding","media.devices","network"];
const info = (schemas: number[], protocol = 2, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ sdk_protocol: protocol, persona: { schemas, revision: 1, engine_family: "blink", engine_major: 158, capabilities: CAPABILITIES, ...extra } });

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "ant0-pf-test-")); roots.push(p); return p; };
beforeEach(() => { opens.length = 0; fdLog.opened.length = 0; fdLog.closed.length = 0; fdLog.fchmod.length = 0; fdLog.chmodPaths.length = 0; writeHook = undefined; closeHook = undefined; taskkillHook = undefined; procCmdline = undefined; resetEngineProbeCache(); });
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const posix = process.platform === "win32" ? it.skip : it; // fake engines are /bin/sh scripts
const sh = (body: string): string => {
  const path = join(temp(), "chrome");
  writeFileSync(path, `#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
const fakeEngine = (output: string) => sh(`cat <<'JSON'\n${output}\nJSON`);

describe("persona temporary file creation", () => {
  const tempOpens = () => opens.filter((o) => o.path.endsWith(".tmp"));
  it("is created exclusively, with mode 0600 at creation, before any content exists", async () => {
    const udd = temp();
    await writePersonaProfileFile(udd, v4(), async () => "", "linux");
    const creation = tempOpens()[0];
    expect(creation).toBeDefined();
    // O_EXCL: a pre-existing or planted file is an error, never reused
    expect(creation.flags & realFs.constants.O_EXCL).toBe(realFs.constants.O_EXCL);
    expect(creation.flags & realFs.constants.O_CREAT).toBe(realFs.constants.O_CREAT);
    // the owner-only mode is given to open(), not applied after the fact
    expect(creation.mode).toBe(0o600);
    // nothing has been written when the file is created
    expect(creation.contentAtOpen).toBe(-1);
    // the content goes through the handle of that exclusive create: the path is never opened again
    // (nothing to follow or swap in between; a second open with O_TRUNC failed on Windows)
    expect(tempOpens()).toHaveLength(1);
  });
  posix("ends as 0600 under a permissive umask", async () => {
    const old = process.umask(0);
    try {
      const path = await writePersonaProfileFile(temp(), v4(), async () => "", "linux");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { process.umask(old); }
  });
});

describe("the descriptor of the exclusive create", () => {
  const sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  const left = (udd: string) => readdirSync(udd);
  it("is closed once and no temporary file is left when writeSync throws", async () => {
    const udd = temp();
    writeHook = () => { throw new Error("disk full"); };
    await expect(writePersonaProfileFile(udd, v4(), async () => "", "linux")).rejects.toThrow("disk full");
    expect(fdLog.opened).toHaveLength(1);
    expect(fdLog.closed).toEqual(fdLog.opened);
    expect(left(udd)).toEqual([]);
  });
  it("is closed once and no temporary file is left when the icacls runner throws", async () => {
    const udd = temp();
    const run: CommandRunner = async (file) => { if (file === "icacls") throw new Error("denied"); return `"A\\b","${sid}"`; };
    await expect(writePersonaProfileFile(udd, v4(), run, "win32")).rejects.toMatchObject({ code: "sdk.profile_file_unsafe" });
    expect(fdLog.opened).toHaveLength(1);
    expect(fdLog.closed).toEqual(fdLog.opened);
    expect(left(udd)).toEqual([]);
  });
  it("is not closed a second time when closeSync itself throws", async () => {
    const udd = temp();
    closeHook = () => { throw new Error("EIO on close"); };
    await expect(writePersonaProfileFile(udd, v4(), async () => "", "linux")).rejects.toThrow("EIO on close");
    expect(fdLog.closed).toEqual(fdLog.opened); // exactly one close of that number
    expect(left(udd)).toEqual([]);
  });
  posix("is restricted by handle (fchmod), not by path", async () => {
    await writePersonaProfileFile(temp(), v4(), async () => "", "linux");
    expect(fdLog.fchmod).toEqual([[fdLog.opened[0], 0o600]]);
    expect(fdLog.chmodPaths).toEqual([]);
  });
});

describe("Windows privacy at creation", () => {
  const sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  it("restricts the empty temporary file by SID before the content is written", async () => {
    const udd = temp();
    const calls: { file: string; args: string[]; sizeAtCall: number; names: string[] }[] = [];
    const run: CommandRunner = async (file, args) => {
      const tmpFile = readdirSync(udd).find((f) => f.endsWith(".tmp"));
      calls.push({ file, args, sizeAtCall: tmpFile ? statSync(join(udd, tmpFile)).size : -1, names: readdirSync(udd) });
      return file === "whoami" ? `"DOMAIN\\user","${sid}"\r\n` : "";
    };
    const path = await writePersonaProfileFile(udd, v4(), run, "win32");
    expect(calls.map((c) => c.file)).toEqual(["whoami", "icacls"]);
    expect(calls[0].args).toEqual(["/user", "/fo", "csv", "/nh"]);
    expect(calls[1].args[0]).toMatch(/\.tmp$/);        // the temporary file, not the final name
    expect(calls[1].args.slice(1)).toEqual(["/inheritance:r", "/grant:r", `*${sid}:F`]);
    expect(calls.every((c) => c.sizeAtCall === 0)).toBe(true); // still empty when restricted
    expect(calls[1].names.includes(PROFILE_FILE_NAME)).toBe(false);
    expect(statSync(path).size).toBeGreaterThan(0);
    expect(readdirSync(udd)).toEqual([PROFILE_FILE_NAME]);
  });
  it("does not use the account name, and passes arguments as an array", async () => {
    const seen: string[][] = [];
    await writePersonaProfileFile(temp(), v4(), async (f, a) => { seen.push([f, ...a]); return f === "whoami" ? `"A\\b","${sid}"` : ""; }, "win32");
    expect(seen.flat().some((x) => x.includes("\\"))).toBe(false);
    expect(seen.every((cmd) => cmd.every((x) => typeof x === "string"))).toBe(true);
  });
  it("fails the write, leaving nothing behind, when icacls fails", async () => {
    const udd = temp();
    const run: CommandRunner = async (file) => { if (file === "icacls") throw new Error("denied"); return `"A\\b","${sid}"`; };
    await expect(writePersonaProfileFile(udd, v4(), run, "win32")).rejects.toMatchObject({ code: "sdk.profile_file_unsafe" });
    expect(readdirSync(udd)).toEqual([]);
  });
  it("fails the write when whoami fails or prints no SID", async () => {
    for (const out of ["", "garbage", '"A\\b","not-a-sid"']) {
      const udd = temp();
      await expect(writePersonaProfileFile(udd, v4(), async () => out, "win32")).rejects.toMatchObject({ code: "sdk.profile_file_unsafe" });
      expect(readdirSync(udd)).toEqual([]);
    }
    await expect(writePersonaProfileFile(temp(), v4(), async () => { throw new Error("no whoami"); }, "win32"))
      .rejects.toMatchObject({ code: "sdk.profile_file_unsafe" });
  });
  it("parses the SID out of the csv line", async () => {
    expect(await currentUserSid(async () => `"CORP\\ann lee","${sid}"\r\n`)).toBe(sid);
  });
});

describe("engine probe", () => {
  it("is async: the event loop keeps turning while the engine runs", async () => {
    const engine = sh("sleep 0.4; echo '" + info([2, 4]) + "'");
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    try { expect(await enginePersonaSchemas(engine)).toEqual([2, 4]); } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(5);
  });
  posix("kills an engine that ignores SIGTERM: the process is gone, not just abandoned", async () => {
    const pidFile = join(temp(), "pid");
    const engine = sh(`trap '' TERM; echo $$ > '${pidFile}'; exec sleep 30`);
    const t0 = Date.now();
    const r = await probeSdkInfo(engine, { timeoutMs: 300 });
    expect(r.completed).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r2) => setTimeout(r2, 20));
    expect(alive()).toBe(false);
  });
  posix("runs the engine with a private profile dir and isolating arguments, and removes the dir", async () => {
    const out = join(temp(), "argv");
    const engine = sh(`for a in "$@"; do echo "$a"; done > '${out}'
for a in "$@"; do case "$a" in --user-data-dir=*) [ -d "\${a#--user-data-dir=}" ] && echo EXISTS >> '${out}';; esac; done
echo '${info([2, 4])}'`);
    const r = await probeSdkInfo(engine);
    expect(r.completed).toBe(true);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    const udd = lines.find((l) => l.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    expect(udd).toContain("ant0sdk-probe-");
    expect(udd.startsWith(tmpdir())).toBe(true);
    expect(lines).toContain("EXISTS");                 // it existed while the engine ran
    expect(lines).toEqual(expect.arrayContaining(["--headless=new", "--no-first-run", "--no-default-browser-check", "--ant0-sdk-info"]));
    expect(existsSync(udd)).toBe(false);               // and is gone afterwards
  });
  posix("answers when the process exits even if a child keeps stdout open", async () => {
    const engine = sh(`echo '${info([2, 4])}'; sleep 3 &`);
    const t0 = Date.now();
    const r = await probeSdkInfo(engine, { timeoutMs: 5000, drainMs: 100 });
    expect(r.completed).toBe(true);
    expect(parseSdkInfoSchemas(r.stdout)).toEqual([2, 4]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  posix("caps the output", async () => {
    const engine = sh("exec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const r = await probeSdkInfo(engine, { timeoutMs: 5000, maxBytes: 4096 });
    expect(r).toEqual({ completed: false, timedOut: true, stdout: "" });
  });
  it("a missing executable is not completed", async () => {
    expect(await probeSdkInfo(join(temp(), "nope"))).toEqual({ completed: false, stdout: "" });
  });
  it("caches by path, size and mtime: a modern engine for good, a completed old engine for 10 minutes, a timeout for 30 s, a spawn error never", async () => {
    const engine = join(temp(), "chrome");
    writeFileSync(engine, "x");
    let n = 0;
    let t = 1_000_000;
    const now = () => t;
    const answers: { completed: boolean; timedOut?: boolean; stdout: string }[] = [
      { completed: false, stdout: "" },                 // spawn error: not cached
      { completed: false, stdout: "" },                 // spawn error again
      { completed: false, timedOut: true, stdout: "" }, // timeout: cached for 30 s
      { completed: true, stdout: info([2]) },           // old engine answer after the entry expires
      { completed: true, stdout: info([2, 4]) },        // then a modern engine
    ];
    const probe: SdkInfoProbe = async () => answers[Math.min(n++, answers.length - 1)];
    expect(await enginePersonaSchemas(engine, probe, now)).toEqual([2]);
    expect(await enginePersonaSchemas(engine, probe, now)).toEqual([2]);
    expect(n).toBe(2);                                  // spawn errors: asked again each time
    expect(await enginePersonaSchemas(engine, probe, now)).toEqual([2]);
    expect(n).toBe(3);
    t += 20 * 1000;
    expect(await enginePersonaSchemas(engine, probe, now)).toEqual([2]);
    expect(n).toBe(3);                                  // the timeout is remembered: no second 5 s wait
    t += 20 * 1000;                                     // 40 s in: the 30 s entry expired
    expect(await enginePersonaSchemas(engine, probe, now)).toEqual([2]);
    expect(n).toBe(4);                                  // completed but old
    t += 9 * 60 * 1000;
    await enginePersonaSchemas(engine, probe, now);
    expect(n).toBe(4);                                  // the old-engine answer is cached too
    t += 2 * 60 * 1000;
    expect(await enginePersonaSchemas(engine, probe, now)).toEqual([2, 4]);
    expect(n).toBe(5);
    t += 24 * 3600 * 1000;
    expect(await enginePersonaSchemas(engine, probe, now)).toEqual([2, 4]);
    expect(n).toBe(5);                                  // a modern answer does not expire
    writeFileSync(engine, "changed binary");            // size changes: probe again
    await enginePersonaSchemas(engine, probe, now);
    expect(n).toBe(6);
  });
  posix("a first run that is slower than the timeout is retried after 30 s and then seen as schema 4", async () => {
    const marker = join(temp(), "ran");
    const engine = sh(`if [ ! -e '${marker}' ]; then : > '${marker}'; exec sleep 30; fi\necho '${info([2, 4])}'`);
    let t = 5_000_000;
    const now = () => t;
    let n = 0;
    const probe: SdkInfoProbe = (e) => { n++; return probeSdkInfo(e, { timeoutMs: 400, drainMs: 50 }); };
    expect((await enginePersonaInfo(engine, probe, now)).schemas).toEqual([2]);   // timed out
    t += 29_000;
    expect((await enginePersonaInfo(engine, probe, now)).schemas).toEqual([2]);   // cached timeout
    expect(n).toBe(1);
    t += 2_000;                                                                   // 31 s: window over
    expect((await enginePersonaInfo(engine, probe, now)).schemas).toEqual([2, 4]);
    expect(n).toBe(2);
    t += 7 * 24 * 3600 * 1000;
    await enginePersonaInfo(engine, probe, now);
    expect(n).toBe(2);                                                            // schema 4 is kept for good
  });
  it("an old engine that times out costs the wait once, not on every launch", async () => {
    const engine = join(temp(), "chrome");
    writeFileSync(engine, "x");
    let n = 0;
    const probe: SdkInfoProbe = async () => { n++; return { completed: false, timedOut: true, stdout: "" }; };
    for (let i = 0; i < 3; i++) {
      await expect(stagePersonaProfile({ fingerprintProfile: v4() as any }, engine, temp(), { probe, run: async () => "", platform: "linux" }))
        .rejects.toMatchObject({ code: "sdk.persona_requires_engine" });
    }
    expect(n).toBe(1);
  });
  posix("the probe child's TMPDIR, TMP and TEMP are the probe dir, and what it creates there is removed with it", async () => {
    const marker = `m${process.pid}${Date.now()}`;
    const out = join(temp(), "env");
    const engine = sh(`echo "$TMPDIR|$TMP|$TEMP" > '${out}'
mkdir "$TMPDIR/org.chromium.Chromium.${marker}"; : > "$TMPDIR/org.chromium.Chromium.${marker}/SingletonSocket"
exec sleep 30`);
    const r = await probeSdkInfo(engine, { timeoutMs: 400 });
    expect(r).toEqual({ completed: false, timedOut: true, stdout: "" });
    const [a, b, c] = readFileSync(out, "utf8").trim().split("|");
    expect(a).toContain("ant0sdk-probe-");
    expect([b, c]).toEqual([a, a]);
    expect(existsSync(a)).toBe(false);                                           // the probe dir and its contents are gone
    expect(existsSync(join(tmpdir(), `org.chromium.Chromium.${marker}`))).toBe(false); // nothing leaked into TMPDIR
  });
  it("a probe that throws is an unknown engine and is not cached", async () => {
    const engine = join(temp(), "chrome");
    writeFileSync(engine, "x");
    let n = 0;
    const probe: SdkInfoProbe = async () => { n++; throw new Error("boom"); };
    expect(await enginePersonaSchemas(engine, probe)).toEqual([2]);
    await enginePersonaSchemas(engine, probe);
    expect(n).toBe(2);
  });
  posix("a real engine that exits non-zero counts as an old engine and is cached", async () => {
    const engine = sh("exit 3");
    expect(await enginePersonaSchemas(engine)).toEqual([2]);
    writeFileSync(engine, "#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\ncat <<'JSON'\n" + info([2, 4]) + "\nJSON\n"); // a different binary: probed again
    expect(await enginePersonaSchemas(engine)).toEqual([2, 4]);
  });
});

describe("parseSdkInfoSchemas", () => {
  const cases = JSON.parse(readFileSync(
    new URL("../../fixtures/synthetic/sdk-info-parse.json", import.meta.url), "utf8")).cases as
    { name: string; output: string; expected: number[] }[];
  // The same file is run by the Python suite: both SDKs must read every output the same way.
  for (const c of cases) it(`shared case: ${c.name}`, () => { expect(parseSdkInfoSchemas(c.output)).toEqual(c.expected); });
  const camel = (k: string) => k.replace(/_([a-z])/g, (_m, ch) => ch.toUpperCase());
  const allCases = JSON.parse(readFileSync(
    new URL("../../fixtures/synthetic/sdk-info-parse.json", import.meta.url), "utf8")).cases as
    { name: string; output: string; expected_info?: Record<string, unknown> }[];
  for (const c of allCases.filter((x) => x.expected_info)) {
    it(`shared persona member: ${c.name}`, () => {
      const want = Object.fromEntries(Object.entries(c.expected_info!).map(([k, v]) => [camel(k), v]));
      expect(parseSdkInfo(c.output)).toEqual(want);
    });
  }
  it("reads a pretty-printed record", () => {
    expect(parseSdkInfoSchemas(JSON.stringify({ sdk_protocol: 2, persona: { schemas: [2, 4] } }, null, 2))).toEqual([2, 4]);
    expect(parseSdkInfoSchemas(`${info([2, 4])}\ntrailing text`)).toEqual([2, 4]);
  });
});

describe("stale and temporary persona files", () => {
  posix("a launch without a schema 4 persona removes the stale file, and only that file", async () => {
    const udd = temp();
    writeFileSync(join(udd, PROFILE_FILE_NAME), "old persona");
    writeFileSync(join(udd, "ant0-persona.profile.bak"), "keep");
    writeFileSync(join(udd, "Preferences"), "keep");
    const fp = { fingerprintProfile: v2() };
    const staged = await stagePersonaProfile(fp as any, "/nonexistent/chrome", udd);
    expect(staged.fingerprint).toBe(fp);
    expect(readdirSync(udd).sort()).toEqual(["Preferences", "ant0-persona.profile.bak"]);
  });
  posix("unlinks a symlink with that name without following it", () => {
    const udd = temp();
    const outside = join(temp(), "secret");
    writeFileSync(outside, "do not touch");
    symlinkSync(outside, join(udd, PROFILE_FILE_NAME));
    expect(removeStalePersonaFile(udd)).toBe(true);
    expect(() => lstatSync(join(udd, PROFILE_FILE_NAME))).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("do not touch");
  });
  posix("an empty userDataDir never touches the current directory", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, PROFILE_FILE_NAME), "mine, not stale");
    const old = process.cwd();
    process.chdir(cwd);
    try {
      // not a schema 4 persona: nothing is removed
      const fp = { fingerprintProfile: v2() };
      expect((await stagePersonaProfile(fp as any, "/nonexistent/chrome", "")).fingerprint).toBe(fp);
      expect(removeStalePersonaFile("")).toBe(false);
      expect(readFileSync(join(cwd, PROFILE_FILE_NAME), "utf8")).toBe("mine, not stale");
      // a schema 4 persona: written to a private temp dir (like an incognito launch), never the cwd
      const probe: SdkInfoProbe = async () => ({ completed: true, stdout: info([2, 4]) });
      const staged = await stagePersonaProfile({ fingerprintProfile: v4() as any }, "/x/chrome", "", { probe, run: async () => "", platform: "linux" });
      const path = staged.fingerprint.fingerprintProfileFile!;
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(path.startsWith(realFs.realpathSync(cwd))).toBe(false);
      expect(readFileSync(join(cwd, PROFILE_FILE_NAME), "utf8")).toBe("mine, not stale");
      expect(readdirSync(cwd)).toEqual([PROFILE_FILE_NAME]);
      staged.cleanup();
      expect(existsSync(path)).toBe(false);
    } finally { process.chdir(old); }
  });
  it("leaves a directory with that name alone and survives a missing profile dir", () => {
    const udd = temp();
    mkdirSync(join(udd, PROFILE_FILE_NAME));
    expect(removeStalePersonaFile(udd)).toBe(false);
    expect(existsSync(join(udd, PROFILE_FILE_NAME))).toBe(true);
    expect(removeStalePersonaFile(join(udd, "missing"))).toBe(false);
  });
  posix("the probe disables background networking, updates and crash reporting, and points every home at the probe dir", async () => {
    const out = join(temp(), "seen");
    const engine = sh(`{ echo "$@"; echo "$HOME|$USERPROFILE|$APPDATA|$LOCALAPPDATA|$XDG_CONFIG_HOME|$XDG_DATA_HOME|$XDG_CACHE_HOME|$XDG_STATE_HOME|$XDG_RUNTIME_DIR|$TMPDIR"; } > '${out}'
exec sleep 30`);
    await probeSdkInfo(engine, { timeoutMs: 400 });
    const [argLine, envLine] = readFileSync(out, "utf8").trim().split("\n");
    for (const sw of ["--disable-background-networking", "--disable-component-update", "--no-first-run", "--disable-breakpad", "--disable-crash-reporter", "--headless=new", "--proxy-server=127.0.0.1:9", "--ant0-sdk-info"])
      expect(argLine.split(" "), sw).toContain(sw);
    const dirs = envLine.split("|");
    expect(dirs).toHaveLength(10);
    expect(new Set(dirs).size).toBe(1);                     // all the same, and it is the probe dir
    expect(dirs[0]).toContain("ant0sdk-probe-");
    expect(dirs[0]).not.toBe(process.env.HOME);
    expect(argLine).toContain(`--user-data-dir=${dirs[0]}`);
  });
  posix("the probe dir path is short, also when TMPDIR is long", () => {
    const short = makeProbeDir();
    roots.push(short);
    expect(short.length).toBeLessThanOrEqual(PROBE_DIR_MAX_LENGTH + 6);
    const longBase = join(temp(), "a".repeat(40), "b".repeat(40));
    realFs.mkdirSync(longBase, { recursive: true });
    const old = process.env.TMPDIR;
    process.env.TMPDIR = longBase;
    try {
      const dir = makeProbeDir();
      roots.push(dir);
      expect(dir.startsWith(longBase)).toBe(false);
      expect(dir.length).toBeLessThanOrEqual(PROBE_DIR_MAX_LENGTH + 6);
    } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; }
  });
  posix("a timed-out probe takes its whole process group with it", async () => {
    const pids = join(temp(), "pids");
    const engine = sh(`sleep 60 &\necho $! > '${pids}'\nexec sleep 60`);
    const r = await probeSdkInfo(engine, { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    const grandchild = Number(readFileSync(pids, "utf8").trim());
    expect(grandchild).toBeGreaterThan(1);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(grandchild, 0); await new Promise((r2) => setTimeout(r2, 50)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });
  it("an incognito (no profile dir) schema 4 launch uses a temp dir that cleanup removes, twice-safe", async () => {
    const probe: SdkInfoProbe = async () => ({ completed: true, stdout: info([2, 4]) });
    const staged = await stagePersonaProfile({ fingerprintProfile: v4() as any }, "/x/chrome", undefined, { probe, run: async () => "", platform: "linux" });
    const path = staged.fingerprint.fingerprintProfileFile!;
    expect(statSync(path).isFile()).toBe(true);
    staged.cleanup();
    staged.cleanup();
    expect(existsSync(path)).toBe(false);
  });
});


describe("requires negotiation, size limit and brand version", () => {
  const probeWith = (extra: Record<string, unknown> = {}, drop: string[] = []): SdkInfoProbe => async () => {
    const o = JSON.parse(info([2, 4], 2, extra));
    for (const k of drop) delete o.persona[k];
    return { completed: true, stdout: JSON.stringify(o) };
  };
  const stage = (profile: any, udd: string | undefined, probe: SdkInfoProbe) =>
    (resetEngineProbeCache(), stagePersonaProfile)({ fingerprintProfile: profile }, "/x/chrome", udd, { probe, run: async () => "", platform: "linux" });

  it("a persona whose requires the engine serves is staged", async () => {
    const udd = temp();
    const p: any = v4(); p.requires = ["display", "input", "gpu.webgl", "network"];
    const staged = await stage(p, udd, probeWith());
    expect(staged.fingerprint.fingerprintProfileFile).toBe(join(udd, PROFILE_FILE_NAME));
  });
  it("names every missing capability and writes nothing", async () => {
    const udd = temp();
    const p: any = v4(); p.requires = ["display", "appearance.system_colors", "keyboard.map"];
    await expect(stage(p, udd, probeWith())).rejects.toMatchObject({
      code: "sdk.persona_capability_missing",
      message: expect.stringContaining("appearance.system_colors, keyboard.map"),
    });
    expect(readdirSync(udd)).toEqual([]);
  });
  it("accepts identity ids the engine accepts although persona.capabilities does not list them (CapabilityIsKnown)", async () => {
    const p: any = v4();
    p.requires = ["display", "os:windows", "os:macos", "engine:blink", "brand:edge", "brand:vivaldi", "arch:arm64"];
    const advertised = { os: ["windows", "linux", "macos", "android"], arch: ["x86_64", "arm64"], brands: ["chrome", "edge", "opera", "vivaldi"] };
    expect((await stage(p, temp(), probeWith(advertised))).fingerprint.fingerprintProfileFile).toBeDefined();
    // the engine does not advertise its identity support: identity ids are accepted
    expect((await stage(p, temp(), probeWith())).fingerprint.fingerprintProfileFile).toBeDefined();
  });
  it("refuses identity ids outside the advertised identity support, and plain ids not in capabilities", async () => {
    const advertised = { os: ["windows", "linux"], arch: ["x86_64"], brands: ["chrome", "edge"], engine_family: "blink" };
    for (const id of ["os:macos", "arch:arm64", "brand:opera", "engine:gecko", "os:", "os", "brand:", "gpu.webgl2", "navigator.nope"]) {
      const p: any = v4(); p.requires = [id];
      await expect(stage(p, temp(), probeWith(advertised)), id).rejects.toMatchObject({
        code: "sdk.persona_capability_missing", message: expect.stringContaining(id) });
    }
  });
  it("refuses an engine that takes schema 4 but lists no capabilities, even for an empty requires", async () => {
    const p: any = v4(); p.requires = [];
    await expect(stage(p, temp(), probeWith({}, ["capabilities"]))).rejects.toMatchObject({ code: "sdk.persona_capability_missing" });
    expect(() => assertEngineServesRequires([], { schemas: [2, 4] })).toThrow(/does not list its capabilities/);
  });
  it("a missing capability in the incognito case leaves no temp dir behind", async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("ant0-persona-")).length;
    const p: any = v4(); p.requires = ["battery"];
    await expect(stage(p, undefined, probeWith())).rejects.toMatchObject({ code: "sdk.persona_capability_missing" });
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith("ant0-persona-")).length).toBe(before);
  });
  it("refuses a persona whose encoded file would exceed 1 MiB, before creating anything", async () => {
    const udd = join(temp(), "new-dir");
    const p: any = v4();
    p.surfaces.blob = Buffer.from(Array.from({ length: 900_000 }, (_v, i) => (i * 2654435761) >>> 24)).toString("hex");
    p.surfaces.noise = (await import("node:crypto")).randomBytes(900_000).toString("base64");
    await expect(writePersonaProfileFile(udd, p, async () => "", "linux")).rejects.toMatchObject({ code: "sdk.persona_too_large" });
    expect(existsSync(udd)).toBe(false);
    await expect(stage(p, udd, probeWith())).rejects.toMatchObject({ code: "sdk.persona_too_large" });
  });
  it("a persona just under the limit is written", async () => {
    const p: any = v4();
    p.surfaces.noise = (await import("node:crypto")).randomBytes(500_000).toString("base64");
    const path = await writePersonaProfileFile(temp(), p, async () => "", "linux");
    expect(statSync(path).size).toBeLessThanOrEqual(1 << 20);
  });
  const MSG = "the persona's brand version 158.0.4370.16 has major 158, but this engine's major is 159. " +
    "For Chrome and Edge the engine presents the brand version only when the majors match, so the page will not show it. " +
    "Use a persona issued for this engine's major.";
  it("warns, with one code and text in both SDKs, when the brand version major differs from the engine's", async () => {
    const staged = await stage(v4(), temp(), probeWith({ engine_major: 159 }));
    expect(staged.notices).toEqual([{ code: "persona-brand-version-major", message: MSG }]);
    expect((await stage(v4(), temp(), probeWith())).notices).toEqual([]);                       // 158 = 158
    // the engine compares the major for Chrome and Edge only
    for (const [id, expected] of [["chrome", 1], ["edge", 1], ["opera", 0], ["vivaldi", 0]] as const) {
      const p: any = v4(); p.identity.brand = { id, version: "158.0.4370.16" };
      expect((await stage(p, temp(), probeWith({ engine_major: 159 }))).notices, id).toHaveLength(expected);
    }
    expect((await stage(v4(), temp(), probeWith({}, ["engine_major"]))).notices).toEqual([]);  // engine major unknown
    expect(brandVersionNotice(v4(), { schemas: [2, 4], engineMajor: 159 })!.message).toBe(MSG);
  });
  it("prints the notice as a warning, and not when quiet", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      emitPersonaNotices([{ code: "persona-brand-version-major", message: MSG }], false);
      emitPersonaNotices([{ code: "persona-brand-version-major", message: MSG }], true);
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines).toEqual([`ant0-browser: warning: [persona-brand-version-major] ${MSG}\n`]);
    } finally { spy.mockRestore(); }
  });
  it("reads the persona member of a protocol 2 engine, tolerating unknown fields", async () => {
    const probe: SdkInfoProbe = async () => ({ completed: true, stdout: info([2, 4], 2, { future: { a: 1 }, brands: ["edge", 3] }) });
    const i = await enginePersonaInfo("/x/chrome", probe);
    expect(i).toMatchObject({ schemas: [2, 4], revision: 1, engineFamily: "blink", engineMajor: 158, brands: ["edge"] });
    expect(i.capabilities).toContain("gpu.webgl");
  });
  it("never lets a caller pass --ant0-persona-handle, in any spelling Chromium parses", () => {
    expect(() => assertNoReservedArgs(["--no-sandbox", "--ant0-persona-handler=1", "--x=--ant0-persona-handle"])).not.toThrow();
    for (const a of ["--ant0-persona-handle", "--ant0-persona-handle=3:abc", "-ant0-persona-handle=1", "-ant0-persona-handle",
      "--ANT0-PERSONA-HANDLE=1", "/ant0-persona-handle=1", "/Ant0-Persona-Handle", "-Ant0-Persona-Handle=1:2"])
      expect(() => assertNoReservedArgs(["--no-sandbox", a]), a).toThrowError(expect.objectContaining({ code: "sdk.launch_option_unsupported" }));
  });
});

describe("probe skips binaries that are not Ant0 engines", () => {
  const foreign = (body: string): string => {
    const path = join(temp(), "chrome");
    writeFileSync(path, `#!/bin/sh\n${body}\n`); // no capability marker
    chmodSync(path, 0o755);
    return path;
  };
  posix("a binary without the capability marker is never run and has no persona support", async () => {
    const ran = join(temp(), "ran");
    const engine = foreign(`: > '${ran}'\nexec sleep 30`);
    const t0 = Date.now();
    const r = await probeSdkInfo(engine);
    expect(r).toEqual({ completed: true, notAnt0: true, stdout: "" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(existsSync(ran)).toBe(false);
    expect(await enginePersonaSchemas(engine)).toEqual([2]);
    expect(existsSync(ran)).toBe(false);
  });
  posix("the answer is cached as a completed one, not as a timeout", async () => {
    const engine = foreign("exit 0");
    let n = 0;
    let now = 0;
    const probe: SdkInfoProbe = (e) => { n++; return probeSdkInfo(e); };
    await enginePersonaInfo(engine, probe, () => now);
    await enginePersonaInfo(engine, probe, () => now);
    expect(n).toBe(1);
    now = 60 * 1000; // past a timeout's 30 s, inside an old engine's 10 minutes
    await enginePersonaInfo(engine, probe, () => now);
    expect(n).toBe(1);
  });
  posix("a schema 4 persona is refused for it without running it", async () => {
    const ran = join(temp(), "ran");
    const engine = foreign(`: > '${ran}'`);
    await expect(stagePersonaProfile({ fingerprintProfile: v4() as any }, engine, temp(), { run: async () => "", platform: "linux" }))
      .rejects.toMatchObject({ code: "sdk.persona_requires_engine" });
    expect(existsSync(ran)).toBe(false);
  });
  posix("a missing path still goes to the spawn and is not cached", async () => {
    expect(await probeSdkInfo(join(temp(), "nope"))).toEqual({ completed: false, stdout: "" });
  });
});

describe("a probe child cannot outlive the SDK process", () => {
  const live = (): Function | undefined => process.listeners("exit").find((f) => f.name === "cleanupEverything");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 60 && !cond(); i++) await new Promise((r) => setTimeout(r, 50)); };
  posix("the exit handler kills a running probe's group and removes its dir", async () => {
    const pids = join(temp(), "pids");
    const engine = sh(`sleep 60 &\necho "$$ $!" > '${pids}'\nexec sleep 60`);
    const running = probeSdkInfo(engine, { timeoutMs: 20000 });
    await waitFor(() => existsSync(pids) && readFileSync(pids, "utf8").trim().includes(" "));
    const [leader, grandchild] = readFileSync(pids, "utf8").trim().split(" ").map(Number);
    expect(alive(leader) && alive(grandchild)).toBe(true);
    expect(live()).toBeDefined();
    live()!();                                   // what process "exit" runs
    await waitFor(() => !alive(grandchild) && !alive(leader));
    expect(alive(leader)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    await running;
  });
  posix("sweeping removes a stale probe dir and kills the probe in it, and leaves fresh and foreign dirs", async () => {
    const root = temp();
    const stale = join(root, "ant0sdk-probe-stale1");
    const fresh = join(root, "ant0sdk-probe-fresh1");
    const foreignDir = join(root, "other-dir");
    for (const d of [stale, fresh, foreignDir]) mkdirSync(d);
    const { spawn } = await import("node:child_process");
    // a child whose command line names the stale dir, as a real probe's --user-data-dir does
    const child = spawn("sh", ["-c", "sleep 60; :", `--user-data-dir=${stale}`], { detached: true, stdio: "ignore" });
    child.unref();
    const started = Date.now() - 2 * STALE_PROBE_DIR_MS;
    writeFileSync(join(stale, ".ant0-probe.json"), JSON.stringify({ pid: child.pid, startedAt: started }));
    writeFileSync(join(fresh, ".ant0-probe.json"), JSON.stringify({ pid: 1, startedAt: Date.now() }));
    // a recycled pid (a process that does not name the dir) must never be signalled
    const bystander = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    bystander.unref();
    const stale2 = join(root, "ant0sdk-probe-stale2");
    mkdirSync(stale2);
    writeFileSync(join(stale2, ".ant0-probe.json"), JSON.stringify({ pid: bystander.pid, startedAt: started }));
    try {
      const removed = sweepStaleProbeDirs([root]);
      expect(removed.sort()).toEqual([stale, stale2].sort());
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(foreignDir)).toBe(true);
      await waitFor(() => !alive(child.pid!));
      expect(alive(child.pid!)).toBe(false);
      expect(alive(bystander.pid!)).toBe(true);
    } finally { try { process.kill(bystander.pid!, "SIGKILL"); } catch { /* gone */ } try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
});

describe("sweeping abandoned probe dirs", () => {
  const OLD = () => Date.now() - 2 * STALE_PROBE_DIR_MS;
  const aged = (dir: string) => { const t = new Date(OLD()); utimesSync(dir, t, t); };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("new probe dirs carry the distinctive prefix and exactly the shape the sweep recognises", () => {
    const dir = makeProbeDir();
    try {
      expect(PROBE_DIR_PREFIX).toBe("ant0sdk-probe-");
      expect(basename(dir)).toMatch(/^ant0sdk-probe-[A-Za-z0-9]{6}$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("never touches an unrelated directory, old or not, with or without the prefix", () => {
    const root = temp();
    const names = ["ant0-probe-cache-keep", "ant0-probe-abc123", "ant0sdk-probe-cache-keep", "ant0sdk-probe-abc12", "ant0sdk-probe-abc1234", "ant0sdk-probe-abc-12"];
    for (const n of names) { mkdirSync(join(root, n)); writeFileSync(join(root, n, "keep.txt"), "x"); aged(join(root, n)); }
    expect(sweepStaleProbeDirs([root])).toEqual([]);
    for (const n of names) expect(existsSync(join(root, n, "keep.txt"))).toBe(true);
  });
  it("never sweeps a recorded old dir without the exact prefix (`ant0-probe-*` of earlier SDKs is left to the OS)", () => {
    const root = temp();
    const names = ["ant0-probe-abcd12", "ant0-probe-recorded", "ant0sdk-probe", "ant0sdk-prob-abcd12", "xant0sdk-probe-abcd12", "Ant0sdk-probe-abcd12"];
    for (const n of names) {
      mkdirSync(join(root, n));
      writeFileSync(join(root, n, "keep.txt"), "x");
      writeFileSync(join(root, n, ".ant0-probe.json"), JSON.stringify({ pid: 2 ** 22 + 1, startedAt: OLD() }));
      aged(join(root, n));
    }
    expect(sweepStaleProbeDirs([root])).toEqual([]);
    for (const n of names) expect(existsSync(join(root, n, "keep.txt"))).toBe(true);
  });
  it("removes an old unrecorded dir of exactly the mkdtemp shape, and not a young one", () => {
    const root = temp();
    const old = join(root, "ant0sdk-probe-Ab3xYz");
    const young = join(root, "ant0sdk-probe-Zz9yXw");
    mkdirSync(old); mkdirSync(young); aged(old);
    expect(sweepStaleProbeDirs([root])).toEqual([old]);
    expect(existsSync(young)).toBe(true);
  });
  it("removes a recorded old dir whatever its name, but only with the prefix", () => {
    const root = temp();
    const recorded = join(root, "ant0sdk-probe-recorded-by-us");
    mkdirSync(recorded);
    writeFileSync(join(recorded, ".ant0-probe.json"), JSON.stringify({ pid: 2 ** 22 + 1, startedAt: OLD() }));
    expect(sweepStaleProbeDirs([root])).toEqual([recorded]);
  });
  posix("a recorded pid of 0 or below is never signalled (a negative group id would hit a whole group)", () => {
    const root = temp();
    const dirOf = new Map<number, string>();
    for (const pid of [0, -1, -5]) {
      const dir = join(root, `ant0sdk-probe-pid${Math.abs(pid)}-${-pid}`.slice(0, 20));
      mkdirSync(dir);
      writeFileSync(join(dir, ".ant0-probe.json"), JSON.stringify({ pid, startedAt: OLD() }));
      dirOf.set(pid, dir);
    }
    // even if such a "process" claimed to run the probe (/proc/<pid>/cmdline naming its dir)
    procCmdline = (path) => {
      const m = /^\/proc\/(-?\d+)\/cmdline$/.exec(path);
      const dir = m ? dirOf.get(Number(m[1])) : undefined;
      return dir === undefined ? undefined : `sh\0--user-data-dir=${dir}\0`;
    };
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as any);
    try {
      expect(sweepStaleProbeDirs([root])).toHaveLength(3);
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
  it("leaves a directory owned by someone else alone", () => {
    if (typeof process.getuid !== "function") return;
    const root = temp();
    const dir = join(root, "ant0sdk-probe-Own3rX");
    mkdirSync(dir); aged(dir);
    expect(sweepStaleProbeDirs([root], Date.now(), process.getuid() + 1)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(sweepStaleProbeDirs([root], Date.now(), process.getuid())).toEqual([dir]);
  });
  posix("signals the recorded process only when its argument is exactly --user-data-dir=<dir>", async () => {
    const root = temp();
    const dir = join(root, "ant0sdk-probe-Exact1");
    mkdirSync(dir);
    const { spawn } = await import("node:child_process");
    // names the dir only as a prefix of a longer argument, so it is not this probe
    const lookalike = spawn("sh", ["-c", "sleep 60; :", `--user-data-dir=${dir}-other`], { detached: true, stdio: "ignore" });
    lookalike.unref();
    writeFileSync(join(dir, ".ant0-probe.json"), JSON.stringify({ pid: lookalike.pid, startedAt: OLD() }));
    try {
      expect(sweepStaleProbeDirs([root])).toEqual([dir]);
      await new Promise((r) => setTimeout(r, 300)); // a killed child is reaped asynchronously
      expect(alive(lookalike.pid!)).toBe(true);
    } finally { try { process.kill(-lookalike.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
});

describe("killProbeTree on Windows", () => {
  const onWin32 = async (body: () => Promise<void>) => {
    const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try { await body(); } finally { Object.defineProperty(process, "platform", desc); }
  };
  const fakeChild = () => ({ pid: 4242, kill: vi.fn() }) as any;
  it("waits for taskkill to finish, then kills the leader", async () => {
    await onWin32(async () => {
      const tk = new EventEmitter();
      taskkillHook = () => tk;
      const child = fakeChild();
      let done = false;
      const p = killProbeTree(child, 5000).then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 30));
      expect(child.kill).not.toHaveBeenCalled();
      expect(done).toBe(false);
      tk.emit("exit", 0);
      await p;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });
  it("goes on after the bound when taskkill hangs, and after an error", async () => {
    await onWin32(async () => {
      taskkillHook = () => new EventEmitter(); // never exits
      const slow = fakeChild();
      const t0 = Date.now();
      await killProbeTree(slow, 80);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
      expect(slow.kill).toHaveBeenCalledTimes(1);
      const failing = new EventEmitter();
      taskkillHook = () => { queueMicrotask(() => failing.emit("error", new Error("ENOENT"))); return failing; };
      const child = fakeChild();
      await killProbeTree(child, 5000);
      expect(child.kill).toHaveBeenCalledTimes(1);
    });
  });
});

describe("an unreadable binary is not taken for a foreign one", () => {
  it("isAnt0Binary throws on a read error instead of answering false", () => {
    const dir = temp(); // opening a directory succeeds, reading it fails (EISDIR): a read error
    expect(() => isAnt0Binary(dir)).toThrow();
  });
  it("the probe does not answer notAnt0 for it (the spawn decides), so nothing is cached as a completed old engine", async () => {
    const dir = temp();
    const r = await probeSdkInfo(dir);
    expect(r).not.toHaveProperty("notAnt0");
    expect(r.completed).toBe(false);
    let n = 0;
    const probe: SdkInfoProbe = (e) => { n++; return probeSdkInfo(e); };
    await enginePersonaInfo(dir, probe, () => 0);
    await enginePersonaInfo(dir, probe, () => 0);
    expect(n).toBe(2);
  });
});

describe("process hooks are released after a probe", () => {
  posix("a finished probe leaves no exit or signal listener behind", async () => {
    const saved = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM"), exit: process.listenerCount("exit") };
    process.removeAllListeners("SIGINT"); process.removeAllListeners("SIGTERM");
    try {
      const r = await probeSdkInfo(fakeEngine(info([2, 4])));
      expect(r.completed).toBe(true);
      expect(process.listenerCount("SIGINT")).toBe(0);
      expect(process.listenerCount("SIGTERM")).toBe(0);
    } finally {
      for (const l of saved.SIGINT) process.on("SIGINT", l as any);
      for (const l of saved.SIGTERM) process.on("SIGTERM", l as any);
    }
  });
});

describe("library signal handlers never change the host's signal behaviour", () => {
  const posix2 = process.platform === "win32" ? it.skip : it;
  const probe: SdkInfoProbe = async () => ({ completed: true, stdout: info([2, 4]) });
  const stage = () => stagePersonaProfile({ fingerprintProfile: v4() as any }, "/x/chrome", undefined, { probe, run: async () => "", platform: "linux" });
  // Run with the host's own listeners set aside, so what the library adds is all there is.
  const isolated = async (signal: "SIGINT" | "SIGTERM", body: () => Promise<void>) => {
    const saved = process.listeners(signal);
    process.removeAllListeners(signal);
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as any);
    try { await body(); } finally {
      kill.mockRestore();
      process.removeAllListeners(signal);
      for (const l of saved) process.on(signal, l as any);
    }
  };
  posix2("an idle SDK has no signal listeners, and a staged persona adds them only while it needs cleaning", async () => {
    await isolated("SIGTERM", async () => {
      expect(process.listenerCount("SIGTERM")).toBe(0);
      const staged = await stage();
      expect(process.listenerCount("SIGTERM")).toBe(1);
      staged.cleanup();
      expect(process.listenerCount("SIGTERM")).toBe(0);
    });
  });
  posix2("with no other listener: cleans up, removes itself and re-raises the signal", async () => {
    await isolated("SIGTERM", async () => {
      const staged = await stage();
      const dir = dirname(staged.fingerprint.fingerprintProfileFile!);
      process.emit("SIGTERM" as any);
      expect(existsSync(dir)).toBe(false);
      expect(process.kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(process.listenerCount("SIGTERM")).toBe(0);
    });
  });
  posix2("with another listener: cleans up, does not re-raise, and the other listener runs", async () => {
    await isolated("SIGINT", async () => {
      const other = vi.fn();
      process.on("SIGINT", other);
      const staged = await stage();
      const dir = dirname(staged.fingerprint.fingerprintProfileFile!);
      process.emit("SIGINT" as any);
      expect(existsSync(dir)).toBe(false);
      expect(other).toHaveBeenCalledTimes(1);
      expect(process.kill).not.toHaveBeenCalled();
      expect(process.listenerCount("SIGINT")).toBe(1);    // only the host's own listener is left
    });
  });
});

describe("a leading byte order mark in --ant0-sdk-info output", () => {
  it("is ignored, as in the Python SDK", () => {
    expect(parseSdkInfoSchemas("\uFEFF" + info([2, 4]))).toEqual([2, 4]);
    expect(parseSdkInfoSchemas("\uFEFFbanner\n" + info([2, 4]) + "\n")).toEqual([2, 4]);
  });
});
