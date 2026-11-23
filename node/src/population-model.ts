/** Deterministic population-model generator for synthetic mode (ant0/persona-generate/v1).
 *
 * Byte-for-byte identical to the Python reference in python/ant0browser/population_model.py.
 * Recombines validated real hardware bundles into an ordinary-looking persona-profile-v2 using a
 * SHA-256 counter DRBG and integer weighted sampling. The same identity key, device key, and model
 * always produce the same profile; golden vectors prove parity with Python. */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHROMIUM_MAJOR } from "./chromium-version.js";
import { assertPersonaProfileV2, type PersonaProfileV2 } from "./persona-profile-v2.js";
import { SdkTypeError } from "./errors.js";
import { builtinSpeechVoices, speechValuesForLocale } from "./speech-coherence.js";
import type { ErrorClass } from "./errors.js";
import { hasAngleDeviceId, normaliseWin11DisplayRow } from "./windows-coherence.js";

export const GENERATE_ALGORITHM = "ant0/persona-generate/v1";
export const GENERATOR_NAME = "ant0-population-generator";
export const GENERATOR_VERSION = "1.1.0";
const DOMAIN = Buffer.from("ant0/persona-generate/v1\0", "ascii");

/** Fixed sampling order; each group is drawn exactly once. */
export const GENERATION_ORDER = ["graphics", "cpu_mem", "display", "audio", "fonts", "speech"] as const;
const CONSTANT_KEYS = ["js_heap_size_limit", "desktop_display", "codecs", "devices", "locale"] as const;
const DISPLAY_VARIABLE_KEYS = [
  "width", "height", "available_width", "available_height",
  "color_depth", "pixel_depth", "device_pixel_ratio",
] as const;

export interface PopulationModelValue {
  id: string;
  support: number;
  weight: number;
  payload: Record<string, unknown> | unknown[];
}
export interface PopulationModel {
  model_version: string;
  generate_algorithm: string;
  created_at: string;
  k_floor: number;
  source: { revision?: string; files: Record<string, { sha256: string }> };
  constants: Record<string, any>;
  groups: Record<string, { values: PopulationModelValue[] }>;
}

export class PopulationModelError extends Error {
  readonly code: string = "sdk.population_model_invalid";
  readonly errorClass: ErrorClass = "expected";
  constructor(message: string) {
    super(message);
    this.name = "PopulationModelError";
  }
}

function keyBytes(value: string, name: string): Buffer {
  if (typeof value !== "string") throw new SdkTypeError("sdk.population_invalid", `${name} must be a string`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else throw new SdkTypeError("sdk.population_invalid", `${name} must contain only Unicode scalar values`);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new SdkTypeError("sdk.population_invalid", `${name} must contain only Unicode scalar values`);
    }
  }
  return Buffer.from(value, "utf8");
}

function u64be(value: number | bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

function frame(value: Buffer): Buffer {
  return Buffer.concat([u64be(value.length), value]);
}

function seed(identityKey: string, deviceKey: string, modelVersion: string): Buffer {
  return createHash("sha256")
    .update(DOMAIN)
    .update(frame(keyBytes(identityKey, "identityKey")))
    .update(frame(keyBytes(deviceKey, "deviceKey")))
    .update(frame(Buffer.from(modelVersion, "utf8")))
    .digest();
}

/** SHA-256 counter DRBG: block i is SHA256(seed || u64be(i)); bytes are drawn in order. */
class Drbg {
  private readonly seed: Buffer;
  private counter = 0;
  private buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(seedBytes: Buffer) {
    this.seed = seedBytes;
  }

  drawU64(): bigint {
    while (this.buffer.length - this.offset < 8) {
      const block = createHash("sha256").update(this.seed).update(u64be(this.counter)).digest();
      this.counter += 1;
      this.buffer = Buffer.concat([this.buffer, block]);
    }
    const value = this.buffer.readBigUInt64BE(this.offset);
    this.offset += 8;
    return value;
  }
}

function choose(values: PopulationModelValue[], drbg: Drbg): PopulationModelValue {
  let total = 0n;
  for (const value of values) total += BigInt(value.weight);
  const target = drbg.drawU64() % total;
  let cumulative = 0n;
  for (const value of values) {
    cumulative += BigInt(value.weight);
    if (target < cumulative) return value;
  }
  return values[values.length - 1]!;
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PopulationModelError(message);
}

function validateModel(model: unknown): asserts model is PopulationModel {
  ensure(typeof model === "object" && model !== null && !Array.isArray(model), "model must be an object");
  const m = model as Record<string, any>;
  ensure(m.generate_algorithm === GENERATE_ALGORITHM, "unsupported generate_algorithm");
  ensure(typeof m.model_version === "string" && m.model_version, "model_version must be a nonempty string");
  ensure(typeof m.created_at === "string" && m.created_at, "created_at must be a nonempty string");
  ensure(Number.isInteger(m.k_floor) && m.k_floor >= 1, "k_floor must be >= 1");
  ensure(typeof m.constants === "object" && m.constants !== null
    && CONSTANT_KEYS.every((key) => key in m.constants), "constants are incomplete");
  ensure(typeof m.source === "object" && m.source !== null
    && typeof m.source.files === "object" && m.source.files !== null, "source provenance is incomplete");
  ensure(typeof m.groups === "object" && m.groups !== null
    && GENERATION_ORDER.every((name) => name in m.groups)
    && Object.keys(m.groups).length === GENERATION_ORDER.length,
    "groups must be exactly the six generation bundles");
  for (const name of GENERATION_ORDER) {
    const values = m.groups[name]?.values;
    ensure(Array.isArray(values) && values.length > 0, `group ${name} has no values`);
    for (const value of values) {
      ensure(typeof value === "object" && value !== null
        && typeof value.id === "string"
        && Number.isInteger(value.weight) && value.weight >= 1
        && Number.isInteger(value.support)
        && typeof value.payload === "object" && value.payload !== null,
        `group ${name} has a malformed value`);
    }
  }
}

/** Load and structurally validate a population model from a path, directory, or object. */
export function loadPopulationModel(source: string | PopulationModel): PopulationModel {
  let model: unknown;
  if (typeof source === "string") {
    let path = resolve(source);
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      throw new PopulationModelError(`population model is not a regular file: ${path}`);
    }
    if (stat.isDirectory()) {
      path = resolve(path, "population-model-v1.json");
      try { stat = lstatSync(path); } catch (error) {
        throw new PopulationModelError(`population model is not a regular file: ${path}`);
      }
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new PopulationModelError(`population model is not a regular file: ${path}`);
    }
    try { model = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
      throw new PopulationModelError(`cannot load population model: ${path}: ${String(error)}`);
    }
  } else {
    model = source;
  }
  validateModel(model);
  return model;
}

