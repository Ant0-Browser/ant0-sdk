/** Public three-mode identity API and canonical template loading. */

import { builtinSpeechIfContradicting, cohereSpeech } from "./speech-coherence.js";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, parse, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  createOrLoadGeneratedIdentity, createOrLoadIdentity, loadPersistedIdentity,
} from "./identity-persistence.js";
import { FINGERPRINT_KEYS } from "./fingerprint.js";
import { assertPersonaProfileV2, type PersonaProfileV2 } from "./persona-profile-v2.js";
import { assertPersonaProfileV4, isPersonaV4, type PersonaProfileV4 } from "./persona-profile-v4.js";
import { assertCanvasNoiseKey, assertCanvasOption, canvasMode, canvasNoiseKeyFor } from "./canvas.js";
import { loadPopulationModel } from "./population-model.js";
import type { PersonaTemplate } from "./template-selection.js";
import { SdkInputError, SdkTypeError } from "./errors.js";
import { warnCanvasBridgeRemoved, warnCanvasNoiseNoKey, warnPersonaIdentityOverride } from "./warnings.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface NativeIdentity { mode: "native" }
export interface CapturedIdentity { mode: "captured"; source: string | Record<string, unknown> }
export interface SyntheticIdentity {
  mode: "synthetic";
  key: string;
  templateDirectory?: string;
  modelDirectory?: string;
  identityDirectory?: string;
}
export type Identity = NativeIdentity | CapturedIdentity | SyntheticIdentity;
/** Per-launch audio profile override. Each field is optional; a field left out keeps the persona's
 * value. Applied to the profile payload at launch only; a saved identity is never rewritten. */
export interface AudioProfileOverride {
  /** AudioContext.sampleRate in Hz, 8000 to 384000. */
  sampleRate?: number;
  /** AudioContext.baseLatency in seconds, greater than 0 and at most 1. */
  baseLatency?: number;
  /** AudioContext.outputLatency in seconds, 0 to 1. */
  outputLatency?: number;
}
/** Per-launch `navigator.connection` override (engine >= ant0.7). Each field is optional; `null` or `undefined`
 * means not given. `rtt` and `downlink` replace the persona's BASE link values; the page still sees them through
 * the per-host factor (0.90 to 1.10) and Chrome's rounding (rtt a multiple of 50 ms, downlink at most 10 in 0.05
 * steps), so the reported numbers can differ from the base (a base of 250 ms reports 250 to 300). `effectiveType`
 * is one value for the machine and follows from the base rtt (4g below 272 ms, 3g below 1420, 2g below 2010,
 * else slow-2g). Giving `effectiveType` together with an `rtt` that implies another type is REJECTED. Giving only
 * `effectiveType` below 4g derives rtt and downlink from Chrome's typical values for it; below 4g a `downlink`
 * is capped like Chrome's ClampKbpsBasedOnEct (0.14, 0.262, 1.4 Mbps).
 * Applied to the launch payload only; a saved identity is never rewritten. */
export interface NetworkOverride {
  /** Base RTT in ms, greater than 0 and at most 3000. */
  rtt?: number;
  /** Base downlink in Mbps, greater than 0 and at most 1000. */
  downlink?: number;
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
}
export type IdentityOverrides = Omit<import("./fingerprint.js").FingerprintOptions,
  "fingerprint" | "fingerprintProfile" | "fingerprintProfileFile" | "lightStealth"> & { audioProfile?: AudioProfileOverride; network?: NetworkOverride };

const NETWORK_FIELDS: ReadonlyArray<[keyof NetworkOverride, string]> = [
  ["rtt", "rtt_ms"], ["downlink", "downlink_mbps"], ["effectiveType", "effective_type"],
];
const NETWORK_ECT = ["slow-2g", "2g", "3g", "4g"];
/** Chrome's effective connection type for a base RTT: net/nqe/network_quality_estimator.cc:1062-1076 with the
 * default thresholds net/nqe/network_quality_estimator_params.h:29-32. */
function ectForRtt(ms: number): string {
  return ms >= 2010 ? "slow-2g" : ms >= 1420 ? "2g" : ms >= 272 ? "3g" : "4g";
}

