// Linux font wiring.
//
// The Linux release bundles metric-compatible font clones (Segoe UI->Selawik,
// Arial->Arimo, Times New Roman->Tinos, …) under `<binDir>/fonts/`, together with a
// self-contained `fonts.conf.template`. On a bare server/container the Windows families
// (and even the standard fontconfig metric-alias rules) are absent, so a page asking for
// "Segoe UI" collapses to a single default — a detectable render + an absent-font tell.
//
// At launch we materialize the template (substituting the real fonts dir + a writable
// cache dir) and point FONTCONFIG_FILE at it, so the clones resolve without depending on
// the host's /etc/fonts. No-op on non-Linux and on older binaries that ship no `fonts/`.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const RENDER_DEFAULTS =
  '  <match target="font"><edit name="antialias" mode="assign"><bool>true</bool></edit></match>\n' +
  '  <match target="font"><edit name="hinting" mode="assign"><bool>true</bool></edit></match>\n' +
  '  <match target="font"><edit name="hintstyle" mode="assign"><const>hintslight</const></edit></match>\n' +
  '  <match target="font"><edit name="rgba" mode="assign"><const>rgb</const></edit></match>\n' +
  '  <match target="font"><edit name="lcdfilter" mode="assign"><const>lcddefault</const></edit></match>\n';

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// A fontconfig that serves the REAL Windows fonts (correct metrics), clones as fallback; no forced
// Windows->clone substitution (so real Arial renders as real Arial).
function packConf(packDir: string, clonesDir: string, cacheDir: string): string {
  let dirs = `  <dir>${xml(packDir)}</dir>\n`;
  if (clonesDir && isDir(clonesDir)) dirs += `  <dir>${xml(clonesDir)}</dir>\n`;
  return '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n' + dirs +
    `  <cachedir>${xml(cacheDir)}</cachedir>\n` +
    '  <alias><family>sans-serif</family><prefer><family>Segoe UI</family><family>Arial</family></prefer></alias>\n' +
    '  <alias><family>serif</family><prefer><family>Times New Roman</family></prefer></alias>\n' +
    '  <alias><family>monospace</family><prefer><family>Consolas</family><family>Courier New</family></prefer></alias>\n' +
    '  <alias><family>system-ui</family><prefer><family>Segoe UI</family></prefer></alias>\n' +
    '  <alias><family>-webkit-standard</family><prefer><family>Segoe UI</family></prefer></alias>\n' +
    RENDER_DEFAULTS + "</fontconfig>\n";
}

/** Returns `{ FONTCONFIG_FILE }` on Linux — pack mode when `packDir` is given (real fonts), else
 *  clone mode from the bundled template. `{}` when there is nothing to wire. */
export function linuxFontEnv(exePath: string, packDir?: string): Record<string, string> {
  if (process.platform !== "linux") return {};
  const clonesDir = join(dirname(exePath), "fonts");
  const template = join(clonesDir, "fonts.conf.template");
  try {
    const cacheDir = join(tmpdir(), "ant0-fc-cache");
    mkdirSync(cacheDir, { recursive: true });
    if (packDir && isDir(packDir)) {
      const confPath = join(cacheDir, "fonts.pack.conf");
      writeFileSync(confPath, packConf(packDir, clonesDir, cacheDir));
      return { FONTCONFIG_FILE: confPath };
    }
    if (!existsSync(template)) return {};
    const conf = readFileSync(template, "utf8")
      .split("@FONTS_DIR@").join(clonesDir)
      .split("@CACHE_DIR@").join(cacheDir);
    const confPath = join(clonesDir, "fonts.generated.conf");
    writeFileSync(confPath, conf);
    return { FONTCONFIG_FILE: confPath };
  } catch {
    return {}; // never block a launch on font wiring
  }
}

type EnvMap = { [key: string]: string | undefined };

/**
 * Build the `env` to pass to Playwright's launch so the bundled fonts resolve.
 * Merges process.env (Playwright replaces the env when `env` is set, so we must include it),
 * the bundled-font FONTCONFIG_FILE, then any caller-supplied `env` (caller wins).
 * Returns `undefined` when there is nothing to add (preserve Playwright's default env).
 */
export function fontLaunchEnv(exePath: string, userEnv?: EnvMap, packDir?: string): EnvMap | undefined {
  const fontEnv = linuxFontEnv(exePath, packDir);
  if (Object.keys(fontEnv).length === 0 && !userEnv) return undefined;
  return { ...process.env, ...fontEnv, ...(userEnv ?? {}) };
}
