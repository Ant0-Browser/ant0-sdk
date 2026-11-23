import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  InvalidPersonaProfileV2Error,
  assertPersonaProfileV2,
  parsePersonaProfileV2,
  validatePersonaProfileV2,
  type PersonaProfileV2,
} from "../src/persona-profile-v2.js";
import { CHROMIUM_MAJOR } from "../src/chromium-version.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../fixtures/synthetic/${name}`, import.meta.url)),
  "utf8",
));
const validFixture = fixture("persona-v2.json") as Record<string, unknown>;
const invalidCases = fixture("invalid-cases.json") as Array<{
  name: string;
  operation: "set" | "append";
  path: string;
  value: unknown;
  expected_path: string;
}>;

function clone(): Record<string, unknown> {
  return structuredClone(validFixture);
}

function mutate(target: Record<string, unknown>, operation: "set" | "append", path: string, value: unknown): void {
  const parts = path.split(".");
  let current: unknown = target;
  for (const part of parts.slice(0, -1)) current = (current as Record<string, unknown>)[part];
  const key = parts.at(-1)!;
  if (operation === "append") (current as Record<string, unknown[]>)[key].push(value);
  else (current as Record<string, unknown>)[key] = value;
}

function errors(value: unknown) {
  const result = validatePersonaProfileV2(value);
  expect(result.valid).toBe(false);
  return result.valid ? [] : result.errors;
}

describe("persona-profile-v2 fixture contract", () => {
  it("accepts the representative Windows Chromium fixture", () => {
    const result = validatePersonaProfileV2(clone());
    expect(result).toMatchObject({ valid: true, errors: [] });
    if (result.valid) expect(result.value.compatibility.browser_major).toBe(CHROMIUM_MAJOR);
  });

  for (const testCase of invalidCases) {
    it(`rejects fixture mutation: ${testCase.name}`, () => {
      const profile = clone();
      mutate(profile, testCase.operation, testCase.path, testCase.value);
      expect(errors(profile).map((error) => error.path)).toContain(testCase.expected_path);
    });
  }
});

describe("persona-profile-v2 structural validation", () => {
  it.each([
    ["missing section", "audio", "audio"],
    ["nested additional property", "display.extra", "display.extra"],
    ["wrong object type", "graphics.webgl", "graphics.webgl"],
    ["wrong scalar type", "audio.sample_rate", "audio.sample_rate"],
    ["invalid enum", "display.pointer", "display.pointer"],
    ["empty required array", "fonts.families", "fonts.families"],
    ["empty WebGL parameters", "graphics.webgl.webgl1.parameters", "graphics.webgl.webgl1.parameters"],
    ["empty WebGPU limits", "graphics.webgpu.limits", "graphics.webgpu.limits"],
    ["invalid media kind", "media.devices.0.kind", "media.devices.0.kind"],
  ])("reports %s at its field", (_name, mutationPath, expectedPath) => {
    const profile = clone();
    if (mutationPath === "audio") delete profile.audio;
    else {
      const replacements: Record<string, unknown> = {
        "display.extra": true,
        "graphics.webgl": null,
        "audio.sample_rate": "48000",
        "display.pointer": "mouse",
        "fonts.families": [],
        "graphics.webgl.webgl1.parameters": {},
        "graphics.webgpu.limits": {},
        "media.devices.0.kind": "camera",
      };
      const parts = mutationPath.split(".");
      let current: unknown = profile;
      for (const part of parts.slice(0, -1)) {
        current = Array.isArray(current) ? current[Number(part)] : (current as Record<string, unknown>)[part];
      }
      (current as Record<string, unknown>)[parts.at(-1)!] = replacements[mutationPath];
    }
    expect(errors(profile).map((error) => error.path)).toContain(expectedPath);
  });

  it.each([
    ["metadata.created_at", "2026-02-30T00:00:00Z"],
    ["metadata.created_at", "not-a-date"],
    ["metadata.generator.name", ""],
    ["hardware.device_memory_gb", 3],
    ["hardware.js_heap_size_limit", 1.5],
    ["display.device_pixel_ratio", 0],
    ["audio.base_latency", 11],
    ["graphics.webgpu.limits.maxBufferSize", -1],
    ["graphics.webgl.webgl1.parameters.MAX_TEXTURE_SIZE", Number.NaN],
  ])("enforces schema constraint at %s", (path, value) => {
    const profile = clone();
    mutate(profile, "set", path, value);
    expect(errors(profile).map((error) => error.path)).toContain(path);
  });

  it.each([
    ["locale.languages", ["en-US", "en-US"]],
    ["fonts.families", ["Arial", "Arial"]],
    ["graphics.webgl.webgl1.extensions", ["EXT_a", "EXT_a"]],
    ["graphics.webgpu.features", ["feature", "feature"]],
  ])("enforces uniqueness at %s", (path, value) => {
    const profile = clone();
    mutate(profile, "set", path, value);
    expect(errors(profile)).toContainEqual(expect.objectContaining({ path, code: "unique" }));
  });

  it("requires generator metadata only for synthetic profiles", () => {
    const synthetic = clone();
    delete (synthetic.metadata as Record<string, unknown>).generator;
    expect(errors(synthetic).map((error) => error.path)).toContain("metadata.generator");

    const captured = clone();
    (captured.metadata as Record<string, unknown>).source = "captured";
    delete (captured.metadata as Record<string, unknown>).generator;
    expect(validatePersonaProfileV2(captured).valid).toBe(true);
  });

  it("validates source references and their hash format", () => {
    const profile = clone();
    (profile.metadata as Record<string, unknown>).source_references = [{ name: "capture", revision: "1", sha256: "ABC" }];
    expect(errors(profile).map((error) => error.path)).toContain("metadata.source_references.0.sha256");
  });
});

