import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ execute: vi.fn(), load: vi.fn() }));
vi.mock("node:module", async original => ({ ...await original<typeof import("node:module")>(),
  createRequire: () => (path: string) => { native.load(path); return native; } }));
import { RuntimeError, decodeRuntimeResult, executeRuntime, runtimeBinding, type RuntimeRequest } from "../src/runtime-client.js";
const nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const id = "11111111-1111-4111-8111-111111111111";
const version = "154.0.8037.57-ant0.2";
const home = process.platform === "win32" ? "C:\\Ant0" : "/home/test/ant0";
const request: RuntimeRequest = { schema: "ant0-runtime-client/v1", nonce, operation: "resolve-direct-engine",
  binding: { mode: "v1", home, descriptor_path: null, endpoint: null }, engine_version: version, ticket_fetch: false };
function success(r = request): any {
  return { schema: r.schema, nonce: r.nonce, operation: r.operation, ok: true,
    handshake: { protocol: "ant0-runtime/v1", nonce, install_id: id, generation: id, app_version: "0.3.15",
      target: process.platform === "win32" ? "windows-x64" : "linux-x64", pid: 123, home,
      daemon_sha256: "a".repeat(64), auth_protocol: "ant0-native-auth/v1", engine_ticket: "ant0-launch/v1",
      capabilities: ["auth.loopback", "auth.device_code", "auth.install", "engine.status", "engine.install", "engine.ticket", "profiles.managed", "automation.scoped"], lifecycle: "persistent" },
    engine: { version, chromium: "154.0.8037.57", target: process.platform === "win32" ? "windows-x64" : "linux-x64",
      path: home + "/browsers/engine", executable: home + "/browsers/engine/chrome", installed_at: "2026-10-12T00:00:00Z", size_bytes: 123, default: true },
    ticket: null, context: null };
}
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
describe("native result boundary", () => {
  it("does not load native code on import or while normalizing bindings", async () => {
    expect(native.load).not.toHaveBeenCalled();
    expect(await runtimeBinding({}, {})).toEqual({ mode: "v1", home: null, descriptor_path: null, endpoint: null });
    expect(native.load).not.toHaveBeenCalled();
  });
  it("accepts only the complete closed result for this operation", () => {
    expect(decodeRuntimeResult(bytes(success()), request).engine.version).toBe(version);
    for (const alter of [
      (v: any) => { v.nonce = "B".repeat(43); },
      (v: any) => { v.extra = true; },
      (v: any) => { v.engine.default = false; },
      (v: any) => { v.engine.version = "155.0.0.0-ant0.1"; },
      (v: any) => { v.handshake.home = home + "/other"; },
      (v: any) => { v.handshake.capabilities.pop(); },
      (v: any) => { v.handshake.nonce = [nonce]; },
      (v: any) => { v.context = {}; },
      (v: any) => { v.ticket = {}; },
    ]) { const v = success(); alter(v); expect(() => decodeRuntimeResult(bytes(v), request)).toThrow(/runtime.invalid_response/); }
  });
  it("rejects duplicates, invalid UTF-8, BOM, trailing and oversized input", () => {
    for (const b of [Buffer.from('{"schema":"x","schema":"y"}'), Buffer.from([0xff]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(success())]), Buffer.concat([bytes(success()), Buffer.from(" null")]), Buffer.alloc(65537)]) {
      expect(() => decodeRuntimeResult(b, request)).toThrow(/runtime.invalid_response/);
    }
    const duplicate = JSON.stringify(success()).replace('"default":true', '"default":true,"default":true');
    expect(() => decodeRuntimeResult(Buffer.from(duplicate), request)).toThrow(/runtime.invalid_response/);
  });
  it("maps known failures without reflecting a native/backend message", () => {
    const v = { schema: request.schema, nonce, operation: request.operation, ok: false, status: 503,
      failure: { error: "runtime.not_running", message: "private backend detail", details: { next_action: "start" } } };
    expect(() => decodeRuntimeResult(bytes(v), request)).toThrow("runtime.not_running; next action: start");
    v.status = 200;
    expect(() => decodeRuntimeResult(bytes(v), request)).toThrow(/runtime.invalid_response/);
  });
  it("maps a damaged installed engine to its own code and a reinstall, not to a missing engine", () => {
    const v = { schema: request.schema, nonce, operation: request.operation, ok: false, status: 409,
      failure: { error: "browser.proof_mismatch", message: "An installed engine file does not match its signed proof.", details: { next_action: "reinstall_engine" } } };
    expect(() => decodeRuntimeResult(bytes(v), request)).toThrow("browser.proof_mismatch; next action: reinstall_engine");
    try { decodeRuntimeResult(bytes(v), request); } catch (e: any) { expect(e.status).toBe(409); expect(e.errorClass).toBe("environment"); }
    // The old pair for the same code is no longer accepted: status and action must agree.
    v.status = 404; v.failure.details.next_action = "install_engine";
    expect(() => decodeRuntimeResult(bytes(v), request)).toThrow(/runtime.invalid_response/);
  });
  it("maps an unexpected file in the engine folder to its own code and a reinstall, not to a missing engine", () => {
    const message = "The engine folder has an unexpected file (debug.log); repair or reinstall the engine.";
    const v = { schema: request.schema, nonce, operation: request.operation, ok: false, status: 409,
      failure: { error: "browser.unexpected_file", message, details: { next_action: "reinstall_engine" } } };
    expect(() => decodeRuntimeResult(bytes(v), request)).toThrow("browser.unexpected_file; next action: reinstall_engine");
    try { decodeRuntimeResult(bytes(v), request); } catch (e: any) { expect(e.status).toBe(409); expect(e.errorClass).toBe("environment"); expect(e.message).not.toContain("debug.log"); }
    // The old answer for the same situation (a missing engine) is not accepted for this code.
    v.status = 404; v.failure.details.next_action = "install_engine";
    expect(() => decodeRuntimeResult(bytes(v), request)).toThrow(/runtime.invalid_response/);
  });
  it("retains pins until release and releases once on invalid results", async () => {
    const release = vi.fn();
    native.execute.mockImplementation((b: Uint8Array) => ({ completion: Promise.resolve({ bytes: bytes(success(JSON.parse(Buffer.from(b).toString()))), release }), cancel() {} }));
    const result = await executeRuntime(request.operation, request.binding, version, false);
    expect(native.load.mock.calls[0][0]).toMatch(/native[/\\](linux|windows)-x64[/\\]ant0_runtime\.node$/);
    expect(release).not.toHaveBeenCalled(); result.release(); result.release(); expect(release).toHaveBeenCalledTimes(1);
    release.mockClear(); native.execute.mockReturnValue({ completion: Promise.resolve({ bytes: bytes({}), release }), cancel() {} });
    await expect(executeRuntime(request.operation, request.binding, version, false)).rejects.toThrow(/invalid_response/);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("requests cancellation and waits for the owned native result before cleanup", async () => {
    const cancel = vi.fn(), release = vi.fn(), controller = new AbortController();
    let finish!: (v: any) => void;
    native.execute.mockReturnValue({ completion: new Promise(resolve => { finish = resolve; }), cancel });
    const pending = executeRuntime(request.operation, request.binding, version, false, controller.signal);
    controller.abort(); expect(cancel).toHaveBeenCalledTimes(1);
    finish({ bytes: bytes({}), release });
    await expect(pending).rejects.toThrow(/cancelled/); expect(release).toHaveBeenCalledTimes(1);
  });
});
describe("explicit binding selection", () => {
  it("uses explicit URL then option host/port then environment without token input", async () => {
    expect(await runtimeBinding({ home, url: "http://[::1]:27123", host: "invalid", port: 12 }, { ANT0D_PORT: "bad" })).toEqual({ mode: "v1", home, descriptor_path: null, endpoint: { host: "::1", port: 27123 } });
    expect((await runtimeBinding({ port: 12 }, { ANT0D_PORT: "bad" })).endpoint).toEqual({ host: "127.0.0.1", port: 12 });
  });
  it.each(["http://127.0.0.1:2/", "http://127.1:2", "http://127.0.0.2:2", "http://u@127.0.0.1:2", "https://127.0.0.1:2", "http://127.0.0.1:0", "http://127.0.0.1:2?x"])("rejects noncanonical endpoint %s before native load", async url => {
    await expect(runtimeBinding({ url }, {})).rejects.toThrow(/invalid_request/); expect(native.load).not.toHaveBeenCalled();
  });
  it("rejects explicit relative home and empty descriptor without fallback", async () => {
    await expect(runtimeBinding({ home: "relative" }, {})).rejects.toThrow(/invalid_request/);
    await expect(runtimeBinding({ descriptorPath: "" }, {})).rejects.toThrow(/invalid_request/);
  });
});
