// The launch ticket travels in ANT0_LAUNCH of the engine child as well as in --ant0-launch= (the engine reads
// the environment first; older engines read only argv). Playwright and the spawn are stubbed at the call, so these
// assert what actually reaches the engine.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let spawnFailure: Error | undefined;
const spawned: { args: string[]; env: Record<string, string | undefined> | undefined }[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...real,
    spawn: (exe: string, args: string[], options?: { env?: Record<string, string> }) => {
      if (!String(exe).includes("fake-engine-real")) {
        spawned.push({ args, env: options?.env });
        const child = new EventEmitter() as any;
        child.pid = 1;
        setImmediate(() => (spawnFailure ? child.emit("error", spawnFailure) : child.emit("spawn")));
        return child;
      }
      return (real.spawn as any)(exe, args, options);
    },
  };
});

import {
  LAUNCH_TICKET_ENV, LaunchTicketRejectedError, launch, launchPersistentContext, launchPlan, launchTicketRejection, serve,
} from "../src/index.js";
import { applyTicketEnv, argsForTicketDecision, callerEnvTicket, launchSecretValues, redactError, redactLaunchSecrets, rethrowIfTicketRejected } from "../src/launch-ticket.js";

const MARKER = Buffer.from("ant0-browser-capabilities/persona-profile-v1");
const TICKET = "eyJraWQiOiJTRUNSRVQtMSIsInYiOjF9.eyJkZXYiOiJTRUNSRVQifQ.c2lnU0VDUkVU.eyJlbmciOiJTRUNSRVQifQ.Y3NpZ1NFQ1JFVA";
const OTHER = "eyJraWQiOiJTRUNSRVQtMiIsInYiOjF9.eyJkZXYiOiJPVEhFUiJ9.b3RoZXJTRUNSRVQ.eyJlbmciOiJPVEhFUiJ9.b3RoZXJzaWc";

let dir: string;
let exe: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ant0-tkenv-"));
  exe = join(dir, "chrome");
  writeFileSync(exe, Buffer.concat([Buffer.alloc(64, "x"), MARKER]));
  spawned.length = 0;
  spawnFailure = undefined;
  delete process.env[LAUNCH_TICKET_ENV];
});
const planDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  for (const d of planDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[LAUNCH_TICKET_ENV];
});

const base = (extra: Record<string, unknown> = {}) => ({
  executablePath: exe, identity: { mode: "native" }, headless: true, quiet: true, launchTicket: TICKET, ...extra,
});
async function captureIncognito(opts: Record<string, unknown>): Promise<any> {
  let seen: any;
  vi.spyOn(chromium, "launch").mockImplementation((async (o: any) => { seen = o; throw new Error("stop"); }) as any);
  await launch({ ...base(opts), ephemeralProfile: false } as any).catch(() => {});
  return seen;
}
async function capturePersistent(opts: Record<string, unknown>): Promise<any> {
  let seen: any;
  vi.spyOn(chromium, "launchPersistentContext").mockImplementation((async (_d: string, o: any) => { seen = o; throw new Error("stop"); }) as any);
  await launchPersistentContext(join(dir, "udd"), base(opts) as any).catch(() => {});
  return seen;
}
async function capturePlan(opts: Record<string, unknown>): Promise<any> {
  const plan = await launchPlan({ ...base(opts), userDataDir: join(dir, "plan-udd") } as any);
  return { args: plan.args, env: plan.env };
}
async function captureSpawn(opts: Record<string, unknown>): Promise<any> {
  const plan = await launchPlan({ ...base(opts), userDataDir: join(dir, "spawn-udd") } as any);
  await plan.spawn!();
  return spawned.at(-1);
}
const argvTicket = (args: string[]) => args.filter((a) => a.startsWith("--ant0-launch=")).map((a) => a.slice("--ant0-launch=".length));

const PATHS = [
  ["launch", captureIncognito],
  ["launchPersistentContext", capturePersistent],
  ["launchPlan", capturePlan],
  ["launchPlan().spawn (serve)", captureSpawn],
] as const;

