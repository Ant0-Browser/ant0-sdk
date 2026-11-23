// Ant0 Browser — Playwright drop-in.
//
//   import { launch } from "ant0-browser";
//   const browser = await launch({ identity: { mode: "native" } });
//   const page = await browser.newPage();
//   await page.goto("https://example.com/");
//
// launch() returns a standard Playwright `Browser`, backed by a caller-provided local binary.
// Every Playwright launch option (headless, proxy, args, timeout, ...) passes through. Identity is
// selected with the strict native, captured, or synthetic API.

import { chromium } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions as PlaywrightLaunchOptions,
  Page,
} from "playwright-core";
import { type DownloadOptions } from "./download.js";
import { fingerprintArgs, personaAvail, personaDpr, splitFingerprintOptions, type FingerprintOptions } from "./fingerprint.js";
import { scaleWindowArgs, withDeviceScale } from "./scale.js";
import { prepareIdentityOptions, type Identity } from "./identity.js";
import { installHumanize, installHumanizeOnContext, type HumanizeOptions } from "./humanize.js";
import {
  FIRST_RUN_HYGIENE_ARGS,
  defaultStartUrlArgs,
  extensionArgs,
  resolveProxy,
  mergeFeatureFlags,
  privacySandboxArgs,
  domStorageBackendArgs,
  proxyBypassArgs,
  quicArgs,
  socks5UdpArgs,
  webBluetoothArgs,
  personaPlatformOf,
  IGNORED_PLAYWRIGHT_DEFAULTS,
  withPlaywrightFeatureDefaults,
  mergeIgnoreDefaultArgs,
  gateWebrtcArgs,
  webrtcDefaultDenyArgs,
  type PwProxy,
  assertNoReservedArgs,
} from "./launchopts.js";
import { RELEASE, platformRelease } from "./release.js";
import { fetchWidevine, seedWidevine, widevineArgs } from "./widevine.js";
import { emitCoherenceWarnings, gpuHostMissingFor } from "./warnings.js";
import { removeOwnDir, stopChild, track, untrack, type Tracked } from "./cleanup.js";
import { installedEngineVersion as readInstalledEngineVersion } from "./launch-ticket.js";
import { fontLaunchEnv } from "./fonts.js";
import { resolveFontPack } from "./fontpack.js";
export { resolveFontPack, packFamilies, PACK_VERSION as FONT_PACK_VERSION } from "./fontpack.js";
import { withShaderDialect, type ShaderDialect } from "./shaderdialect.js";
import { InactiveProfileWatch, PersonaFileRejectedError, personaFileRejection } from "./persona-rejected.js";
import {
  LaunchTicketRejectedError,
  hasLaunchTicketArg,
  rethrowIfTicketRejected,
  launchTicketRejection,
  LAUNCH_TICKET_EXIT_CODE,
  redactError,
  redactLaunchSecrets,
  launchSecretValues,
  applyTicketEnv,
  argsForTicketDecision,
  callerEnvTicket,
  launchTicketArgValue,
  sdkFetchedTicket,
  withTicketRetry,
  type TicketNote,
  dropPartialFirstLine,
  type LaunchTicketOption,
} from "./launch-ticket.js";
import {
  applyHeadlessGeometry, initialWindowArgs,
  type AppliedGeometry,
} from "./geometry.js";

import { manualBinary, withRuntimeLaunch } from "./runtime-launch.js";
import { assertPersonaFitsEngine, removeStalePersonaFile, stagePersonaProfile } from "./profile-file.js";
import { emitPersonaNotices } from "./warnings.js";
import type { RuntimeOptions } from "./runtime-client.js";
import { SdkError, SdkTypeError } from "./errors.js";
export { RuntimeError, type RuntimeOptions } from "./runtime-client.js";
export { SdkError, SdkInputError, SdkTypeError, SdkRangeError, reportFields, type CodedError, type ErrorClass } from "./errors.js";

export type { DownloadOptions } from "./download.js";
export { checkInstall, verifyInstall } from "./download.js";
export { resolveGeo, type Geo } from "./geoip.js";
export type { HumanizeOptions } from "./humanize.js";
// For callers that attach to an already-running browser (connectOverCDP) rather than launching
// one: humanize its existing context (current and future pages). Seed it from the identity's
// fingerprint so the motor persona matches the one a launch would have used.
export { installHumanizeOnContext } from "./humanize.js";
// The pure motor model behind humanized input (no page or browser access): seeded personas,
// mouse trajectories, click points and key/click timings. For callers that drive input over raw
// CDP themselves and want the same timing model as `humanize: true`.
export {
  mulberry32, hashSeed, gaussFrom, makePersona, clickHold, keyDwell, minJerk, planMove,
  dragDwell, clickPoint, planAmbient,
  type Rng, type Persona, type Point, type Step, type PlanOpts, type Box, type Viewport,
} from "./motion.js";
export { RELEASE, RELEASE_PUBLIC_KEY } from "./release.js";
export { installRelease, installedRelease, verifyMinisign, ReleaseError, SignatureError, type InstallReleaseOptions, type InstallProgress, type InstallProgressCallback } from "./release-fetch.js";
export { fetchWidevine, seedWidevine } from "./widevine.js";
export { checkRenderCoherence, type RenderVerdict } from "./render.js";
export { setContent, type SetContentOptions } from "./content.js";
export { PersonaFileRejectedError, personaFileRejection, personaInactiveReason, PERSONA_FILE_EXIT_CODE, PERSONA_FILE_REJECTED_CODE } from "./persona-rejected.js";
export {
  LaunchTicketRejectedError,
  LaunchTicketUnavailableError,
  launchTicketRejection,
  fetchLaunchTicket,
  discoverDaemon,
  resolveDaemonHome,
  inferEngineVersion,
  installedEngineVersion,
  resolveLaunchTicketArgs,
  hasLaunchTicketArg,
  LAUNCH_TICKET_SWITCH,
  LAUNCH_TICKET_ENV,
  LAUNCH_TICKET_EXIT_CODE,
  LAUNCH_TICKET_REJECTED_CODE,
  ENGINE_VERSION_ENV,
  type LaunchTicketOption,
  type DaemonLocation,
} from "./launch-ticket.js";
export {
  assertPersonaProfileV2,
  parsePersonaProfileV2,
  validatePersonaProfileV2,
  InvalidPersonaProfileV2Error,
  WEBGL_PARAMETER_NAMES,
  WEBGPU_LIMIT_NAMES,
  type PersonaProfileV2,
  type PersonaProfileValidationError,
  type PersonaProfileValidationErrorCode,
  type PersonaProfileValidationResult,
  type PersonaMetadata,
  type PersonaCompatibility,
  type PersonaHardware,
  type PersonaDisplay,
  type PersonaLocale,
  type PersonaGraphics,
  type PersonaWebGL,
  type PersonaWebGLVersion,
  type PersonaWebGPU,
  type PersonaAudio,
  type PersonaFonts,
  type PersonaSpeech,
  type PersonaVoice,
  type PersonaMedia,
  type PersonaCodec,
  type PersonaMediaDevice,
  type WebGLParameterName,
  type WebGLValue,
  type WebGPULimitName,
} from "./persona-profile-v2.js";
export { CHROMIUM_VERSION, CHROMIUM_MAJOR, CHROMIUM_UA_VERSION } from "./chromium-version.js";
export {
  migratePersonaBrowserMajor,
  needsMigration,
  personaBrowserMajor,
  PersonaMigrationError,
  MIGRATED_FIELDS,
} from "./persona-migration.js";
export {
  selectPersonaTemplate,
  type PersonaTemplate,
} from "./template-selection.js";
export {
  GENERATE_ALGORITHM,
  GENERATION_ORDER,
  PopulationModelError,
  loadPopulationModel,
  generatePersonaProfile,
  type PopulationModel,
  type PopulationModelValue,
} from "./population-model.js";
export {
  IDENTITY_WRAPPER_VERSION,
  GENERATED_IDENTITY_WRAPPER_VERSION,
  TEMPLATE_SELECTION_ALGORITHM,
  GENERATE_ALGORITHM as GENERATE_IDENTITY_ALGORITHM,
  IdentityPersistenceError,
  resolveIdentityDirectory,
  identityFilename,
  loadOrCreateDeviceKey,
  validatePersistedIdentity,
  loadPersistedIdentity,
  createOrLoadIdentity,
  createOrLoadGeneratedIdentity,
  createOrLoadIssuedIdentity,
  ISSUED_IDENTITY_WRAPPER_VERSION,
  type IssuedIdentityRecord,
  type IssuedPersistedIdentity,
  type PersistedIdentity,
  type GeneratedPersistedIdentity,
  type AnyPersistedIdentity,
  type IdentityPersistenceOptions,
} from "./identity-persistence.js";
export {
  CANVAS_NOISE_KEY_SWITCH, CANVAS_NOISE_KEY_LENGTH, CANVAS_NOISE_KEY_DOMAIN, canvasMode, isCanvasNoiseKey,
  newCanvasNoiseKey, deriveCanvasNoiseKey, canvasNoiseKeyFor, type CanvasMode,
} from "./canvas.js";
export { canvasNoiseKeyOfIdentity } from "./identity.js";
export { assertPersonaProfileV4, isPersonaV4, PersonaV4SchemaError, type PersonaProfileV4 } from "./persona-profile-v4.js";
export {
  PROFILE_FILE_SWITCH, SDK_INFO_SWITCH, PROFILE_FILE_NAME, enginePersonaInfo, enginePersonaSchemas, parseSdkInfoSchemas,
  writePersonaProfileFile, type EnginePersonaInfo,
} from "./profile-file.js";
export type { ClaimHints, ClaimLocale, ClaimBrand, ClaimHostGpuVendor } from "./claim-hints.js";
export {
  loadTemplateDirectory, loadCapturedProfile, resolveIdentity, prepareIdentityOptions,
  type Identity, type NativeIdentity, type CapturedIdentity, type SyntheticIdentity, type IdentityOverrides, type NetworkOverride,
  type ResolvedIdentity, type PreparedIdentityOptions,
} from "./identity.js";

