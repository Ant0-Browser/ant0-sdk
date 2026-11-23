// launchPlan()/serve() apply the same launch options launch() does: caller env, widevine, proxy
// bypass, the sandbox option, and the socks5h:// scheme. Also the ignored cacheDir note on every
// launch path. Nothing launches: Playwright and child_process are stubbed at the call.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: { args: string[]; env: Record<string, string | undefined> }[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...real,
    spawn: (_exe: string, args: string[], opts: any) => {
      spawned.push({ args, env: opts?.env });
      const child = new EventEmitter() as any;
      child.pid = 1;
      setImmediate(() => child.emit("spawn"));
      return child;
    },
  };
});
const seeded: string[] = [];
vi.mock("../src/widevine.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/widevine.js")>();
  return { ...real, seedWidevine: async (udd: string) => { seeded.push(udd); return udd; } };
});

import { launch, launchPersistentContext, launchPlan } from "../src/index.js";
import { resolveProxy, proxyBypassArgs } from "../src/launchopts.js";

const MARKER = Buffer.from("ant0-browser-capabilities/persona-profile-v1");
let dir: string;
let exe: string;
const planDirs: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ant0-parity-"));
  exe = join(dir, "chrome");
  writeFileSync(exe, Buffer.concat([Buffer.alloc(64, "x"), MARKER]));
  spawned.length = 0;
  seeded.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  for (const d of planDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const base = (extra: Record<string, unknown> = {}) => ({
  executablePath: exe, identity: { mode: "native" }, headless: true, quiet: true, launchTicket: false, ...extra,
});
const plan = async (extra: Record<string, unknown> = {}) => {
  const p = await launchPlan(base(extra) as any);
  if (p.ownUserDataDir) planDirs.push(p.userDataDir);
  return p;
};

describe("launchPlan: caller env", () => {
  it("layers the caller env over process.env and the font wiring, like launch()", async () => {
    process.env.ANT0_PARITY_BASE = "from-process";
    try {
      const p = await plan({ env: { ANT0_PARITY_BASE: "from-caller", ANT0_PARITY_NEW: "1" } });
      expect(p.env.ANT0_PARITY_BASE).toBe("from-caller");
      expect(p.env.ANT0_PARITY_NEW).toBe("1");
    } finally { delete process.env.ANT0_PARITY_BASE; }
  });

  it("drops undefined caller values and stringifies the rest", async () => {
    process.env.ANT0_PARITY_GONE = "x";
    try {
      const p = await plan({ env: { ANT0_PARITY_GONE: undefined, ANT0_PARITY_NUM: 7 } });
      expect("ANT0_PARITY_GONE" in p.env).toBe(false);
      expect(p.env.ANT0_PARITY_NUM).toBe("7");
    } finally { delete process.env.ANT0_PARITY_GONE; }
  });

  it("keeps the caller env at spawn time (the fresh env is rebuilt there) and applies the shader dialect over it", async () => {
    const p = await plan({ env: { ANT0_PARITY_NEW: "2" }, shaderDialect: "hlsl" });
    await p.spawn!();
    expect(spawned[0].env.ANT0_PARITY_NEW).toBe("2");
    expect(spawned[0].env.ANT0_BROWSER_SHADER_DIALECT).toBe("hlsl");
  });
});

describe("launchPlan: env removal survives the shader dialect", () => {
  it("a caller env value of undefined removes an inherited variable, with shaderDialect set, in the plan and at spawn", async () => {
    process.env.ANT0_PARITY_GONE = "inherited";
    try {
      const p = await plan({ env: { ANT0_PARITY_GONE: undefined }, shaderDialect: "hlsl" });
      expect("ANT0_PARITY_GONE" in p.env).toBe(false);
      expect(p.env.ANT0_BROWSER_SHADER_DIALECT).toBe("hlsl");
      await p.spawn!();
      expect(spawned[0].env.ANT0_PARITY_GONE).toBeUndefined();
      expect(spawned[0].env.ANT0_BROWSER_SHADER_DIALECT).toBe("hlsl");
    } finally { delete process.env.ANT0_PARITY_GONE; }
  });
});

describe("widevine: true changes the launch args", () => {
  it("launchPersistentContext seeds the CDM and un-suppresses the component updater", async () => {
    let seen: any;
    vi.spyOn(chromium, "launchPersistentContext").mockImplementation((async (_d: string, o: any) => { seen = o; throw new Error("stop"); }) as any);
    const udd = join(dir, "udd");
    await launchPersistentContext(udd, base({ widevine: true }) as any).catch(() => {});
    expect(seeded).toEqual([udd]);
    expect(seen.ignoreDefaultArgs).toContain("--disable-component-update");
    expect(seen.ignoreDefaultArgs).toContain("--enable-automation");
  });

  it("launchPlan adds the component-updater scan switch where it applies (non-Linux), built after seeding", async () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const withWv = await plan({ widevine: true });
      expect(seeded).toEqual([withWv.userDataDir]);
      expect(withWv.args).toContain("--component-updater=fast-update");
      const without = await plan({});
      expect(without.args).not.toContain("--component-updater=fast-update");
    } finally { Object.defineProperty(process, "platform", orig); }
  });

  it("launchPlan on Linux seeds but adds no scan switch", async () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const p = await plan({ widevine: true });
      expect(seeded).toEqual([p.userDataDir]);
      expect(p.args).not.toContain("--component-updater=fast-update");
    } finally { Object.defineProperty(process, "platform", orig); }
  });
});