/** Validate a `network` override and return the profile with a `network` block. The input is not mutated. */
export function applyNetworkOverride(profile: PersonaProfileV2, value: unknown): PersonaProfileV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SdkTypeError("sdk.identity_invalid", "network must be an object");
  }
  const given = value as Record<string, unknown>;
  const unknownKeys = Object.keys(given).filter((k) => !NETWORK_FIELDS.some((f) => f[0] === k));
  if (unknownKeys.length) throw new SdkInputError("sdk.identity_invalid", `unsupported network field(s): ${unknownKeys.join(", ")}`);
  const network: Record<string, unknown> = {};
  for (const [key, wire] of NETWORK_FIELDS) {
    const v = given[key];
    if (v === undefined || v === null) continue; // null = not given, as in the Python SDK
    if (key === "effectiveType") {
      if (typeof v !== "string" || !NETWORK_ECT.includes(v)) {
        throw new SdkInputError("sdk.identity_invalid", `network.effectiveType must be one of: ${NETWORK_ECT.join(", ")}`);
      }
    } else {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new SdkTypeError("sdk.identity_invalid", `network.${key} must be a finite number`);
      }
      const max = key === "rtt" ? 3000 : 1000;
      if (!(v > 0 && v <= max)) {
        throw new SdkInputError("sdk.identity_invalid", `network.${key} must be greater than 0 and at most ${max}`);
      }
    }
    network[wire] = v;
  }
  if (!Object.keys(network).length) return profile;
  if (network.rtt_ms !== undefined && network.effective_type !== undefined) {
    const implied = ectForRtt(network.rtt_ms as number);
    if (implied !== network.effective_type) {
      throw new SdkInputError("sdk.identity_invalid",
        `network.effectiveType "${network.effective_type}" contradicts network.rtt ${network.rtt_ms} ms, which is "${implied}" in Chrome (slow-2g from 2010 ms, 2g from 1420, 3g from 272, else 4g); give one of them, or consistent values`);
    }
  }
  return { ...profile, network } as unknown as PersonaProfileV2;
}

const AUDIO_FIELDS: ReadonlyArray<[keyof AudioProfileOverride, string, (n: number) => boolean, string]> = [
  ["sampleRate", "sample_rate", (n) => n >= 8000 && n <= 384000, "between 8000 and 384000"],
  ["baseLatency", "base_latency", (n) => n > 0 && n <= 1, "greater than 0 and at most 1"],
  ["outputLatency", "output_latency", (n) => n >= 0 && n <= 1, "between 0 and 1"],
];

/** Validate an `audioProfile` override and return the profile with those `audio` fields replaced.
 * The input profile is not mutated. */
export function applyAudioProfile(profile: PersonaProfileV2, value: unknown): PersonaProfileV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SdkTypeError("sdk.identity_invalid", "audioProfile must be an object");
  }
  const given = value as Record<string, unknown>;
  const unknownKeys = Object.keys(given).filter((k) => !AUDIO_FIELDS.some((f) => f[0] === k));
  if (unknownKeys.length) throw new SdkInputError("sdk.identity_invalid", `unsupported audioProfile field(s): ${unknownKeys.join(", ")}`);
  const audio: Record<string, unknown> = { ...(profile.audio as unknown as Record<string, unknown>) };
  for (const [key, wire, ok, range] of AUDIO_FIELDS) {
    const n = given[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new SdkTypeError("sdk.identity_invalid", `audioProfile.${key} must be a finite number`);
    }
    if (!ok(n)) throw new SdkInputError("sdk.identity_invalid", `audioProfile.${key} must be ${range}`);
    audio[wire] = n;
  }
  return { ...profile, audio } as unknown as PersonaProfileV2;
}

function readJsonFile(path: string, kind: string): unknown {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new SdkInputError("sdk.identity_source_unreadable", "not a regular file");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
  } catch (error) {
    throw new SdkInputError("sdk.identity_source_unreadable", `cannot load ${kind}: ${path}: ${String(error)}`, { cause: error });
  }
}

