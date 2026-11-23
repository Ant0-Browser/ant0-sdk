/** Canonical persona-profile-v2 contract and dependency-free runtime validation. */

import { webglLimitViolations } from "./webgl-coherence.js";
import type { ErrorClass } from "./errors.js";

const BROWSER_MAJOR_MIN = 100;
const BROWSER_MAJOR_MAX = 999;

export type PersonaSource = "synthetic" | "captured";
export type DeviceMemoryGb = 0.25 | 0.5 | 1 | 2 | 4 | 8 | 16 | 32;
export type PointerType = "none" | "coarse" | "fine";
export type HoverType = "none" | "hover";
export type ColorGamut = "srgb" | "p3" | "rec2020";
export type DynamicRange = "standard" | "high";

export interface PersonaGenerator {
  name: string;
  version: string;
  model_version: string;
}

export interface PersonaSourceReference {
  name: string;
  revision: string;
  sha256: string;
}

export interface PersonaMetadata {
  source: PersonaSource;
  created_at: string;
  generator?: PersonaGenerator;
  source_references?: PersonaSourceReference[];
}

export interface PersonaCompatibility {
  os_family: "windows";
  architecture: "x86_64";
  browser_family: "chromium";
  /** The Chromium major the persona was issued for. Informational: any engine runs it. */
  browser_major: number;
}

export interface PersonaHardware {
  hardware_concurrency: number;
  device_memory_gb: DeviceMemoryGb;
  js_heap_size_limit: number;
}

export interface PersonaDisplay {
  width: number;
  height: number;
  available_width: number;
  available_height: number;
  color_depth: number;
  pixel_depth: number;
  device_pixel_ratio: number;
  max_touch_points: number;
  pointer: PointerType;
  hover: HoverType;
  color_gamut: ColorGamut;
  dynamic_range: DynamicRange;
}

export interface PersonaLocale {
  primary_language: string;
  languages: string[];
  timezone: string;
}

export const WEBGL_PARAMETER_NAMES = [
  "MAX_TEXTURE_SIZE", "MAX_CUBE_MAP_TEXTURE_SIZE", "MAX_RENDERBUFFER_SIZE",
  "MAX_VIEWPORT_DIMS", "MAX_VARYING_VECTORS", "MAX_VERTEX_UNIFORM_VECTORS",
  "MAX_FRAGMENT_UNIFORM_VECTORS", "MAX_COMBINED_TEXTURE_IMAGE_UNITS",
  "MAX_3D_TEXTURE_SIZE", "MAX_ARRAY_TEXTURE_LAYERS", "MAX_DRAW_BUFFERS",
  "MAX_COLOR_ATTACHMENTS", "MAX_SAMPLES", "MAX_VERTEX_UNIFORM_BLOCKS",
  "MAX_FRAGMENT_UNIFORM_BLOCKS", "MAX_COMBINED_UNIFORM_BLOCKS",
  "MAX_UNIFORM_BUFFER_BINDINGS", "MAX_VERTEX_UNIFORM_COMPONENTS",
  "MAX_FRAGMENT_UNIFORM_COMPONENTS", "MAX_TEXTURE_LOD_BIAS", "RED_BITS",
  "GREEN_BITS", "BLUE_BITS", "ALPHA_BITS", "DEPTH_BITS", "STENCIL_BITS",
  "SUBPIXEL_BITS", "SAMPLE_BUFFERS", "SAMPLES", "MAX_TEXTURE_MAX_ANISOTROPY_EXT",
  "ALIASED_LINE_WIDTH_RANGE", "ALIASED_POINT_SIZE_RANGE",
  "MAX_TEXTURE_IMAGE_UNITS", "MAX_VERTEX_TEXTURE_IMAGE_UNITS", "MAX_VERTEX_ATTRIBS",
  "MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS", "UNIFORM_BUFFER_OFFSET_ALIGNMENT",
  "STENCIL_VALUE_MASK", "STENCIL_WRITEMASK", "STENCIL_BACK_VALUE_MASK", "STENCIL_BACK_WRITEMASK",
] as const;
export type WebGLParameterName = typeof WEBGL_PARAMETER_NAMES[number];
export type WebGLValue = number | [number, number];

export interface PersonaWebGLVersion {
  parameters: Partial<Record<WebGLParameterName, WebGLValue>>;
  extensions: string[];
}

