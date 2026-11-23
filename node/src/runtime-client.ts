// SDK-owned, lazy native consumer. Runtime records never select the binding to load.
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorClass } from "./errors.js";

export interface RuntimeOptions {
  home?: string;
  descriptorPath?: string;
  url?: string;
  host?: string;
  port?: number;
}
export type Endpoint = { host: "127.0.0.1" | "::1"; port: number };
export type Binding = { mode: "v1"; home: string | null; descriptor_path: string | null; endpoint: Endpoint | null }
  | { mode: "legacy"; home: string; endpoint: Endpoint };
export interface RuntimeRequest {
  schema: "ant0-runtime-client/v1";
  nonce: string;
  operation: "resolve-direct-engine" | "fetch-ticket";
  binding: Binding;
  engine_version: string | null;
  ticket_fetch?: boolean;
}
export const FAILURES: Record<string, readonly [number, string]> = {
  "runtime.absent": [404, "setup"], "runtime.not_running": [503, "start"],
  "runtime.untrusted": [403, "select_home"], "runtime.incompatible": [426, "update_runtime"],
  "runtime.conflict": [409, "stop_explicitly"], "runtime.invalid_request": [400, "select_home"],
  "runtime.storage": [500, "retry"], "runtime.bootstrap_unavailable": [503, "setup"],
  "runtime.timeout": [504, "retry"], "runtime.cancelled": [499, "retry"],
  "runtime.transport": [502, "retry"], "runtime.invalid_response": [502, "update_runtime"],
  unauthorized: [401, "login"], "licence.required": [403, "login"],
  "licence.profile_limit": [403, "login"], "workspace.suspended": [403, "login"],
  "browser.not_found": [404, "install_engine"], "browser.not_installed": [404, "install_engine"],
  "browser.proof_mismatch": [409, "reinstall_engine"],
  "browser.unexpected_file": [409, "reinstall_engine"],
  "ticket.invalid": [403, "retry"],
};
function runtimeErrorClass(code: string): ErrorClass {
  if (code === "runtime.invalid_request" || code === "runtime.invalid_response") return "defect";
  if (/^(runtime|browser)\./.test(code) && code !== "runtime.cancelled") return "environment";
  return "expected";
}
export class RuntimeError extends Error {
  readonly status: number;
  readonly nextAction: string;
  readonly errorClass: ErrorClass;
  constructor(readonly code: string, options?: { cause?: unknown }) {
    const [status, action] = FAILURES[code] ?? FAILURES["runtime.invalid_response"];
    super(`ant0-browser: ${code}; next action: ${action}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RuntimeError";
    this.status = status;
    this.nextAction = action;
    this.errorClass = runtimeErrorClass(code);
  }
}
function invalid(): never { throw new RuntimeError("runtime.invalid_request"); }
function bad(): never { throw new RuntimeError("runtime.invalid_response"); }
const releasePattern = /^\d+\.\d+\.\d+\.\d+-ant0\.\d+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stringMatch = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value);
const r32Pattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const pathValid = (x: unknown): x is string => typeof x === "string" && Buffer.byteLength(x) <= 4096 && !x.includes("\0") && isAbsolute(x);
const exact = (x: unknown, keys: string[]): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const integer = (x: unknown, min: number, max: number) => typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max;
const time = (x: unknown) => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(x) && Number.isFinite(Date.parse(x));

export async function runtimeBinding(options: RuntimeOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<Binding> {
  const home = options.home ?? env.ANT0_HOME ?? null;
  const descriptor_path = options.descriptorPath ?? env.ANT0_RUNTIME_DESCRIPTOR ?? null;
  if (home !== null && !pathValid(home) || descriptor_path !== null && !pathValid(descriptor_path)) invalid();
  const url = options.url ?? env.ANT0_URL;
  let host = options.host ?? env.ANT0D_HOST;
  let port: unknown = options.port ?? env.ANT0D_PORT;
  if (url !== undefined) {
    // Parse the literal form first: URL() normalizes forbidden paths and unusual IPv4 forms.
    const m = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/.exec(url);
    if (!m) invalid();
    host = m[1] === "[::1]" ? "::1" : m[1]; port = Number(m[2]);
  }
  let endpoint: Endpoint | null = null;
  if (host !== undefined || port !== undefined) {
    host ??= "127.0.0.1"; port ??= 27100;
    if (typeof port === "string") {
      if (!/^[1-9][0-9]{0,4}$/.test(port)) invalid();
      port = Number(port);
    }
    if (!integer(port, 1, 65535)) invalid();
    if (host === "localhost") {
      const addresses = await lookup(host, { all: true }).catch(() => invalid());
      if (!addresses.length || addresses.some(a => a.address !== "127.0.0.1" && a.address !== "::1")) invalid();
      host = addresses[0].address;
    }
    if (host !== "127.0.0.1" && host !== "::1") invalid();
    endpoint = { host, port: port as number };
  }
  return { mode: "v1", home, descriptor_path, endpoint };
}

// JSON.parse alone silently accepts duplicate object members. Walk its bounded input before parsing.
function parseClosedJson(bytes: Uint8Array): unknown {
  if (!bytes.length || bytes.length > 65536) bad();
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return bad(); }
  let i = 0;
  const ws = () => { while (/[ \t\r\n]/.test(source[i] ?? "x")) i++; };
  const str = (): string => {
    const start = i++;
    while (i < source.length) {
      const c = source[i++];
      if (c === "\\") i++;
      else if (c === '"') { try { return JSON.parse(source.slice(start, i)); } catch { bad(); } }
    }
    return bad();
  };
  const value = (depth: number): void => {
    if (depth > 24) bad(); ws();
    if (source[i] === "{") {
      i++; ws(); const keys = new Set<string>();
      if (source[i] === "}") { i++; return; }
      while (true) {
        ws(); if (source[i] !== '"') bad(); const key = str();
        if (keys.has(key)) bad(); keys.add(key); ws(); if (source[i++] !== ":") bad();
        value(depth + 1); ws(); const c = source[i++]; if (c === "}") return; if (c !== ",") bad();
      }
    }
    if (source[i] === "[") {
      i++; ws(); if (source[i] === "]") { i++; return; }
      while (true) { value(depth + 1); ws(); const c = source[i++]; if (c === "]") return; if (c !== ",") bad(); }
    }
    if (source[i] === '"') { str(); return; }
    const m = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(i));
    if (!m) bad(); i += m[0].length;
  };
  value(0); ws(); if (i !== source.length) bad();
  try { return JSON.parse(source); } catch { return bad(); }
}

const capabilities = ["auth.loopback", "auth.device_code", "auth.install", "engine.status", "engine.install", "engine.ticket", "profiles.managed", "automation.scoped"];
export function decodeRuntimeResult(bytes: Uint8Array, request: RuntimeRequest): Record<string, any> {
  const v: any = parseClosedJson(bytes);
  const base = ["schema", "nonce", "operation", "ok"];
  if (!v || v.schema !== request.schema || v.nonce !== request.nonce || v.operation !== request.operation) bad();
  if (v.ok === false) {
    if (!exact(v, [...base, "status", "failure"]) || !exact(v.failure, ["error", "message", "details"])
      || !exact(v.failure.details, ["next_action"])) bad();
    const f = FAILURES[v.failure.error];
    if (!f || v.status !== f[0] || v.failure.details.next_action !== f[1]
      || typeof v.failure.message !== "string" || !v.failure.message.length || v.failure.message.length > 240) bad();
    throw new RuntimeError(v.failure.error);
  }
  const resolving = request.operation === "resolve-direct-engine";
  if (v.ok !== true || !exact(v, [...base, "handshake", ...(resolving ? ["engine"] : []), "ticket", "context"])) bad();
  const h = v.handshake;
  if (request.binding.mode === "legacy") { if (h !== null || resolving) bad(); }
  else {
    if (!exact(h, ["protocol", "nonce", "install_id", "generation", "app_version", "target", "pid", "home", "daemon_sha256", "auth_protocol", "engine_ticket", "capabilities", "lifecycle"])
      || h.protocol !== "ant0-runtime/v1" || !stringMatch(h.nonce, r32Pattern) || !stringMatch(h.install_id, uuidPattern) || !stringMatch(h.generation, uuidPattern)
      || typeof h.app_version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(h.app_version)
      || h.target !== (process.platform === "win32" ? "windows-x64" : "linux-x64")
      || !integer(h.pid, 1, 2147483647) || !pathValid(h.home) || !stringMatch(h.daemon_sha256, /^[0-9a-f]{64}$/)
      || h.auth_protocol !== "ant0-native-auth/v1" || h.engine_ticket !== "ant0-launch/v1"
      || !["desktop", "manual", "persistent"].includes(h.lifecycle)
      || !Array.isArray(h.capabilities) || h.capabilities.length !== capabilities.length
      || !capabilities.every(c => h.capabilities.includes(c))
      || request.binding.home !== null && h.home !== request.binding.home) bad();
  }
  if (resolving) {
    const e = v.engine;
    if (!exact(e, ["version", "chromium", "target", "path", "executable", "installed_at", "size_bytes", "default"])
      || typeof e.version !== "string" || !releasePattern.test(e.version) || e.chromium !== e.version.split("-ant0.")[0]
      || e.target !== h.target || !pathValid(e.path) || !pathValid(e.executable) || !time(e.installed_at)
      || !integer(e.size_bytes, 0, 8589934592) || e.default !== true
      || request.engine_version !== null && e.version !== request.engine_version) bad();
  }
  if (resolving && request.ticket_fetch === false) { if (v.ticket !== null || v.context !== null) bad(); }
  else {
    const t = v.ticket, c = v.context;
    if (!exact(t, ["launch", "engine", "expires_at"]) || typeof t.launch !== "string"
      || Buffer.byteLength(t.launch) > 16384 || t.launch.split(".").length !== 5
      || t.engine !== (resolving ? v.engine.version : request.engine_version) || !time(t.expires_at)
      || !exact(c, ["device_id", "sign_pub", "workspace_id"])
      || typeof c.device_id !== "string" || !/^[A-Z2-7]{26}$/.test(c.device_id)
      || typeof c.sign_pub !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(c.sign_pub) || Buffer.from(c.sign_pub, "base64").toString("base64") !== c.sign_pub
      || !stringMatch(c.workspace_id, uuidPattern)) bad();
  }
  return v;
}

interface NativeResult { bytes: Uint8Array; release(): void }
interface NativeCall { completion: Promise<NativeResult>; cancel(): void }
interface NativeBinding { execute(bytes: Uint8Array): NativeCall }
function loadBinding(): NativeBinding {
  if (process.arch !== "x64" || !["linux", "win32"].includes(process.platform)) throw new RuntimeError("runtime.bootstrap_unavailable");
  const target = process.platform === "win32" ? "windows-x64" : "linux-x64";
  try {
    const binding = createRequire(import.meta.url)(fileURLToPath(new URL(`./native/${target}/ant0_runtime.node`, import.meta.url)));
    if (typeof binding?.execute !== "function") throw new Error();
    return binding;
  } catch { throw new RuntimeError("runtime.bootstrap_unavailable"); }
}

export async function executeRuntime(operation: RuntimeRequest["operation"], binding: Binding, engineVersion: string | null,
  ticketFetch = true, signal?: AbortSignal): Promise<{ value: Record<string, any>; release(): void }> {
  if (engineVersion !== null && !stringMatch(engineVersion, releasePattern) || operation === "fetch-ticket" && engineVersion === null) invalid();
  if (signal?.aborted) throw new RuntimeError("runtime.cancelled");
  const request: RuntimeRequest = { schema: "ant0-runtime-client/v1", nonce: randomBytes(32).toString("base64url"), operation,
    binding, engine_version: engineVersion, ...(operation === "resolve-direct-engine" ? { ticket_fetch: ticketFetch } : {}) };
  const bytes = Buffer.from(JSON.stringify(request)); if (bytes.length > 16384) invalid();
  const started = performance.now();
  const native = loadBinding();
  if (performance.now() - started >= 180000) throw new RuntimeError("runtime.timeout");
  let call: NativeCall;
  try {
    call = native.execute(bytes);
    if (!call || typeof call.cancel !== "function" || typeof call.completion?.then !== "function") bad();
  } catch { throw new RuntimeError("runtime.invalid_response"); }
  let timeout = false;
  const cancel = () => call.cancel();
  const timer = setTimeout(() => { timeout = true; cancel(); }, Math.max(1, 180000 - (performance.now() - started)));
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let owned: NativeResult | undefined;
  try {
    owned = await call.completion;
    if (timeout) throw new RuntimeError("runtime.timeout");
    if (signal?.aborted) throw new RuntimeError("runtime.cancelled");
    if (!(owned?.bytes instanceof Uint8Array) || typeof owned.release !== "function") bad();
    const value = decodeRuntimeResult(owned.bytes, request);
    let released = false;
    const result = owned;
    return { value, release() { if (!released) { released = true; result.release(); } } };
  } catch (e) {
    owned?.release?.();
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError("runtime.invalid_response");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
