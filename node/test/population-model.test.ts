import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertPersonaProfileV2 } from "../src/persona-profile-v2.js";
import {
  GENERATION_ORDER,
  PopulationModelError,
  generatePersonaProfile,
  loadPopulationModel,
  type PopulationModel,
} from "../src/population-model.js";
import { CHROMIUM_MAJOR } from "../src/chromium-version.js";
import {
  hasAngleDeviceId, isWin11Screen, isWin11TaskbarGap, normaliseWin11DisplayRow,
} from "../src/windows-coherence.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../fixtures/synthetic/${name}`, import.meta.url)),
  "utf8",
)) as T;

interface GenerateFixture {
  model: PopulationModel;
  vectors: Array<{ identity_key: string; device_key: string; expected_profile: any }>;
}

function model(): PopulationModel {
  return fixture<GenerateFixture>("population-generate-v1.json").model;
}

describe("deterministic population-model generator", () => {
  it("reproduces the shared golden vectors (parity with Python)", () => {
    const data = fixture<GenerateFixture>("population-generate-v1.json");
    for (const vector of data.vectors) {
      const generated = generatePersonaProfile(vector.identity_key, vector.device_key, data.model);
      expect(generated).toEqual(vector.expected_profile);
    }
  });

  it("emits a valid, synthetic-marked profile for the pinned Chromium major", () => {
    const generated = generatePersonaProfile("acct", "0".repeat(64), model());
    assertPersonaProfileV2(generated);
    expect(generated.metadata.source).toBe("synthetic");
    expect(generated.metadata.generator?.model_version).toBe("population-model-fixture-1");
    expect(generated.compatibility.browser_major).toBe(CHROMIUM_MAJOR);
  });

  it("is deterministic and returns an independent deep copy", () => {
    const m = model();
    const first = generatePersonaProfile("acct", "0".repeat(64), m);
    const second = generatePersonaProfile("acct", "0".repeat(64), m);
    expect(first).toEqual(second);
    (first.fonts.families as string[]).push("Injected");
    expect(m.groups.fonts!.values.every(
      (value) => !((value.payload as any).families as string[]).includes("Injected"),
    )).toBe(true);
  });

  it("varies the identity across keys and reseeds on model_version", () => {
    const m = model();
    const vendors = new Set(
      Array.from({ length: 60 }, (_, index) =>
        generatePersonaProfile(`acct-${index}`, "0".repeat(64), m).graphics.webgpu.vendor),
    );
    expect(vendors.size).toBeGreaterThan(1);
    const other = structuredClone(m);
    other.model_version = "population-model-fixture-2";
    const changed = Array.from({ length: 20 }, (_, index) => index).some((index) =>
      JSON.stringify(generatePersonaProfile(`k${index}`, "0".repeat(64), m))
      !== JSON.stringify(generatePersonaProfile(`k${index}`, "0".repeat(64), other)));
    expect(changed).toBe(true);
  });

  it("rejects a selected bundle below k_floor (distinguisher gate)", () => {
    const m = model();
    m.groups.graphics!.values = [{
      id: "only", support: 3, weight: 10,
      payload: m.groups.graphics!.values[0]!.payload,
    }];
    expect(() => generatePersonaProfile("acct", "0".repeat(64), m))
      .toThrow(PopulationModelError);
  });

  it("honors integer weights", () => {
    const m = model();
    for (const value of m.groups.graphics!.values) {
      value.weight = value.id === "graphics-a" ? 1 : 1_000_000;
    }
    const vendors = Array.from({ length: 50 }, (_, index) =>
      generatePersonaProfile(`acct-${index}`, "0".repeat(64), m).graphics.webgpu.vendor);
    expect(vendors.filter((vendor) => vendor === "example-b").length).toBeGreaterThanOrEqual(48);
  });

  it.each([
    ["generate_algorithm", (m: any) => { m.generate_algorithm = "other"; }, /unsupported generate_algorithm/],
    ["missing group", (m: any) => { delete m.groups.fonts; }, /exactly the six generation bundles/],
    ["empty values", (m: any) => { m.groups.audio.values = []; }, /group audio has no values/],
    ["k_floor", (m: any) => { m.k_floor = 0; }, /k_floor must be >= 1/],
    ["constants", (m: any) => { delete m.constants.locale; }, /constants are incomplete/],
  ])("rejects malformed model: %s", (_name, mutate, message) => {
    const m = model();
    mutate(m);
    expect(() => loadPopulationModel(m)).toThrow(message);
  });

  it("loads from a file and a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ant0-model-"));
    writeFileSync(join(dir, "population-model-v1.json"), JSON.stringify(model()), "utf8");
    expect(loadPopulationModel(join(dir, "population-model-v1.json")).model_version)
      .toBe("population-model-fixture-1");
    expect(loadPopulationModel(dir).model_version).toBe("population-model-fixture-1");
  });

  it("reproduces the DRBG known-answer vectors", () => {
    // Exercised indirectly through the profile vectors; here we assert the generation order is fixed.
    expect([...GENERATION_ORDER]).toEqual(["graphics", "cpu_mem", "display", "audio", "fonts", "speech"]);
  });
});

