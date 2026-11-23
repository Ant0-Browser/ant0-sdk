// Fetch, verify, and install a published Ant0 Browser release.
//
// Opt-in: nothing here runs unless ANT0_BROWSER_RELEASE_URL is set (or installRelease is called
// explicitly). The base URL points at a release store laid out by scripts/publish_release.py:
//
//   <base>/channels/<channel>.json                  -> which version a channel currently serves
//   <base>/releases/<version>/manifest.json
//   <base>/releases/<version>/SHA256SUMS.txt
//   <base>/releases/<version>/SHA256SUMS.txt.minisig
//   <base>/releases/<version>/<target>/<archive>
//
// Trust chain: SHA256SUMS.txt is verified against the minisign public key embedded in this SDK
// (RELEASE_PUBLIC_KEY); the manifest and the archive are then verified against the hashes it
// lists. Anything served by the store is untrusted until that chain closes.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { RELEASE_PUBLIC_KEY, platformRelease } from "./release.js";
import type { ErrorClass } from "./errors.js";

export const USER_AGENT = "ant0-browser-sdk/node";
export const CHANNEL_SCHEMA = "ant0-release-channel/v1";
export const MANIFEST_SCHEMA = "ant0-release-manifest/v1";
export const TARGET_FOR_PLATFORM: Record<string, string> = { win32: "windows-x64", linux: "linux-x64" };

export class ReleaseError extends Error {
  readonly code: string = "sdk.release_failed";
  readonly errorClass: ErrorClass = "environment";
}
export class SignatureError extends ReleaseError {
  override readonly code: string = "sdk.release_signature_invalid";
}

// ---------------------------------------------------------------------------------------------
// minisign
// ---------------------------------------------------------------------------------------------

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519Verify(publicKey: Buffer, signature: Buffer, message: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: "der", type: "spki" });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function parseMinisignPublicKey(text: string): { keyId: Buffer; publicKey: Buffer } {
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const encoded = lines[lines.length - 1] ?? "";
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw new SignatureError("minisign public key is not valid base64");
  const raw = Buffer.from(encoded, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new SignatureError("unrecognized minisign public key format");
  }
  return { keyId: raw.subarray(2, 10), publicKey: raw.subarray(10) };
}

/** Verify a minisign signature file over `message`. Returns the trusted comment; throws on failure. */
export function verifyMinisign(message: Buffer, signatureText: string, publicKeyText: string): string {
  const { keyId, publicKey } = parseMinisignPublicKey(publicKeyText);
  const lines = signatureText.split(/\r?\n/);
  if (lines.length < 4) throw new SignatureError("minisign signature file is truncated");
  const sigBlob = Buffer.from(lines[1].trim(), "base64");
  const globalSig = Buffer.from(lines[3].trim(), "base64");
  if (sigBlob.length !== 74 || globalSig.length !== 64) throw new SignatureError("minisign signature has unexpected length");
  const alg = sigBlob.subarray(0, 2).toString("latin1");
  if (!sigBlob.subarray(2, 10).equals(keyId)) throw new SignatureError("signature was made with a different key than the SDK trusts");
  const signature = sigBlob.subarray(10);
  let signed: Buffer;
  if (alg === "ED") signed = createHash("blake2b512").update(message).digest();
  else if (alg === "Ed") signed = message;
  else throw new SignatureError("unsupported minisign algorithm");
  if (!ed25519Verify(publicKey, signature, signed)) {
    throw new SignatureError("SHA256SUMS.txt signature does not verify: the release is not authentic");
  }
  const prefix = "trusted comment: ";
  if (!lines[2].startsWith(prefix)) throw new SignatureError("minisign trusted comment missing");
  const trusted = lines[2].slice(prefix.length);
  if (!ed25519Verify(publicKey, globalSig, Buffer.concat([signature, Buffer.from(trusted, "utf8")]))) {
    throw new SignatureError("minisign trusted comment signature does not verify");
  }
  return trusted;
}