/** When true (and a proxy is set), resolve the proxy's exit-IP geo and auto-fill any unset
 * `timezone` + `acceptLanguage` (+ `location`) so they match the proxy region. */
interface IdentityOption {
  /** Strict public identity mode. Omitted means native. */
  identity?: Identity;
  /** Explicit identity switches. These take precedence over captured/synthetic profile fields. */
  overrides?: import("./identity.js").IdentityOverrides;
}

/** Load unpacked extensions (emits --load-extension + --disable-extensions-except). */
interface ExtensionsOption {
  /** Unpacked-extension directory paths. */
  extensions?: string[];
  /** Disable Privacy Sandbox APIs (Topics/FLEDGE/Shared Storage/Fenced Frames).
   *
   * Default `false` since 0.23.0 — real Google Chrome ships all of them, and the default persona
   * (`brand: "chrome"`) claims to be Google Chrome, so disabling them was a coherence tell rather
   * than a privacy win. Set `true` when the persona genuinely is de-Googled Chromium. */
  disablePrivacySandbox?: boolean;
}

/** Profile-directory control for {@link launch}. */
interface EphemeralProfileOption {
  /** Launch on a throwaway persistent profile that is deleted on close. Default `true` since
   * 0.23.0 — incognito cannot load the Widevine CDM, which is itself a tell. Set `false` for the
   * pre-0.23 incognito launch. */
  ephemeralProfile?: boolean;
  /** Keep a profile at this path instead of a throwaway one (delegates to
   * {@link launchPersistentContext}; the directory is NOT deleted). */
  userDataDir?: string;
}

/** Opt-in shader-dialect reporting (see ./shaderdialect.ts). */
interface ShaderDialectOption {
  /** Report ANGLE's translated shader in this dialect for
   * `WEBGL_debug_shaders.getTranslatedShaderSource()`.
   *
   * `"hlsl"` makes a Windows persona on a Linux host report HLSL, matching the Direct3D renderer
   * string it already advertises — without it the Vulkan backend answers with SPIR-V and the two
   * values contradict each other. Rendering is unaffected.
   *
   * OFF by default: the re-translation is a different code path from the one that rendered, so a
   * shader the real backend accepts but the HLSL translator rejects falls back to the honest
   * dialect. Turn it on if you hit this specific check. Requires engine support. */
  shaderDialect?: ShaderDialect;
}

/** Opt-in SOCKS5 UDP relaying (see {@link socks5UdpArgs}). */
interface Socks5UdpOption {
  /** Ask for WebRTC UDP to be relayed through the SOCKS5 proxy (UDP ASSOCIATE).
   *
   * NOT IMPLEMENTED BY THE ENGINE: the `--socks5-udp` switch this sends is ignored by every engine
   * release so far, so setting it changes nothing. Non-proxied UDP stays denied and peer
   * connections that need UDP still fail. Kept for compatibility until the engine supports it.
   *
   * Applies only to a `socks5://` proxy; ignored otherwise. */
  socks5Udp?: boolean;
}

/** Options for {@link launch}: Playwright launch options plus local Ant0 Browser controls. */
/** Font options. The real Windows font pack is retired; look-alike fonts are always used. */
interface FontResolveOption {
  /** @deprecated No effect. The SDK no longer uses a Windows font pack; Windows profiles on Linux
   * use the bundled open look-alike fonts. */
  resolveFonts?: boolean;
}

export interface LaunchOptions extends PlaywrightLaunchOptions, IdentityOption, ExtensionsOption, EphemeralProfileOption, HumanizeOptions, DownloadOptions, ShaderDialectOption, Socks5UdpOption, FontResolveOption, LaunchTicketOption {}

/** Always undefined: the Windows font pack is retired (see fontpack.ts). */
async function fontPackForLaunch(
  identityMode: Identity["mode"], resolveFonts: boolean | undefined, quiet: boolean,
): Promise<string | undefined> {
  if (resolveFonts === false || process.platform !== "linux") return undefined;
  if (identityMode !== "captured" && identityMode !== "synthetic") return undefined;
  return resolveFontPack({ quiet });
}

/** Options for {@link launchPersistentContext}. */
export interface PersistentContextOptions
  extends PlaywrightLaunchOptions,
    BrowserContextOptions,
    IdentityOption,
    ExtensionsOption,
    HumanizeOptions,
    DownloadOptions,
    ShaderDialectOption,
    Socks5UdpOption,
    FontResolveOption,
    LaunchTicketOption {
  /**
   * Seed + enable the opt-in Widevine CDM in this profile so DRM/EME works
   * (`requestMediaKeySystemAccess('com.widevine.alpha')` resolves) and the EME surface matches a
   * real Chrome instead of being a no-Widevine tell. The CDM is fetched once from Google's
   * component server (see {@link fetchWidevine}); ant0-browser never bundles Google's blob.
   */
  widevine?: boolean;
}

function ensureRunnableHere(exe: string): void {
  if (platformRelease() === undefined) {
    throw new SdkError("sdk.environment_unsupported", 
      `Ant0 Browser ${RELEASE.version} ships Windows x64 and Linux x64 binaries — there is no build for '${process.platform}'.\n` +
        `Run on Windows or Linux, or pass executablePath to a compatible binary.\n` +
        `(The resolved local binary is: ${exe})`
    );
  }
}

