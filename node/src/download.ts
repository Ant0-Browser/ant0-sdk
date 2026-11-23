// Offline Ant0 Browser binary discovery and install-integrity helpers.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { platformRelease } from "./release.js";
import { SdkError } from "./errors.js";

const ANT0_CAPABILITY = Buffer.from("ant0-browser-capabilities/persona-profile-v1");
const capabilityChecked = new Set<string>();

/** Whether the file carries the marker. Throws when it cannot be read (EBUSY, EACCES, a scan holding a lock):
 * that says nothing about the binary, so it must never be taken for "not an Ant0 engine". */
function containsCapability(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const block = Buffer.allocUnsafe(1024 * 1024);
    let previous = Buffer.alloc(0);
    for (;;) {
      const count = readSync(fd, block, 0, block.length, null);
      if (!count) return false;
      const data = Buffer.concat([previous, block.subarray(0, count)]);
      if (data.indexOf(ANT0_CAPABILITY) !== -1) return true;
      previous = data.subarray(Math.max(0, data.length - ANT0_CAPABILITY.length + 1));
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Whether the binary (or its chrome.dll) carries the Ant0 capability marker. Reads the file; a positive answer is cached. Throws when the path cannot be read. */
export function isAnt0Binary(exe: string): boolean {
  const resolved = realpathSync(exe);
  const sibling = path.join(path.dirname(resolved), "chrome.dll");
  const files = [resolved, ...(existsSync(sibling) ? [sibling] : [])];
  const identity = files.map((file) => {
    const stat = statSync(file, { bigint: true });
    return `${file}:${stat.size}:${stat.mtimeNs}`;
  }).join("|");
  if (capabilityChecked.has(identity)) return true;
  if (!files.some(containsCapability)) return false;
  capabilityChecked.add(identity);
  return true;
}

export function incompatibleBinaryError(exe: string): Error {
  return new Error(
    `The selected executable is not a compatible Ant0 Browser build:\n    ${exe}\n` +
      "Required SDK capability persona-profile-v1 was not found. " +
      "Refusing to launch arbitrary Chrome/Chromium.",
  );
}

export interface DownloadOptions {
  /** Override the legacy local cache directory. No network access is performed. */
  cacheDir?: string;
  /** Suppress cache diagnostics. */
  quiet?: boolean;
}

function defaultCacheRoot(): string {
  if (process.env.ANT0_BROWSER_CACHE) return process.env.ANT0_BROWSER_CACHE;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ant0-browser", "Cache");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ant0-browser");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ant0-browser");
}

function findFile(dir: string, name: string): string | null {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.name.toLowerCase() === name.toLowerCase()) return target;
    }
  }
  return null;
}

export const MANIFEST = ".manifest.json";
const CRITICAL_FILES = {
  win32: ["chrome.exe", "chrome.dll", "chrome_elf.dll", "icudtl.dat", "snapshot_blob.bin", "resources.pak"],
  other: ["icudtl.dat", "snapshot_blob.bin", "resources.pak"],
};
const scanned = new Set<string>();

function criticalNames(): string[] {
  return CRITICAL_FILES[process.platform === "win32" ? "win32" : "other"];
}

export function writeManifest(base: string, browserDir: string): void {
  const files: Record<string, number> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else files[path.relative(browserDir, target).split(path.sep).join("/")] = statSync(target).size;
    }
  };
  try {
    walk(browserDir);
    mkdirSync(base, { recursive: true });
    writeFileSync(path.join(base, MANIFEST), JSON.stringify({ files }));
  } catch { /* a manifest is an optimization */ }
}

function checkNames(browserDir: string, names: string[], sizes: Record<string, number> = {}): string[] {
  const problems: string[] = [];
  for (const name of names) {
    const target = path.join(browserDir, ...name.split("/"));
    if (!existsSync(target)) {
      problems.push(`${name} — missing`);
      continue;
    }
    const got = statSync(target).size;
    const want = sizes[name];
    if (want !== undefined && got !== want) problems.push(`${name} — ${got} bytes, expected ${want}`);
    else if (want === undefined && got === 0) problems.push(`${name} — empty (0 bytes)`);
  }
  return problems;
}

