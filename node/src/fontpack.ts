// Font pack (retired). Earlier versions could locate, download or cache a pack of real Windows
// fonts. Those fonts may not be redistributed, so the SDK no longer fetches, caches or applies any
// pack: Windows profiles on Linux use the bundled open look-alike fonts only. The exports below are
// kept so existing imports keep compiling; they do nothing.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** @deprecated Retired together with the font pack. */
export const PACK_VERSION = "windows-v1";
const FONT_EXTS = [".ttf", ".ttc", ".otf"];

/** @deprecated Always returns an empty string: the SDK no longer downloads a font pack. */
export function packUrl(): string {
  return "";
}

/**
 * @deprecated Always resolves to `undefined`. The SDK no longer downloads, caches or applies a
 * font pack, and `ANT0_BROWSER_FONT_PACK` is ignored; the bundled look-alike fonts are used.
 */
export async function resolveFontPack(_opts: { quiet?: boolean; download?: boolean } = {}): Promise<string | undefined> {
  return undefined;
}

/** Lower-cased family names in the pack (cached in families.txt; fc-scan once if missing). */
export function packFamilies(packDir?: string): Set<string> {
  if (!packDir) return new Set();
  const manifest = join(packDir, "families.txt");
  try {
    if (existsSync(manifest)) {
      return new Set(readFileSync(manifest, "utf8").split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean));
    }
  } catch { /* fall through to scan */ }
  const fams = new Set<string>();
  try {
    const files = readdirSync(packDir)
      .filter((n) => FONT_EXTS.includes(n.slice(n.lastIndexOf(".")).toLowerCase()))
      .map((n) => join(packDir, n));
    if (!files.length) return fams;
    const out = execFileSync("fc-scan", ["--format", "%{family}\n", ...files], { encoding: "utf8", timeout: 60000 });
    for (const line of out.split("\n")) for (const part of line.split(",")) {
      const p = part.trim().toLowerCase(); if (p) fams.add(p);
    }
    if (fams.size) writeFileSync(manifest, [...fams].sort().join("\n") + "\n");
  } catch { /* fc-scan unavailable */ }
  return fams;
}