/** Load a deterministic, strictly validated pool of flat JSON templates. */
export function loadTemplateDirectory(directory: string): PersonaTemplate[] {
  const path = resolve(directory);
  let names: string[];
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SdkInputError("sdk.identity_source_unreadable", "not a regular directory");
    names = readdirSync(path).sort();
  } catch (error) {
    throw new SdkInputError("sdk.identity_source_unreadable", `cannot read template directory: ${path}: ${String(error)}`, { cause: error });
  }
  const templates: PersonaTemplate[] = [];
  for (const name of names) {
    const entry = resolve(path, name);
    let stat;
    try { stat = lstatSync(entry); } catch (error) {
      throw new SdkInputError("sdk.identity_source_unreadable", `cannot inspect template directory entry: ${entry}`, { cause: error });
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SdkInputError("sdk.identity_source_unreadable", `template directory entry is not a regular file: ${entry}`);
    }
    if (extname(name) !== ".json") continue;
    const id = parse(name).name;
    if (!SAFE_ID.test(id)) throw new SdkInputError("sdk.identity_source_unreadable", `unsafe template filename stem: ${JSON.stringify(id)}`);
    const profile = readJsonFile(entry, "template");
    try { assertPersonaProfileV2(profile); } catch (error) {
      throw new SdkInputError("sdk.identity_source_unreadable", `invalid template ${entry}: ${String(error)}`, { cause: error });
    }
    templates.push({ id, profile });
  }
  if (!templates.length) throw new SdkInputError("sdk.identity_source_unreadable", `template directory contains no .json profiles: ${path}`);
  return templates;
}

/** Load and validate a canonical captured profile from a path, object, or JSON string. */
export function loadCapturedProfile(source: string | Record<string, unknown>): PersonaProfileV2 | PersonaProfileV4 {
  let profile: unknown;
  if (typeof source === "string") {
    profile = existsSync(source) ? readJsonFile(source, "captured profile") : (() => {
      try { return JSON.parse(source); } catch (error) {
        throw new SdkInputError("sdk.identity_invalid", "captured identity source must be a profile object, JSON, or existing path", { cause: error });
      }
    })();
  } else if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    profile = source;
  } else {
    throw new SdkTypeError("sdk.identity_invalid", "captured identity source must be a profile object, JSON, or path");
  }
  if (isPersonaV4(profile)) {
    assertPersonaProfileV4(profile);
    return profile;
  }
  assertPersonaProfileV2(profile);
  return profile;
}

export interface ResolvedIdentity {
  mode: Identity["mode"];
  fingerprintProfile?: PersonaProfileV2 | PersonaProfileV4;
  /** Persona OS (from the profile's compatibility.os_family), so the browser presents the
   * profile's OS regardless of the host binary. A caller `overrides.platform` still wins. */
  platform?: string;
  /** Persona brand. Personas are plain-Chrome captures, so default to Google Chrome; otherwise
   * navigator.userAgentData advertises only "Chromium" (a UA/UA-CH mismatch). A
   * caller `overrides.brand` still wins. */
  brand?: string;
}

export interface PreparedIdentityOptions {
  options: Record<string, unknown>;
  identityMode: Identity["mode"];
}

const OS_FAMILY_TO_PLATFORM: Record<string, string> = {
  windows: "windows", linux: "linux", macos: "macos",
};

/** Build the resolved result for a persona profile, deriving the platform from its OS so a Windows
 * persona run on the Linux binary presents Windows (UA, UA-CH, navigator.platform) instead of
 * leaking the host's Linux UA next to a Windows GPU — an incoherent, detectable contradiction. */
function personaResult(mode: Identity["mode"], profile: PersonaProfileV2 | PersonaProfileV4): ResolvedIdentity {
  if (isPersonaV4(profile)) {
    // Schema 4: the profile file is the only source of the machine's identity (the engine applies the
    // OS, brand, versions and the brand major rule from it). No identity switch is derived from it here.
    return { mode, fingerprintProfile: profile };
  }
  const platform = OS_FAMILY_TO_PLATFORM[(profile as any)?.compatibility?.os_family];
  const base: ResolvedIdentity = { mode, fingerprintProfile: profile, brand: "chrome" };
  return platform ? { ...base, platform } : base;
}

