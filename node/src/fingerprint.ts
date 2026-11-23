// Maps the SDK's fingerprint options to the Ant0 Browser Chromium command-line switches.
// Switch names mirror the engine's fingerprint command-line switches.

import { gzipSync } from "node:zlib";
import { assertPersonaProfileV4 } from "./persona-profile-v4.js";
import {
  CANVAS_NOISE_KEY_SWITCH, assertCanvasNoiseKey, canvasMode, type CanvasMode,
} from "./canvas.js";
import { SdkInputError } from "./errors.js";
import { webgpuOverridePlan } from "./webgpu-override.js";
import { assertPersonaProfileV2 } from "./persona-profile-v2.js";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface FingerprintOptions {
  /**
   * Master fingerprint seed (the per-eTLD+1 farbling root). Same seed => the same stable
   * identity across launches; different seeds => unlinkable identities. Any string or number
   * is accepted (non-numeric seeds are hashed engine-side — they will not crash the renderer).
   */
  fingerprint?: string | number;
  /**
   * Spoofed OS family for UA / UA-CH / navigator.platform. `"android"` is a best-effort **mobile**
   * persona (seed-selected from a Pixel/Galaxy device pool): Android UA + `Sec-CH-UA-Mobile: ?1`,
   * touch (`maxTouchPoints`), `pointer:coarse`/`hover:none`, mobile screen/DPR, Mali/Adreno WebGL,
   * `plugins=0`, and a mobile viewport (auto-sets a phone `--window-size`). On a desktop engine the
   * GPU *render* and fine page geometry stay desktop (documented residual tells).
   */
  platform?: "windows" | "linux" | "macos" | "android";
  /** Spoofed platform version (UA-CH high-entropy). */
  platformVersion?: string;
  /** Browser brand for UA / UA-CH. */
  brand?: "Chrome" | "Edge" | "Opera" | "Vivaldi" | (string & {});
  /** Brand version. */
  brandVersion?: string;
  /**
   * TLS network persona — keep the TLS ClientHello coherent with the persona's claimed Chrome
   * version, so the network layer follows the UA instead of always emitting the build's native TLS.
   * Only the version-variant ClientHello fields change (post-quantum key-share group, ALPS
   * codepoint); the cipher list, version bounds, and per-connection extension permutation stay
   * exactly real-Chrome. Chromium-core only (Chrome/Edge/Brave/Opera share the ClientHello; brand
   * differs in headers/UA-CH, not TLS).
   *
   * - `"match-persona"` (default) / `"auto"`: follow `brandVersion`'s major; with no `brandVersion`
   *   the persona claims the browser's native version, so this is a no-op (native TLS).
   * - `"native"` / `"off"`: leave the build's native TLS unchanged.
   * - `"chrome-<major>"` or a number (e.g. `120`): pin the TLS shape to that Chromium major.
   */
  tlsProfile?: "match-persona" | "auto" | "native" | "off" | `chrome-${number}` | (string & {}) | number;
  /** WebGL UNMASKED_VENDOR string. */
  gpuVendor?: string;
  /** WebGL UNMASKED_RENDERER string. */
  gpuRenderer?: string;
  /** navigator.hardwareConcurrency. */
  hardwareConcurrency?: number;
  /** navigator.deviceMemory in GB (spec-clamps to 8 — larger values report as 8). */
  deviceMemory?: number;
  /**
   * screen.width in CSS px. NOTE: spoofing screen dimensions is inconsistent
   * (a faked screen cannot be reconciled with the real window/render surface), so this is
   * opt-in and is NOT part of the `lightStealth` preset. Best when the host's real display matches.
   */
  screenWidth?: number;
  /** screen.height in CSS px (see the caveat on `screenWidth`). */
  screenHeight?: number;
  /** screen.availWidth in CSS px (see the caveat on `screenWidth`). */
  availWidth?: number;
  /** screen.availHeight in CSS px (see the caveat on `screenWidth`). */
  availHeight?: number;
  /** screen.colorDepth (e.g. 24). */
  colorDepth?: number;
  /** window.devicePixelRatio (e.g. 1, 1.25, 1.5). */
  devicePixelRatio?: number;
  /** navigator.maxTouchPoints (0 on a mouse-only desktop). */
  maxTouchPoints?: number;
  /**
   * Light-stealth preset: spoof a coherent, seed-derived bundle of the metadata axes that SURVIVE
   * the real browser — hardwareConcurrency, deviceMemory, colorDepth, devicePixelRatio,
   * maxTouchPoints — applied via the native override switches ONLY (never the `--fingerprint`
   * persona machinery / farbling). Rendering (canvas/WebGL/audio/fonts),
   * TLS, and the real Chrome version are all left untouched, so the identity stays coherent and
   * coherent. Screen dimensions are deliberately NOT spoofed (a faked screen is inconsistent with the real window) — pass screenWidth/etc. explicitly to opt in. An explicit field wins over the preset.
   * The lightest identity variation.
   */
  lightStealth?: boolean;
  /** Geolocation as "lat,lng" (only returned when the page is granted permission). */
  location?: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
  /**
   * Accept-Language / navigator.languages, e.g. "en-US,en". Sets BOTH the server-side
   * Accept-Language header and navigator.language(s) coherently (Chromium `--accept-lang`).
   * Set this under launch `overrides` to match the timezone/proxy region.
   */
  acceptLanguage?: string;
  /** WebRTC egress IP to report (typically your proxy's public IP). */
  webrtcIp?: string;
  /**
   * WebRTC host-candidate mDNS concealment. Real Chrome hides local host candidates behind an
   * `<uuid>.local` mDNS name so a page opening an RTCPeerConnection cannot read the LAN address;
   * that is the default here too. Set `"off"` only if you need routable raw host candidates
   * (LAN/P2P) — it re-exposes the private IP to every page.
   *
   * Requires an engine built with `enable_mdns=true`; with it off the responder is never compiled,
   * concealment cannot happen, and the LAN IP leaks regardless of this option. (Builds before
   * 150.0.7871.114-r4 were in exactly that state.)
   */
  webrtcMdns?: "on" | "off";
  /**
   * Present the machine's **real GPU** instead of a spoofed one. WebGL `UNMASKED_VENDOR`/`RENDERER`,
   * the `getParameter` table, and the canvas/WebGL render all report the genuine host backend. This
   * is the most coherent setting: the GPU string and the actually-rendered pixels match, so
   * nothing disagrees. Composes with `fingerprintProfile` — the profile still supplies
   * screen/fonts/audio/hardware, but the **real host GPU is kept** instead of the profile's GPU
   * (which the host cannot actually render, and would otherwise be a string-vs-render mismatch).
   * Pair with `fingerprintNoise: false` so the canvas/WebGL readback isn't perturbed either.
   *
   * Trade-off: every persona on one physical machine then shares the same canvas/WebGL identity, so
   * a tracker can link them by GPU hash. Best for single-identity / one-persona-per-host use; for
   * multi-account-on-one-machine, keep this off and instead match the profile's GPU to the host.
   */
  disableGpuFingerprint?: boolean;
  /**
   * Set `false` to turn OFF the per-eTLD+1 farbling NOISE (canvas/WebGL/audio/client-rects), so
   * those surfaces return their natural, unperturbed values. Use when a site treats
   * the noise pattern as "tampered". Identity spoofs (UA/screen/GPU/persona)
   * stay on. Default (unset/`true`) keeps the noise.
   */
  fingerprintNoise?: boolean;
  /**
   * `false` presents the machine's REAL GPU. With real GPU strings, every GPU value (the card name,
   * the WebGL limits and extensions, shader precision, the WebGPU adapter info, limits and
   * features) comes from this machine's graphics stack, and only the readback noise stays; so on a
   * Linux computer a Windows persona shows a Linux GPU. The difference from `disableGpuFingerprint`
   * is that the noise is kept. The Windows-only Direct3D11 answers (shader precision,
   * MAX_ELEMENT_INDEX, hidden ASTC/ETC, a bgra8unorm preferred format) are the backend's too, and
   * an explicit `gpuRenderer` / `gpuVendor` (or a WebGPU override) loses to it.
   * Requires engine ant0.8 or later; inert on older builds.
   */
  gpuStringSpoof?: boolean;
  /**
   * `false` turns off the per-eTLD+1 farble on the canvas READBACKS: `getImageData` and `toDataURL`
   * of a 2D canvas (also bitmaprenderer and OffscreenCanvas), and the `toBlob()` /
   * `convertToBlob()` encode path (WebP, and anything made in a worker). WebGL and WebGPU canvases,
   * `gl.readPixels`, audio and client rects keep their noise -- unlike `fingerprintNoise: false`,
   * which is the process-wide off switch. Requires engine ant0.8 or later; inert on older builds.
   */
  canvasNoise?: boolean;
  /**
   * Canvas mode of the profile. `"real"` (the default) presents this computer's genuine canvas
   * output, which every profile on this computer shares. `"noise"` makes the canvas output unique
   * to the profile and stable across launches and sites; it needs a key (`canvasNoiseKey`, or the
   * key stored with the identity) and sends exactly one `--fingerprint-noise-key=<16 hex>`.
   * When `canvas` is unset the mode is `"real"`: `canvasNoise: true` and `fingerprintNoise: true` never
   * select noise (they only warn), and their `false` values keep sending `--disable-canvas-noise` /
   * `--disable-fingerprint-noise` as before.
   * See ./canvas.ts for the full table.
   */
  canvas?: CanvasMode;
  /** The profile's canvas noise key: 16 lowercase hex characters. Used only in `"noise"` mode. */
  canvasNoiseKey?: string;
  /** Internal: absolute path of the private file that carries a schema 4 persona. Set by the
   * launch code (see ./profile-file.ts), never by a caller. */
  fingerprintProfileFile?: string;
  /**
   * Import a real captured fingerprint so the browser presents *that machine's* identity instead
   * of the synthetic seed-derived one. Accepts a path to a `.json` profile, a profile object, or a
   * JSON string. Fields present in the profile
   * override the seed-derived persona; absent fields fall back to the seed, so partial profiles
   * stay coherent.
   */
  fingerprintProfile?: string | Record<string, unknown>;
  /**
   * `navigator.storage.estimate().quota` in **megabytes**. A tiny/ephemeral quota reads as a test
   * machine or incognito; set a realistic on-disk value (e.g. `250000` for ~244 GB).
   */
  storageQuota?: number;
}

