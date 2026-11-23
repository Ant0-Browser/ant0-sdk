// Local build metadata used for cache lookup and compatibility warnings.

import { CHROMIUM_VERSION } from "./chromium-version.js";

/**
 * minisign public key that signs every published Ant0 Browser release (SHA256SUMS.txt.minisig).
 * Downloads are refused unless the signature verifies against this key. The private key lives
 * only on the release build server. Rotating it requires an SDK release.
 */
export const RELEASE_PUBLIC_KEY = "RWTvXmwMqczy1xMs5KJs+qS9x7LmikRzIX+la3WGmWIFEKvQvR1JW8d9";
export interface ReleaseInfo {
  tag: string;
  version: string;
  os: NodeJS.Platform;
  binary: string;
}

const WINDOWS: ReleaseInfo = {
  tag: `ant0-m${CHROMIUM_VERSION}`,
  version: CHROMIUM_VERSION,
  os: "win32",
  binary: "chrome.exe",
};
const LINUX: ReleaseInfo = {
  tag: `ant0-m${CHROMIUM_VERSION}`,
  version: CHROMIUM_VERSION,
  os: "linux",
  binary: "chrome",
};

export const PLATFORMS: Record<string, ReleaseInfo> = { win32: WINDOWS, linux: LINUX };

export function platformRelease(plat: NodeJS.Platform | string = process.platform): ReleaseInfo | undefined {
  return PLATFORMS[plat];
}

export const RELEASE: ReleaseInfo = platformRelease() ?? WINDOWS;
