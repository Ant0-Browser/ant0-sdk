/** Device-local, atomic persistence for canonical synthetic identities. */

import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { assertPersonaProfileV2, type PersonaProfileV2 } from "./persona-profile-v2.js";
import { assertPersonaProfileV4, type PersonaProfileV4 } from "./persona-profile-v4.js";
import { isCanvasNoiseKey, newCanvasNoiseKey } from "./canvas.js";
import { selectPersonaTemplateEntry, type PersonaTemplate } from "./template-selection.js";
import { generatePersonaProfile, type PopulationModel } from "./population-model.js";
import { SdkInputError, SdkRangeError, SdkTypeError } from "./errors.js";
import type { ErrorClass } from "./errors.js";

export const IDENTITY_WRAPPER_VERSION = 1 as const;
export const GENERATED_IDENTITY_WRAPPER_VERSION = 2 as const;
/** Wrapper version that stores a schema 4 persona (the new persona format). */
export const ISSUED_IDENTITY_WRAPPER_VERSION = 3 as const;
export const TEMPLATE_SELECTION_ALGORITHM = "ant0/persona-template-selection/v1" as const;
export const GENERATE_ALGORITHM = "ant0/persona-generate/v1" as const;
const FILENAME_DOMAIN = Buffer.from("ant0/identity-filename/v1\0", "ascii");
const DEVICE_KEY_NAME = "device.key";
const WRAPPER_FIELDS = [
  "created_at", "profile", "schema_version", "template_id", "template_selection_algorithm",
];
const WRAPPER_V2_FIELDS = ["algorithm", "algorithm_ref", "created_at", "profile", "schema_version"];
const ALGORITHM_V3 = /^ant0\/persona-generate\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Optional on every wrapper version when reading. Written only by wrapper v3 (new-format identities):
 * older releases require the exact v1/v2 field set, and these files travel to them in sync bundles.
 * Identities without a stored key use the key derived from the identity key (see canvas.ts). */
const CANVAS_KEY_FIELD = "canvas_noise_key";
const SAFE_TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export interface PersistedIdentity {
  schema_version: 1;
  template_selection_algorithm: typeof TEMPLATE_SELECTION_ALGORITHM;
  template_id: string;
  created_at: string;
  profile: PersonaProfileV2;
  /** Accepted when present (16 lowercase hex), but this release never writes it into v1/v2 files.
   * Use `canvasNoiseKeyFor` to read it (it derives the key when absent). Existing files are never rewritten. */
  canvas_noise_key?: string;
}

export interface GeneratedPersistedIdentity {
  schema_version: 2;
  algorithm: typeof GENERATE_ALGORITHM;
  algorithm_ref: string;
  created_at: string;
  profile: PersonaProfileV2;
  canvas_noise_key?: string;
}

/** Wrapper for a persona in the new format (schema_version 4), as issued by the cloud. */
export interface IssuedPersistedIdentity {
  schema_version: 3;
  /** The generator that issued the persona, e.g. "ant0/persona-generate/v2.2". */
  algorithm: string;
  /** The issuing model version, e.g. "population-model-v2.2". */
  algorithm_ref: string;
  created_at: string;
  profile: PersonaProfileV4;
  /** Required in v3: a new-format identity always carries its own random key (16 lowercase hex). */
  canvas_noise_key: string;
}

export type AnyPersistedIdentity = PersistedIdentity | GeneratedPersistedIdentity | IssuedPersistedIdentity;

export interface IdentityPersistenceOptions {
  identityDir?: string;
}

export class IdentityPersistenceError extends Error {
  readonly code: string = "sdk.identity_state_unsafe";
  readonly errorClass: ErrorClass = "environment";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdentityPersistenceError";
  }
}

function keyBytes(value: string): Buffer {
  if (typeof value !== "string") throw new SdkTypeError("sdk.identity_state_invalid", "identityKey must be a string");
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else throw new SdkTypeError("sdk.identity_state_invalid", "identityKey must contain only Unicode scalar values");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new SdkTypeError("sdk.identity_state_invalid", "identityKey must contain only Unicode scalar values");
    }
  }
  return Buffer.from(value, "utf8");
}

/** Return the configured identity directory without creating it. */
export function resolveIdentityDirectory(): string {
  return process.env.ANT0_BROWSER_IDENTITY_DIR || join(homedir(), ".ant0-browser", "identities");
}