export const FINGERPRINT_KEYS: (keyof FingerprintOptions)[] = [
  "fingerprint",
  "platform",
  "platformVersion",
  "brand",
  "brandVersion",
  "gpuVendor",
  "gpuRenderer",
  "hardwareConcurrency",
  "deviceMemory",
  "screenWidth",
  "screenHeight",
  "availWidth",
  "availHeight",
  "colorDepth",
  "devicePixelRatio",
  "maxTouchPoints",
  "lightStealth",
  "location",
  "timezone",
  "acceptLanguage",
  "webrtcIp",
  "webrtcMdns",
  "disableGpuFingerprint",
  "fingerprintNoise",
  "gpuStringSpoof",
  "canvasNoise",
  "canvas",
  "canvasNoiseKey",
  "fingerprintProfileFile",
  "fingerprintProfile",
  "storageQuota",
  "tlsProfile",
];

/** Split an options object into its fingerprint half and the remaining (Playwright) half. */
export function splitFingerprintOptions<T extends object>(
  options: T
): { fingerprint: FingerprintOptions; rest: Omit<T, keyof FingerprintOptions> } {
  const fingerprint: FingerprintOptions = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if ((FINGERPRINT_KEYS as string[]).includes(k)) {
      (fingerprint as Record<string, unknown>)[k] = v;
    } else {
      rest[k] = v;
    }
  }
  return { fingerprint, rest: rest as Omit<T, keyof FingerprintOptions> };
}