describe.each(PATHS)("%s", (_name, run) => {
  it("passes the same ticket in argv and in ANT0_LAUNCH of the engine env", async () => {
    const seen = await run({});
    expect(argvTicket(seen.args)).toEqual([TICKET]);
    expect(seen.env?.[LAUNCH_TICKET_ENV]).toBe(TICKET);
  });
  it("never sets it in the SDK's own process.env", async () => {
    const before = { ...process.env };
    await run({});
    expect(process.env[LAUNCH_TICKET_ENV]).toBeUndefined();
    expect(process.env).toEqual(before);
  });
  it("keeps the caller's other env entries", async () => {
    const seen = await run({ env: { KEEP_ME: "1" } });
    expect(seen.env.KEEP_ME).toBe("1");
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(TICKET);
  });
  it("does not overwrite a caller's ANT0_LAUNCH, and mirrors it into argv (no second ticket fetched or passed)", async () => {
    const seen = await run({ launchTicket: undefined, env: { [LAUNCH_TICKET_ENV]: OTHER } });
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(OTHER);
    expect(argvTicket(seen.args)).toEqual([OTHER]);
  });
  it("treats a caller's ANT0_LAUNCH like a caller's --ant0-launch=: the launchTicket option does not add a different one", async () => {
    const seen = await run({ launchTicket: TICKET, env: { [LAUNCH_TICKET_ENV]: OTHER } });
    expect(argvTicket(seen.args)).toEqual([OTHER]);
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(OTHER);
  });
  it("mirrors a caller's --ant0-launch= into the env", async () => {
    const seen = await run({ launchTicket: undefined, args: [`--ant0-launch=${OTHER}`] });
    expect(argvTicket(seen.args)).toEqual([OTHER]);
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(OTHER);
  });
  it("leaves both alone, and refuses nothing, when the caller gave two different tickets", async () => {
    const seen = await run({ args: [`--ant0-launch=${TICKET}`], env: { [LAUNCH_TICKET_ENV]: OTHER } });
    expect(argvTicket(seen.args)).toEqual([TICKET]);
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(OTHER);
  });
  it("sets nothing when there is no ticket at all", async () => {
    const seen = await run({ launchTicket: false });
    expect(argvTicket(seen.args)).toEqual([]);
    expect(seen.env?.[LAUNCH_TICKET_ENV]).toBeUndefined();
  });
});

describe("launchPlan", () => {
  it("documents and carries the env entry in plan.env, a plain string map", async () => {
    const plan = await launchPlan({ ...base(), userDataDir: join(dir, "p") } as any);
    expect(plan.env[LAUNCH_TICKET_ENV]).toBe(TICKET);
    expect(Object.values(plan.env).every((v) => typeof v === "string")).toBe(true);
    expect(process.env[LAUNCH_TICKET_ENV]).toBeUndefined();
  });
});

describe("serve() with a real child", () => {
  it.skipIf(process.platform === "win32")("the engine child sees ANT0_LAUNCH and --ant0-launch= with the same value", async () => {
    const out = join(dir, "out");
    const engine = join(dir, "fake-engine-real");
    writeFileSync(engine, `#!/bin/sh\n# ${MARKER.toString()}\nprintf '%s' "$ANT0_LAUNCH" > "${out}.env"\nfor a in "$@"; do case "$a" in --ant0-launch=*) printf '%s' "\${a#--ant0-launch=}" > "${out}.argv";; esac; done\necho "env dump: ANT0_LAUNCH=$ANT0_LAUNCH $*" >&2\nexit 90\n`);
    chmodSync(engine, 0o755);
    const error: any = await serve({ executablePath: engine, identity: { mode: "native" }, quiet: true, launchTicket: TICKET, readyTimeoutMs: 5000 }).catch((e) => e);
    expect(readFileSync(`${out}.env`, "utf8")).toBe(TICKET);
    expect(readFileSync(`${out}.argv`, "utf8")).toBe(TICKET);
    expect(process.env[LAUNCH_TICKET_ENV]).toBeUndefined();
    // The engine echoed its environment on exit 90: nothing of the ticket reaches the error.
    expect(error).toBeInstanceOf(LaunchTicketRejectedError);
    expect(JSON.stringify([error.message, error.stack, Object.getOwnPropertyNames(error).map((k) => String(error[k]))])).not.toContain("SECRET");
  });
});