/** Resolve the installed default without fetching a ticket. The returned path is informational;
 * launch/serve resolve again and retain native proof through their immediate spawn. */
export async function executablePath(
  options: { executablePath?: string; runtime?: RuntimeOptions; engineVersion?: string } & DownloadOptions = {}
): Promise<string> {
  return withRuntimeLaunch({ ...options, launchTicket: false }, r => r.executable);
}

/** Headless context defaults ride on newPage/newContext because `chromium.launch()` takes none. */
function installHeadlessGeometry(
  browser: Browser,
  geom: AppliedGeometry,
  dpr?: number,
): void {
  const defaults: Record<string, unknown> = geom.mode === "native"
    ? { viewport: null }
    : { screen: geom.screen, viewport: geom.viewport };
  const merge = (o: Record<string, unknown> = {}) =>
    withDeviceScale("viewport" in o || "screen" in o ? o : { ...o, ...defaults }, dpr);
  const origNewPage = browser.newPage.bind(browser);
  const origNewContext = browser.newContext.bind(browser);
  (browser as unknown as { newPage: (o?: Record<string, unknown>) => Promise<Page> }).newPage =
    async (o = {}) => origNewPage(merge(o) as Parameters<typeof origNewPage>[0]);
  (browser as unknown as { newContext: (o?: Record<string, unknown>) => Promise<BrowserContext> }).newContext =
    async (o = {}) => origNewContext(merge(o) as Parameters<typeof origNewContext>[0]);
}

/** A headed launch with Playwright's default emulated viewport (1280x720) on the real OS window
 * makes window.innerWidth/Height disagree with the actual window — an impossible-window tell. For a
 * headed browser, default new pages/contexts to `viewport: null` (innerWidth tracks the real window)
 * unless the caller asked for a viewport. */
function installHeadedViewport(browser: Browser, dpr?: number): void {
  const merge = (o: Record<string, unknown>) =>
    withDeviceScale("viewport" in o || "screen" in o ? o : { ...o, viewport: null }, dpr);
  const origNewPage = browser.newPage.bind(browser);
  (browser as { newPage: unknown }).newPage = (o: Record<string, unknown> = {}) => origNewPage(merge(o));
  const origNewContext = browser.newContext.bind(browser);
  (browser as { newContext: unknown }).newContext = (o: Record<string, unknown> = {}) => origNewContext(merge(o));
}

/** The engine release is only known once the executable is resolved, so the `--webrtc-ip` gate
 * (engines older than ant0.3 turn non-proxied UDP back on with it) is applied by each caller to
 * the assembled list, with the version `withRuntimeLaunch` reports. */
function personaPlatformFor(fp: { platform?: unknown; fingerprintProfile?: unknown }): string | undefined {
  return personaPlatformOf(fp.platform, fp.fingerprintProfile);
}

/** Assemble the final engine args from all layers: identity + extensions + proxy, the
 * Privacy-Sandbox-disable default, the WebRTC leak-proof default, and the user's own args — then
 * collapse all --enable-features/--disable-features into one each (Chromium keeps only the last). */
function assembleArgs(
  fpArgs: string[],
  extArgs: string[],
  proxyArgs: string[],
  disablePrivacySandbox: boolean | undefined,
  webrtcIp: unknown,
  userArgs: string[],
  proxyForQuic?: PwProxy,
  socks5Udp?: boolean,
  personaPlatform?: string,
  pinDomStorage = false
): string[] {
  assertNoReservedArgs(userArgs);
  // webBluetoothArgs: a Linux host hides navigator.bluetooth while exposing usb/serial/hid, an
  // OS-origin tell on a Windows or macOS persona. Emitted only for such a persona; a Linux persona
  // or a no-persona launch must not have it (real Linux Chrome lacks it).
  const base = [...fpArgs, ...extArgs, ...proxyArgs, ...quicArgs(proxyForQuic), ...socks5UdpArgs(socks5Udp, proxyForQuic), ...webBluetoothArgs(personaPlatform ?? null)];
  // DEFAULT FLIPPED IN 0.23.0 — opt IN to disabling, rather than opt out.
  //
  // Keep these APIs enabled unless the caller explicitly requests the de-Googled policy.
  if (disablePrivacySandbox === true) base.push(...privacySandboxArgs());
  // Sync captures only the leveldb DOM storage backend. Direct spawns (serve/launchPlan) pin here;
  // the Playwright launch paths pin inside withPlaywrightFeatureDefaults, only when Playwright's own
  // disabled list is known (else this --disable-features would replace the whole list).
  if (pinDomStorage) base.push(...domStorageBackendArgs());
  base.push(...webrtcDefaultDenyArgs([...base, ...userArgs], webrtcIp));
  return mergeFeatureFlags([...base, ...userArgs]);
}

/** `widevine: true`: seed the CDM into the profile and fix the launch args so the engine registers it
 * (un-suppress the component updater, force the startup scan on Windows). Best-effort: a failure
 * leaves DRM off and the launch proceeds. Returns the adjusted `ignoreDefaultArgs` and args. */
async function applyWidevineLaunch(
  userDataDir: string,
  ignoreDefaultArgs: string[] | boolean | undefined,
  userArgs: string[],
  quiet: boolean | undefined,
): Promise<{ ignoreDefaultArgs: string[] | boolean | undefined; args: string[] }> {
  try {
    await seedWidevine(userDataDir, { quiet });
    // The --component-updater=fast-update scan is Windows-only (on Linux the hint file registers
    // the CDM). Only warn about a user-supplied non-fast-update mode where fast-update matters.
    const cu = userArgs.filter((a) => a.includes("component-updater"));
    if (process.platform !== "linux" && cu.length && !cu.some((a) => a.includes("fast-update")) && !quiet) {
      process.stderr.write("[ant0-browser] [widevine] note: your --component-updater mode may not register the CDM; --component-updater=fast-update is needed to scan the pre-installed component\n");
    }
    const tweak = widevineArgs(ignoreDefaultArgs, userArgs);
    return { ignoreDefaultArgs: tweak.ignoreDefaultArgs, args: tweak.args };
  } catch (e) {
    if (!quiet) process.stderr.write(`[ant0-browser] [widevine] setup failed (continuing without DRM): ${String(e)}\n`);
    return { ignoreDefaultArgs, args: userArgs };
  }
}

function applyIdentityOption<T extends Record<string, unknown>>(
  options: T,
): { options: T; identityMode: Identity["mode"] } {
  const prepared = prepareIdentityOptions(options);
  return { options: prepared.options as T, identityMode: prepared.identityMode };
}

/**
 * Delete a throwaway profile directory once its context closes.
 *
 * THE RETRY IS NOT DEFENSIVE PADDING — a single attempt measurably does not work. On Windows the
 * browser still holds handles under the profile directory for a short window after `close()`
 * resolves, so the first removal throws EBUSY/EPERM. Measured on the first build of this change
 * (Python port): the directory survived a close plus a 1.5s wait and leaked silently.
 *
 * Two triggers, because neither alone is enough: `close` covers an orderly shutdown, and the
 * process-exit hook covers a script that throws or is interrupted with the browser still open.
 * Both funnel through one idempotent remove.
 */
function installEphemeralProfileCleanup(context: BrowserContext, userDataDir: string): void {
  let done = false;
  const remove = async () => {
    if (done) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        done = true;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); // 0.25→1.5s, ~5s total
      }
    }
  };
  // Synchronous: an exit handler cannot await, and an unresolved promise at exit removes nothing.
  const onExit = () => {
    if (done) return;
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* temp sweeper gets it */ }
  };
  process.once("exit", onExit);
  context.on("close", () => {
    void remove().finally(() => {
      if (done) process.removeListener("exit", onExit);
    });
  });
}