/** Normalize an Accept-Language value for Chromium's `--accept-lang`: a plain comma-separated
 * tag list with NO `;q=` weights or spaces (Chromium adds the q-weights to the header itself; a
 * `;` in the switch value trips a DCHECK and crashes the renderer). */
export function cleanAcceptLanguage(v: string): string {
  return String(v)
    .split(",")
    .map((t) => t.split(";")[0].trim())
    .filter(Boolean)
    .join(",");
}

/** Encode a captured ant0-browser-profile for the `--fingerprint-profile` switch. `value` may be a
 * path to a `.json` file, a profile object, or a JSON string. gzip+base64 keeps the full capture
 * (~40 KB) within Chromium's command-line length limit (gzip ~6x); the engine gunzips + parses it. */
export function encodeProfile(value: string | Record<string, unknown>): string {
  let raw: Buffer;
  if (typeof value === "object") {
    if (value.schema_version === 2) assertPersonaProfileV2(value);
    if (value.schema_version === 4) assertPersonaProfileV4(value);
    raw = Buffer.from(JSON.stringify(value));
  } else if (existsSync(value)) {
    raw = readFileSync(value);
  } else {
    raw = Buffer.from(value); // assume a JSON string
  }
  if (typeof value !== "object") {
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null
          && (parsed as Record<string, unknown>).schema_version === 2) {
        assertPersonaProfileV2(parsed);
      } else if (typeof parsed === "object" && parsed !== null
          && (parsed as Record<string, unknown>).schema_version === 4) {
        assertPersonaProfileV4(parsed);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        // Preserve legacy behavior: Chromium reports malformed legacy JSON.
      } else {
        throw error;
      }
    }
  }
  return gzipSync(raw, { level: 9 }).toString("base64");
}

