// Launch-time coherence warnings (mirror of the Python ant0-browser/_warnings.py).
//
// The SDK already defaults the safe things (strips --enable-automation, denies WebRTC leak,
// disables Privacy Sandbox, matches the persona to the build). What it CAN'T fix is an operator
// passing an incoherent or missing-recommended combination. coherenceWarnings() spots those at
// launch() and emitCoherenceWarnings() prints an actionable line to stderr. Never blocks the
// launch; suppressible with quiet:true or ANT0_BROWSER_NO_WARN=1. coherenceWarnings() is pure (no I/O).

import { readdirSync } from "node:fs";
import { webgpuOverridePlan } from "./webgpu-override.js";
import { CHROMIUM_MAJOR } from "./chromium-version.js";
import { canvasMode, type CanvasOptions } from "./canvas.js";

const SOFTWARE_GPU = ["swiftshader", "llvmpipe", "microsoft basic render", "software adapter", "software"];
const seenNotes = new Set<string>(); // fire-once per process for NOTE codes and ONCE_WARN_CODES
/** WARN-level codes that still print only once per process (an ignored switch repeats every launch). */
const ONCE_WARN_CODES = new Set(["gpu-string-only"]);

/** True if this Linux host exposes a DRM/GPU device (a renderD or card node under /dev/dri). Absence
 * strongly implies software rendering, so callers act only on ABSENCE. Does I/O (kept out of the
 * pure coherenceWarnings). */
export function linuxHostHasGpu(driDir = "/dev/dri"): boolean {
  try {
    return readdirSync(driDir).some((e) => e.startsWith("renderD") || e.startsWith("card"));
  } catch {
    return false;
  }
}

/** Return identityMode when a persona presenting a HARDWARE GPU will render on a software rasterizer
 * because this Linux host has no GPU device; else undefined. Threaded into coherenceWarnings as
 * _gpuHostMissing. Silent under honest GPU (disableGpuFingerprint) or a pinned software renderer.
 * Does I/O. */
export function gpuHostMissingFor(
  fp: Record<string, unknown>, identityMode: string | undefined,
  hostPlatform?: string, driDir = "/dev/dri",
): string | undefined {
  const host = hostPlatform ?? process.platform;
  if ((identityMode !== "captured" && identityMode !== "synthetic") || !host.startsWith("linux")) return undefined;
  if (fp.disableGpuFingerprint) return undefined;
  const gr = String(fp.gpuRenderer ?? "").toLowerCase();
  if (SOFTWARE_GPU.some((s) => gr.includes(s))) return undefined;
  if (linuxHostHasGpu(driDir)) return undefined;
  return identityMode;
}

/** First engine release that closes the narrow-switch gaps: WebGPU, limits and shader precision follow
 * the real GPU under --disable-gpu-string-spoof, and toBlob/convertToBlob follow --disable-canvas-noise. */
export const GPU_CANVAS_FIX_ENGINE = "158.0.8127.18-ant0.8";
const ENGINE_RE = /^(\d+)\.(\d+)\.(\d+)\.(\d+)-ant0\.(\d+)$/;
const DEV_ENGINE_RE = /^\d+\.\d+\.\d+\.\d+-ant0\.dev$/;

/** True when the running engine is ant0.8 or later. A development build (`<chromium>-ant0.dev`, built
 * from main) counts as NEW, so it is not nagged about gaps main has closed; a missing or unparseable
 * version counts as OLD, so the operator is warned. Compared numerically, field by field. */
export function engineHasGpuCanvasFixes(engineVersion: unknown): boolean {
  if (typeof engineVersion !== "string") return false;
  const v = engineVersion.trim();
  if (DEV_ENGINE_RE.test(v)) return true;
  const have = ENGINE_RE.exec(v);
  if (!have) return false;
  const need = ENGINE_RE.exec(GPU_CANVAS_FIX_ENGINE) as RegExpExecArray;
  for (let i = 1; i < need.length; i++) {
    const a = Number(have[i]), b = Number(need[i]);
    if (a !== b) return a > b;
  }
  return true;
}

export interface CoherenceWarning {
  severity: "warn" | "note";
  code: string;
  message: string;
}

