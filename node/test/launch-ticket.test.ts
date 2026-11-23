// Engine launch ticket: daemon discovery, ticket fetch with a mock ant0d, the
// `--ant0-launch=` wiring through launchPlan(), and the exit-90 mapping in serve().

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCH_TICKET_EXIT_CODE,
  LAUNCH_TICKET_REJECTED_CODE,
  LaunchTicketRejectedError,
  LaunchTicketUnavailableError,
  discoverDaemon,
  fetchLaunchTicket,
  hasLaunchTicketArg,
  inferEngineVersion,
  launchPlan,
  launchTicketRejection,
  resolveDaemonHome,
  resolveLaunchTicketArgs,
  serve,
  installedEngineVersion,
} from "../src/index.js";

const MARKER = "ant0-browser-capabilities/persona-profile-v1";
const ENGINE = "149.0.7827.114-ant0.1";
// Shape only (five base64url segments); the mock daemon never verifies it.
const TICKET = "eyJraWQiOiJsaWMtdGVzdCIsInYiOjF9.eyJkZXYiOiJ4In0.c2ln.eyJlbmciOiIxNDkifQ.Y3NpZw";

const roots: string[] = [];
const temp = (prefix = "ant0-ticket-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake install in the daemon's layout: <base>/<version>/browser/chrome + .release.json. */
function fakeInstall(version = ENGINE, withReleaseJson = true): string {
  const base = join(temp(), version);
  mkdirSync(join(base, "browser"), { recursive: true });
  const exe = join(base, "browser", process.platform === "win32" ? "chrome.exe" : "chrome");
  writeFileSync(exe, Buffer.concat([Buffer.alloc(64, "x"), Buffer.from(MARKER)]));
  if (withReleaseJson) writeFileSync(join(base, ".release.json"), JSON.stringify({ version, chromium: "149.0.7827.114" }));
  return exe;
}

// ------------------------------------------------------------------ mock ant0d
interface Seen { url: string; auth: string | undefined }
let server: HttpServer;
let baseUrl: string;
const seen: Seen[] = [];
let mode: "ok" | "licence.required" | "hang" | "garbage" = "ok";

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.headers.authorization !== "Bearer tok-123") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "auth.invalid", message: "bad token" } }));
      return;
    }
    if (mode === "hang") return; // never answers; the client must time out
    if (mode === "licence.required") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "licence.required", message: "sign in to start profiles" } }));
      return;
    }
    if (mode === "garbage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ launch: "not.a.ticket" }));
      return;
    }
    const engine = new URL(req.url ?? "/", "http://x").searchParams.get("engine");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ launch: TICKET, engine, expires_at: "2027-01-15T08:15:05.000Z" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  seen.length = 0;
  mode = "ok";
});

const envWith = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, ...extra });

