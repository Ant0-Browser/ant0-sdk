import { describe, it, expect } from "vitest";
import { coherenceWarnings, emitCoherenceWarnings, engineHasGpuCanvasFixes } from "../src/warnings.js";
import { vi } from "vitest";

const codes = (o: Record<string, unknown>, host = "win32", build = "149") =>
  new Set(coherenceWarnings(o, host, build).map((w) => w.code));

describe("coherenceWarnings", () => {
  it("is silent for a coherent default persona", () => {
    expect(coherenceWarnings({ platform: "windows", fingerprint: "s", headless: false }, "win32", "149")).toEqual([]);
  });

  it("flags a proxy without geo coherence, silent with geoip or manual geo", () => {
    expect(codes({ proxy: { server: "http://h:8080" }, headless: false }).has("proxy-no-geo")).toBe(true);
    expect(codes({ proxy: { server: "http://h:8080" }, geoip: true, headless: false }).has("proxy-no-geo")).toBe(false);
    expect(codes({ proxy: "http://h:8080", timezone: "America/New_York", acceptLanguage: "en-US,en", headless: false }).has("proxy-no-geo")).toBe(false);
  });

  it("flags SOCKS + geoip (can't resolve)", () => {
    expect(codes({ proxy: "socks5://u:p@h:1", geoip: true, headless: false }).has("socks-geoip")).toBe(true);
    expect(codes({ proxy: "http://h:1", geoip: true, headless: false }).has("socks-geoip")).toBe(false);
  });

  it("flags platform spoofed away from the host without a profile", () => {
    expect(codes({ platform: "macos", headless: false }).has("platform-host-fonts")).toBe(true);
    expect(codes({ platform: "windows", headless: false }).has("platform-host-fonts")).toBe(false);
    expect(codes({ platform: "macos", fingerprintProfile: "p.json", headless: false }).has("platform-host-fonts")).toBe(false);
  });

  it("flags GPU string incoherent with platform, and software renderers", () => {
    expect(codes({ platform: "macos", gpuRenderer: "ANGLE (Apple, Direct3D11)", headless: false }, "darwin").has("gpu-platform")).toBe(true);
    expect(codes({ gpuRenderer: "ANGLE (Google, Vulkan SwiftShader Device)", headless: false }).has("gpu-software")).toBe(true);
  });

  it("flags non-Chrome brand and a version that differs from the build", () => {
    expect(codes({ brand: "Edge", headless: false }).has("brand-mismatch")).toBe(true);
    expect(codes({ brand: "Chrome", headless: false }).has("brand-mismatch")).toBe(false);
    expect(codes({ brandVersion: "146", headless: false }).has("version-mismatch")).toBe(true);
    expect(codes({ brandVersion: "149.0.1", headless: false }).has("version-mismatch")).toBe(false);
  });

  it("flags disableGpuFingerprint only in canvas noise mode", () => {
    expect(codes({ disableGpuFingerprint: true, canvas: "noise", headless: false }).has("gpu-noise")).toBe(true);
    expect(codes({ disableGpuFingerprint: true, headless: false }).has("gpu-noise")).toBe(false);
    expect(codes({ disableGpuFingerprint: true, canvas: "real", headless: false }).has("gpu-noise")).toBe(false);
  });

  it("notes headless render coherence", () => {
    expect(codes({ headless: true }).has("headless-render")).toBe(true);
    expect(codes({ headless: false }).has("headless-render")).toBe(false);
    // The canvas bridge is gone: an old canvasBridge value no longer silences or adds anything.
    expect(codes({ headless: true, canvasBridge: { url: "ws://h" } }).has("headless-render")).toBe(true);
    expect(codes({ canvasBridge: { url: "ws://h" }, headless: false }).has("bridge-no-gpu")).toBe(false);
  });

  it("flags re-added automation args", () => {
    expect(codes({ _userArgs: ["--enable-automation"], headless: false }).has("automation-arg")).toBe(true);
    expect(codes({ _userArgs: ["--remote-debugging-port=9222"], headless: false }).has("automation-arg")).toBe(true);
    expect(codes({ _userArgs: ["--no-sandbox"], headless: false }).has("automation-arg")).toBe(false);
  });
});

