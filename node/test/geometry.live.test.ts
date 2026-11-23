/**
 * Live-engine geometry tests. Skipped unless ANT0_BROWSER_LIVE_ENGINE points at a chrome binary
 * These belong in the local binary verification gate.
 *
 * These verify the browser's native geometry and the SDK's seedless context defaults against a real
 * engine. The SDK must not resize or move a window after launch.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchPersistentContext } from "../src/index.js";
import {
  geometryIsCoherent,
} from "../src/geometry.js";

const LIVE_EXE = process.env.ANT0_BROWSER_LIVE_ENGINE;

const READ = "[[screen.width, screen.height], [screen.availWidth, screen.availHeight], " +
  "[innerWidth, innerHeight], [outerWidth, outerHeight], [screenX, screenY], [window.__resizes]]";

async function measure(tabs = 1) {
  const dir = mkdtempSync(join(tmpdir(), "ant0-live-node-"));
  try {
    const ctx = await launchPersistentContext(dir, {
      executablePath: LIVE_EXE, args: ["--no-sandbox"], quiet: true,
      identity: { mode: "native" },
    });
    try {
      // Runs before any page script: a window resized after a page starts running JS would show up
      // here as a resize event and a jump in innerWidth.
      await ctx.addInitScript("window.__resizes = 0; addEventListener('resize', () => { window.__resizes++; }, true);");
      const out = [];
      for (let i = 0; i < tabs; i++) {
        const page = await ctx.newPage();
        await page.goto("data:text/html,<body style='margin:0'>geo</body>");
        await page.waitForTimeout(700);   // first paint: innerWidth reads 0 before it
        const m = (await page.evaluate(READ)) as number[][];
        out.push({ screen: m[0], avail: m[1], inner: m[2], outer: m[3], pos: m[4], resizes: m[5][0] });
      }
      return out;
    } finally {
      await ctx.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(LIVE_EXE)("live engine geometry", () => {
  it("omitted/native identity leaves coherent engine geometry", async () => {
    const [m] = await measure();
    expect(geometryIsCoherent(m.screen, m.avail, m.inner, m.outer)).toBe(true);
    expect(m.resizes).toBe(0);
  }, 120_000);

  it("a second tab in the same window reports the same geometry", async () => {
    const [first, second] = await measure(2);
    expect(second.screen).toEqual(first.screen);
    expect(second.inner).toEqual(first.inner);
    expect(second.outer).toEqual(first.outer);
    expect(second.resizes).toBe(0);
  }, 150_000);
});