export interface PersonaWebGL {
  unmasked_vendor: string;
  unmasked_renderer: string;
  webgl1: PersonaWebGLVersion;
  webgl2: PersonaWebGLVersion;
}

export const WEBGPU_LIMIT_NAMES = [
  "maxTextureDimension1D", "maxTextureDimension2D", "maxTextureDimension3D",
  "maxTextureArrayLayers", "maxBindGroups", "maxBindGroupsPlusVertexBuffers",
  "maxBindingsPerBindGroup", "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout", "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage", "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize", "maxStorageBufferBindingSize",
  "minUniformBufferOffsetAlignment", "minStorageBufferOffsetAlignment", "maxVertexBuffers",
  "maxBufferSize", "maxVertexAttributes", "maxVertexBufferArrayStride",
  "maxInterStageShaderVariables", "maxColorAttachments", "maxColorAttachmentBytesPerSample",
  "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension", "maxStorageBuffersInFragmentStage",
  "maxStorageTexturesInFragmentStage", "maxStorageBuffersInVertexStage",
  "maxStorageTexturesInVertexStage",
] as const;
export type WebGPULimitName = typeof WEBGPU_LIMIT_NAMES[number];

export interface PersonaWebGPU {
  vendor: string;
  architecture: string;
  device?: string;
  description?: string;
  is_fallback_adapter: boolean;
  features: string[];
  limits: Partial<Record<WebGPULimitName, number>>;
}

export interface PersonaGraphics {
  webgl: PersonaWebGL;
  webgpu: PersonaWebGPU;
}

export interface PersonaAudio {
  sample_rate: number;
  base_latency: number;
  output_latency: number;
}

/** Optional per-launch `navigator.connection` base values (engine >= ant0.7); see SDK `overrides.network`. */
export interface PersonaNetwork {
  /** Base round-trip time in ms, > 0 and <= 3000. The reported rtt is this times a per-host factor, rounded to 50. */
  rtt_ms?: number;
  /** Base downlink in Mbps, > 0 and <= 1000. Reported value is capped at 10 and rounded to 0.05. */
  downlink_mbps?: number;
  effective_type?: "slow-2g" | "2g" | "3g" | "4g";
}

export interface PersonaFonts {
  families: string[];
}

export interface PersonaVoice {
  voice_uri: string;
  name: string;
  language: string;
  local_service: boolean;
  default: boolean;
}

export interface PersonaSpeech {
  voices: PersonaVoice[];
}

export interface PersonaCodec {
  supported: boolean;
  smooth: boolean;
  power_efficient: boolean;
}

export type PersonaMediaDeviceKind = "audioinput" | "audiooutput" | "videoinput";

export interface PersonaMediaDevice {
  kind: PersonaMediaDeviceKind;
  label: string;
  device_id: string;
  group_id: string;
}

export interface PersonaMedia {
  codecs: Record<"h264" | "vp8" | "vp9" | "av1" | "hevc", PersonaCodec>;
  devices: PersonaMediaDevice[];
}

export interface PersonaProfileV2 {
  schema_version: 2;
  metadata: PersonaMetadata;
  compatibility: PersonaCompatibility;
  hardware: PersonaHardware;
  display: PersonaDisplay;
  locale: PersonaLocale;
  graphics: PersonaGraphics;
  audio: PersonaAudio;
  fonts: PersonaFonts;
  speech: PersonaSpeech;
  media: PersonaMedia;
  /** Launch-only; never part of a saved identity. */
  network?: PersonaNetwork;
}

export type PersonaProfileValidationErrorCode =
  | "required" | "additional_property" | "type" | "const" | "enum" | "range"
  | "length" | "pattern" | "format" | "unique" | "invariant";

export interface PersonaProfileValidationError {
  /** Dotted canonical field path, with array indexes represented as numeric segments. */
  path: string;
  code: PersonaProfileValidationErrorCode;
  message: string;
}

export type PersonaProfileValidationResult =
  | { valid: true; value: PersonaProfileV2; errors: [] }
  | { valid: false; errors: PersonaProfileValidationError[] };

export class InvalidPersonaProfileV2Error extends Error {
  readonly code: string = "sdk.persona_profile_invalid";
  readonly errorClass: ErrorClass = "expected";
  readonly errors: PersonaProfileValidationError[];

  constructor(errors: PersonaProfileValidationError[]) {
    super(`Invalid persona-profile-v2: ${errors.map((error) => `${error.path || "<root>"}: ${error.message}`).join("; ")}`);
    this.name = "InvalidPersonaProfileV2Error";
    this.errors = errors;
  }
}

