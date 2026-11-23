/**
 * Migrate a persona profile across a Chromium engine upgrade.
 *
 * An engine upgrade moves **only** the browser-version fields
 * and keeps the simulated machine identical. A user who upgrades the engine must look like the
 * same computer running a newer browser — not like a new computer.
 *
 * ## What this rewrites
 *
 * `compatibility.browser_major` — and nothing else.
 *
 * That is the complete set, and it is a property of the contract rather than an omission.
 * `persona-profile-v2` is a *closed* schema (`additionalProperties: false` throughout) and
 * carries no user-agent string, no Sec-CH-UA brand list and no full-version list: the engine
 * derives all of those at runtime from its own build version (it seeds the brand list from the Chromium major version). `browser_major` is a compatibility assertion — "this
 * machine description was generated for engine major N" — not a source of UA text. Everything
 * that makes the persona a *machine* (hardware, display, locale, graphics, audio, fonts,
 * speech, media) is version-independent and is preserved byte-for-byte.
 *
 * ## Determinism
 *
 * The result is a pure function of `(profile, targetMajor)`. No randomness, no clock, no
 * environment. Re-running on an already-migrated profile returns an equal profile
 * (idempotent), and migrating to the profile's current major is an exact no-op.
 */

import { CHROMIUM_MAJOR } from "./chromium-version.js";
import type { ErrorClass } from "./errors.js";

/** The profile cannot be migrated (wrong shape, or a refused target major). */
export class PersonaMigrationError extends Error {
  readonly code: string = "sdk.persona_migration_refused";
  readonly errorClass: ErrorClass = "expected";
  constructor(message: string) {
    super(message);
    this.name = "PersonaMigrationError";
  }
}

/**
 * Fields this migration is permitted to rewrite. Anything outside this set must come out
 * byte-identical; {@link migratePersonaBrowserMajor} asserts that before returning.
 */
export const MIGRATED_FIELDS = ["compatibility.browser_major"] as const;

function resolveTarget(targetMajor?: number): number {
  if (targetMajor === undefined) return CHROMIUM_MAJOR;
  if (typeof targetMajor !== "number" || !Number.isInteger(targetMajor)) {
    throw new PersonaMigrationError("targetMajor must be an integer");
  }
  if (targetMajor < 100 || targetMajor > 999) {
    throw new PersonaMigrationError(`targetMajor ${targetMajor} is not a plausible Chromium major`);
  }
  return targetMajor;
}

/** The major a profile declares, or `undefined` when it does not declare one. */
export function personaBrowserMajor(profile: unknown): number | undefined {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return undefined;
  const compatibility = (profile as Record<string, unknown>).compatibility;
  if (typeof compatibility !== "object" || compatibility === null) return undefined;
  const major = (compatibility as Record<string, unknown>).browser_major;
  return typeof major === "number" && Number.isInteger(major) ? major : undefined;
}

/** True when `profile` targets a different major than the engine (default: the pin). */
export function needsMigration(profile: unknown, targetMajor?: number): boolean {
  const current = personaBrowserMajor(profile);
  return current !== undefined && current !== resolveTarget(targetMajor);
}

/**
 * Return a copy of `profile` valid for `targetMajor` (default: the pinned engine).
 *
 * Only `compatibility.browser_major` changes; every other byte is preserved. The input is
 * never mutated. Throws {@link PersonaMigrationError} if the profile does not carry a
 * `compatibility.browser_major` integer — that is a malformed profile, not an upgradable one,
 * and silently inventing a major would fabricate a machine.
 */
export function migratePersonaBrowserMajor<T>(profile: T, targetMajor?: number): T {
  const target = resolveTarget(targetMajor);
  if (personaBrowserMajor(profile) === undefined) {
    throw new PersonaMigrationError("profile has no integer compatibility.browser_major to migrate");
  }

  const migrated = structuredClone(profile) as T & { compatibility: { browser_major: number } };
  migrated.compatibility.browser_major = target;

  // Prove the "keep the machine" guarantee rather than trusting it: with the one migrated
  // field masked out, the two profiles must be identical. This catches any future edit to
  // this function that starts touching the machine description.
  const before = structuredClone(profile) as { compatibility: Record<string, unknown> };
  const after = structuredClone(migrated) as { compatibility: Record<string, unknown> };
  delete before.compatibility.browser_major;
  delete after.compatibility.browser_major;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new PersonaMigrationError(`migration altered a field outside ${MIGRATED_FIELDS.join(", ")}`);
  }
  return migrated;
}
