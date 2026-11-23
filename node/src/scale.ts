// Persona scale (see `personaDpr` in ./fingerprint.ts): the pieces around `--force-device-scale-factor`.
//
//  - A Playwright `viewport` emulates scale 1 and breaks the match, so a caller viewport gets the
//    persona's `deviceScaleFactor` unless it set its own.
//  - The engine sizes the window from the persona in CSS px and the flag multiplies it, so a persona
//    scale above the real display's draws wider than the screen. A headed window is clamped to the
//    real display divided by the scale.
//
// Mirror of the Python ant0browser/_scale.py.

import { spawnSync } from "node:child_process";

export interface DisplaySize { width: number; height: number }

const WINDOW_FLAGS = ["--window-size", "--start-maximized", "--start-fullscreen", "--kiosk"];
const POSITION_FLAG = "--window-position";

/** Physical pixels left free on each axis when the SDK sizes the window to the display. Chromium's
 * `--window-size` sets the OUTER window (frame and borders included) in DIP, and Windows runs
 * ended 1-2 px over at 125%/150% (1402x902, 1401x900 on 1400x900) because of rounding and the frame.
 * 8 px absorbs that without a visible gap. */
export const WINDOW_MARGIN = 8;

/** Add `deviceScaleFactor` to context options that carry a viewport but no scale of their own. */
export function withDeviceScale<T extends Record<string, unknown>>(o: T, dpr: number | undefined): T {
  if (dpr === undefined) return o;
  if (!o.viewport || typeof o.viewport !== "object") return o; // null or absent: no emulation
  if (o.deviceScaleFactor !== undefined) return o;
  return { ...o, deviceScaleFactor: dpr };
}

function parseSize(w: string, h: string): DisplaySize | undefined {
  const width = Number(w), height = Number(h);
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : undefined;
}

/** `ANT0_DISPLAY_SIZE=WIDTHxHEIGHT` (real pixels) wins; otherwise the X11 screen on Linux. Windows and
 * macOS are not detected: the caller (the app) passes `--window-size` there. Cached; never throws. */
export function parseDisplaySize(text: string): DisplaySize | undefined {
  const m = /current\s+(\d+)\s*x\s*(\d+)/.exec(text) ?? /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(text);
  return m ? parseSize(m[1], m[2]) : undefined;
}

let cachedDisplay: DisplaySize | null | undefined;
export function detectDisplaySize(platform: string = process.platform): DisplaySize | undefined {
  const env = /^(\d+)x(\d+)$/i.exec((process.env.ANT0_DISPLAY_SIZE ?? "").trim());
  if (env) return parseSize(env[1], env[2]);
  if (platform !== "linux" || !process.env.DISPLAY) return undefined;
  if (cachedDisplay !== undefined) return cachedDisplay ?? undefined;
  cachedDisplay = null;
  for (const [cmd, args] of [["xrandr", ["--current"]], ["xdpyinfo", []]] as const) {
    try {
      const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: 2000 });
      const size = r.status === 0 ? parseDisplaySize(r.stdout) : undefined;
      if (size) { cachedDisplay = size; break; }
    } catch { /* tool missing */ }
  }
  return cachedDisplay ?? undefined;
}

/** `--window-size` (CSS px) that keeps a headed window on a display of `display` real pixels at scale
 * `dpr` (any positive dpr, 1 and below included), or undefined when no clamp is needed. `persona` is
 * the persona's own available size. Sizes round down (floor) and leave `WINDOW_MARGIN` physical px
 * free, so CSS size x dpr never exceeds the display. */
export function clampedWindowSize(
  dpr: number, display: DisplaySize | undefined, persona?: Partial<DisplaySize>,
): DisplaySize | undefined {
  if (!display || !Number.isFinite(dpr) || !(dpr > 0)) return undefined;
  const maxW = Math.max(1, Math.floor((display.width - WINDOW_MARGIN) / dpr));
  const maxH = Math.max(1, Math.floor((display.height - WINDOW_MARGIN) / dpr));
  const width = Math.min(maxW, persona?.width ?? Infinity);
  const height = Math.min(maxH, persona?.height ?? Infinity);
  const fits = persona?.width !== undefined && persona?.height !== undefined
    && persona.width <= maxW && persona.height <= maxH;
  return fits ? undefined : { width, height };
}

/** Clamp the SDK's own window size for a headed launch at persona scale `dpr`. Takes the SDK-built
 * args (before the caller's `args` are appended, so a caller's own `--window-size` still wins) and
 * `callerArgs` only to see whether the caller sized or maximised the window. An existing
 * `--window-size` in `sdkArgs` (the Android phone size) is the persona size to clamp; else
 * `persona`, the persona's available screen. When it clamps, it also adds `--window-position=0,0`
 * (the window would otherwise sit at an OS-chosen offset and run past the right edge) unless the
 * caller or `sdkArgs` already position the window. */
export function scaleWindowArgs(
  sdkArgs: readonly string[], dpr: number | undefined, headed: boolean,
  persona?: Partial<DisplaySize>, callerArgs: readonly string[] = [],
  display: DisplaySize | undefined = headed ? detectDisplaySize() : undefined,
): string[] {
  const out = [...sdkArgs];
  if (!headed || dpr === undefined) return out;
  const flagOf = (a: unknown) => String(a).split("=", 1)[0];
  if (callerArgs.some((a) => WINDOW_FLAGS.includes(flagOf(a)) || flagOf(a) === POSITION_FLAG)) return out;
  let own: Partial<DisplaySize> | undefined;
  for (const a of out) {
    const m = /^--window-size=(\d+),(\d+)$/.exec(String(a));
    if (m) own = { width: Number(m[1]), height: Number(m[2]) };
  }
  const size = clampedWindowSize(dpr, display, own ?? persona);
  if (!size) return out;
  const kept = out.filter((a) => !String(a).startsWith("--window-size="));
  kept.push(`--window-size=${size.width},${size.height}`);
  if (!kept.some((a) => flagOf(a) === POSITION_FLAG)) kept.push(`${POSITION_FLAG}=0,0`);
  return kept;
}