// ------------------------------------------------------------------ discovery
describe("discoverDaemon", () => {
  it("prefers ANT0_URL + ANT0_TOKEN and strips a trailing slash", () => {
    expect(discoverDaemon(envWith({ ANT0_URL: "http://127.0.0.1:4444/", ANT0_TOKEN: "t" }), "linux", "/nohome"))
      .toEqual({ baseUrl: "http://127.0.0.1:4444", token: "t" });
  });

  it("reads ant0d.pid and ant0d.token from ANT0_HOME like the CLI", () => {
    const home = temp("ant0-home-");
    writeFileSync(join(home, "ant0d.pid"), JSON.stringify({ pid: 1, port: 27555, started_at: "x" }));
    writeFileSync(join(home, "ant0d.token"), "tok-123\n");
    expect(discoverDaemon(envWith({ ANT0_HOME: home }), "linux", "/nohome"))
      .toEqual({ baseUrl: "http://127.0.0.1:27555", token: "tok-123" });
  });

  it("ignores a non-loopback host in the pid file and falls back to ANT0D_PORT / 27100", () => {
    const home = temp("ant0-home-");
    writeFileSync(join(home, "ant0d.pid"), JSON.stringify({ pid: 1, port: 1, host: "evil.example" }));
    writeFileSync(join(home, "ant0d.token"), "tok");
    expect(discoverDaemon(envWith({ ANT0_HOME: home }), "linux", "/nohome")?.baseUrl).toBe("http://127.0.0.1:1");
    rmSync(join(home, "ant0d.pid"));
    expect(discoverDaemon(envWith({ ANT0_HOME: home, ANT0D_PORT: "28000" }), "linux", "/nohome")?.baseUrl)
      .toBe("http://127.0.0.1:28000");
    expect(discoverDaemon(envWith({ ANT0_HOME: home }), "linux", "/nohome")?.baseUrl).toBe("http://127.0.0.1:27100");
  });

  it("returns undefined without a token (daemon not running)", () => {
    const home = temp("ant0-home-");
    expect(discoverDaemon(envWith({ ANT0_HOME: home }), "linux", "/nohome")).toBeUndefined();
    expect(discoverDaemon(envWith({ ANT0_URL: "http://127.0.0.1:1" }), "linux", "/nohome")).toBeUndefined();
  });

  it("resolves the platform data folder and keeps a populated legacy ~/.ant0", () => {
    const userHome = temp("ant0-user-");
    // The simulated target, not the test host, determines the returned separator.
    expect(resolveDaemonHome(envWith({}), "linux", userHome)).toBe(posix.join(userHome, ".local", "share", "ant0"));
    expect(resolveDaemonHome(envWith({ XDG_DATA_HOME: "/xdg" }), "linux", userHome)).toBe("/xdg/ant0");
    expect(resolveDaemonHome(envWith({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }), "win32", "C:\\Users\\u"))
      .toBe("C:\\Users\\u\\AppData\\Local\\Ant0");
    mkdirSync(join(userHome, ".ant0", "profiles"), { recursive: true });
    expect(resolveDaemonHome(envWith({}), "linux", userHome)).toBe(posix.join(userHome, ".ant0"));
  });
});

describe("inferEngineVersion", () => {
  it("reads .release.json above browser/, else the version path component, else the env", () => {
    expect(inferEngineVersion(fakeInstall(), envWith({}))).toBe(ENGINE);
    expect(inferEngineVersion(fakeInstall("149.0.7827.114-ant0.7", false), envWith({}))).toBe("149.0.7827.114-ant0.7");
    const bare = join(temp(), "chrome");
    writeFileSync(bare, MARKER);
    expect(inferEngineVersion(bare, envWith({}))).toBeUndefined();
    expect(inferEngineVersion(bare, envWith({ ANT0_BROWSER_ENGINE_VERSION: ENGINE }))).toBe(ENGINE);
    expect(inferEngineVersion(bare, envWith({ ANT0_BROWSER_ENGINE_VERSION: "149.0.7827.114" }))).toBeUndefined();
  });
});

// ------------------------------------------------------------------ fetch
describe("fetchLaunchTicket", () => {
  it("GETs /v1/licence/ticket?engine= with the bearer token and returns `launch`", async () => {
    const launch = await fetchLaunchTicket(ENGINE, { baseUrl, token: "tok-123" });
    expect(launch).toBe(TICKET);
    expect(seen).toEqual([{ url: `/v1/licence/ticket?engine=${encodeURIComponent(ENGINE)}`, auth: "Bearer tok-123" }]);
  });

  it("surfaces the daemon's error envelope code", async () => {
    mode = "licence.required";
    const err = await fetchLaunchTicket(ENGINE, { baseUrl, token: "tok-123" }).catch((e) => e);
    expect(err).toBeInstanceOf(LaunchTicketUnavailableError);
    expect((err as LaunchTicketUnavailableError).code).toBe("licence.required");
    const unauthorized = await fetchLaunchTicket(ENGINE, { baseUrl, token: "nope" }).catch((e) => e);
    expect((unauthorized as LaunchTicketUnavailableError).code).toBe("auth.invalid");
  });

  it("rejects a response without a five-segment launch, and times out", async () => {
    mode = "garbage";
    const bad = await fetchLaunchTicket(ENGINE, { baseUrl, token: "tok-123" }).catch((e) => e);
    expect((bad as LaunchTicketUnavailableError).code).toBe("bad_response");
    mode = "hang";
    const slow = await fetchLaunchTicket(ENGINE, { baseUrl, token: "tok-123" }, { timeoutMs: 50 }).catch((e) => e);
    expect((slow as Error).name).toBe("AbortError");
  });
});