function sourceReferences(source: PopulationModel["source"]): Array<{ name: string; revision: string; sha256: string }> {
  const revision = source.revision ?? "";
  return Object.keys(source.files).sort().map((name) => ({
    name, revision, sha256: source.files[name]!.sha256,
  }));
}

/**
 * Rows a generated persona may draw from. Every persona claims Windows 11, so a graphics row must
 * carry ANGLE's 8-digit device id (a row without one is not drawn; ids are never filled in) and a
 * display row a full-width bottom taskbar of 48 px or none: a display row with another work area is
 * normalised to a 48 px bottom taskbar, keeping its size and weight. Throws when a group has no usable row.
 */
function coherentRows(group: string, values: PopulationModelValue[]): PopulationModelValue[] {
  if (group !== "graphics" && group !== "display") return values;
  let kept: PopulationModelValue[];
  if (group === "graphics") {
    kept = values.filter((value) => hasAngleDeviceId((value.payload as Record<string, any>).webgl?.unmasked_renderer));
  } else {
    kept = [];
    for (const value of values) {
      const payload = normaliseWin11DisplayRow(value.payload as Record<string, any>);
      if (payload !== undefined) kept.push(payload === value.payload ? value : { ...value, payload });
    }
  }
  ensure(kept.length > 0, group === "graphics"
    ? "no graphics value carries an ANGLE device id"
    : "no display value can be given a Windows 11 work area");
  return kept;
}

/** Deterministically generate and validate one persona-profile-v2 from the model. */
export function generatePersonaProfile(
  identityKey: string,
  deviceKey: string,
  model: PopulationModel,
): PersonaProfileV2 {
  validateModel(model);
  const kFloor = model.k_floor;
  const constants = model.constants;
  const drbg = new Drbg(seed(identityKey, deviceKey, model.model_version));

  const chosen: Record<string, any> = {};
  for (const group of GENERATION_ORDER) {
    const values = coherentRows(group, [...model.groups[group]!.values].sort(
      (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    ));
    if (group === "speech") {
      // The speech group is independent of the other groups and holds captures of every language. Draw
      // only from sets whose default voice is in the persona's language (constants.locale.primary_language);
      // with none, use the engine's built-in Windows set, which the engine localises by Accept-Language.
      // One draw either way, so the stream stays aligned.
      const pool = speechValuesForLocale(values, constants.locale?.primary_language);
      const picked = choose(pool.length ? pool : values, drbg);
      if (pool.length) {
        if (picked.support < kFloor) throw new PopulationModelError(`group ${group} selected a value below k_floor`);
        chosen[group] = structuredClone(picked.payload);
      } else {
        chosen[group] = { voices: builtinSpeechVoices() };
      }
      continue;
    }
    const selected = choose(values, drbg);
    if (selected.support < kFloor) {
      throw new PopulationModelError(`group ${group} selected a value below k_floor`);
    }
    chosen[group] = structuredClone(selected.payload);
  }
  // Note: the model's WebGPU block (features, limits) is emitted unchanged. A stub that blanked features to []
  // and shrank limits was removed: engines older than ant0.8 read features [] as "no features", a strong tell,
  // and only ant0.8 serves the real adapter set for it. It can return once old engines are gone.
  const cpuMem = chosen.cpu_mem as Record<string, unknown>;
  const display = chosen.display as Record<string, unknown>;
  const displayVariable: Record<string, unknown> = {};
  for (const key of DISPLAY_VARIABLE_KEYS) displayVariable[key] = display[key];

  const profile = {
    schema_version: 2,
    metadata: {
      source: "synthetic",
      created_at: model.created_at,
      generator: {
        name: GENERATOR_NAME,
        version: GENERATOR_VERSION,
        model_version: model.model_version,
      },
      source_references: sourceReferences(model.source),
    },
    compatibility: {
      os_family: "windows", architecture: "x86_64",
      browser_family: "chromium", browser_major: CHROMIUM_MAJOR,
    },
    hardware: {
      hardware_concurrency: cpuMem.hardware_concurrency,
      device_memory_gb: cpuMem.device_memory_gb,
      js_heap_size_limit: constants.js_heap_size_limit,
    },
    display: { ...displayVariable, ...structuredClone(constants.desktop_display) },
    locale: structuredClone(constants.locale),
    graphics: chosen.graphics,
    audio: chosen.audio,
    fonts: chosen.fonts,
    speech: chosen.speech,
    media: {
      codecs: structuredClone(constants.codecs),
      devices: structuredClone(constants.devices),
    },
  };
  assertPersonaProfileV2(profile);
  return profile as PersonaProfileV2;
}