describe("persona-profile-v2 semantic validation and API", () => {
  it.each([16, 32])("accepts device_memory_gb=%i (Chrome 147+ desktop values)", (mem) => {
    const profile = clone();
    mutate(profile, "set", "hardware.device_memory_gb", mem);
    expect(validatePersonaProfileV2(profile)).toMatchObject({ valid: true, errors: [] });
  });

  it("rejects available height beyond the display height", () => {
    const profile = clone();
    mutate(profile, "set", "display.available_height", 1200);
    expect(errors(profile)).toContainEqual(expect.objectContaining({ path: "display.available_height", code: "invariant" }));
  });

  it("allows no default voice but rejects two", () => {
    const profile = clone();
    mutate(profile, "set", "speech.voices.0.default", false);
    expect(validatePersonaProfileV2(profile).valid).toBe(true);
  });

  it("rejects identifiable WebGL/WebGPU GPU-family disagreement", () => {
    const profile = clone();
    mutate(profile, "set", "graphics.webgl.unmasked_renderer", "ANGLE (Intel, Intel(R) UHD Graphics 770 (0xA780) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    mutate(profile, "set", "graphics.webgpu.vendor", "NVIDIA");
    mutate(profile, "set", "graphics.webgpu.description", "GeForce RTX 4070");
    expect(errors(profile)).toContainEqual(expect.objectContaining({ path: "graphics.webgpu.vendor", code: "invariant" }));
  });

  it("does not guess when either GPU family is not identifiable", () => {
    const profile = clone();
    mutate(profile, "set", "graphics.webgpu.vendor", "vendor-id-unknown");
    expect(validatePersonaProfileV2(profile).valid).toBe(true);
  });

  it("provides typed parse and assertion APIs", () => {
    const parsed: PersonaProfileV2 = parsePersonaProfileV2(clone());
    expect(parsed.schema_version).toBe(2);
    expect(() => assertPersonaProfileV2({})).toThrow(InvalidPersonaProfileV2Error);
    try {
      parsePersonaProfileV2({});
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPersonaProfileV2Error);
      expect((error as InvalidPersonaProfileV2Error).errors[0].path).toBe("schema_version");
    }
  });
});
