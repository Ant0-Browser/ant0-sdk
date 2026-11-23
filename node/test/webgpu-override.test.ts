import { describe, it, expect } from "vitest";
import { fingerprintArgs } from "../src/fingerprint.js";
import { coherenceWarnings } from "../src/warnings.js";
import { webgpuArchitectureFor } from "../src/webgpu-override.js";

const amdProfile = { graphics: { webgpu: { vendor: "amd", architecture: "gcn-4", device: "", description: "" } } };
const intelProfile = { graphics: { webgpu: { vendor: "intel", architecture: "gen-9" } } };
const UHD630 = "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)";
const webgpuFlags = (a: string[]) => a.filter((x) => x.startsWith("--fingerprint-webgpu-"));
const codes = (o: Record<string, unknown>) => coherenceWarnings({ headless: false, ...o }, "win32", "149").map((w) => w.code);

describe("GPU override and WebGPU", () => {
  it("Intel override on an AMD-webgpu persona sets vendor, mapped architecture, empty device/description", () => {
    const args = fingerprintArgs({ gpuVendor: "Google Inc. (Intel)", gpuRenderer: UHD630, fingerprintProfile: amdProfile });
    expect(webgpuFlags(args)).toEqual([
      "--fingerprint-webgpu-vendor=intel",
      "--fingerprint-webgpu-architecture=gen-9",
      "--fingerprint-webgpu-device=",
      "--fingerprint-webgpu-description=",
    ]);
    expect(codes({ gpuVendor: "Google Inc. (Intel)", gpuRenderer: UHD630, fingerprintProfile: amdProfile })).not.toContain("gpu-webgpu-mismatch");
  });

  it("unknown renderer: vendor set, architecture empty, warning present", () => {
    const o = { gpuVendor: "Google Inc. (Intel)", gpuRenderer: "ANGLE (Intel, Intel(R) Arc(TM) A770 Direct3D11)", fingerprintProfile: amdProfile };
    const flags = webgpuFlags(fingerprintArgs(o));
    expect(flags).toContain("--fingerprint-webgpu-vendor=intel");
    expect(flags).toContain("--fingerprint-webgpu-architecture=");
    expect(codes(o)).toContain("gpu-webgpu-mismatch");
  });

  it("same family: no webgpu flags and no warning", () => {
    const o = { gpuVendor: "Google Inc. (Intel)", gpuRenderer: UHD630, fingerprintProfile: intelProfile };
    expect(webgpuFlags(fingerprintArgs(o))).toEqual([]);
    expect(codes(o)).not.toContain("gpu-webgpu-mismatch");
  });

  it("no override: args unchanged", () => {
    expect(fingerprintArgs({ fingerprint: "s", platform: "windows" })).toEqual([
      "--fingerprint=s", "--fingerprint-platform=windows", "--fingerprint-brand=chrome",
      "--accept-lang=en-US,en", "--lang=en-US", "--timezone=America/New_York",
    ]);
    expect(webgpuFlags(fingerprintArgs({ fingerprint: "s", platform: "windows" }))).toEqual([]);
    expect(codes({ fingerprint: "s", platform: "windows" })).not.toContain("gpu-webgpu-mismatch");
  });

  it("unknowable family: no flags, warning", () => {
    const o = { gpuRenderer: "Mystery GPU 9000", fingerprintProfile: amdProfile };
    expect(webgpuFlags(fingerprintArgs(o))).toEqual([]);
    expect(codes(o)).toContain("gpu-webgpu-mismatch");
  });

  it("maps renderers to architectures", () => {
    const t: [string, string][] = [
      ["Intel(R) Iris(R) Xe Graphics", "gen-12-lp"], ["Intel(R) UHD Graphics 770", "gen-12-lp"],
      ["NVIDIA GeForce GTX 1060", "pascal"], ["NVIDIA GeForce GTX 1660 Ti", "turing"], ["NVIDIA GeForce RTX 2070", "turing"],
      ["NVIDIA GeForce RTX 3060", "ampere"], ["NVIDIA GeForce RTX 4070", "lovelace"],
      ["AMD Radeon RX 580", "gcn-4"], ["AMD Radeon RX 5700 XT", "rdna-1"], ["AMD Radeon RX 6600", "rdna-2"], ["AMD Radeon RX 7800 XT", "rdna-3"],
      ["Something else", ""],
    ];
    for (const [r, a] of t) expect(webgpuArchitectureFor(r)).toBe(a);
  });

  it("does nothing when the real GPU is presented", () => {
    expect(webgpuFlags(fingerprintArgs({ gpuRenderer: UHD630, disableGpuFingerprint: true, fingerprintProfile: amdProfile }))).toEqual([]);
  });
});