describe("launchPlan: widevine", () => {
  it("seeds the CDM into the served profile when widevine is true, and only then", async () => {
    const udd = join(dir, "udd");
    mkdirSync(udd);
    await plan({ userDataDir: udd, widevine: true });
    expect(seeded).toEqual([udd]);
    seeded.length = 0;
    await plan({ userDataDir: udd });
    expect(seeded).toEqual([]);
  });

  it("seeds into the plan's own temp profile too, before the args are built", async () => {
    const p = await plan({ widevine: true });
    expect(seeded).toEqual([p.userDataDir]);
  });

  it("does not pass widevine to anything else (no stray switch on Linux)", async () => {
    const p = await plan({ widevine: true });
    expect(p.args.some((a) => /widevine/i.test(a))).toBe(false);
  });
});

describe("launchPlan: proxy bypass", () => {
  const proxy = { server: "http://127.0.0.1:3128", bypass: "example.com, .internal ,10.0.0.0/8" };
  it("passes bypass as --proxy-bypass-list with Playwright's rule translation, and no <-loopback>", async () => {
    const p = await plan({ proxy });
    expect(p.args.filter((a) => a.startsWith("--proxy-bypass-list="))).toEqual(["--proxy-bypass-list=example.com;*.internal;10.0.0.0/8"]);
    expect(p.args.join(" ")).not.toContain("<-loopback>");
    expect(p.args).toContain("--proxy-server=http://127.0.0.1:3128");
  });
  it("a caller's own --proxy-bypass-list in args wins", async () => {
    const p = await plan({ proxy, args: ["--proxy-bypass-list=mine.test"] });
    expect(p.args.filter((a) => a.startsWith("--proxy-bypass-list="))).toEqual(["--proxy-bypass-list=mine.test"]);
  });
  it("adds nothing without a proxy server or without a bypass", async () => {
    expect((await plan({ proxy: { server: "http://127.0.0.1:3128" } })).args.some((a) => a.startsWith("--proxy-bypass-list"))).toBe(false);
    expect((await plan({})).args.some((a) => a.startsWith("--proxy-bypass-list"))).toBe(false);
    expect(proxyBypassArgs({ bypass: "a.com" })).toEqual([]);
    expect(proxyBypassArgs({ server: "http://p:1", bypass: " , " })).toEqual([]);
  });
});

describe("launchPlan: chromiumSandbox", () => {
  it("false adds --no-sandbox once; the default and true keep the sandbox on", async () => {
    expect((await plan({ chromiumSandbox: false })).args.filter((a) => a === "--no-sandbox")).toHaveLength(1);
    expect((await plan({ chromiumSandbox: false, args: ["--no-sandbox"] })).args.filter((a) => a === "--no-sandbox")).toHaveLength(1);
    expect((await plan({})).args).not.toContain("--no-sandbox");
    expect((await plan({ chromiumSandbox: true })).args).not.toContain("--no-sandbox");
  });
});

describe("socks5h:// is sent as socks5://", () => {
  it("resolveProxy maps the scheme case-insensitively and keeps everything else", () => {
    expect(resolveProxy({ server: "socks5h://10.0.0.1:1080", bypass: "a.com" }).proxy)
      .toEqual({ server: "socks5://10.0.0.1:1080", bypass: "a.com" });
    expect(resolveProxy({ server: "SOCKS5H://Host.Example:1080" }).proxy?.server).toBe("socks5://Host.Example:1080");
    for (const server of ["socks5://h:1", "socks4://h:1", "http://h:1", "https://h:1", "h:1", "socks5hx://h:1"]) {
      expect(resolveProxy({ server }).proxy?.server).toBe(server);
    }
  });
  it("does not change the caller's object", () => {
    const input = { server: "socks5h://h:1" };
    resolveProxy(input);
    expect(input.server).toBe("socks5h://h:1");
  });
  it("a credentialed socks5h proxy is still rejected", () => {
    expect(() => resolveProxy({ server: "socks5h://u:p@h:1" })).toThrow();
    expect(() => resolveProxy({ server: "socks5h://h:1", username: "u" })).toThrow();
  });

  it("launch (incognito) and launchPersistentContext hand Playwright socks5://", async () => {
    let seen: any;
    vi.spyOn(chromium, "launch").mockImplementation((async (o: any) => { seen = o; throw new Error("stop"); }) as any);
    await launch({ ...base({ proxy: { server: "SOCKS5H://h.test:1080", bypass: "a.com" } }), ephemeralProfile: false } as any).catch(() => {});
    expect(seen.proxy).toEqual({ server: "socks5://h.test:1080", bypass: "a.com" });
    vi.spyOn(chromium, "launchPersistentContext").mockImplementation((async (_d: string, o: any) => { seen = o; throw new Error("stop"); }) as any);
    await launchPersistentContext(join(dir, "udd"), base({ proxy: { server: "socks5h://h.test:1080" } }) as any).catch(() => {});
    expect(seen.proxy.server).toBe("socks5://h.test:1080");
  });

  it("launchPlan/serve spawn with --proxy-server=socks5://", async () => {
    const p = await plan({ proxy: { server: "socks5h://h.test:1080" } });
    expect(p.args).toContain("--proxy-server=socks5://h.test:1080");
    expect(p.args.join(" ")).not.toContain("socks5h");
    await p.spawn!();
    expect(spawned[0].args).toContain("--proxy-server=socks5://h.test:1080");
  });

  it("another scheme is passed to launchPlan unchanged", async () => {
    expect((await plan({ proxy: { server: "http://h.test:8080" } })).args).toContain("--proxy-server=http://h.test:8080");
  });
});

