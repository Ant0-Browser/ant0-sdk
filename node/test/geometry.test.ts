import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENGINE_FRAME_HEIGHT,
  DEFAULT_HEADLESS_GEOMETRY_SEED,
  ENGINE_FRAME_WIDTH,
  HEADLESS_SCREEN_PROFILES,
  applyHeadlessGeometry,
  geometryIsCoherent,
  headlessGeometry,
  headlessGeometryPoint,
  initialWindowArgs,
  nativeDisplayActive,
} from "../src/geometry.js";

describe("headless corpus geometry", () => {
  it("fits every viewport inside its selected screen", () => {
    for (const [width, height] of HEADLESS_SCREEN_PROFILES) {
      const inner = [width - ENGINE_FRAME_WIDTH, height - ENGINE_FRAME_HEIGHT];
      expect(geometryIsCoherent([width, height], [width, height], inner, [width, height])).toBe(true);
    }
  });

  const parity: Array<[string | null | undefined, number, number]> = [
    [null, 1920, 1080], ["", 1920, 1080], ["seed-1", 1920, 1200],
    ["acct-42", 1366, 768], ["ant0", 1366, 768], ["x", 2560, 1440],
    ["y", 3440, 1440], ["z", 1920, 1080], ["12345", 1920, 1080],
  ];

  it.each(parity)("keeps cross-SDK parity for %p", (seed, width, height) => {
    expect(headlessGeometry(seed)).toEqual({
      screen: { width, height },
      viewport: {
        width: width - ENGINE_FRAME_WIDTH,
        height: height - ENGINE_FRAME_HEIGHT,
      },
    });
  });

  it("uses context geometry and a pre-launch origin", () => {
    const opts: Record<string, unknown> = { headless: true };
    const applied = applyHeadlessGeometry(opts, undefined, ["--no-sandbox"]);
    expect(opts).toEqual({ headless: true, ...headlessGeometry(undefined) });
    expect(initialWindowArgs(["--no-sandbox"], applied))
      .toEqual(["--no-sandbox", "--window-position=0,0"]);
  });

  it.each(["--window-position=31,47", "--window-size=1111,777", "--start-maximized"])(
    "does not add an origin over explicit caller geometry %s",
    (flag) => {
      const applied = applyHeadlessGeometry({}, undefined, [flag]);
      expect(initialWindowArgs([flag], applied)).toEqual([flag]);
    },
  );
});

describe("native display geometry", () => {
  it("recognizes seed, imported profile, and paired direct avail dimensions", () => {
    expect(nativeDisplayActive(["--fingerprint=seed"])).toBe(true);
    expect(nativeDisplayActive(["--fingerprint-profile=encoded"])).toBe(true);
    expect(nativeDisplayActive([
      "--fingerprint-avail-width=1600", "--fingerprint-avail-height=860",
    ])).toBe(true);
    expect(nativeDisplayActive(["--fingerprint-avail-width=1600"])).toBe(false);
    expect(nativeDisplayActive(["--fingerprint-screen-width=1600"])).toBe(false);
  });

  it.each([
    [["--fingerprint=seed"]],
    [["--fingerprint-profile=encoded"]],
    [["--fingerprint-avail-width=1600", "--fingerprint-avail-height=860"]],
  ])("uses viewport null and performs no SDK window fixup for %p", (args) => {
    const opts: Record<string, unknown> = { headless: true };
    expect(applyHeadlessGeometry(opts, "seed", args)).toEqual({ mode: "native" });
    expect(opts).toEqual({ headless: true, viewport: null });
  });

  it("contains no geometry CDP or post-launch viewport fixup", () => {
    const geometry = readFileSync(new URL("../src/geometry.ts", import.meta.url), "utf8");
    const launcher = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(geometry).not.toContain("newCDPSession");
    expect(geometry).not.toContain("setViewportSize");
    expect(launcher).not.toContain("installWindowFixup");
  });

  it.each([
    { viewport: { width: 800, height: 600 } },
    { viewport: null },
    { screen: { width: 1024, height: 768 } },
  ])("leaves explicit caller context geometry untouched: %p", (explicit) => {
    const opts: Record<string, unknown> = { headless: true, ...explicit };
    expect(applyHeadlessGeometry(opts, "seed", ["--fingerprint=seed"])).toBeNull();
    expect(opts).toEqual({ headless: true, ...explicit });
  });
});

describe("default headless-geometry seed string", () => {
  it("names the default seed constant", () => {
    expect(DEFAULT_HEADLESS_GEOMETRY_SEED).toBe("ant0-headless-geometry");
  });
  it("seedless calls use that constant", () => {
    expect(headlessGeometry()).toEqual(headlessGeometry(DEFAULT_HEADLESS_GEOMETRY_SEED));
    expect(headlessGeometry("")).toEqual(headlessGeometry(DEFAULT_HEADLESS_GEOMETRY_SEED));
    expect(headlessGeometryPoint()).toBe(headlessGeometryPoint(DEFAULT_HEADLESS_GEOMETRY_SEED));
  });
  it("pins the hash point and geometry (matches the Python SDK)", () => {
    expect(headlessGeometryPoint()).toBe(8);
    expect(headlessGeometry()).toEqual({
      screen: { width: 1920, height: 1080 },
      viewport: { width: 1920 - ENGINE_FRAME_WIDTH, height: 1080 - ENGINE_FRAME_HEIGHT },
    });
  });
});