export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf("  ");
    if (idx !== 64) throw new ReleaseError("malformed SHA256SUMS.txt");
    out[line.slice(idx + 2).trim()] = line.slice(0, 64).toLowerCase();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------

function join(base: string, rel: string): string {
  return base.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

function request(url: string, onResponse: (res: import("node:http").IncomingMessage) => void, reject: (e: Error) => void, hops = 0): void {
  const getter = url.startsWith("http://") ? httpGet : httpsGet;
  getter(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
    const code = res.statusCode ?? 0;
    if (code >= 300 && code < 400 && res.headers.location && hops < 5) {
      res.resume();
      request(new URL(res.headers.location, url).toString(), onResponse, reject, hops + 1);
      return;
    }
    if (code !== 200) {
      res.resume();
      reject(new ReleaseError(`${url}: HTTP ${code}`));
      return;
    }
    onResponse(res);
  }).on("error", (e) => reject(new ReleaseError(`${url}: ${e.message}`)));
}

export function fetchBytes(url: string, limit = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) { res.destroy(); reject(new ReleaseError(`${url}: response larger than ${limit} bytes`)); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", (e) => reject(new ReleaseError(`${url}: ${e.message}`)));
    }, reject);
  });
}

async function fetchJson(url: string): Promise<any> {
  try {
    return JSON.parse((await fetchBytes(url)).toString("utf8"));
  } catch (e) {
    if (e instanceof ReleaseError) throw e;
    throw new ReleaseError(`${url}: not valid JSON`);
  }
}

export async function resolveRelease(baseUrl: string, version?: string, channel?: string): Promise<{ version: string; prefix: string }> {
  if (!version) {
    const name = channel || process.env.ANT0_BROWSER_RELEASE_CHANNEL || "stable";
    const doc = await fetchJson(join(baseUrl, `channels/${name}.json`));
    if (doc?.schema !== CHANNEL_SCHEMA || typeof doc?.version !== "string") {
      throw new ReleaseError(`channel '${name}' document is not a recognized Ant0 release channel`);
    }
    version = doc.version as string;
  }
  return { version, prefix: join(baseUrl, `releases/${version}`) };
}

/** Progress of one `installRelease` phase. For `extract`, `bytes`/`total` count archive entries. */
export interface InstallProgress {
  phase: "download" | "verify" | "extract";
  bytes: number;
  /** 0 when unknown (no Content-Length). */
  total: number;
}

export type InstallProgressCallback = (progress: InstallProgress) => void;

/** Minimum spacing between two progress callbacks of one phase (≤ 4 events/s). */
export const PROGRESS_INTERVAL_MS = 250;

/**
 * Rate-limits a progress callback to one call per `PROGRESS_INTERVAL_MS`, except that the first
 * report and a report that completes the phase (`bytes >= total > 0`, or `flush()`) always go out.
 * Callback exceptions never break the install.
 */
export function throttleProgress(
  cb: InstallProgressCallback | undefined,
  phase: InstallProgress["phase"],
  now: () => number = Date.now,
): { report(bytes: number, total: number): void; flush(): void } {
  if (!cb) return { report: () => {}, flush: () => {} };
  let last = -Infinity;
  let pending: InstallProgress | undefined;
  const emit = (p: InstallProgress) => {
    last = now();
    pending = undefined;
    try { cb(p); } catch { /* a listener must not abort the install */ }
  };
  return {
    report(bytes, total) {
      const p: InstallProgress = { phase, bytes, total };
      const complete = total > 0 && bytes >= total;
      if (complete || now() - last >= PROGRESS_INTERVAL_MS) emit(p);
      else pending = p;
    },
    flush() {
      if (pending) emit(pending);
    },
  };
}

