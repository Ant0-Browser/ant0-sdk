/** Coherent `speechSynthesis` voice lists, built from rules instead of an independent random draw.
 *
 * The population model draws a persona's voices independently of its platform and language, so a
 * measured 82.6 percent of personas had a default voice in another language than the persona, and
 * 98 percent of Linux personas carried Windows (Microsoft) voices. Both are contradictions a page
 * can read in one line. At launch, when the platform and language are known, this module rewrites
 * `speech.voices` by these rules, keyed on the persona's own language (`locale.primary_language`),
 * never on the launch language, which can follow a proxy's exit IP, except for the one launch-time safety net
 * `builtinSpeechIfContradicting` below (identical in the Python SDK; the shared fixture
 * `fixtures/speech-coherence-v1.json` pins both):
 *
 *  - Linux persona: never a Microsoft voice. The list is LINUX_VOICES, ONE TABLE ENTRY THAT MAY STILL
 *    CHANGE WITH FURTHER MEASUREMENT: edit it here and in `_speech_coherence.py` (and the fixture).
 *    It is exactly what real Chrome 158 Beta on Linux listed (tests/voices-linux, measured on a
 *    server; that a desktop matches is inferred): 19 network `Google ...` voices, no local ones,
 *    `Google Deutsch` (de-DE) default under --lang en-US, de-DE, ja-JP and fr-FR alike. The default
 *    does not follow the language, so the Linux list is the same for every identity and language,
 *    and the "default voice has the persona language" rule applies to Windows only.
 *  - Windows persona: the profile's own list is kept when its default voice already has the persona
 *    language (it is a real capture). Otherwise one of the real captured Windows sets whose default
 *    voice is in that language is chosen, weighted by how often it was captured and keyed on the
 *    profile so the same profile always gets the same list. An exact language tag (en-GB) is
 *    preferred over the bare language (en). For a language with no capture but listed in
 *    Microsoft's Appendix A (ja-JP, ko-KR, pl-PL, ...), DOCUMENTED_WINDOWS_VOICE_SETS is used: the
 *    voice names are Microsoft's, NOT captured from a browser, and the display labels are inferred
 *    (lower confidence). With neither (for example ar-EG) it falls back to English; `fallback` in the
 *    result says so.
 *  - Every list this module builds has its default voice first, because stock Chrome marks the first
 *    listed voice as the default (`is_default = (i == 0)` in speech_synthesis_impl.cc); on Windows the
 *    persona-language voice leads and native voices come before the network ones, as in every capture.
 *  - Brand: the 19 network voices exist only under the Chrome brand (the engine appends them for a Chrome desktop
 *    claim). Chrome gets the local voices followed by exactly those 19; any other brand (Edge, none, ...)
 *    gets the local voices only, so the Linux list is then empty. The brand is `options.brand`, the value sent as
 *    `--fingerprint-brand`; the Windows `net` flag of a captured set only says the capture had network voices.
 *  - Any other platform (macos, android): left as is. The repo holds no real voice capture for them.
 *
 * Voice names are those in the population model's captures (real browsers) and, marked as documented
 * rather than captured, Microsoft's Appendix A. Nothing else is made up.
 * Captured Windows sets: the population model's `speech` group (26 captures): their local voices,
 * followed by the 19 Google network voices when the capture had them.
 */
import { createHash } from "node:crypto";
import type { PersonaProfileV2 } from "./persona-profile-v2.js";

type V = [name: string, language: string, isDefault: boolean];

/** The 19 network voices real Chrome lists (name, language), in captured order. */
export const GOOGLE_VOICES: ReadonlyArray<readonly [string, string]> = [
  ["Google Deutsch", "de-DE"],
  ["Google US English", "en-US"],
  ["Google UK English Female", "en-GB"],
  ["Google UK English Male", "en-GB"],
  ["Google espa\u00f1ol", "es-ES"],
  ["Google espa\u00f1ol de Estados Unidos", "es-US"],
  ["Google fran\u00e7ais", "fr-FR"],
  ["Google \u0939\u093f\u0928\u094d\u0926\u0940", "hi-IN"],
  ["Google Bahasa Indonesia", "id-ID"],
  ["Google italiano", "it-IT"],
  ["Google \u65e5\u672c\u8a9e", "ja-JP"],
  ["Google \ud55c\uad6d\uc758", "ko-KR"],
  ["Google Nederlands", "nl-NL"],
  ["Google polski", "pl-PL"],
  ["Google portugu\u00eas do Brasil", "pt-BR"],
  ["Google \u0440\u0443\u0441\u0441\u043a\u0438\u0439", "ru-RU"],
  ["Google\u00a0\u666e\u901a\u8bdd\uff08\u4e2d\u56fd\u5927\u9646\uff09", "zh-CN"],
  ["Google\u00a0\u7ca4\u8a9e\uff08\u9999\u6e2f\uff09", "zh-HK"],
  ["Google \u570b\u8a9e\uff08\u81fa\u7063\uff09", "zh-TW"],
];

