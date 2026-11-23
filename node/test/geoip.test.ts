import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, expect } from "vitest";
import { acceptLanguageForCountry, exitIp, geoEndpoints, geoFromEchoJson, resolveGeo } from "../src/geoip.js";

describe("acceptLanguageForCountry", () => {
  it("maps known countries (case-insensitive)", () => {
    expect(acceptLanguageForCountry("US")).toBe("en-US,en");
    expect(acceptLanguageForCountry("de")).toBe("de-DE,de,en");
    expect(acceptLanguageForCountry("BR")).toBe("pt-BR,pt,en");
    expect(acceptLanguageForCountry("JP")).toBe("ja-JP,ja,en");
  });

  it("falls back to en-US,en for unknown / empty", () => {
    expect(acceptLanguageForCountry("ZZ")).toBe("en-US,en");
    expect(acceptLanguageForCountry("")).toBe("en-US,en");
    expect(acceptLanguageForCountry(undefined)).toBe("en-US,en");
  });

  it("never returns ;q= weights (Chromium --accept-lang would DCHECK)", () => {
    for (const cc of ["US", "DE", "FR", "CA", "BR", "JP", "ZZ"]) {
      expect(acceptLanguageForCountry(cc)).not.toContain(";");
    }
  });
});

describe("resolveGeo", () => {
  it("returns null for a SOCKS proxy without any network call", async () => {
    // SOCKS can't be used for the geo lookup, and we must NOT fall back to the local IP
    // under a proxy (wrong region). Resolves to null synchronously after the scheme check.
    expect(await resolveGeo({ server: "socks5://127.0.0.1:9050" }, { quiet: true })).toBeNull();
  });
});

describe("endpoints (ip.ant0.link first, third parties last)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["ANT0_BROWSER_IPECHO_URL", "ANT0_BROWSER_GEOIP_URL", "ANT0_BROWSER_GEOJSON_URL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to Ant0's own endpoints, plain http first so proxy probes stay absolute-form", () => {
    delete process.env.ANT0_BROWSER_IPECHO_URL;
    delete process.env.ANT0_BROWSER_GEOIP_URL;
    delete process.env.ANT0_BROWSER_GEOJSON_URL;
    const e = geoEndpoints();
    expect(e.ipecho[0]).toBe("http://ip.ant0.link/");
    expect(e.ipecho[1]).toBe("https://ip.ant0.link/");
    expect(e.ipecho.slice(2)).toEqual(["http://api.ipify.org", "http://ip-api.com/line/?fields=query"]);
    expect(e.mmdb).toBe("https://releases.ant0.link/ant0-assets/geoip/v1/geoip-aio-all.mmdb.zip");
    expect(e.geojson).toBe("http://ip.ant0.link/json");
  });

  it("honours env overrides and drops the third-party fallbacks when the echo is overridden", () => {
    process.env.ANT0_BROWSER_IPECHO_URL = "http://127.0.0.1:9/";
    process.env.ANT0_BROWSER_GEOIP_URL = "https://mirror.example/geo.zip";
    process.env.ANT0_BROWSER_GEOJSON_URL = "http://127.0.0.1:9/json";
    const e = geoEndpoints();
    expect(e.ipecho).toEqual(["http://127.0.0.1:9/"]);
    expect(e.mmdb).toBe("https://mirror.example/geo.zip");
    expect(e.geojson).toBe("http://127.0.0.1:9/json");
  });

  it("reads the exit IP from a local echo (ANT0_BROWSER_IPECHO_URL) with the plain-text parse", async () => {
    const srv = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("203.0.113.7\n");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    process.env.ANT0_BROWSER_IPECHO_URL = `http://127.0.0.1:${port}/`;
    try {
      expect(await exitIp(null, true)).toBe("203.0.113.7");
    } finally {
      srv.close();
    }
  });
});

describe("geoFromEchoJson", () => {
  it("maps the /json shape and derives Accept-Language from the country", () => {
    const g = geoFromEchoJson({ ip: "203.0.113.7", country: "us", region: null, city: null,
      timezone: "America/Chicago", lat: 39.09973, lon: -94.57857, asn: null, org: null });
    expect(g).toEqual({ ip: "203.0.113.7", country: "US", timezone: "America/Chicago",
      acceptLanguage: "en-US,en", location: "39.09973,-94.57857" });
  });

  it("returns null when the server knows the IP but has no geo (database missing)", () => {
    expect(geoFromEchoJson({ ip: "203.0.113.7", country: null, timezone: null, lat: null, lon: null })).toBeNull();
    expect(geoFromEchoJson(null)).toBeNull();
    expect(geoFromEchoJson({} as any)).toBeNull();
  });
});
