// Release download trust chain: minisign signature over SHA256SUMS.txt, then hashes for the
// manifest and archive. Every failure must refuse the install; nothing is trusted from the store.
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RELEASE_PUBLIC_KEY, platformRelease } from "../src/release.js";
import {
  PROGRESS_INTERVAL_MS,
  ReleaseError,
  SignatureError,
  TARGET_FOR_PLATFORM,
  ed25519Verify,
  installRelease,
  parseMinisignPublicKey,
  resolveRelease,
  throttleProgress,
  verifyMinisign,
  type InstallProgress,
} from "../src/release-fetch.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/release/", import.meta.url));

// RFC 8032 section 7.1 vectors (public key, message, signature), hex.
const RFC8032: Array<[string, string, string]> = [
  ["d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"],
  ["fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
    "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"],
];

describe("ed25519 / minisign", () => {
  it("accepts RFC 8032 vectors and rejects tampering", () => {
    for (const [pk, msg, sig] of RFC8032) {
      expect(ed25519Verify(Buffer.from(pk, "hex"), Buffer.from(sig, "hex"), Buffer.from(msg, "hex"))).toBe(true);
      const bad = Buffer.from(sig, "hex"); bad[0] ^= 1;
      expect(ed25519Verify(Buffer.from(pk, "hex"), bad, Buffer.from(msg, "hex"))).toBe(false);
    }
  });

  it("parses the embedded release key", () => {
    const { keyId, publicKey } = parseMinisignPublicKey(RELEASE_PUBLIC_KEY);
    expect(keyId.length).toBe(8);
    expect(publicKey.length).toBe(32);
  });

  it("verifies a real minisign signature made with the production key", () => {
    const message = readFileSync(path.join(FIXTURES, "fixture.txt"));
    const sig = readFileSync(path.join(FIXTURES, "fixture.txt.minisig"), "utf8");
    expect(verifyMinisign(message, sig, RELEASE_PUBLIC_KEY)).toBe("ant0 sdk fixture");
    expect(() => verifyMinisign(Buffer.concat([message, Buffer.from("\n")]), sig, RELEASE_PUBLIC_KEY)).toThrow(/not authentic/);
    expect(() => verifyMinisign(message, sig.replace("ant0 sdk fixture", "ant0 sdk fixturE"), RELEASE_PUBLIC_KEY)).toThrow(/trusted comment/);
    const other = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8, 1), Buffer.alloc(32, 2)]).toString("base64");
    expect(() => verifyMinisign(message, sig, other)).toThrow(/different key/);
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end install from a fake release store served over local HTTP
// ---------------------------------------------------------------------------------------------

class Signer {
  private priv: KeyObject;
  readonly keyId = Buffer.from("1122334455667788", "hex");
  readonly publicKey: string;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.priv = privateKey;
    const raw = (publicKey.export({ format: "jwk" }) as { x: string }).x;
    this.publicKey = Buffer.concat([Buffer.from("Ed"), this.keyId, Buffer.from(raw, "base64url")]).toString("base64");
  }
  sign(message: Buffer, trusted = "test release"): string {
    const sig = cryptoSign(null, createHash("blake2b512").update(message).digest(), this.priv);
    const glob = cryptoSign(null, Buffer.concat([sig, Buffer.from(trusted, "utf8")]), this.priv);
    return ["untrusted comment: test", Buffer.concat([Buffer.from("ED"), this.keyId, sig]).toString("base64"),
      `trusted comment: ${trusted}`, glob.toString("base64"), ""].join("\n");
  }
}

function makeArchive(dir: string, name: string, files: Record<string, Buffer>): Buffer {
  const src = path.join(dir, "src"); mkdirSync(src, { recursive: true });
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    writeFileSync(path.join(src, rel), data);
  }
  const out = path.join(dir, name);
  const args = name.endsWith(".zip") ? ["-a", "-cf", out, "-C", src, "."] : ["-cJf", out, "-C", src, "."];
  const r = spawnSync("tar", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
  return readFileSync(out);
}

interface StoreOptions { chromium?: string; tamper?: "archive" | "signature" }

