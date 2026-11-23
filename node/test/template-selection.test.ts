import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InvalidPersonaProfileV2Error } from "../src/persona-profile-v2.js";
import { selectPersonaTemplate, type PersonaTemplate } from "../src/template-selection.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../fixtures/synthetic/${name}`, import.meta.url)),
  "utf8",
)) as T;

interface VectorFixture {
  template_ids: string[];
  vectors: Array<{ identity_key: string; device_key: string; selected_id: string }>;
}

function templates(): PersonaTemplate[] {
  const profile = fixture<Record<string, any>>("persona-v2.json");
  return fixture<VectorFixture>("template-selection-v1.json").template_ids.map((id) => {
    const item = structuredClone(profile);
    item.metadata.generator.model_version = id;
    return { id, profile: item };
  });
}

function selectedId(profile: any): string {
  return profile.metadata.generator.model_version as string;
}

describe("deterministic template selection", () => {
  it("matches the shared golden vectors", () => {
    const vectors = fixture<VectorFixture>("template-selection-v1.json").vectors;
    const pool = templates();
    for (const vector of vectors) {
      expect(selectedId(selectPersonaTemplate(vector.identity_key, vector.device_key, pool)))
        .toBe(vector.selected_id);
    }
  });

  it("is order-independent and returns a deep copy", () => {
    const pool = templates();
    const selected = selectPersonaTemplate("identity-0", "device-1", pool);
    expect(selectedId(selected)).toBe(selectedId(
      selectPersonaTemplate("identity-0", "device-1", [...pool].reverse()),
    ));
    selected.hardware.hardware_concurrency = 2;
    expect(pool.every((item) => (item.profile as any).hardware.hardware_concurrency === 8)).toBe(true);
  });

  it("is sensitive to identity and device keys", () => {
    const pool = templates();
    expect(selectedId(selectPersonaTemplate("identity-0", "device-1", pool)))
      .not.toBe(selectedId(selectPersonaTemplate("identity-2", "device-1", pool)));
    expect(selectedId(selectPersonaTemplate("alice", "device-1", pool)))
      .not.toBe(selectedId(selectPersonaTemplate("alice", "device-6", pool)));
  });

  it("validates every profile before selection", () => {
    const pool = templates();
    (pool.at(-1)!.profile as any).schema_version = 1;
    expect(() => selectPersonaTemplate("identity-0", "device-1", pool))
      .toThrow(InvalidPersonaProfileV2Error);
  });

  it.each(["", ".", "../escape", "has space", "é"])("rejects unsafe ID %j", (id) => {
    expect(() => selectPersonaTemplate("identity", "device", [{ id, profile: templates()[0].profile }]))
      .toThrow(/unsafe template id/);
  });

  it("rejects duplicate IDs and empty pools", () => {
    const profile = templates()[0].profile;
    expect(() => selectPersonaTemplate("identity", "device", [
      { id: "same", profile }, { id: "same", profile },
    ])).toThrow(/duplicate template id/);
    expect(() => selectPersonaTemplate("identity", "device", [])).toThrow(/must not be empty/);
  });
});
