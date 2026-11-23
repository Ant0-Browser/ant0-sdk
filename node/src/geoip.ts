// geoip: resolve the egress IP's geo (timezone + lat/lon + language) so the browser matches the
// proxy actually in use. Primary source is an offline all-in-one MaxMind DB (more accurate than a single online API; merges IP2Location +
// GeoLite2 + DB-IP, timezone computed from coordinates), served from the Ant0 asset mirror. Flow:
// discover the exit IP via Ant0's own IP echo (ip.ant0.link, zero request logging) *through the
// proxy*, then look that IP up in the cached .mmdb. Falls back to ip.ant0.link/json (geo computed
// server-side from the same DB, through the proxy) if the DB can't be fetched/opened.
//
// Network endpoints, in order of preference (all overridable):
//   ANT0_BROWSER_IPECHO_URL   plain-text IP echo; default http://ip.ant0.link/ (then https://, then
//                             the legacy third parties api.ipify.org / ip-api.com as a last resort)
//   ANT0_BROWSER_GEOIP_URL    the .mmdb zip; default releases.ant0.link/ant0-assets/geoip/v1/…
//   ANT0_BROWSER_GEOJSON_URL  JSON geo fallback; default http://ip.ant0.link/json
//
// The .mmdb (GPL-3.0 data with IP2Location LITE / GeoLite2 / DB-IP attributions, see README) is
// downloaded + cached on first use (≈52 MB zip → ≈120 MB), NOT bundled.
// http(s) proxies only for the lookup; SOCKS is skipped (we never fall back to the local IP under a
// proxy, which would give the wrong region).

import http from "node:http";
import https from "node:https";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import maxmind, { type Reader } from "maxmind";
import * as unzipper from "unzipper";
import { SdkError } from "./errors.js";

export const DEFAULT_MMDB_URL = "https://releases.ant0.link/ant0-assets/geoip/v1/geoip-aio-all.mmdb.zip";
export const DEFAULT_IPECHO_URL = "http://ip.ant0.link/";
export const DEFAULT_GEOJSON_URL = "http://ip.ant0.link/json";
// Kept only as a last resort after both ip.ant0.link schemes fail (third parties, plain HTTP).
const LEGACY_IPECHO_URLS = ["http://api.ipify.org", "http://ip-api.com/line/?fields=query"];
const MMDB_MAX_AGE_DAYS = 30;

/** Env overrides are read at call time (not frozen at import) so tests and daemons can set them. */
export function geoEndpoints(): { ipecho: string[]; mmdb: string; geojson: string } {
  const ipecho = process.env.ANT0_BROWSER_IPECHO_URL || DEFAULT_IPECHO_URL;
  const list = [ipecho];
  if (ipecho === DEFAULT_IPECHO_URL) list.push(ipecho.replace(/^http:/, "https:"), ...LEGACY_IPECHO_URLS);
  return {
    ipecho: list,
    mmdb: process.env.ANT0_BROWSER_GEOIP_URL || DEFAULT_MMDB_URL,
    geojson: process.env.ANT0_BROWSER_GEOJSON_URL || DEFAULT_GEOJSON_URL,
  };
}

export interface Geo {
  ip?: string;
  country?: string;
  timezone?: string;
  acceptLanguage?: string;
  location?: string; // "lat,lon"
}

function log(quiet: boolean | undefined, m: string): void {
  if (!quiet) process.stderr.write(`[ant0-browser] ${m}\n`);
}

function geoCacheRoot(): string {
  if (process.env.ANT0_BROWSER_CACHE) return path.join(process.env.ANT0_BROWSER_CACHE, "geoip");
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ant0-browser", "geoip");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ant0-browser", "geoip");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ant0-browser", "geoip");
}