/** The canvas noise key stored with (or derived for) a synthetic identity, or undefined for any other
 * identity or one that is not stored yet. Reads the identity file; call it after `resolveIdentity`. */
export function canvasNoiseKeyOfIdentity(identity: Identity): string | undefined {
  if ((identity as { mode?: unknown }).mode !== "synthetic") return undefined;
  const value = identity as SyntheticIdentity;
  const persisted = loadPersistedIdentity(value.key, { identityDir: value.identityDirectory });
  return persisted ? canvasNoiseKeyFor(persisted, value.key) : undefined;
}

/** Strictly resolve one public identity option into the canonical launch representation. */
export function resolveIdentity(identity: Identity): ResolvedIdentity {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
    throw new SdkTypeError("sdk.identity_invalid", "identity must be an object");
  }
  const value = identity as unknown as Record<string, unknown>;
  const fields = Object.keys(value).sort().join("\0");
  if (value.mode === "native") {
    if (fields !== "mode") throw new SdkInputError("sdk.identity_invalid", "native identity must contain exactly 'mode'");
    return { mode: "native" };
  }
  if (value.mode === "captured") {
    if (fields !== "mode\0source") throw new SdkInputError("sdk.identity_invalid", "captured identity must contain exactly 'mode' and 'source'");
    return personaResult("captured", loadCapturedProfile(value.source as string | Record<string, unknown>));
  }
  if (value.mode === "synthetic") {
    const allowed = new Set(["mode", "key", "templateDirectory", "modelDirectory", "identityDirectory"]);
    if (!("key" in value) || Object.keys(value).some((key) => !allowed.has(key))) {
      throw new SdkInputError("sdk.identity_invalid", "synthetic identity requires 'key' and only supports directory options");
    }
    if (typeof value.key !== "string" || !value.key) {
      throw new SdkInputError("sdk.identity_invalid", "synthetic identity key must be a nonempty string");
    }
    if (value.identityDirectory !== undefined
        && (typeof value.identityDirectory !== "string" || !value.identityDirectory)) {
      throw new SdkTypeError("sdk.identity_invalid", "identityDirectory must be a nonempty string");
    }
    const persistenceOptions = { identityDir: value.identityDirectory as string | undefined };
    // A persisted identity is authoritative and never re-reads a model or template source.
    const existing = loadPersistedIdentity(value.key, persistenceOptions);
    if (existing) return personaResult("synthetic", existing.profile);
    // Precedence: explicit modelDirectory > explicit templateDirectory > env model > env template.
    const modelDirectory = value.modelDirectory as string | undefined;
    const templateDirectory = value.templateDirectory as string | undefined;
    const envModel = process.env.ANT0_BROWSER_MODEL_SOURCE;
    const envTemplate = process.env.ANT0_BROWSER_TEMPLATE_SOURCE;
    if (modelDirectory) {
      const persisted = createOrLoadGeneratedIdentity(
        value.key, loadPopulationModel(modelDirectory), persistenceOptions);
      return personaResult("synthetic", persisted.profile);
    }
    if (templateDirectory) {
      const persisted = createOrLoadIdentity(
        value.key, loadTemplateDirectory(templateDirectory), persistenceOptions);
      return personaResult("synthetic", persisted.profile);
    }
    if (envModel) {
      const persisted = createOrLoadGeneratedIdentity(
        value.key, loadPopulationModel(envModel), persistenceOptions);
      return personaResult("synthetic", persisted.profile);
    }
    if (envTemplate) {
      const persisted = createOrLoadIdentity(
        value.key, loadTemplateDirectory(envTemplate), persistenceOptions);
      return personaResult("synthetic", persisted.profile);
    }
    throw new SdkInputError("sdk.identity_invalid", "new synthetic identity requires modelDirectory or templateDirectory "
      + "(or ANT0_BROWSER_MODEL_SOURCE / ANT0_BROWSER_TEMPLATE_SOURCE)");
  }
  throw new SdkInputError("sdk.identity_invalid", "identity.mode must be one of: native, captured, synthetic");
}

/** `canvasBridge` was removed with the engine's canvas bridge. An old caller's value (top-level,
 * under `overrides`, or as a `--canvas-bridge-*` argument) is ignored with a one-time warning;
 * it never fails a launch. Returns a copy; the caller's object is untouched. */
