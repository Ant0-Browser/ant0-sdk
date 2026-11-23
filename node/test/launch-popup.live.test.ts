/**
 * Live-engine check that launch() no longer passes --disable-popup-blocking and --hide-scrollbars. Skipped unless
 * ANT0_BROWSER_LIVE_ENGINE points at a chrome binary (the local binary verification gate).
 * ANT0_BROWSER_LIVE_MINT (a script that prints a launch ticket for the version given as its argument) and
 * ANT0_BROWSER_LIVE_ENGINE_VERSION are used for an engine that checks launch tickets.
 *
 * A click on a button whose handler calls window.open must still open a popup that the context's `page` event
 * reports, and the two switches must really be gone from the browser a page sees.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launch, launchPersistentContext } from "../src/index.js";

const LIVE_EXE = process.env.ANT0_BROWSER_LIVE_ENGINE;

const BUTTON = "data:text/html,<button id=b onclick=\"window.open('about:blank%23popup')\">open</button>";
// A page whose own timer calls window.open() (no user gesture): null (or undefined) with popup blocking on, a Window
// with --disable-popup-blocking. The test must not evaluate while waiting: Playwright evaluates with a user gesture,
// which allows the popup.
const TIMER = "data:text/html,<title>wait</title><script>setTimeout(() => { document.title = " +
  "(w => w === null || w === undefined)(window.open('about:blank%23timer')) ? 'blocked' : 'opened'; }, 300)</script>";
// A scrollbar is 15 px wide unless --hide-scrollbars is passed.
const TALL = "data:text/html,<body style='margin:0'><div style='height:5000px'>tall</div></body>";

function launchTicket(): string | false {
  const mint = process.env.ANT0_BROWSER_LIVE_MINT;
  const version = process.env.ANT0_BROWSER_LIVE_ENGINE_VERSION;
  return mint && version ? execFileSync("python3", ["-I", mint, version], { encoding: "utf8" }).trim() : false;
}
const opts = () => ({
  executablePath: LIVE_EXE, args: ["--no-sandbox"], quiet: true, launchTicket: launchTicket(), headless: true,
  identity: { mode: "native" },
}) as any;

async function check(page: any, ctx: any) {
  const seen: any[] = [];
  ctx.on("page", (p: any) => seen.push(p));
  await page.goto(BUTTON);
  const [popup] = await Promise.all([ctx.waitForEvent("page"), page.click("#b")]);
  expect(popup.url()).toBe("about:blank#popup");
  expect(seen.map((p) => p.url())).toContain("about:blank#popup"); // context.on('page') fired
  await page.goto(TIMER);
  await page.waitForTimeout(1000);
  expect(await page.title()).toBe("blocked"); // popup blocking is on, as in a normal Chrome
  await page.goto(TALL);
  expect(await page.evaluate("window.innerWidth - document.documentElement.clientWidth")).toBeGreaterThan(0); // scrollbars shown
}

describe.runIf(LIVE_EXE)("live engine: popups and scrollbars", () => {
  it("launch(): a click popup opens and the context reports it; blocking and scrollbars are on", async () => {
    const browser = await launch(opts());
    try {
      const ctx = await browser.newContext();
      await check(await ctx.newPage(), ctx);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("launchPersistentContext(): the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ant0-popup-live-"));
    try {
      const ctx = await launchPersistentContext(dir, opts());
      try {
        await check(await ctx.newPage(), ctx);
      } finally {
        await ctx.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