/**
 * Make a persistent BrowserContext satisfy code written against launch()'s Browser.
 *
 * `newContext()` returns THE PERSISTENT CONTEXT ITSELF rather than a fresh incognito one. That is
 * deliberate: a real incognito context would silently leave the profile behind — taking the
 * Widevine CDM and the component-updated state with it — handing back exactly the browser this
 * change exists to stop producing. Two calls returning the same context is a visible, documented
 * compromise; quietly returning a profile-less browser is not.
 */
function asBrowserLike(context: BrowserContext): Browser {
  const c = context as BrowserContext & { newContext?: unknown; contexts?: unknown };
  if (c.newContext === undefined) c.newContext = async () => context;
  if (c.contexts === undefined) c.contexts = () => [context];
  return context as unknown as Browser;
}

/**
 * Launch Ant0 Browser and return a Playwright browser handle backed by a REAL Chrome profile.
 *
 * PROFILE-BACKED BY DEFAULT (changed in 0.23.0). This used to be `chromium.launch()` — incognito,
 * no profile directory. Incognito cannot load a component-updated CDM, so
 * `requestMediaKeySystemAccess('com.widevine.alpha')` rejected and the EME surface was a
 * no-Widevine tell on a build branded Google Chrome (measured against the live audit on 150-r10).
 * It now launches a persistent context on a throwaway directory, so `widevine: true` works here.
 *
 * The directory is deleted when the context closes AND on process exit, so nothing is left behind
 * and no state survives to the next launch — the incognito-like isolation callers relied on is
 * preserved. Pass `userDataDir` to keep a profile, or `ephemeralProfile: false` to opt back out.
 */
export async function launch(options: LaunchOptions = {}): Promise<Browser> {
  // ephemeralProfile: false restores the pre-0.23 incognito launch. Kept because the persistent
  // path costs a directory create+delete per launch, which a caller spawning hundreds of
  // short-lived browsers may reasonably not want to pay for a CDM they never touch.
  const { ephemeralProfile, userDataDir, ...restOpts } = options as LaunchOptions & {
    ephemeralProfile?: boolean;
    userDataDir?: string;
  };
  if (userDataDir !== undefined) {
    return asBrowserLike(await launchPersistentContext(userDataDir, restOpts as PersistentContextOptions));
  }
  if (ephemeralProfile !== false) {
    const dir = mkdtempSync(join(tmpdir(), "ant0-browser-run-"));
    let context: BrowserContext;
    try {
      context = await launchPersistentContext(dir, restOpts as PersistentContextOptions);
    } catch (error) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* preserve launch error */ }
      throw error;
    }
    installEphemeralProfileCleanup(context, dir);
    return asBrowserLike(context);
  }
  return launchIncognito(restOpts as LaunchOptions);
}

/** The engine release to judge advisory warnings by: the trusted release record, else (for a
 * development build) its `-ant0.dev` label. Never used for a gate. */
function advisoryEngineVersion(resolved: string | undefined, exe: string): string | undefined {
  return resolved ?? readInstalledEngineVersion(exe, true);
}

/** The pre-0.23 incognito launch, reached via `ephemeralProfile: false`. */
async function launchIncognito(options: LaunchOptions = {}): Promise<Browser> {
  return withTicketRetry((note) => launchIncognitoOnce({ ...options }, note));
}

async function launchIncognitoOnce(options: LaunchOptions, note: TicketNote): Promise<Browser> {
  const identity = applyIdentityOption(options as unknown as Record<string, unknown>);
  options = identity.options as unknown as LaunchOptions;
  const { extensions, shaderDialect, socks5Udp, disablePrivacySandbox, executablePath: exeOption, args, humanize, showCursor, cacheDir, quiet, resolveFonts, launchTicket, engineVersion, runtime, ...rest } = options;
  const { fingerprint, rest: pwOptions } = splitFingerprintOptions(rest);
  const proxyOpt = (pwOptions as PlaywrightLaunchOptions).proxy;  // captured before resolveProxy runs
  // resolveProxy throws for a credentialed SOCKS proxy (nothing in the stack can authenticate to
  // one; use a relay). Every other shape is left to Playwright unchanged.
  const { args: proxyArgs, proxy } = resolveProxy((pwOptions as PlaywrightLaunchOptions).proxy as PwProxy | undefined);
  if (proxy === undefined) delete (pwOptions as Record<string, unknown>).proxy;
  else (pwOptions as Record<string, unknown>).proxy = proxy;
  // Refused before the engine is resolved, probed or any persona file is written.
  assertNoReservedArgs(args ?? []);
  return withRuntimeLaunch({ executablePath: exeOption, runtime, launchTicket, engineVersion, args: argsForTicketDecision(args, (pwOptions as PlaywrightLaunchOptions).env), quiet }, async ({ executable: exe, ticketArgs, engineVersion: resolvedEngine }) => {
  note(sdkFetchedTicket(launchTicket, ticketArgs));
  ensureRunnableHere(exe);
  // Emitted here, not before the engine is resolved: the GPU/canvas gap warnings depend on the engine release.
  emitCoherenceWarnings(
    { ...fingerprint, proxy: proxyOpt, geoip: false, headless: (pwOptions as PlaywrightLaunchOptions).headless, _userArgs: args ?? [], _cacheDirGiven: cacheDir !== undefined,
      _gpuHostMissing: gpuHostMissingFor(fingerprint as unknown as Record<string, unknown>, identity.identityMode) },
    quiet, process.platform, String(RELEASE.version).split(".")[0], advisoryEngineVersion(resolvedEngine, exe));
  const headed = (pwOptions as PlaywrightLaunchOptions).headless === false;
  // On Linux, point FONTCONFIG_FILE at the bundled metric-compatible clones (Segoe UI, Arial, …).
  const packDir = await fontPackForLaunch(identity.identityMode, resolveFonts, Boolean(quiet));
  const launchEnv = withShaderDialect(shaderDialect, fontLaunchEnv(exe, (pwOptions as PlaywrightLaunchOptions).env, packDir));
  const dpr = personaDpr(fingerprint);
  // Schema 4 personas travel in a private file (no profile dir here, so a temp dir, removed when the browser closes).
  const staged = await stagePersonaProfile(fingerprint, exe);
  emitPersonaNotices(staged.notices, quiet);
  let launched = false;
  try {
  const sdkArgs = scaleWindowArgs(fingerprintArgs(staged.fingerprint, true), dpr, headed, personaAvail(fingerprint), args ?? []);
  let engineArgs = gateWebrtcArgs(assembleArgs(sdkArgs, extensionArgs(extensions), proxyArgs, disablePrivacySandbox, fingerprint.webrtcIp, args ?? [], proxyOpt as PwProxy | undefined, socks5Udp, personaPlatformFor(fingerprint)), resolvedEngine, quiet, Boolean(proxyOpt?.server));
  // Headless: screen.* has to be handled alongside the viewport or the window reports a geometry no
  // real browser can (see ./geometry.ts). Probe a copy — viewport/screen are context options, which
  // chromium.launch() does not take — and carry the result to newPage/newContext.
  const geom = headed
    ? null
    : identity.identityMode === "native"
      ? { mode: "native" } as AppliedGeometry
      : applyHeadlessGeometry({ ...(pwOptions as Record<string, unknown>) }, fingerprint.fingerprint, engineArgs);
  engineArgs = initialWindowArgs(engineArgs, geom);
  // The caller's ticket, or one from the local daemon (see ./launch-ticket.ts).
  engineArgs = [...engineArgs, ...ticketArgs];
  // The same ticket in ANT0_LAUNCH of the engine child (a copy of the env; never process.env).
  const ticketed = applyTicketEnv(engineArgs, launchEnv, (pwOptions as PlaywrightLaunchOptions).env);
  engineArgs = withPlaywrightFeatureDefaults(ticketed.args, mergeIgnoreDefaultArgs((pwOptions as PlaywrightLaunchOptions).ignoreDefaultArgs, args), quiet);
  const childEnv = ticketed.env;
  let browser: Browser;
  try {
    browser = await chromium.launch({
      // Drop Playwright's default --enable-automation so the engine's AutomationControlled feature
      // stays off (it flips webdriver-adjacent tells). Caller can override via ignoreDefaultArgs.
      ...(pwOptions as PlaywrightLaunchOptions),
      ignoreDefaultArgs: mergeIgnoreDefaultArgs((pwOptions as PlaywrightLaunchOptions).ignoreDefaultArgs, args),
      executablePath: exe,
      ...(childEnv ? { env: childEnv } : {}),
      args: engineArgs,
    });
  } catch (error) {
    rethrowIfTicketRejected(error, launchSecretValues(engineArgs, [], childEnv));  // exit 90 / 91 + stderr line -> LaunchTicketRejectedError / PersonaFileRejectedError
  }
  if (headed) {
    installHeadedViewport(browser, dpr); // launch() takes no viewport option -> wrap newPage/newContext
  }
  else if (geom) installHeadlessGeometry(browser, geom, dpr);
  installHumanize(browser, { humanize, showCursor, seed: fingerprint.fingerprint }); // seed => stable motor persona
  staged.removeFile(); // the engine read it at startup: the file does not stay until the browser closes
  browser.once("disconnected", () => staged.cleanup()); // the temp dir goes when the browser does (process exit is the fallback)
  launched = true;
  return browser;
  } finally { if (!launched) staged.cleanup(); }
  });
}

