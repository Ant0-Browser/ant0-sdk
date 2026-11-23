import { describe, it, expect, vi } from "vitest";
import { setContent } from "../src/content.js";

// A fake page that runs the in-page function against a minimal fake document.
function fakePage(readyAfterClose: string) {
  const calls: string[] = [];
  const listeners: Array<() => void> = [];
  const doc = {
    readyState: "loading",
    open: () => calls.push("open"),
    write: (h: string) => calls.push("write:" + h),
    close: () => { calls.push("close"); doc.readyState = readyAfterClose; },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  const page = {
    evaluate: vi.fn(async (fn: (a: unknown) => unknown, arg: unknown) => {
      (globalThis as any).document = doc;
      try { return await fn(arg); } finally { delete (globalThis as any).document; }
    }),
    waitForLoadState: vi.fn(async () => undefined),
  };
  return { page, calls, doc, listeners };
}

describe("setContent", () => {
  it("writes through document.open/write/close and does not use page.setContent", async () => {
    const f = fakePage("complete");
    await setContent(f.page as never, "<p>x</p>");
    expect(f.calls).toEqual(["open", "write:<p>x</p>", "close"]);
  });

  it("waits for load: resolves on the readystatechange that reaches complete", async () => {
    const f = fakePage("interactive");
    let done = false;
    const p = setContent(f.page as never, "<p>x</p>").then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    f.doc.readyState = "complete";
    f.listeners.forEach((fn) => fn());
    await p;
    expect(done).toBe(true);
  });

  it("domcontentloaded resolves at interactive; commit resolves right after close", async () => {
    await setContent(fakePage("interactive").page as never, "x", { waitUntil: "domcontentloaded" });
    await setContent(fakePage("loading").page as never, "x", { waitUntil: "commit" });
  });

  it("networkidle waits for load, then asks Playwright for network idle", async () => {
    const f = fakePage("complete");
    await setContent(f.page as never, "x", { waitUntil: "networkidle", timeout: 5000 });
    expect(f.page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 5000 });
  });

  it("times out when the document never loads, and rejects an unknown waitUntil", async () => {
    await expect(setContent(fakePage("loading").page as never, "x", { timeout: 30 })).rejects.toThrow(/timeout 30ms/);
    await expect(setContent(fakePage("complete").page as never, "x", { waitUntil: "nope" as never })).rejects.toThrow(/unsupported waitUntil/);
  });
});
