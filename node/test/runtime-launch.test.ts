import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), binding: vi.fn(), check: vi.fn() }));
vi.mock("../src/download.js", () => ({ checkInstall: mocks.check }));
vi.mock("../src/runtime-client.js", async original => ({ ...await original<typeof import("../src/runtime-client.js")>(), executeRuntime: mocks.execute, runtimeBinding: mocks.binding }));
import { prepareRuntimeLaunch, withRuntimeLaunch } from "../src/runtime-launch.js";
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
it.each([{ launchTicket: false as const }, { launchTicket: "a.b.c.d.e" }, { args: ["--ant0-launch=opaque"] }, { launchTicket: "bad", args: ["--ant0-launch"] }])("manual override is offline: %j", async options => {
  vi.stubEnv("ANT0_BROWSER_BINARY", "");
  await prepareRuntimeLaunch({ executablePath: "/manual/chrome", ...options });
  expect(mocks.binding).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
});
it.each([{ launchTicket: false as const }, { launchTicket: "a.b.c.d.e" }, { args: ["--ant0-launch=opaque"] }])("automatic override discovers with ticket_fetch false: %j", async options => {
  vi.stubEnv("ANT0_BROWSER_BINARY", ""); vi.stubEnv("ANT0_TOKEN", undefined);
  const release = vi.fn(); mocks.execute.mockResolvedValue({ value: { engine: { executable: "/signed/chrome" }, ticket: null }, release });
  const r = await prepareRuntimeLaunch(options); expect(mocks.execute.mock.calls[0][3]).toBe(false);
  expect(release).not.toHaveBeenCalled(); r.release(); expect(release).toHaveBeenCalledOnce();
});
it("holds pins through failed spawn and releases in finally", async () => {
  vi.stubEnv("ANT0_BROWSER_BINARY", ""); vi.stubEnv("ANT0_TOKEN", undefined);
  const release = vi.fn(); mocks.execute.mockResolvedValue({ value: { engine: { executable: "/signed/chrome" }, ticket: null }, release });
  await expect(withRuntimeLaunch({ launchTicket: false }, async () => { expect(release).not.toHaveBeenCalled(); throw new Error("spawn failed"); })).rejects.toThrow("spawn failed");
  expect(release).toHaveBeenCalledOnce();
});
it("automatic discovery rejects a bearer override before binding or native access", async () => {
  vi.stubEnv("ANT0_BROWSER_BINARY", ""); vi.stubEnv("ANT0_TOKEN", "caller-token");
  await expect(prepareRuntimeLaunch({ launchTicket: false })).rejects.toThrow(/invalid_request/);
  expect(mocks.binding).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
});