export function verifyInstall(browserDir: string, base?: string, full?: boolean): string[] {
  let problems = checkNames(browserDir, criticalNames());
  if (problems.length) return problems;
  const manifest = path.join(base ?? path.dirname(browserDir), MANIFEST);
  const key = path.resolve(browserDir).toLowerCase();
  if (full === false || (full === undefined && scanned.has(key)) || !existsSync(manifest)) return problems;
  try {
    const sizes = (JSON.parse(readFileSync(manifest, "utf8")) as { files?: Record<string, number> }).files ?? {};
    problems = checkNames(browserDir, Object.keys(sizes), sizes);
    if (!problems.length) scanned.add(key);
  } catch { /* ignore an unreadable optional manifest */ }
  return problems;
}

export function brokenInstallError(browserDir: string, problems: string[], repairable = true): Error {
  const shown = problems.slice(0, 8).map((problem) => `    ${problem}`).join("\n");
  const more = problems.length > 8 ? `\n    ... and ${problems.length - 8} more` : "";
  const fix = repairable
    ? `Delete the damaged local cache folder and point the SDK at a complete local build:\n    ${path.dirname(browserDir)}`
    : "Re-create this browser directory from a complete local build.";
  return new Error(
    `Ant0 Browser browser install is incomplete or corrupted:\n    ${browserDir}\n${shown}${more}\n\n${fix}\n` +
      "Set executablePath or ANT0_BROWSER_BINARY to the resulting chrome executable.\n" +
      "Common causes include antivirus quarantine, a full disk, or an interrupted copy.",
  );
}

export function checkInstall(exe: string): void {
  if (!exe || !existsSync(exe) || !statSync(exe).isFile() || !isAnt0Binary(exe)) {
    throw incompatibleBinaryError(exe);
  }
  const browserDir = path.dirname(path.resolve(exe));
  const payload = criticalNames().filter((name) => !name.toLowerCase().startsWith("chrome.ex"));
  if (!payload.some((name) => existsSync(path.join(browserDir, name)))) return;
  const problems = verifyInstall(browserDir);
  if (problems.length) throw brokenInstallError(browserDir, problems, false);
}

export function cachedBinary(base: string, binary: string, quiet?: boolean): string | null {
  if (!existsSync(path.join(base, ".verified"))) return null;
  const browserDir = path.join(base, "browser");
  const cached = findFile(browserDir, binary);
  if (!cached) return null;
  let ant0: boolean;
  try { ant0 = isAnt0Binary(cached); } catch { return null; } // unreadable right now: not proof that it is foreign, nothing is deleted
  if (!ant0) {
    rmSync(browserDir, { recursive: true, force: true });
    rmSync(path.join(base, ".verified"), { force: true });
    rmSync(path.join(base, MANIFEST), { force: true });
    return null;
  }
  const problems = verifyInstall(browserDir, base);
  if (!problems.length) return cached;
  if (!quiet) process.stderr.write(`[ant0-browser] cached browser is damaged (${problems[0]}); removing it\n`);
  rmSync(browserDir, { recursive: true, force: true });
  rmSync(path.join(base, ".verified"), { force: true });
  rmSync(path.join(base, MANIFEST), { force: true });
  return null;
}

/**
 * Return the pinned-cache binary, installing it from a release store only when opted in.
 *
 * Without ANT0_BROWSER_RELEASE_URL this never touches the network. With it, a missing cache is
 * filled from that store after the release signature and hashes verify; an existing cache is
 * always used as-is (updates are an explicit action, see `installRelease`).
 */
export async function ensureBinary(opts: DownloadOptions = {}): Promise<string> {
  const release = platformRelease();
  const base = release ? path.join(opts.cacheDir || defaultCacheRoot(), release.tag) : undefined;
  if (release && base) {
    const cached = cachedBinary(base, release.binary, opts.quiet);
    if (cached) return cached;
  }
  const releaseUrl = process.env.ANT0_BROWSER_RELEASE_URL;
  if (releaseUrl && base) {
    const { installRelease } = await import("./release-fetch.js");
    const exe = await installRelease(releaseUrl, base, {
      quiet: opts.quiet,
      version: process.env.ANT0_BROWSER_RELEASE_VERSION || undefined,
      channel: process.env.ANT0_BROWSER_RELEASE_CHANNEL || undefined,
    });
    checkInstall(exe);
    return exe;
  }
  throw new SdkError("sdk.engine_not_found", 
    "No local Ant0 Browser binary was found. Build the browser first, then pass executablePath or " +
      "set ANT0_BROWSER_BINARY to chrome/chrome.exe. To install a published release instead, set " +
      "ANT0_BROWSER_RELEASE_URL to your release store.",
  );
}
