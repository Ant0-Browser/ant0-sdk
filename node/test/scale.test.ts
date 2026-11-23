import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fingerprintArgs, personaAvail, personaDpr } from "../src/fingerprint.js";
import {
  clampedWindowSize, detectDisplaySize, parseDisplaySize, scaleWindowArgs, withDeviceScale,
} from "../src/scale.js";

const fixture = () => JSON.parse(readFileSync(
  fileURLToPath(new URL("../../fixtures/synthetic/persona-v2.json", import.meta.url)), "utf8"));
const profileWithDpr = (dpr: number) => {
  const p = fixture();
  p.display.device_pixel_ratio = dpr;
  return p;
};
const flag = (args: string[]) => args.filter((a) => a.startsWith("--force-device-scale-factor"));

describe("persona scale flag", () => {
  it("emits the persona's DPR from an explicit devicePixelRatio, including 1", () => {
    expect(flag(fingerprintArgs({ devicePixelRatio: 1.5 }))).toEqual(["--force-device-scale-factor=1.5"]);
    expect(flag(fingerprintArgs({ devicePixelRatio: 1 }))).toEqual(["--force-device-scale-factor=1"]);
  });

  it("reads the DPR of a v2 profile", () => {
    expect(flag(fingerprintArgs({ fingerprintProfile: profileWithDpr(1.25) }, true))).toEqual(["--force-device-scale-factor=1.25"]);
    expect(personaDpr({ fingerprintProfile: JSON.stringify(profileWithDpr(2)) })).toBe(2);
  });

  it("an explicit devicePixelRatio beats the profile; lightStealth supplies one", () => {
    expect(personaDpr({ devicePixelRatio: 1.5, fingerprintProfile: profileWithDpr(1) })).toBe(1.5);
    const dpr = personaDpr({ lightStealth: true, fingerprint: "seed-x" });
    expect(dpr).toBeGreaterThan(0);
    expect(flag(fingerprintArgs({ lightStealth: true, fingerprint: "seed-x" }))).toEqual([`--force-device-scale-factor=${dpr}`]);
  });

  it("emits nothing when the SDK does not know the persona's scale", () => {
    expect(flag(fingerprintArgs({}, true))).toEqual([]);
    expect(flag(fingerprintArgs({ fingerprint: "seed" }))).toEqual([]);
    expect(personaDpr({ fingerprintProfile: "{not json" })).toBeUndefined();
    expect(personaDpr({ devicePixelRatio: 0 })).toBeUndefined();
    expect(personaDpr({ devicePixelRatio: Number.NaN })).toBeUndefined();
  });

  it("reads the persona's available size", () => {
    expect(personaAvail({ fingerprintProfile: fixture() })).toEqual({ width: 1920, height: 1040 });
    expect(personaAvail({ availWidth: 1500, availHeight: 800, fingerprintProfile: fixture() })).toEqual({ width: 1500, height: 800 });
  });
});

describe("withDeviceScale", () => {
  it("gives a caller viewport the persona scale", () => {
    expect(withDeviceScale({ viewport: { width: 1000, height: 600 } }, 1.5))
      .toEqual({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1.5 });
  });
  it("leaves the caller's own scale, a null viewport and an unknown persona scale alone", () => {
    const own = { viewport: { width: 1, height: 1 }, deviceScaleFactor: 2 };
    expect(withDeviceScale(own, 1.5)).toBe(own);
    const none = { viewport: null };
    expect(withDeviceScale(none, 1.5)).toBe(none);
    const v = { viewport: { width: 1, height: 1 } };
    expect(withDeviceScale(v, undefined)).toBe(v);
    expect(withDeviceScale({}, 1.5)).toEqual({});
  });
  it("does not mutate the input", () => {
    const v = { viewport: { width: 1, height: 1 } };
    withDeviceScale(v, 2);
    expect("deviceScaleFactor" in v).toBe(false);
  });
});