function downloadTo(url: string, dest: string, expectedSha256: string, log: (m: string) => void, onProgress?: InstallProgressCallback): Promise<void> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      const hash = createHash("sha256");
      const total = Number(res.headers["content-length"]) || 0;
      let done = 0;
      let nextReport = 0;
      const progress = throttleProgress(onProgress, "download");
      progress.report(0, total);
      const out = createWriteStream(dest);
      res.on("data", (c: Buffer) => {
        hash.update(c);
        done += c.length;
        progress.report(done, total);
        if (total && done >= nextReport) { log(`downloading ${path.basename(url)}: ${Math.floor((done * 100) / total)}%`); nextReport += Math.max(Math.floor(total / 10), 1); }
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => {
        progress.report(done, total || done);
        progress.flush();
        if (hash.digest("hex") !== expectedSha256.toLowerCase()) {
          reject(new ReleaseError(`${path.basename(url)}: SHA-256 mismatch after download; refusing to install`));
        } else resolve();
      }));
      out.on("error", (e) => reject(new ReleaseError(e.message)));
      res.on("error", (e) => reject(new ReleaseError(e.message)));
    }, reject);
  });
}

function safeTarget(dest: string, name: string): string {
  const root = path.resolve(dest);
  const target = path.resolve(dest, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new ReleaseError(`archive entry escapes destination: ${name}`);
  return target;
}

/** Unpack a `.zip` or `.tar.xz` into `dest`. Progress (`phase: "extract"`) counts archive entries. */
export async function extractArchive(archive: string, dest: string, onProgress?: InstallProgressCallback): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const progress = throttleProgress(onProgress, "extract");
  if (archive.endsWith(".zip")) {
    const unzipper = await import("unzipper");
    const dir = await unzipper.Open.file(archive);
    const total = dir.files.length;
    let done = 0;
    progress.report(0, total);
    for (const entry of dir.files) {
      const target = safeTarget(dest, entry.path);
      if (entry.type === "Directory") mkdirSync(target, { recursive: true });
      else {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, await entry.buffer());
      }
      progress.report(++done, total);
    }
    progress.flush();
    return;
  }
  if (archive.endsWith(".tar.xz") || archive.endsWith(".txz")) {
    const list = spawnSync("tar", ["-tJf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (list.status !== 0) throw new ReleaseError(`tar failed to read the archive (is xz installed?): ${list.stderr}`);
    const names = list.stdout.split("\n").filter(Boolean);
    for (const name of names) safeTarget(dest, name);
    const total = names.length;
    progress.report(0, total);
    // `-v` prints one line per extracted entry (stdout on GNU tar, stderr on bsdtar); count them.
    await new Promise<void>((resolve, reject) => {
      const run = spawn("tar", ["-xvJf", archive, "-C", dest, "--no-same-owner"]);
      let done = 0;
      let stderr = "";
      const count = (chunk: Buffer) => {
        const lines = chunk.toString("utf8").split("\n").filter(Boolean).length;
        done = Math.min(total, done + lines);
        progress.report(done, total);
      };
      run.stdout.on("data", count);
      run.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); count(chunk); });
      run.on("error", (e) => reject(new ReleaseError(`tar extraction failed: ${e.message}`)));
      run.on("close", (status) => {
        if (status !== 0) { reject(new ReleaseError(`tar extraction failed: ${stderr.trim().split("\n").slice(-5).join("\n")}`)); return; }
        progress.report(total, total);
        progress.flush();
        resolve();
      });
    });
    return;
  }
  throw new ReleaseError(`unsupported archive type: ${archive}`);
}

function findBinary(root: string, name: string): string | undefined {
  const want = name.toLowerCase();
  const stack = [root];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.name.toLowerCase() === want) return target;
    }
  }
  return undefined;
}

export interface InstallReleaseOptions {
  version?: string;
  channel?: string;
  target?: string;
  quiet?: boolean;
  /** Defaults to the key embedded in this SDK; exists only so tests can substitute a test key. */
  publicKey?: string;
  expectedChromium?: string;
  /**
   * Progress callback: `download` streams Content-Length-based byte counts (≤ 4 calls/s), `verify`
   * fires once when the downloaded archive's SHA-256 matched, `extract` counts archive entries.
   * Exceptions thrown by the callback are ignored.
   */
  onProgress?: InstallProgressCallback;
  /** Recorded as `.release.json#source` instead of `baseUrl` (e.g. when bytes flow through a local relay). */
  sourceLabel?: string;
}

