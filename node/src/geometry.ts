/** Headless context geometry defaults shared with the Python SDK. */
import { createHash } from "node:crypto";

export const ENGINE_FRAME_WIDTH = process.platform === "win32" ? 16 : 8;
export const ENGINE_FRAME_HEIGHT = process.platform === "win32" ? 134 : 131;

/** `[screenWidth, screenHeight, weight, osHint]`. */
export const HEADLESS_SCREEN_PROFILES: ReadonlyArray<readonly [number, number, number, string]> = [
  [1920, 1080, 24, "windows"],
  [2560, 1440, 13, "windows"],
  [1920, 1200, 6, "linux"],
  [1366, 768, 3, "windows"],
  [1600, 900, 3, "linux"],
  [3440, 1440, 2, "windows"],
  [3840, 2160, 2, "windows"],
  [1680, 1050, 2, "windows"],
];

const CALLER_WINDOW_FLAGS = ["--window-size", "--window-position", "--start-maximized"];

export interface Size { width: number; height: number }
export interface HeadlessGeometry { screen: Size; viewport: Size }
export type AppliedGeometry = { mode: "native" } | ({ mode: "corpus" } & HeadlessGeometry);

/** Whether Chromium owns initial window geometry for this launch. */
export function nativeDisplayActive(args?: readonly string[] | null): boolean {
  const names = new Set((args ?? []).map((arg) => String(arg).split("=", 1)[0]));
  return names.has("--fingerprint")
    || names.has("--fingerprint-profile")
    || (names.has("--fingerprint-avail-width") && names.has("--fingerprint-avail-height"));
}

/** Whether the caller supplied command-line window geometry. */
export function callerSizedTheWindow(args?: readonly string[] | null): boolean {
  return (args ?? []).some((arg) => CALLER_WINDOW_FLAGS.includes(String(arg).split("=", 1)[0]));
}

/** Default seed string for seedless calls. */
export const DEFAULT_HEADLESS_GEOMETRY_SEED = "ant0-headless-geometry";

/** Weighted-table point a seed maps to (full sha256 digest as a big integer, mod the total weight). */
export function headlessGeometryPoint(seed?: string | number | null): number {
  const key = seed === undefined || seed === null || seed === ""
    ? DEFAULT_HEADLESS_GEOMETRY_SEED : String(seed);
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  const total = HEADLESS_SCREEN_PROFILES.reduce((sum, row) => sum + row[2], 0);
  return Number(BigInt("0x" + digest) % BigInt(total));
}

function pick(seed?: string | number | null): readonly [number, number, number, string] {
  let point = headlessGeometryPoint(seed);
  for (const row of HEADLESS_SCREEN_PROFILES) {
    point -= row[2];
    if (point < 0) return row;
  }
  return HEADLESS_SCREEN_PROFILES[HEADLESS_SCREEN_PROFILES.length - 1];
}

export function headlessGeometry(seed?: string | number | null): HeadlessGeometry {
  const [width, height] = pick(seed);
  return {
    screen: { width, height },
    viewport: {
      width: width - ENGINE_FRAME_WIDTH,
      height: height - ENGINE_FRAME_HEIGHT,
    },
  };
}

/** Apply context defaults while leaving explicit caller context geometry untouched. */
export function applyHeadlessGeometry(
  opts: Record<string, unknown>,
  seed?: string | number | null,
  args?: readonly string[] | null,
): AppliedGeometry | null {
  if (opts.headless === false) return null;
  if ("viewport" in opts || "screen" in opts) return null;
  if (nativeDisplayActive(args)) {
    opts.viewport = null;
    return { mode: "native" };
  }
  const geom = headlessGeometry(seed);
  opts.screen = geom.screen;
  opts.viewport = geom.viewport;
  return { mode: "corpus", ...geom };
}

/** Place corpus headless windows at the origin before launch unless the caller chose geometry. */
export function initialWindowArgs(
  args: readonly string[] | null | undefined,
  appliedGeometry: AppliedGeometry | null,
): string[] {
  const result = [...(args ?? [])];
  if (appliedGeometry?.mode === "corpus" && !callerSizedTheWindow(result)) {
    result.push("--window-position=0,0");
  }
  return result;
}

export function geometryIsCoherent(
  screen: number[], avail: number[], inner: number[], outer: number[],
): boolean {
  return inner[0] <= outer[0] && inner[1] <= outer[1]
    && outer[0] <= avail[0] && outer[1] <= avail[1]
    && avail[0] <= screen[0] && avail[1] <= screen[1];
}
