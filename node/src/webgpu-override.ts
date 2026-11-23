// A GPU override (gpuVendor / gpuRenderer) replaces only the WebGL strings in the engine. The WebGPU
// adapter reads --fingerprint-webgpu-{vendor,architecture,device,
// description} when present, else the persona's own values, so without these flags WebGL can say
// Intel while navigator.gpu still says the persona's old AMD/NVIDIA GPU.
//
// Empty values: the adapter tests HasSwitch() first, so `--fingerprint-webgpu-architecture=` really
// yields an empty architecture (it does NOT fall back to the persona). Device and description are
// emptied the same way so the old GPU's strings cannot leak. (The persona derivation in the engine
// does refill an empty persona.webgpu_architecture from the WebGL vendor, but the adapter never
// reads that value once the switch is present.)

import { existsSync, readFileSync } from "node:fs";
import { gpuFamilies } from "./persona-profile-v2.js";

/** Renderer text -> WebGPU architecture. Spellings: `gen-9`, `gen-12-lp`, `turing`, `ampere` appear
 * in the persona data. `pascal`/`lovelace` (NVIDIA)
 * and `gcn-4`/`rdna-1`/`rdna-2`/`rdna-3` (AMD) follow Dawn's gpu_info architecture naming. Anything not matched is left empty rather than guessed. */
const ARCHITECTURES: [RegExp, string][] = [
  [/\b(?:uhd|hd) graphics\s*[56]\d\d\b/i, "gen-9"],
  [/\biris\W*(?:\(r\)\W*)?xe\b|\buhd graphics\s*7\d\d\b/i, "gen-12-lp"],
  [/\bgtx\s*10\d\d\b/i, "pascal"],
  [/\bgtx\s*16\d\d\b|\brtx\s*20\d\d\b/i, "turing"],
  [/\brtx\s*30\d\d\b/i, "ampere"],
  [/\brtx\s*40\d\d\b/i, "lovelace"],
  [/\brx\s*[45]\d\d\b/i, "gcn-4"],
  [/\brx\s*5\d{3}\b/i, "rdna-1"],
  [/\brx\s*6\d{3}\b/i, "rdna-2"],
  [/\brx\s*7\d{3}\b/i, "rdna-3"],
];

const SUPPORTED = new Set(["intel", "nvidia", "amd", "qualcomm"]);

export function webgpuArchitectureFor(renderer: string): string {
  return ARCHITECTURES.find(([re]) => re.test(renderer))?.[1] ?? "";
}

function profileWebgpuFamily(profile: unknown): string | undefined {
  let obj: unknown;
  try {
    obj = typeof profile === "object" ? profile : existsSync(String(profile)) ? JSON.parse(readFileSync(String(profile), "utf8")) : JSON.parse(String(profile));
  } catch {
    return undefined;
  }
  const g = (obj as { graphics?: { webgpu?: Record<string, unknown> } } | null)?.graphics?.webgpu;
  if (!g || typeof g !== "object") return undefined;
  const text = [g.vendor, g.architecture, g.device, g.description].filter((s): s is string => typeof s === "string").join(" ");
  const fams = gpuFamilies(text);
  return fams.size === 1 ? [...fams][0] : undefined;
}

export interface WebgpuOverridePlan {
  args: string[];
  /** Set when WebGPU may not fully match the override (family unknown, or no architecture mapping). */
  warning?: string;
}

export function webgpuOverridePlan(o: {
  gpuVendor?: unknown; gpuRenderer?: unknown; fingerprintProfile?: unknown;
  disableGpuFingerprint?: unknown; gpuStringSpoof?: unknown;
}): WebgpuOverridePlan {
  const vendor = typeof o.gpuVendor === "string" ? o.gpuVendor : "";
  const renderer = typeof o.gpuRenderer === "string" ? o.gpuRenderer : "";
  if (!vendor && !renderer) return { args: [] };
  // The real GPU is presented (or the string spoof is off): the override is not applied at all.
  if (o.disableGpuFingerprint === true || o.gpuStringSpoof === false) return { args: [] };
  const fams = gpuFamilies(`${vendor} ${renderer}`);
  const family = fams.size === 1 ? [...fams][0] : undefined;
  if (!family || !SUPPORTED.has(family)) {
    return {
      args: [],
      warning: `Cannot tell which GPU family gpuVendor/gpuRenderer ('${vendor}' / '${renderer}') names, so WebGPU ` +
        "(navigator.gpu) keeps the persona's own adapter and may contradict WebGL. Use a recognisable " +
        "Intel/NVIDIA/AMD/Qualcomm renderer string.",
    };
  }
  if (o.fingerprintProfile !== undefined && profileWebgpuFamily(o.fingerprintProfile) === family) return { args: [] };
  const arch = webgpuArchitectureFor(renderer);
  return {
    // device/description are emptied so the previous GPU's strings cannot leak.
    args: [
      `--fingerprint-webgpu-vendor=${family}`,
      `--fingerprint-webgpu-architecture=${arch}`,
      "--fingerprint-webgpu-device=",
      "--fingerprint-webgpu-description=",
    ],
    warning: arch ? undefined :
      `gpuRenderer '${renderer}' is not in the WebGPU architecture table: WebGPU vendor is set to '${family}' ` +
      "but its architecture, device and description are empty, which a real adapter never reports.",
  };
}