/** Return the opaque filename for an identity key on this device. */
export function identityFilename(identityKey: string, deviceKey: Uint8Array): string {
  if (!(deviceKey instanceof Uint8Array) || deviceKey.byteLength !== 32) {
    throw new SdkRangeError("sdk.identity_state_invalid", "deviceKey must be exactly 32 bytes");
  }
  return createHmac("sha256", deviceKey)
    .update(FILENAME_DOMAIN)
    .update(keyBytes(identityKey))
    .digest("hex") + ".json";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* permissions are best effort on Windows */ }
  try {
    if (!lstatSync(path).isDirectory()) throw new SdkInputError("sdk.identity_state_invalid", "not a directory");
  } catch (error) {
    throw new IdentityPersistenceError(`identity path is not a directory: ${path}`, { cause: error });
  }
}

function readRegular(path: string): Buffer {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new IdentityPersistenceError(`identity state is not a regular file: ${path}`);
    }
    return readFileSync(path);
  } catch (error) {
    if (error instanceof IdentityPersistenceError) throw error;
    throw new IdentityPersistenceError(`cannot read identity state: ${path}`, { cause: error });
  }
}

function publish(path: string, data: Uint8Array): boolean {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { chmodSync(temp, 0o600); } catch { /* permissions are best effort on Windows */ }
    try {
      linkSync(temp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Load, or atomically create once, the installation-local 32-byte key. */
export function loadOrCreateDeviceKey(options: IdentityPersistenceOptions = {}): Buffer {
  const directory = options.identityDir ?? resolveIdentityDirectory();
  privateDirectory(directory);
  const path = join(directory, DEVICE_KEY_NAME);
  let key: Buffer;
  if (existsSync(path)) {
    key = readRegular(path);
  } else {
    const candidate = randomBytes(32);
    key = publish(path, candidate) ? candidate : readRegular(path);
  }
  if (key.byteLength !== 32) {
    throw new IdentityPersistenceError(`device key must contain exactly 32 bytes: ${path}`);
  }
  try { chmodSync(path, 0o600); } catch { /* permissions are best effort on Windows */ }
  return key;
}

function validateCreatedAt(value: unknown): void {
  if (typeof value !== "string") throw new IdentityPersistenceError("created_at must be an RFC 3339 date-time");
  const match = RFC3339.exec(value);
  if (!match) throw new IdentityPersistenceError("created_at must be an RFC 3339 date-time");
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23
      || Number(minute) > 59 || Number(second) > 60 || Number(offsetHour ?? 0) > 23
      || Number(offsetMinute ?? 0) > 59) {
    throw new IdentityPersistenceError("created_at must be an RFC 3339 date-time");
  }
}

/** Strictly validate a persistence wrapper and its complete canonical profile.
 *
 * Wrapper v1 records template selection; wrapper v2 records population-model generation. Only a
 * schema_version of exactly 2 routes to the v2 shape, so a v1-shaped file with a mutated version is
 * still rejected. */
export function validatePersistedIdentity(value: unknown): AnyPersistedIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IdentityPersistenceError("persisted identity must contain exactly the v1 wrapper fields");
  }
  const version = (value as Record<string, unknown>).schema_version;
  if (version === ISSUED_IDENTITY_WRAPPER_VERSION) return validateIssuedWrapper(value);
  if (version === GENERATED_IDENTITY_WRAPPER_VERSION) return validateGeneratedWrapper(value);
  return validateTemplateWrapper(value);
}

/** The wrapper's field names without the optional canvas key, sorted, for the exact-fields check. */
function requiredKeys(value: object): string {
  return Object.keys(value).filter((k) => k !== CANVAS_KEY_FIELD).sort().join("\0");
}

function validateCanvasKeyField(wrapper: Record<string, unknown>): void {
  if (CANVAS_KEY_FIELD in wrapper && !isCanvasNoiseKey(wrapper[CANVAS_KEY_FIELD])) {
    throw new IdentityPersistenceError("canvas_noise_key must be 16 lowercase hex characters");
  }
}

function validateIssuedWrapper(value: object): IssuedPersistedIdentity {
  if (requiredKeys(value) !== WRAPPER_V2_FIELDS.join("\0")) {
    throw new IdentityPersistenceError("persisted identity must contain exactly the v3 wrapper fields");
  }
  const wrapper = value as Record<string, unknown>;
  if (typeof wrapper.algorithm !== "string" || !ALGORITHM_V3.test(wrapper.algorithm)) {
    throw new IdentityPersistenceError("unsupported generate algorithm");
  }
  if (typeof wrapper.algorithm_ref !== "string" || !SAFE_TEMPLATE_ID.test(wrapper.algorithm_ref)) {
    throw new IdentityPersistenceError("algorithm_ref is unsafe");
  }
  if (!(CANVAS_KEY_FIELD in wrapper)) {
    throw new IdentityPersistenceError("canvas_noise_key is required in a v3 wrapper");
  }
  validateCanvasKeyField(wrapper);
  validateCreatedAt(wrapper.created_at);
  try {
    assertPersonaProfileV4(wrapper.profile);
  } catch (error) {
    throw new IdentityPersistenceError(`invalid persisted profile: ${String(error)}`, { cause: error });
  }
  return value as IssuedPersistedIdentity;
}

