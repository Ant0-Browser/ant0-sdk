// launchPlan() is the first half of serve(): everything resolved before spawn, handed to a
// supervisor (ant0d) that owns the child process itself. These tests pin the plan's shape against a
// fake binary that passes checkInstall (the capability marker is all isAnt0Binary looks for when no
// payload files sit next to the executable), so no browser is launched.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import api, { launchPlan, Server, type LaunchPlan, type ServeOptions } from "../src/index.js";

const MARKER = Buffer.from("ant0-browser-capabilities/persona-profile-v1");
const roots: string[] = [];
const temp = (prefix = "ant0-launch-plan-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

let exe: string;

/** A one-file fake install: the executable carries the capability marker and has no payload. */
beforeEach(() => {
  const dir = temp();
  exe = join(dir, process.platform === "win32" ? "chrome.exe" : "chrome");
  writeFileSync(exe, Buffer.concat([Buffer.alloc(64, "x"), MARKER]));
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Run `fn` with os.tmpdir() (TMPDIR) pointing at a private empty directory, so a test counts only
 * the dirs it creates itself; other processes and other test files cannot change the count. */
const serveDirs = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("ant0-browser-serve-"));
const withPrivateTmp = async (fn: (priv: string) => Promise<void>) => {
  const priv = temp("ant0-private-tmp-");
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = priv;
  try {
    expect(tmpdir()).toBe(priv);
    await fn(priv);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
};

/** A plan that creates its own profile dir hands it to the caller, so every plan made here is
 * registered for cleanup (as a supervisor would). Without this each such test leaked one dir. */
const plan = async (extra: ServeOptions = {}): Promise<LaunchPlan> => {
  const p = await launchPlan({ executablePath: exe, identity: { mode: "native" }, headless: true, quiet: true, ...extra });
  if (p.ownUserDataDir) roots.push(p.userDataDir);
  return p;
};
const own = plan;

describe("launchPlan", () => {
  it("rejects a malformed supplied ticket before automatic runtime discovery", async () => {
    await expect(launchPlan({ launchTicket: "invalid", identity: { mode: "native" }, quiet: true }))
      .rejects.toThrow(/five-segment/);
  });

  it("is exported by name and on the default export", () => {
    expect(typeof launchPlan).toBe("function");
    expect((api as { launchPlan?: unknown }).launchPlan).toBe(launchPlan);
  });

  it("resolves a native headless plan with the caller's port and profile dir", async () => {
    const udd = temp("ant0-udd-");
    const p = await plan({ port: 45678, userDataDir: udd });
    expect(p.executable).toBe(exe);
    expect(p.host).toBe("127.0.0.1");
    expect(p.port).toBe(45678);
    expect(p.cdpUrl).toBe("http://127.0.0.1:45678");
    expect(p.identityMode).toBe("native");
    expect(p.headless).toBe(true);
    expect(p.userDataDir).toBe(udd);
    expect(p.ownUserDataDir).toBe(false);
    expect(p.args).toContain("--remote-debugging-port=45678");
    expect(p.args).toContain("--remote-debugging-address=127.0.0.1");
    expect(p.args).toContain("--remote-allow-origins=http://127.0.0.1:45678,http://localhost:45678");
    expect(p.args).toContain(`--user-data-dir=${udd}`);
    expect(p.args).toContain("--headless=new");
    // The engine's default rides along: the plan is assembleArgs() + the CDP switches.
    expect(p.args).toContain("--webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(p.args).not.toContain("--enable-automation");
  });

  it("keeps DOM storage on leveldb, merged into a caller's own --disable-features", async () => {
    const udd = temp("ant0-udd-");
    const p = await plan({ port: 45678, userDataDir: udd, args: ["--disable-features=Foo"] });
    const disable = p.args.filter((a) => a.startsWith("--disable-features="));
    expect(disable).toHaveLength(1);
    const list = disable[0]!.slice("--disable-features=".length).split(",");
    expect(list).toEqual(
      expect.arrayContaining(["DomStorageSqlite", "DomStorageSqliteMigration", "DomStorageSqliteNewDatabases", "Foo"]),
    );
  });

  it("orders the args as serve() spawns them: engine args, CDP + hygiene switches, about:blank", async () => {
    const udd = temp("ant0-udd-");
    const p = await plan({ port: 45678, userDataDir: udd, args: ["--no-sandbox"] });
    expect(p.args).toContain("--no-sandbox");
    expect(p.args.slice(-9)).toEqual([
      "--remote-debugging-port=45678",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=http://127.0.0.1:45678,http://localhost:45678",
      `--user-data-dir=${udd}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--headless=new",
      "about:blank",
    ]);
    expect(p.args.indexOf("--no-sandbox")).toBeLessThan(p.args.indexOf("--remote-debugging-port=45678"));
  });

  // Playwright adds these on launch(); a supervisor spawning from the plan got none of them, so the
  // engine opened chrome://ungoogled-first-run (empty
  // body) whenever the caller passed no start URL.
  it("adds the first-run hygiene switches headed and headless, without any feature flag", async () => {
    const udd = temp("ant0-udd-");
    for (const headless of [true, false]) {
      const p = await plan({ port: 45678, userDataDir: udd, headless });
      for (const a of ["--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen"]) {
        expect(p.args.filter((x) => x === a)).toHaveLength(1);
      }
      // The identity layer owns feature flags; hygiene must not add or alter any.
      const features = p.args.filter((a) => a.startsWith("--enable-features=") || a.startsWith("--disable-features="));
      expect(features.length).toBeLessThanOrEqual(2);
      expect(features.some((a) => /FirstRun|SearchEngineChoice|DefaultBrowser/i.test(a))).toBe(false);
    }
  });

  it("opens about:blank as the final positional only when the caller passed no URL", async () => {
    const udd = temp("ant0-udd-");
    const none = await plan({ port: 45678, userDataDir: udd, args: ["--no-sandbox"] });
    expect(none.args.at(-1)).toBe("about:blank");
    expect(none.args.filter((a) => a === "about:blank")).toHaveLength(1);

    const withUrl = await plan({ port: 45678, userDataDir: udd, args: ["--no-sandbox", "https://example.com/"] });
    expect(withUrl.args).not.toContain("about:blank");
    expect(withUrl.args).toContain("https://example.com/");
    // The caller's URL stays a positional; switches after it are still switches to Chromium.
    expect(withUrl.args.indexOf("https://example.com/")).toBeLessThan(withUrl.args.indexOf("--remote-debugging-port=45678"));

    const two = await plan({ port: 45678, userDataDir: udd, args: ["https://a.example/", "https://b.example/"] });
    expect(two.args).not.toContain("about:blank");
  });

  it("the hygiene switches do not trigger the coherence checker's automation-arg warning", async () => {
    const { coherenceWarnings } = await import("../src/warnings.js");
    const codes = coherenceWarnings({
      _userArgs: ["--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen", "about:blank"],
      headless: false,
    }).map((w) => w.code);
    expect(codes).not.toContain("automation-arg");
  });

  it("creates a temp profile dir + picks a free port when the caller passes none", async () => {
    const p = await own();
    expect(p.ownUserDataDir).toBe(true);
    expect(existsSync(p.userDataDir)).toBe(true);
    expect(p.userDataDir.startsWith(join(tmpdir(), "ant0-browser-serve-"))).toBe(true);
    expect(p.args).toContain(`--user-data-dir=${p.userDataDir}`);
    expect(p.port).toBeGreaterThan(0);
    expect(p.cdpUrl).toBe(`http://127.0.0.1:${p.port}`);
    expect(p.args).toContain(`--remote-debugging-port=${p.port}`);
  });

  it("honours host, allowOrigins and headless: false", async () => {
    const p = await own({ host: "127.0.0.2", port: 45679, allowOrigins: "*", headless: false });
    expect(p.host).toBe("127.0.0.2");
    expect(p.cdpUrl).toBe("http://127.0.0.2:45679");
    expect(p.headless).toBe(false);
    expect(p.args).toContain("--remote-debugging-address=127.0.0.2");
    expect(p.args).toContain("--remote-allow-origins=*");
    expect(p.args).not.toContain("--headless=new");
  });

  it("env is process.env (stringified, no undefined) plus the shader dialect when asked", async () => {
    const udd = temp("ant0-udd-");
    const plain = await plan({ port: 45678, userDataDir: udd });
    expect(plain.env.PATH).toBe(process.env.PATH);
    expect(Object.values(plain.env).every((v) => typeof v === "string")).toBe(true);
    expect(plain.env.ANT0_BROWSER_SHADER_DIALECT).toBeUndefined();
    const hlsl = await plan({ port: 45678, userDataDir: udd, shaderDialect: "hlsl" });
    expect(hlsl.env.ANT0_BROWSER_SHADER_DIALECT).toBe("hlsl");
    expect(hlsl.env.PATH).toBe(process.env.PATH);
  });

  it("a SOCKS URL with embedded userinfo is rejected like explicit credentials", async () => {
    // Chromium drops userinfo from --proxy-server silently, so this shape is as broken as
    // username/password fields on a SOCKS descriptor; an http(s) URL with userinfo is Playwright's.
    await expect(own({ proxy: { server: "socks5://u:p@h:1080" } })).rejects.toThrow(/RFC 1929/);
    const p = await own({ proxy: { server: "http://u:p@h:3128" } });
    expect(p.args).toContain("--proxy-server=http://u:p@h:3128");
    expect(p.args).toContain("--disable-quic");
  });

  it("a credentialed SOCKS5 proxy is rejected: the engine has no RFC 1929 client, use a relay", async () => {
    // Nothing in the stack can authenticate to a SOCKS5 proxy (the engine has none, Playwright has
    // no support), so launching would only produce a proxy that refuses every connection. The daemon
    // (ant0d) strips credentials and runs a loopback relay before calling launchPlan().
    await expect(own({ proxy: { server: "socks5://h:1080", username: "u", password: "p" } }))
      .rejects.toThrow(/RFC 1929|relay/);
  });

  it("a credentialed SOCKS5 proxy fails before any temp profile dir is created", () =>
    withPrivateTmp(async (priv) => {
      await expect(plan({ port: 45678, proxy: { server: "socks5://h:1080", username: "u", password: "p" } }))
        .rejects.toThrow(/RFC 1929/);
      expect(serveDirs(priv)).toEqual([]);
    }));

  it("an unauthenticated SOCKS5 proxy (the relay shape) yields --proxy-server + --disable-quic only", async () => {
    const p = await own({ proxy: { server: "socks5://127.0.0.1:1080" } });
    expect(p.args).toContain("--proxy-server=socks5://127.0.0.1:1080");
    expect(p.args).toContain("--disable-quic");
    expect(p.args.some((a) => a.startsWith("--socks5-credentials"))).toBe(false);
  });

  it("emits --socks5-udp only with socks5Udp: true and a socks5 proxy", async () => {
    const udp = await own({ socks5Udp: true, proxy: { server: "socks5://h:1080" } });
    expect(udp.args).toContain("--socks5-udp");
    const http = await own({ socks5Udp: true, proxy: { server: "http://h:8080" } });
    expect(http.args).not.toContain("--socks5-udp");
    expect(http.args).toContain("--disable-quic");
    const none = await own({ socks5Udp: true });
    expect(none.args).not.toContain("--socks5-udp");
    expect(none.args).not.toContain("--disable-quic");
  });

  it("loads unpacked extensions with both switches", async () => {
    const ext = temp("ant0-ext-");
    mkdirSync(join(ext, "unpacked"));
    const dir = join(ext, "unpacked");
    const p = await own({ extensions: [dir] });
    expect(p.args).toContain(`--load-extension=${dir}`);
    expect(p.args).toContain(`--disable-extensions-except=${dir}`);
  });

  it("never emits --enable-automation", async () => {
    const udd = temp("ant0-udd-");
    for (const extra of [
      {}, { headless: false }, { proxy: { server: "http://h:8080" } }, { args: ["--no-sandbox"] },
    ] as ServeOptions[]) {
      const p = await plan({ port: 45678, userDataDir: udd, ...extra });
      expect(p.args).not.toContain("--enable-automation");
    }
  });

  it("rejects an unknown shader dialect without leaving a temp profile dir behind", () =>
    withPrivateTmp(async (priv) => {
      await expect(plan({ shaderDialect: "glsl" as never })).rejects.toThrow(/shaderDialect/);
      expect(serveDirs(priv)).toEqual([]);
      // Control: a valid plan DOES create its dir in the private tmpdir, so the check can fail.
      const ok = await plan();
      expect(serveDirs(priv)).toEqual([ok.userDataDir.slice(priv.length + 1)]);
    }));

  it("removes its own temp profile dir when planning throws AFTER the dir was created", () =>
    withPrivateTmp(async (priv) => {
      // allowOrigins is stringified only after mkdtemp, so a throwing toString reaches that point.
      const boom = { toString() { throw new Error("boom after mkdtemp"); } };
      await expect(plan({ allowOrigins: boom as never })).rejects.toThrow(/boom after mkdtemp/);
      expect(serveDirs(priv)).toEqual([]);
    }));

  it("rejects a binary that is not an Ant0 build", async () => {
    const other = join(temp("ant0-other-"), "chrome");
    writeFileSync(other, "not chromium");
    await expect(launchPlan({ executablePath: other, quiet: true })).rejects.toThrow(/not a compatible Ant0 Browser/);
  });
});

describe("Server.pid", () => {
  it("exposes the child's pid", () => {
    const fakeProc = { pid: 4242, exitCode: null, killed: false } as unknown as import("node:child_process").ChildProcess;
    const s = new Server(fakeProc, "127.0.0.1", 9222, "/tmp/x", false);
    expect(s.pid).toBe(4242);
  });
});

describe("launchPlan --webrtc-ip engine gate", () => {
  const withIp = (engineVersion: string | undefined, extra: ServeOptions = {}) =>
    plan({ launchTicket: false, engineVersion, overrides: { webrtcIp: "203.0.113.7" }, ...extra });
  const ipArgs = (p: LaunchPlan) => p.args.filter((a) => a.startsWith("--webrtc-ip="));

  it("omits it for an older engine and keeps the deny policy", async () => {
    const p = await withIp("158.0.8127.18-ant0.2");
    expect(ipArgs(p)).toEqual([]);
    expect(p.args).toContain("--webrtc-ip-handling-policy=disable_non_proxied_udp");
  });

  it("omits it when the engine version is unknown", async () => {
    expect(ipArgs(await withIp(undefined))).toEqual([]);
  });

  it("emits it for ant0.3 and later", async () => {
    expect(ipArgs(await withIp("158.0.8127.18-ant0.3"))).toEqual(["--webrtc-ip=203.0.113.7"]);
  });

  it("omits an explicit caller --webrtc-ip arg on an older engine", async () => {
    expect(ipArgs(await withIp("158.0.8127.18-ant0.2", { args: ["--webrtc-ip=198.51.100.9"] }))).toEqual([]);
  });

  it("keeps it on an old engine when the caller's own policy allows UDP", async () => {
    const p = await withIp("158.0.8127.18-ant0.2", { args: ["--webrtc-ip-handling-policy=default"] });
    expect(ipArgs(p)).toEqual(["--webrtc-ip=203.0.113.7"]);
  });
});

describe("launchPlan navigator.bluetooth flag follows the persona", () => {
  const real = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: real, configurable: true }));
  const has = (p: LaunchPlan) => p.args.some((a) => a.includes("WebBluetooth"));

  it("only a non-Linux persona on a Linux host gets it", async () => {
    if (real === "win32") return; // ensureRunnableHere / fake exe path differ; logic is unit-tested above
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(has(await plan({ overrides: { platform: "windows" } }))).toBe(true);
    expect(has(await plan({ overrides: { platform: "linux" } }))).toBe(false);
    expect(has(await plan({}))).toBe(false); // native: the real host
  });
});

describe("launchPlan --webrtc-no-local-dns", () => {
  const proxied = (engineVersion: string | undefined, extra: ServeOptions = {}) =>
    plan({ launchTicket: false, engineVersion, proxy: { server: "http://127.0.0.1:3128" }, ...extra });
  const has = (p: LaunchPlan) => p.args.includes("--webrtc-no-local-dns");

  it("is passed with a proxy on ant0.3, and not on an older or unknown engine", async () => {
    expect(has(await proxied("158.0.8127.18-ant0.3"))).toBe(true);
    expect(has(await proxied("158.0.8127.18-ant0.2"))).toBe(false);
    expect(has(await proxied(undefined))).toBe(false);
  });

  it("is not passed without a proxy, or when the caller's policy allows UDP", async () => {
    expect(has(await plan({ launchTicket: false, engineVersion: "158.0.8127.18-ant0.3" }))).toBe(false);
    expect(has(await proxied("158.0.8127.18-ant0.3", { args: ["--webrtc-ip-handling-policy=default"] }))).toBe(false);
  });
});
