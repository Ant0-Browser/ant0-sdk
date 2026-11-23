/**
 * Single source of truth for the Chromium version this SDK targets.
 *
 * The SDK ships as a standalone package, so the pinned Chromium version is a constant here.
 * It is updated together with each engine release.
 */

/** Full pinned Chromium version, e.g. `"154.0.8037.57"`. */
export const CHROMIUM_VERSION = "158.0.8127.18";

/** Major of {@link CHROMIUM_VERSION}, e.g. `154`. The identity contract's `browser_major`. */
export const CHROMIUM_MAJOR = 158;

/** The UA-reduction form Chromium reports, e.g. `"154.0.0.0"`. */
export const CHROMIUM_UA_VERSION = "158.0.0.0";