function validateTemplateWrapper(value: object): PersistedIdentity {
  if (requiredKeys(value) !== WRAPPER_FIELDS.join("\0")) {
    throw new IdentityPersistenceError("persisted identity must contain exactly the v1 wrapper fields");
  }
  const wrapper = value as Record<string, unknown>;
  validateCanvasKeyField(wrapper);
  if (wrapper.schema_version !== IDENTITY_WRAPPER_VERSION) {
    throw new IdentityPersistenceError("schema_version must equal 1");
  }
  if (wrapper.template_selection_algorithm !== TEMPLATE_SELECTION_ALGORITHM) {
    throw new IdentityPersistenceError("unsupported template_selection_algorithm");
  }
  if (typeof wrapper.template_id !== "string" || !SAFE_TEMPLATE_ID.test(wrapper.template_id)) {
    throw new IdentityPersistenceError("template_id is unsafe");
  }
  validateCreatedAt(wrapper.created_at);
  try {
    assertPersonaProfileV2(wrapper.profile);
  } catch (error) {
    throw new IdentityPersistenceError(`invalid persisted profile: ${String(error)}`, { cause: error });
  }
  return value as PersistedIdentity;
}

function validateGeneratedWrapper(value: object): GeneratedPersistedIdentity {
  if (requiredKeys(value) !== WRAPPER_V2_FIELDS.join("\0")) {
    throw new IdentityPersistenceError("persisted identity must contain exactly the v2 wrapper fields");
  }
  const wrapper = value as Record<string, unknown>;
  validateCanvasKeyField(wrapper);
  if (wrapper.algorithm !== GENERATE_ALGORITHM) {
    throw new IdentityPersistenceError("unsupported generate algorithm");
  }
  if (typeof wrapper.algorithm_ref !== "string" || !SAFE_TEMPLATE_ID.test(wrapper.algorithm_ref)) {
    throw new IdentityPersistenceError("algorithm_ref is unsafe");
  }
  validateCreatedAt(wrapper.created_at);
  try {
    assertPersonaProfileV2(wrapper.profile);
  } catch (error) {
    throw new IdentityPersistenceError(`invalid persisted profile: ${String(error)}`, { cause: error });
  }
  return value as GeneratedPersistedIdentity;
}

function loadPath(path: string): AnyPersistedIdentity {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readRegular(path)));
  } catch (error) {
    if (error instanceof IdentityPersistenceError) throw error;
    throw new IdentityPersistenceError(`invalid persisted identity JSON: ${path}`, { cause: error });
  }
  return validatePersistedIdentity(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SdkTypeError("sdk.identity_state_invalid", "identity contains a non-JSON value");
  return encoded;
}

/** Load an identity, returning undefined when no device key or identity exists. */
export function loadPersistedIdentity(
  identityKey: string,
  options: IdentityPersistenceOptions = {},
): AnyPersistedIdentity | undefined {
  keyBytes(identityKey);
  const directory = options.identityDir ?? resolveIdentityDirectory();
  const keyPath = join(directory, DEVICE_KEY_NAME);
  if (!existsSync(keyPath)) return undefined;
  const deviceKey = readRegular(keyPath);
  if (deviceKey.byteLength !== 32) {
    throw new IdentityPersistenceError(`device key must contain exactly 32 bytes: ${keyPath}`);
  }
  const path = join(directory, identityFilename(identityKey, deviceKey));
  return existsSync(path) ? clone(loadPath(path)) : undefined;
}