type ObjectValue = Record<string, unknown>;
type ValidationContext = { errors: PersonaProfileValidationError[] };

function field(path: string, name: string | number): string {
  return path ? `${path}.${name}` : String(name);
}

function report(ctx: ValidationContext, path: string, code: PersonaProfileValidationErrorCode, message: string): void {
  ctx.errors.push({ path, code, message });
}

function object(
  ctx: ValidationContext,
  value: unknown,
  path: string,
  required: readonly string[],
  allowed: readonly string[],
): ObjectValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    report(ctx, path, "type", "must be an object");
    return undefined;
  }
  const out = value as ObjectValue;
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(out, name)) {
      report(ctx, field(path, name), "required", "is required");
    }
  }
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(out)) {
    if (!allowedSet.has(name)) report(ctx, field(path, name), "additional_property", "is not allowed");
  }
  return out;
}

function stringValue(
  ctx: ValidationContext,
  value: unknown,
  path: string,
  minLength = 0,
  maxLength?: number,
): value is string {
  if (typeof value !== "string") {
    report(ctx, path, "type", "must be a string");
    return false;
  }
  const length = [...value].length;
  if (length < minLength || (maxLength !== undefined && length > maxLength)) {
    report(ctx, path, "length", `length must be between ${minLength} and ${maxLength ?? "unbounded"}`);
    return false;
  }
  return true;
}

function nonEmptyString(ctx: ValidationContext, value: unknown, path: string): value is string {
  return stringValue(ctx, value, path, 1, 512);
}

function numberValue(
  ctx: ValidationContext,
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  integer = false,
  exclusiveMinimum = false,
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    report(ctx, path, "type", `must be a finite ${integer ? "integer" : "number"}`);
    return false;
  }
  if ((exclusiveMinimum ? value <= minimum : value < minimum) || value > maximum) {
    report(ctx, path, "range", `must be ${exclusiveMinimum ? ">" : ">="} ${minimum} and <= ${maximum}`);
    return false;
  }
  return true;
}

function booleanValue(ctx: ValidationContext, value: unknown, path: string): value is boolean {
  if (typeof value !== "boolean") {
    report(ctx, path, "type", "must be a boolean");
    return false;
  }
  return true;
}

function enumValue(ctx: ValidationContext, value: unknown, path: string, values: readonly unknown[]): boolean {
  if (!values.includes(value)) {
    report(ctx, path, "enum", `must be one of ${values.map(String).join(", ")}`);
    return false;
  }
  return true;
}

function arrayValue(ctx: ValidationContext, value: unknown, path: string, minimum = 0): unknown[] | undefined {
  if (!Array.isArray(value)) {
    report(ctx, path, "type", "must be an array");
    return undefined;
  }
  if (value.length < minimum) report(ctx, path, "length", `must contain at least ${minimum} item(s)`);
  return value;
}

function stringArray(ctx: ValidationContext, value: unknown, path: string, minimum: number): string[] | undefined {
  const values = arrayValue(ctx, value, path, minimum);
  if (!values) return undefined;
  values.forEach((item, index) => nonEmptyString(ctx, item, field(path, index)));
  const strings = values.filter((item): item is string => typeof item === "string");
  if (new Set(strings).size !== strings.length) report(ctx, path, "unique", "must not contain duplicate items");
  return values as string[];
}

function validateDateTime(ctx: ValidationContext, value: unknown, path: string): void {
  if (!stringValue(ctx, value, path)) return;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) {
    report(ctx, path, "format", "must be an RFC 3339 date-time");
    return;
  }
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const validDay = m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth[m - 1];
  // RFC 3339 permits 60 only for an inserted leap second.
  if (!validDay || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60
      || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) {
    report(ctx, path, "format", "must be an RFC 3339 date-time");
  }
}

