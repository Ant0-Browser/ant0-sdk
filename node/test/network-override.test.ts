import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeProfile } from "../src/fingerprint.js";
import { prepareIdentityOptions } from "../src/identity.js";
import { validatePersonaProfileV2 } from "../src/persona-profile-v2.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const base = () => read("../../fixtures/synthetic/persona-v2.json");
const shared = read("../../fixtures/network-override-v1.json");
const camel = (o: Record<string, unknown>) => Object.fromEntries(
  Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
const prep = (network?: unknown) => prepareIdentityOptions({
  identity: { mode: "captured", source: base() },
  ...(network === undefined ? {} : { overrides: { network } }),
});
const payload = (o: any) => JSON.parse(gunzipSync(Buffer.from(encodeProfile(o.options.fingerprintProfile), "base64")).toString("utf8"));

describe("network override", () => {
  it("no option leaves the payload byte-identical and without a network block", () => {
    expect(encodeProfile(prep({}).options.fingerprintProfile as any)).toBe(encodeProfile(prep().options.fingerprintProfile as any));
    expect("network" in payload(prep())).toBe(false);
  });

  for (const c of shared.cases) {
    it(`shared case: ${c.label}`, () => {
      const out = payload(prep(camel(c.override)));
      if (c.network_block === null) expect("network" in out).toBe(false);
      else expect(out.network).toEqual(c.network_block);
      const { network: _n, ...rest } = out;
      expect(rest).toEqual(base());
    });
  }

  it("the payload with a network block still validates, and a caller's profile is not mutated", () => {
    const src = base();
    const p = prepareIdentityOptions({ identity: { mode: "captured", source: src }, overrides: { network: { rtt: 100 } } });
    expect(validatePersonaProfileV2(p.options.fingerprintProfile).valid).toBe(true);
    expect("network" in src).toBe(false);
  });

  it("the validator rejects a malformed block", () => {
    const bad = { ...base(), network: { rtt_ms: 0 } };
    expect(validatePersonaProfileV2(bad).valid).toBe(false);
    expect(validatePersonaProfileV2({ ...base(), network: { effective_type: "5g" } }).valid).toBe(false);
    expect(validatePersonaProfileV2({ ...base(), network: { x: 1 } }).valid).toBe(false);
  });

  for (const c of shared.invalid) {
    it(`rejects ${JSON.stringify(c.override)}`, () => {
      expect(() => prep(camel(c.override))).toThrow();
    });
  }

  it("a null network and null fields mean not given (same as Python)", () => {
    expect(encodeProfile(prep(null).options.fingerprintProfile as any)).toBe(encodeProfile(prep().options.fingerprintProfile as any));
    expect("network" in payload(prep({ rtt: null, downlink: null }))).toBe(false);
    expect(payload(prep({ rtt: 100, downlink: null })).network).toEqual({ rtt_ms: 100 });
    // null network on a native identity is "not given", not an error
    expect(() => prepareIdentityOptions({ overrides: { network: null } })).not.toThrow();
  });

  it("rejects non-objects and native identity", () => {
    expect(() => prep(5)).toThrow(/network must be an object/);
    expect(() => prep([])).toThrow();
    expect(() => prepareIdentityOptions({ overrides: { network: { rtt: 50 } } })).toThrow(/requires a captured or synthetic/);
  });
});
