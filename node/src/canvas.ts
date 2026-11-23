/**
 * Canvas mode per profile, and the per-profile canvas noise key.
 *
 * Two modes:
 *   real   this computer's genuine canvas output. Every profile on this computer shows the same
 *          canvas result. This is the default.
 *   noise  a canvas result that is unique to the profile, stable across launches and across sites.
 *          Needs a 16-hex key; the engine takes it as `--fingerprint-noise-key=<key>`.
 *
 * Mapping of the options onto the mode (`canvasMode`):
 *
 *   canvas        canvasNoise   fingerprintNoise   mode
 *   "real"        any           any                real
 *   "noise"       any           any                noise (the key is required)
 *   unset         any           any                real
 *
 * Only `canvas: "noise"` selects noise. The legacy `canvasNoise` and `fingerprintNoise` flags never do:
 * on earlier releases `true` sent nothing and `false` sent `--disable-canvas-noise` /
 * `--disable-fingerprint-noise`, and a profile that already existed must not change its fingerprint on
 * upgrade. They keep exactly that behaviour; `true` now also gets the `canvas-noise-no-key` warning.
 */

import { createHash, randomBytes } from "node:crypto";
import { SdkInputError } from "./errors.js";

/** The engine switch that carries the key. One constant so the spelling is a one-line change. */
export const CANVAS_NOISE_KEY_SWITCH = "--fingerprint-noise-key";
/** The key is exactly this many lowercase hex characters (8 bytes), with no 0x prefix. */
export const CANVAS_NOISE_KEY_LENGTH = 16;
/** Domain separator for the key derived for older identity files (v1 and v2 wrappers), which store none. */
export const CANVAS_NOISE_KEY_DOMAIN = "ant0/canvas-noise-key/v1\0";

export type CanvasMode = "real" | "noise";
const KEY_RE = /^[0-9a-f]{16}$/;

export interface CanvasOptions {
  canvas?: CanvasMode;
  canvasNoise?: boolean;
  fingerprintNoise?: boolean;
}

/** True when `value` is a valid canvas noise key: 16 lowercase hex characters. */
export function isCanvasNoiseKey(value: unknown): value is string {
  return typeof value === "string" && KEY_RE.test(value);
}

/** Throw unless `canvas` is undefined, "real" or "noise". */
export function assertCanvasOption(canvas: unknown): void {
  if (canvas !== undefined && canvas !== "real" && canvas !== "noise") {
    throw new SdkInputError("sdk.canvas_invalid", 'canvas must be "real" or "noise"');
  }
}

/** Throw unless `key` is undefined or a valid canvas noise key. */
export function assertCanvasNoiseKey(key: unknown): void {
  if (key !== undefined && !isCanvasNoiseKey(key)) {
    throw new SdkInputError("sdk.canvas_invalid", "canvasNoiseKey must be 16 lowercase hex characters");
  }
}

/** Resolve the canvas mode from the options (see the table at the top of this file). */
export function canvasMode(o: CanvasOptions): CanvasMode {
  assertCanvasOption(o.canvas);
  if (o.canvas !== undefined) return o.canvas;
  return "real";
}

/** A fresh random canvas noise key (CSPRNG, 8 bytes as 16 lowercase hex). */
export function newCanvasNoiseKey(): string {
  return randomBytes(8).toString("hex");
}

/** The key for an identity stored without one: the first 8 bytes of
 * SHA-256("ant0/canvas-noise-key/v1\0" + identityKey), as 16 lowercase hex.
 * `identityKey` is the string the caller gave as `identity.key` (the daemon: the profile's
 * identity key); it is hashed as UTF-8. */
export function deriveCanvasNoiseKey(identityKey: string): string {
  if (typeof identityKey !== "string") {
    throw new SdkInputError("sdk.canvas_invalid", "identityKey must be a string");
  }
  return createHash("sha256").update(CANVAS_NOISE_KEY_DOMAIN, "utf8").update(identityKey, "utf8")
    .digest().subarray(0, 8).toString("hex");
}

/** The canvas noise key of a persisted identity: its stored `canvas_noise_key`, else the key derived
 * from `identityKey`. The wrapper does not record the identity key (its file name is an HMAC of it),
 * so the caller passes it. */
export function canvasNoiseKeyFor(
  persisted: { canvas_noise_key?: string } | null | undefined, identityKey: string,
): string {
  const stored = persisted?.canvas_noise_key;
  if (stored !== undefined) {
    if (!isCanvasNoiseKey(stored)) {
      throw new SdkInputError("sdk.canvas_invalid", "stored canvas_noise_key is not 16 lowercase hex characters");
    }
    return stored;
  }
  return deriveCanvasNoiseKey(identityKey);
}