/**
 * Launch Ant0 Browser with a persistent profile directory and return a Playwright
 * {@link BrowserContext} (cookies, storage, etc. persist in `userDataDir`).
 */
export async function launchPersistentContext(
  userDataDir: string,
  options: PersistentContextOptions = {}
): Promise<BrowserContext> {
  return withTicketRetry((note) => launchPersistentContextOnce(userDataDir, { ...options }, note));
}

async function launchPersistentContextOnce(userDataDir: string, options: PersistentContextOptions, note: TicketNote): Promise<BrowserContext> {
  const identity = applyIdentityOption(options as unknown as Record<string, unknown>);
  options = identity.options as unknown as PersistentContextOptions;
  const { extensions, shaderDialect, socks5Udp, disablePrivacySandbox, executablePath: exeOption, args, humanize, showCursor, cacheDir, quiet, widevine, resolveFonts, launchTicket, engineVersion, runtime, ...rest } = options;
  const { fingerprint, rest: pwOptions } = splitFingerprintOptions(rest);
  const proxyOpt = (pwOptions as PlaywrightLaunchOptions).proxy;  // captured before resolveProxy runs
  // Throws for a credentialed SOCKS proxy (see resolveProxy); other shapes pass through unchanged.
  const { args: proxyArgs, proxy } = resolveProxy((pwOptions as PlaywrightLaunchOptions).proxy as PwProxy | undefined);
  if (proxy === undefined) delete (pwOptions as Record<string, unknown>).proxy;
  else (pwOptions as Record<string, unknown>).proxy = proxy;
  const opts = pwOptions as PlaywrightLaunchOptions & BrowserContextOptions;
  // headed + no explicit viewport -> disable the emulated viewport (impossible-window tell)
  const headedNoViewport = opts.headless === false
    && opts.viewport === undefined && opts.screen === undefined;
  if (headedNoViewport) opts.viewport = null;
  // widevine=true: seed the CDM into the profile + un-suppress the component updater (Playwright
  // disables it by default) so the engine registers it. Failure -> DRM gracefully off, launch proceeds.
  // Default the automation strip BEFORE the Widevine helper so it appends --disable-component-update
  // to ['--enable-automation'] rather than clobbering it (losing the strip). Caller's own wins.
  let ignoreDefaultArgs: string[] | boolean | undefined =
    mergeIgnoreDefaultArgs(opts.ignoreDefaultArgs, args);
  assertNoReservedArgs(args ?? []); // before the profile directory is touched, the engine probed or a persona written
  let userArgs = args ?? [];
  if (widevine) {
    const wv = await applyWidevineLaunch(userDataDir, ignoreDefaultArgs, userArgs, quiet);
    ignoreDefaultArgs = wv.ignoreDefaultArgs;
    userArgs = wv.args;
  }
  delete (opts as Record<string, unknown>).ignoreDefaultArgs;  // passed explicitly below
  return withRuntimeLaunch({ executablePath: exeOption, runtime, launchTicket, engineVersion, args: argsForTicketDecision(userArgs, (opts as PlaywrightLaunchOptions).env), quiet }, async ({ executable: exe, ticketArgs, engineVersion: resolvedEngine }) => {
  note(sdkFetchedTicket(launchTicket, ticketArgs));
  ensureRunnableHere(exe);
  // Emitted here, not before the engine is resolved: the GPU/canvas gap warnings depend on the engine release.
  emitCoherenceWarnings(
    { ...fingerprint, proxy: proxyOpt, geoip: false, headless: (pwOptions as PlaywrightLaunchOptions).headless, _userArgs: args ?? [], _cacheDirGiven: cacheDir !== undefined,
      _gpuHostMissing: gpuHostMissingFor(fingerprint as unknown as Record<string, unknown>, identity.identityMode) },
    quiet, process.platform, String(RELEASE.version).split(".")[0], advisoryEngineVersion(resolvedEngine, exe));
  const packDir = await fontPackForLaunch(identity.identityMode, resolveFonts, Boolean(quiet));
  const ctxEnv = withShaderDialect(shaderDialect, fontLaunchEnv(exe, (opts as PlaywrightLaunchOptions).env, packDir));
  const dpr = personaDpr(fingerprint);
  // Schema 4 personas travel in a private file inside the profile directory.
  const stagedPersona = await stagePersonaProfile(fingerprint, exe, userDataDir);
  emitPersonaNotices(stagedPersona.notices, quiet);
  const sdkArgs = scaleWindowArgs(fingerprintArgs(stagedPersona.fingerprint, true), dpr, opts.headless === false, personaAvail(fingerprint), userArgs);
  let engineArgs = gateWebrtcArgs(assembleArgs(sdkArgs, extensionArgs(extensions), proxyArgs, disablePrivacySandbox, fingerprint.webrtcIp, userArgs, proxyOpt as PwProxy | undefined, socks5Udp, personaPlatformFor(fingerprint)), resolvedEngine, quiet, Boolean(proxyOpt?.server));
  // Native persona/profile geometry only needs viewport:null. A seedless headless launch receives
  // corpus context geometry. Headed mode already set viewport:null above.
  const geom = opts.headless === false
    ? null
    : identity.identityMode === "native"
      ? ({ mode: "native" } as AppliedGeometry)
      : applyHeadlessGeometry(opts as unknown as Record<string, unknown>, fingerprint.fingerprint, engineArgs);
  if (identity.identityMode === "native" && opts.headless !== false && opts.viewport === undefined) {
    opts.viewport = null;
  }
  engineArgs = initialWindowArgs(engineArgs, geom);
  // A caller's (or the corpus) viewport emulates scale 1; give it the persona's scale.
  Object.assign(opts, withDeviceScale(opts as Record<string, unknown>, dpr));
  // The caller's ticket, or one from the local daemon (see ./launch-ticket.ts).
  engineArgs = [...engineArgs, ...ticketArgs];
  // The same ticket in ANT0_LAUNCH of the engine child (a copy of the env; never process.env).
  const ticketed = applyTicketEnv(engineArgs, ctxEnv, (opts as PlaywrightLaunchOptions).env);
  engineArgs = withPlaywrightFeatureDefaults(ticketed.args, ignoreDefaultArgs, quiet);
  const childEnv = ticketed.env;
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      ...opts,
      ignoreDefaultArgs,  // keep AutomationControlled off (+ component updater on when widevine)
      executablePath: exe,
      ...(childEnv ? { env: childEnv } : {}),
      args: engineArgs,
    });
  } catch (error) {
    stagedPersona.removeFile();
    stagedPersona.cleanup(); // a no-op unless userDataDir was "" (a temp persona dir was made)
    rethrowIfTicketRejected(error, launchSecretValues(engineArgs, [userDataDir], childEnv));  // exit 90 / 91 + stderr line -> LaunchTicketRejectedError / PersonaFileRejectedError
  }
  stagedPersona.removeFile(); // the engine read it at startup; nothing may be left in the kept profile
  context.once("close", () => stagedPersona.cleanup());
  installHumanizeOnContext(context, { humanize, showCursor, seed: fingerprint.fingerprint }); // seed => stable motor persona
  return context;
  });
}


