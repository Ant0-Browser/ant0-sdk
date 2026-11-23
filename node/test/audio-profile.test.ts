import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fingerprintArgs, encodeProfile } from "../src/fingerprint.js";
import { prepareIdentityOptions } from "../src/identity.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const base = () => read("../../fixtures/synthetic/persona-v2.json");
const shared = read("../../fixtures/audio-profile-override-v1.json");
const camel = (o: Record<string, unknown>) => Object.fromEntries(
  Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
const prep = (audioProfile?: unknown) => prepareIdentityOptions({
  identity: { mode: "captured", source: base() },
  ...(audioProfile === undefined ? {} : { overrides: { audioProfile } }),
});
const payload = (o: any) => JSON.parse(gunzipSync(Buffer.from(encodeProfile(o.options.fingerprintProfile), "base64")).toString("utf8"));

describe("audioProfile override", () => {
  it("no option leaves the payload byte-identical", () => {
    const plain = encodeProfile(prep().options.fingerprintProfile as any);
    const withEmpty = encodeProfile(prep({}).options.fingerprintProfile as any);
    expect(withEmpty).toBe(plain);
    expect(payload(prep()).audio).toEqual(base().audio);
  });

  for (const c of shared.cases) {
    it(`shared case: ${c.label}`, () => {
      const out = payload(prep(camel(c.override)));
      expect(out.audio).toEqual({ ...base().audio, ...c.audio_overrides });
      expect(Object.keys(out.audio)).toEqual(Object.keys(base().audio));
      expect({ ...out, audio: 0 }).toEqual({ ...payload(prep()), audio: 0 });
    });
  }

  it("each field alone keeps the others", () => {
    const b = base().audio;
    expect(payload(prep({ sampleRate: 44100 })).audio).toEqual({ ...b, sample_rate: 44100 });
    expect(payload(prep({ baseLatency: 0.02 })).audio).toEqual({ ...b, base_latency: 0.02 });
    expect(payload(prep({ outputLatency: 0.05 })).audio).toEqual({ ...b, output_latency: 0.05 });
  });

  it("reaches the --fingerprint-profile switch and does not mutate the caller's profile", () => {
    const src = base();
    const p = prepareIdentityOptions({ identity: { mode: "captured", source: src }, overrides: { audioProfile: { sampleRate: 44100 } } });
    const args = fingerprintArgs(p.options as any, true);
    expect(args.some((a) => a.startsWith("--fingerprint-profile="))).toBe(true);
    expect(src.audio).toEqual(base().audio);
  });

  for (const c of shared.invalid) {
    it(`rejects ${JSON.stringify(c.override)}`, () => {
      expect(() => prep(camel(c.override))).toThrow();
    });
  }

  it("rejects non-objects and native identity", () => {
    expect(() => prep(5)).toThrow(/audioProfile must be an object/);
    expect(() => prep([])).toThrow();
    expect(() => prepareIdentityOptions({ overrides: { audioProfile: { sampleRate: 44100 } } })).toThrow(/requires a captured or synthetic/);
  });
});
