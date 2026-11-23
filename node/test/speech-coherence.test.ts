import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertPersonaProfileV2 } from "../src/persona-profile-v2.js";
import { generatePersonaProfile } from "../src/population-model.js";
import { prepareIdentityOptions } from "../src/identity.js";
import {
  BUILTIN_WINDOWS_VOICES, builtinSpeechIfContradicting, builtinSpeechVoices, DOCUMENTED_WINDOWS_VOICE_SETS, GOOGLE_VOICES, LINUX_VOICES, WINDOWS_VOICE_SETS, cohereSpeech, languageTag,
} from "../src/speech-coherence.js";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const golden = read("../../fixtures/speech-coherence-v1.json");
const model = read("../../fixtures/synthetic/population-generate-v1.json").model;
const bare = (l: string) => l.toLowerCase().split("-")[0];

// The persona's language is `locale.primary_language`; the launch language argument is ignored.
const co = (p: any, plat: string, lang?: string, brand: unknown = "chrome") =>
  cohereSpeech(lang ? { ...p, locale: { ...p.locale, primary_language: lang, languages: [lang, lang.split("-")[0]] } } : p, plat, undefined, brand);

describe("cohereSpeech golden cases (shared with the Python SDK)", () => {
  for (const c of golden.cases) {
    it(c.label, () => {
      const r = cohereSpeech(c.profile, c.platform, c.accept_language, c.brand);
      const voices = (r.profile as any).speech.voices;
      expect({
        fallback: r.fallback, count: voices.length, default: voices.find((v: any) => v.default)?.name ?? null,
        sha256: createHash("sha256").update(JSON.stringify(voices)).digest("hex"),
      }).toEqual(c.expect);
    });
  }
});

// 2000 generated personas x 13 languages: CPU-bound, and slow on a loaded CI box. An explicit bound for
// these two tests only; the suite-wide default is unchanged.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

