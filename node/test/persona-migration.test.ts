/**
 * Persona migration across a Chromium engine upgrade.
 *
 * The contract under test ("profiles keep their machine"): an engine
 * upgrade rewrites only the browser-version fields and leaves the simulated machine identical.
 * Mirrors python/tests/test_persona_migration.py — the two SDKs must agree.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHROMIUM_MAJOR } from "../src/chromium-version.js";
import {
  MIGRATED_FIELDS,
  PersonaMigrationError,
  migratePersonaBrowserMajor,
  needsMigration,
  personaBrowserMajor,
} from "../src/persona-migration.js";
import { assertPersonaProfileV2 } from "../src/persona-profile-v2.js";

const profile = (): Record<string, any> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../fixtures/synthetic/persona-v2.json", import.meta.url)),
      "utf8",
    ),
  );

const atOld = (): Record<string, any> => {
  const p = profile();
  p.compatibility.browser_major = CHROMIUM_MAJOR - 1;
  return p;
};

describe("persona migration", () => {
  it("migrates exactly one field", () => {
    expect(MIGRATED_FIELDS).toEqual(["compatibility.browser_major"]);
  });

  it("keeps the machine byte-identical", () => {
    const old = atOld();
    const migrated = migratePersonaBrowserMajor(old, CHROMIUM_MAJOR);
    expect(migrated.compatibility.browser_major).toBe(CHROMIUM_MAJOR);

    const a = JSON.parse(JSON.stringify(old));
    const b = JSON.parse(JSON.stringify(migrated));
    delete a.compatibility.browser_major;
    delete b.compatibility.browser_major;
    expect(b).toEqual(a);

    for (const group of ["hardware", "display", "locale", "graphics", "audio", "fonts", "speech", "media"]) {
      expect(migrated[group]).toEqual(old[group]);
    }
  });

  it("does not mutate its input", () => {
    const old = atOld();
    const snapshot = JSON.parse(JSON.stringify(old));
    migratePersonaBrowserMajor(old, CHROMIUM_MAJOR);
    expect(old).toEqual(snapshot);
  });

  it("is deterministic and idempotent", () => {
    const old = atOld();
    const once = migratePersonaBrowserMajor(old, CHROMIUM_MAJOR);
    expect(migratePersonaBrowserMajor(old, CHROMIUM_MAJOR)).toEqual(once);
    expect(migratePersonaBrowserMajor(once, CHROMIUM_MAJOR)).toEqual(once);
  });

  it("is a no-op when the major already matches", () => {
    const old = profile();
    expect(migratePersonaBrowserMajor(old, old.compatibility.browser_major)).toEqual(old);
  });

  it("an old persona loads unchanged; migration is only a tidy-up", () => {
    const old = atOld();
    expect(() => assertPersonaProfileV2(old)).not.toThrow();
    expect(() => assertPersonaProfileV2(migratePersonaBrowserMajor(old))).not.toThrow();
  });

  it("defaults to the pinned engine major", () => {
    expect(migratePersonaBrowserMajor(atOld()).compatibility.browser_major).toBe(CHROMIUM_MAJOR);
  });

  it("reports when a persona needs migration", () => {
    const old = atOld();
    expect(needsMigration(old)).toBe(true);
    expect(needsMigration(migratePersonaBrowserMajor(old))).toBe(false);
  });

  it("reads the declared major defensively", () => {
    expect(personaBrowserMajor(profile())).toBe(CHROMIUM_MAJOR);
    expect(personaBrowserMajor({})).toBeUndefined();
    expect(personaBrowserMajor({ compatibility: {} })).toBeUndefined();
    expect(personaBrowserMajor(null)).toBeUndefined();
    expect(personaBrowserMajor({ compatibility: { browser_major: "154" } })).toBeUndefined();
  });

  it("refuses a malformed profile rather than inventing a major", () => {
    expect(() => migratePersonaBrowserMajor({ compatibility: {} })).toThrow(PersonaMigrationError);
    expect(() => migratePersonaBrowserMajor({})).toThrow(PersonaMigrationError);
  });

  it.each([0, 99, 1000, 154.5, Number.NaN])("refuses implausible target major %s", (bad) => {
    expect(() => migratePersonaBrowserMajor(profile(), bad as number)).toThrow(PersonaMigrationError);
  });
});