// ------------------------------------------------------------------ resolution
describe("resolveLaunchTicketArgs", () => {
  const daemonEnv = () => envWith({ ANT0_URL: baseUrl, ANT0_TOKEN: "tok-123" });

  it("passes an explicit ticket through and validates its shape", async () => {
    const exe = fakeInstall();
    expect(await resolveLaunchTicketArgs({ launchTicket: TICKET, executable: exe, args: [] })).toEqual([`--ant0-launch=${TICKET}`]);
    await expect(resolveLaunchTicketArgs({ launchTicket: "a.b.c", executable: exe, args: [] })).rejects.toThrow(/five-segment/);
    expect(seen).toHaveLength(0);
  });

  it("does nothing when disabled or when the caller already passed the switch", async () => {
    const exe = fakeInstall();
    expect(await resolveLaunchTicketArgs({ launchTicket: false, executable: exe, args: [], env: daemonEnv() })).toEqual([]);
    expect(await resolveLaunchTicketArgs({ executable: exe, args: ["--ant0-launch=x.y.z.w.v"], env: daemonEnv() })).toEqual([]);
    expect(hasLaunchTicketArg(["--foo", "--ant0-launch=x"])).toBe(true);
    expect(hasLaunchTicketArg(["--ant0-launch-other=x"])).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("fetches from the daemon for the inferred engine version", async () => {
    const exe = fakeInstall();
    const args = await resolveLaunchTicketArgs({ executable: exe, args: [], env: daemonEnv(), quiet: true });
    expect(args).toEqual([`--ant0-launch=${TICKET}`]);
    expect(seen[0]?.url).toContain(`engine=${encodeURIComponent(ENGINE)}`);
  });

  it("uses an explicit engineVersion over the inferred one", async () => {
    const exe = fakeInstall();
    await resolveLaunchTicketArgs({ executable: exe, args: [], env: daemonEnv(), quiet: true, engineVersion: "149.0.7827.114-ant0.9" });
    expect(seen[0]?.url).toContain("engine=149.0.7827.114-ant0.9");
  });

  it("launches without a ticket when there is no version, no daemon, or the daemon refuses", async () => {
    const bare = join(temp(), "chrome");
    writeFileSync(bare, MARKER);
    expect(await resolveLaunchTicketArgs({ executable: bare, args: [], env: daemonEnv(), quiet: true })).toEqual([]);
    expect(seen).toHaveLength(0); // nothing to bind a ticket to -> no request
    const exe = fakeInstall();
    expect(await resolveLaunchTicketArgs({ executable: exe, args: [], env: envWith({ ANT0_HOME: temp() }), quiet: true })).toEqual([]);
    mode = "licence.required";
    expect(await resolveLaunchTicketArgs({ executable: exe, args: [], env: daemonEnv(), quiet: true })).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ launchPlan / serve
describe("launchPlan with a ticket", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["ANT0_URL", "ANT0_TOKEN", "ANT0_HOME"]) saved[k] = process.env[k];
    process.env.ANT0_URL = baseUrl;
    process.env.ANT0_TOKEN = "tok-123";
    delete process.env.ANT0_HOME;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("puts the fetched ticket last before the start URLs", async () => {
    const exe = fakeInstall();
    const udd = temp("ant0-udd-");
    const plan = await launchPlan({ executablePath: exe, identity: { mode: "native" }, quiet: true, userDataDir: udd });
    const i = plan.args.indexOf(`--ant0-launch=${TICKET}`);
    expect(i).toBeGreaterThan(0);
    expect(plan.args.slice(i)).toEqual([`--ant0-launch=${TICKET}`, "about:blank"]);
    expect(plan.args.filter((a) => a.startsWith("--ant0-launch=")).length).toBe(1);
  });

  it("keeps a ticket the caller (ant0d) put in args and never fetches a second one", async () => {
    const exe = fakeInstall();
    const udd = temp("ant0-udd-");
    const plan = await launchPlan({
      executablePath: exe, identity: { mode: "native" }, quiet: true, userDataDir: udd,
      args: ["--ant0-launch=a.b.c.d.e", "https://example.com/"],
    });
    expect(plan.args.filter((a) => a.startsWith("--ant0-launch=")).length).toBe(1);
    expect(plan.args).toContain("--ant0-launch=a.b.c.d.e");
    expect(seen).toHaveLength(0);
  });

  it("launchTicket: false / an explicit ticket skip the daemon", async () => {
    const exe = fakeInstall();
    const udd = temp("ant0-udd-");
    const off = await launchPlan({ executablePath: exe, identity: { mode: "native" }, quiet: true, userDataDir: udd, launchTicket: false });
    expect(off.args.some((a) => a.startsWith("--ant0-launch="))).toBe(false);
    const explicit = await launchPlan({ executablePath: exe, identity: { mode: "native" }, quiet: true, userDataDir: udd, launchTicket: TICKET });
    expect(explicit.args).toContain(`--ant0-launch=${TICKET}`);
    expect(seen).toHaveLength(0);
  });
});

describe("serve() exit-90 mapping", () => {
  it.skipIf(process.platform === "win32")("throws LaunchTicketRejectedError with the engine's reason", async () => {
    const dir = temp();
    const exe = join(dir, "chrome");
    // A fake engine: carries the capability marker (checkInstall) and behaves like a ticket-checking engine.
    writeFileSync(exe, `#!/bin/sh\n# ${MARKER}\necho "ant0: launch ticket invalid (unknown_kid)" >&2\nexit ${LAUNCH_TICKET_EXIT_CODE}\n`);
    chmodSync(exe, 0o755);
    const err = await serve({ executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: false, readyTimeoutMs: 5000 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LaunchTicketRejectedError);
    expect((err as LaunchTicketRejectedError).code).toBe(LAUNCH_TICKET_REJECTED_CODE);
    expect((err as LaunchTicketRejectedError).reason).toBe("unknown_kid");
  });

  it("parses the engine's stderr line", () => {
    expect(launchTicketRejection("Failed to launch: chrome\nant0: launch ticket invalid (claim_expired)\n")).toBe("claim_expired");
    expect(launchTicketRejection("nothing here")).toBeUndefined();
    expect(launchTicketRejection(undefined)).toBeUndefined();
    const e = new LaunchTicketRejectedError("missing");
    expect(e.code).toBe("engine.launch_ticket_rejected");
    expect(e.message).toMatch(/launchTicket|ant0d/);
  });
});

describe("installedEngineVersion (strict, for the --webrtc-ip gate)", () => {
  const make = (record: boolean, ancestor = false) => {
    const root = mkdtempSync(join(tmpdir(), "ant0-iev-"));
    const base = join(root, "inst");
    mkdirSync(join(base, "browser"), { recursive: true });
    const exe = join(base, "browser", "chrome");
    writeFileSync(exe, "x");
    if (record) writeFileSync(join(base, ".release.json"), JSON.stringify({ version: "158.0.8127.18-ant0.3" }));
    if (ancestor) writeFileSync(join(root, ".release.json"), JSON.stringify({ version: "158.0.8127.18-ant0.3" }));
    return { root, exe };
  };
  it("trusts the record beside the install's browser/ directory", () => {
    const { root, exe } = make(true);
    expect(installedEngineVersion(exe)).toBe("158.0.8127.18-ant0.3");
    rmSync(root, { recursive: true, force: true });
  });
  it("ignores a stale env var, a version in the path and a record in a far ancestor", () => {
    const { root, exe } = make(false, true);
    process.env.ANT0_BROWSER_ENGINE_VERSION = "158.0.8127.18-ant0.3";
    try {
      expect(installedEngineVersion(exe)).toBeUndefined();
      const named = join(root, "158.0.8127.18-ant0.3", "chrome");
      mkdirSync(dirname(named), { recursive: true });
      writeFileSync(named, "x");
      expect(installedEngineVersion(named)).toBeUndefined();
    } finally { delete process.env.ANT0_BROWSER_ENGINE_VERSION; rmSync(root, { recursive: true, force: true }); }
  });
  it("returns a dev build's -ant0.dev label only with allowDev", () => {
    const { root, exe } = make(false);
    writeFileSync(join(root, "inst", ".release.json"), JSON.stringify({ version: "158.0.8127.18-ant0.dev" }));
    expect(installedEngineVersion(exe)).toBeUndefined();
    expect(installedEngineVersion(exe, true)).toBe("158.0.8127.18-ant0.dev");
    writeFileSync(join(root, "inst", ".release.json"), JSON.stringify({ version: "nonsense" }));
    expect(installedEngineVersion(exe, true)).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