describe("cohereSpeech rules over many seeds", () => {
  const seeds = Array.from({ length: 2000 }, (_, i) => i);
  const profileFor = (i: number) => generatePersonaProfile(`k${i}`, createHash("sha256").update(`d${i}`).digest("hex"), model) as any;
  const withData = ["en-US", "en-GB", "de-DE", "fr-FR", "es-MX", "pt-BR", "ru-RU", "zh-CN", "tr-TR", "it-IT"];

  it("a Windows persona's default voice always has the persona language when a capture exists", () => {
    let changed = 0;
    for (const i of seeds) for (const lang of withData) {
      const orig = profileFor(i);
      const r = co(orig, "windows", lang);
      const def = (r.profile as any).speech.voices.find((v: any) => v.default);
      expect(def, `${i} ${lang}`).toBeDefined();
      expect(bare(def.language)).toBe(bare(lang));
      expect(r.fallback).toBe(false);
      if (JSON.stringify(r.profile.speech) !== JSON.stringify(orig.speech)) changed++;
    }
    expect(changed).toBeGreaterThan(0); // the test would otherwise pass on a no-op
  }, HEAVY_TEST_TIMEOUT_MS);

  it("an exact tag is preferred: en-GB gets a British default", () => {
    for (const i of seeds.slice(0, 300)) {
      const def = (co(profileFor(i), "windows", "en-GB").profile as any).speech.voices.find((v: any) => v.default);
      expect(def.language).toBe("en-GB");
    }
  });

  it("a Linux persona gets exactly the measured Chrome list, whatever its language", () => {
    const expected = LINUX_VOICES.map(([n]) => n);
    for (const i of seeds) for (const lang of [...withData, "ja-JP", "ko-KR", "xx-YY"]) {
      const r = co(profileFor(i), "linux", lang);
      const voices = (r.profile as any).speech.voices as any[];
      expect(voices.map((v) => v.name)).toEqual(expected);
      expect(voices.some((v) => /Microsoft/.test(v.name) || v.local_service)).toBe(false);
      expect(voices.filter((v) => v.default).map((v) => v.name)).toEqual(["Google Deutsch"]);
      expect(r.fallback).toBe(false);
    }
  }, HEAVY_TEST_TIMEOUT_MS);

  it("the default voice is always the first entry and native voices precede network ones", () => {
    for (const i of seeds.slice(0, 500)) for (const plat of ["windows", "linux"]) for (const lang of ["en-US", "de-DE", "ru-RU", "ja-JP"]) {
      const voices = (co(profileFor(i), plat, lang).profile as any).speech.voices as any[];
      expect(voices.findIndex((v) => v.default)).toBe(0);
      const firstNetwork = voices.findIndex((v) => !v.local_service);
      if (firstNetwork >= 0) expect(voices.slice(firstNetwork).every((v) => !v.local_service)).toBe(true);
    }
  });

  it("moves a misplaced default to the front when the profile's own list is kept", () => {
    const p = { ...profileFor(1), speech: { voices: [
      { voice_uri: "a", name: "Microsoft Zira - English (United States)", language: "en-US", local_service: true, default: false },
      { voice_uri: "b", name: "Microsoft David - English (United States)", language: "en-US", local_service: true, default: true }] } };
    const v = (co(p as any, "windows", "en-US", null).profile as any).speech.voices;
    expect(v.map((x: any) => x.name)).toEqual(["Microsoft David - English (United States)", "Microsoft Zira - English (United States)"]);
  });

  it("is stable: the same profile, platform and language give the same list", () => {
    for (const i of seeds.slice(0, 200)) {
      const p = profileFor(i);
      expect(co(p, "windows", "fr-FR").profile.speech).toEqual(co(p, "windows", "fr-FR").profile.speech);
    }
  });

  it("the launch language never changes the list: same persona, same voices for undefined, ru-RU and de-DE", () => {
    for (const i of seeds.slice(0, 200)) for (const plat of ["windows", "linux"]) {
      const p = profileFor(i);
      const base = JSON.stringify(cohereSpeech(p, plat, undefined, "chrome").profile.speech);
      for (const launch of ["ru-RU", "de-DE", "en-US", "ja-JP", "", null]) {
        expect(JSON.stringify(cohereSpeech(p, plat, launch, "chrome").profile.speech)).toBe(base);
      }
    }
  });

  it("ja-JP uses the documented Microsoft voices, not the English fallback", () => {
    for (const i of seeds.slice(0, 300)) {
      const r = co(profileFor(i), "windows", "ja-JP");
      const voices = (r.profile as any).speech.voices as any[];
      expect(r.fallback).toBe(false);
      expect(voices.slice(0, 3).map((v) => v.name)).toEqual([
        "Microsoft Ayumi - Japanese (Japan)", "Microsoft Haruka - Japanese (Japan)", "Microsoft Ichiro - Japanese (Japan)"]);
      expect(voices[0].default).toBe(true);
      expect(voices[0].language).toBe("ja-JP");
    }
    expect(Object.keys(WINDOWS_VOICE_SETS)).not.toContain("ja");
  });

  it("falls back to English and reports it when no capture exists", () => {
    const r = co(profileFor(1), "windows", "ar-EG");
    expect(r.fallback).toBe(true);
    expect((r.profile as any).speech.voices.find((v: any) => v.default).language).toBe("en-US");
  });

  it("leaves other platforms and the input object alone", () => {
    const p = profileFor(1);
    const before = JSON.stringify(p);
    expect(cohereSpeech(p, "macos", "en-US", "chrome").profile).toBe(p);
    cohereSpeech(p, "linux", "en-US");
    expect(JSON.stringify(p)).toBe(before);
  });

  it("every produced profile still validates and uses only real table names", () => {
    const real = new Set<string>([...GOOGLE_VOICES.map((g) => g[0]),
      ...Object.values(WINDOWS_VOICE_SETS).flat().flatMap((s) => s.voices.map((v) => v[0])),
      ...Object.values(DOCUMENTED_WINDOWS_VOICE_SETS).flat().flatMap((s) => s.voices.map((v) => v[0]))]);
    for (const i of seeds.slice(0, 200)) for (const plat of ["windows", "linux"]) {
      const r = co(profileFor(i), plat, "de-DE");
      assertPersonaProfileV2(r.profile);
      if (JSON.stringify(r.profile.speech) !== JSON.stringify(profileFor(i).speech)) {
        for (const v of (r.profile as any).speech.voices) expect(real.has(v.name)).toBe(true);
      }
    }
  });
});