function validateMetadata(ctx: ValidationContext, value: unknown): void {
  const path = "metadata";
  const v = object(ctx, value, path, ["source", "created_at"], ["source", "created_at", "generator", "source_references"]);
  if (!v) return;
  enumValue(ctx, v.source, `${path}.source`, ["synthetic", "captured"]);
  validateDateTime(ctx, v.created_at, `${path}.created_at`);
  if (v.source === "synthetic" && !Object.prototype.hasOwnProperty.call(v, "generator")) {
    report(ctx, `${path}.generator`, "required", "is required when metadata.source is synthetic");
  }
  if (v.generator !== undefined) {
    const p = `${path}.generator`;
    const generator = object(ctx, v.generator, p, ["name", "version", "model_version"], ["name", "version", "model_version"]);
    if (generator) {
      stringValue(ctx, generator.name, `${p}.name`, 1, 64);
      stringValue(ctx, generator.version, `${p}.version`, 1, 64);
      stringValue(ctx, generator.model_version, `${p}.model_version`, 1, 128);
    }
  }
  if (v.source_references !== undefined) {
    const refs = arrayValue(ctx, v.source_references, `${path}.source_references`);
    refs?.forEach((item, index) => {
      const p = `${path}.source_references.${index}`;
      const ref = object(ctx, item, p, ["name", "revision", "sha256"], ["name", "revision", "sha256"]);
      if (!ref) return;
      stringValue(ctx, ref.name, `${p}.name`, 1, 128);
      stringValue(ctx, ref.revision, `${p}.revision`, 1, 128);
      if (stringValue(ctx, ref.sha256, `${p}.sha256`) && !/^[0-9a-f]{64}$/.test(ref.sha256)) {
        report(ctx, `${p}.sha256`, "pattern", "must be 64 lowercase hexadecimal characters");
      }
    });
  }
}

function validateCompatibility(ctx: ValidationContext, value: unknown): void {
  const p = "compatibility";
  const v = object(ctx, value, p, ["os_family", "architecture", "browser_family", "browser_major"], ["os_family", "architecture", "browser_family", "browser_major"]);
  if (!v) return;
  for (const [name, expected] of Object.entries({ os_family: "windows", architecture: "x86_64", browser_family: "chromium" })) {
    if (v[name] !== expected) report(ctx, `${p}.${name}`, "const", `must equal ${expected}`);
  }
  // Informational: the engine reports its own build's version, so a persona issued for another
  // Chromium major stays valid across engine upgrades.
  if (typeof v.browser_major !== "number" || !Number.isInteger(v.browser_major)) {
    report(ctx, `${p}.browser_major`, "type", "must be an integer");
  } else if (v.browser_major < BROWSER_MAJOR_MIN || v.browser_major > BROWSER_MAJOR_MAX) {
    report(ctx, `${p}.browser_major`, "range", `must be between ${BROWSER_MAJOR_MIN} and ${BROWSER_MAJOR_MAX}`);
  }
}

function validateHardware(ctx: ValidationContext, value: unknown): void {
  const p = "hardware";
  const v = object(ctx, value, p, ["hardware_concurrency", "device_memory_gb", "js_heap_size_limit"], ["hardware_concurrency", "device_memory_gb", "js_heap_size_limit"]);
  if (!v) return;
  numberValue(ctx, v.hardware_concurrency, `${p}.hardware_concurrency`, 1, 256, true);
  enumValue(ctx, v.device_memory_gb, `${p}.device_memory_gb`, [0.25, 0.5, 1, 2, 4, 8, 16, 32]);
  numberValue(ctx, v.js_heap_size_limit, `${p}.js_heap_size_limit`, 1073741824, 17179869184, true);
}

function validateDisplay(ctx: ValidationContext, value: unknown): void {
  const p = "display";
  const names = ["width", "height", "available_width", "available_height", "color_depth", "pixel_depth", "device_pixel_ratio", "max_touch_points", "pointer", "hover", "color_gamut", "dynamic_range"];
  const v = object(ctx, value, p, names, names);
  if (!v) return;
  numberValue(ctx, v.width, `${p}.width`, 320, 16384, true);
  numberValue(ctx, v.height, `${p}.height`, 240, 8640, true);
  numberValue(ctx, v.available_width, `${p}.available_width`, 1, 16384, true);
  numberValue(ctx, v.available_height, `${p}.available_height`, 1, 8640, true);
  numberValue(ctx, v.color_depth, `${p}.color_depth`, 1, 64, true);
  numberValue(ctx, v.pixel_depth, `${p}.pixel_depth`, 1, 64, true);
  numberValue(ctx, v.device_pixel_ratio, `${p}.device_pixel_ratio`, 0, 8, false, true);
  numberValue(ctx, v.max_touch_points, `${p}.max_touch_points`, 0, 32, true);
  enumValue(ctx, v.pointer, `${p}.pointer`, ["none", "coarse", "fine"]);
  enumValue(ctx, v.hover, `${p}.hover`, ["none", "hover"]);
  enumValue(ctx, v.color_gamut, `${p}.color_gamut`, ["srgb", "p3", "rec2020"]);
  enumValue(ctx, v.dynamic_range, `${p}.dynamic_range`, ["standard", "high"]);
  if (typeof v.available_width === "number" && typeof v.width === "number" && v.available_width > v.width) {
    report(ctx, `${p}.available_width`, "invariant", "must not exceed display.width");
  }
  if (typeof v.available_height === "number" && typeof v.height === "number" && v.available_height > v.height) {
    report(ctx, `${p}.available_height`, "invariant", "must not exceed display.height");
  }
  if (typeof v.pixel_depth === "number" && typeof v.color_depth === "number" && v.pixel_depth !== v.color_depth) {
    report(ctx, `${p}.pixel_depth`, "invariant", "must equal display.color_depth");
  }
}