function dropCanvasBridge(options: Record<string, unknown>): Record<string, unknown> {
  const isArg = (a: unknown) => String(a).startsWith("--canvas-bridge-");
  const ov = options.overrides;
  const hasOverride = typeof ov === "object" && ov !== null && !Array.isArray(ov) && "canvasBridge" in ov;
  const hasArg = Array.isArray(options.args) && options.args.some(isArg);
  if (!("canvasBridge" in options) && !hasOverride && !hasArg) return options;
  const clean: Record<string, unknown> = { ...options };
  delete clean.canvasBridge;
  if (hasOverride) {
    const o = { ...(ov as Record<string, unknown>) };
    delete o.canvasBridge;
    clean.overrides = o;
  }
  if (hasArg) clean.args = (options.args as unknown[]).filter((a) => !isArg(a));
  warnCanvasBridgeRemoved(options.quiet === true);
  return clean;
}

/** The OS a persona names: `identity.os.family` (schema 4) or `compatibility.os_family` (schema 2).
 * Undefined when there is no persona or it names none. */
function personaOsFamily(profile: unknown): string | undefined {
  const p = profile as { schema_version?: unknown; compatibility?: { os_family?: unknown }; identity?: { os?: { family?: unknown } } } | undefined;
  const os = p?.schema_version === 4 ? p.identity?.os?.family : p?.compatibility?.os_family;
  return typeof os === "string" && os.trim() ? os.trim().toLowerCase() : undefined;
}

/** Throws `sdk.identity_platform_mismatch` when an explicit platform override names another OS than the
 * persona. A matching platform, no override, or a persona with no known OS passes. */
export function assertPlatformMatchesPersona(platform: unknown, profile: unknown): void {
  if (typeof platform !== "string" || !platform.trim()) return;
  const persona = personaOsFamily(profile);
  const wanted = platform.trim().toLowerCase();
  if (persona === undefined || persona === wanted) return;
  throw new SdkInputError("sdk.identity_platform_mismatch",
    `overrides.platform ${JSON.stringify(wanted)} contradicts the persona's OS ${JSON.stringify(persona)}; the engine would present a mixed identity (UA, GPU and fonts of different systems). Drop the platform override or use a persona of the ${wanted} OS`);
}