import { linuxHostHasGpu, gpuHostMissingFor } from "../src/warnings.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("host-GPU reachability", () => {
  it("linuxHostHasGpu detects render/card nodes, false when absent", () => {
    const empty = mkdtempSync(join(tmpdir(), "dri-"));
    expect(linuxHostHasGpu(join(empty, "missing"))).toBe(false);   // dir absent
    expect(linuxHostHasGpu(empty)).toBe(false);                    // empty
    const g = mkdtempSync(join(tmpdir(), "dri2-")); writeFileSync(join(g, "renderD128"), "");
    expect(linuxHostHasGpu(g)).toBe(true);
    const c = mkdtempSync(join(tmpdir(), "dri3-")); writeFileSync(join(c, "card0"), "");
    expect(linuxHostHasGpu(c)).toBe(true);
  });

  it("gpuHostMissingFor flags a persona on a GPU-less Linux host, with escape hatches", () => {
    const empty = mkdtempSync(join(tmpdir(), "nogpu-"));
    const real = mkdtempSync(join(tmpdir(), "gpu-")); writeFileSync(join(real, "renderD128"), "");
    expect(gpuHostMissingFor({}, "synthetic", "linux", empty)).toBe("synthetic");
    expect(gpuHostMissingFor({}, "captured", "linux", empty)).toBe("captured");
    expect(gpuHostMissingFor({}, "native", "linux", empty)).toBeUndefined();
    expect(gpuHostMissingFor({}, "synthetic", "linux", real)).toBeUndefined();
    expect(gpuHostMissingFor({}, "synthetic", "win32", empty)).toBeUndefined();
    expect(gpuHostMissingFor({ disableGpuFingerprint: true }, "synthetic", "linux", empty)).toBeUndefined();
    expect(gpuHostMissingFor({ gpuRenderer: "SwiftShader" }, "synthetic", "linux", empty)).toBeUndefined();
    expect(gpuHostMissingFor({ canvasBridge: { url: "ws://h/x" } }, "synthetic", "linux", empty)).toBe("synthetic");
  });

  it("persona-gpu-unreachable warns and supersedes headless-render", () => {
    const c = codes({ _gpuHostMissing: "synthetic", headless: true }, "linux");
    expect(c.has("persona-gpu-unreachable")).toBe(true);
    expect(c.has("headless-render")).toBe(false);
    expect(codes({ headless: false }, "linux").has("persona-gpu-unreachable")).toBe(false);
  });
});

describe("engine-version-aware GPU and canvas gap warnings", () => {
  const OLD = "158.0.8127.18-ant0.7", FIRST = "158.0.8127.18-ant0.8", LATER = "158.0.8127.18-ant0.10";
  const REAL = { gpuStringSpoof: false, canvasNoise: false, headless: false };
  const NOISE = { ...REAL, canvas: "noise" };
  const c = (o: Record<string, unknown>, v?: string) =>
    new Set(coherenceWarnings(o, "win32", "149", v).map((w) => w.code));

  it("engineHasGpuCanvasFixes: ant0.8 and later yes, dev yes, old/unknown/unparseable no", () => {
    for (const v of [FIRST, LATER, "158.0.8127.19-ant0.1", "159.0.1.1-ant0.1", "158.0.8127.18-ant0.dev"])
      expect(engineHasGpuCanvasFixes(v), v).toBe(true);
    for (const v of [OLD, "158.0.8127.9-ant0.9", undefined, "", "garbage", "158.0.8127.18-ant0.8-rc1", "158.0.8127.18", 8])
      expect(engineHasGpuCanvasFixes(v), String(v)).toBe(false);
  });

  it("old and unknown engines: gpu-string-only (the engine ignores the switch) in either mode, never gpu-noise-string", () => {
    for (const v of [OLD, undefined, "garbage"]) {
      for (const o of [REAL, NOISE]) {
        const got = c(o, v);
        expect(got.has("gpu-string-only"), String(v)).toBe(true);
        expect(got.has("gpu-noise-string"), String(v)).toBe(false);   // would repeat gpu-string-only
      }
      expect(c(NOISE, v).has("canvas-noise-toblob"), String(v)).toBe(true);
      expect(c(REAL, v).has("canvas-noise-toblob"), String(v)).toBe(false);   // real mode: no noise to keep
    }
  });

  it("gpu-string-only is a warn (not a note) on old and unknown engines", () => {
    for (const v of [OLD, undefined, "garbage"])
      expect(coherenceWarnings(REAL, "win32", "149", v).find((w) => w.code === "gpu-string-only")?.severity, String(v)).toBe("warn");
  });

  it("gpu-string-only prints once per process even though it is a warn", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (let i = 0; i < 3; i++) emitCoherenceWarnings({ gpuStringSpoof: false, headless: false }, false, "win32", "149", OLD);
      const out = spy.mock.calls.map((x) => String(x[0])).filter((l) => l.includes("ignore gpuStringSpoof:false"));
      expect(out.length).toBe(1);
      expect(out[0]).toContain("warning:");
    } finally { spy.mockRestore(); }
  });

  it("ant0.8, later and dev builds: no ignored-switch warnings; the string-over-pixels warning only in noise mode", () => {
    for (const v of [FIRST, LATER, "158.0.8127.18-ant0.dev"]) {
      for (const o of [REAL, NOISE]) {
        expect(c(o, v).has("gpu-string-only"), v).toBe(false);
        expect(c(o, v).has("canvas-noise-toblob"), v).toBe(false);
      }
      expect(c(NOISE, v).has("gpu-noise-string"), v).toBe(true);
      expect(c(REAL, v).has("gpu-noise-string"), v).toBe(false);
    }
  });

  it("old-engine text says the switch is ignored and what the user still sees", () => {
    const m = (code: string) => coherenceWarnings(NOISE, "win32", "149", OLD).find((w) => w.code === code)?.message ?? "";
    expect(m("gpu-string-only")).toContain("engines before ant0.8 ignore gpuStringSpoof:false");
    expect(m("gpu-string-only")).toContain("full persona GPU");
    expect(m("canvas-noise-toblob")).toContain("engines before ant0.8 ignore canvasNoise:false");
    expect(m("canvas-noise-toblob")).toContain("canvas mode 'noise'");
  });

  it("gpu-string-only stands down when disableGpuFingerprint takes the GPU real", () => {
    expect(c({ gpuStringSpoof: false, disableGpuFingerprint: true, headless: false }, OLD).has("gpu-string-only")).toBe(false);
  });
});

