import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareIdentityOptions } from "../src/identity.js";

// A schema 2 persona is always a Windows one (the validator pins compatibility.os_family to "windows").
const v2 = (_os = "windows") => JSON.parse(readFileSync(new URL("../../fixtures/synthetic/persona-v2.json", import.meta.url), "utf8"));
/** A small synthetic schema 4 persona (same shape as persona-v4-canvas.test.ts). */
const v4 = (os = "windows") => ({
  schema_version: 4, schema_revision: 1, requires: ["display", "input"],
  provenance: { source: "synthetic", model: { version: "population-model-v2.2", sha256: "0".repeat(64) } },
  identity: {
    os: { family: os, release: "windows-11", platform_version: "19.0.0", architecture: "x86_64" },
    engine: { family: "blink", major: 158 },
    brand: { id: "edge", version: "158.0.4370.16" },
    form_factor: "desktop", device_model: "",
  },
  surfaces: { display: { width: 1920 } },
});
const prep = (source: unknown, platform?: unknown) => prepareIdentityOptions({
  identity: { mode: "captured", source: source as any },
  ...(platform === undefined ? {} : { overrides: { platform } }),
  quiet: true,
} as any);

describe("platform override against the persona's OS", () => {
  for (const [label, make] of [["schema 2", v2], ["schema 4", v4]] as const) {
    it(`${label}: a contradicting platform raises a typed, actionable error`, () => {
      let err: any;
      try { prep(make("windows"), "linux"); } catch (e) { err = e; }
      expect(err).toBeDefined();
      expect(err.code).toBe("sdk.identity_platform_mismatch");
      expect(err.errorClass).toBe("expected");
      expect(err.message).toMatch(/drop the platform override or use a persona of the linux OS/i);
    });
    it(`${label}: a matching platform passes, case-insensitively`, () => {
      expect(() => prep(make("windows"), "windows")).not.toThrow();
      expect(() => prep(make("windows"), "Windows")).not.toThrow();
    });
    it(`${label}: no platform override passes`, () => {
      expect(() => prep(make("windows"))).not.toThrow();
    });
  }
  it("a schema 4 persona of another OS accepts its own platform", () => {
    expect(() => prep(v4("linux"), "linux")).not.toThrow();
    expect(() => prep(v4("macos"), "linux")).toThrow(/sdk\.identity_platform_mismatch|contradicts/);
  });
  it("keeps the matching platform in the launch options and the Windows voices of a Windows persona", () => {
    const out = prep(v2(), "windows").options as any;
    expect(out.platform).toBe("windows");
    expect(out.fingerprintProfile.speech.voices.length).toBeGreaterThan(0);
    expect(out.fingerprintProfile.speech.voices.some((v: any) => /Example Voice/.test(v.name))).toBe(true);
  });
  it("no persona (native identity) passes any platform", () => {
    for (const platform of ["linux", "windows", "macos"]) {
      expect(() => prepareIdentityOptions({ identity: { mode: "native" }, overrides: { platform }, quiet: true } as any)).not.toThrow();
    }
  });
  it("a persona that names no OS passes", () => {
    const p: any = v4(); p.identity.os.family = "";
    expect(() => prep(p, "linux")).not.toThrow();
  });
});