/** Read imported language and canonical-v2 timezone values without changing legacy profiles. */
function profileLocale(value: string | Record<string, unknown>): { language?: string; timezone?: string } {
  let obj: Record<string, unknown> | undefined;
  try {
    if (typeof value === "object") obj = value;
    else if (existsSync(value)) obj = JSON.parse(readFileSync(value, "utf8"));
    else obj = JSON.parse(value);
  } catch {
    return {};
  }
  const nav = obj?.navigator as Record<string, unknown> | undefined;
  const locale = obj?.locale as Record<string, unknown> | undefined;
  const langs = obj?.schema_version === 2 ? locale?.languages : nav?.languages;
  const timezone = obj?.schema_version === 2 && typeof locale?.timezone === "string" && locale.timezone
    ? locale.timezone
    : undefined;
  return {
    language: Array.isArray(langs) && langs.length ? langs.map(String).join(",") : undefined,
    timezone,
  };
}

/** Best-effort imported profile language list for Chromium's locale switches. */
export function profileAcceptLanguage(value: string | Record<string, unknown>): string | undefined {
  return profileLocale(value).language;
}

// Coherent Windows-plausible desktop/laptop metadata bundles, indexed by a hash of the seed:
// [screen_w, screen_h, avail_w, avail_h, dpr, color_depth, device_memory_gb, hw_concurrency].
// lightStealth uses ONLY dpr/color_depth/device_memory/hw_concurrency from each row (screen stays
// real — see the note on `lightStealth`). The screen columns are retained so an explicit opt-in
// screen spoof can reuse a coherent row.
const LIGHT_STEALTH_PROFILES: readonly (readonly [number, number, number, number, number, number, number, number])[] = [
  [1920, 1080, 1920, 1040, 1.0, 24, 8, 8],
  [1920, 1080, 1920, 1040, 1.0, 24, 16, 12],
  [1920, 1080, 1920, 1040, 1.0, 24, 16, 16],
  [2560, 1440, 2560, 1400, 1.0, 24, 16, 16],
  [2560, 1440, 2560, 1400, 1.5, 24, 16, 12],
  [1536, 864, 1536, 824, 1.25, 24, 8, 8],
  [1536, 864, 1536, 824, 1.25, 24, 16, 12],
  [1366, 768, 1366, 728, 1.0, 24, 8, 4],
  [1366, 768, 1366, 728, 1.0, 24, 4, 4],
  [1440, 900, 1440, 860, 1.0, 24, 8, 8],
  [1600, 900, 1600, 860, 1.0, 24, 8, 8],
  [1680, 1050, 1680, 1010, 1.0, 24, 8, 8],
  [1920, 1200, 1920, 1160, 1.0, 24, 16, 12],
  [3840, 2160, 3840, 2120, 1.0, 24, 32, 16],
];

/**
 * Deterministic, coherent metadata bundle for `lightStealth`, applied via the NATIVE override
 * switches only (never `--fingerprint`). Spoofs ONLY the axes that stay consistent with the real browser:
 * hardwareConcurrency, deviceMemory, colorDepth, devicePixelRatio, maxTouchPoints. It deliberately
 * does NOT spoof screen/avail dimensions (a faked screen is inconsistent). Presents the
 * browser's REAL version (no brandVersion spoof — a version lie desyncs UA-CH + TLS from the real
 * binary). The seed->row mapping matches the Python SDK (full sha256 digest as a big integer mod N).
 */
export function lightStealthValues(seed?: string | number): Partial<FingerprintOptions> {
  // Default seed string for seedless calls: the same persona every time unless an explicit seed is passed.
  const key = seed === undefined || seed === null || String(seed) === "" ? "ant0-light-stealth" : String(seed);
  const hex = createHash("sha256").update(key, "utf8").digest("hex");
  const idx = Number(BigInt("0x" + hex) % BigInt(LIGHT_STEALTH_PROFILES.length));
  const row = LIGHT_STEALTH_PROFILES[idx];
  return {
    devicePixelRatio: row[4],
    colorDepth: row[5],
    deviceMemory: row[6],
    hardwareConcurrency: row[7],
    maxTouchPoints: 0,
    brand: "chrome",
  };
}

