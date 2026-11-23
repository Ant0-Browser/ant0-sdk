import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { encodeProfile } from "../src/fingerprint.js";
import { prepareIdentityOptions } from "../src/identity.js";
import { generatePersonaProfile, type PopulationModel } from "../src/population-model.js";
import { BUILTIN_WINDOWS_VOICES, builtinSpeechIfContradicting, cohereSpeech } from "../src/speech-coherence.js";

interface Fixture {
  model: PopulationModel;
  cases: Array<{ primary_language: string; identity_key: string; device_key: string; expected_voices: any[] }>;
}
const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../fixtures/synthetic/speech-locale-generate-v1.json", import.meta.url)), "utf8")) as Fixture;

function modelFor(locale: string): PopulationModel {
  const m = structuredClone(fixture.model);
  m.constants.locale = { ...m.constants.locale, primary_language: locale, languages: [locale] };
  return m;
}
const gen = (locale: string, key: string) => generatePersonaProfile(key, "0".repeat(64), modelFor(locale));
const defaultLang = (p: any): string => p.speech.voices.find((v: any) => v.default).language;
const names = (p: any): string[] => p.speech.voices.map((v: any) => v.name);

describe("locale-aware speech draw in the generator", () => {
  it("reproduces the shared golden cases (parity with Python)", () => {
    for (const c of fixture.cases) {
      const p = generatePersonaProfile(c.identity_key, c.device_key, modelFor(c.primary_language));
      expect(p.speech.voices).toEqual(c.expected_voices);
    }
  });

  it("an en-US persona gets an en-US default and never a ru default", () => {
    for (let i = 0; i < 80; i++) {
      const p = gen("en-US", `k${i}`);
      expect(defaultLang(p)).toBe("en-US");
    }
  });

  it("a ru-RU persona gets a ru set", () => {
    for (let i = 0; i < 40; i++) expect(defaultLang(gen("ru-RU", `k${i}`))).toBe("ru-RU");
  });

  it("en-GB prefers an en-GB default; bare en accepts any English default", () => {
    for (let i = 0; i < 20; i++) expect(defaultLang(gen("en-GB", `k${i}`))).toBe("en-GB");
    const langs = new Set(Array.from({ length: 80 }, (_, i) => defaultLang(gen("en", `k${i}`))));
    expect([...langs].every((l) => l.startsWith("en-"))).toBe(true);
    expect(langs.size).toBeGreaterThan(1);
  });

  it("a locale with no matching set gets the engine's built-in Windows set", () => {
    const p = gen("de-DE", "k1");
    expect(names(p)).toEqual(BUILTIN_WINDOWS_VOICES.map((v) => v[0]));
    expect(names(p)).toEqual([
      "Microsoft David - English (United States)",
      "Microsoft Zira - English (United States)",
      "Microsoft Mark - English (United States)",
    ]);
    expect(p.speech.voices.filter((v: any) => v.default).length).toBe(1);
  });

  it("does not change any other group's draw", () => {
    const a = gen("en-US", "k9") as any, b = gen("de-DE", "k9") as any;
    expect({ ...a, speech: null, locale: null }).toEqual({ ...b, speech: null, locale: null });
  });
});

const CROSS_SDK_SHA256 = "221f1db0757a294dc5453a7d2a9fd662459014f596a7ebf3e06eb8155560cdf6";

describe("launch-time safety net", () => {
  const ruProfile = () => ({ ...(gen("ru-RU", "k1") as any) });

  it("swaps in the built-in set when the default voice contradicts the persona's own language, without touching the input", () => {
    const en = gen("en-US", "k1") as any;
    const p = structuredClone(en);
    p.speech.voices = ruProfile().speech.voices;
    const before = JSON.stringify(p);
    const out = builtinSpeechIfContradicting(p, "windows") as any;
    expect(names(out)).toEqual(BUILTIN_WINDOWS_VOICES.map((v) => v[0]));
    expect(JSON.stringify(p)).toBe(before);
    // Accept-Language is ignored, in both directions.
    expect(builtinSpeechIfContradicting(p, "windows", "ru-RU,ru")).toEqual(out);
    expect(builtinSpeechIfContradicting(ruProfile(), "windows", "en-US")).toEqual(ruProfile());
  });

  it("leaves agreeing lists and other platforms alone", () => {
    const p = ruProfile();
    expect(builtinSpeechIfContradicting(p, "windows", undefined)).toBe(p);
    expect(builtinSpeechIfContradicting(p, "linux", "en-US")).toBe(p);
    const en = gen("en-US", "k1");
    expect(builtinSpeechIfContradicting(en, "windows", "de-DE")).toBe(en);
  });

  describe("through prepareIdentityOptions", () => {
    const dirs: string[] = [];
    afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
    const setup = () => {
      const root = mkdtempSync(join(tmpdir(), "ant0-speech-"));
      dirs.push(root);
      const model = structuredClone(fixture.model);
      writeFileSync(join(root, "population-model-v1.json"), JSON.stringify(model));
      return { root, identities: join(root, "ids") };
    };
    const launch = (root: string, ids: string, extra: Record<string, unknown> = {}) =>
      (prepareIdentityOptions({
        identity: { mode: "synthetic", key: "acct-1", modelDirectory: root, identityDirectory: ids },
        overrides: extra,
      }).options as any).fingerprintProfile;

    const decode = (fp: any) => JSON.stringify(fp);
    it("launch Accept-Language never changes the payload; the saved identity keeps its voices", () => {
      const { root, identities } = setup();
      launch(root, identities); // first launch creates and saves the identity
      const plain = launch(root, identities);
      expect(defaultLang(plain)).toBe("en-US");
      const saved = () => readdirSync(identities).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(identities, f), "utf8")).join("|");
      const before = saved();
      for (const l of ["en-US", "de-DE", "fr-FR", "ru-RU,ru"]) {
        expect(decode(launch(root, identities, { acceptLanguage: l }))).toBe(decode(plain));
      }
      expect(saved()).toBe(before);
    });

    it("encoded payload is byte-identical across Accept-Language values", () => {
      const { root, identities } = setup();
      const enc = (extra: Record<string, unknown>) => {
        const o = prepareIdentityOptions({
          identity: { mode: "synthetic", key: "acct-1", modelDirectory: root, identityDirectory: identities },
          overrides: extra,
        }).options as any;
        return o;
      };
      const payload = (o: any) => gunzipSync(Buffer.from(encodeProfile(o.fingerprintProfile), "base64")).toString("utf8");
      enc({}); // first launch creates and saves the identity
      const base = payload(enc({}));
      for (const l of ["en-US", "de-DE", "fr-FR"]) expect(payload(enc({ acceptLanguage: l }))).toBe(base);
    });

    it("fixed stale en-US persona encodes to the same canonical payload in both SDKs", () => {
      const stale = structuredClone(gen("en-US", "k1")) as any;
      stale.speech.voices = ruProfile().speech.voices;
      const out = cohereSpeech(stale, "windows", "de-DE", "chrome").profile;
      const fixed = builtinSpeechIfContradicting(out, "windows", "fr-FR");
      const base = gunzipSync(Buffer.from(encodeProfile(fixed as any), "base64")).toString("utf8");
      const canon = (v: any): any => Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
      expect(createHash("sha256").update(JSON.stringify(canon(JSON.parse(base)))).digest("hex")).toBe(CROSS_SDK_SHA256);
    });
  });
});