// The note is once per process, so each test loads a fresh copy of the modules.
describe("cacheDir is accepted and ignored on launch, with a once-per-process note", () => {
  const NOTE = "cacheDir is ignored on launch";
  let writes: string[];
  const load = async () => {
    vi.resetModules();
    const sdk = await import("../src/index.js");
    const pw = await import("playwright-core");
    return { sdk, chromium: pw.chromium };
  };
  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((c: any) => { writes.push(String(c)); return true; }) as any);
  });
  const notes = () => writes.filter((w) => w.includes(NOTE));

  it("fires once across two launches, as a note that points to executablePath({ cacheDir })", async () => {
    const { sdk, chromium: cr } = await load();
    vi.spyOn(cr, "launchPersistentContext").mockImplementation((async () => { throw new Error("stop"); }) as any);
    const opts = { ...base({ quiet: false }), cacheDir: join(dir, "cache") } as any;
    await sdk.launchPersistentContext(join(dir, "u1"), opts).catch(() => {});
    await sdk.launchPersistentContext(join(dir, "u2"), opts).catch(() => {});
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatch(/^ant0-browser: note: /);
    expect(notes()[0]).toContain("executablePath({ cacheDir })");
  });

  it("fires on the incognito path and on launchPlan", async () => {
    const { sdk, chromium: cr } = await load();
    vi.spyOn(cr, "launch").mockImplementation((async () => { throw new Error("stop"); }) as any);
    await sdk.launch({ ...base({ quiet: false }), cacheDir: "x", ephemeralProfile: false } as any).catch(() => {});
    expect(notes()).toHaveLength(1);
    const { sdk: sdk2 } = await load();
    writes.length = 0;
    const p = await sdk2.launchPlan({ ...base({ quiet: false }), cacheDir: "x" } as any);
    planDirs.push(p.userDataDir);
    expect(notes()).toHaveLength(1);
  });

  it("does not fire when the option is not given", async () => {
    const { sdk, chromium: cr } = await load();
    vi.spyOn(cr, "launchPersistentContext").mockImplementation((async () => { throw new Error("stop"); }) as any);
    await sdk.launchPersistentContext(join(dir, "u1"), base({ quiet: false }) as any).catch(() => {});
    expect(notes()).toHaveLength(0);
  });

  it("is silent under quiet and ANT0_BROWSER_NO_WARN", async () => {
    const { sdk, chromium: cr } = await load();
    vi.spyOn(cr, "launchPersistentContext").mockImplementation((async () => { throw new Error("stop"); }) as any);
    await sdk.launchPersistentContext(join(dir, "u1"), { ...base({ quiet: true }), cacheDir: "x" } as any).catch(() => {});
    process.env.ANT0_BROWSER_NO_WARN = "1";
    try {
      await sdk.launchPersistentContext(join(dir, "u2"), { ...base({ quiet: false }), cacheDir: "x" } as any).catch(() => {});
    } finally { delete process.env.ANT0_BROWSER_NO_WARN; }
    expect(notes()).toHaveLength(0);
  });

  it("launch still works with the option given: Playwright is reached without it", async () => {
    const { sdk, chromium: cr } = await load();
    let seen: any;
    vi.spyOn(cr, "launchPersistentContext").mockImplementation((async (_d: string, o: any) => { seen = o; throw new Error("stop"); }) as any);
    await sdk.launchPersistentContext(join(dir, "u1"), { ...base(), cacheDir: "x" } as any).catch(() => {});
    expect(seen.executablePath).toBe(exe);
    expect("cacheDir" in seen).toBe(false);
  });
});