/** Build the Chromium switches for a set of fingerprint options. */
/** Parse the leading integer (the major) out of a version string like "120.0.6099.109" -> 120. */
function majorFromVersion(value?: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const head = String(value).trim().split(".")[0];
  return /^\d+$/.test(head) ? Number(head) : undefined;
}

/**
 * Resolve `tlsProfile` to a concrete `--fingerprint-tls-profile` value, or undefined (native TLS).
 * "match-persona"/"auto" (default) follows `brandVersion`; "native"/"off"/undefined -> native;
 * "chrome-<major>" or a number -> pinned. Unrecognized values -> native (never break the handshake).
 * Always resolves to `chrome-<major>` (Chromium-core; the brand lives in headers, not the ClientHello).
 */
export function resolveTlsProfile(
  value: FingerprintOptions["tlsProfile"],
  o: FingerprintOptions
): string | undefined {
  if (value === undefined || value === null || value === "" || value === "native" || value === "off") {
    return undefined;
  }
  if (value === "match-persona" || value === "auto") {
    const major = majorFromVersion(o.brandVersion);
    return major ? `chrome-${major}` : undefined;
  }
  if (typeof value === "number") return `chrome-${value}`;
  const text = String(value).trim().toLowerCase();
  if (/^chrome-\d+$/.test(text)) return text;
  if (/^\d+$/.test(text)) return `chrome-${text}`;
  return undefined;
}

// Primary Accept-Language tag -> a plausible IANA timezone, so the default persona's timezone is
// coherent with its locale instead of leaking the host's (often UTC on servers/containers). Not
// geo-truth — resolve the proxy exit-IP and pass an explicit timezone override for accuracy.
const LOCALE_TZ: Record<string, string> = {
  "en-US": "America/New_York", "en-CA": "America/Toronto", "en-GB": "Europe/London",
  "en-AU": "Australia/Sydney", "en-NZ": "Pacific/Auckland", "en-IE": "Europe/Dublin",
  "de-DE": "Europe/Berlin", "de-AT": "Europe/Vienna", "fr-FR": "Europe/Paris",
  "es-ES": "Europe/Madrid", "es-MX": "America/Mexico_City", "it-IT": "Europe/Rome",
  "nl-NL": "Europe/Amsterdam", "pt-BR": "America/Sao_Paulo", "pt-PT": "Europe/Lisbon",
  "pl-PL": "Europe/Warsaw", "sv-SE": "Europe/Stockholm", "ja-JP": "Asia/Tokyo",
  "ko-KR": "Asia/Seoul", "zh-CN": "Asia/Shanghai", "zh-TW": "Asia/Taipei",
  "ru-RU": "Europe/Moscow", "tr-TR": "Europe/Istanbul", "ar-SA": "Asia/Riyadh",
  "hi-IN": "Asia/Kolkata", "id-ID": "Asia/Jakarta",
};

/**
 * A plausible IANA timezone for a primary Accept-Language tag (`en-US` -> `America/New_York`), so the
 * default persona's timezone is coherent with its locale rather than leaking the host's UTC. Falls
 * back by language subtag, then to America/New_York (matching the en-US Accept-Language default).
 */
export function defaultTimezone(primaryLang: string): string | undefined {
  if (!primaryLang) return undefined;
  const tag = primaryLang.trim();
  if (LOCALE_TZ[tag]) return LOCALE_TZ[tag];
  const lang = tag.split("-")[0].toLowerCase();
  for (const [key, tz] of Object.entries(LOCALE_TZ)) {
    if (key.toLowerCase().startsWith(lang + "-")) return tz;
  }
  return "America/New_York";
}

/** The persona's device pixel ratio when the SDK knows it, else undefined (a native identity, or an
 * engine-picked persona, leaves the real display scale alone). Order: the explicit
 * `devicePixelRatio`, the `lightStealth` bundle's value, then a v2 profile's `display.device_pixel_ratio`. */
export function personaDpr(o: FingerprintOptions): number | undefined {
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 8;
  if (ok(o.devicePixelRatio)) return o.devicePixelRatio;
  if (o.devicePixelRatio === undefined && o.lightStealth) {
    const v = lightStealthValues(o.fingerprint).devicePixelRatio;
    if (ok(v)) return v;
  }
  const d = profileDisplay(o);
  return ok(d?.device_pixel_ratio) ? d.device_pixel_ratio as number : undefined;
}