function proxyServer(proxy: unknown): string {
  if (!proxy) return "";
  if (typeof proxy === "object" && proxy && "server" in proxy) return String((proxy as { server?: unknown }).server ?? "");
  return String(proxy);
}
function isSocks(s: string): boolean {
  const l = s.toLowerCase();
  return l.startsWith("socks") || l.includes("://socks");
}
function hostFamily(host: string): string | null {
  if (host.startsWith("win")) return "windows";
  if (host === "darwin" || host.startsWith("mac")) return "macos";
  if (host.startsWith("linux")) return "linux";
  return null;
}
function gpuIncoherent(renderer: string, platform: string): string | null {
  const r = renderer.toLowerCase();
  if (platform === "macos" && (r.includes("direct3d") || r.includes("d3d"))) return "macOS uses Metal/OpenGL, never Direct3D";
  if (platform === "windows" && r.includes("metal")) return "Windows uses Direct3D/ANGLE, never Metal";
  if (platform === "linux" && (r.includes("direct3d") || r.includes("d3d") || r.includes("metal"))) return "Linux uses OpenGL/Vulkan, never Direct3D/Metal";
  return null;
}

/** The canvas mode the launch resolves to; an invalid `canvas` value (rejected elsewhere) counts as real. */
function warnedCanvasMode(opts: Record<string, unknown>): "real" | "noise" {
  try { return canvasMode(opts as CanvasOptions); } catch { return "real"; }
}

