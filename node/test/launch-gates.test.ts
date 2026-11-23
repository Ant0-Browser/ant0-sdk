// The launch paths themselves (not just the helpers) must apply the --webrtc-ip gate, the
// --webrtc-no-local-dns rule and Playwright's feature merge. Playwright and child_process are
// stubbed at the call, so these assert the arguments that actually reach the spawn.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: { args: string[] }[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...real,
    spawn: (_exe: string, args: string[]) => {
      spawned.push({ args });
      const child = new EventEmitter() as any;
      child.pid = 1;
      setImmediate(() => child.emit("spawn"));
      return child;
    },
  };
});

import { launch, launchPersistentContext, launchPlan } from "../src/index.js";

const MARKER = Buffer.from("ant0-browser-capabilities/persona-profile-v1");
const OLD = "158.0.8127.18-ant0.2";
const NEW = "158.0.8127.18-ant0.3";
let dir: string;
let exe: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ant0-gates-"));
  exe = join(dir, "chrome");
  writeFileSync(exe, Buffer.concat([Buffer.alloc(64, "x"), MARKER]));
  spawned.length = 0;
});
// A plan without a userDataDir creates its own temp profile dir, which the caller owns.
const planDirs: string[] = [];
const ownDirOf = (p: { ownUserDataDir: boolean; userDataDir: string }) => { if (p.ownUserDataDir) planDirs.push(p.userDataDir); };
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  for (const d of planDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = (extra: Record<string, unknown> = {}) => ({
  executablePath: exe, identity: { mode: "native" }, headless: true, quiet: true, launchTicket: false, ...extra,
});

/** Run a launch with Playwright stubbed; resolves with the options Playwright was handed. */
async function captureIncognito(opts: Record<string, unknown>): Promise<any> {
  let seen: any;
  vi.spyOn(chromium, "launch").mockImplementation((async (o: any) => { seen = o; throw new Error("stop"); }) as any);
  await launch({ ...base(opts), ephemeralProfile: false } as any).catch(() => {});
  return seen;
}
async function capturePersistent(opts: Record<string, unknown>): Promise<any> {
  let seen: any;
  vi.spyOn(chromium, "launchPersistentContext").mockImplementation((async (_d: string, o: any) => { seen = o; throw new Error("stop"); }) as any);
  await launchPersistentContext(join(dir, "udd"), base(opts) as any).catch(() => {});
  return seen;
}

const IP = "--webrtc-ip=203.0.113.7";
const ipOf = (args: string[]) => args.filter((a) => /^(?:--|-|\/)webrtc-ip(?:=|$)/i.test(a));

describe.each([
  ["launch (incognito)", captureIncognito],
  ["launchPersistentContext", capturePersistent],
] as const)("%s", (_name, run) => {
  it("drops --webrtc-ip on an old or unknown engine, in every spelling, and keeps it on ant0.3", async () => {
    for (const engineVersion of [OLD, undefined]) {
      const seen = await run({ engineVersion, args: [IP, "-webrtc-ip=198.51.100.1", "--WEBRTC-IP=198.51.100.2", "/webrtc-ip=198.51.100.3", "--webrtc-ip"] });
      expect(ipOf(seen.args)).toEqual([]);
    }
    const ok = await run({ engineVersion: NEW, args: [IP] });
    expect(ipOf(ok.args)).toEqual([IP]);
  });

  it("drops an invalid value on ant0.3 in any spelling", async () => {
    const seen = await run({ engineVersion: NEW, args: ["--webrtc-ip=not-an-ip", "-WebRTC-IP=", "--webrtc-ip"] });
    expect(ipOf(seen.args)).toEqual([]);
  });

  it("adds --webrtc-no-local-dns with a proxy (option or raw switch) on ant0.3 only", async () => {
    const proxied = await run({ engineVersion: NEW, proxy: { server: "http://127.0.0.1:3128" } });
    expect(proxied.args).toContain("--webrtc-no-local-dns");
    const raw = await run({ engineVersion: NEW, args: ["--proxy-server=http://127.0.0.1:3128"] });
    expect(raw.args).toContain("--webrtc-no-local-dns");
    expect((await run({ engineVersion: OLD, proxy: { server: "http://127.0.0.1:3128" } })).args).not.toContain("--webrtc-no-local-dns");
    expect((await run({ engineVersion: NEW })).args).not.toContain("--webrtc-no-local-dns");
    expect((await run({ engineVersion: NEW, proxy: { server: "http://127.0.0.1:3128" }, args: ["--webrtc-ip-handling-policy=default"] })).args)
      .not.toContain("--webrtc-no-local-dns");
  });

  it("keeps --webrtc-ip when the policy in force allows UDP, not when a safe value comes last or is forced", async () => {
    const allow = await run({ engineVersion: OLD, args: [IP, "--webrtc-ip-handling-policy=default"] });
    expect(ipOf(allow.args)).toEqual([IP]);
    for (const args of [
      [IP, "--webrtc-ip-handling-policy=default", "--webrtc-ip-handling-policy=disable_non_proxied_udp"],
      [IP, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=default"],
      [IP, "--webrtc-ip-handling-policy=", "--webrtc-ip-handling-policy"],
    ]) expect(ipOf((await run({ engineVersion: OLD, args })).args)).toEqual([]);
  });

  it("merges Playwright's feature lists into one switch each, without ThirdPartyStoragePartitioning", async () => {
    const seen = await run({ engineVersion: NEW, args: ["--disable-features=BrowsingTopics", "--enable-features=Foo"] });
    const dis = seen.args.filter((a: string) => a.startsWith("--disable-features="));
    const en = seen.args.filter((a: string) => a.startsWith("--enable-features="));
    expect(dis).toHaveLength(1);
    expect(dis[0]).toContain("BrowsingTopics");
    expect(dis[0]).toContain("Translate");
    expect(dis[0]).not.toContain("ThirdPartyStoragePartitioning");
    expect(en).toHaveLength(1);
    expect(en[0]).toContain("Foo");
    expect(en[0]).toContain("CDPScreenshotNewSurface");
  });

  it("pins DOM storage to leveldb once, in the same merged --disable-features as Playwright's list", async () => {
    const seen = await run({ engineVersion: NEW, args: ["--disable-features=Foo"] });
    const dis = seen.args.filter((a: string) => a.startsWith("--disable-features="));
    expect(dis).toHaveLength(1);
    const list = dis[0].slice("--disable-features=".length).split(",");
    for (const f of ["DomStorageSqlite", "DomStorageSqliteMigration", "DomStorageSqliteNewDatabases", "Foo", "Translate"]) {
      expect(list.filter((x: string) => x === f)).toHaveLength(1);
    }
  });

  it("adds the caller's ignoreDefaultArgs to the SDK's instead of replacing them", async () => {
    const seen = await run({ engineVersion: NEW, ignoreDefaultArgs: ["--mute-audio"] });
    const ign = seen.ignoreDefaultArgs as string[];
    expect(ign).toEqual(expect.arrayContaining(["--mute-audio", "--enable-automation", "--disable-ipc-flooding-protection"]));
  });

  // launch() stops passing four Playwright testing switches that a page can observe. These run against the
  // Playwright that is installed (playwright-core's real default list, which disables both features and not HFM).
  const DROPPED = ["HttpsUpgrades", "BoundaryEventDispatchTracksNodeRemoval", "MediaRouter"];
  const HFM = "HttpsFirstBalancedModeAutoEnable";
  const names = (args: string[]) => {
    const dis = args.filter((a) => a.startsWith("--disable-features="));
    expect(dis).toHaveLength(1);
    return dis[0].slice("--disable-features=".length).split(",");
  };

  it("never leaves MediaRouter disabled (a page can flag it as chromium_automation), keeps the other defaults", async () => {
    const n = names((await run({ engineVersion: NEW })).args);
    expect(n).not.toContain("MediaRouter");
    expect(n).toContain("Translate");
    expect(n).toContain(HFM);
  });

  it("stops disabling HttpsUpgrades, BoundaryEventDispatchTracksNodeRemoval and MediaRouter, and disables HFM exactly once", async () => {
    const n = names((await run({ engineVersion: NEW })).args);
    for (const f of DROPPED) expect(n).not.toContain(f);
    expect(n.filter((x) => x === HFM)).toHaveLength(1);
    expect(n).toContain("Translate");
  });

  it("ignores --hide-scrollbars and --disable-popup-blocking exactly once", async () => {
    for (const ignoreDefaultArgs of [undefined, ["--hide-scrollbars", "--mute-audio"]]) {
      const ign = (await run({ engineVersion: NEW, ignoreDefaultArgs })).ignoreDefaultArgs as string[];
      expect(ign.filter((a) => a === "--hide-scrollbars")).toHaveLength(1);
      expect(ign.filter((a) => a === "--disable-popup-blocking")).toHaveLength(1);
    }
  });

  it("honours a caller who passes the plain switches or the observable features themselves", async () => {
    const seen = await run({ engineVersion: NEW, args: ["--hide-scrollbars", "--disable-popup-blocking",
      "--disable-features=HttpsUpgrades,BoundaryEventDispatchTracksNodeRemoval,MediaRouter"] });
    expect(seen.ignoreDefaultArgs).not.toContain("--hide-scrollbars");
    expect(seen.ignoreDefaultArgs).not.toContain("--disable-popup-blocking");
    expect(seen.args.filter((a: string) => a === "--hide-scrollbars")).toHaveLength(1);
    expect(seen.args.filter((a: string) => a === "--disable-popup-blocking")).toHaveLength(1);
    const n = names(seen.args);
    for (const f of [...DROPPED, HFM]) expect(n.filter((x) => x === f)).toHaveLength(1);
    const one = await run({ engineVersion: NEW, args: ["--hide-scrollbars"] });
    expect(one.ignoreDefaultArgs).not.toContain("--hide-scrollbars");
    expect(one.ignoreDefaultArgs).toContain("--disable-popup-blocking");
  });

  it("a caller's --enable-features of HFM or a dropped feature lands only in --enable-features", async () => {
    for (const feat of [HFM, ...DROPPED]) {
      const seen = await run({ engineVersion: NEW, args: ["--enable-features=" + feat] });
      const en = seen.args.filter((a: string) => a.startsWith("--enable-features="));
      expect(en).toHaveLength(1);
      expect(en[0].split("=")[1].split(",")).toContain(feat);
      expect(seen.args.filter((a: string) => a.startsWith("--disable-features=")).join(",")).not.toContain(feat);
    }
  });

  it("with every default ignored passes true and edits no feature list", async () => {
    const seen = await run({ engineVersion: NEW, ignoreDefaultArgs: true });
    expect(seen.ignoreDefaultArgs).toBe(true);
    expect(seen.args.some((a: string) => a.includes(HFM))).toBe(false);
  });

  it("does not merge Playwright's features when every default is ignored", async () => {
    const seen = await run({ engineVersion: NEW, ignoreDefaultArgs: true });
    expect(seen.args.some((a: string) => a.startsWith("--disable-features=") && a.includes("Translate"))).toBe(false);
  });
});

describe("launchPlan() still matches stock on the switches launch() stopped passing", () => {
  it("passes neither the plain switches nor any HFM/HttpsUpgrades/Boundary feature edit", async () => {
    const plan = await launchPlan({ ...base({ engineVersion: NEW }) } as any);
    ownDirOf(plan);
    expect(plan.args).not.toContain("--hide-scrollbars");
    expect(plan.args).not.toContain("--disable-popup-blocking");
    const dis = plan.args.filter((a) => a.startsWith("--disable-features="));
    expect(dis).toEqual(["--disable-features=DomStorageSqlite,DomStorageSqliteMigration,DomStorageSqliteNewDatabases"]);
    expect(plan.args.filter((a) => a.startsWith("--enable-features="))).toEqual([]);
  });
});

describe("launchPlan().spawn", () => {
  it("re-gates the args that reach spawn with the fresh engine version", async () => {
    const plan = await launchPlan({ ...base({ engineVersion: OLD, args: [IP, "-webrtc-ip=198.51.100.1"] }) } as any);
    ownDirOf(plan);
    await plan.spawn();
    expect(spawned).toHaveLength(1);
    expect(ipOf(spawned[0].args)).toEqual([]);
  });

  it("keeps it on ant0.3 and adds --webrtc-no-local-dns for a raw proxy switch", async () => {
    const plan = await launchPlan({ ...base({ engineVersion: NEW, args: [IP, "--proxy-server=http://127.0.0.1:3128"] }) } as any);
    ownDirOf(plan);
    await plan.spawn();
    expect(ipOf(spawned[0].args)).toEqual([IP]);
    expect(spawned[0].args).toContain("--webrtc-no-local-dns");
  });
});

// Every launch path must hand the resolved engine version to the coherence warnings. The signal is
// the text of gpu-noise-string (canvas noise mode with gpuStringSpoof:false), a WARN (not fire-once): it
// fires only on an engine that honours gpuStringSpoof:false (ant0.8 or later).
describe("coherence warnings receive the engine version on every launch path", () => {
  const FIRES = "real string over altered pixels";
  const run = async (path: string, opts: Record<string, unknown>) => {
    const out: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((c: any) => { out.push(String(c)); return true; }) as any);
    const o = { ...base(opts), quiet: false, overrides: { canvas: "noise", canvasNoiseKey: "2092fc8be8f13c86", gpuStringSpoof: false } };
    if (path === "incognito") await captureIncognito(o);
    else if (path === "persistent") await capturePersistent(o);
    else { const p = await launchPlan(o as any); ownDirOf(p); }
    vi.restoreAllMocks();
    return out.join("");
  };
  /** An install layout whose .release.json carries `version` (what installedEngineVersion reads). */
  const installed = (version: string) => {
    const inst = join(dir, "inst"); mkdirSync(join(inst, "browser"), { recursive: true });
    const e = join(inst, "browser", "chrome");
    writeFileSync(e, Buffer.concat([Buffer.alloc(64, "x"), MARKER]));
    writeFileSync(join(inst, ".release.json"), JSON.stringify({ version }));
    return e;
  };
  for (const path of ["incognito", "persistent", "plan"]) {
    it(`${path}: old engine does not get the ant0.8 warning, ant0.8 and a dev build do`, async () => {
      expect(await run(path, { engineVersion: "158.0.8127.18-ant0.7" })).not.toContain(FIRES);
      expect(await run(path, { engineVersion: "158.0.8127.18-ant0.8" })).toContain(FIRES);
      expect(await run(path, { executablePath: installed("158.0.8127.18-ant0.dev") })).toContain(FIRES);
      expect(await run(path, { executablePath: installed("158.0.8127.18-ant0.7") })).not.toContain(FIRES);
    });
  }
});
