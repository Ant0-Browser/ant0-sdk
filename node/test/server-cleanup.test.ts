// Server / serve() cleanup contract: one exit listener, SIGTERM-then-SIGKILL close, exit-time cleanup
// of SDK-created temp dirs only, and no signal handlers. Exit behaviour is tested in real child
// processes running the bundled SDK (an 'exit' listener cannot be observed from inside the test).

import { spawn, spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "../src/index.js";
import { EXIT_DIR_BUDGET_MS, EXIT_TOTAL_BUDGET_MS, runExitCleanup, sleepSync, type ExitOps, type Tracked } from "../src/cleanup.js";

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
let bundle: string;
const isWin = process.platform === "win32";

beforeAll(() => {
  // Inside node_modules so the bundle resolves playwright-core and the other externals.
  const out = join(here, "../node_modules/.ant0-test-bundle");
  mkdirSync(out, { recursive: true });
  roots.push(out);
  bundle = join(out, "sdk.mjs");
  buildSync({ entryPoints: [join(here, "../src/index.ts")], bundle: true, platform: "node", format: "esm",
    packages: "external", outfile: bundle, logLevel: "silent" });
});
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const waitSpawn = (c: ReturnType<typeof sleeper>) => new Promise((r) => c.once("spawn", r));
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) { for (let t = 0; t < ms && !cond(); t += 50) await sleepMs(50); }

/** Run `body` (ESM, top-level await) in a child node with the bundled SDK; returns stdout JSON. */
function child(body: string, env: Record<string, string> = {}) {
  const dir = temp("ant0-harness-");
  const file = join(dir, "h.mjs");
  writeFileSync(file, `import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const sdk = await import(${JSON.stringify(bundle)});
const { Server } = sdk;
const warnings = []; process.on("warning", (w) => warnings.push(w.name));
const mk = async () => { const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((r) => c.once("spawn", r)); return c; };
${body}`);
  const r = spawnSync(process.execPath, [file], { env: { ...process.env, TMPDIR: dir, ...env }, encoding: "utf8", timeout: 20000 });
  const last = r.stdout.trim().split("\n").pop() ?? "";
  if (r.status !== 0 && process.env.H_DEBUG) console.log(r.stderr);
  return { dir, status: r.status, signal: r.signal, stderr: r.stderr, out: last ? JSON.parse(last) : {} };
}