describe("serve() exit-90 error when the env ticket is not the argv one", () => {
  it.skipIf(process.platform === "win32")("redacts the ANT0_LAUNCH value although no argv copy carries it", async () => {
    // Two different caller tickets are both left alone (see the rule): the argv one is A, the env one is B.
    // The engine prints only B, so the only way to hide it is to know the env value.
    const engine = join(dir, "fake-engine-real");
    writeFileSync(engine, `#!/bin/sh\n# ${MARKER.toString()}\necho "ANT0_LAUNCH=$ANT0_LAUNCH" >&2\nexit 90\n`);
    chmodSync(engine, 0o755);
    const error: any = await serve({
      executablePath: engine, identity: { mode: "native" }, quiet: true, launchTicket: false, readyTimeoutMs: 5000,
      args: [`--ant0-launch=${TICKET}`], env: { [LAUNCH_TICKET_ENV]: OTHER },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LaunchTicketRejectedError);
    expect(error.message).toContain("ANT0_LAUNCH=<redacted>");
    expect(JSON.stringify([error.message, error.stack, error.detail])).not.toContain("SECRET");
  });
});

describe("redaction of the environment copy", () => {
  it("launchSecretValues takes ANT0_LAUNCH of the env as an exact secret", () => {
    const secrets = launchSecretValues([], [], { [LAUNCH_TICKET_ENV]: OTHER });
    expect(secrets.exact).toContain(OTHER);
    expect(redactLaunchSecrets(`env: ANT0_LAUNCH=${OTHER}; PATH=/bin`, secrets)).toBe("env: ANT0_LAUNCH=<redacted>; PATH=/bin");
    expect(launchSecretValues([], [], {}).exact).toEqual([]);
  });
  it("a launch failure that dumps the environment is redacted, and its env/spawnargs properties are dropped", () => {
    const e: any = new Error(`browserType.launch: failed\nenv: { ANT0_LAUNCH: '${TICKET}' }\nANT0_LAUNCH=${TICKET}`);
    e.env = { ANT0_LAUNCH: TICKET };
    const secrets = launchSecretValues([], [], { [LAUNCH_TICKET_ENV]: TICKET });
    const fresh: any = redactError(e, secrets);
    expect("env" in fresh).toBe(false);
    expect(fresh.message).not.toContain("SECRET");
    expect(fresh.message).not.toContain(TICKET);
    expect(fresh.stack).not.toContain(TICKET);
    expect(e.env.ANT0_LAUNCH).toBe(TICKET); // the shared object was not modified
  });
  it("an error with only an env property (clean message) is still replaced by a copy without it", () => {
    const e: any = new Error("spawn failed");
    e.env = { ANT0_LAUNCH: TICKET };
    expect("env" in (redactError(e, launchSecretValues([], [], { [LAUNCH_TICKET_ENV]: TICKET })) as object)).toBe(false);
  });
  it("launch(): a Playwright failure carrying the env is rethrown without it", async () => {
    const boom: any = new Error(`browserType.launch: Browser closed\nANT0_LAUNCH=${TICKET}`);
    boom.env = { ANT0_LAUNCH: TICKET };
    vi.spyOn(chromium, "launch").mockRejectedValue(boom);
    const error: any = await launch({ ...base(), ephemeralProfile: false } as any).catch((e) => e);
    expect(error.message).not.toContain(TICKET);
    expect("env" in error).toBe(false);
  });
  it("launchPersistentContext(): the same", async () => {
    const boom: any = new Error(`browserType.launchPersistentContext: Browser closed\nANT0_LAUNCH=${TICKET}`);
    boom.env = { ANT0_LAUNCH: TICKET };
    vi.spyOn(chromium, "launchPersistentContext").mockRejectedValue(boom);
    const error: any = await launchPersistentContext(join(dir, "udd"), base() as any).catch((e) => e);
    expect(error.message).not.toContain(TICKET);
    expect("env" in error).toBe(false);
  });
});

describe("claim_stale", () => {
  it("is read from the exit-90 line like claim_expired and maps to the same error", () => {
    expect(launchTicketRejection("x\nant0: launch ticket invalid (claim_stale)\ny")).toBe("claim_stale");
    const stale = new LaunchTicketRejectedError("claim_stale");
    const expired = new LaunchTicketRejectedError("claim_expired");
    expect(stale.code).toBe(expired.code);
    expect(stale.errorClass).toBe(expired.errorClass);
    expect(stale.reason).toBe("claim_stale");
    expect(stale.message.replace("claim_stale", "X")).toBe(expired.message.replace("claim_expired", "X"));
    expect(() => rethrowIfTicketRejected(new Error("Browser closed\nant0: launch ticket invalid (claim_stale)\n<process did exit: exitCode=90>")))
      .toThrow(LaunchTicketRejectedError);
  });
});

// ------------------------------------------------------------------ an inherited ANT0_LAUNCH is not the caller's ticket
const STALE = "STALE-INHERITED-TICKET";
const FETCHED = "eyJraWQiOiJGRVRDSCIsInYiOjF9.eyJkZXYiOiJGRVRDSCJ9.ZmV0Y2hzaWc.eyJlbmciOiJGRVRDSCJ9.ZmV0Y2hjc2ln";
const serialized = (seen: any) => JSON.stringify([seen.args, seen.env]);

describe.each(PATHS)("%s: ANT0_LAUNCH=STALE in the SDK's own environment", (_name, run) => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env[LAUNCH_TICKET_ENV] = STALE;
    process.env.ANT0_URL = "http://127.0.0.1:1";
    process.env.ANT0_TOKEN = "tok-test";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ launch: FETCHED }), { status: 200, headers: { "content-type": "application/json" } })) as any);
  });
  afterEach(() => {
    delete process.env[LAUNCH_TICKET_ENV];
    delete process.env.ANT0_URL;
    delete process.env.ANT0_TOKEN;
  });

  it("no ticket option: the daemon is asked, and the fetched ticket (not STALE) is in argv and env", async () => {
    const seen = await run({ launchTicket: undefined, engineVersion: "149.0.7827.114-ant0.9" });
    expect(fetchSpy).toHaveBeenCalled(); // launchPlan().spawn() asks again at spawn time
    expect(argvTicket(seen.args)).toEqual([FETCHED]);
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(FETCHED);
    expect(serialized(seen)).not.toContain(STALE);
  });
  it("no ticket option and no daemon ticket: the engine gets neither argv nor env ticket, never STALE", async () => {
    const seen = await run({ launchTicket: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(argvTicket(seen.args)).toEqual([]);
    expect(seen.env).toBeDefined();
    expect(LAUNCH_TICKET_ENV in seen.env).toBe(false);
    expect(serialized(seen)).not.toContain(STALE);
  });
  it("an explicit launchTicket wins: argv and env carry it, and no fetch happens", async () => {
    const seen = await run({ launchTicket: TICKET, engineVersion: "149.0.7827.114-ant0.9" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(argvTicket(seen.args)).toEqual([TICKET]);
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(TICKET);
    expect(serialized(seen)).not.toContain(STALE);
  });
  it("an argv ticket (as ant0d's launchPlan passes it): env carries the same one, no fetch", async () => {
    const seen = await run({ launchTicket: undefined, engineVersion: "149.0.7827.114-ant0.9", args: [`--ant0-launch=${OTHER}`] });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(argvTicket(seen.args)).toEqual([OTHER]);
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(OTHER);
    expect(serialized(seen)).not.toContain(STALE);
  });
  it("an explicit env ticket beats the inherited one", async () => {
    const seen = await run({ launchTicket: undefined, env: { [LAUNCH_TICKET_ENV]: OTHER } });
    expect(argvTicket(seen.args)).toEqual([OTHER]);
    expect(seen.env[LAUNCH_TICKET_ENV]).toBe(OTHER);
    expect(serialized(seen)).not.toContain(STALE);
  });
  it("an explicit empty env ticket is no ticket, and STALE still does not leak", async () => {
    const seen = await run({ launchTicket: false, env: { [LAUNCH_TICKET_ENV]: "" } });
    expect(LAUNCH_TICKET_ENV in seen.env).toBe(false);
    expect(serialized(seen)).not.toContain(STALE);
  });
  it("leaves the SDK's own environment as it was", async () => {
    await run({ launchTicket: TICKET });
    expect(process.env[LAUNCH_TICKET_ENV]).toBe(STALE);
  });
});

describe("applyTicketEnv / callerEnvTicket / argsForTicketDecision", () => {
  const ARG = `--ant0-launch=${TICKET}`;
  it("always returns a fresh env copy, never undefined, and never the inherited ticket", () => {
    process.env[LAUNCH_TICKET_ENV] = STALE;
    try {
      const none = applyTicketEnv([], undefined);
      expect(none.env).toBeDefined();
      expect(none.env).not.toBe(process.env);
      expect(LAUNCH_TICKET_ENV in none.env).toBe(false);
      expect(applyTicketEnv([ARG], undefined).env[LAUNCH_TICKET_ENV]).toBe(TICKET);
      const given = { KEEP: "1", [LAUNCH_TICKET_ENV]: STALE };
      const out = applyTicketEnv([], given);
      expect(out.env).not.toBe(given);
      expect(out.env).toEqual({ KEEP: "1" });
      expect(given[LAUNCH_TICKET_ENV]).toBe(STALE); // the input was not modified
      expect(process.env[LAUNCH_TICKET_ENV]).toBe(STALE);
    } finally {
      delete process.env[LAUNCH_TICKET_ENV];
    }
  });
  it("only the caller's explicit env counts: process.env never does", () => {
    process.env[LAUNCH_TICKET_ENV] = STALE;
    try {
      expect(callerEnvTicket(undefined)).toBeUndefined();
      expect(callerEnvTicket({})).toBeUndefined();
      expect(callerEnvTicket({ [LAUNCH_TICKET_ENV]: OTHER })).toBe(OTHER);
      expect(argsForTicketDecision(["--x"], undefined)).toEqual(["--x"]);
      expect(argsForTicketDecision([], { [LAUNCH_TICKET_ENV]: OTHER })).toEqual([`--ant0-launch=${OTHER}`]);
    } finally {
      delete process.env[LAUNCH_TICKET_ENV];
    }
  });
  it("on Windows the key is matched case-insensitively and the copy never holds two spellings", () => {
    const env = { ant0_launch: STALE, Path: "C:\\x", ANT0_Launch: STALE };
    const out = applyTicketEnv([ARG], env, undefined, true);
    expect(Object.keys(out.env).filter((k) => k.toUpperCase() === LAUNCH_TICKET_ENV)).toEqual([LAUNCH_TICKET_ENV]);
    expect(out.env[LAUNCH_TICKET_ENV]).toBe(TICKET);
    expect(out.env.Path).toBe("C:\\x");
    expect(Object.keys(applyTicketEnv([], env, undefined, true).env).filter((k) => k.toUpperCase() === LAUNCH_TICKET_ENV)).toEqual([]);
    // A caller's lower-case spelling is the caller's ticket there, and is rewritten to the one canonical key.
    const caller = { ant0_launch: OTHER };
    expect(callerEnvTicket(caller, true)).toBe(OTHER);
    const mirrored = applyTicketEnv([], { ...caller, Path: "p" }, caller, true);
    expect(mirrored.args).toEqual([`--ant0-launch=${OTHER}`]);
    expect(Object.keys(mirrored.env).filter((k) => k.toUpperCase() === LAUNCH_TICKET_ENV)).toEqual([LAUNCH_TICKET_ENV]);
    expect(mirrored.env[LAUNCH_TICKET_ENV]).toBe(OTHER);
  });
  it("elsewhere a lower-case spelling is a different variable: left alone, and not a ticket", () => {
    const out = applyTicketEnv([ARG], { ant0_launch: "x" }, { ant0_launch: OTHER }, false);
    expect(out.env.ant0_launch).toBe("x");
    expect(out.env[LAUNCH_TICKET_ENV]).toBe(TICKET);
    expect(callerEnvTicket({ ant0_launch: OTHER }, false)).toBeUndefined();
  });
  it("the space form is not parsed or mirrored: it is a caller argument left to the engine", async () => {
    const out = applyTicketEnv(["--ant0-launch", OTHER], undefined);
    expect(LAUNCH_TICKET_ENV in out.env).toBe(false);
    expect(out.args).toEqual(["--ant0-launch", OTHER]);
    const seen = await captureIncognito({ launchTicket: undefined, args: ["--ant0-launch", OTHER] });
    expect(seen.args).toEqual(expect.arrayContaining(["--ant0-launch", OTHER]));
    expect(argvTicket(seen.args)).toEqual([]);
    expect(LAUNCH_TICKET_ENV in seen.env).toBe(false);
  });
});

describe("serve() spawn failure", () => {
  it("redacts plan.env: an env ticket that is not in argv is hidden from a spawn error", async () => {
    // argv carries A, the caller's env carries B (both left alone); the spawn error quotes only B.
    spawnFailure = Object.assign(new Error(`spawn failed with env ANT0_LAUNCH=${OTHER}`), { env: { [LAUNCH_TICKET_ENV]: OTHER } });
    const error: any = await serve({
      executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: false, readyTimeoutMs: 2000,
      args: [`--ant0-launch=${TICKET}`], env: { [LAUNCH_TICKET_ENV]: OTHER },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify([error.message, error.stack])).not.toContain(OTHER);
    expect("env" in error).toBe(false);
  });
});

// ------------------------------------------------------------------ one retry when a fetched ticket went stale
const ticketN = (n: number) => `eyJraWQiOiJGRVRDSCIsInYiOjF9.eyJkZXYiOiJGRVRDSCJ9.ZmV0Y2hzaWc${n}.eyJlbmciOiJGRVRDSCJ9.ZmV0Y2hjc2ln`;
// A regression that allows a third attempt must FAIL at once, not loop: the stub throws a plain (non-retryable) error
// as soon as attempt 3 starts, which ends any retry loop and shows up as a wrong count / error kind.
const attemptReason = (calls: unknown[], reasons: string[]) => {
  if (calls.length > 2) throw new Error(`unexpected launch attempt ${calls.length}: only one retry is allowed`);
  return reasons[calls.length - 1] ?? reasons.at(-1)!;
};
const exit90 = (reason: string) => new Error(`browserType.launch: Browser closed\nant0: launch ticket invalid (${reason})\n<process did exit: exitCode=90>`);

describe("retry once with a freshly fetched ticket", { timeout: 15000 }, () => {
  let fetches: number;
  beforeEach(() => {
    process.env.ANT0_URL = "http://127.0.0.1:1";
    process.env.ANT0_TOKEN = "tok-test";
    fetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: any) => {
      if (!String(url).includes("/v1/licence/ticket")) throw new Error("not up"); // serve()'s CDP readiness probe
      fetches += 1;
      return new Response(JSON.stringify({ launch: ticketN(fetches) }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any);
  });
  afterEach(() => {
    delete process.env.ANT0_URL;
    delete process.env.ANT0_TOKEN;
  });
  const SDK_FETCHED = { launchTicket: undefined, engineVersion: "149.0.7827.114-ant0.9" };

  describe.each([
    ["launch", async (o: Record<string, unknown>, calls: any[], reasons: string[]) => {
      vi.spyOn(chromium, "launch").mockImplementation((async (opts: any) => { calls.push(opts); throw exit90(attemptReason(calls, reasons)); }) as any);
      return launch({ ...base(o), ephemeralProfile: false } as any).catch((e) => e);
    }],
    ["launchPersistentContext", async (o: Record<string, unknown>, calls: any[], reasons: string[]) => {
      vi.spyOn(chromium, "launchPersistentContext").mockImplementation((async (_d: string, opts: any) => { calls.push(opts); throw exit90(attemptReason(calls, reasons)); }) as any);
      return launchPersistentContext(join(dir, "udd"), base(o) as any).catch((e) => e);
    }],
  ] as const)("%s", (_name, run) => {
    it.each(["claim_expired", "claim_stale"])("retries exactly once on %s, with a ticket fetched right before the respawn", async (reason) => {
      const calls: any[] = [];
      const error = await run(SDK_FETCHED, calls, [reason]);
      expect(calls).toHaveLength(2);
      expect(fetches).toBe(2);
      expect(argvTicket(calls[0].args)).toEqual([ticketN(1)]);
      expect(argvTicket(calls[1].args)).toEqual([ticketN(2)]);
      expect(calls[1].env[LAUNCH_TICKET_ENV]).toBe(ticketN(2));
      // The second failure surfaces as today, and there is no third attempt.
      expect(error).toBeInstanceOf(LaunchTicketRejectedError);
      expect((error as LaunchTicketRejectedError).reason).toBe(reason);
    });
    it("a second exit 90 of the other retryable kind is still not retried again", async () => {
      const calls: any[] = [];
      const error = await run(SDK_FETCHED, calls, ["claim_expired", "claim_stale"]);
      expect(calls).toHaveLength(2);
      expect((error as LaunchTicketRejectedError).reason).toBe("claim_stale");
    });
    it.each(["bad_signature", "wrong_engine", "missing", "past_grace", "claim_mismatch"])("does not retry for %s", async (reason) => {
      const calls: any[] = [];
      const error = await run(SDK_FETCHED, calls, [reason]);
      expect(calls).toHaveLength(1);
      expect(fetches).toBe(1);
      expect(error).toBeInstanceOf(LaunchTicketRejectedError);
    });
    it.each([
      ["the launchTicket option", { launchTicket: TICKET }],
      ["an argv ticket", { launchTicket: undefined, args: [`--ant0-launch=${OTHER}`] }],
      ["an explicit env ticket", { launchTicket: undefined, env: { [LAUNCH_TICKET_ENV]: OTHER } }],
    ])("does not retry a ticket the caller provided (%s)", async (_label, extra) => {
      const calls: any[] = [];
      const error = await run({ ...SDK_FETCHED, ...extra }, calls, ["claim_expired"]);
      expect(calls).toHaveLength(1);
      expect(fetches).toBe(0);
      expect(error).toBeInstanceOf(LaunchTicketRejectedError);
    });
  });

  describe.skipIf(process.platform === "win32")("serve()", () => {
    const engineScript = (counter: string, reason: string) =>
      `#!/bin/sh\n# ${MARKER.toString()}\necho run >> "${counter}"\nif [ "$(wc -l < "${counter}")" -ge 3 ]; then echo "third attempt" >&2; exit 1; fi\nfor a in "$@"; do case "$a" in --ant0-launch=*) echo "\${a#--ant0-launch=}" >> "${counter}.tickets";; esac; done\necho "ant0: launch ticket invalid (${reason})" >&2\nexit 90\n`;
    const serveWith = async (reason: string, extra: Record<string, unknown>) => {
      const counter = join(dir, "runs");
      const engine = join(dir, "fake-engine-real");
      writeFileSync(engine, engineScript(counter, reason));
      chmodSync(engine, 0o755);
      const error: any = await serve({ executablePath: engine, identity: { mode: "native" }, quiet: true, readyTimeoutMs: 5000, engineVersion: "149.0.7827.114-ant0.9", ...extra } as any).catch((e) => e);
      const runs = (() => { try { return readFileSync(counter, "utf8").trim().split("\n").length; } catch { return 0; } })();
      const tickets = (() => { try { return readFileSync(`${counter}.tickets`, "utf8").trim().split("\n"); } catch { return []; } })();
      return { error, runs, tickets };
    };
    it.each(["claim_expired", "claim_stale"])("retries exactly once on %s with a fresh ticket", async (reason) => {
      const { error, runs, tickets } = await serveWith(reason, {});
      expect(runs).toBe(2);
      expect(tickets).toHaveLength(2);
      expect(tickets[0]).not.toBe(tickets[1]);
      expect(error).toBeInstanceOf(LaunchTicketRejectedError);
      expect(error.reason).toBe(reason);
    });
    it("does not retry for another reason", async () => {
      const { error, runs } = await serveWith("bad_signature", {});
      expect(runs).toBe(1);
      expect(error).toBeInstanceOf(LaunchTicketRejectedError);
    });
    it.each([
      ["the launchTicket option", { launchTicket: TICKET }],
      ["an argv ticket", { launchTicket: false, args: [`--ant0-launch=${OTHER}`] }],
      ["an explicit env ticket", { launchTicket: false, env: { [LAUNCH_TICKET_ENV]: OTHER } }],
    ])("does not retry a ticket the caller provided (%s)", async (_label, extra) => {
      const { error, runs } = await serveWith("claim_expired", extra);
      expect(runs).toBe(1);
      expect(error).toBeInstanceOf(LaunchTicketRejectedError);
    });
  });
});