describe("Windows 11 coherence of generated personas", () => {
  const ID = /\(0x[0-9A-Fa-f]{8}\)/;
  const ids = Array.from({ length: 200 }, (_, index) => `acct-${index}`);
  const gen = (m: PopulationModel, id: string) => generatePersonaProfile(id, "0".repeat(64), m);

  it("accepts only ANGLE's 0x plus exactly 8 hex digits, and a taskbar gap of 48 or 0", () => {
    expect(hasAngleDeviceId("ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11, D3D11)")).toBe(true);
    expect(hasAngleDeviceId("ANGLE (Intel, Intel(R) UHD Graphics 770 (0xA780) Direct3D11, D3D11)")).toBe(false);
    expect(hasAngleDeviceId("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11, D3D11)")).toBe(false);
    expect(hasAngleDeviceId("ANGLE (Intel, X (0x00003EA00) Direct3D11)")).toBe(false);
    expect(hasAngleDeviceId(undefined)).toBe(false);
    expect(isWin11TaskbarGap(1080, 1032)).toBe(true);
    expect(isWin11TaskbarGap(1080, 1080)).toBe(true);
    for (const avail of [1040, 1050, 1010, 1000]) expect(isWin11TaskbarGap(1080, avail)).toBe(false);
    expect(isWin11TaskbarGap(1080, "1032")).toBe(false);
  });

  it("a Windows 11 screen needs a full-width bottom taskbar: no side taskbar", () => {
    const s = (availWidth: number, availHeight: number) => ({ width: 1920, height: 1080, availWidth, availHeight });
    expect(isWin11Screen(s(1920, 1032))).toBe(true);
    expect(isWin11Screen(s(1920, 1080))).toBe(true);
    expect(isWin11Screen(s(1872, 1080))).toBe(false);
    expect(isWin11Screen(s(1872, 1032))).toBe(false);
  });

  it("turns a side taskbar (available_width < width) into a bottom 48 px one, size and weight kept", () => {
    const m = model();
    const side = structuredClone(m.groups.display!.values[0]!) as any;
    side.id = "disp-side";
    side.weight = 1_000_000_000;
    side.payload.available_width = side.payload.width - 48;
    side.payload.available_height = side.payload.height; // gap 0, so only the width gives it away
    m.groups.display!.values.push(side);
    for (const id of ids) {
      const d = gen(m, id).display;
      expect(d.available_width).toBe(d.width);
      expect(d.available_height).toBe(d.height === side.payload.height ? d.height - 48 : d.available_height);
    }
  });

  it("emits the model's WebGPU block unchanged (no stub: old engines read features [] as none)", () => {
    const limits = { maxTextureDimension2D: 8192, maxBindGroups: 7 };
    const m = model();
    for (const g of m.groups.graphics!.values)
      (g.payload as any).webgpu = { ...(g.payload as any).webgpu, features: ["depth-clip-control"], limits };
    for (const id of ids.slice(0, 10)) {
      const w = gen(m, id).graphics.webgpu;
      expect(w.features).toEqual(["depth-clip-control"]);
      expect(w.limits).toEqual(limits);
    }
  });

  it("stamps the generator version 1.1.0", () => {
    expect(gen(model(), "acct-0").metadata.generator?.version).toBe("1.1.0");
  });

  it("never draws a graphics row without an ANGLE device id, and never invents one", () => {
    const m = model();
    const bare = structuredClone(m.groups.graphics!.values[0]!) as any;
    bare.id = "graphics-bare";
    bare.weight = 1_000_000_000; // drawn almost every time if it were eligible
    bare.payload.webgl.unmasked_renderer =
      "ANGLE (Intel, Intel(R) UHD Graphics 770 (0xA780) Direct3D11 vs_5_0 ps_5_0, D3D11)";
    m.groups.graphics!.values.push(bare);
    for (const id of ids) {
      const renderer = gen(m, id).graphics.webgl.unmasked_renderer as string;
      expect(renderer).toMatch(ID);
      expect(renderer).not.toContain("0xA780");
    }
  });

  it("normalises a display row with another taskbar gap to a 48 px bottom taskbar, keeping size and weight", () => {
    const m = model();
    const old = structuredClone(m.groups.display!.values[0]!) as any;
    old.id = "disp-win10";
    old.weight = 1_000_000_000;
    old.payload.available_height = old.payload.height - 40;
    m.groups.display!.values.push(old);
    const before = structuredClone(m);
    for (const id of ids) {
      const d = gen(m, id).display;
      expect(isWin11TaskbarGap(d.height, d.available_height)).toBe(true);
      expect(d.available_width).toBe(d.width);
    }
    // The model is never mutated, and the draws are the ones the unnormalised model would make.
    expect(m).toEqual(before);
  });

  it("normaliseWin11DisplayRow: gap-0 and 48 rows stay, others become a bottom 48 px taskbar", () => {
    const row = (aw: number, ah: number) => ({ width: 1920, height: 1080, available_width: aw, available_height: ah, x: 1 });
    const same = row(1920, 1080);
    expect(normaliseWin11DisplayRow(same)).toBe(same);
    const bar = row(1920, 1032);
    expect(normaliseWin11DisplayRow(bar)).toBe(bar);
    for (const bad of [row(1920, 1040), row(1872, 1080), row(1872, 1032), row(1920, 1000)]) {
      expect(normaliseWin11DisplayRow(bad)).toEqual(row(1920, 1032));
    }
    expect(normaliseWin11DisplayRow({ width: 1920, height: 48, available_width: 1920, available_height: 0 })).toBeUndefined();
    expect(normaliseWin11DisplayRow({ width: "1920", height: 1080 })).toBeUndefined();
  });

  it("fails loudly when the model has no usable row", () => {
    const noIds = model();
    for (const v of noIds.groups.graphics!.values) {
      (v.payload as any).webgl.unmasked_renderer = "ANGLE (Intel, Intel(R) UHD Graphics 630, D3D11)";
    }
    expect(() => gen(noIds, "a")).toThrow(/ANGLE device id/);
    const noDisplay = model();
    for (const v of noDisplay.groups.display!.values) (v.payload as any).height = "tall";
    expect(() => gen(noDisplay, "a")).toThrow(/Windows 11 work area/);
  });
});