function validateLocale(ctx: ValidationContext, value: unknown): void {
  const p = "locale";
  const v = object(ctx, value, p, ["primary_language", "languages", "timezone"], ["primary_language", "languages", "timezone"]);
  if (!v) return;
  nonEmptyString(ctx, v.primary_language, `${p}.primary_language`);
  const languages = stringArray(ctx, v.languages, `${p}.languages`, 1);
  nonEmptyString(ctx, v.timezone, `${p}.timezone`);
  if (languages && typeof v.primary_language === "string" && languages[0] !== v.primary_language) {
    report(ctx, `${p}.languages`, "invariant", "first language must equal locale.primary_language");
  }
}

function validateWebGLVersion(ctx: ValidationContext, value: unknown, path: string): void {
  const v = object(ctx, value, path, ["parameters", "extensions"], ["parameters", "extensions"]);
  if (!v) return;
  const parameters = object(ctx, v.parameters, `${path}.parameters`, [], WEBGL_PARAMETER_NAMES);
  if (parameters) {
    if (Object.keys(parameters).length < 1) report(ctx, `${path}.parameters`, "length", "must contain at least one property");
    for (const [name, parameter] of Object.entries(parameters)) {
      const p = `${path}.parameters.${name}`;
      if (Array.isArray(parameter)) {
        if (parameter.length !== 2) report(ctx, p, "length", "array value must contain exactly two numbers");
        parameter.forEach((item, index) => numberValue(ctx, item, field(p, index), -Infinity, Infinity));
      } else {
        numberValue(ctx, parameter, p, -Infinity, Infinity);
      }
    }
  }
  stringArray(ctx, v.extensions, `${path}.extensions`, 0);
}

/** Reject limits no driver produces, as the engine's strict loader does (a profile the engine
 *  would reject must not launch silently with no persona). Runs only when the rest is shape-valid. */
function validateWebGLCoherence(ctx: ValidationContext, root: ObjectValue): void {
  if (ctx.errors.length) return;
  const compat = root.compatibility as ObjectValue | undefined;
  const gl = (root.graphics as ObjectValue | undefined)?.webgl as ObjectValue | undefined;
  const params = (set: unknown) => ((set as ObjectValue | undefined)?.parameters ?? undefined) as Record<string, unknown> | undefined;
  const messages = webglLimitViolations(
    String(compat?.os_family), String(compat?.browser_family), params(gl?.webgl1), params(gl?.webgl2));
  for (const message of messages) report(ctx, "graphics.webgl.parameters", "invariant", message);
}

export function gpuFamilies(text: string): Set<string> {
  const patterns: [string, RegExp][] = [
    ["intel", /\bintel\b|\bgen[- ]?\d|(?:0x)?8086\b/i],
    ["nvidia", /\bnvidia\b|\bgeforce\b|\bquadro\b|\b[rg]tx\s*\d|(?:0x)?10de\b/i],
    ["amd", /\bamd\b|advanced micro devices|\bati\b|\bradeon\b|\brdna\b|(?:0x)?1002\b/i],
    ["qualcomm", /\bqualcomm\b|\badreno\b|(?:0x)?17cb\b/i],
    ["software", /swiftshader|\bwarp\b|software adapter/i],
  ];
  return new Set(patterns.filter(([, pattern]) => pattern.test(text)).map(([family]) => family));
}