function proxyUrl(proxy?: { server?: string; username?: string; password?: string }): string | null {
  if (!proxy?.server) return null;
  let server = proxy.server;
  if (!/:\/\//.test(server)) server = "http://" + server;
  if (proxy.username) {
    const u = new URL(server);
    u.username = encodeURIComponent(proxy.username);
    if (proxy.password) u.password = encodeURIComponent(proxy.password);
    return u.toString();
  }
  return server;
}

function isSocks(proxy?: { server?: string }): boolean {
  return !!proxy?.server && /^socks/i.test(proxy.server);
}

// GET an http(s):// URL, optionally through an http proxy (absolute-form request target for http://
// targets; https:// targets are only fetched directly — through a proxy they would need CONNECT,
// so the caller lists them after the plain-http variant). Text body.
function httpGetText(targetUrl: string, proxy: string | null, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = new URL(targetUrl);
    const secure = t.protocol === "https:";
    if (secure && proxy) return reject(new Error("https target through an http proxy is not supported here"));
    let opts: http.RequestOptions;
    if (proxy) {
      const p = new URL(proxy);
      opts = { host: p.hostname, port: p.port || 80, path: targetUrl, timeout: timeoutMs,
        headers: { Host: t.host, "User-Agent": "ant0-browser-sdk", Accept: "*/*" } };
      if (p.username) {
        const cred = Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64");
        (opts.headers as Record<string, string>)["Proxy-Authorization"] = `Basic ${cred}`;
      }
    } else {
      opts = { host: t.hostname, port: t.port || (secure ? 443 : 80), path: t.pathname + t.search, timeout: timeoutMs,
        headers: { Host: t.host, "User-Agent": "ant0-browser-sdk", Accept: "*/*" } };
    }
    const req = (secure ? https : http).request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data.trim()));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.end();
  });
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;
function looksLikeIp(s: string): boolean {
  return IPV4.test(s) || (s.includes(":") && IPV6.test(s));
}

/** Discover the egress IP via an IP-echo through the proxy (or direct). */
export async function exitIp(proxy: string | null, quiet?: boolean): Promise<string | null> {
  for (const url of geoEndpoints().ipecho) {
    try {
      const ip = (await httpGetText(url, proxy, 8000)).split(/\s+/)[0];
      if (looksLikeIp(ip)) return ip;
    } catch {
      /* try next */
    }
  }
  log(quiet, "geoip: could not determine the exit IP");
  return null;
}

