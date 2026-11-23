/** Pure deterministic selection from validated persona-profile-v2 templates. */

import { createHash } from "node:crypto";
import { assertPersonaProfileV2, type PersonaProfileV2 } from "./persona-profile-v2.js";
import { SdkRangeError, SdkTypeError } from "./errors.js";

const DOMAIN = Buffer.from("ant0/persona-template-selection/v1\0", "ascii");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PersonaTemplate {
  readonly id: string;
  readonly profile: unknown;
}

function keyBytes(value: string, name: string): Buffer {
  if (typeof value !== "string") throw new SdkTypeError("sdk.template_invalid", `${name} must be a string`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else throw new SdkTypeError("sdk.template_invalid", `${name} must contain only Unicode scalar values`);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new SdkTypeError("sdk.template_invalid", `${name} must contain only Unicode scalar values`);
    }
  }
  return Buffer.from(value, "utf8");
}

function frame(value: Buffer): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  return Buffer.concat([length, value]);
}

/** Select and deep-copy one complete profile using the documented v1 selection algorithm. */
export function selectPersonaTemplateEntry(
  identityKey: string,
  deviceKey: string,
  templates: readonly PersonaTemplate[],
): { id: string; profile: PersonaProfileV2 } {
  const identity = keyBytes(identityKey, "identityKey");
  const device = keyBytes(deviceKey, "deviceKey");
  const seen = new Set<string>();
  const ordered = templates.map((template) => {
    if (typeof template !== "object" || template === null
      || Object.keys(template).length !== 2
      || !Object.prototype.hasOwnProperty.call(template, "id")
      || !Object.prototype.hasOwnProperty.call(template, "profile")) {
      throw new SdkTypeError("sdk.template_invalid", "each template must contain exactly id and profile");
    }
    if (typeof template.id !== "string" || !SAFE_ID.test(template.id)) {
      throw new SdkTypeError("sdk.template_invalid", `unsafe template id: ${String(template.id)}`);
    }
    if (seen.has(template.id)) throw new SdkTypeError("sdk.template_invalid", `duplicate template id: ${template.id}`);
    seen.add(template.id);
    assertPersonaProfileV2(template.profile);
    return template;
  });
  if (ordered.length === 0) throw new SdkRangeError("sdk.template_invalid", "template pool must not be empty");

  ordered.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const digest = createHash("sha256")
    .update(DOMAIN)
    .update(frame(identity))
    .update(frame(device))
    .digest("hex");
  const index = Number(BigInt(`0x${digest}`) % BigInt(ordered.length));
  return structuredClone(ordered[index]) as { id: string; profile: PersonaProfileV2 };
}

/** Select and deep-copy one complete profile using the documented v1 selection algorithm. */
export function selectPersonaTemplate(
  identityKey: string,
  deviceKey: string,
  templates: readonly PersonaTemplate[],
): PersonaProfileV2 {
  return selectPersonaTemplateEntry(identityKey, deviceKey, templates).profile;
}