function validateGraphics(ctx: ValidationContext, value: unknown): void {
  const p = "graphics";
  const v = object(ctx, value, p, ["webgl", "webgpu"], ["webgl", "webgpu"]);
  if (!v) return;
  const glPath = `${p}.webgl`;
  const gl = object(ctx, v.webgl, glPath, ["unmasked_vendor", "unmasked_renderer", "webgl1", "webgl2"], ["unmasked_vendor", "unmasked_renderer", "webgl1", "webgl2"]);
  if (gl) {
    nonEmptyString(ctx, gl.unmasked_vendor, `${glPath}.unmasked_vendor`);
    nonEmptyString(ctx, gl.unmasked_renderer, `${glPath}.unmasked_renderer`);
    validateWebGLVersion(ctx, gl.webgl1, `${glPath}.webgl1`);
    validateWebGLVersion(ctx, gl.webgl2, `${glPath}.webgl2`);
  }
  const gpuPath = `${p}.webgpu`;
  const gpu = object(ctx, v.webgpu, gpuPath, ["vendor", "architecture", "is_fallback_adapter", "features", "limits"], ["vendor", "architecture", "device", "description", "is_fallback_adapter", "features", "limits"]);
  if (gpu) {
    nonEmptyString(ctx, gpu.vendor, `${gpuPath}.vendor`);
    nonEmptyString(ctx, gpu.architecture, `${gpuPath}.architecture`);
    if (gpu.device !== undefined) stringValue(ctx, gpu.device, `${gpuPath}.device`, 0, 256);
    if (gpu.description !== undefined) stringValue(ctx, gpu.description, `${gpuPath}.description`, 0, 512);
    booleanValue(ctx, gpu.is_fallback_adapter, `${gpuPath}.is_fallback_adapter`);
    stringArray(ctx, gpu.features, `${gpuPath}.features`, 0);
    const limits = object(ctx, gpu.limits, `${gpuPath}.limits`, [], WEBGPU_LIMIT_NAMES);
    if (limits) {
      if (Object.keys(limits).length < 1) report(ctx, `${gpuPath}.limits`, "length", "must contain at least one property");
      for (const [name, limit] of Object.entries(limits)) {
        numberValue(ctx, limit, `${gpuPath}.limits.${name}`, 0, Number.MAX_SAFE_INTEGER, true);
      }
    }
  }
  if (gl && gpu && typeof gl.unmasked_vendor === "string" && typeof gl.unmasked_renderer === "string" && typeof gpu.vendor === "string") {
    const webglFamilies = gpuFamilies(`${gl.unmasked_vendor} ${gl.unmasked_renderer}`);
    const webgpuFamilies = gpuFamilies([gpu.vendor, gpu.architecture, gpu.device, gpu.description].filter((item): item is string => typeof item === "string").join(" "));
    if (webglFamilies.size && webgpuFamilies.size
        && (webglFamilies.size !== 1 || webgpuFamilies.size !== 1
          || ![...webglFamilies].every((family) => webgpuFamilies.has(family)))) {
      report(ctx, `${gpuPath}.vendor`, "invariant", "must identify the same GPU family as graphics.webgl");
    }
  }
}

function validateAudio(ctx: ValidationContext, value: unknown): void {
  const p = "audio";
  const names = ["sample_rate", "base_latency", "output_latency"];
  const v = object(ctx, value, p, names, names);
  if (!v) return;
  numberValue(ctx, v.sample_rate, `${p}.sample_rate`, 8000, 384000);
  numberValue(ctx, v.base_latency, `${p}.base_latency`, 0, 10);
  numberValue(ctx, v.output_latency, `${p}.output_latency`, 0, 10);
}

function validateNetwork(ctx: ValidationContext, value: unknown): void {
  const p = "network";
  const v = object(ctx, value, p, [], ["rtt_ms", "downlink_mbps", "effective_type"]);
  if (!v) return;
  if (v.rtt_ms !== undefined) numberValue(ctx, v.rtt_ms, `${p}.rtt_ms`, 0, 3000, false, true);
  if (v.downlink_mbps !== undefined) numberValue(ctx, v.downlink_mbps, `${p}.downlink_mbps`, 0, 1000, false, true);
  if (v.effective_type !== undefined) enumValue(ctx, v.effective_type, `${p}.effective_type`, ["slow-2g", "2g", "3g", "4g"]);
}

function validateFonts(ctx: ValidationContext, value: unknown): void {
  const v = object(ctx, value, "fonts", ["families"], ["families"]);
  if (v) stringArray(ctx, v.families, "fonts.families", 1);
}