function makeStore(root: string, signer: Signer, o: StoreOptions = {}): string {
  const release = platformRelease()!;
  const chromium = o.chromium || release.version;
  const version = `${chromium}-ant0.3`;
  const target = TARGET_FOR_PLATFORM[process.platform];
  const marker = Buffer.from("ant0-browser-capabilities/persona-profile-v1");
  const files: Record<string, Buffer> = {
    [release.binary]: Buffer.concat([Buffer.from("MZ"), marker]), "icudtl.dat": Buffer.alloc(16, "i"),
    "snapshot_blob.bin": Buffer.alloc(16, "s"), "resources.pak": Buffer.alloc(16, "r"), "locales/en-US.pak": Buffer.alloc(8, "l"),
  };
  if (process.platform === "win32") { files["chrome.dll"] = marker; files["chrome_elf.dll"] = Buffer.alloc(8, "e"); }
  const name = `ant0-browser-${version}-${process.platform === "win32" ? "windows-x64.zip" : "linux-x64.tar.xz"}`;
  const scratch = mkdtempSync(path.join(tmpdir(), "ant0-mk-"));
  let archive = makeArchive(scratch, name, files);
  const goodHash = createHash("sha256").update(archive).digest("hex");
  if (o.tamper === "archive") { archive = Buffer.from(archive); archive[archive.length - 1] ^= 0xff; }
  rmSync(scratch, { recursive: true, force: true });

  const rel = path.join(root, "releases", version);
  mkdirSync(path.join(rel, target), { recursive: true });
  writeFileSync(path.join(rel, target, name), archive);
  const manifest = { schema: "ant0-release-manifest/v1", version, chromium, ant0_build: 3,
    targets: { [target]: { file: `${target}/${name}`, size: archive.length, sha256: goodHash, binary: release.binary } } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(path.join(rel, "manifest.json"), manifestBytes);
  let sums = `${goodHash}  ${target}/${name}\n${createHash("sha256").update(manifestBytes).digest("hex")}  manifest.json\n`;
  const sig = signer.sign(Buffer.from(sums), `ant0-browser ${version}`);
  if (o.tamper === "signature") sums = sums.replace("manifest.json", "manifest.jsoN");
  writeFileSync(path.join(rel, "SHA256SUMS.txt"), sums);
  writeFileSync(path.join(rel, "SHA256SUMS.txt.minisig"), sig);
  mkdirSync(path.join(root, "channels"));
  writeFileSync(path.join(root, "channels", "stable.json"), JSON.stringify(
    { schema: "ant0-release-channel/v1", channel: "stable", version, chromium, manifest: `releases/${version}/manifest.json` }));
  return version;
}

function serve(root: string): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const file = path.join(root, decodeURIComponent(new URL(req.url || "/", "http://x").pathname));
      if (!file.startsWith(root) || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
      const data = readFileSync(file);
      res.setHeader("Content-Length", data.length); res.end(data);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

describe("throttleProgress", () => {
  it("emits the first report, spaces the rest by PROGRESS_INTERVAL_MS and always emits completion", () => {
    let t = 1000;
    const seen: InstallProgress[] = [];
    const p = throttleProgress((x) => seen.push(x), "download", () => t);
    p.report(0, 100);
    p.report(10, 100); // suppressed (same instant)
    t += PROGRESS_INTERVAL_MS - 1;
    p.report(20, 100); // suppressed
    t += 1;
    p.report(30, 100); // interval elapsed
    p.report(40, 100); // suppressed, kept as pending
    p.flush(); // pending goes out
    p.report(100, 100); // completion is never throttled
    expect(seen.map((x) => x.bytes)).toEqual([0, 30, 40, 100]);
    expect(seen.every((x) => x.phase === "download" && x.total === 100)).toBe(true);
    expect(PROGRESS_INTERVAL_MS).toBe(250);
  });

  it("is a no-op without a callback and swallows listener exceptions", () => {
    const none = throttleProgress(undefined, "extract");
    expect(() => { none.report(1, 2); none.flush(); }).not.toThrow();
    const bad = throttleProgress(() => { throw new Error("boom"); }, "extract", () => 0);
    expect(() => bad.report(2, 2)).not.toThrow();
  });
});

describe("installRelease", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const c of cleanups.splice(0)) c(); });

  async function setup(o: StoreOptions = {}) {
    const tmp = mkdtempSync(path.join(tmpdir(), "ant0-rel-"));
    const signer = new Signer();
    const version = makeStore(path.join(tmp, "store"), signer, o);
    const { url, server } = await serve(path.join(tmp, "store"));
    cleanups.push(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });
    return { tmp, signer, version, url, cache: path.join(tmp, "cache", "ant0-mtest") };
  }

  it("installs end to end and records the release", async () => {
    const { signer, version, url, cache } = await setup();
    const exe = await installRelease(url, cache, { quiet: true, publicKey: signer.publicKey });
    expect(path.basename(exe)).toBe(platformRelease()!.binary);
    expect(readFileSync(path.join(cache, ".verified"), "utf8").trim()).toBe(version);
    expect(JSON.parse(readFileSync(path.join(cache, ".release.json"), "utf8")).version).toBe(version);
    expect(existsSync(path.join(cache, ".manifest.json"))).toBe(true);
    expect(existsSync(path.join(cache, "browser", "locales", "en-US.pak"))).toBe(true);
  });

  it("reports download, verify and extract progress through onProgress", async () => {
    const { signer, url, cache } = await setup();
    const seen: InstallProgress[] = [];
    await installRelease(url, cache, {
      quiet: true, publicKey: signer.publicKey,
      onProgress: (p) => { seen.push({ ...p }); if (p.phase === "verify") throw new Error("listener bug is swallowed"); },
    });
    const phases = [...new Set(seen.map((p) => p.phase))];
    expect(phases).toEqual(["download", "verify", "extract"]);
    const download = seen.filter((p) => p.phase === "download");
    const total = download[0]!.total;
    expect(total).toBeGreaterThan(0); // Content-Length was honoured
    for (const p of download) { expect(p.total).toBe(total); expect(p.bytes).toBeLessThanOrEqual(total); }
    expect(download[0]!.bytes).toBe(0);
    expect(download[download.length - 1]!.bytes).toBe(total);
    const verify = seen.filter((p) => p.phase === "verify");
    expect(verify).toEqual([{ phase: "verify", bytes: total, total }]);
    const extract = seen.filter((p) => p.phase === "extract");
    expect(extract[0]!.total).toBeGreaterThanOrEqual(5); // at least the five files
    expect(extract[extract.length - 1]).toEqual({ phase: "extract", bytes: extract[0]!.total, total: extract[0]!.total });
    for (const p of extract) expect(p.bytes).toBeLessThanOrEqual(p.total);
  });

  it("resolves the channel pointer, or a pinned version", async () => {
    const { version, url } = await setup();
    expect((await resolveRelease(url)).version).toBe(version);
    expect((await resolveRelease(url, "pinned-1")).prefix.endsWith("releases/pinned-1")).toBe(true);
  });

  it("refuses a bad signature and leaves no install behind", async () => {
    const { signer, url, cache } = await setup({ tamper: "signature" });
    await expect(installRelease(url, cache, { quiet: true, publicKey: signer.publicKey })).rejects.toBeInstanceOf(SignatureError);
    expect(existsSync(path.join(cache, "browser"))).toBe(false);
  });

  it("refuses a signature from an untrusted key", async () => {
    const { url, cache } = await setup();
    await expect(installRelease(url, cache, { quiet: true, publicKey: new Signer().publicKey })).rejects.toBeInstanceOf(SignatureError);
  });

  it("refuses a tampered archive", async () => {
    const { signer, url, cache } = await setup({ tamper: "archive" });
    await expect(installRelease(url, cache, { quiet: true, publicKey: signer.publicKey })).rejects.toThrow(/SHA-256 mismatch/);
    expect(existsSync(path.join(cache, "browser"))).toBe(false);
  });

  it("refuses a release built for a different Chromium than this SDK", async () => {
    const { signer, url, cache } = await setup({ chromium: "150.0.1.1" });
    await expect(installRelease(url, cache, { quiet: true, publicKey: signer.publicKey })).rejects.toThrow(/expects/);
  });

  it("ensureBinary installs only when opted in, then serves from cache", async () => {
    const { signer, url, tmp } = await setup();
    const cacheDir = path.join(tmp, "cache2");
    // Substitute the embedded key for this test only, through module mocking (ESM exports are immutable).
    vi.resetModules();
    vi.doMock("../src/release.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/release.js")>()),
      RELEASE_PUBLIC_KEY: signer.publicKey,
    }));
    try {
      const download = await import("../src/download.js");
      delete process.env.ANT0_BROWSER_RELEASE_URL;
      await expect(download.ensureBinary({ cacheDir, quiet: true })).rejects.toThrow(/ANT0_BROWSER_RELEASE_URL/);
      process.env.ANT0_BROWSER_RELEASE_URL = url;
      const exe = await download.ensureBinary({ cacheDir, quiet: true });
      expect(existsSync(exe)).toBe(true);
      rmSync(path.join(tmp, "store"), { recursive: true, force: true }); // second call must not need the store
      expect(await download.ensureBinary({ cacheDir, quiet: true })).toBe(exe);
    } finally {
      delete process.env.ANT0_BROWSER_RELEASE_URL;
      vi.doUnmock("../src/release.js");
      vi.resetModules();
    }
  });
});
