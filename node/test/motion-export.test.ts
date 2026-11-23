import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import * as motion from "../src/motion.js";

describe("public motion export", () => {
  it("re-exports the pure motor model unchanged", () => {
    for (const name of ["mulberry32", "hashSeed", "gaussFrom", "makePersona", "clickHold", "keyDwell",
      "minJerk", "planMove", "dragDwell", "clickPoint", "planAmbient"] as const) {
      expect(sdk[name]).toBe(motion[name]);
    }
  });

  it("stays pure: motion.ts imports nothing, so it can never touch a page", () => {
    const src = readFileSync(new URL("../src/motion.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\b(page|browser|context)\.[A-Za-z_]/);
  });

  it("is deterministic for a seed", () => {
    const a = sdk.makePersona("seed-1");
    const b = sdk.makePersona("seed-1");
    expect(a).toEqual(b);
    const rng1 = sdk.mulberry32(sdk.hashSeed("x"));
    const rng2 = sdk.mulberry32(sdk.hashSeed("x"));
    const from = { x: 10, y: 10 };
    const to = { x: 400, y: 300 };
    expect(sdk.planMove(from, to, a, { rng: rng1 })).toEqual(sdk.planMove(from, to, b, { rng: rng2 }));
  });
});