/** A v2 profile's `display` block, or undefined (no profile, unreadable, or the legacy format). */
function profileDisplay(o: FingerprintOptions): Record<string, unknown> | undefined {
  if (o.fingerprintProfile === undefined) return undefined;
  let obj: unknown;
  try {
    const v = o.fingerprintProfile;
    obj = typeof v === "object" ? v : existsSync(v) ? JSON.parse(readFileSync(v, "utf8")) : JSON.parse(v);
  } catch {
    return undefined;
  }
  const root = obj as Record<string, unknown> | null;
  if (root && root.schema_version === 4) {
    // Schema 4 (spec 2.4): surfaces.display names the available area avail_width/avail_height;
    // present it under the v2 key names so both formats yield the same flags for the same numbers.
    const sd = (root.surfaces as Record<string, unknown> | undefined)?.display;
    if (!sd || typeof sd !== "object") return undefined;
    const s4 = sd as Record<string, unknown>;
    return { device_pixel_ratio: s4.device_pixel_ratio, available_width: s4.avail_width, available_height: s4.avail_height };
  }
  if (!root || root.schema_version !== 2) return undefined;
  const d = root.display;
  return d && typeof d === "object" ? d as Record<string, unknown> : undefined;
}

/** The persona's available screen in CSS px (explicit `availWidth`/`availHeight`, else a v2 profile). */
export function personaAvail(o: FingerprintOptions): { width?: number; height?: number } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const d = profileDisplay(o);
  return {
    width: num(o.availWidth) ?? num(d?.available_width),
    height: num(o.availHeight) ?? num(d?.available_height),
  };
}

/** Engine switch that names a persona file (schema 4). One constant, one-line change. */
export const PROFILE_FILE_SWITCH = "--fingerprint-profile-file";

/** The `schema_version` of a profile given as an object, JSON text or a path; undefined if unreadable. */
function profileSchemaVersion(value: string | Record<string, unknown>): unknown {
  try {
    const obj = typeof value === "object" ? value : existsSync(value) ? JSON.parse(readFileSync(value, "utf8")) : JSON.parse(value);
    return (obj as Record<string, unknown> | null)?.schema_version;
  } catch {
    return undefined;
  }
}