describe("Server cleanup registry", () => {
  it("srv.close() without await + process.exit() still stops the child and removes the temp dir", async () => {
    const r = child(`
      const d = mkdtempSync(join(process.env.TMPDIR, "ant0-browser-serve-")); const c = await mk();
      const srv = new Server(c, "127.0.0.1", 9222, d, true);
      srv.close(); console.log(JSON.stringify({ pid: c.pid, d })); process.exit(0);`);
    expect(r.status).toBe(0);
    await until(() => !alive(r.out.pid));
    expect(alive(r.out.pid)).toBe(false);
    expect(existsSync(r.out.d)).toBe(false);
  });

  it.skipIf(isWin)("a caller-supplied persistent profile dir survives exit (marker file kept) and the browser gets SIGTERM, not SIGKILL", async () => {
    const r = child(`
      const d = mkdtempSync(join(process.env.TMPDIR, "persistent-profile-")); writeFileSync(join(d, "marker"), "keep");
      // A "browser" that flushes into the profile dir when it is asked to terminate gracefully.
      const script = 'process.on("SIGTERM", () => { require("fs").writeFileSync(' + JSON.stringify(join(d, "flushed")) + ', "1"); process.exit(0); }); setInterval(() => {}, 1000);';
      const c = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
      await new Promise((r) => c.once("spawn", r)); await new Promise((r) => setTimeout(r, 300));
      new Server(c, "127.0.0.1", 9222, d, false);
      console.log(JSON.stringify({ pid: c.pid, d })); process.exit(0);`);
    await until(() => !alive(r.out.pid));
    expect(alive(r.out.pid)).toBe(false);
    expect(readFileSync(join(r.out.d, "marker"), "utf8")).toBe("keep");
    await until(() => existsSync(join(r.out.d, "flushed")));
    expect(existsSync(join(r.out.d, "flushed"))).toBe(true);     // SIGTERM handler ran: graceful
  });

  it.skipIf(isWin)("the exit hook SIGKILLs a temp dir's browser: a child that rewrites its dir on SIGTERM cannot resurrect it", async () => {
    // Chromium writes "Local State" back into its profile during a graceful shutdown. Model that: on
    // SIGTERM the child recreates the dir and a file in it. With SIGTERM at exit the dir survives.
    const r = child(`
      const d = mkdtempSync(join(process.env.TMPDIR, "ant0-browser-serve-"));
      const script = 'process.on("SIGTERM", () => { setTimeout(() => { const fs = require("fs"); fs.mkdirSync(' + JSON.stringify(d) + ', { recursive: true }); fs.writeFileSync(' + JSON.stringify(join(d, "Local State")) + ', "{}"); process.exit(0); }, 100); }); setInterval(() => {}, 1000);';
      const c = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
      await new Promise((r) => c.once("spawn", r)); await new Promise((r) => setTimeout(r, 300));
      new Server(c, "127.0.0.1", 9222, d, true);
      console.log(JSON.stringify({ pid: c.pid, d })); process.exit(0);`);
    await until(() => !alive(r.out.pid));
    await sleepMs(500);                       // long enough for a SIGTERM handler to have rewritten the dir
    expect(alive(r.out.pid)).toBe(false);
    expect(existsSync(r.out.d)).toBe(false);
  });

  it("20 servers add exactly one exit listener, raise no MaxListeners warning, and none stay after close", async () => {
    const r = child(`
      const before = process.listenerCount("exit"); const sigs = ["SIGINT","SIGTERM","SIGHUP"].map((s) => process.listenerCount(s));
      const servers = [];
      for (let i = 0; i < 20; i++) servers.push(new Server(await mk(), "127.0.0.1", 9222, "/nonexistent", false));
      const during = process.listenerCount("exit");
      const sigsDuring = ["SIGINT","SIGTERM","SIGHUP"].map((s) => process.listenerCount(s));
      await Promise.all(servers.map((s) => s.close()));
      await new Promise((r) => setTimeout(r, 50));
      console.log(JSON.stringify({ delta: during - before, after: process.listenerCount("exit") - before, warnings,
        sigDelta: sigsDuring.map((n, i) => n - sigs[i]) }));`);
    expect(r.out.delta).toBe(1);
    expect(r.out.after).toBe(0);
    expect(r.out.warnings).toEqual([]);
    expect(r.out.sigDelta).toEqual([0, 0, 0]);   // no signal handlers: the library does not own the signals
  });

  it("in-process: 20 servers add at most one exit listener", async () => {
    const before = process.listenerCount("exit");
    const kids = await Promise.all(Array.from({ length: 20 }, async () => { const c = sleeper(); await waitSpawn(c); return c; }));
    const servers = kids.map((c) => new Server(c, "127.0.0.1", 9222, "/nonexistent", false));
    expect(process.listenerCount("exit") - before).toBe(1);
    await Promise.all(servers.map((s) => s.close()));
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("close() removes a temp dir it owns but never a caller-supplied one", async () => {
    const own = temp("ant0-browser-serve-"), theirs = temp("ant0-udd-");
    for (const [d, owned] of [[own, true], [theirs, false]] as const) {
      const c = sleeper(); await waitSpawn(c);
      await new Server(c, "127.0.0.1", 9222, d, owned).close();
    }
    expect(existsSync(own)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });

  it.skipIf(isWin)("exit cleanup does not send a second SIGTERM to a caller-dir browser that close() already signalled", async () => {
    const dir = temp("ant0-udd-"), log = join(dir, "terms");
    const script = `const fs = require("fs"); process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(log)}, "T"); setTimeout(() => process.exit(0), 600); });
      setInterval(() => {}, 1000); fs.writeFileSync(${JSON.stringify(join(dir, "ready"))}, "1");`;
    const c = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    await waitSpawn(c);
    await until(() => existsSync(join(dir, "ready")));
    const srv = new Server(c, "127.0.0.1", 9222, dir, false);
    const closing = srv.close();                  // not awaited: close(); process.exit() style
    runExitCleanup([{ proc: c }]);                // what the exit hook does right after
    await closing;
    expect(readFileSync(log, "utf8")).toBe("T");  // exactly one SIGTERM
  });

  it.skipIf(isWin)("close() sends SIGTERM and waits for a graceful exit; no SIGKILL while the child is shutting down", async () => {
    const dir = temp("ant0-grace-");
    const script = `process.on("SIGTERM", () => { require("fs").writeFileSync(${JSON.stringify(join(dir, "term"))}, "1");
      setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(join(dir, "flushed"))}, "1"); process.exit(0); }, 400); });
      setInterval(() => {}, 1000);`;
    const c = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    await waitSpawn(c);
    await sleepMs(150);
    await new Server(c, "127.0.0.1", 9222, "/nonexistent", false, 5000).close();
    expect(existsSync(join(dir, "flushed"))).toBe(true);   // the write after SIGTERM completed
    expect(c.signalCode).toBeNull();
    expect(c.exitCode).toBe(0);
  });

  it.skipIf(isWin)("falls back to SIGKILL only after the grace period when SIGTERM is ignored", async () => {
    const dir = temp("ant0-stubborn-");
    const script = `process.on("SIGTERM", () => { require("fs").writeFileSync(${JSON.stringify(join(dir, "term"))}, "1"); });
      setInterval(() => {}, 1000);`;
    const c = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    await waitSpawn(c);
    await sleepMs(150);
    const t0 = Date.now();
    await new Server(c, "127.0.0.1", 9222, "/nonexistent", false, 400).close();
    expect(existsSync(join(dir, "term"))).toBe(true);       // SIGTERM came first
    expect(c.signalCode).toBe("SIGKILL");                     // then the fallback
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);      // ...not before the grace period
  });
});

describe.skipIf(isWin)("serve() startup registration", () => {
  /** A fake engine: carries the capability marker, records its pid, and never opens a CDP port. */
  const fakeEngine = () => {
    const d = temp("ant0-fake-engine-");
    const exe = join(d, "chrome");
    writeFileSync(exe, `#!/bin/sh\necho $$ > "${join(d, "pid")}"\nexec sleep 60\n# ant0-browser-capabilities/persona-profile-v1\n`);
    chmodSync(exe, 0o755);
    return { exe, pidFile: join(d, "pid") };
  };
  const opts = (exe: string, extra = "") =>
    `{ executablePath: ${JSON.stringify(exe)}, identity: { mode: "native" }, quiet: true, launchTicket: false, ${extra} }`;

  it("a failed readiness wait stops the child and removes the temp profile dir", async () => {
    const { exe, pidFile } = fakeEngine();
    const r = child(`
      let msg = ""; try { await sdk.serve(${opts(exe, "readyTimeoutMs: 600")}); } catch (e) { msg = String(e.message); }
      console.log(JSON.stringify({ msg }));`);
    expect(r.out.msg).toMatch(/did not come up/);
    expect(readdirSync(r.dir).filter((n) => n.startsWith("ant0-browser-serve-"))).toEqual([]);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });

  it("a process exit DURING the readiness wait still stops the child and removes the temp dir", async () => {
    const { exe, pidFile } = fakeEngine();
    const r = child(`
      void sdk.serve(${opts(exe, "readyTimeoutMs: 30000")}).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      console.log(JSON.stringify({ dirs: (await import("node:fs")).readdirSync(process.env.TMPDIR).filter((n) => n.startsWith("ant0-browser-serve-")) }));
      process.exit(0);`);
    expect(r.out.dirs).toHaveLength(1);                       // the control: the dir did exist at exit
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    expect(readdirSync(r.dir).filter((n) => n.startsWith("ant0-browser-serve-"))).toEqual([]);
  });
});

describe("exit-hook budget", () => {
  const realSleep = (ms: number) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
  const entries = (n: number): Tracked[] => Array.from({ length: n }, (_, i) => (
    { proc: { exitCode: 0, signalCode: null, kill() {} } as never, ownDir: `/nonexistent/stuck-${i}` }));
  const stuck = (calls: { n: number }): ExitOps => ({
    rm: () => { calls.n++; throw new Error("EBUSY"); },     // a dir that can never be removed
    exists: () => true,
    sleep: realSleep,
    now: Date.now,
  });

  it("gives up on one undeletable dir after about 1 s, sleeping between tries (no busy loop)", () => {
    const calls = { n: 0 };
    const t0 = Date.now();
    runExitCleanup(entries(1), stuck(calls));
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(EXIT_DIR_BUDGET_MS - 100);
    expect(took).toBeLessThan(EXIT_DIR_BUDGET_MS + 600);
    expect(calls.n).toBeGreaterThan(2);
    expect(calls.n).toBeLessThan(60);                       // a spin loop would make thousands of calls
  });

  it("stays within about 3 s across many undeletable dirs", () => {
    const t0 = Date.now();
    runExitCleanup(entries(6), stuck({ n: 0 }));
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(EXIT_TOTAL_BUDGET_MS - 200);
    expect(took).toBeLessThan(EXIT_TOTAL_BUDGET_MS + 600);
  });

  it("the real sleepSync blocks without burning CPU", () => {
    const cpu0 = process.cpuUsage(), t0 = Date.now();
    sleepSync(100);
    const wall = Date.now() - t0, cpu = process.cpuUsage(cpu0);
    expect(wall).toBeGreaterThanOrEqual(90);
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(wall / 3);
  });

  it("a removable dir costs no waiting", () => {
    const d = temp("ant0-browser-serve-");
    const t0 = Date.now();
    runExitCleanup([{ proc: { exitCode: 0, signalCode: null, kill() {} } as never, ownDir: d }]);
    expect(existsSync(d)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(300);
  });
});

describe.skipIf(isWin)("serve() success path", () => {
  it("leaves no exit listener or temp dir behind after a successful serve() + close()", async () => {
    const d = temp("ant0-fake-cdp-");
    const exe = join(d, "chrome");
    writeFileSync(exe, `#!${process.execPath}
const port = Number(process.argv.find((a) => a.startsWith("--remote-debugging-port=")).split("=")[1]);
require("http").createServer((q, r) => r.end("{}")).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
// ant0-browser-capabilities/persona-profile-v1
`);
    chmodSync(exe, 0o755);
    const r = child(`
      const before = process.listenerCount("exit");
      const srv = await sdk.serve({ executablePath: ${JSON.stringify(exe)}, identity: { mode: "native" }, quiet: true, launchTicket: false });
      const during = process.listenerCount("exit") - before;
      await srv.close();
      console.log(JSON.stringify({ during, after: process.listenerCount("exit") - before,
        dirs: (await import("node:fs")).readdirSync(process.env.TMPDIR).filter((n) => n.startsWith("ant0-browser-serve-")) }));`);
    expect(r.out.during).toBe(1);
    expect(r.out.after).toBe(0);      // the in-flight launch entry was released when the Server took over
    expect(r.out.dirs).toEqual([]);
  });
});
