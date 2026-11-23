/**
 * The new persona format (schema_version 4): structural validator and types.
 *
 * Mirrors the cloud's persona validator. Same lenient policy as the
 * format spec section 3.2: unknown keys are ignored, known fields keep strict type checks. This is a
 * structural check only; the engine validates the surfaces. A schema 4 persona is never converted to
 * schema 2 and never travels inline: it goes through the `--fingerprint-profile-file` switch (see
 * ./profile-file.ts).
 */

import { SdkInputError } from "./errors.js";

export interface PersonaProfileV4 {
  schema_version: 4;
  schema_revision: number;
  /** Surfaces the engine must apply; host-supplied surfaces are absent from this list. */
  requires: string[];
  provenance: {
    source: "synthetic";
    model: { version: string; sha256: string; created_at?: string };
    generator?: { name: string; version: string; algorithm: string };
    seed_id?: string;
    noise_key?: string;
    [key: string]: unknown;
  };
  identity: {
    os: { family: string; release: string; platform_version: string; architecture: string };
    engine: { family: "blink"; major: number };
    brand: { id: string; version: string };
    form_factor: string;
    device_model: string;
  };
  surfaces: Record<string, unknown>;
}

/** Thrown for a schema 4 persona that breaks the structural invariants. */
export class PersonaV4SchemaError extends SdkInputError {
  constructor(readonly problems: string[]) {
    super("sdk.persona_profile_invalid",
      `persona violates the new persona format (schema_version 4): ${problems.join("; ")}`);
    this.name = "PersonaV4SchemaError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** True for a value that claims to be a schema 4 persona (before any validation). */
export function isPersonaV4(value: unknown): boolean {
  return isObject(value) && value.schema_version === 4;
}

/** Throws when `value` is not a structurally valid schema_version 4 persona. */
export function assertPersonaProfileV4(value: unknown): asserts value is PersonaProfileV4 {
  const problems: string[] = [];
  if (!isObject(value)) throw new PersonaV4SchemaError(["<root> must be an object"]);
  if (value.schema_version !== 4) problems.push("schema_version must be 4");
  if (!Number.isInteger(value.schema_revision)) problems.push("schema_revision must be an integer");
  const req = value.requires;
  if (!Array.isArray(req) || !req.every((r) => typeof r === "string")) {
    problems.push("requires must be an array of strings");
  } else if (new Set(req).size !== req.length) {
    problems.push("requires must not contain duplicates");
  }
  const prov = value.provenance;
  if (!isObject(prov)) problems.push("provenance must be an object");
  else {
    if (prov.source !== "synthetic") problems.push("provenance.source must be synthetic");
    const model = prov.model;
    if (!isObject(model) || typeof model.version !== "string" || typeof model.sha256 !== "string") {
      problems.push("provenance.model must carry version and sha256");
    }
    if ("attempt" in prov) problems.push("provenance.attempt must not be present");
    // Optional: a document without a key is valid (the engine hashes it). A key that is present must be
    // exactly what the engine's ParseNoiseKey accepts: 16 lowercase hex characters.
    if ("noise_key" in prov && !(typeof prov.noise_key === "string" && /^[0-9a-f]{16}$/.test(prov.noise_key))) {
      problems.push("provenance.noise_key must be 16 lowercase hex characters");
    }
  }
  const id = value.identity;
  if (!isObject(id)) problems.push("identity must be an object");
  else {
    const os = id.os;
    if (!isObject(os) || typeof os.family !== "string") problems.push("identity.os.family must be a string");
    const engine = id.engine;
    if (!isObject(engine) || engine.family !== "blink" || !Number.isInteger(engine.major)) {
      problems.push("identity.engine must be blink with an integer major");
    }
    const brand = id.brand;
    if (!isObject(brand) || typeof brand.id !== "string") problems.push("identity.brand.id must be a string");
  }
  if (!isObject(value.surfaces)) problems.push("surfaces must be an object");
  if (problems.length > 0) throw new PersonaV4SchemaError(problems);
}
