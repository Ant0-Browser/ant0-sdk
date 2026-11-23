// The persona file (ant0-persona.profile) is read by the engine once at startup: it does not stay in a
// profile directory the caller keeps, and a temporary persona directory goes with a signal too.

import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchPersistentContext, launchPlan } from "../src/index.js";
import { PROFILE_FILE_NAME, assertPersonaFitsEngine, stagePersonaProfile, type SdkInfoProbe } from "../src/profile-file.js";

const posix = process.platform === "win32" ? it.skip : it;
const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "ant0-life-")); roots.push(p); return p; };
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const v4 = () => ({
  schema_version: 4, schema_revision: 1, requires: ["display"],
  provenance: { source: "synthetic", model: { version: "population-model-v2.2", sha256: "0".repeat(64) } },
  identity: {
    os: { family: "windows", release: "windows-11", platform_version: "19.0.0", architecture: "x86_64" },
    engine: { family: "blink", major: 158 }, brand: { id: "edge", version: "158.0.4370.16" },
    form_factor: "desktop", device_model: "",
  },
  surfaces: { display: { width: 1920 } },
});
const INFO = JSON.stringify({ sdk_protocol: 2, persona: { schemas: [2, 4], revision: 1, engine_family: "blink", engine_major: 158, capabilities: ["display"] } });
const fakeEngine = () => {
  const path = join(temp(), "chrome");
  writeFileSync(path, `#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\ncat <<'JSON'\n${INFO}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
};
const opts = (engine: string) => ({
  executablePath: engine, identity: { mode: "captured", source: v4() }, headless: true, quiet: true, launchTicket: false,
}) as any;

describe("persona file in a persistent profile", () => {
  posix("launchPersistentContext removes it once the browser is up, so nothing is left in the kept profile", async () => {
    const udd = temp();
    const seen: boolean[] = [];
    const fake = Object.assign(new EventEmitter(), { newPage: async () => ({}), pages: () => [] });
    vi.spyOn(chromium, "launchPersistentContext").mockImplementation((async () => {
      seen.push(existsSync(join(udd, PROFILE_FILE_NAME))); // there while the engine starts
      return fake;
    }) as any);
    await launchPersistentContext(udd, opts(fakeEngine()));
    expect(seen).toEqual([true]);
    expect(existsSync(join(udd, PROFILE_FILE_NAME))).toBe(false);
    expect(readdirSync(udd).filter((f) => f.includes("persona"))).toEqual([]);
  });
  posix("a failed launch leaves none either", async () => {
    const udd = temp();
    vi.spyOn(chromium, "launchPersistentContext").mockImplementation((async () => { throw new Error("stop"); }) as any);
    await expect(launchPersistentContext(udd, opts(fakeEngine()))).rejects.toThrow("stop");
    expect(existsSync(join(udd, PROFILE_FILE_NAME))).toBe(false);
  });
  posix("launchPlan exposes the file and removePersonaFile deletes it (idempotent); a native plan has none", async () => {
    const udd = temp();
    const plan = await launchPlan({ ...opts(fakeEngine()), userDataDir: udd });
    expect(plan.personaFile).toBe(join(udd, PROFILE_FILE_NAME));
    expect(existsSync(plan.personaFile!)).toBe(true);
    expect(plan.args).toContain(`--fingerprint-profile-file=${plan.personaFile}`);
    plan.removePersonaFile();
    plan.removePersonaFile();
    expect(existsSync(plan.personaFile!)).toBe(false);
    const native = await launchPlan({ executablePath: fakeEngine(), identity: { mode: "native" }, headless: true, quiet: true, launchTicket: false, userDataDir: temp() } as any);
    expect(native.personaFile).toBeUndefined();
    expect(() => native.removePersonaFile()).not.toThrow();
  });
  it("removeFile on a staged persona deletes only that file", async () => {
    const udd = temp();
    writeFileSync(join(udd, "Preferences"), "{}");
    const probe: SdkInfoProbe = async () => ({ completed: true, stdout: INFO });
    const staged = await stagePersonaProfile({ fingerprintProfile: v4() as any }, "/x/chrome", udd, { probe, run: async () => "", platform: "linux" });
    expect(existsSync(join(udd, PROFILE_FILE_NAME))).toBe(true);
    staged.removeFile();
    staged.removeFile();
    expect(readdirSync(udd)).toEqual(["Preferences"]);
  });
});

describe("the engine that starts is the one that was checked", () => {
  it("assertPersonaFitsEngine refuses an engine without schema 4 or without a required capability", async () => {
    const old: SdkInfoProbe = async () => ({ completed: true, stdout: JSON.stringify({ sdk_protocol: 1 }) });
    await expect(assertPersonaFitsEngine(v4(), "/old/chrome", old)).rejects.toMatchObject({ code: "sdk.persona_requires_engine" });
    const missing: SdkInfoProbe = async () => ({ completed: true, stdout: JSON.stringify({ sdk_protocol: 2, persona: { schemas: [4], capabilities: ["navigator"] } }) });
    await expect(assertPersonaFitsEngine(v4(), "/other/chrome", missing)).rejects.toMatchObject({ code: "sdk.persona_capability_missing" });
    const ok: SdkInfoProbe = async () => ({ completed: true, stdout: INFO });
    await expect(assertPersonaFitsEngine(v4(), "/new/chrome", ok)).resolves.toBeUndefined();
    await expect(assertPersonaFitsEngine({ schema_version: 2 }, "/old/chrome", old)).resolves.toBeUndefined(); // no v4: nothing to check
  });
});

describe("the temporary persona directory and signals", () => {
  it("a SIGINT or SIGTERM removes it (another listener keeps the process alive here)", async () => {
    const probe: SdkInfoProbe = async () => ({ completed: true, stdout: INFO });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const keep = () => {};
      process.on(signal, keep);
      try {
        const staged = await stagePersonaProfile({ fingerprintProfile: v4() as any }, "/x/chrome", undefined, { probe, run: async () => "", platform: "linux" });
        const path = staged.fingerprint.fingerprintProfileFile!;
        expect(existsSync(path)).toBe(true);
        process.emit(signal, signal);
        expect(existsSync(path), signal).toBe(false);
      } finally { process.removeListener(signal, keep); }
    }
  });
});
