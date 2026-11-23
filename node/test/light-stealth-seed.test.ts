import { describe, it, expect } from "vitest";
import { lightStealthValues } from "../src/fingerprint.js";

describe("default light-stealth seed string", () => {
  it("seedless calls use the ant0-light-stealth seed", () => {
    expect(lightStealthValues()).toEqual(lightStealthValues("ant0-light-stealth"));
    expect(lightStealthValues("")).toEqual(lightStealthValues("ant0-light-stealth"));
  });
  it("pins the default persona (matches the Python SDK)", () => {
    expect(lightStealthValues()).toEqual({
      devicePixelRatio: 1, colorDepth: 24, deviceMemory: 8, hardwareConcurrency: 4, maxTouchPoints: 0, brand: "chrome",
    });
  });
});