/** A free ephemeral TCP port on loopback. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export interface ServeOptions extends LaunchOptions {
  /** CDP port (default: a free ephemeral port; pass 9222 for the conventional one). */
  port?: number;
  /** Bind address — keep it loopback (default 127.0.0.1) for safety. */
  host?: string;
  /** `--remote-allow-origins` value (default: the loopback origins only; "*" for trusted local use). */
  allowOrigins?: string;
  /** Persistent profile dir (default: a fresh temp dir, removed on close). */
  userDataDir?: string;
  /** Run headless (default true; false for a visible window). */
  headless?: boolean;
  /** How long to wait for the CDP endpoint to come up (ms; default 30000). */
  readyTimeoutMs?: number;
  /** Seed the Widevine CDM into the served profile (as `launchPersistentContext` does) and add the
   * switches the engine needs to register it. Best-effort: a failure leaves DRM off. */
  widevine?: boolean;
}

/**
 * Everything {@link serve} resolves BEFORE it spawns the binary, for a supervisor that must own the
 * child process itself (exit codes, stderr capture, SIGKILL fallback, pid) while launching exactly
 * the configuration `serve()` would: identity, fingerprint switches, proxy routing,
 * extensions, font wiring, shader dialect, and the CDP switches.
 */
export interface LaunchPlan {
  /** Resolved binary path (after {@link executablePath} + the host-platform check). */
  executable: string;
  /** Engine args, then the CDP + first-run hygiene switches, then `about:blank` when the caller
   * passed no URL positional — exactly what `serve()` passes to `spawn`. */
  args: string[];
  /** The environment `serve()` spawns with: `process.env`, then the font wiring, then the caller's
   * `env` (a variable the caller sets to `undefined` is removed), then the shader dialect, then the launch ticket in
   * `ANT0_LAUNCH` (the same value as the `--ant0-launch=` in `args`; a caller's own `ANT0_LAUNCH` or `--ant0-launch=` is
   * never overwritten, and the one that is missing is filled from the other). Entries
   * whose value is `undefined` or `null` are dropped; the rest are stringified. */
  env: Record<string, string>;
  /** Resolved profile directory. A fresh temp dir is created when the caller passed none. */
  userDataDir: string;
  /** True when the plan created `userDataDir`; the caller is then responsible for removing it. */
  ownUserDataDir: boolean;
  /** Resolved CDP bind address. */
  host: string;
  /** Resolved CDP port (a free ephemeral one when the caller passed none). */
  port: number;
  /** `http://host:port` — the CDP HTTP base once the browser is up. */
  cdpUrl: string;
  identityMode: "native" | "captured" | "synthetic";
  headless: boolean;
  /** Absolute path of the persona file written for a schema 4 persona (inside `userDataDir`), else
   * undefined. The engine reads it once at startup: call {@link removePersonaFile} when the browser is
   * up (or when the launch failed or the process exited). The next launch also removes a stale one. */
  personaFile?: string;
  /** Delete {@link personaFile}. Idempotent; a no-op without a schema 4 persona. */
  removePersonaFile(): void;
  /** Fresh verification for this spawn; use for automatic discovery. Raw fields are a snapshot. */
  spawn?(options?: Pick<SpawnOptions, "stdio" | "detached" | "cwd">): Promise<ChildProcess>;
}

/**
 * Stale tickets: unlike {@link serve}, a plan cannot retry for you. If your child exits 90 with `claim_expired` or
 * `claim_stale` and the ticket was the SDK-fetched one (you passed no ticket of your own), build a fresh plan (or call
 * `plan.spawn()` again, which fetches a new ticket) and respawn ONCE; do not retry any other reason.
 *
 * Resolve a {@link LaunchPlan} from {@link ServeOptions} without launching anything. This is the
 * first half of {@link serve}; a supervisor spawns `plan.executable` with `plan.args` and
 * `plan.env`, polls `plan.cdpUrl + "/json/version"` for readiness, and removes `plan.userDataDir`
 * on exit when `plan.ownUserDataDir` is true. Side effects: may create the temp profile dir and,
 * nothing is downloaded.
*
 * Spawn window: the plan carries a launch ticket that engines from ant0.11 accept only for about 5 minutes after it
 * was issued. Spawn the plan promptly, and call `launchPlan` again for every (re)spawn; never respawn from an old plan.
 */
