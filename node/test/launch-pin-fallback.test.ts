// The DOM storage pin is a --disable-features switch. On a launch path it is skipped when the
// installed Playwright's default feature lists cannot be read, because the SDK's switch would then
// replace Playwright's whole disabled list. serve()/launchPlan() always pin (they have no Playwright
// list). Reading Playwright's source is made to fail here, so this file runs in the fallback state.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const guard = ((p: any, ...rest: any[]) => {
    if (/playwright-core[\\/]lib[\\/](coreBundle\.js|server[\\/]chromium[\\/]chromiumSwitches\.js)$/.test(String(p))) {
      throw new Error("unreadable");
    }
    return (real.readFileSync as any)(p, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync: guard, default: { ...real, readFileSync: guard } };
});

import { launch, launchPersistentContext, launchPlan } from "../src/index.js";
import { installedPlaywrightFeatureDefaults, withPlaywrightFeatureDefaults } from "../src/launchopts.js";

const MARKER = Buffer.from("ant0-browser-capabilities/persona-profile-v1");
let dir: string;
let exe: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ant0-pin-fb-"));
  exe = join(dir, "chrome");
  writeFileSync(exe, Buffer.concat([Buffer.alloc(64, "x"), MARKER]));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const base = (extra: Record<string, unknown> = {}) => ({
  executablePath: exe, identity: { mode: "native" }, headless: true, quiet: true, launchTicket: false, ...extra,
});
async function incognito(opts: Record<string, unknown>): Promise<any> {
  let seen: any;
  vi.spyOn(chromium, "launch").mockImplementation((async (o: any) => { seen = o; throw new Error("stop"); }) as any);
  await launch({ ...base(opts), ephemeralProfile: false } as any).catch(() => {});
  return seen;
}
async function persistent(opts: Record<string, unknown>): Promise<any> {
  let seen: any;
  vi.spyOn(chromium, "launchPersistentContext").mockImplementation((async (_d: string, o: any) => { seen = o; throw new Error("stop"); }) as any);
  await launchPersistentContext(join(dir, "udd"), base(opts) as any).catch(() => {});
  return seen;
}
const features = (args: string[]) => args.filter((a) => /^--(enable|disable)-features=/.test(a));

describe("fallback state (Playwright defaults unreadable)", () => {
  it("is really in the fallback state", () => {
    expect(installedPlaywrightFeatureDefaults()).toBeUndefined();
  });

  for (const [name, run] of [["launch", incognito], ["launchPersistentContext", persistent]] as const) {
    it(`${name}: no pin, so Playwright's own lists stay (no --disable-features at all)`, async () => {
      const seen = await run({});
      expect(features(seen.args).filter((a: string) => a.startsWith("--disable-features="))).toEqual([]);
      expect(seen.args.join(" ")).not.toContain("DomStorageSqlite");
    });

    it(`${name}: a caller's --disable-features passes through alone, without the pin`, async () => {
      const seen = await run({ args: ["--disable-features=Foo"] });
      expect(features(seen.args)).toEqual(["--disable-features=Foo"]);
    });

    it(`${name}: unreadable defaults add no HFM and remove nothing, but the two plain switches are still ignored`, async () => {
      for (const args of [[], ["--disable-features=HttpsUpgrades,BoundaryEventDispatchTracksNodeRemoval"]]) {
        const seen = await run({ args });
        const dis = features(seen.args).filter((a: string) => a.startsWith("--disable-features="));
        expect(dis).toEqual(args.length ? args : []);
        expect(seen.args.join(" ")).not.toContain("HttpsFirstBalancedModeAutoEnable");
        expect(seen.ignoreDefaultArgs).toEqual(expect.arrayContaining(["--hide-scrollbars", "--disable-popup-blocking"]));
      }
    });

    it(`${name}: the pin is kept when every Playwright default is ignored`, async () => {
      const seen = await run({ ignoreDefaultArgs: true });
      expect(features(seen.args)).toEqual([
        "--disable-features=DomStorageSqlite,DomStorageSqliteMigration,DomStorageSqliteNewDatabases",
      ]);
    });
  }

  it("launchPlan always pins, once, merged into the caller's list", async () => {
    const p = await launchPlan(base({ args: ["--disable-features=Foo"] }) as any);
    if (p.ownUserDataDir) rmSync(p.userDataDir, { recursive: true, force: true });
    const dis = p.args.filter((a) => a.startsWith("--disable-features="));
    expect(dis).toHaveLength(1);
    expect(dis[0]!.slice("--disable-features=".length).split(",").sort()).toEqual(
      ["DomStorageSqlite", "DomStorageSqliteMigration", "DomStorageSqliteNewDatabases", "Foo"]);
  });

  it("withPlaywrightFeatureDefaults: injected unreadable defaults add no pin; parsed ones add one merged pin", () => {
    expect(features(withPlaywrightFeatureDefaults(["--x"], undefined, true, null))).toEqual([]);
    const parsed = withPlaywrightFeatureDefaults(["--disable-features=Foo"], undefined, true, ["Translate", "MediaRouter"]);
    const dis = features(parsed);
    expect(dis).toHaveLength(1);
    expect(dis[0]).toBe("--disable-features=Translate,HttpsFirstBalancedModeAutoEnable,Foo,DomStorageSqlite,DomStorageSqliteMigration,DomStorageSqliteNewDatabases");
  });
});