/** Linux persona voice list (name, language, default). Single entry, flagged: see the module comment. */
export const LINUX_VOICES: ReadonlyArray<readonly [string, string, boolean]> =
  GOOGLE_VOICES.map(([n, l]) => [n, l, n === "Google Deutsch"] as const);

/** Real captured Windows voice sets by the bare language of their default voice. `w` is the
 * capture weight in the population model; `net` says whether the Google voices followed. */
export const WINDOWS_VOICE_SETS: Readonly<Record<string, ReadonlyArray<{ w: number; net: boolean; voices: V[] }>>> = {
  "ru": [
    { w: 418614, net: true, voices: [["Microsoft Irina - Russian (Russia)", "ru-RU", true], ["Microsoft Pavel - Russian (Russia)", "ru-RU", false]] },
    { w: 234653, net: true, voices: [["Microsoft Irina - Russian (Russia)", "ru-RU", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft David - English (United States)", "en-US", false], ["Microsoft Pavel - Russian (Russia)", "ru-RU", false]] },
    { w: 5743, net: false, voices: [["Microsoft Irina - Russian (Russia)", "ru-RU", true], ["Microsoft Pavel - Russian (Russia)", "ru-RU", false]] },
    { w: 4950, net: true, voices: [["Microsoft Irina - Russian (Russia)", "ru-RU", true], ["Microsoft Hazel - English (United Kingdom)", "en-GB", false], ["Microsoft Susan - English (United Kingdom)", "en-GB", false], ["Microsoft David - English (United States)", "en-US", false], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft George - English (United Kingdom)", "en-GB", false], ["Microsoft Pavel - Russian (Russia)", "ru-RU", false]] },
    { w: 3366, net: true, voices: [["Microsoft Irina Mobile - Russian (Russia)", "ru-RU", true], ["Microsoft Pavel Mobile - Russian (Russia)", "ru-RU", false]] },
    { w: 2772, net: false, voices: [["Microsoft Irina - Russian (Russia)", "ru-RU", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft David - English (United States)", "en-US", false], ["Microsoft Pavel - Russian (Russia)", "ru-RU", false]] },
  ],
  "en": [
    { w: 153663, net: true, voices: [["Microsoft David - English (United States)", "en-US", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false]] },
    { w: 37030, net: true, voices: [["Microsoft Zira Desktop - English (United States)", "en-US", true]] },
    { w: 20198, net: true, voices: [["Microsoft David - English (United States)", "en-US", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft Irina - Russian (Russia)", "ru-RU", false], ["Microsoft Pavel - Russian (Russia)", "ru-RU", false]] },
    { w: 7327, net: true, voices: [["Microsoft George - English (United Kingdom)", "en-GB", true], ["Microsoft Hazel - English (United Kingdom)", "en-GB", false], ["Microsoft Susan - English (United Kingdom)", "en-GB", false]] },
    { w: 5347, net: true, voices: [["Microsoft David Mobile - English (United States)", "en-US", true], ["Microsoft Mark Mobile - English (United States)", "en-US", false], ["Microsoft Zira Mobile - English (United States)", "en-US", false]] },
    { w: 4950, net: true, voices: [["Microsoft David - English (United States)", "en-US", true], ["Microsoft Ravi - English (India)", "en-IN", false], ["Microsoft Heera - English (India)", "en-IN", false], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false]] },
    { w: 4752, net: true, voices: [["Microsoft George - English (United Kingdom)", "en-GB", true], ["Microsoft Hazel - English (United Kingdom)", "en-GB", false], ["Microsoft Susan - English (United Kingdom)", "en-GB", false], ["Microsoft David - English (United States)", "en-US", false], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false]] },
    { w: 3564, net: true, voices: [["Microsoft David - English (United States)", "en-US", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft An - Vietnamese (Vietnam)", "vi-VN", false]] },
    { w: 3564, net: false, voices: [["Microsoft David - English (United States)", "en-US", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false]] },
    { w: 2970, net: true, voices: [["Microsoft David - English (United States)", "en-US", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft Asaf - Hebrew (Israel)", "he-IL", false]] },
  ],
  "tr": [
    { w: 23168, net: true, voices: [["Microsoft Tolga - Turkish (Turkey)", "tr-TR", true]] },
    { w: 1980, net: true, voices: [["Microsoft Tolga - Turkish (Turkey)", "tr-TR", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft David - English (United States)", "en-US", false]] },
  ],
  "fr": [
    { w: 10693, net: true, voices: [["Microsoft Hortense - French (France)", "fr-FR", true], ["Microsoft Julie - French (France)", "fr-FR", false], ["Microsoft Paul - French (France)", "fr-FR", false]] },
    { w: 4158, net: true, voices: [["Microsoft Hortense - French (France)", "fr-FR", true], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft David - English (United States)", "en-US", false], ["Microsoft Julie - French (France)", "fr-FR", false], ["Microsoft Paul - French (France)", "fr-FR", false]] },
  ],
  "zh": [
    { w: 10693, net: true, voices: [["Microsoft Huihui - Chinese (Simplified, PRC)", "zh-CN", true], ["Microsoft Kangkang - Chinese (Simplified, PRC)", "zh-CN", false], ["Microsoft Yaoyao - Chinese (Simplified, PRC)", "zh-CN", false]] },
  ],
  "pt": [
    { w: 8713, net: true, voices: [["Microsoft Daniel - Portuguese (Brazil)", "pt-BR", true], ["Microsoft Maria - Portuguese (Brazil)", "pt-BR", false]] },
  ],
  "es": [
    { w: 4752, net: true, voices: [["Microsoft Helena - Spanish (Spain)", "es-ES", true], ["Microsoft Laura - Spanish (Spain)", "es-ES", false], ["Microsoft Pablo - Spanish (Spain)", "es-ES", false]] },
  ],
  "it": [
    { w: 2574, net: true, voices: [["Microsoft Cosimo - Italian (Italy)", "it-IT", true], ["Microsoft Elsa - Italian (Italy)", "it-IT", false]] },
  ],
  "de": [
    { w: 1980, net: true, voices: [["Microsoft Hedda - German (Germany)", "de-DE", true], ["Microsoft Katja - German (Germany)", "de-DE", false], ["Microsoft Stefan - German (Germany)", "de-DE", false], ["Microsoft David - English (United States)", "en-US", false], ["Microsoft Mark - English (United States)", "en-US", false], ["Microsoft Zira - English (United States)", "en-US", false], ["Microsoft Irina - Russian (Russia)", "ru-RU", false], ["Microsoft Pavel - Russian (Russia)", "ru-RU", false]] },
  ],
};

// Languages with no real capture, taken from Microsoft's Appendix A (supported languages and voices).
// DOCUMENTED, NOT CAPTURED: the voice names are Microsoft's; the display label and the Google voices
// following them follow the captured sets' format and are inferred. Lower confidence than WINDOWS_VOICE_SETS.
export const DOCUMENTED_WINDOWS_VOICE_SETS: Readonly<Record<string, ReadonlyArray<{ w: number; net: boolean; voices: V[] }>>> = {
  "ja": [{ w: 1, net: true, voices: [["Microsoft Ayumi - Japanese (Japan)", "ja-JP", true], ["Microsoft Haruka - Japanese (Japan)", "ja-JP", false], ["Microsoft Ichiro - Japanese (Japan)", "ja-JP", false]] }],
  "ko": [{ w: 1, net: true, voices: [["Microsoft Heami - Korean (Korea)", "ko-KR", true]] }],
  "pl": [{ w: 1, net: true, voices: [["Microsoft Paulina - Polish (Poland)", "pl-PL", true], ["Microsoft Adam - Polish (Poland)", "pl-PL", false]] }],
  "cs": [{ w: 1, net: true, voices: [["Microsoft Jakub - Czech (Czech Republic)", "cs-CZ", true]] }],
  "hu": [{ w: 1, net: true, voices: [["Microsoft Szabolcs - Hungarian (Hungary)", "hu-HU", true]] }],
  "ro": [{ w: 1, net: true, voices: [["Microsoft Andrei - Romanian (Romania)", "ro-RO", true]] }],
  "sk": [{ w: 1, net: true, voices: [["Microsoft Filip - Slovak (Slovakia)", "sk-SK", true]] }],
  "th": [{ w: 1, net: true, voices: [["Microsoft Pattara - Thai (Thailand)", "th-TH", true]] }],
  "hi": [{ w: 1, net: true, voices: [["Microsoft Kalpana - Hindi (India)", "hi-IN", true], ["Microsoft Hemant - Hindi (India)", "hi-IN", false]] }],
  "id": [{ w: 1, net: true, voices: [["Microsoft Andika - Indonesian (Indonesia)", "id-ID", true]] }],
  "nl": [{ w: 1, net: true, voices: [["Microsoft Frank - Dutch (Netherlands)", "nl-NL", true]] }],
  "sv": [{ w: 1, net: true, voices: [["Microsoft Bengt - Swedish (Sweden)", "sv-SE", true]] }],
  "da": [{ w: 1, net: true, voices: [["Microsoft Helle - Danish (Denmark)", "da-DK", true]] }],
  "fi": [{ w: 1, net: true, voices: [["Microsoft Heidi - Finnish (Finland)", "fi-FI", true]] }],
  "el": [{ w: 1, net: true, voices: [["Microsoft Stefanos - Greek (Greece)", "el-GR", true]] }],
  "bg": [{ w: 1, net: true, voices: [["Microsoft Ivan - Bulgarian (Bulgaria)", "bg-BG", true]] }],
  "hr": [{ w: 1, net: true, voices: [["Microsoft Matej - Croatian (Croatia)", "hr-HR", true]] }],
  "sl": [{ w: 1, net: true, voices: [["Microsoft Lado - Slovenian (Slovenia)", "sl-SI", true]] }],
  "ms": [{ w: 1, net: true, voices: [["Microsoft Rizwan - Malay (Malaysia)", "ms-MY", true]] }],
  "nb": [{ w: 1, net: true, voices: [["Microsoft Jon - Norwegian (Norway)", "nb-NO", true]] }],
};

const ALL_WINDOWS_SETS = { ...DOCUMENTED_WINDOWS_VOICE_SETS, ...WINDOWS_VOICE_SETS };

const FALLBACK_LANGUAGE = "en-US";

/** First tag of an Accept-Language style value, as `ll-RR` (case normalised), or "" if none. */
export function languageTag(value: unknown): string {
  if (typeof value !== "string") return "";
  const first = value.split(",")[0].split(";")[0].trim().replace(/_/g, "-");
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(first)) return "";
  const [lang, ...rest] = first.split("-");
  return [lang.toLowerCase(), ...rest.map((p, i) => (i === 0 && p.length === 2 ? p.toUpperCase() : p))].join("-");
}
const primary = (tag: string): string => tag.split("-")[0].toLowerCase();

function stableKey(profile: PersonaProfileV2): string {
  const p = profile as unknown as {
    speech?: { voices?: Array<{ name?: string }> };
    hardware?: { hardware_concurrency?: number; device_memory_gb?: number };
    display?: { width?: number; height?: number };
  };
  const names = (p.speech?.voices ?? []).map((v) => v.name).join("\u0001");
  return `${names}|${p.hardware?.hardware_concurrency}|${p.hardware?.device_memory_gb}|${p.display?.width}x${p.display?.height}`;
}

function pickWeighted<T extends { w: number }>(items: ReadonlyArray<T>, key: string): T {
  const total = items.reduce((s, x) => s + x.w, 0);
  let r = Number(BigInt("0x" + createHash("sha256").update(key).digest("hex").slice(0, 16)) % BigInt(total));
  for (const x of items) {
    if (r < x.w) return x;
    r -= x.w;
  }
  return items[items.length - 1];
}

function toProfileVoices(list: V[]): Array<Record<string, unknown>> {
  return list.map(([name, language, isDefault]) => ({
    voice_uri: name, name, language, local_service: !GOOGLE_NAMES.has(name), default: isDefault,
  }));
}
const GOOGLE_NAMES = new Set(GOOGLE_VOICES.map((g) => g[0]));

/** The engine's built-in default Windows voice set. The engine recognises it by
 * exactly these three names in this order and then
 * rebuilds the list for the Accept-Language at runtime (`PersonaVoicesForAcceptLanguages`: the matching
 * language pack first and default, then two en-US base voices). Any other list is treated as a real capture
 * and passed through unchanged. Used as the answer when no captured set fits a language. */
export const BUILTIN_WINDOWS_VOICES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["Microsoft David - English (United States)", "en-US", true],
  ["Microsoft Zira - English (United States)", "en-US", false],
  ["Microsoft Mark - English (United States)", "en-US", false],
];

/** The built-in set as profile `speech.voices` entries. */
export function builtinSpeechVoices(): Array<Record<string, unknown>> {
  return toProfileVoices(BUILTIN_WINDOWS_VOICES.map(([n, l, d]) => [n, l, d] as V));
}

function defaultVoiceLanguage(voices: unknown): string {
  if (!Array.isArray(voices) || !voices.length) return "";
  const list = voices as Array<{ language?: unknown; default?: unknown }>;
  const d = list.find((v) => v && v.default === true) ?? list[0];
  return typeof d?.language === "string" ? d.language : "";
}

/** Generator rule: of the model's `speech` values, those whose DEFAULT voice's primary language equals the
 * persona's (en matches en-US and en-GB). An exact tag match (en-US default for an en-US persona) is preferred
 * over the bare language. Returns [] when nothing fits; the caller then uses `builtinSpeechVoices()`. Order of
 * the input is kept, so the caller's weighted draw stays deterministic. */
export function speechValuesForLocale<T extends { payload: unknown }>(values: ReadonlyArray<T>, localeTag: unknown): T[] {
  const tag = languageTag(localeTag) || FALLBACK_LANGUAGE;
  const lang = (v: T) => defaultVoiceLanguage((v.payload as { voices?: unknown } | null)?.voices);
  const exact = values.filter((v) => lang(v).replace(/_/g, "-").toLowerCase() === tag.toLowerCase());
  if (exact.length) return exact;
  return values.filter((v) => { const l = lang(v); return l !== "" && primary(l) === primary(tag); });
}

/** Safety net (launch payload only, never saved). A Windows persona whose default voice language contradicts the
 * persona's OWN language (`locale.primary_language`, the same source the generator filter uses) gets the built-in
 * set, e.g. an old saved identity that carries a ru-default set. The launch Accept-Language is never consulted
 * (the third argument is accepted for compatibility and ignored): the engine hashes the voices into the persona
 * key, so anything launch-dependent would change audio/measureText/netinfo between launches of one identity.
 * Other platforms and a list that already agrees are returned untouched. */
export function builtinSpeechIfContradicting(profile: PersonaProfileV2, platform: unknown, _acceptLanguage?: unknown): PersonaProfileV2 {
  const plat = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  if (plat !== "windows" && plat !== "") return profile;
  const p = profile as unknown as { locale?: { primary_language?: unknown }; speech?: { voices?: unknown } };
  const own = languageTag(p.locale?.primary_language) || FALLBACK_LANGUAGE;
  const dv = defaultVoiceLanguage(p.speech?.voices);
  if (!dv || primary(dv) === primary(own)) return profile;
  return { ...profile, speech: { voices: builtinSpeechVoices() } } as unknown as PersonaProfileV2;
}

export interface SpeechResult {
  profile: PersonaProfileV2;
  /** True when the persona language had no real Windows capture and English was used. */
  fallback: boolean;
}

/** True for the brand the engine treats as branded Google Chrome (`--fingerprint-brand chrome`, case-insensitive).
 * Only that brand loads Chrome's network speech extension; Edge, Brave, Opera, an absent brand and the rest do not. */
export function isChromeBrand(brand: unknown): boolean {
  return typeof brand === "string" && brand.trim().toLowerCase() === "chrome";
}

/** Brand rule for the network voices, the SDK side of the engine's `PersonaVoicesForAcceptLanguages`.
 * The engine appends the 19 Google network voices after the local ones for a Chrome desktop claim, but only when the
 * list holds no network voice at all. So under the Chrome brand a list with none is left to the engine (nothing is
 * appended here, which also keeps the engine's built-in 3-name set recognisable), and a list with some but not
 * exactly the 19 is made local voices plus exactly the 19, since the engine would leave it as it is. Under any other
 * brand every network voice is dropped (Linux then lists nothing). Windows and Linux only; the caller leaves other
 * platforms alone. */
export function applyBrandVoices(profile: PersonaProfileV2, brand: unknown): PersonaProfileV2 {
  const voices = ((profile as unknown as { speech?: { voices?: Array<Record<string, unknown>> } }).speech?.voices ?? []);
  const local = voices.filter((v) => v.local_service !== false);
  const withVoices = (list: Array<Record<string, unknown>>): PersonaProfileV2 =>
    ({ ...profile, speech: { voices: list } }) as unknown as PersonaProfileV2;
  if (!isChromeBrand(brand)) return local.length === voices.length ? profile : withVoices(local);
  const network = voices.length - local.length;
  if (network === 0) return profile;
  if (network === GOOGLE_VOICES.length && voices.slice(local.length).every((v, i) => v.name === GOOGLE_VOICES[i][0])) return profile;
  return withVoices([...local, ...toProfileVoices(GOOGLE_VOICES.map(([n, l]) => [n, l, local.length === 0 && n === GOOGLE_VOICES[0][0]] as V))]);
}

/** Rewrite `profile.speech` for the launch platform, the persona's own language (`locale.primary_language`;
 * the third argument is accepted for compatibility and ignored) and the browser brand (network voices only under
 * Chrome, see `applyBrandVoices`). Pure; never modifies the input. */
export function cohereSpeech(profile: PersonaProfileV2, platform: unknown, _acceptLanguage?: unknown, brand?: unknown): SpeechResult {
  const r = cohereSpeechByPlatform(profile, platform);
  const plat = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  if (plat !== "linux" && plat !== "windows" && plat !== "") return r;
  return { ...r, profile: applyBrandVoices(r.profile, brand) };
}

function cohereSpeechByPlatform(profile: PersonaProfileV2, platform: unknown): SpeechResult {
  const plat = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  const prof = profile as unknown as { locale?: { primary_language?: string }; speech?: { voices?: Array<{ language: string; default: boolean }> } };
  // Keyed on the persona's own language only. The launch language can come from the proxy's exit IP
  // (geo.source "proxy") and change every launch; a real machine's voices do not follow its exit IP.
  const tag = languageTag(prof.locale?.primary_language) || FALLBACK_LANGUAGE;
  const withVoices = (voices: Array<Record<string, unknown>>): PersonaProfileV2 =>
    ({ ...profile, speech: { voices } }) as unknown as PersonaProfileV2;

  if (plat === "linux") {
    return { profile: withVoices(toProfileVoices(LINUX_VOICES.map(([n, l, d]) => [n, l, d] as V))), fallback: false };
  }
  if (plat !== "windows" && plat !== "") return { profile, fallback: false };

  const exact = Object.values(ALL_WINDOWS_SETS).flat().filter((s) => s.voices.some(([, l, d]) => d && l.toLowerCase() === tag.toLowerCase()));
  const bare = (ALL_WINDOWS_SETS[primary(tag)] ?? []);
  const hasData = bare.length > 0;
  const pool = exact.length ? exact : hasData ? bare : (WINDOWS_VOICE_SETS[primary(FALLBACK_LANGUAGE)] ?? []).filter((s) => s.voices.some(([, l, d]) => d && l === FALLBACK_LANGUAGE));
  const current = prof.speech?.voices?.find((v) => v.default);
  const want = exact.length ? (l: string) => l.toLowerCase() === tag.toLowerCase()
    : hasData ? (l: string) => primary(l) === primary(tag)
    : (l: string) => primary(l) === primary(FALLBACK_LANGUAGE);
  if (current && want(current.language)) {
    // Stock Chrome marks the first listed voice as the default (content/browser/speech/
    // speech_synthesis_impl.cc: `is_default = (i == 0)`), so a default anywhere else is a tell.
    const voices = (profile as unknown as { speech: { voices: Array<{ default: boolean }> } }).speech.voices;
    const at = voices.findIndex((v) => v.default);
    if (at <= 0) return { profile, fallback: !hasData };
    return { profile: withVoices([voices[at], ...voices.filter((_, i) => i !== at)] as Array<Record<string, unknown>>), fallback: !hasData };
  }
  const set = pickWeighted(pool, stableKey(profile));
  const list: V[] = [...set.voices, ...(set.net ? GOOGLE_VOICES.map(([n, l]) => [n, l, false] as V) : [])];
  return { profile: withVoices(toProfileVoices(list)), fallback: !hasData };
}