export async function launchPlan(options: ServeOptions = {}): Promise<LaunchPlan> {
  const identity = applyIdentityOption(options as unknown as Record<string, unknown>);
  options = identity.options as unknown as ServeOptions;
  const {
    port,
    host = "127.0.0.1",
    allowOrigins,
    userDataDir: uddOption,
    headless = true,
    readyTimeoutMs: _readyTimeoutMs, // consumed by serve()'s readiness loop, not a launch input
    humanize: _humanize, // Playwright-only; not applicable to a direct launch
    showCursor: _showCursor,
    ...launchOpts
  } = options;

  // Build the same arg set as launch(); the caller launches the binary directly.
  const {
    extensions, shaderDialect, socks5Udp, disablePrivacySandbox, executablePath: exeOption,
    args: callerArgs, cacheDir, quiet, widevine, resolveFonts, launchTicket, engineVersion, runtime, ...rest
  } = launchOpts;
  const { fingerprint, rest: pwOptions } = splitFingerprintOptions(rest);
  // The resolved proxy (a socks5h:// server is sent as socks5://); throws for a credentialed SOCKS one.
  const { args: proxyArgs, proxy: proxyOpt } = resolveProxy((pwOptions as PlaywrightLaunchOptions).proxy as PwProxy | undefined);
  // Playwright adds --no-sandbox unless chromiumSandbox is true; a direct spawn keeps Chromium's
  // sandbox on by default and drops it only for an explicit false.
  const noSandbox = (pwOptions as { chromiumSandbox?: boolean }).chromiumSandbox === false;
  const callerEnv = (pwOptions as PlaywrightLaunchOptions).env as Record<string, string | undefined> | undefined;
  assertNoReservedArgs(callerArgs ?? []); // before any temp dir, probe or persona file
  let userArgs = callerArgs;
  if (typeof launchTicket === "string" && !hasLaunchTicketArg(userArgs ?? []) && launchTicket.split(".").length !== 5) {
    throw new SdkTypeError("sdk.launch_ticket_invalid", "launchTicket must be the five-segment value the daemon issues");
  }
  return withRuntimeLaunch({ executablePath: exeOption, runtime, launchTicket: manualBinary({ executablePath: exeOption }) ? launchTicket : false, engineVersion, args: argsForTicketDecision(userArgs, callerEnv), quiet }, async ({ executable: exe, ticketArgs, engineVersion: resolvedEngine }) => {
  ensureRunnableHere(exe);
  // Emitted here, not before the engine is resolved: the GPU/canvas gap warnings depend on the engine release.
  emitCoherenceWarnings(
    { ...fingerprint, proxy: proxyOpt, geoip: false, headless, _userArgs: userArgs ?? [], _cacheDirGiven: cacheDir !== undefined,
      _gpuHostMissing: gpuHostMissingFor(fingerprint as unknown as Record<string, unknown>, identity.identityMode) },
    quiet, process.platform, String(RELEASE.version).split(".")[0], advisoryEngineVersion(resolvedEngine, exe));
  // Env before the temp dir: withShaderDialect throws on a bad dialect, and nothing must leak then.
  // Layered as launch() does: process.env < font wiring < caller env, then the shader dialect.
  const packDir = await fontPackForLaunch(identity.identityMode, resolveFonts, Boolean(quiet));
  const planEnv = (exePath: string): Record<string, string> => {
    // Both helpers already start from process.env and drop what the caller removed; spreading
    // process.env underneath would bring a caller-removed variable back.
    const layered = withShaderDialect(shaderDialect, fontLaunchEnv(exePath, callerEnv, packDir)) ?? process.env;
    const out: Record<string, string> = {};
    // undefined and null values are dropped (as Python drops None); the rest are stringified.
    for (const [k, v] of Object.entries(layered)) if (v !== undefined && v !== null) out[k] = String(v);
    return out;
  };
  const env = planEnv(exe);

  const resolvedPort = port ?? (await freePort());
  const ownUserDataDir = !uddOption;
  const userDataDir = uddOption ?? mkdtempSync(join(tmpdir(), "ant0-browser-serve-"));
  // From here the plan's own temp dir exists; the caller takes ownership only once the plan is
  // returned, so a throw before that point must remove it (nothing can, otherwise).
  try {
  // widevine: true seeds the CDM into the served profile before the args are built, as
  // launchPersistentContext does (the component-updater switch it may add lands in the args).
  if (widevine) userArgs = (await applyWidevineLaunch(userDataDir, undefined, userArgs ?? [], quiet)).args;
  // Ungated on purpose: spawn() resolves the engine again, and the `--webrtc-ip` gate must use
  // the version of the binary that actually starts.
  const stagedServe = await stagePersonaProfile(fingerprint, exe, userDataDir);
  emitPersonaNotices(stagedServe.notices, quiet);
  const rawEngineArgs = assembleArgs(
    scaleWindowArgs(fingerprintArgs(stagedServe.fingerprint, true), personaDpr(fingerprint), headless === false,
      personaAvail(fingerprint), userArgs ?? []),
    extensionArgs(extensions),
    proxyArgs, disablePrivacySandbox, fingerprint.webrtcIp, userArgs ?? [], proxyOpt, socks5Udp,
    personaPlatformFor(fingerprint), true);
  const engineArgs = gateWebrtcArgs(rawEngineArgs, resolvedEngine, quiet, Boolean(proxyOpt?.server));

  const origins = allowOrigins ?? `http://${host}:${resolvedPort},http://localhost:${resolvedPort}`;
  // Playwright's launch() adds the first-run hygiene switches itself; a direct spawn must add
  // them, or the first tab is chrome://ungoogled-first-run (see FIRST_RUN_HYGIENE_ARGS).
  const cdpArgs = [
    `--remote-debugging-port=${resolvedPort}`,
    `--remote-debugging-address=${host}`,
    `--remote-allow-origins=${origins}`,
    `--user-data-dir=${userDataDir}`,
    ...FIRST_RUN_HYGIENE_ARGS,
  ];
  if (headless) cdpArgs.push("--headless=new");
  if (proxyOpt?.server) {
    cdpArgs.push(`--proxy-server=${proxyOpt.server}`);
    // A caller's own --proxy-bypass-list wins, as it does under Playwright (args come last).
    if (!(userArgs ?? []).some((a) => String(a).startsWith("--proxy-bypass-list"))) cdpArgs.push(...proxyBypassArgs(proxyOpt));
  }
  if (noSandbox && !(userArgs ?? []).includes("--no-sandbox")) cdpArgs.push("--no-sandbox");
  // Chromium opens every positional as a URL; with none from the caller, open about:blank so the
  // first tab is neutral. Appended last so a caller's URL positionals (inside engineArgs) win.
  const startUrlArgs = defaultStartUrlArgs(engineArgs);
  // The caller's ticket (ant0d passes its own in `args`, which wins), or one
  // from the local daemon; the last switch before the start URLs, as the daemon does it.
  let spawned = false;
  // The ticket also goes in ANT0_LAUNCH of the engine's environment. The plan's env carries it
  // (a copy; process.env is not touched), so a supervisor that spawns the plan itself passes it on.
  const ticketedPlan = ticketedPlanFor([...engineArgs, ...cdpArgs, ...ticketArgs, ...startUrlArgs], env, callerEnv);

  return {
    executable: exe,
    args: ticketedPlan.args,
    env: ticketedPlan.env,
    userDataDir,
    ownUserDataDir,
    host,
    port: resolvedPort,
    cdpUrl: `http://${host}:${resolvedPort}`,
    identityMode: identity.identityMode,
    headless,
    personaFile: stagedServe.fingerprint.fingerprintProfileFile,
    removePersonaFile: () => stagedServe.removeFile(),
    async spawn(spawnOptions = {}) {
      if (spawned) throw new SdkError("sdk.launch_plan_used", "This launch plan has already been used; create a fresh plan");
      spawned = true;
      return withRuntimeLaunch({ executablePath: exeOption, runtime, launchTicket, engineVersion, args: argsForTicketDecision(userArgs, callerEnv), quiet }, async fresh => {
        // The engine that starts is the one that was checked: spawn() resolves the binary again, and a
        // different one has not been probed for the persona's format and requirements.
        if (fresh.executable !== exe) await assertPersonaFitsEngine(fingerprint.fingerprintProfile, fresh.executable);
        const freshEnv = planEnv(fresh.executable);
        return new Promise<ChildProcess>((resolve, reject) => {
          const freshPlan = ticketedPlanFor([...gateWebrtcArgs(rawEngineArgs, fresh.engineVersion, true, Boolean(proxyOpt?.server)), ...cdpArgs, ...fresh.ticketArgs, ...startUrlArgs], freshEnv, callerEnv);
          const child = spawn(fresh.executable, freshPlan.args,
            { ...spawnOptions, env: freshPlan.env, stdio: spawnOptions.stdio ?? ["ignore", "ignore", "pipe"] });
          child.once("error", reject);
          child.once("spawn", () => resolve(child));
        });
      });
    },
  };
  } catch (error) {
    if (ownUserDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* keep the original error */ } }
    else removeStalePersonaFile(userDataDir); // the persona file of a plan that never came to be
    throw error;
  }
  });
}

/** `applyTicketEnv` for a plan: the env stays a plain string map. */
function ticketedPlanFor(args: string[], env: Record<string, string>, callerEnv?: Record<string, string | undefined>): { args: string[]; env: Record<string, string> } {
  const t = applyTicketEnv(args, env, callerEnv);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.env)) if (v !== undefined) out[k] = String(v);
  return { args: t.args, env: out };
}

