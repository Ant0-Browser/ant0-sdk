import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePersonaProfileV2 } from "../src/persona-profile-v2.js";
import { webglLimitViolations } from "../src/webgl-coherence.js";

const base = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../fixtures/synthetic/persona-v2.json", import.meta.url)),
  "utf8",
)) as Record<string, any>;

function profile(webgl1: Record<string, unknown> = {}, webgl2: Record<string, unknown> = {}) {
  const p = structuredClone(base);
  Object.assign(p.graphics.webgl.webgl1.parameters, webgl1);
  Object.assign(p.graphics.webgl.webgl2.parameters, webgl2);
  return p;
}
const blocks = (v: number, f: number, c: number, b: number) => ({
  MAX_VERTEX_UNIFORM_BLOCKS: v, MAX_FRAGMENT_UNIFORM_BLOCKS: f,
  MAX_COMBINED_UNIFORM_BLOCKS: c, MAX_UNIFORM_BUFFER_BINDINGS: b,
});
const coherence = (p: unknown) => {
  const r = validatePersonaProfileV2(p);
  return r.valid ? [] : r.errors.filter((e) => e.path === "graphics.webgl.parameters");
};

describe("WebGL limit coherence (same cases as the engine's strict loader)", () => {
  it.each([
    ["no relation key present (fixture)", profile()],
    ["blocks 12/12/24 bindings 24", profile({}, blocks(12, 12, 24, 24))],
    ["blocks 14/14/28 bindings 28", profile({}, blocks(14, 14, 28, 28))],
    ["only vertex blocks 8 (8+12 <= 24)", profile({}, { MAX_VERTEX_UNIFORM_BLOCKS: 8 })],
    ["merged: webgl1 combined 20, webgl2 blocks 8/8", profile(
      { MAX_COMBINED_UNIFORM_BLOCKS: 20, MAX_UNIFORM_BUFFER_BINDINGS: 24 },
      { MAX_VERTEX_UNIFORM_BLOCKS: 8, MAX_FRAGMENT_UNIFORM_BLOCKS: 8 })],
    ["texture units 16+16 combined 32", profile({
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_TEXTURE_IMAGE_UNITS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32 })],
    ["combined texture units 96 alone", profile({ MAX_COMBINED_TEXTURE_IMAGE_UNITS: 96 })],
    ["four stencil masks", profile({
      STENCIL_VALUE_MASK: 4294967295, STENCIL_WRITEMASK: 4294967295,
      STENCIL_BACK_VALUE_MASK: 4294967295, STENCIL_BACK_WRITEMASK: 4294967295 })],
    ["the five optional limit names", profile({
      MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_ATTRIBS: 16,
      MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 120, UNIFORM_BUFFER_OFFSET_ALIGNMENT: 256 })],
  ])("accepts: %s", (_name, p) => {
    expect(validatePersonaProfileV2(p).valid).toBe(true);
  });

  it.each([
    ["blocks 12/12 combined 20", profile({}, blocks(12, 12, 20, 24)),
      "incoherent WebGL limits: webgl2 MAX_VERTEX_UNIFORM_BLOCKS (12) + MAX_FRAGMENT_UNIFORM_BLOCKS (12) exceeds MAX_COMBINED_UNIFORM_BLOCKS (20)"],
    ["the 14/12/24 example", profile({}, blocks(14, 12, 24, 24)),
      "incoherent WebGL limits: webgl2 MAX_VERTEX_UNIFORM_BLOCKS (14) + MAX_FRAGMENT_UNIFORM_BLOCKS (12) exceeds MAX_COMBINED_UNIFORM_BLOCKS (24)"],
    ["combined 24 bindings 16", profile({}, blocks(12, 12, 24, 16)),
      "incoherent WebGL limits: webgl2 MAX_COMBINED_UNIFORM_BLOCKS (24) exceeds MAX_UNIFORM_BUFFER_BINDINGS (16)"],
    ["only combined 20 present (defaults 12+12)", profile({}, { MAX_COMBINED_UNIFORM_BLOCKS: 20 }),
      "incoherent WebGL limits: webgl2 MAX_VERTEX_UNIFORM_BLOCKS (12) + MAX_FRAGMENT_UNIFORM_BLOCKS (12) exceeds MAX_COMBINED_UNIFORM_BLOCKS (20)"],
    ["only bindings 10 present (default combined 24)", profile({}, { MAX_UNIFORM_BUFFER_BINDINGS: 10 }),
      "incoherent WebGL limits: webgl2 MAX_COMBINED_UNIFORM_BLOCKS (24) exceeds MAX_UNIFORM_BUFFER_BINDINGS (10)"],
    ["merged: webgl2 combined 20 overwrites webgl1 12/12/24/24",
      profile(blocks(12, 12, 24, 24), { MAX_COMBINED_UNIFORM_BLOCKS: 20 }),
      "incoherent WebGL limits: webgl2 MAX_VERTEX_UNIFORM_BLOCKS (12) + MAX_FRAGMENT_UNIFORM_BLOCKS (12) exceeds MAX_COMBINED_UNIFORM_BLOCKS (20)"],
    ["texture units 20+16 combined 32 (webgl1 only)", profile({
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: 20, MAX_TEXTURE_IMAGE_UNITS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32 }),
      "incoherent WebGL limits: webgl1 MAX_VERTEX_TEXTURE_IMAGE_UNITS (20) + MAX_TEXTURE_IMAGE_UNITS (16) exceeds MAX_COMBINED_TEXTURE_IMAGE_UNITS (32)"],
    ["only vertex texture units 20 (default 16+20 > 32)", profile({ MAX_VERTEX_TEXTURE_IMAGE_UNITS: 20 }),
      "incoherent WebGL limits: webgl1 MAX_VERTEX_TEXTURE_IMAGE_UNITS (20) + MAX_TEXTURE_IMAGE_UNITS (16) exceeds MAX_COMBINED_TEXTURE_IMAGE_UNITS (32)"],
  ])("rejects with a message naming the relation and values: %s", (_name, p, message) => {
    const found = coherence(p);
    expect(found).toHaveLength(1);
    expect(found[0].message).toBe(message);
    expect(found[0].code).toBe("invariant");
  });

  it("rejects a non-integer present limit", () => {
    const found = coherence(profile({}, { MAX_COMBINED_UNIFORM_BLOCKS: 24.5 }));
    expect(found[0].message).toBe("MAX_COMBINED_UNIFORM_BLOCKS must be a non-negative integer, got 24.5");
  });

  it("an unknown (platform, family) pair has no rule; a known one does", () => {
    const bad = { MAX_COMBINED_UNIFORM_BLOCKS: 20 };
    expect(webglLimitViolations("android", "chromium", {}, bad)).toEqual([]);
    expect(webglLimitViolations("windows", "firefox", {}, bad)).toEqual([]);
    expect(webglLimitViolations("linux", "chromium", {}, bad)).toHaveLength(1);
    expect(webglLimitViolations("macos", "chromium", {}, bad)).toHaveLength(1);
  });
});
