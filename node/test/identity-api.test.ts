import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintArgs } from "../src/fingerprint.js";
import { loadTemplateDirectory, prepareIdentityOptions, resolveIdentity } from "../src/identity.js";
import { launch, serve } from "../src/index.js";

const fixturePath = new URL("../../fixtures/synthetic/persona-v2.json", import.meta.url);
const profile = () => JSON.parse(readFileSync(fixturePath, "utf8"));
const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "ant0-identity-api-")); roots.push(path); return path; };
const writeTemplate = (directory: string, name = "desktop-a.json") => writeFileSync(join(directory, name), JSON.stringify(profile()));

afterEach(() => {
  delete process.env.ANT0_BROWSER_TEMPLATE_SOURCE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("three-mode identity API", () => {
  it.each([null, {}, { mode: "other" }, { mode: "native", key: "x" }])("strictly validates modes", (identity) => {
    expect(() => resolveIdentity(identity as never)).toThrow();
  });

  it("loads and validates captured object, JSON, and path with locale", () => {
    const root = temp();
    const path = join(root, "captured.json");
    writeFileSync(path, JSON.stringify(profile()));
    for (const source of [profile(), JSON.stringify(profile()), path]) {
      const resolved = resolveIdentity({ mode: "captured", source });
      expect(resolved.fingerprintProfile?.locale).toEqual(profile().locale);
    }
    const broken = profile();
    broken.schema_version = 1;
    expect(() => resolveIdentity({ mode: "captured", source: broken })).toThrow(/schema_version/);
  });

  it("loads templates in deterministic order and rejects nonfiles", () => {
    const root = temp();
    writeTemplate(root, "z.json");
    writeTemplate(root, "a.json");
    writeFileSync(join(root, "notes.txt"), "ignored");
    expect(loadTemplateDirectory(root).map(({ id }) => id)).toEqual(["a", "z"]);
    mkdirSync(join(root, "nested"));
    expect(() => loadTemplateDirectory(root)).toThrow(/not a regular file/);
  });

  it("rejects empty, unsafe, and invalid template pools", () => {
    const root = temp();
    const empty = join(root, "empty"); mkdirSync(empty);
    expect(() => loadTemplateDirectory(empty)).toThrow(/no .json profiles/);
    const unsafe = join(root, "unsafe"); mkdirSync(unsafe); writeTemplate(unsafe, "bad name.json");
    expect(() => loadTemplateDirectory(unsafe)).toThrow(/unsafe/);
    const invalid = join(root, "invalid"); mkdirSync(invalid); writeFileSync(join(invalid, "bad.json"), "{}");
    expect(() => loadTemplateDirectory(invalid)).toThrow(/invalid template/);
  });

  it("rejects symlink template entries when the host permits creating them", () => {
    const root = temp();
    const links = join(root, "links"); mkdirSync(links);
    const target = join(root, "target.json"); writeFileSync(target, JSON.stringify(profile()));
    try {
      symlinkSync(target, join(links, "link.json"));
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() => loadTemplateDirectory(links)).toThrow(/not a regular file/);
  });

  it("creates and reuses a synthetic persisted profile", () => {
    const root = temp();
    const templates = join(root, "templates"); mkdirSync(templates); writeTemplate(templates);
    const identityDirectory = join(root, "identities");
    const option = { mode: "synthetic" as const, key: "account-42", templateDirectory: templates, identityDirectory };
    const first = resolveIdentity(option).fingerprintProfile;
    rmSync(templates, { recursive: true, force: true });
    expect(resolveIdentity({
      mode: "synthetic", key: "account-42", identityDirectory,
    }).fingerprintProfile).toEqual(first);
  });

  it("uses the template env and reports a missing source", () => {
    expect(() => resolveIdentity({ mode: "synthetic", key: "x" })).toThrow(/ANT0_BROWSER_TEMPLATE_SOURCE/);
    const root = temp(); const templates = join(root, "templates"); mkdirSync(templates); writeTemplate(templates);
    process.env.ANT0_BROWSER_TEMPLATE_SOURCE = templates;
    expect(resolveIdentity({ mode: "synthetic", key: "x", identityDirectory: join(root, "ids") }).mode).toBe("synthetic");
  });

  it("keeps camelCase API options separate from Python snake_case", () => {
    expect(() => resolveIdentity({ mode: "synthetic", key: "x", template_directory: "/tmp" } as never)).toThrow(/directory options/);
  });

  it("does not export saved-option or auto-profile launch APIs", async () => {
    const api = await import("../src/index.js") as Record<string, unknown>;
    for (const name of ["Profile", "listProfiles", "loadProfile", "resolveAuto", "resolveLocal"]) {
      expect(api[name]).toBeUndefined();
    }
  });

  it("rejects removed identity options whether identity is explicit or omitted", async () => {
    await expect(launch({ fingerprint: "legacy" } as never)).rejects.toThrow(/identity.*overrides/);
    await expect(launch({ identity: { mode: "native" }, fingerprintProfile: profile() } as never)).rejects.toThrow(/fingerprintProfile/);
    await expect(serve({ lightStealth: true } as never)).rejects.toThrow(/lightStealth/);
    await expect(serve({ profile: "auto", profileSelect: {} } as never)).rejects.toThrow(/profile/);
  });

  it("native emits no identity defaults", () => {
    const prefixes = ["--fingerprint-platform=", "--fingerprint-brand=", "--accept-lang=", "--lang=", "--timezone="];
    expect(fingerprintArgs({}, true).some((arg) => prefixes.some((prefix) => arg.startsWith(prefix)))).toBe(false);
  });

  it("rejects removed fields inside overrides", async () => {
    await expect(launch({ overrides: { fingerprint: "seed" } } as never)).rejects.toThrow(/unsupported identity override/);
    await expect(launch({ args: ["--fingerprint-brand=Edge"] })).rejects.toThrow(/not supported in args/);
  });

  it("defaults omitted identity to native and applies overrides after canonical profiles", () => {
    expect(prepareIdentityOptions({}).identityMode).toBe("native");
    const prepared = prepareIdentityOptions({
      identity: { mode: "captured", source: profile() },
      overrides: { timezone: "Europe/London", brand: "Edge" },
    });
    expect(prepared.identityMode).toBe("captured");
    expect(prepared.options.timezone).toBe("Europe/London");
    expect(prepared.options.brand).toBe("Edge");
    expect((prepared.options.fingerprintProfile as any).locale.timezone).not.toBe("Europe/London");
  });

  it("captured emits its canonical locale without a farbling seed", () => {
    const resolved = resolveIdentity({ mode: "captured", source: profile() });
    const args = fingerprintArgs({ fingerprintProfile: resolved.fingerprintProfile }, true);
    expect(args.some((arg) => arg.startsWith("--fingerprint-profile="))).toBe(true);
    expect(args.some((arg) => arg.startsWith("--fingerprint="))).toBe(false);
    expect(args).toContain("--accept-lang=en-US,en");
    expect(args).toContain("--lang=en-US");
  });

  it("derives platform + Google Chrome brand from the persona for cross-host coherence", () => {
    // A Windows persona driven by the Linux binary must present Windows (UA/UA-CH/platform) and
    // Google Chrome brands, not leak the host's Linux UA / the build's Chromium brand.
    const resolved = resolveIdentity({ mode: "captured", source: profile() });
    expect(resolved.platform).toBe("windows");
    expect(resolved.brand).toBe("chrome");
    expect(resolveIdentity({ mode: "native" }).platform).toBeUndefined();
    expect(resolveIdentity({ mode: "native" }).brand).toBeUndefined();

    const prepared = prepareIdentityOptions({ identity: { mode: "captured", source: profile() } });
    expect(prepared.options.platform).toBe("windows");
    expect(prepared.options.brand).toBe("chrome");
    const args = fingerprintArgs(prepared.options, true);
    expect(args).toContain("--fingerprint-platform=windows");
    expect(args).toContain("--fingerprint-brand=chrome");

    // explicit overrides still win (a platform override must name the persona's own OS, see platform-mismatch.test.ts).
    const overridden = prepareIdentityOptions({
      identity: { mode: "captured", source: profile() },
      overrides: { platform: "windows", brand: "Edge" },
    });
    expect(overridden.options.platform).toBe("windows");
    expect(overridden.options.brand).toBe("Edge");
    const args2 = fingerprintArgs(overridden.options, true);
    expect(args2).toContain("--fingerprint-platform=windows");
    expect(args2).toContain("--fingerprint-brand=Edge");
    expect(args2).not.toContain("--fingerprint-brand=chrome");
  });
});

describe("removed canvasBridge option", () => {
  it("is ignored with a single note, never an error", async () => {
    const { resetCanvasBridgeNote } = await import("../src/warnings.js");
    resetCanvasBridgeNote();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const a = prepareIdentityOptions({ canvasBridge: { url: "ws://h:1" }, args: ["--canvas-bridge-url=ws://h:1", "--keep"] });
      expect("canvasBridge" in a.options).toBe(false);
      expect(a.options.args).toEqual(["--keep"]);
      const b = prepareIdentityOptions({ overrides: { canvasBridge: { url: "ws://h:1" }, timezone: "Europe/London" } });
      expect(b.options.timezone).toBe("Europe/London");
      expect("canvasBridge" in (b.options as object)).toBe(false);
      const notes = err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("canvasBridge was removed"));
      expect(notes).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });

  it("is silent under quiet and does not touch the caller's object", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const input = { quiet: true, canvasBridge: { url: "ws://h:1" } };
      prepareIdentityOptions(input);
      expect("canvasBridge" in input).toBe(true);
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});
