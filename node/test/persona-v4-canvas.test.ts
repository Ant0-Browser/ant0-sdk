import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canvasMode, canvasNoiseKeyFor, deriveCanvasNoiseKey, newCanvasNoiseKey,
} from "../src/canvas.js";
import { fingerprintArgs, personaAvail, personaDpr } from "../src/fingerprint.js";
import { prepareIdentityOptions, resolveIdentity } from "../src/identity.js";
import {
  IdentityPersistenceError, createOrLoadGeneratedIdentity, createOrLoadIssuedIdentity,
  loadPersistedIdentity, validatePersistedIdentity,
} from "../src/identity-persistence.js";
import { PersonaV4SchemaError, assertPersonaProfileV4 } from "../src/persona-profile-v4.js";
import { parseSdkInfoSchemas, stagePersonaProfile, PROFILE_FILE_NAME } from "../src/profile-file.js";
import { coherenceWarnings, PERSONA_IDENTITY_OVERRIDE_MESSAGE } from "../src/warnings.js";

const v2 = () => JSON.parse(readFileSync(
  new URL("../../fixtures/synthetic/persona-v2.json", import.meta.url), "utf8"));
/** A small synthetic schema 4 persona: the structural fields the validator reads, nothing else. */
const v4 = (brand = "edge") => ({
  schema_version: 4, schema_revision: 1, requires: ["display", "input"],
  provenance: { source: "synthetic", model: { version: "population-model-v2.2", sha256: "0".repeat(64) } },
  identity: {
    os: { family: "windows", release: "windows-11", platform_version: "19.0.0", architecture: "x86_64" },
    engine: { family: "blink", major: 158 },
    brand: { id: brand, version: "158.0.4370.16" },
    form_factor: "desktop", device_model: "",
  },
  surfaces: { display: { width: 1920 }, "x-unknown": { ignored: true } },
});
const KEY = "2092fc8be8f13c86";

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "ant0-v4-test-")); roots.push(p); return p; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A fake engine: a shell script that prints the given text for --ant0-sdk-info. */
function fakeEngine(output: string): string {
  const path = join(temp(), "chrome");
  writeFileSync(path, `#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\ncat <<'JSON'\n${output}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}
const CAPABILITIES = ["navigator","navigator.ua_ch","display","input","gpu.webgl","gpu.webgpu","fonts","speech","audio","media.decoding","media.devices","network"];
const info = (schemas: number[], protocol = 2, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ sdk_protocol: protocol, persona: { schemas, revision: 1, engine_family: "blink", engine_major: 158, capabilities: CAPABILITIES, ...extra } });

describe("schema 4 validator", () => {
  it("accepts a structurally valid persona and ignores unknown keys", () => {
    expect(() => assertPersonaProfileV4(v4())).not.toThrow();
  });
  it("rejects the cloud's invalid cases", () => {
    const bad = (mut: (p: any) => void) => { const p: any = v4(); mut(p); return p; };
    for (const p of [
      bad((x) => { x.schema_version = 2; }),
      bad((x) => { x.requires = ["a", "a"]; }),
      bad((x) => { x.provenance.source = "captured"; }),
      bad((x) => { x.provenance.attempt = 1; }),
      bad((x) => { x.identity.engine.family = "gecko"; }),
      bad((x) => { delete x.identity.brand; }),
      bad((x) => { x.surfaces = []; }),
    ]) expect(() => assertPersonaProfileV4(p)).toThrow(PersonaV4SchemaError);
  });
});

describe("option combinations that cannot be honoured", () => {
  it("canvas together with the direct fingerprint seed is refused with a clear error", () => {
    for (const canvas of ["real", "noise"] as const) {
      expect(() => fingerprintArgs({ fingerprint: "seed", canvas, canvasNoiseKey: KEY }), canvas)
        .toThrowError(expect.objectContaining({ code: "sdk.canvas_invalid", message: expect.stringContaining("fingerprint seed") }));
    }
    expect(() => fingerprintArgs({ fingerprint: "seed" })).not.toThrow();
    expect(() => fingerprintArgs({ canvas: "real" })).not.toThrow();
  });
  it("a schema 4 persona given as a path or JSON text says so instead of 'file missing'", () => {
    const dir = temp();
    const file = join(dir, "persona.json");
    writeFileSync(file, JSON.stringify(v4()));
    for (const fingerprintProfile of [file, JSON.stringify(v4())]) {
      expect(() => fingerprintArgs({ fingerprintProfile } as any, true))
        .toThrowError(expect.objectContaining({ code: "sdk.persona_profile_invalid", message: expect.stringContaining("identity") }));
    }
  });
});

describe("provenance.noise_key", () => {
  const withKey = (k: unknown) => { const p: any = v4(); if (k !== "absent") p.provenance.noise_key = k; return p; };
  it("is optional: a hand-made document without it stays valid", () => {
    expect(() => assertPersonaProfileV4(withKey("absent"))).not.toThrow();
    expect(() => assertPersonaProfileV4(withKey("0123456789abcdef"))).not.toThrow();
  });
  it("must be exactly 16 lowercase hex characters when present", () => {
    for (const k of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "0x23456789abcdef", "0123456789abcdeg",
      "0123456789abcdef\n", "", null, 7, {}]) {
      expect(() => assertPersonaProfileV4(withKey(k)), JSON.stringify(k)).toThrow(/noise_key/);
    }
  });
  it("a missing key is only a debug line", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const old = process.env.ANT0_BROWSER_DEBUG;
    try {
      const probe = async () => ({ completed: true, stdout: JSON.stringify({ sdk_protocol: 2, persona: { schemas: [2, 4], capabilities: ["display", "input"] } }) });
      delete process.env.ANT0_BROWSER_DEBUG;
      await stagePersonaProfile({ fingerprintProfile: v4() as any }, "/x/chrome", temp(), { probe, run: async () => "", platform: "linux" });
      expect(spy).not.toHaveBeenCalled();
      process.env.ANT0_BROWSER_DEBUG = "1";
      await stagePersonaProfile({ fingerprintProfile: v4() as any }, "/x/chrome2", temp(), { probe, run: async () => "", platform: "linux" });
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/debug: .*no provenance\.noise_key/);
    } finally { spy.mockRestore(); if (old === undefined) delete process.env.ANT0_BROWSER_DEBUG; else process.env.ANT0_BROWSER_DEBUG = old; }
  });
});

describe("persisted wrapper", () => {
  const wrapper3 = (extra: object = {}) => ({
    schema_version: 3, algorithm: "ant0/persona-generate/v2.2", algorithm_ref: "population-model-v2.2",
    created_at: "2026-11-14T10:00:00Z", profile: v4(), canvas_noise_key: KEY, ...extra,
  });
  it("accepts a schema 4 persona in a v3 wrapper that carries a canvas key", () => {
    expect(validatePersistedIdentity(wrapper3()).schema_version).toBe(3);
  });
  it("requires the canvas key in a v3 wrapper, while v1 and v2 stay valid without one", () => {
    const { canvas_noise_key: _drop, ...keyless } = wrapper3();
    expect(() => validatePersistedIdentity(keyless)).toThrow(/canvas_noise_key is required/);
    expect(() => validatePersistedIdentity(keyless)).toThrow(IdentityPersistenceError);
    expect(() => validatePersistedIdentity({ ...keyless, canvas_noise_key: undefined })).toThrow(IdentityPersistenceError);
    expect(() => validatePersistedIdentity({ ...keyless, canvas_noise_key: null })).toThrow(IdentityPersistenceError);
  });
  it("rejects a bad key, a v2 profile in a v3 wrapper and a v4 profile in a v2 wrapper", () => {
    expect(() => validatePersistedIdentity(wrapper3({ canvas_noise_key: "0x" + KEY.slice(2) }))).toThrow(IdentityPersistenceError);
    expect(() => validatePersistedIdentity(wrapper3({ canvas_noise_key: KEY.toUpperCase() }))).toThrow(IdentityPersistenceError);
    expect(() => validatePersistedIdentity({ ...wrapper3(), profile: v2() })).toThrow(IdentityPersistenceError);
    expect(() => validatePersistedIdentity({ ...wrapper3(), schema_version: 2, algorithm: "ant0/persona-generate/v1" })).toThrow(IdentityPersistenceError);
  });
  it("still accepts the v2 wrapper unchanged, with and without a key", () => {
    const w = { schema_version: 2, algorithm: "ant0/persona-generate/v1", algorithm_ref: "m1",
      created_at: "2026-11-14T10:00:00Z", profile: v2() };
    expect(validatePersistedIdentity(w).schema_version).toBe(2);
    expect(validatePersistedIdentity({ ...w, canvas_noise_key: KEY }).schema_version).toBe(2);
  });
  it("stores an issued v4 persona once, with a fresh key, and keeps the first file", () => {
    const dir = temp();
    const first = createOrLoadIssuedIdentity("acct", { profile: v4(), algorithm: "ant0/persona-generate/v2.2", algorithmRef: "population-model-v2.2" }, { identityDir: dir });
    expect(first.schema_version).toBe(3);
    expect(first.canvas_noise_key).toMatch(/^[0-9a-f]{16}$/);
    const second = createOrLoadIssuedIdentity("acct", { profile: v4("chrome"), algorithm: "ant0/persona-generate/v2.2", algorithmRef: "population-model-v2.2" }, { identityDir: dir });
    expect(second).toEqual(first);
    expect(loadPersistedIdentity("acct", { identityDir: dir })).toEqual(first);
  });
  it("stores an issued v2 persona in a v2 wrapper without a key", () => {
    const w = createOrLoadIssuedIdentity("acct2", { profile: v2(), algorithm: "ant0/persona-generate/v1", algorithmRef: "population-model-v1" }, { identityDir: temp() });
    expect(w.schema_version).toBe(2);
    expect(w.canvas_noise_key).toBeUndefined();
  });
});

/** The exact field sets origin/main readers require for each wrapper version. */
const OLD_V1_FIELDS = ["created_at", "profile", "schema_version", "template_id", "template_selection_algorithm"];
const OLD_V2_FIELDS = ["algorithm", "algorithm_ref", "created_at", "profile", "schema_version"];
const onDisk = (dir: string) => {
  const files = readdirSync(dir).filter((f) => f !== "device.key");
  expect(files.length).toBe(1);
  return JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
};

describe("files stay readable by older releases", () => {
  const model = () => JSON.parse(readFileSync(
    new URL("../../fixtures/synthetic/population-generate-v1.json", import.meta.url), "utf8")).model;
  it("a v2 file written by the generated route has exactly the origin/main v2 field set", () => {
    const dir = temp();
    createOrLoadGeneratedIdentity("k", model(), { identityDir: dir });
    const w = onDisk(dir);
    expect(w.schema_version).toBe(2);
    expect(Object.keys(w).sort()).toEqual(OLD_V2_FIELDS);
  });
  it("a v2 file written by the issued route has exactly the origin/main v2 field set", () => {
    const dir = temp();
    createOrLoadIssuedIdentity("k", { profile: v2(), algorithm: "ant0/persona-generate/v1", algorithmRef: "m" }, { identityDir: dir });
    const w = onDisk(dir);
    expect(w.schema_version).toBe(2);
    expect(Object.keys(w).sort()).toEqual(OLD_V2_FIELDS);
  });
  it("a v3 file (new persona format) carries the random key; v1/v2 never do", () => {
    const dir = temp();
    createOrLoadIssuedIdentity("k", { profile: v4(), algorithm: "ant0/persona-generate/v2.2", algorithmRef: "population-model-v2.2" }, { identityDir: dir });
    const w = onDisk(dir);
    expect(w.schema_version).toBe(3);
    expect(Object.keys(w).sort()).toEqual([...OLD_V2_FIELDS, "canvas_noise_key"].sort());
    expect(w.canvas_noise_key).toMatch(/^[0-9a-f]{16}$/);
  });
  it("two v2 identities with different identity keys get different derived canvas keys", () => {
    expect(deriveCanvasNoiseKey("a-1")).not.toBe(deriveCanvasNoiseKey("a-2"));
  });
  it("readers still accept a valid optional key in v1 and v2 files and reject a malformed one", () => {
    const v1 = { schema_version: 1, template_selection_algorithm: "ant0/persona-template-selection/v1",
      template_id: "t1", created_at: "2026-11-14T10:00:00Z", profile: v2() };
    const v2w = { schema_version: 2, algorithm: "ant0/persona-generate/v1", algorithm_ref: "m1",
      created_at: "2026-11-14T10:00:00Z", profile: v2() };
    for (const w of [v1, v2w]) {
      expect(() => validatePersistedIdentity({ ...w, canvas_noise_key: KEY })).not.toThrow();
      for (const bad of ["0x" + KEY.slice(2), KEY.toUpperCase(), KEY.slice(1), KEY + "0", "", 5, null, "zzzzzzzzzzzzzzzz"]) {
        expect(() => validatePersistedIdentity({ ...w, canvas_noise_key: bad }), `${w.schema_version} ${String(bad)}`)
          .toThrow(IdentityPersistenceError);
      }
    }
  });
});

describe("v3 wrapper algorithm", () => {
  const w3 = (extra: object) => ({
    schema_version: 3, algorithm: "ant0/persona-generate/v2.2", algorithm_ref: "population-model-v2.2",
    created_at: "2026-11-14T10:00:00Z", profile: v4(), canvas_noise_key: KEY, ...extra,
  });
  it("accepts the generator names it knows and rejects anything else", () => {
    expect(() => validatePersistedIdentity(w3({}))).not.toThrow();
    expect(() => validatePersistedIdentity(w3({ algorithm: "ant0/persona-generate/v3.0" }))).not.toThrow();
    for (const algorithm of ["other/persona-generate/v2.2", "ant0/persona-generate/", "ant0/persona-generate/../x", "", 2, undefined]) {
      expect(() => validatePersistedIdentity(w3({ algorithm })), String(algorithm)).toThrow(IdentityPersistenceError);
    }
    expect(() => validatePersistedIdentity(w3({ algorithm_ref: "../x" }))).toThrow(IdentityPersistenceError);
  });
});

describe("canvas noise key", () => {
  it("derives a stable key that matches the pinned vector", () => {
    expect(deriveCanvasNoiseKey("account-42")).toBe(KEY);
    expect(deriveCanvasNoiseKey("")).toBe("6823a00150088ea3");
    expect(deriveCanvasNoiseKey("профиль-1")).toBe("ad17a5bc990e445e");
    expect(deriveCanvasNoiseKey("account-42")).toBe(deriveCanvasNoiseKey("account-42"));
  });
  it("makes random 16-hex keys", () => {
    const keys = new Set(Array.from({ length: 50 }, newCanvasNoiseKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{16}$/);
  });
  it("prefers the stored key and derives for a legacy wrapper without one", () => {
    expect(canvasNoiseKeyFor({ canvas_noise_key: "00112233445566ff" }, "account-42")).toBe("00112233445566ff");
    expect(canvasNoiseKeyFor({}, "account-42")).toBe(KEY);
  });
  it("a newly generated (v2) identity stores no key, so older readers accept it; an existing file is not rewritten", () => {
    const dir = temp();
    const model = JSON.parse(readFileSync(
      new URL("../../fixtures/synthetic/population-generate-v1.json", import.meta.url), "utf8")).model;
    const created = createOrLoadGeneratedIdentity("k", model, { identityDir: dir });
    expect(created.canvas_noise_key).toBeUndefined();
    const file = readdirSync(dir).find((f) => f.endsWith(".json"))!;
    const before = readFileSync(join(dir, file), "utf8");
    expect(createOrLoadGeneratedIdentity("k", model, { identityDir: dir })).toEqual(created);
    expect(readFileSync(join(dir, file), "utf8")).toBe(before);
  });
});

describe("canvas mode and switches", () => {
  const noiseSwitches = (o: object) => fingerprintArgs(o as any).filter((a) => a.startsWith("--fingerprint-noise-key"));
  it("real sends no noise-key switch", () => {
    expect(noiseSwitches({ canvas: "real", canvasNoiseKey: KEY })).toEqual([]);
    expect(noiseSwitches({})).toEqual([]);
  });
  it("noise sends exactly one switch with the 16 hex key", () => {
    expect(noiseSwitches({ canvas: "noise", canvasNoiseKey: KEY })).toEqual([`--fingerprint-noise-key=${KEY}`]);
  });
  it("noise without a key is an error; a malformed key is an error", () => {
    expect(() => fingerprintArgs({ canvas: "noise" })).toThrow(/canvasNoiseKey/);
    for (const bad of ["abc", "0x" + KEY.slice(2), KEY.toUpperCase(), KEY + "0"]) {
      expect(() => fingerprintArgs({ canvas: "noise", canvasNoiseKey: bad })).toThrow(/16 lowercase hex/);
    }
    expect(() => canvasMode({ canvas: "loud" as never })).toThrow(/real|noise/);
  });
  it("maps the legacy overrides", () => {
    expect(canvasMode({})).toBe("real");
    expect(canvasMode({ canvasNoise: true })).toBe("real");      // legacy flags never enable noise
    expect(canvasMode({ fingerprintNoise: true })).toBe("real");
    expect(canvasMode({ canvasNoise: true, fingerprintNoise: true })).toBe("real");
    expect(canvasMode({ canvasNoise: false, fingerprintNoise: false })).toBe("real");
    expect(canvasMode({ canvas: "real", canvasNoise: true })).toBe("real");
    expect(canvasMode({ canvas: "noise", canvasNoise: false })).toBe("noise");
    expect(noiseSwitches({ canvasNoise: true, canvasNoiseKey: KEY })).toEqual([]);
    expect(noiseSwitches({ canvas: "noise", canvasNoiseKey: KEY })).toEqual([`--fingerprint-noise-key=${KEY}`]);
  });
  it("keeps the seed-path disable switches exactly as before", () => {
    expect(fingerprintArgs({ fingerprint: "s", canvasNoise: false, fingerprintNoise: false }))
      .toEqual(expect.arrayContaining(["--disable-canvas-noise", "--disable-fingerprint-noise"]));
    expect(fingerprintArgs({ canvasNoise: true })).toEqual(fingerprintArgs({}));
  });
});

describe("identity path", () => {
  it("noise takes the key from the option, else the stored identity, else fails", () => {
    const dir = temp();
    createOrLoadIssuedIdentity("acct", { profile: v4(), algorithm: "ant0/persona-generate/v2.2", algorithmRef: "population-model-v2.2" }, { identityDir: dir });
    const stored = (loadPersistedIdentity("acct", { identityDir: dir }) as any).canvas_noise_key;
    const id = { mode: "synthetic", key: "acct", identityDirectory: dir };
    expect(prepareIdentityOptions({ identity: id, overrides: { canvas: "noise" } }).options.canvasNoiseKey).toBe(stored);
    expect(prepareIdentityOptions({ identity: id, overrides: { canvas: "noise", canvasNoiseKey: KEY } }).options.canvasNoiseKey).toBe(KEY);
    expect(prepareIdentityOptions({ identity: id }).options.canvasNoiseKey).toBeUndefined();
    expect(() => prepareIdentityOptions({ overrides: { canvas: "noise" } }))
      .toThrowError(expect.objectContaining({ code: "sdk.canvas_key_missing" }));
    expect(() => prepareIdentityOptions({ identity: { mode: "captured", source: v2() }, overrides: { canvas: "noise" } }))
      .toThrowError(expect.objectContaining({ code: "sdk.canvas_key_missing" }));
  });
  // What every legacy shape did on main (the SDK pinned at 0277779): `false` sent the matching
  // --disable-* switch, `true` and absent sent nothing, for every identity mode. None of it enables noise.
  const modes: [string, () => Record<string, unknown> | undefined][] = [
    ["native", () => undefined],
    ["captured v2", () => ({ mode: "captured", source: v2() })],
    ["captured v4", () => ({ mode: "captured", source: v4() as any })],
    ["synthetic with a stored key", () => {
      const dir = temp();
      createOrLoadIssuedIdentity("acct", { profile: v4(), algorithm: "ant0/persona-generate/v2.2", algorithmRef: "population-model-v2.2" }, { identityDir: dir });
      return { mode: "synthetic", key: "acct", identityDirectory: dir };
    }],
  ];
  for (const [modeName, makeIdentity] of modes) {
    for (const canvasNoise of [true, false, undefined]) {
      for (const fingerprintNoise of [true, false, undefined]) {
        it(`legacy shape on ${modeName}: canvasNoise=${canvasNoise} fingerprintNoise=${fingerprintNoise} stays real, as on main`, () => {
          const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
          try {
            const identity = makeIdentity();
            const overrides: Record<string, unknown> = {};
            if (canvasNoise !== undefined) overrides.canvasNoise = canvasNoise;
            if (fingerprintNoise !== undefined) overrides.fingerprintNoise = fingerprintNoise;
            const o = prepareIdentityOptions({ ...(identity ? { identity } : {}), overrides } as any).options as any;
            expect(canvasMode(o)).toBe("real");
            expect(o.canvasNoiseKey).toBeUndefined();
            const args = fingerprintArgs({ ...o, ...(o.fingerprintProfile?.schema_version === 4 ? { fingerprintProfileFile: "/x" } : {}) }, true);
            expect(args.some((a) => a.startsWith("--fingerprint-noise-key"))).toBe(false);
            expect(args.includes("--disable-canvas-noise")).toBe(canvasNoise === false);
            expect(args.includes("--disable-fingerprint-noise")).toBe(fingerprintNoise === false);
            const warned = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("canvas-noise-no-key")).length;
            expect(warned).toBe(canvasNoise === true || fingerprintNoise === true ? 1 : 0);
          } finally { spy.mockRestore(); }
        });
      }
    }
  }
  it("the legacy warning is quiet when asked, and an explicit canvas: noise needs no warning", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      prepareIdentityOptions({ quiet: true, overrides: { canvasNoise: true } });
      prepareIdentityOptions({ overrides: { canvas: "noise", canvasNoise: true, canvasNoiseKey: KEY } });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("a v2 wrapper has no key and derives one from the identity key", () => {
    const dir = temp();
    createOrLoadIssuedIdentity("account-42", { profile: v2(), algorithm: "ant0/persona-generate/v1", algorithmRef: "m" }, { identityDir: dir });
    const id = { mode: "synthetic", key: "account-42", identityDirectory: dir };
    expect(prepareIdentityOptions({ identity: id, overrides: { canvas: "noise" } }).options.canvasNoiseKey).toBe(KEY);
  });
  it("a schema 4 persona derives no identity switch: no platform, brand, versions or tls profile", () => {
    const r = resolveIdentity({ mode: "captured", source: v4() as any });
    expect(Object.keys(r).sort()).toEqual(["fingerprintProfile", "mode"]);
    const p = prepareIdentityOptions({ identity: { mode: "captured", source: v4() as any } }).options;
    for (const k of ["platform", "brand", "brandVersion", "platformVersion"]) expect(p[k], k).toBeUndefined();
    // the persona's major (158) against an engine of another major (159): still nothing derived
    const args = fingerprintArgs({ ...p, fingerprintProfileFile: "/x" } as any, true);
    expect(args.filter((a) => /^--fingerprint-(brand|platform|tls)/.test(a))).toEqual([]);
    expect(args).toContain("--fingerprint-profile-file=/x");
  });
  it("platform and brand overrides on a schema 4 persona pass only the user's values, and warn once with one code", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const prepared = (overrides: Record<string, unknown>) => prepareIdentityOptions(
        { identity: { mode: "captured", source: v4() as any }, overrides } as any).options;
      const only = (o: Record<string, unknown>) =>
        fingerprintArgs({ ...o, fingerprintProfileFile: "/x" } as any, true).filter((a) => /^--fingerprint-(brand|platform|tls)/.test(a));
      expect(only(prepared({ platform: "windows" }))).toEqual(["--fingerprint-platform=windows"]);
      expect(only(prepared({ brand: "chrome" }))).toEqual(["--fingerprint-brand=chrome"]);
      expect(only(prepared({ brand: "chrome", brandVersion: "150.0.1.2" })))
        .toEqual(["--fingerprint-brand=chrome", "--fingerprint-brand-version=150.0.1.2", "--fingerprint-tls-profile=chrome-150"]);
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("persona-identity-override"));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(`ant0-browser: warning: [persona-identity-override] ${PERSONA_IDENTITY_OVERRIDE_MESSAGE}\n`);
      spy.mockClear();
      prepareIdentityOptions({ identity: { mode: "captured", source: v4() as any }, overrides: { brand: "chrome" }, quiet: true } as any);
      prepareIdentityOptions({ identity: { mode: "captured", source: v2() } , overrides: { brand: "chrome" } } as any); // v2: no mix
      expect(spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("persona-identity-override"))).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it("an Android schema 4 persona still gets the phone-sized window, without a platform switch", () => {
    const p: any = v4(); p.identity.os.family = "android"; p.identity.form_factor = "phone"; p.identity.brand.id = "chrome";
    const args = fingerprintArgs({ fingerprintProfile: p, fingerprintProfileFile: "/x" } as any, true);
    expect(args).toContain("--window-size=412,915");
    expect(args.some((a) => a.startsWith("--fingerprint-platform"))).toBe(false);
  });
  it("v2 identity options are unchanged: same brand, no version fields", () => {
    const p = prepareIdentityOptions({ identity: { mode: "captured", source: v2() } }).options;
    expect(p.brand).toBe("chrome");
    expect(p.brandVersion).toBeUndefined();
    expect(p.platformVersion).toBeUndefined();
  });
});

describe("persona file transport", () => {
  const posix = process.platform === "win32" ? it.skip : it; // the fake engines are /bin/sh scripts
  posix("writes a 0600 file in the profile dir, round-trips, and uses the file switch only", async () => {
    const udd = temp();
    const engine = fakeEngine(info([2, 4]));
    const staged = await stagePersonaProfile({ fingerprintProfile: v4() as any }, engine, udd);
    const path = staged.fingerprint.fingerprintProfileFile!;
    expect(path).toBe(join(udd, PROFILE_FILE_NAME));
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const back = JSON.parse(gunzipSync(Buffer.from(readFileSync(path, "utf8"), "base64")).toString("utf8"));
    expect(back).toEqual(v4());
    const args = fingerprintArgs(staged.fingerprint, true);
    expect(args).toContain(`--fingerprint-profile-file=${path}`);
    expect(args.some((a) => a.startsWith("--fingerprint-profile="))).toBe(false);
    expect(readdirSync(udd)).toEqual([PROFILE_FILE_NAME]); // no temporary file left behind
  });
  posix("replaces an existing file atomically and keeps it private", async () => {
    const udd = temp();
    const engine = fakeEngine(info([2, 4]));
    await stagePersonaProfile({ fingerprintProfile: v4("chrome") as any }, engine, udd);
    const staged = await stagePersonaProfile({ fingerprintProfile: v4("edge") as any }, engine, udd);
    const back = JSON.parse(gunzipSync(Buffer.from(readFileSync(staged.fingerprint.fingerprintProfileFile!, "utf8"), "base64")).toString());
    expect(back.identity.brand.id).toBe("edge");
    if (process.platform !== "win32") expect(statSync(staged.fingerprint.fingerprintProfileFile!).mode & 0o777).toBe(0o600);
  });
  posix("without a profile dir uses a private temp dir that cleanup removes", async () => {
    const staged = await stagePersonaProfile({ fingerprintProfile: v4() as any }, fakeEngine(info([2, 4])));
    const path = staged.fingerprint.fingerprintProfileFile!;
    expect(statSync(path).isFile()).toBe(true);
    staged.cleanup();
    expect(() => statSync(path)).toThrow();
  });
  posix("refuses a schema 4 persona on an engine that does not advertise 4", async () => {
    const udd = temp();
    for (const engine of [fakeEngine(info([2])), fakeEngine(info([2, 4], 1)), fakeEngine("not json"), join(temp(), "missing")]) {
      await expect(stagePersonaProfile({ fingerprintProfile: v4() as any }, engine, udd))
        .rejects.toMatchObject({ code: "sdk.persona_requires_engine" });
    }
    expect(readdirSync(udd)).toEqual([]); // nothing written
  });
  it("sending a schema 4 persona without the file is refused, never inline", () => {
    expect(() => fingerprintArgs({ fingerprintProfile: v4() as any }, true)).toThrow(/private file/);
  });
  it("v2 personas stay inline and are not staged", async () => {
    const fp = { fingerprintProfile: v2() };
    const staged = await stagePersonaProfile(fp, "/nonexistent/chrome", temp());
    expect(staged.fingerprint).toBe(fp);
    const args = fingerprintArgs(fp, true);
    expect(args.some((a) => a.startsWith("--fingerprint-profile="))).toBe(true);
    expect(args.some((a) => a.startsWith("--fingerprint-profile-file"))).toBe(false);
  });
  it("reads the advertisement", () => {
    expect(parseSdkInfoSchemas(info([2, 4]))).toEqual([2, 4]);
    expect(parseSdkInfoSchemas(info([2, 4], 1))).toEqual([2]);
    expect(parseSdkInfoSchemas("")).toEqual([2]);
  });
});

describe("warnings text", () => {
  it("does not call an Edge schema 4 persona a brand mismatch", () => {
    const codes = coherenceWarnings({ brand: "edge", fingerprintProfile: v4(), headless: false }, "win32", "158").map((x) => x.code);
    expect(codes).not.toContain("brand-mismatch");
  });
});

describe("schema 4 display", () => {
  const withDisplay = (d: object) => { const p: any = v4(); p.surfaces.display = d; return p; };
  const display = { width: 2560, height: 1440, avail_width: 1920, avail_height: 1040, avail_left: 0, avail_top: 0, device_pixel_ratio: 1.25 };
  it("feeds the scale and available-area flags from surfaces.display", () => {
    const fp: any = { fingerprintProfile: withDisplay(display) };
    expect(personaDpr(fp)).toBe(1.25);
    expect(personaAvail(fp)).toEqual({ width: 1920, height: 1040 });
    expect(fingerprintArgs({ ...fp, fingerprintProfileFile: "/x" }, true)).toContain("--force-device-scale-factor=1.25");
  });
  it("gives the same flags as a v2 persona with the same numbers", () => {
    const p2 = v2(); p2.display.device_pixel_ratio = 1.25; p2.display.available_width = 1920; p2.display.available_height = 1040;
    const a = fingerprintArgs({ fingerprintProfile: p2 } as any, true).filter((x) => x.startsWith("--force-device-scale-factor"));
    const b = fingerprintArgs({ fingerprintProfile: withDisplay(display), fingerprintProfileFile: "/x" } as any, true).filter((x) => x.startsWith("--force-device-scale-factor"));
    expect(b).toEqual(a);
    expect(personaAvail({ fingerprintProfile: p2 } as any)).toEqual(personaAvail({ fingerprintProfile: withDisplay(display) } as any));
  });
  it("explicit values win, and a persona without display leaves the scale alone", () => {
    expect(personaDpr({ devicePixelRatio: 2, fingerprintProfile: withDisplay(display) } as any)).toBe(2);
    expect(personaAvail({ availWidth: 1000, fingerprintProfile: withDisplay(display) } as any).width).toBe(1000);
    expect(personaDpr({ fingerprintProfile: v4() } as any)).toBeUndefined();
    expect(personaDpr({ fingerprintProfile: withDisplay({ device_pixel_ratio: 99 }) } as any)).toBeUndefined();
  });
});

describe("incognito persona file lifetime", () => {
  const posix = process.platform === "win32" ? it.skip : it;
  posix("launch() removes the temp persona file once the browser is up and the temp dir when it disconnects; a failed launch removes both", async () => {
    const { EventEmitter } = await import("node:events");
    const { chromium } = await import("playwright-core");
    const { launch } = await import("../src/index.js");
    const engine = join(temp(), "chrome");
    writeFileSync(engine, `#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\ncat <<'JSON'\n${info([2, 4])}\nJSON\n`);
    chmodSync(engine, 0o755);
    const seen: string[] = [];
    const allArgs: string[] = [];
    const fake = Object.assign(new EventEmitter(), { newPage: async () => ({}), newContext: async () => ({}) });
    vi.spyOn(chromium, "launch").mockImplementation((async (o: any) => {
      allArgs.push(...o.args);
      seen.push(o.args.find((a: string) => a.startsWith("--fingerprint-profile-file="))!.split("=")[1]);
      return fake;
    }) as any);
    try {
      const browser: any = await launch({ executablePath: engine, identity: { mode: "captured", source: v4() as any },
        ephemeralProfile: false, headless: true, quiet: true, launchTicket: false } as any);
      expect(() => statSync(seen[0])).toThrow();                  // the engine read it at startup: the file is gone already
      expect(statSync(dirname(seen[0])).isDirectory()).toBe(true); // the 0700 temp dir stays until the browser closes
      expect(allArgs.some((a) => a.includes("ant0-persona-handle"))).toBe(false); // the engine sets it, never the SDK
      browser.emit("disconnected");
      expect(() => statSync(dirname(seen[0]))).toThrow();
      // a launch that fails removes it at once
      (chromium.launch as any).mockImplementation(async (o: any) => {
        seen.push(o.args.find((a: string) => a.startsWith("--fingerprint-profile-file="))!.split("=")[1]);
        throw new Error("stop");
      });
      await launch({ executablePath: engine, identity: { mode: "captured", source: v4() as any },
        ephemeralProfile: false, headless: true, quiet: true, launchTicket: false } as any).catch(() => {});
      expect(() => statSync(seen[1])).toThrow();
      expect(() => statSync(dirname(seen[1]))).toThrow();
    } finally { vi.restoreAllMocks(); }
  });
  posix("a refused launch runs no probe and writes no persona file, in launch, launchPersistentContext and serve", async () => {
    const { launch, launchPersistentContext, serve } = await import("../src/index.js");
    const probed = join(temp(), "probed");
    const engine = join(temp(), "chrome");
    writeFileSync(engine, `#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\n: > '${probed}'\ncat <<'JSON'\n${info([2, 4])}\nJSON\n`);
    chmodSync(engine, 0o755);
    const identity = { mode: "captured", source: v4() as any };
    const common = { executablePath: engine, identity, args: ["-ANT0-persona-handle=1"], headless: true, quiet: true, launchTicket: false };
    const udd = temp();
    // A private TMPDIR: the shared one also holds other test files' (and other runs') serve and persona dirs.
    const privateTmp = temp();
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = privateTmp;
    try {
      expect(tmpdir()).toBe(privateTmp);
      await expect(launch({ ...common, ephemeralProfile: false } as any)).rejects.toMatchObject({ code: "sdk.launch_option_unsupported" });
      await expect(launchPersistentContext(udd, common as any)).rejects.toMatchObject({ code: "sdk.launch_option_unsupported" });
      await expect(serve({ ...common } as any)).rejects.toMatchObject({ code: "sdk.launch_option_unsupported" });
      await expect(serve({ ...common, userDataDir: udd } as any)).rejects.toMatchObject({ code: "sdk.launch_option_unsupported" });
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    }
    expect(existsSync(probed)).toBe(false);                      // the engine was never run
    expect(readdirSync(udd)).toEqual([]);                        // no persona file in the profile
    expect(readdirSync(privateTmp)).toEqual([]);                 // no persona or serve temp dir was created
  });
  posix("a caller's own --ant0-persona-handle is refused before anything reaches the engine", async () => {
    const { chromium } = await import("playwright-core");
    const { launch } = await import("../src/index.js");
    const engine = join(temp(), "chrome");
    writeFileSync(engine, `#!/bin/sh\n# ant0-browser-capabilities/persona-profile-v1\ncat <<'JSON'\n${info([2, 4])}\nJSON\n`);
    chmodSync(engine, 0o755);
    const spy = vi.spyOn(chromium, "launch").mockImplementation((async () => { throw new Error("must not be reached"); }) as any);
    try {
      for (const identity of [{ mode: "native" }, { mode: "captured", source: v4() as any }]) {
        await expect(launch({ executablePath: engine, identity, args: ["--ant0-persona-handle=1:2"], ephemeralProfile: false,
          headless: true, quiet: true, launchTicket: false } as any)).rejects.toMatchObject({ code: "sdk.launch_option_unsupported" });
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});
