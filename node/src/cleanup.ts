// Process-exit cleanup registry for serve() browsers (see the notes on Server in index.ts).
import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

/** Exit-time budget: at most about this long per temp dir ... */
export const EXIT_DIR_BUDGET_MS = 1000;
/** ... and about this long across all dirs in one exit. When it runs out we give up and accept the
 * leak (an `exit` handler must not hang the process). */
export const EXIT_TOTAL_BUDGET_MS = 3000;

// ---- Cleanup registry -------------------------------------------------------------------------
// A library must not take over the process's signals, so there are NO SIGINT/SIGTERM/SIGHUP
// handlers here: Ctrl+C / SIGTERM cleanup is the application's job (call `close()`). What IS
// guaranteed is cleanup when the process exits normally (including `srv.close(); process.exit(0)`
// without awaiting): one module-level registry of live servers and in-flight launches, with a single
// `process.on("exit")` listener that is installed when the first entry is added and removed when the
// last one goes, so any number of servers never trips MaxListeners.
export interface Tracked {
  proc: ChildProcess;
  /** Set ONLY for a temp dir the SDK created itself (serve/plan). Never a caller-supplied or
   * persistent profile dir, which is left alone even when the SDK launched the browser. */
  ownDir?: string;
}
export const tracked = new Set<Tracked>();

/** Sleep without spinning: Atomics.wait on a private SharedArrayBuffer blocks the thread. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Injection points so the budget can be tested with a dir that cannot be removed. */
export interface ExitOps {
  rm(dir: string): void;
  exists(dir: string): boolean;
  sleep(ms: number): void;
  now(): number;
}
const realOps: ExitOps = {
  rm: (dir) => rmSync(dir, { recursive: true, force: true }),
  exists: existsSync,
  sleep: sleepSync,
  now: Date.now,
};

/** Remove `dir`, retrying with short sleeps until it is gone or `deadline` (ms, ops.now clock) passes. */
function removeWithin(dir: string, deadline: number, ops: ExitOps): void {
  for (let attempt = 1; ; attempt++) {
    try { ops.rm(dir); if (!ops.exists(dir)) return; } catch { /* retry until the deadline */ }
    const left = deadline - ops.now();
    if (left <= 0) return;                       // budget spent: accept the leak
    ops.sleep(Math.min(50 * attempt, left));
  }
}

/** Runs inside the "exit" event, so it is SYNCHRONOUS (process.kill, fs.rmSync and a blocking sleep
 * only; anything awaited or promise-based never runs there). Bounded: about EXIT_DIR_BUDGET_MS per
 * dir and EXIT_TOTAL_BUDGET_MS in all. */
export function runExitCleanup(entries: Iterable<Tracked> = tracked, ops: ExitOps = realOps): void {
  const list = [...entries];
  const start = ops.now();
  for (const t of list) {
    // A throwaway temp profile has nothing to flush, and Chromium writes "Local State" back during a
    // graceful shutdown, which would recreate the dir we are about to remove: SIGKILL. Persistent and
    // caller-supplied dirs (no ownDir) still get SIGTERM so they shut down gracefully.
    // A caller-supplied dir whose browser close() has already sent SIGTERM (proc.killed) is not signalled
    // again: Chromium restores the default SIGTERM handler after the first one, so a second SIGTERM
    // would kill it mid-shutdown and leave the profile without Preferences / a clean exit marker.
    try {
      if (t.proc.exitCode === null && t.proc.signalCode === null && (t.ownDir || !t.proc.killed))
        t.proc.kill(t.ownDir ? "SIGKILL" : "SIGTERM");
    } catch { /* gone */ }
  }
  for (const t of list) {
    if (!t.ownDir) continue;
    const now = ops.now();
    removeWithin(t.ownDir, Math.min(now + EXIT_DIR_BUDGET_MS, start + EXIT_TOTAL_BUDGET_MS), ops);
  }
}


function killTrackedAtExit(): void { runExitCleanup(); }

export function track(proc: ChildProcess, ownDir?: string): Tracked {
  const entry: Tracked = { proc, ownDir };
  if (tracked.size === 0) process.on("exit", killTrackedAtExit);
  tracked.add(entry);
  return entry;
}

export function untrack(entry: Tracked): void {
  tracked.delete(entry);
  if (tracked.size === 0) process.removeListener("exit", killTrackedAtExit);
}

/** Remove a profile dir we created. Retries because a browser that is still shutting down can
 * recreate files for a moment; never throws. */
export async function removeOwnDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); if (!existsSync(dir)) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
  }
}

/** Stop a child we spawned and wait until it has exited: SIGTERM first (a graceful shutdown, so a
 * persistent profile keeps its writes), SIGKILL only as a fallback after `graceMs`. */
export async function stopChild(proc: ChildProcess, graceMs = 5000, killMs = 2000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
  try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  await Promise.race([exited, wait(graceMs)]);
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    await Promise.race([exited, wait(killMs)]);
  }
}

