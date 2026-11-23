import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFontPack, packFamilies, packUrl } from "../src/fontpack.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("resolveFontPack (retired)", () => {
  it("ignores ANT0_BROWSER_FONT_PACK even when it points at a folder with fonts", async () => {
    const d = mkdtempSync(join(tmpdir(), "fp-")); writeFileSync(join(d, "Arial.ttf"), "x");
    process.env.ANT0_BROWSER_FONT_PACK = d;
    expect(await resolveFontPack({ quiet: true })).toBeUndefined();
  });

  it("ignores a previously cached pack", async () => {
    delete process.env.ANT0_BROWSER_FONT_PACK;
    const cache = mkdtempSync(join(tmpdir(), "fpcache-"));
    process.env.ANT0_BROWSER_CACHE = cache;
    const dest = join(cache, "fontpack", "windows-v1"); mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "Arial.ttf"), "x");
    expect(await resolveFontPack({ quiet: true, download: false })).toBeUndefined();
  });

  it("never downloads, whatever the URL variable says", async () => {
    process.env.ANT0_BROWSER_FONT_PACK_URL = "https://127.0.0.1:1/ant0-fontpack-windows-v1.zip";
    expect(packUrl()).toBe("");
    expect(await resolveFontPack({ quiet: false, download: true })).toBeUndefined();
  });

  it("packFamilies still reads families.txt", () => {
    const d = mkdtempSync(join(tmpdir(), "fpm-"));
    writeFileSync(join(d, "families.txt"), "Arial\nSegoe UI\nCalibri\n");
    const fams = packFamilies(d);
    expect(fams.has("arial")).toBe(true);
    expect(fams.has("segoe ui")).toBe(true);
  });
});