/** Replace public identity options with validated internal fingerprint options. */
export function prepareIdentityOptions(options: Record<string, unknown>): PreparedIdentityOptions {
  options = dropCanvasBridge(options);
  const conflicts = ["profile", "profileSelect", "geoip", ...(FINGERPRINT_KEYS as string[])]
    .filter((key) => key in options);
  if (conflicts.length) {
    throw new SdkInputError("sdk.identity_invalid", 
      `legacy top-level identity options were removed; use identity and overrides: ${conflicts.join(", ")}`,
    );
  }
  const identitySwitches = [
    "--fingerprint", "--accept-lang", "--lang", "--timezone",
    "--disable-fingerprint", "--disable-gpu-fingerprint", "--disable-gpu-string-spoof",
    "--disable-canvas-noise",
  ];
  const rawOverride = Array.isArray(options.args)
    ? options.args.find((arg) => identitySwitches.some((prefix) => String(arg).startsWith(prefix)))
    : undefined;
  if (rawOverride !== undefined) {
    throw new SdkInputError("sdk.identity_invalid", `identity switch ${JSON.stringify(rawOverride)} is not supported in args; use identity and overrides`);
  }
  const overrides = options.overrides ?? {};
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    throw new SdkTypeError("sdk.identity_invalid", "overrides must be an object");
  }
  const allowed = new Set((FINGERPRINT_KEYS as string[]).filter(
    (key) => !["fingerprint", "fingerprintProfile", "fingerprintProfileFile", "lightStealth"].includes(key),
  ));
  allowed.add("audioProfile");
  allowed.add("network");
  const unsupported = Object.keys(overrides as object).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new SdkInputError("sdk.identity_invalid", `unsupported identity override(s): ${unsupported.join(", ")}`);
  const resolved = resolveIdentity((options.identity ?? { mode: "native" }) as Identity);
  const clean = { ...options };
  delete clean.identity;
  delete clean.overrides;
  if (resolved.fingerprintProfile) clean.fingerprintProfile = resolved.fingerprintProfile;
  if (resolved.platform !== undefined) clean.platform = resolved.platform;
  if (resolved.brand !== undefined) clean.brand = resolved.brand;
  const { audioProfile, network, ...plainOverrides } = overrides as Record<string, unknown>;
  Object.assign(clean, plainOverrides);
  // A platform override that contradicts the persona's OS yields a mixed identity (for example a Linux
  // UA with a Windows GPU and fonts). Refuse it here, before any browser starts.
  assertPlatformMatchesPersona(plainOverrides.platform, resolved.fingerprintProfile);
  // A schema 4 persona carries its own identity. An explicit platform or brand value still wins as a
  // switch, but only the value the caller set is passed (never the persona's versions) and the mix is
  // said out loud.
  if ((resolved.fingerprintProfile as { schema_version?: unknown } | undefined)?.schema_version === 4
      && ["platform", "brand", "platformVersion", "brandVersion"].some((k) => plainOverrides[k] !== undefined && plainOverrides[k] !== null)) {
    warnPersonaIdentityOverride(options.quiet === true);
  }
  if (audioProfile !== undefined) {
    const fp = clean.fingerprintProfile as PersonaProfileV2 | undefined;
    if (!fp || typeof fp !== "object" || (fp as { schema_version?: unknown }).schema_version !== 2) {
      throw new SdkInputError("sdk.identity_invalid", "audioProfile requires a captured or synthetic identity with a v2 persona profile");
    }
    clean.fingerprintProfile = applyAudioProfile(fp, audioProfile);
  }
  if (network !== undefined && network !== null) {
    const fp = clean.fingerprintProfile as PersonaProfileV2 | undefined;
    if (!fp || typeof fp !== "object" || (fp as { schema_version?: unknown }).schema_version !== 2) {
      throw new SdkInputError("sdk.identity_invalid", "network requires a captured or synthetic identity with a v2 persona profile");
    }
    clean.fingerprintProfile = applyNetworkOverride(fp, network);
  }
  // The population model draws voices independently of platform and language. Now that both are
  // known, rebuild them by rule: no Windows voices on Linux, default voice in the persona's language
  // (see ./speech-coherence.ts). A profile whose list already fits is left untouched.
  // Canvas mode (see ./canvas.ts). Noise needs a key: the option, else the one stored with the
  // identity, else the launch fails here, before any browser starts.
  assertCanvasOption(clean.canvas);
  assertCanvasNoiseKey(clean.canvasNoiseKey);
  if (clean.canvas === "noise" && clean.canvasNoiseKey === undefined) {
    const stored = canvasNoiseKeyOfIdentity((options.identity ?? { mode: "native" }) as Identity);
    if (stored === undefined) {
      throw new SdkInputError("sdk.canvas_key_missing",
        "canvas noise needs a key: pass overrides.canvasNoiseKey (16 lowercase hex characters) or use a synthetic identity, which has one");
    }
    clean.canvasNoiseKey = stored;
  }
  // The legacy true-valued flags never enable noise (an absent canvas is real); they only say so.
  if (clean.canvas !== "noise" && (clean.canvasNoise === true || clean.fingerprintNoise === true)) {
    warnCanvasNoiseNoKey(options.quiet === true);
  }
  if (clean.fingerprintProfile && (clean.fingerprintProfile as { schema_version?: unknown }).schema_version !== 4) {
    const coherent = cohereSpeech(clean.fingerprintProfile as PersonaProfileV2, clean.platform, clean.acceptLanguage, clean.brand).profile;
    // Safety net, launch payload only (the saved identity is never rewritten): a default voice whose language
    // contradicts the persona's own language gets the engine's built-in set. Launch Accept-Language is not used:
    // voices feed the persona key, so they must be deterministic per identity.
    clean.fingerprintProfile = builtinSpeechIfContradicting(coherent, clean.platform);
  }
  return { options: clean, identityMode: resolved.mode };
}
