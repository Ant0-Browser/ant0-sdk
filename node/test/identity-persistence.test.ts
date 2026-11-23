import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IdentityPersistenceError,
  createOrLoadIdentity,
  identityFilename,
  loadOrCreateDeviceKey,
  loadPersistedIdentity,
  resolveIdentityDirectory,
  validatePersistedIdentity,
} from "../src/identity-persistence.js";
import type { PersonaTemplate } from "../src/template-selection.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../fixtures/synthetic/${name}`, import.meta.url)),
  "utf8",
)) as T;

const dirs: string[] = [];
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "ant0-identity-test-"));
  dirs.push(path);
  return path;
};
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function templates(ids = ["desktop-a", "laptop-b", "workstation-c"]): PersonaTemplate[] {
  const profile = fixture<Record<string, any>>("persona-v2.json");
  return ids.map((id) => {
    const item = structuredClone(profile);
    item.metadata.generator.model_version = id;
    return { id, profile: item };
  });
}

describe("identity persistence", () => {
  it("matches shared opaque filename vectors", () => {
    const vectors = fixture<{ device_key_hex: string; vectors: Array<{ identity_key: string; filename: string }> }>("identity-persistence-v1.json");
    const key = Buffer.from(vectors.device_key_hex, "hex");
    for (const vector of vectors.vectors) {
      expect(identityFilename(vector.identity_key, key)).toBe(vector.filename);
      if (vector.identity_key) expect(vector.filename).not.toContain(vector.identity_key);
    }
  });

  it.each([undefined, ""])("resolves the environment override and default (%s)", (override) => {
    try {
      vi.stubEnv("ANT0_BROWSER_IDENTITY_DIR", "/tmp/ant0-explicit-identities");
      expect(resolveIdentityDirectory()).toBe("/tmp/ant0-explicit-identities");
      vi.stubEnv("ANT0_BROWSER_IDENTITY_DIR", override);
      expect(resolveIdentityDirectory()).toBe(join(homedir(), ".ant0-browser", "identities"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("creates one stable private 32-byte device key", () => {
    const dir = temp();
    const first = loadOrCreateDeviceKey({ identityDir: dir });
    expect(loadOrCreateDeviceKey({ identityDir: dir })).toEqual(first);
    expect(first).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "device.key")).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects a corrupt device key", () => {
    const dir = temp();
    writeFileSync(join(dir, "device.key"), "short");
    expect(() => createOrLoadIdentity("identity", templates(), { identityDir: dir }))
      .toThrow(/exactly 32 bytes/);
  });

  it("writes the shared shape and reuses it after the pool changes", () => {
    const dir = temp();
    const created = createOrLoadIdentity("account-42", templates(), { identityDir: dir });
    const key = readFileSync(join(dir, "device.key"));
    const path = join(dir, identityFilename("account-42", key));
    const encoded = readFileSync(path, "utf8");
    const stored = JSON.parse(encoded) as Record<string, unknown>;
    const vectors = fixture<{ wrapper_fields: string[]; wrapper_schema_version: number; template_selection_algorithm: string }>("identity-persistence-v1.json");
    expect(Object.keys(stored)).toEqual([...vectors.wrapper_fields].sort());
    expect(stored).toEqual(created);
    expect(encoded).not.toContain("account-42");
    expect(created.schema_version).toBe(vectors.wrapper_schema_version);
    expect(created.template_selection_algorithm).toBe(vectors.template_selection_algorithm);
    expect(createOrLoadIdentity("account-42", [], { identityDir: dir })).toEqual(created);
    expect(loadPersistedIdentity("account-42", { identityDir: dir })).toEqual(created);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats an existing valid file as the authoritative concurrent winner", () => {
    const dir = temp();
    const winner = createOrLoadIdentity("shared", templates(["desktop-a"]), { identityDir: dir });
    const loaded = createOrLoadIdentity("shared", templates(["workstation-c"]), { identityDir: dir });
    expect(loaded).toEqual(winner);
    expect(loaded.template_id).toBe("desktop-a");
  });

  it.each(["json", "version", "profile", "unknown"])("rejects corrupt persisted data: %s", (mutation) => {
    const dir = temp();
    createOrLoadIdentity("broken", templates(), { identityDir: dir });
    const key = readFileSync(join(dir, "device.key"));
    const path = join(dir, identityFilename("broken", key));
    const value = JSON.parse(readFileSync(path, "utf8")) as any;
    if (mutation === "json") writeFileSync(path, "{");
    else {
      if (mutation === "version") value.schema_version = 2;
      else if (mutation === "profile") value.profile.schema_version = 1;
      else value.identity_key = "broken";
      writeFileSync(path, JSON.stringify(value));
    }
    expect(() => createOrLoadIdentity("broken", templates(), { identityDir: dir }))
      .toThrow(IdentityPersistenceError);
  });

  it("strictly validates complete wrappers", () => {
    const value = {
      schema_version: 1,
      template_selection_algorithm: "ant0/persona-template-selection/v1",
      template_id: "desktop-a",
      created_at: "2026-08-24T12:34:56Z",
      profile: templates(["desktop-a"])[0].profile,
    };
    expect(validatePersistedIdentity(value)).toBe(value);
  });
});
