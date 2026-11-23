// setContent: Playwright's `page.setContent` times out on Ant0 (the engine removes the
// `console.debug` handshake it waits on). This sets the document the plain-DOM way instead:
// `document.open()`, `document.write(html)`, `document.close()`, then waits for the same lifecycle
// point. Mirror of the Python ant0browser `set_content`.

import type { Frame, Page } from "playwright-core";

export interface SetContentOptions {
  /** Lifecycle point to wait for: "load" (default), "domcontentloaded", "networkidle" or "commit"
   * (return right after `document.close()`). */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /** Milliseconds (default 30000). 0 disables the limit. */
  timeout?: number;
}

// Runs in the page. Plain function (not a string) so Playwright calls it with the argument.
function writeDocument(args: { html: string; until: string }): Promise<void> {
  // The SDK compiles without the DOM lib, so the page's document is reached untyped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const document = (globalThis as any).document;
  return new Promise<void>((resolve) => {
    document.open();
    document.write(args.html);
    document.close();
    const done = () => {
      const rs = document.readyState;
      return args.until === "load" ? rs === "complete" : rs === "interactive" || rs === "complete";
    };
    if (args.until === "commit" || done()) { resolve(); return; }
    document.addEventListener("readystatechange", () => { if (done()) resolve(); });
  });
}

/** Replace the page's (or frame's) document with `html` and wait. Use instead of `page.setContent`. */
export async function setContent(
  target: Page | Frame, html: string, options: SetContentOptions = {},
): Promise<void> {
  const until = options.waitUntil ?? "load";
  if (!["load", "domcontentloaded", "networkidle", "commit"].includes(until)) {
    throw new TypeError(`setContent: unsupported waitUntil ${JSON.stringify(until)}`);
  }
  const timeout = options.timeout ?? 30000;
  const write = target.evaluate(writeDocument, { html: String(html), until: until === "networkidle" ? "load" : until }) as Promise<void>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = timeout > 0
    ? new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`setContent: timeout ${timeout}ms exceeded waiting for "${until}"`)), timeout);
      })
    : undefined;
  try {
    await (limit ? Promise.race([write, limit]) : write);
    if (until === "networkidle") {
      const page = "page" in target && typeof (target as Frame).page === "function" ? (target as Frame).page() : (target as Page);
      await page.waitForLoadState("networkidle", timeout > 0 ? { timeout } : undefined);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