/** Load an authoritative identity or atomically select and persist its first value. */
export function createOrLoadIdentity(
  identityKey: string,
  templates: readonly PersonaTemplate[],
  options: IdentityPersistenceOptions = {},
): PersistedIdentity {
  keyBytes(identityKey);
  const directory = options.identityDir ?? resolveIdentityDirectory();
  const deviceKey = loadOrCreateDeviceKey({ identityDir: directory });
  const path = join(directory, identityFilename(identityKey, deviceKey));
  if (existsSync(path)) return clone(loadPath(path)) as PersistedIdentity;

  const selected = selectPersonaTemplateEntry(identityKey, deviceKey.toString("hex"), templates);
  const wrapper: PersistedIdentity = {
    schema_version: IDENTITY_WRAPPER_VERSION,
    template_selection_algorithm: TEMPLATE_SELECTION_ALGORITHM,
    template_id: selected.id,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    profile: selected.profile,
    // No canvas_noise_key in a v1 file: releases before this one require the exact v1 field set
    //. The key is derived on
    // read; only new-format (v3) identities store a random one.
  };
  validatePersistedIdentity(wrapper);
  const data = Buffer.from(`${stableJson(wrapper)}\n`, "utf8");
  return publish(path, data) ? clone(wrapper) : clone(loadPath(path)) as PersistedIdentity;
}

/** Load an authoritative identity or atomically generate and persist its first value.
 *
 * The population model is consulted only when a new identity is created; an existing file is
 * authoritative, so a model or k_floor change never mutates an already-created identity. */
export function createOrLoadGeneratedIdentity(
  identityKey: string,
  model: PopulationModel,
  options: IdentityPersistenceOptions = {},
): GeneratedPersistedIdentity {
  keyBytes(identityKey);
  const directory = options.identityDir ?? resolveIdentityDirectory();
  const deviceKey = loadOrCreateDeviceKey({ identityDir: directory });
  const path = join(directory, identityFilename(identityKey, deviceKey));
  if (existsSync(path)) return clone(loadPath(path)) as GeneratedPersistedIdentity;

  const profile = generatePersonaProfile(identityKey, deviceKey.toString("hex"), model);
  const wrapper: GeneratedPersistedIdentity = {
    schema_version: GENERATED_IDENTITY_WRAPPER_VERSION,
    algorithm: GENERATE_ALGORITHM,
    algorithm_ref: model.model_version,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    profile,
    // No canvas_noise_key: wrapper v2 keeps the field set older readers require; its key is derived.
  };
  validatePersistedIdentity(wrapper);
  const data = Buffer.from(`${stableJson(wrapper)}\n`, "utf8");
  return publish(path, data) ? clone(wrapper) : clone(loadPath(path)) as GeneratedPersistedIdentity;
}

export interface IssuedIdentityRecord {
  /** The persona as the cloud issued it: schema_version 2 or 4. */
  profile: PersonaProfileV2 | PersonaProfileV4;
  /** The generator that issued it, e.g. "ant0/persona-generate/v1" (schema 2) or "ant0/persona-generate/v2.2" (schema 4). */
  algorithm: string;
  /** The issuing model version, e.g. "population-model-v2.2". */
  algorithmRef: string;
}

/** Store, or load if one already exists, a persona issued elsewhere (the cloud, through the daemon).
 *
 * A schema 2 persona is stored in a wrapper v2 and a schema 4 persona in a wrapper v3. The file is
 * named and written like every other identity file, atomically, and an existing file for the key is
 * authoritative and returned unchanged. A new schema 4 file (wrapper v3) gets a fresh random
 * `canvas_noise_key`; a schema 2 file (wrapper v2) gets none, and its key is derived on read. */
export function createOrLoadIssuedIdentity(
  identityKey: string,
  record: IssuedIdentityRecord,
  options: IdentityPersistenceOptions = {},
): GeneratedPersistedIdentity | IssuedPersistedIdentity {
  keyBytes(identityKey);
  const directory = options.identityDir ?? resolveIdentityDirectory();
  const deviceKey = loadOrCreateDeviceKey({ identityDir: directory });
  const path = join(directory, identityFilename(identityKey, deviceKey));
  if (existsSync(path)) return clone(loadPath(path)) as GeneratedPersistedIdentity | IssuedPersistedIdentity;
  const v4 = (record.profile as { schema_version?: unknown }).schema_version === 4;
  const wrapper = {
    schema_version: v4 ? ISSUED_IDENTITY_WRAPPER_VERSION : GENERATED_IDENTITY_WRAPPER_VERSION,
    algorithm: record.algorithm,
    algorithm_ref: record.algorithmRef,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    profile: record.profile,
    // Only the new-format (v3) wrapper stores a key; v2 keeps the field set older readers require.
    ...(v4 ? { canvas_noise_key: newCanvasNoiseKey() } : {}),
  } as GeneratedPersistedIdentity | IssuedPersistedIdentity;
  validatePersistedIdentity(wrapper);
  const data = Buffer.from(`${stableJson(wrapper)}\n`, "utf8");
  return publish(path, data) ? clone(wrapper) : clone(loadPath(path)) as GeneratedPersistedIdentity | IssuedPersistedIdentity;
}