/** Inspect resolved options for incoherent / missing-recommended combinations. Pure. */
export function coherenceWarnings(
  opts: Record<string, unknown>,
  hostPlatform?: string,
  buildMajor?: string,
  engineVersion?: string
): CoherenceWarning[] {
  const host = hostPlatform ?? process.platform;
  const bmajor = buildMajor ?? String(CHROMIUM_MAJOR);
  const out: CoherenceWarning[] = [];
  const warn = (code: string, message: string) => out.push({ severity: "warn", code, message });
  const note = (code: string, message: string) => out.push({ severity: "note", code, message });

  const server = proxyServer(opts.proxy);
  const geoip = Boolean(opts.geoip);
  const tz = opts.timezone, lang = opts.acceptLanguage;
  const platform = opts.platform as string | undefined;
  const brand = opts.brand as string | undefined, bver = opts.brandVersion as string | undefined;
  const gpuR = opts.gpuRenderer as string | undefined, gpuV = opts.gpuVendor;
  const profile = opts.fingerprintProfile;
  const dgf = opts.disableGpuFingerprint, noise = opts.fingerprintNoise;
  const gpuStringSpoof = opts.gpuStringSpoof, canvasNoise = opts.canvasNoise;
  const fixed = engineHasGpuCanvasFixes(engineVersion);
  const personaV4 = typeof profile === "object" && profile !== null
    && (profile as { schema_version?: unknown }).schema_version === 4;
  const headless = opts.headless;
  const userArgs = (opts._userArgs as string[]) ?? [];

  if (server && !geoip && !tz && !lang)
    warn("proxy-no-geo",
      "proxy set without geoip and no timezone/acceptLanguage - the browser's timezone and language " +
      "will reflect THIS host, not the proxy's exit region (a geo-mismatch tell). Resolve the proxy " +
      "location and pass timezone + acceptLanguage under overrides.");
  if (server && geoip && isSocks(server))
    warn("socks-geoip",
      "geoip cannot resolve a SOCKS proxy's exit IP - timezone/language will NOT auto-match. Set " +
      "timezone + acceptLanguage (+ webrtcIp) manually for SOCKS proxies.");

  const fam = hostFamily(host);
  if (platform && fam && platform !== fam && !profile)
    warn("platform-host-fonts",
      `platform='${platform}' but this host is ${fam} and no fingerprintProfile supplies that OS's ` +
      `fonts/metrics - font, canvas and font-list hashes will be host-native and won't match a real ` +
      `${platform} Chrome. Use a fingerprintProfile captured on ${platform}, or set platform='${fam}'.`);
  if (gpuR && platform) {
    const why = gpuIncoherent(gpuR, platform);
    if (why) warn("gpu-platform", `gpuRenderer is incoherent with platform='${platform}' (${why}): '${gpuR}'.`);
  }
  if (gpuR && SOFTWARE_GPU.some((s) => gpuR.toLowerCase().includes(s)))
    warn("gpu-software",
      `gpuRenderer is a SOFTWARE renderer ('${gpuR}') - a real consumer machine reports a hardware GPU. ` +
      "Pin a real GPU string, or use a real-GPU host.");
  const wgpu = webgpuOverridePlan(opts);
  if (wgpu.warning) warn("gpu-webgpu-mismatch", wgpu.warning);
  // A schema 4 persona names its own brand (chrome or edge), and the engine is built for it.
  if (brand && !personaV4 && !["chrome", "google chrome"].includes(String(brand).toLowerCase()))
    warn("brand-mismatch",
      `brand='${brand}' is advertised in UA-CH, but the binary's TLS/JA4 and engine are Chrome ${bmajor} ` +
      "- a UA-vs-transport mismatch sites can cross-check. Keep brand='Chrome'.");
  if (bver && String(bver).split(".")[0] !== bmajor)
    warn("version-mismatch",
      `brandVersion major ${String(bver).split(".")[0]} differs from the build's Chrome ${bmajor} - ` +
      `JA4/UA-CH version desync. Align brandVersion to ${bmajor} (or omit it).`);

  // Canvas mode (identity API: overrides.canvas, see canvas.ts). "real" is this computer's genuine
  // canvas output, the same for every profile on this computer; the SDK adds no noise switch and
  // nothing below warns about noise. "noise" is unique to the profile and stable across launches and
  // sites (--fingerprint-noise-key). Only noise mode can put altered pixels next to a real GPU string.
  const noiseMode = warnedCanvasMode(opts) === "noise";
  const REAL_HINT = " Use canvas:'real' (the default) for this computer's genuine canvas output.";
  if (dgf && noiseMode)
    warn("gpu-noise",
      "disableGpuFingerprint presents the REAL GPU, but canvas mode 'noise' makes the canvas output " +
      "unique to the profile - altered pixels next to a real GPU are themselves a tell." + REAL_HINT);
  // gpuStringSpoof:false. On engines before ant0.8 the switch is ignored; that case is covered by the
  // gpu-string-only warning below, so this warning is for ant0.8+ only (no two messages saying the same).
  if (!dgf && gpuStringSpoof === false && noiseMode && fixed)
    warn("gpu-noise-string",
      "gpuStringSpoof:false reports the REAL WebGL vendor/renderer, but canvas mode 'noise' makes the " +
      "canvas output unique to the profile - a real string over altered pixels is itself a tell." + REAL_HINT);
  if (!dgf && gpuStringSpoof === false && !fixed)
    warn("gpu-string-only",
      "engines before ant0.8 ignore gpuStringSpoof:false, so the setting has no effect until the " +
      "engine is upgraded: this launch still reports the full persona GPU (WebGL vendor/renderer, " +
      "getParameter limits, extension list, shader precision and the navigator.gpu WebGPU identity). " +
      "Upgrade the engine to ant0.8 or later, or use disableGpuFingerprint:true to take the whole GPU " +
      "surface real.");
  if (canvasNoise === false && !fixed && noiseMode)
    note("canvas-noise-toblob",
      "engines before ant0.8 ignore canvasNoise:false, so the setting has no effect until the engine " +
      "is upgraded; this launch is in canvas mode 'noise'. Upgrade the engine to ant0.8 or later." + REAL_HINT);
  if (noiseMode && noise === false)
    warn(CANVAS_NOISE_CONFLICT_CODE, CANVAS_NOISE_CONFLICT_MESSAGE);
  // A persona presenting a hardware GPU on a Linux host with NO GPU device renders on a software
  // rasterizer: the renderer STRING claims a real GPU while MAX_TEXTURE_SIZE, the WebGL extension
  // list and navigator.gpu (WebGPU adapter) report software-tier caps -- exactly what an automated-traffic
  // scorer would flag. Computed via a host device check and threaded in as
  // _gpuHostMissing; supersedes the vaguer headless-render note.
  const gpuUnreachable = opts._gpuHostMissing as string | undefined;
  if (gpuUnreachable)
    warn("persona-gpu-unreachable",
      `the ${gpuUnreachable} persona presents a hardware GPU (an ANGLE/Direct3D11 discrete-GPU ` +
      "renderer string), but this Linux host exposes no GPU device (/dev/dri absent), so WebGL and " +
      "WebGPU fall back to a software rasterizer. A site can read the contradiction " +
      "directly: the renderer STRING claims a real GPU while MAX_TEXTURE_SIZE, the WebGL extension " +
      "list and navigator.gpu (the WebGPU adapter) report software-tier capabilities. Run on a host " +
      "with a real GPU (and drop --disable-gpu).");
  if (headless !== false && !dgf && !profile && !gpuUnreachable)
    note("headless-render",
      "headless with no disableGpuFingerprint/fingerprintProfile - canvas and WebGL may " +
      "render on software here while the persona claims a hardware GPU (a render-vs-string mismatch on " +
      "canvas-scored sites). Use disableGpuFingerprint or a real-GPU host.");

  if (opts._cacheDirGiven)
    note("cache-dir-ignored",
      "cacheDir is ignored on launch: the engine comes from runtime discovery. To choose the download " +
      "cache, use executablePath({ cacheDir }).");

  if (userArgs.some((a) => String(a).includes("--enable-automation") || String(a).startsWith("--remote-debugging-port")))
    warn("automation-arg",
      "your args re-introduce an automation flag (--enable-automation / --remote-debugging-port) the SDK " +
      "strips by default - a strong webdriver/CDP tell.");
  return out;
}