function validateSpeech(ctx: ValidationContext, value: unknown): void {
  const p = "speech";
  const v = object(ctx, value, p, ["voices"], ["voices"]);
  if (!v) return;
  const voices = arrayValue(ctx, v.voices, `${p}.voices`, 1);
  let defaults = 0;
  voices?.forEach((item, index) => {
    const vp = `${p}.voices.${index}`;
    const names = ["voice_uri", "name", "language", "local_service", "default"];
    const voice = object(ctx, item, vp, names, names);
    if (!voice) return;
    nonEmptyString(ctx, voice.voice_uri, `${vp}.voice_uri`);
    nonEmptyString(ctx, voice.name, `${vp}.name`);
    nonEmptyString(ctx, voice.language, `${vp}.language`);
    booleanValue(ctx, voice.local_service, `${vp}.local_service`);
    if (booleanValue(ctx, voice.default, `${vp}.default`) && voice.default) defaults++;
  });
  if (defaults > 1) report(ctx, `${p}.voices`, "invariant", "must contain at most one default voice");
}

function validateCodec(ctx: ValidationContext, value: unknown, path: string): void {
  const names = ["supported", "smooth", "power_efficient"];
  const v = object(ctx, value, path, names, names);
  if (!v) return;
  names.forEach((name) => booleanValue(ctx, v[name], `${path}.${name}`));
}

function validateMedia(ctx: ValidationContext, value: unknown): void {
  const p = "media";
  const v = object(ctx, value, p, ["codecs", "devices"], ["codecs", "devices"]);
  if (!v) return;
  const codecNames = ["h264", "vp8", "vp9", "av1", "hevc"];
  const codecs = object(ctx, v.codecs, `${p}.codecs`, codecNames, codecNames);
  if (codecs) codecNames.forEach((name) => validateCodec(ctx, codecs[name], `${p}.codecs.${name}`));
  const devices = arrayValue(ctx, v.devices, `${p}.devices`, 1);
  devices?.forEach((item, index) => {
    const dp = `${p}.devices.${index}`;
    const names = ["kind", "label", "device_id", "group_id"];
    const device = object(ctx, item, dp, names, names);
    if (!device) return;
    enumValue(ctx, device.kind, `${dp}.kind`, ["audioinput", "audiooutput", "videoinput"]);
    stringValue(ctx, device.label, `${dp}.label`, 0, 256);
    nonEmptyString(ctx, device.device_id, `${dp}.device_id`);
    nonEmptyString(ctx, device.group_id, `${dp}.group_id`);
  });
}

/** Validate an unknown value without throwing. Successful validation narrows it to the canonical type. */
export function validatePersonaProfileV2(value: unknown): PersonaProfileValidationResult {
  const ctx: ValidationContext = { errors: [] };
  const names = ["schema_version", "metadata", "compatibility", "hardware", "display", "locale", "graphics", "audio", "fonts", "speech", "media"];
  const root = object(ctx, value, "", names, [...names, "network"]);
  if (root) {
    if (root.network !== undefined) validateNetwork(ctx, root.network);
    if (root.schema_version !== 2) report(ctx, "schema_version", "const", "must equal 2");
    validateMetadata(ctx, root.metadata);
    validateCompatibility(ctx, root.compatibility);
    validateHardware(ctx, root.hardware);
    validateDisplay(ctx, root.display);
    validateLocale(ctx, root.locale);
    validateGraphics(ctx, root.graphics);
    validateWebGLCoherence(ctx, root);
    validateAudio(ctx, root.audio);
    validateFonts(ctx, root.fonts);
    validateSpeech(ctx, root.speech);
    validateMedia(ctx, root.media);
  }
  if (ctx.errors.length) return { valid: false, errors: ctx.errors };
  return { valid: true, value: value as PersonaProfileV2, errors: [] };
}

/** Throw a field-addressed {@link InvalidPersonaProfileV2Error} unless value is valid. */
export function assertPersonaProfileV2(value: unknown): asserts value is PersonaProfileV2 {
  const result = validatePersonaProfileV2(value);
  if (!result.valid) throw new InvalidPersonaProfileV2Error(result.errors);
}

/** Validate and return a typed profile, suitable for an encoding boundary. */
export function parsePersonaProfileV2(value: unknown): PersonaProfileV2 {
  assertPersonaProfileV2(value);
  return value;
}