/** Handle for a standing ant0-browser CDP endpoint. Use `.cdpUrl` with any CDP client.
 *
 * Cleanup: call `close()`. Ctrl+C / SIGTERM cleanup is the application's job (the SDK installs no
 * signal handlers). If the process exits without it, an exit hook stops the browser (SIGTERM) and
 * removes the temp profile dir `serve()` created; a `userDataDir` you passed is never deleted. */
export class Server {
  /** OS process id of the browser (undefined only if the spawn never produced one). */
  readonly pid: number | undefined;
  private closing: Promise<void> | undefined;
  private readonly entry: Tracked;
  constructor(
    private readonly proc: ChildProcess,
    readonly host: string,
    readonly port: number,
    private readonly userDataDir: string,
    private readonly ownUdd: boolean,
    /** @internal How long close() waits after SIGTERM before it falls back to SIGKILL. */
    private readonly graceMs = 5000,
  ) {
    this.pid = proc.pid;
    this.entry = track(proc, ownUdd ? userDataDir : undefined);
  }
  /** HTTP CDP base — pass to `connectOverCDP` / `puppeteer.connect({ browserURL })`. */
  get cdpUrl(): string {
    return `http://${this.host}:${this.port}`;
  }
  /** The browser-level WebSocket URL (for clients that want `connect({ browserWSEndpoint })`). */
  async wsUrl(): Promise<string | undefined> {
    try {
      const r = await fetch(`${this.cdpUrl}/json/version`);
      return ((await r.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
    } catch {
      return undefined;
    }
  }
  isAlive(): boolean {
    return this.proc.exitCode === null && !this.proc.killed;
  }
  /** Stop the browser (SIGTERM, SIGKILL only after a timeout), wait for it to exit, then remove the
   * temp profile dir if serve() created it. The server stays registered for the exit hook until all
   * of that has finished, so `srv.close(); process.exit(0)` without await still cleans up. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await stopChild(this.proc, this.graceMs);
      if (this.ownUdd) await removeOwnDir(this.userDataDir);
      untrack(this.entry);
    })();
    return this.closing;
  }
}

/**
 * Launch Ant0 Browser with a RAW CDP endpoint and return a {@link Server}. Unlike {@link launch}, `serve`
 * leaves a standing browser any client attaches to with no code change:
 * ```ts
 * const srv = await serve({ identity: { mode: "native" } });
 * const browser = await chromium.connectOverCDP(srv.cdpUrl);        // Playwright
 * // or: await puppeteer.connect({ browserURL: srv.cdpUrl });        // Puppeteer
 * // or: point browser-use / Crawl4AI / Stagehand at srv.cdpUrl
 * await srv.close();
 * ```
 * The binary is launched **directly** (not through Playwright/Puppeteer), so the
 * `--enable-automation` flag those frameworks add is never present and `navigator.webdriver` stays
 * `false`; the engine stops `Runtime.enable` from running page code (no console-argument
 * serialization, live or replayed, so no getter, Proxy trap or `toString` fires). It does not
 * change what an attached client adds itself (init scripts, exposed bindings, emulation
 * overrides, other CDP domains); the port binds to loopback with an origin
 * allowlist; attaching over CDP adds no launch flags, so the served persona is preserved end to end.
 *
 * First-run hygiene: Playwright's `launch()` passes `--no-first-run`, `--no-default-browser-check`
 * and `--disable-search-engine-choice-screen` on its own; `serve()`/`launchPlan()` add the same
 * three switches (plain UI switches, no `base::Feature` toggles, nothing a page can observe) and,
 * when the caller passes no URL positional in `args`, open `about:blank`. Without them the
 * the engine opens `chrome://ungoogled-first-run` in the first tab.
 *
 * To own the child process yourself (a daemon supervising exit codes, stderr, kill escalation),
 * call {@link launchPlan} with the same options and spawn from the returned plan instead.
 */
export async function serve(options: ServeOptions = {}): Promise<Server> {
  return withTicketRetry((note) => serveOnce({ ...options }, note));
}

async function serveOnce(options: ServeOptions, note: TicketNote): Promise<Server> {
  const { readyTimeoutMs = 30000, quiet } = options;
  const plan = await launchPlan(options);
  // A ticket the SDK fetched (none of the caller's own forms is present) may be retried once if the engine finds it stale.
  note(typeof options.launchTicket !== "string" && options.launchTicket !== false && !hasLaunchTicketArg(options.args ?? [])
    && !callerEnvTicket((options as { env?: Record<string, string | undefined> }).env) && launchTicketArgValue(plan.args) !== undefined);
  const { host, port: resolvedPort, userDataDir, ownUserDataDir: ownUdd } = plan;
  const dropOwnUdd = () => {
    if (ownUdd) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };

  // Launched directly, without Playwright or --enable-automation. stderr is piped and drained
  // into a bounded tail so an exit-90 launch-ticket rejection can be named.
  let proc: ChildProcess;
  let stderrTail = "";
  const inactive = new InactiveProfileWatch(); // "... profile remains inactive" = invalid persona, host values in use
  try {
    proc = await plan.spawn!();
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-8192);
      inactive.push(text); // the listener stays attached, so the pipe is always drained
    });
  } catch (error) {
    plan.removePersonaFile();
    dropOwnUdd();
    throw redactError(error, launchSecretValues(plan.args, [userDataDir], plan.env)); // a spawn error carries `spawnargs`: the whole command line
  }
  // From here the child and its temp dir are covered by the exit hook (and by abort() below), also
  // while we wait for readiness; the Server takes over the registration once it exists.
  const launch = track(proc, ownUdd ? userDataDir : undefined);
  const abort = async () => {
    plan.removePersonaFile();
    await stopChild(proc, 500);
    if (ownUdd) await removeOwnDir(userDataDir);
    untrack(launch);
  };

  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || inactive.reason !== undefined) break;
    try {
      await fetch(`${plan.cdpUrl}/json/version`);
      ready = true;
      break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (inactive.reason !== undefined) {
    await abort(); // the engine runs on host values: stop it rather than hand back a browser with no persona
    throw new PersonaFileRejectedError(inactive.reason);
  }
  if (!ready) {
    await abort();
    const secrets = launchSecretValues(plan.args, [userDataDir], plan.env);
    stderrTail = dropPartialFirstLine(stderrTail, stderrTail.length >= 8192);
    const reason = launchTicketRejection(stderrTail);
    if (reason || proc.exitCode === LAUNCH_TICKET_EXIT_CODE) {
      throw new LaunchTicketRejectedError(reason ?? "missing", redactLaunchSecrets(stderrTail.trim(), secrets));
    }
    const persona = personaFileRejection(stderrTail, proc.exitCode);
    if (persona) throw new PersonaFileRejectedError(persona);
    throw new SdkError("sdk.engine_not_ready", 
      `ant0-browser serve: CDP endpoint at ${plan.cdpUrl} did not come up within ${readyTimeoutMs}ms` +
      (proc.exitCode !== null ? ` (engine exited with code ${proc.exitCode})` : "") +
      (stderrTail.trim() ? `\n${redactLaunchSecrets(stderrTail.trim(), secrets)}` : ""));
  }
  plan.removePersonaFile(); // the engine read it at startup
  const srv = new Server(proc, host, resolvedPort, userDataDir, ownUdd);
  untrack(launch);
  if (!quiet) {
    process.stderr.write(
      `[ant0-browser] CDP endpoint ready: ${srv.cdpUrl}\n` +
      `            attach any client: connectOverCDP(${JSON.stringify(srv.cdpUrl)}) / puppeteer.connect({ browserURL })\n`);
  }
  return srv;
}

export default {
  launch,
  launchPersistentContext,
  serve,
  launchPlan,
  Server,
  executablePath,
  fetchWidevine,
  seedWidevine,
  RELEASE,
};