let _mmdbInflight: Promise<string | null> | null = null;
async function ensureMmdb(quiet?: boolean): Promise<string | null> {
  const dir = geoCacheRoot();
  const file = path.join(dir, "geoip-aio-all.mmdb");
  if (existsSync(file)) {
    const ageDays = (Date.now() - statSync(file).mtimeMs) / 86_400_000;
    if (ageDays < MMDB_MAX_AGE_DAYS) return file;
  }
  if (_mmdbInflight) return _mmdbInflight;
  _mmdbInflight = (async () => {
    try {
      mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, "geoip-aio-all.mmdb.zip");
      log(quiet, "geoip: downloading the geoip-all-in-one database (~52 MB, first run only)");
      const res = await fetch(geoEndpoints().mmdb, { redirect: "follow" });
      if (!res.ok || !res.body) throw new SdkError("sdk.geoip_archive_invalid", `HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(zip));
      const tmp = path.join(dir, ".extract");
      rmSync(tmp, { recursive: true, force: true });
      const archive = await unzipper.Open.file(zip);
      await archive.extract({ path: tmp });
      const found = findMmdb(tmp);
      if (!found) throw new SdkError("sdk.geoip_archive_invalid", "no .mmdb in archive");
      rmSync(file, { force: true });
      // move (rename across same dir)
      const fs = await import("node:fs");
      fs.renameSync(found, file);
      rmSync(zip, { force: true });
      rmSync(tmp, { recursive: true, force: true });
      log(quiet, "geoip: database ready");
      return file;
    } catch (e) {
      log(quiet, `geoip: database fetch failed (${(e as Error).message}) — falling back to ip.ant0.link/json`);
      return null;
    } finally {
      _mmdbInflight = null;
    }
  })();
  return _mmdbInflight;
}

function findMmdb(dir: string): string | null {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase().endsWith(".mmdb")) return full;
    }
  }
  return null;
}

let _reader: Reader<any> | null = null;
async function mmdbLookup(ip: string, quiet?: boolean): Promise<Geo | null> {
  const file = await ensureMmdb(quiet);
  if (!file) return null;
  try {
    if (!_reader) _reader = await maxmind.open(file);
    const rec: any = _reader.get(ip);
    if (!rec) return null;
    const country: string | undefined = rec?.country?.iso_code;
    const lat = rec?.location?.latitude;
    const lon = rec?.location?.longitude;
    const tz: string | undefined = rec?.location?.time_zone;
    if (!tz && lat == null) return null;
    return {
      ip,
      country,
      timezone: tz,
      acceptLanguage: acceptLanguageForCountry(country),
      location: lat != null && lon != null ? `${lat},${lon}` : undefined,
    };
  } catch (e) {
    log(quiet, `geoip: mmdb read failed (${(e as Error).message})`);
    return null;
  }
}

/** Shape of `GET ip.ant0.link/json` (fields are null when unknown). */
export interface IpEchoJson {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  lat: number | null;
  lon: number | null;
  asn: number | null;
  org: string | null;
}

/** Map an ip.ant0.link/json body to Geo; null when it carries no usable geo. */
export function geoFromEchoJson(j: Partial<IpEchoJson> | null | undefined): Geo | null {
  if (!j || typeof j !== "object" || !j.ip) return null;
  const country = j.country ? String(j.country).toUpperCase() : undefined;
  const timezone = j.timezone || undefined;
  const hasLoc = typeof j.lat === "number" && typeof j.lon === "number";
  if (!timezone && !hasLoc && !country) return null;
  return {
    ip: j.ip,
    country,
    timezone,
    acceptLanguage: acceptLanguageForCountry(country),
    location: hasLoc ? `${j.lat},${j.lon}` : undefined,
  };
}

// Fallback: ip.ant0.link/json returns geo directly (through the proxy), no local DB needed.
async function geoJsonFallback(proxy: string | null, quiet?: boolean): Promise<Geo | null> {
  try {
    const txt = await httpGetText(geoEndpoints().geojson, proxy, 8000);
    return geoFromEchoJson(JSON.parse(txt));
  } catch {
    return null;
  }
}

/**
 * Resolve geo for the egress (through `proxy` if given, else direct). Never throws — returns null
 * on failure. Uses the geoip-all-in-one offline DB first, ip.ant0.link/json as a fallback.
 */
export async function resolveGeo(
  proxy?: { server?: string; username?: string; password?: string },
  opts: { quiet?: boolean } = {}
): Promise<Geo | null> {
  if (isSocks(proxy)) {
    log(opts.quiet, "geoip: SOCKS proxy can't be used for the geo lookup — set timezone/acceptLanguage explicitly. Skipping.");
    return null;
  }
  const purl = proxyUrl(proxy);
  const ip = await exitIp(purl, opts.quiet);
  let geo: Geo | null = ip ? await mmdbLookup(ip, opts.quiet) : null;
  if (!geo) geo = await geoJsonFallback(purl, opts.quiet);
  if (geo) log(opts.quiet, `geoip: ${geo.ip} -> ${geo.country} tz=${geo.timezone} lang=${geo.acceptLanguage}`);
  return geo;
}

// country (ISO-3166 alpha-2) -> Accept-Language. Plain comma list (NO ;q= weights — Chromium's
// --accept-lang adds those). The geoip DB has no language data, so this maps the resolved country.
const COUNTRY_LANG: Record<string, string> = {
  US: "en-US,en", GB: "en-GB,en", CA: "en-CA,en,fr-CA", AU: "en-AU,en", NZ: "en-NZ,en",
  IE: "en-IE,en", IN: "en-IN,en,hi", ZA: "en-ZA,en", SG: "en-SG,en",
  DE: "de-DE,de,en", AT: "de-AT,de,en", CH: "de-CH,de,fr,en",
  FR: "fr-FR,fr,en", BE: "nl-BE,nl,fr,en", NL: "nl-NL,nl,en",
  ES: "es-ES,es,en", MX: "es-MX,es,en", AR: "es-AR,es,en", CL: "es-CL,es,en",
  CO: "es-CO,es,en", PT: "pt-PT,pt,en", BR: "pt-BR,pt,en",
  IT: "it-IT,it,en", PL: "pl-PL,pl,en", RU: "ru-RU,ru,en", UA: "uk-UA,uk,ru,en",
  SE: "sv-SE,sv,en", NO: "nb-NO,no,en", DK: "da-DK,da,en", FI: "fi-FI,fi,en",
  CZ: "cs-CZ,cs,en", RO: "ro-RO,ro,en", HU: "hu-HU,hu,en", GR: "el-GR,el,en",
  TR: "tr-TR,tr,en", IL: "he-IL,he,en", SA: "ar-SA,ar,en", AE: "ar-AE,ar,en",
  EG: "ar-EG,ar,en", JP: "ja-JP,ja,en", KR: "ko-KR,ko,en",
  CN: "zh-CN,zh,en", HK: "zh-HK,zh,en", TW: "zh-TW,zh,en",
  TH: "th-TH,th,en", VN: "vi-VN,vi,en", ID: "id-ID,id,en",
  MY: "ms-MY,ms,en", PH: "en-PH,en,fil",
};

export function acceptLanguageForCountry(cc?: string): string {
  if (!cc) return "en-US,en";
  return COUNTRY_LANG[cc.toUpperCase()] || "en-US,en";
}
