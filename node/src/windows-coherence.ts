/** Windows persona coherence rules for the local population-model generator (parity with
 * python/ant0browser/_windows_coherence.py and with the cloud generators).
 *
 * Both rules come from tells a page can read without any permission:
 *  - ANGLE writes the PCI device id into the WebGL renderer string as `0x` plus exactly 8 hex digits
 *    (`ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)`). A
 *    renderer without it cannot come from a real Chrome on Windows.
 *  - A generated Windows persona claims Windows 11, whose taskbar is 48 CSS px tall, at the bottom (or
 *    absent when it auto-hides): `availWidth` equals `width`, and `height - availHeight` is 48 or 0. A
 *    side taskbar is a Windows 10 tell.
 * The generator only draws rows that satisfy both: a graphics row without an id is not drawn (ids are
 * never made up), a display row with another work area is normalised to a 48 px bottom taskbar. */

const ANGLE_DEVICE_ID = /\(0x[0-9A-Fa-f]{8}\)/;

/** The Windows 11 taskbar height in CSS px (100, 125 and 150 % scaling). */
export const WIN11_TASKBAR_PX = 48;

/** Whether a WebGL renderer string carries ANGLE's 8-digit device id. */
export function hasAngleDeviceId(renderer: unknown): boolean {
  return typeof renderer === "string" && ANGLE_DEVICE_ID.test(renderer);
}

/** Whether the screen/available height gap is a Windows 11 taskbar: 48 px, or 0 (auto-hidden). */
export function isWin11TaskbarGap(height: unknown, availHeight: unknown): boolean {
  if (typeof height !== "number" || typeof availHeight !== "number") return false;
  const gap = height - availHeight;
  return gap === WIN11_TASKBAR_PX || gap === 0;
}

/** Whether a screen's work area is a Windows 11 one: a full-width bottom taskbar of 48 px, or none. */
export function isWin11Screen(s: {
  width: unknown; height: unknown; availWidth: unknown; availHeight: unknown;
}): boolean {
  return typeof s.width === "number" && s.availWidth === s.width
    && isWin11TaskbarGap(s.height, s.availHeight);
}

/** Whether a display row of the population model passes the Windows 11 screen rule. */
export function isWin11DisplayRow(payload: Record<string, any>): boolean {
  return isWin11Screen({
    width: payload.width,
    height: payload.height,
    availWidth: payload.available_width,
    availHeight: payload.available_height,
  });
}

/**
 * The Windows 11 form of a display row. The screen size and its weight are never touched: only the
 * work area is normalised, so the size mix of the model survives.
 *  - already a full-width bottom 48 px taskbar, or none at all (genuine auto-hide): returned as is;
 *  - anything else (another gap, a side or top taskbar): a bottom taskbar of exactly 48 CSS px,
 *    `available_width = width`, `available_height = height - 48`.
 * Returns undefined only for a row with no numeric size or a screen too short to hold a taskbar. */
export function normaliseWin11DisplayRow<T extends Record<string, any>>(payload: T): T | undefined {
  const { width, height } = payload;
  if (typeof width !== "number" || typeof height !== "number" || height <= WIN11_TASKBAR_PX) {
    return undefined;
  }
  if (isWin11DisplayRow(payload)) return payload;
  return { ...payload, available_width: width, available_height: height - WIN11_TASKBAR_PX };
}