/**
 * Download, verify, and unpack a release into `<installBase>/browser`. Returns the executable path.
 * `installBase` is the per-release cache directory (`<cache>/<release.tag>`).
 */
export async function installRelease(baseUrl: string, installBase: string, opts: InstallReleaseOptions = {}): Promise<string> {
  const { writeManifest } = await import("./download.js");
  const log = (m: string) => { if (!opts.quiet) process.stderr.write(`[ant0-browser] ${m}\n`); };
  const publicKey = opts.publicKey || RELEASE_PUBLIC_KEY;
  const release = platformRelease();
  const target = opts.target || TARGET_FOR_PLATFORM[process.platform];
  if (!target || !release) throw new ReleaseError(`no Ant0 Browser release target for platform '${process.platform}'`);

  const { version, prefix } = await resolveRelease(baseUrl, opts.version, opts.channel);
  log(`resolving release ${version} from ${baseUrl}`);

  const sumsBytes = await fetchBytes(join(prefix, "SHA256SUMS.txt"));
  const sigText = (await fetchBytes(join(prefix, "SHA256SUMS.txt.minisig"))).toString("utf8");
  verifyMinisign(sumsBytes, sigText, publicKey);
  const sums = parseSums(sumsBytes.toString("utf8"));

  const manifestBytes = await fetchBytes(join(prefix, "manifest.json"));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== sums["manifest.json"]) {
    throw new ReleaseError("manifest.json does not match the signed SHA256SUMS.txt");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.schema !== MANIFEST_SCHEMA || manifest?.version !== version) {
    throw new ReleaseError("manifest.json is not a recognized Ant0 release manifest for this version");
  }
  const expectedChromium = opts.expectedChromium || release.version;
  if (manifest.chromium !== expectedChromium) {
    throw new ReleaseError(
      `release ${version} is Chromium ${manifest.chromium} but this SDK expects ${expectedChromium}; ` +
        "upgrade the SDK or pin ANT0_BROWSER_RELEASE_VERSION",
    );
  }
  const entry = manifest.targets?.[target];
  if (!entry) throw new ReleaseError(`release ${version} has no ${target} artifact`);
  if (sums[entry.file] !== entry.sha256) throw new ReleaseError("manifest target hash does not match the signed SHA256SUMS.txt");

  mkdirSync(installBase, { recursive: true });
  const browserDir = path.join(installBase, "browser");
  const tmp = mkdtempSync(path.join(installBase, ".download-"));
  try {
    const archive = path.join(tmp, path.basename(entry.file));
    await downloadTo(join(prefix, entry.file), archive, entry.sha256, log, opts.onProgress);
    const size = statSync(archive).size;
    // The hash was checked while streaming; report the verified archive as one completed step.
    try { opts.onProgress?.({ phase: "verify", bytes: size, total: size }); } catch { /* listener error */ }
    const staging = path.join(tmp, "browser");
    await extractArchive(archive, staging, opts.onProgress);
    if (!findBinary(staging, release.binary)) throw new ReleaseError(`${release.binary} not found in the downloaded archive`);
    rmSync(browserDir, { recursive: true, force: true });
    renameSync(staging, browserDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeManifest(installBase, browserDir);
  writeFileSync(path.join(installBase, ".verified"), `${version}\n`);
  writeFileSync(path.join(installBase, ".release.json"), JSON.stringify({ version, chromium: manifest.chromium, target, source: opts.sourceLabel ?? baseUrl }));
  log(`installed Ant0 Browser ${version} (${target})`);
  const exe = findBinary(browserDir, release.binary) as string;
  return realpathSync(exe);
}

export function installedRelease(installBase: string): { version: string; chromium: string; target: string } | undefined {
  const file = path.join(installBase, ".release.json");
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