describe("canvas mode decides which noise warnings fire", () => {
  const NOISY = ["gpu-noise", "gpu-noise-string", "canvas-noise-toblob", "canvas-noise-conflict"];
  const FIRST = "158.0.8127.18-ant0.8", OLD = "158.0.8127.18-ant0.7";
  const base = { disableGpuFingerprint: true, headless: false };
  const got = (o: Record<string, unknown>, v = FIRST) => coherenceWarnings(o, "win32", "149", v);
  const fired = (o: Record<string, unknown>, v = FIRST) => new Set(got(o, v).map((w) => w.code));

  it("real mode (default, canvas:'real', legacy false flags) fires no noise warning", () => {
    for (const v of [FIRST, OLD, undefined]) {
      for (const o of [
        base, { ...base, canvas: "real" }, { ...base, canvas: "real", fingerprintNoise: true, canvasNoise: true },
        { ...base, canvasNoise: false }, { ...base, fingerprintNoise: false },
        { gpuStringSpoof: false, canvasNoise: false, headless: false },
      ]) {
        const f = fired(o, v);
        for (const code of NOISY) expect(f.has(code), `${JSON.stringify(o)} ${v} ${code}`).toBe(false);
      }
    }
  });

  it("noise mode with a real GPU says what the noise does, and names the way out", () => {
    for (const o of [{ ...base, canvas: "noise" }]) {
      const w = got(o).find((x) => x.code === "gpu-noise");
      expect(w, JSON.stringify(o)).toBeDefined();
      expect(w!.severity).toBe("warn");
      expect(w!.message).toContain("canvas mode 'noise'");
      expect(w!.message).toContain("unique to the profile");
      expect(w!.message).toContain("canvas:'real'");
    }
    // the same text on any engine release
    expect(fired({ ...base, canvas: "noise" }, OLD).has("gpu-noise")).toBe(true);
    expect(fired({ ...base, canvas: "noise" }, undefined).has("gpu-noise")).toBe(true);
  });

  it("the legacy true overrides do not put a launch in noise mode", () => {
    for (const o of [{ ...base, canvasNoise: true }, { ...base, fingerprintNoise: true }])
      expect(fired(o).has("gpu-noise")).toBe(false);
  });

  it("canvas:'real' wins over the legacy true overrides", () => {
    expect(fired({ ...base, canvas: "real", canvasNoise: true }).has("gpu-noise")).toBe(false);
  });

  it("no canvas warning talks about a seed path", () => {
    for (const o of [
      { ...base, canvas: "noise" }, { gpuStringSpoof: false, canvas: "noise", headless: false },
      { canvas: "noise", canvasNoise: false, headless: false }, { canvas: "noise", fingerprintNoise: false, headless: false },
    ]) for (const v of [FIRST, OLD]) for (const w of got(o, v)) {
      expect(w.message.toLowerCase(), w.code).not.toContain("seed path");
      expect(w.message, w.code).not.toContain("exact fix");
    }
  });

  it("canvas:'noise' together with fingerprintNoise:false warns once and only in noise mode", () => {
    const conflict = got({ canvas: "noise", fingerprintNoise: false, headless: false }).filter((w) => w.code === "canvas-noise-conflict");
    expect(conflict.length).toBe(1);
    expect(conflict[0].severity).toBe("warn");
    expect(conflict[0].message).toContain("fingerprintNoise:false");
    expect(conflict[0].message).toContain("fingerprint_noise=False");
    expect(fired({ canvas: "real", fingerprintNoise: false, headless: false }).has("canvas-noise-conflict")).toBe(false);
    expect(fired({ fingerprintNoise: false, headless: false }).has("canvas-noise-conflict")).toBe(false);
    expect(fired({ canvas: "noise", headless: false }).has("canvas-noise-conflict")).toBe(false);
  });

  it("an invalid canvas value is treated as real by the warnings (the launch rejects it elsewhere)", () => {
    expect(() => coherenceWarnings({ ...base, canvas: "weird" }, "win32", "149", FIRST)).not.toThrow();
    expect(fired({ ...base, canvas: "weird" }).has("gpu-noise")).toBe(false);
  });
});