/** Print coherence warnings to stderr unless quiet or ANT0_BROWSER_NO_WARN. NOTE lines fire once/process. */
export function emitCoherenceWarnings(
  opts: Record<string, unknown>,
  quiet?: boolean,
  hostPlatform?: string,
  buildMajor?: string,
  engineVersion?: string
): void {
  if (quiet || process.env.ANT0_BROWSER_NO_WARN) return;
  for (const w of coherenceWarnings(opts, hostPlatform, buildMajor, engineVersion)) {
    if (w.severity === "note" || ONCE_WARN_CODES.has(w.code)) {
      if (seenNotes.has(w.code)) continue;
      seenNotes.add(w.code);
    }
    process.stderr.write(`ant0-browser: ${w.severity === "warn" ? "warning" : "note"}: ${w.message}\n`);
  }
}

let canvasBridgeNoted = false;
/** One-time note that `canvasBridge` was removed and its value is ignored. Never throws. */
export function warnCanvasBridgeRemoved(quiet?: boolean): void {
  if (canvasBridgeNoted) return;
  canvasBridgeNoted = true;
  if (quiet || process.env.ANT0_BROWSER_NO_WARN) return;
  process.stderr.write("ant0-browser: note: canvasBridge was removed and is ignored. Use a host with a real GPU for hardware canvas/WebGL.\n");
}

/** Test hook: forget that the note was shown. */
export function resetCanvasBridgeNote(): void { canvasBridgeNoted = false; }

/** Code and text of the warning for `canvas: "noise"` together with `fingerprintNoise: false`. The
 * args are unchanged (both switches are sent); the combination just contradicts itself. */
export const CANVAS_NOISE_CONFLICT_CODE = "canvas-noise-conflict";
export const CANVAS_NOISE_CONFLICT_MESSAGE =
  "canvas mode 'noise' is combined with fingerprint noise switched off (fingerprintNoise:false in Node, " +
  "fingerprint_noise=False in Python). The SDK sends both the noise key and --disable-fingerprint-noise, " +
  "and the combination contradicts itself. Drop the fingerprint noise override, or use canvas \"real\" for " +
  "this computer's genuine canvas output.";

/** The text of the `canvas-noise-no-key` warning. */
export const CANVAS_NOISE_NO_KEY_MESSAGE =
  "canvasNoise / fingerprintNoise: true no longer turn canvas noise on; this launch uses real readback. " +
  "To get a per-profile canvas, set overrides.canvas to \"noise\" (with overrides.canvasNoiseKey, or a synthetic identity, which has a key).";

/** Warn (every launch, to stderr) that legacy canvasNoise/fingerprintNoise:true does not enable noise and the launch stays real. */
export function warnCanvasNoiseNoKey(quiet?: boolean): void {
  if (quiet || process.env.ANT0_BROWSER_NO_WARN) return;
  process.stderr.write(`ant0-browser: warning: [canvas-noise-no-key] ${CANVAS_NOISE_NO_KEY_MESSAGE}\n`);
}

/** A debug-level line: printed only when ANT0_BROWSER_DEBUG is set. */
export function debugLog(message: string): void {
  if (process.env.ANT0_BROWSER_DEBUG) process.stderr.write(`ant0-browser: debug: ${message}\n`);
}

/** Code and text of the warning for a platform or brand override on a schema 4 persona (same in the Python SDK). */
export const PERSONA_IDENTITY_OVERRIDE_CODE = "persona-identity-override";
export const PERSONA_IDENTITY_OVERRIDE_MESSAGE =
  "a platform or brand override is mixed with a schema 4 persona. The override wins over the persona's " +
  "identity and only the value you set is passed (the persona's versions are not carried along), so the " +
  "page can show an identity the persona does not describe. Drop the override to present the persona as issued.";
export function warnPersonaIdentityOverride(quiet?: boolean): void {
  if (quiet || process.env.ANT0_BROWSER_NO_WARN) return;
  process.stderr.write(`ant0-browser: warning: [${PERSONA_IDENTITY_OVERRIDE_CODE}] ${PERSONA_IDENTITY_OVERRIDE_MESSAGE}\n`);
}

/** Print persona notices (see profile-file.ts) to stderr as warnings, every launch, unless quiet or
 * ANT0_BROWSER_NO_WARN. */
export function emitPersonaNotices(notices: ReadonlyArray<{ code: string; message: string }>, quiet?: boolean): void {
  if (quiet || process.env.ANT0_BROWSER_NO_WARN) return;
  for (const n of notices) process.stderr.write(`ant0-browser: warning: [${n.code}] ${n.message}\n`);
}
