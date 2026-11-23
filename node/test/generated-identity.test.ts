import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENERATED_IDENTITY_WRAPPER_VERSION,
  IdentityPersistenceError,
  createOrLoadGeneratedIdentity,
  loadPersistedIdentity,
  validatePersistedIdentity,
} from "../src/identity-persistence.js";
import { resolveIdentity } from "../src/identity.js";
import type { PopulationModel } from "../src/population-model.js";
import { CHROMIUM_MAJOR } from "../src/chromium-version.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../fixtures/synthetic/${name}`, import.meta.url)),
  "utf8",
)) as T;

function model(): PopulationModel {
  return fixture<{ model: PopulationModel }>("population-generate-v1.json").model;
}

const dirs: string[] = [];
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "ant0-generated-"));
  dirs.push(path);
  return path;
};
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function modelDir(): string {
  const dir = temp();
  writeFileSync(join(dir, "population-model-v1.json"), JSON.stringify(model()), "utf8");
  return dir;
}

describe("model-backed synthetic identity", () => {
  it("writes a v2 wrapper and reuses it authoritatively", () => {
    const identities = temp();
    const created = createOrLoadGeneratedIdentity("account-42", model(), { identityDir: identities });
    expect(created.schema_version).toBe(GENERATED_IDENTITY_WRAPPER_VERSION);
    expect(created.algorithm).toBe("ant0/persona-generate/v1");
    expect(created.algorithm_ref).toBe("population-model-fixture-1");
    expect(created.profile.metadata.source).toBe("synthetic");

    const shrunk = structuredClone(model());
    shrunk.groups.graphics!.values = shrunk.groups.graphics!.values.slice(0, 1);
    expect(createOrLoadGeneratedIdentity("account-42", shrunk, { identityDir: identities }))
      .toEqual(created);
    expect(loadPersistedIdentity("account-42", { identityDir: identities })).toEqual(created);
  });

  it("resolves synthetic identity from modelDirectory", () => {
    const identities = temp();
    const resolved = resolveIdentity({
      mode: "synthetic", key: "acct",
      modelDirectory: modelDir(), identityDirectory: identities,
    });
    expect(resolved.mode).toBe("synthetic");
    expect(resolved.fingerprintProfile?.compatibility.browser_major).toBe(CHROMIUM_MAJOR);
    const again = resolveIdentity({
      mode: "synthetic", key: "acct",
      modelDirectory: modelDir(), identityDirectory: identities,
    });
    expect(again.fingerprintProfile).toEqual(resolved.fingerprintProfile);
  });

  it("resolves synthetic identity from ANT0_BROWSER_MODEL_SOURCE", () => {
    const original = process.env.ANT0_BROWSER_MODEL_SOURCE;
    process.env.ANT0_BROWSER_MODEL_SOURCE = modelDir();
    try {
      const resolved = resolveIdentity({
        mode: "synthetic", key: "env-acct", identityDirectory: temp(),
      });
      expect(resolved.fingerprintProfile?.metadata.generator?.model_version)
        .toBe("population-model-fixture-1");
    } finally {
      if (original === undefined) delete process.env.ANT0_BROWSER_MODEL_SOURCE;
      else process.env.ANT0_BROWSER_MODEL_SOURCE = original;
    }
  });

  it("prefers modelDirectory over templateDirectory", () => {
    const resolved = resolveIdentity({
      mode: "synthetic", key: "prec",
      modelDirectory: modelDir(),
      templateDirectory: join(temp(), "does-not-exist"),
      identityDirectory: temp(),
    });
    expect(resolved.fingerprintProfile?.metadata.source).toBe("synthetic");
  });

  it("requires a source for a new synthetic identity", () => {
    const original = { model: process.env.ANT0_BROWSER_MODEL_SOURCE, tpl: process.env.ANT0_BROWSER_TEMPLATE_SOURCE };
    delete process.env.ANT0_BROWSER_MODEL_SOURCE;
    delete process.env.ANT0_BROWSER_TEMPLATE_SOURCE;
    try {
      expect(() => resolveIdentity({ mode: "synthetic", key: "nosource", identityDirectory: temp() }))
        .toThrow(/requires modelDirectory or templateDirectory/);
    } finally {
      if (original.model !== undefined) process.env.ANT0_BROWSER_MODEL_SOURCE = original.model;
      if (original.tpl !== undefined) process.env.ANT0_BROWSER_TEMPLATE_SOURCE = original.tpl;
    }
  });

  it("accepts a v2 wrapper and rejects a broken one", () => {
    const created = createOrLoadGeneratedIdentity("v", model(), { identityDir: temp() });
    expect(validatePersistedIdentity(created)).toBe(created);
    const wrongAlgo = structuredClone(created);
    wrongAlgo.algorithm = "ant0/persona-template-selection/v1" as any;
    expect(() => validatePersistedIdentity(wrongAlgo)).toThrow(/unsupported generate algorithm/);
    const unsafeRef = structuredClone(created);
    unsafeRef.algorithm_ref = "../escape";
    expect(() => validatePersistedIdentity(unsafeRef)).toThrow(/algorithm_ref is unsafe/);
  });
});