describe("network voices follow the brand", () => {
  const prof = (i: number) => generatePersonaProfile(`k${i}`, createHash("sha256").update(`d${i}`).digest("hex"), model) as any;
  const google = GOOGLE_VOICES.map((g) => g[0]);
  const names = (r: any) => (r.profile.speech.voices as any[]).map((v) => v.name);
  const net = (r: any) => (r.profile.speech.voices as any[]).filter((v) => !v.local_service).map((v) => v.name);
  const win = (brand: unknown, lang = "en-US") => co(prof(3), "windows", lang, brand);

  const david = { voice_uri: "d", name: "Microsoft David - English (United States)", language: "en-US", local_service: true, default: true };
  const gv = (n: number) => GOOGLE_VOICES.slice(0, n).map(([name, language]) => ({ voice_uri: name, name, language, local_service: false, default: false }));
  const withList = (list: any[]) => ({ ...prof(1), speech: { voices: list } });
  const run = (list: any[], brand: unknown) => cohereSpeech(withList(list), "windows", undefined, brand).profile.speech!.voices as any[];

  it("Chrome: local voices first, then at most the 19 network voices, never doubled", () => {
    let withNet = 0;
    for (let i = 0; i < 300; i++) for (const lang of ["en-US", "de-DE", "ru-RU", "ja-JP"]) {
      const r = co(prof(i), "windows", lang, "chrome");
      const v = r.profile.speech!.voices as any[];
      const n = net(r);
      expect(n.length === 0 || n.length === 19, `${i} ${lang}`).toBe(true);
      if (n.length) { withNet++; expect(n).toEqual(google); expect(v.slice(v.length - 19).every((x) => !x.local_service)).toBe(true); }
      expect(v[0].default).toBe(true);
      expect(v.filter((x) => x.default)).toHaveLength(1);
    }
    expect(withNet).toBeGreaterThan(0);
  });
  it("Chrome: a local-only list is left for the engine to extend; exactly the 19 is kept; a partial set becomes the 19", () => {
    const local = run([david], "chrome");
    expect(local.map((v) => v.name)).toEqual([david.name]);
    const full = run([david, ...gv(19)], "Chrome");
    expect(full.map((v) => v.name)).toEqual([david.name, ...google]);
    const partial = run([david, ...gv(3)], "chrome");
    expect(partial.map((v) => v.name)).toEqual([david.name, ...google]);
    expect(partial.filter((v) => v.default).map((v) => v.name)).toEqual([david.name]);
    const again = cohereSpeech(withList([david, ...gv(3)]), "windows", undefined, "chrome").profile;
    expect(cohereSpeech(again, "windows", undefined, "chrome").profile).toBe(again);
  });
  it("Chrome: Linux is the 19 network voices alone, Google Deutsch default", () => {
    const r = co(prof(3), "linux", "en-US", "chrome");
    expect(names(r)).toEqual(google);
    expect((r.profile.speech.voices as any[]).filter((v) => v.default).map((v) => v.name)).toEqual(["Google Deutsch"]);
  });
  it("Edge and any other brand: no network voice on Windows, the local voices stay", () => {
    for (const brand of ["Edge", "edge", "Opera", "Vivaldi", "Brave", "", "chromium"]) {
      expect(run([david, ...gv(19)], brand).map((v) => v.name), String(brand)).toEqual([david.name]);
      expect(run([david, ...gv(3)], brand).map((v) => v.name)).toEqual([david.name]);
      for (let i = 0; i < 100; i++) {
        const r = co(prof(i), "windows", "en-US", brand);
        expect(net(r)).toEqual([]);
        expect(names(r).some((n) => /^Google/.test(n))).toBe(false);
        expect((r.profile.speech!.voices as any[])[0].default).toBe(true);
      }
    }
  });
  it("no brand (undefined, null, non-string): no network voice, Linux list empty", () => {
    for (const brand of [undefined, null, 5]) {
      expect(net(cohereSpeech(prof(3), "windows", undefined, brand))).toEqual([]);
      expect(names(cohereSpeech(prof(3), "linux", undefined, brand))).toEqual([]);
    }
    expect(names(co(prof(3), "linux", "en-US", "Edge"))).toEqual([]);
  });
  it("Android and macOS are left untouched under every brand", () => {
    const p = prof(2);
    for (const brand of ["chrome", "Edge", undefined]) for (const plat of ["android", "macos"]) {
      expect(cohereSpeech(p, plat, undefined, brand).profile).toBe(p);
    }
  });
  it("the engine's built-in 3-name set stays recognisable under every brand", () => {
    const builtin = { ...prof(1), speech: { voices: builtinSpeechVoices() } };
    for (const brand of ["chrome", "Edge", undefined]) expect(cohereSpeech(builtin, "windows", undefined, brand).profile).toBe(builtin);
    const stale = { ...prof(1), locale: { ...prof(1).locale, primary_language: "de-DE" },
      speech: { voices: [{ voice_uri: "x", name: "Microsoft Irina - Russian (Russia)", language: "ru-RU", local_service: true, default: true }] } };
    expect((builtinSpeechIfContradicting(stale, "windows").speech!.voices as any[]).map((v) => v.name)).toEqual(BUILTIN_WINDOWS_VOICES.map((v) => v[0]));
  });
  it("through the launch options: the brand option decides", () => {
    const captured = read("../../fixtures/synthetic/persona-v2.json");
    const voices = (overrides: any) => (prepareIdentityOptions({ identity: { mode: "captured", source: captured }, overrides }).options as any).fingerprintProfile.speech.voices as any[];
    const withNet = { ...captured, speech: { voices: [...captured.speech.voices, ...gv(19)] } };
    const netVoices = (brand?: string) => (prepareIdentityOptions({ identity: { mode: "captured", source: withNet }, ...(brand ? { overrides: { brand } } : {}) })
      .options as any).fingerprintProfile.speech.voices.filter((v: any) => !v.local_service).map((v: any) => v.name);
    expect(netVoices()).toEqual(google); // the default brand is chrome
    expect(netVoices("chrome")).toEqual(google);
    expect(netVoices("Edge")).toEqual([]);
    expect(voices({ brand: "Edge" }).some((v) => !v.local_service)).toBe(false);
  });
});

describe("languageTag", () => {
  it("normalises an Accept-Language style value", () => {
    expect(languageTag("en-us,en;q=0.9")).toBe("en-US");
    expect(languageTag("de_DE")).toBe("de-DE");
    expect(languageTag("")).toBe("");
    expect(languageTag(undefined)).toBe("");
    expect(languageTag("not a tag")).toBe("");
  });
});

describe("identity wiring", () => {
  const captured = read("../../fixtures/synthetic/persona-v2.json");
  const speech = (opts: any) => (prepareIdentityOptions({ identity: { mode: "captured", source: captured }, ...opts }).options as any).fingerprintProfile.speech.voices;

  it("a Linux launch drops Windows voices, a Windows one keeps its capture's language", () => {
    // (A Linux platform override on this Windows capture is refused; see platform-mismatch.test.ts.)
    expect(speech({ overrides: { platform: "windows" } }).some((v: any) => /Example Voice/.test(v.name))).toBe(true);
    // The launch language (which can come from the proxy's exit IP) must not change the list.
    const base = JSON.stringify(speech({}));
    for (const l of ["fr-FR", "ru-RU", "de-DE"]) expect(JSON.stringify(speech({ overrides: { acceptLanguage: l } }))).toBe(base);
  });
});