export function fingerprintArgs(o: FingerprintOptions, identityApi = false): string[] {
  const args: string[] = [];
  o = { ...o }; // never mutate the caller's options
  if (o.lightStealth) {
    // Fill in the coherent metadata bundle via native override switches. An explicit caller field
    // (e.g. deviceMemory: 16) wins over the preset. CRITICAL: never emit --fingerprint, so the
    // persona machinery / farbling never engages; each value then takes the C++ flag > real path.
    const preset = lightStealthValues(o.fingerprint) as Record<string, unknown>;
    for (const [k, v] of Object.entries(preset)) {
      const cur = (o as Record<string, unknown>)[k];
      if (cur === undefined || cur === null || cur === "") (o as Record<string, unknown>)[k] = v;
    }
    delete o.fingerprint;
  }
  const set = (flag: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") {
      args.push(`--${flag}=${value}`);
    }
  };
  // The seed makes the engine noise canvas readback on its own, so `canvas` cannot be honoured with it:
  // "real" would still be noised, and a noise key is ignored.
  if (o.canvas !== undefined && o.fingerprint !== undefined && o.fingerprint !== null && o.fingerprint !== "") {
    throw new SdkInputError("sdk.canvas_invalid",
      'canvas cannot be combined with the fingerprint seed: with a seed the engine noises canvas readback by itself ' +
      '("real" would still be noised and a noise key is ignored). Use an identity, which has no seed.');
  }
  set("fingerprint", o.fingerprint);
  // Default the persona platform to the HOST OS so it's coherent with the binary the SDK ships for
  // this machine (Windows binary -> windows, Linux binary -> linux). Override via
  // platform: "windows" | "linux" | "macos".
  const hostPlatform =
    ({ win32: "windows", linux: "linux", darwin: "macos" } as Record<string, string>)[process.platform] ?? "windows";
  set("fingerprint-platform", o.platform ?? (identityApi ? undefined : hostPlatform));
  set("fingerprint-platform-version", o.platformVersion);
  // ant0-browser presents as Google Chrome (its UA says "Chrome/<v>"); default the UA-CH brand to
  // "chrome" so navigator.userAgentData advertises "Google Chrome", not bare "Chromium" (a
  // UA/UA-CH mismatch some sites flag). Override via brand: "Edge" etc.
  set("fingerprint-brand", o.brand ?? (identityApi ? undefined : "chrome"));
  set("fingerprint-brand-version", o.brandVersion);
  set("fingerprint-gpu-vendor", o.gpuVendor);
  set("fingerprint-gpu-renderer", o.gpuRenderer);
  // Keep WebGPU on the override's GPU family (see webgpu-override.ts).
  args.push(...webgpuOverridePlan(o).args);
  set("fingerprint-hardware-concurrency", o.hardwareConcurrency);
  // Native metadata overrides (flag > persona > real). Read directly by the getters — no
  // --fingerprint persona machinery — so they are safe to spoof individually or via lightStealth.
  //
  // Emit each EXACTLY ONCE. These were previously set in two separate blocks, so every override
  // went out twice. Chromium takes the last occurrence and the values were identical, so nothing
  // misbehaved — but a command line carrying `--fingerprint-device-memory` twice is a shape no
  // real browser produces, and the engine exposes the command line over CDP
  // (BrowserHandler::GetBrowserCommandLine), so it was a free tell.
  //
  // `set` compares strictly against undefined, so a numeric 0 is emitted rather than dropped —
  // that matters for maxTouchPoints, where 0 is a real value (a non-touch desktop), not "unset".
  set("fingerprint-device-memory", o.deviceMemory);
  set("fingerprint-screen-width", o.screenWidth);
  set("fingerprint-screen-height", o.screenHeight);
  set("fingerprint-avail-width", o.availWidth);
  set("fingerprint-avail-height", o.availHeight);
  set("fingerprint-color-depth", o.colorDepth);
  set("fingerprint-device-pixel-ratio", o.devicePixelRatio);
  // Persona scale: make the REAL scale the persona's. Without it a host at scale 2 shows through
  // (0.5px borders, 0.5 pointer steps, 2x screenshots) while the persona claims 1. Measured on
  // Linux: the flag closes the gap without engine support. A caller's own --force-device-scale-factor
  // in `args` comes later on the command line and wins.
  const scale = personaDpr(o);
  if (scale !== undefined) args.push(`--force-device-scale-factor=${scale}`);
  set("fingerprint-max-touch-points", o.maxTouchPoints);
  set("fingerprint-location", o.location);
  set("fingerprint-storage-quota", o.storageQuota);
  set("timezone", o.timezone);
  // Always send a coherent Accept-Language. Without --accept-lang Chromium falls back to the
  // build/OS locale, which can leak a language that mismatches the proxy's country/timezone
  // (e.g. en-GB on a US IP) — a geo-inconsistency tell. Prefer an explicit value, then an imported
  // profile's languages, then en-US,en on the internal legacy path.
  const importedLocale = o.fingerprintProfile ? profileLocale(o.fingerprintProfile) : {};
  const acceptLanguage = o.acceptLanguage || importedLocale.language || (identityApi ? undefined : "en-US,en");
  const cleanLang = acceptLanguage ? cleanAcceptLanguage(String(acceptLanguage)) : "";
  if (cleanLang) args.push(`--accept-lang=${cleanLang}`);
  // Also pin the UI/ICU locale to the PRIMARY Accept-Language tag, so Intl.DateTimeFormat /
  // NumberFormat / Collator (main thread AND workers) resolve to the same locale as
  // navigator.language. Without --lang, Chromium falls back to the build/OS locale (e.g. en-GB on an
  // en-US persona) — a locale-incoherence tell auditors flag (navigator.language=en-US but Intl=en-GB).
  const primaryLang = cleanLang.split(",")[0];
  if (primaryLang) args.push(`--lang=${primaryLang}`);
  // Default the timezone to one coherent with the persona locale when none is set
  // resolve one), so a server/container run doesn't leak the host's UTC (a datacenter tell) while
  // navigator.language says e.g. en-US. An explicit timezone override takes precedence.
  if (!o.timezone) {
    const tz = importedLocale.timezone || (identityApi ? undefined : defaultTimezone(primaryLang));
    if (tz) args.push(`--timezone=${tz}`);
  }
  set("webrtc-ip", o.webrtcIp);
  // Only "off" is meaningful — concealment ON is both the Chromium default and real Chrome's
  // behaviour, so there is nothing to emit for "on".
  //
  // This uses Chromium's OWN feature flag rather than a ant0-browser switch. The mDNS responder is
  // created in PeerConnectionDependencyFactory behind `kWebRtcHideLocalIpsWithMdns`; disabling
  // the feature means no responder is built and host candidates are signalled as raw IPs.
  // Verified end-to-end: with the flag, host candidates come back as 192.168.x.x; without it,
  // as <uuid>.local. mergeFeatureFlags folds this into any other --disable-features value.
  if (o.webrtcMdns === "off") args.push("--disable-features=WebRtcHideLocalIpsWithMdns");
  if (o.disableGpuFingerprint) args.push("--disable-gpu-fingerprint");
  // fingerprintNoise=false turns OFF the per-eTLD+1 farbling noise (canvas/WebGL/audio/client-rects)
  // so those surfaces return natural values — for sites whose ML flags the noise as "tampered".
  // Identity spoofs (UA/screen/GPU/persona) stay on. Default keeps the noise.
  if (o.fingerprintNoise === false) args.push("--disable-fingerprint-noise");
  // The two INDEPENDENT halves of the bundles above (engine ant0.8 or later).
  if (o.gpuStringSpoof === false) args.push("--disable-gpu-string-spoof");
  if (o.canvasNoise === false) args.push("--disable-canvas-noise");
  // Canvas mode (see ./canvas.ts). Real sends nothing. Noise sends the profile's key, once. An explicit
  // canvas: "noise" without a key is an error; the identity path (prepareIdentityOptions) supplies the key.
  if (canvasMode(o) === "noise") {
    assertCanvasNoiseKey(o.canvasNoiseKey);
    if (o.canvasNoiseKey !== undefined) args.push(`${CANVAS_NOISE_KEY_SWITCH}=${o.canvasNoiseKey}`);
    else if (o.canvas === "noise") {
      throw new SdkInputError("sdk.canvas_key_missing", 'canvas: "noise" needs a canvasNoiseKey (16 lowercase hex characters)');
    }
  }
  // fingerprintProfile transports a profile to the native parser. Canonical v2 profiles are
  // complete and activate atomically; only the deprecated unversioned format has partial-field
  // fallback semantics.
  if (o.fingerprintProfile) {
    if (profileSchemaVersion(o.fingerprintProfile) === 4) {
      // Schema 4 never goes inline: the launch code writes it to a private file first.
      if (typeof o.fingerprintProfile === "string") {
        throw new SdkInputError("sdk.persona_profile_invalid",
          "a schema_version 4 persona cannot be given to fingerprintProfile as a path or JSON text (that supports schema 2 " +
          "only); pass it through identity: { mode: \"captured\", source }, which accepts a path or JSON text and writes the private file");
      }
      if (!o.fingerprintProfileFile) {
        throw new SdkInputError("sdk.persona_file_missing",
          "a schema_version 4 persona travels in a private file; launch through the SDK launch functions");
      }
      args.push(`${PROFILE_FILE_SWITCH}=${o.fingerprintProfileFile}`);
    } else {
      args.push(`--fingerprint-profile=${encodeProfile(o.fingerprintProfile)}`);
    }
  }
  // tlsProfile keeps the TLS ClientHello coherent with the persona's claimed Chrome version (the
  // network layer follows the UA). Default "match-persona" follows brandVersion; "chrome-<major>"
  // pins it; "native"/off/unset leaves native TLS. Only version-variant fields change.
  const tlsSwitch = resolveTlsProfile(o.tlsProfile ?? "match-persona", o);
  if (tlsSwitch) args.push(`--fingerprint-tls-profile=${tlsSwitch}`);
  // The Android persona lays the page out as a mobile viewport, which needs a phone-sized window
  // (Chromium's ~500px minimum width floor still applies). Auto-set one; a caller-supplied
  // --window-size in `args` overrides this (Chromium takes the last --window-size).
  // A schema 4 persona names its OS in the profile; no platform switch is derived from it.
  const v4Family = typeof o.fingerprintProfile === "object" && o.fingerprintProfile !== null
    && o.fingerprintProfile.schema_version === 4
    ? (o.fingerprintProfile as { identity?: { os?: { family?: unknown } } }).identity?.os?.family : undefined;
  if ((o.platform ?? v4Family) === "android") {
    args.push("--window-size=412,915");
  }
  return args;
}