describe("window clamp", () => {
  const display = { width: 1920, height: 1080 };
  it("keeps a persona that is larger than the display on it (flag 1.5 drew 2880 wide)", () => {
    expect(clampedWindowSize(1.5, display, { width: 1920, height: 1040 })).toEqual({ width: 1274, height: 714 });
  });
  it("needs no clamp when the persona already fits, at scale 1, or with an unknown display", () => {
    expect(clampedWindowSize(1.5, display, { width: 1200, height: 700 })).toBeUndefined();
    expect(clampedWindowSize(1.5, undefined, { width: 1920, height: 1040 })).toBeUndefined();
  });
  it("with no persona size, uses the display divided by the scale", () => {
    expect(clampedWindowSize(2, display)).toEqual({ width: 956, height: 536 });
  });
  it("scaleWindowArgs adds the clamp for headed launches only, and never over the caller's own size", () => {
    const avail = { width: 1920, height: 1040 };
    expect(scaleWindowArgs(["--a"], 1.5, true, avail, [], display)).toEqual(["--a", "--window-size=1274,714", "--window-position=0,0"]);
    expect(scaleWindowArgs(["--a"], 1.5, false, avail, [], display)).toEqual(["--a"]);
    expect(scaleWindowArgs(["--a"], 1.5, true, avail, ["--window-size=800,600"], display)).toEqual(["--a"]);
    expect(scaleWindowArgs(["--a"], 1.5, true, avail, ["--start-maximized"], display)).toEqual(["--a"]);
    expect(scaleWindowArgs(["--a"], undefined, true, avail, [], display)).toEqual(["--a"]);
  });
  it("clamps the SDK's own window size (the Android phone window) instead of adding a second", () => {
    expect(scaleWindowArgs(["--window-size=412,915", "--b"], 2.625, true, undefined, [], display))
      .toEqual(["--b", "--window-size=412,408", "--window-position=0,0"]);
    expect(scaleWindowArgs(["--window-size=412,915"], 1.5, true, undefined, [], { width: 3000, height: 2000 }))
      .toEqual(["--window-size=412,915"]);
  });
});

describe("window fit on small displays", () => {
  const d = { width: 1400, height: 900 };
  const physical = (a: string[]) => {
    const m = /--window-size=(\d+),(\d+)/.exec(a.join(" "))!;
    return [Number(m[1]), Number(m[2])];
  };
  it("dpr 1 persona larger than the screen is clamped (was 1426x926 at 150%)", () => {
    expect(clampedWindowSize(1, d, { width: 1426, height: 926 })).toEqual({ width: 1392, height: 892 });
    expect(scaleWindowArgs([], 1, true, { width: 1426, height: 926 }, [], d))
      .toEqual(["--window-size=1392,892", "--window-position=0,0"]);
  });
  it("dpr 1 persona that fits is left alone", () => {
    expect(clampedWindowSize(1, d, { width: 1366, height: 768 })).toBeUndefined();
    expect(scaleWindowArgs([], 1, true, { width: 1366, height: 768 }, [], d)).toEqual([]);
  });
  it("dpr 1.25 floors so CSS x dpr stays under the display", () => {
    const [w, h] = physical(scaleWindowArgs([], 1.25, true, { width: 1920, height: 1040 }, [], d));
    expect([w, h]).toEqual([1113, 713]);
    expect(w * 1.25).toBeLessThanOrEqual(1400 - 8);
    expect(h * 1.25).toBeLessThanOrEqual(900 - 8);
  });
  it("dpr 2 clamps and is positioned at the origin", () => {
    expect(scaleWindowArgs([], 2, true, { width: 1366, height: 768 }, [], d))
      .toEqual(["--window-size=696,446", "--window-position=0,0"]);
  });
  it("a caller's own size or position wins and no position is added", () => {
    const p = { width: 1426, height: 926 };
    expect(scaleWindowArgs([], 1, true, p, ["--window-position=10,10"], d)).toEqual([]);
    expect(scaleWindowArgs([], 1, true, p, ["--window-size=800,600"], d)).toEqual([]);
    expect(scaleWindowArgs([], 1, true, p, ["--start-fullscreen"], d)).toEqual([]);
  });
  it("keeps a position the SDK already set", () => {
    expect(scaleWindowArgs(["--window-position=5,5"], 1, true, { width: 1426, height: 926 }, [], d))
      .toEqual(["--window-position=5,5", "--window-size=1392,892"]);
  });
  it("headless and an unset dpr are untouched", () => {
    expect(scaleWindowArgs(["--a"], 1, false, { width: 1426, height: 926 }, [], d)).toEqual(["--a"]);
    expect(scaleWindowArgs(["--a"], undefined, true, { width: 1426, height: 926 }, [], d)).toEqual(["--a"]);
  });
});

describe("display detection", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });
  it("parses xrandr and xdpyinfo output", () => {
    expect(parseDisplaySize("Screen 0: minimum 320 x 200, current 1920 x 1080, maximum 16384 x 16384")).toEqual({ width: 1920, height: 1080 });
    expect(parseDisplaySize("  dimensions:    2560x1440 pixels (677x381 millimeters)")).toEqual({ width: 2560, height: 1440 });
    expect(parseDisplaySize("nothing here")).toBeUndefined();
  });
  it("ANT0_DISPLAY_SIZE wins and works on any platform", () => {
    process.env.ANT0_DISPLAY_SIZE = "1366x768";
    expect(detectDisplaySize("win32")).toEqual({ width: 1366, height: 768 });
    process.env.ANT0_DISPLAY_SIZE = "junk";
    delete process.env.DISPLAY;
    expect(detectDisplaySize("win32")).toBeUndefined();
    expect(detectDisplaySize("linux")).toBeUndefined();
  });
});
