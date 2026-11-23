// Playwright's launch failure quotes the whole command line. The SDK's own errors must not carry the
// launch ticket or the persona-file path anywhere: message, stack, cause chain or own properties.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type LaunchSecrets, LaunchTicketRejectedError, launchSecretValues, redactError, redactLaunchSecrets, rethrowIfTicketRejected } from "../src/launch-ticket.js";
import { PersonaFileRejectedError } from "../src/persona-rejected.js";
import { launch, launchPersistentContext, serve } from "../src/index.js";
import { spawnSync } from "node:child_process";

const MARKER = "ant0-browser-capabilities/persona-profile-v1";
const TICKET = "SECRETlic.SECRETclaim.SECRETsig.SECRETeng.SECRETcs";
const PERSONA_PATH = "/tmp/ant0 persona SECRET/fingerprint-profile.json";
const dirs: string[] = [];
// Real LaunchSecrets only come from launchSecretValues: a profile directory (boundary) or a persona path (exact).
const boundary = (...v: string[]): LaunchSecrets => launchSecretValues([], v);
const exact = (...v: string[]): LaunchSecrets => launchSecretValues(v.map((x) => `--fingerprint-profile-file=${x}`));
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function playwrightFailure(extra: string): Error {
  return new Error(
    "browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n" +
    `<launching> /x/chrome --headless --ant0-launch=${TICKET} --fingerprint-profile-file=${PERSONA_PATH} --no-first-run\n${extra}`);
}

/** Message, stack, own enumerable properties and the whole cause chain, as one string. */
function everything(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let e: unknown = error; e !== undefined && e !== null && !seen.has(e); ) {
    seen.add(e);
    if (e instanceof Error) {
      parts.push(e.message, e.stack ?? "", JSON.stringify(e, Object.getOwnPropertyNames(e)));
      e = (e as { cause?: unknown }).cause;
    } else { parts.push(String(e)); break; }
  }
  return parts.join("\n");
}
const thrown = (e: unknown): unknown => { try { rethrowIfTicketRejected(e); } catch (x) { return x; } return undefined; };

describe("launch ticket and persona path never leak through the SDK's errors", () => {
  it.each([
    ["exit 90 with the stderr line", "<process did exit: exitCode=90, signal=null>\nant0: launch ticket invalid (past_grace)\n", LaunchTicketRejectedError],
    ["exit 90 alone", "<process did exit: exitCode=90, signal=null>\n", LaunchTicketRejectedError],
    ["exit 91", "<process did exit: exitCode=91, signal=null>\n[pid=1][err] fatal: --fingerprint-profile-file: bad file\n", PersonaFileRejectedError],
  ])("%s", (_name, extra, cls) => {
    const error = thrown(playwrightFailure(extra));
    expect(error).toBeInstanceOf(cls);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    const text = everything(error);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(TICKET);
    expect(text).not.toContain(PERSONA_PATH);
  });

  it("redacts a path with spaces and keeps the switches after it", () => {
    const out = redactLaunchSecrets(`x --ant0-launch=${TICKET} --fingerprint-profile-file=${PERSONA_PATH} --keep=1`);
    expect(out).not.toContain("SECRET");
    expect(out.endsWith("--keep=1")).toBe(true);
  });

  it("a detail passed to the error is redacted too", () => {
    expect(everything(new LaunchTicketRejectedError("missing", `Playwright: --ant0-launch=${TICKET}`))).not.toContain("SECRET");
  });

  it.skipIf(process.platform === "win32")("serve(): an engine that echoes its command line on exit 90 does not leak it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ant0-leak-"));
    dirs.push(dir);
    const exe = join(dir, "chrome");
    writeFileSync(exe, `#!/bin/sh\n# ${MARKER}\necho "launching $@" >&2\nexit 90\n`);
    chmodSync(exe, 0o755);
    const error = await serve({ executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: TICKET, readyTimeoutMs: 5000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LaunchTicketRejectedError);
    const text = everything(error);
    expect(text).toContain("<redacted>");
    expect(text).not.toContain("SECRET");
  });

  describe("a launch failure that is neither the ticket nor the persona case", () => {
    const generic = () => {
      const e = new Error("browserType.launch: Browser closed\n<launching> /x/chrome " +
        `--ant0-launch=${TICKET} --fingerprint-profile-file=${PERSONA_PATH} --no-first-run\n<process did exit: exitCode=1, signal=null>\n`);
      e.name = "TimeoutError";
      (e as unknown as { code: string }).code = "E_PW";
      e.stack = `TimeoutError: ${e.message}\n    at launch (file.js:1:1)`;
      (e as { cause?: unknown }).cause = new Error(`inner --ant0-launch=${TICKET}`);
      return e;
    };
    it("rethrowIfTicketRejected rethrows a redacted copy: message, stack, cause chain; name and code kept", () => {
      const original = generic();
      const error = thrown(original) as Error & { code?: string };
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("TimeoutError");
      expect(error.code).toBe("E_PW");
      expect(error.message).toContain("exitCode=1");
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      const text = everything(error);
      expect(text).not.toContain("SECRET");
      expect(original.message).toContain(TICKET); // the shared object was not modified
    });
    it("a spawn error does not carry spawnargs", () => {
      const r = spawnSync("/nonexistent/engine-binary", [`--ant0-launch=${TICKET}`]);
      const error = redactError(r.error);
      expect(error).toBeInstanceOf(Error);
      expect(everything(error)).not.toContain("SECRET");
      expect("spawnargs" in (error as object)).toBe(false);
    });
    it.skipIf(process.platform === "win32")("launch(): a fake engine that echoes its command line and exits 1 leaks nothing", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ant0-leak-"));
      dirs.push(dir);
      const exe = join(dir, "chrome");
      writeFileSync(exe, `#!/bin/sh\n# ${MARKER}\necho "engine argv: $@" >&2\nexit 1\n`);
      chmodSync(exe, 0o755);
      const error = await launch({ executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: TICKET, headless: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(LaunchTicketRejectedError);
      const text = everything(error);
      expect(text).toContain("<redacted>");
      expect(text).not.toContain("SECRET");
    }, 30_000);
    it.skipIf(process.platform === "win32")("serve(): exit 1 with the command line on stderr leaks nothing, also when the tail was cut inside the switch", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ant0-leak-"));
      dirs.push(dir);
      const exe = join(dir, "chrome");
      // 9000 filler bytes first so the 8 KB tail starts inside the echoed line
      writeFileSync(exe, `#!/bin/sh\n# ${MARKER}\nprintf '%09000d' 0 >&2\necho "argv: $@ --fingerprint-profile-file=${PERSONA_PATH}" >&2\nexit 1\n`);
      chmodSync(exe, 0o755);
      const error = await serve({ executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: TICKET, readyTimeoutMs: 5000 }).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("sdk.engine_not_ready");
      expect(everything(error)).not.toContain("SECRET");
    });
  });
});

describe("exact-value redaction of the argv the SDK passed", () => {
  const UDD = "/tmp/ant0 udd --xSECRETtail/profile dir";
  const WIN_UDD = "C:\\Users\\a b\\SECRETwin\\profile";
  const args = [`--user-data-dir=${UDD}`, `--fingerprint-profile-file=${PERSONA_PATH}`, `--ant0-launch=${TICKET}`, "--keep=1"];

  it("launchSecretValues takes the ticket and both paths, as --name=value and as --name value", () => {
    expect(launchSecretValues(args)).toEqual({ exact: [PERSONA_PATH, TICKET], boundary: [UDD] });
    expect(launchSecretValues(["--user-data-dir", "/p/q q"], ["/extra/dir"])).toEqual({ exact: [], boundary: ["/p/q q", "/extra/dir"] });
  });

  it("a profile path containing ' --x' is removed whole, not only up to the ' --'", () => {
    const out = redactLaunchSecrets(`<launching> /x/chrome ${args.join(" ")}`, launchSecretValues(args));
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("tail/profile");
    expect(out.endsWith("--keep=1")).toBe(true);
  });

  it("a persona path containing ' --x' is removed whole", () => {
    const path = "/tmp/p SECRETa --xSECRETb/f.json";
    const a = [`--fingerprint-profile-file=${path}`, "--keep=1"];
    const out = redactLaunchSecrets(`chrome ${a.join(" ")}`, launchSecretValues(a));
    expect(out).toBe("chrome --fingerprint-profile-file=<redacted> --keep=1");
  });

  it("without the exact values the switch pattern alone still runs as the second layer", () => {
    const out = redactLaunchSecrets(`chrome --ant0-launch=${TICKET} --keep=1`);
    expect(out).toBe("chrome --ant0-launch=<redacted> --keep=1");
  });

  it("a quoted secret keeps both quotes: raw, JSON-escaped, single-quoted, whole-switch-quoted, bare", () => {
    const secrets = boundary(WIN_UDD);
    const escaped = WIN_UDD.replace(/\\/g, "\\\\");
    expect(redactLaunchSecrets(`chrome --user-data-dir="${WIN_UDD}" --keep=1`, secrets)).toBe('chrome --user-data-dir="<redacted>" --keep=1');
    expect(redactLaunchSecrets(`chrome --user-data-dir="${escaped}" --keep=1`, secrets)).toBe('chrome --user-data-dir="<redacted>" --keep=1');
    expect(redactLaunchSecrets(`chrome --user-data-dir='${WIN_UDD}' --keep=1`, secrets)).toBe("chrome --user-data-dir='<redacted>' --keep=1");
    expect(redactLaunchSecrets(`chrome "--user-data-dir=${WIN_UDD}" --keep=1`, secrets)).toBe('chrome "--user-data-dir=<redacted>" --keep=1');
    expect(redactLaunchSecrets(`chrome "${WIN_UDD}" --keep=1`, secrets)).toBe('chrome "<redacted>" --keep=1');
    expect(redactLaunchSecrets(`{"args":["--user-data-dir=${escaped}","--keep=1"]}`, secrets)).toBe('{"args":["--user-data-dir=<redacted>","--keep=1"]}');
  });

  it("the switch pattern does not eat the closing quote of a value the exact step already replaced", () => {
    const persona = "C:\\a b\\SECRETp --x\\f.json";
    expect(redactLaunchSecrets(`chrome --fingerprint-profile-file="${persona}" --keep=1`, exact(persona)))
      .toBe('chrome --fingerprint-profile-file="<redacted>" --keep=1');
    expect(redactLaunchSecrets(`chrome --fingerprint-profile-file '${persona}' --keep=1`, exact(persona)))
      .toBe("chrome --fingerprint-profile-file '<redacted>' --keep=1");
    // without the exact values the pattern layer still redacts (it has no quote to keep)
    expect(redactLaunchSecrets(`chrome --ant0-launch="${TICKET}" --keep=1`)).not.toContain("SECRET");
  });

  it("the longest value goes first when one secret contains another", () => {
    const out = redactLaunchSecrets("a /tmp/SECRETdir/persona.json b", boundary("/tmp/SECRETdir", "/tmp/SECRETdir/persona.json"));
    expect(out).toBe("a <redacted> b");
  });

  it("rethrowIfTicketRejected removes a path with ' --x' from a generic failure, message and stack", () => {
    const e = new Error(`launch failed\n<launching> /x/chrome ${args.join(" ")}\n`);
    const error = (() => { try { rethrowIfTicketRejected(e, launchSecretValues(args)); } catch (x) { return x; } return undefined; })();
    expect(everything(error)).not.toContain("SECRET");
    expect(everything(error)).not.toContain("tail/profile");
  });

  describe("secrets are a LaunchSecrets, never an array", () => {
    it("is frozen, with frozen lists", () => {
      const v = launchSecretValues(args, ["/x/udd"]);
      expect(Object.isFrozen(v) && Object.isFrozen(v.exact) && Object.isFrozen(v.boundary)).toBe(true);
    });
    it("a plain array is a type error and a TypeError at runtime (redactLaunchSecrets, redactError, rethrowIfTicketRejected)", () => {
      // @ts-expect-error a plain array is not LaunchSecrets
      expect(() => redactLaunchSecrets("x", [TICKET])).toThrow(TypeError);
      // @ts-expect-error a plain array is not LaunchSecrets
      expect(() => redactError(new Error("x"), [TICKET])).toThrow(TypeError);
      // @ts-expect-error a plain array is not LaunchSecrets
      expect(() => rethrowIfTicketRejected(new Error("x"), [TICKET])).toThrow(TypeError);
      // @ts-expect-error neither is a bare string, null, or an object without both lists
      expect(() => redactLaunchSecrets("x", TICKET)).toThrow(TypeError);
      // @ts-expect-error null is not LaunchSecrets
      expect(() => redactLaunchSecrets("x", null)).toThrow(TypeError);
      // @ts-expect-error the lists must be arrays (a string would spread into characters)
      expect(() => redactLaunchSecrets("x", { exact: [TICKET], boundary: "/some/dir" })).toThrow(TypeError);
      // @ts-expect-error both lists are required
      expect(() => redactLaunchSecrets("x", { exact: [TICKET] })).toThrow(TypeError);
    });
    it("nothing means the regex layer only", () => {
      expect(redactLaunchSecrets(`chrome --ant0-launch=${TICKET} --keep=1`, undefined)).toBe("chrome --ant0-launch=<redacted> --keep=1");
    });
    it("a hand-built lookalike, a spread copy or a JSON round trip is rejected: only launchSecretValues() output counts", () => {
      const real = launchSecretValues(args);
      const lookalikes = [{ exact: [TICKET], boundary: [] }, { ...real }, JSON.parse(JSON.stringify(real)), Object.freeze({ exact: Object.freeze([TICKET]), boundary: Object.freeze([]) })];
      for (const fake of lookalikes) {
        expect(() => redactLaunchSecrets("x", fake as LaunchSecrets)).toThrow(TypeError);
        expect(() => redactError(new Error("x"), fake as LaunchSecrets)).toThrow(TypeError);
        expect(() => rethrowIfTicketRejected(new Error("x"), fake as LaunchSecrets)).toThrow(TypeError);
      }
      expect(redactLaunchSecrets(`ticket=${TICKET}&x`, real)).toBe("ticket=<redacted>&x");
    });
    it("a short --ant0-launch value is boundary-only: it does not mangle text, a long ticket is removed anywhere", () => {
      for (const short of ["abc", "true", "1234567890abcde"]) {
        const v = launchSecretValues([`--ant0-launch=${short}`]);
        expect(v.exact).toEqual([]);
        expect(v.boundary).toEqual([short]);
        const text = `${short}ing is true, abcdef trueish ${short}x --ant0-launch=${short} --keep=1`;
        expect(redactLaunchSecrets(text, v)).toBe(`${short}ing is true, abcdef trueish ${short}x --ant0-launch=<redacted> --keep=1`);
      }
      const long = launchSecretValues(["--ant0-launch=0123456789abcdef"]);
      expect(long.exact).toEqual(["0123456789abcdef"]);
      expect(redactLaunchSecrets("a&0123456789abcdef|b", long)).toBe("a&<redacted>|b");
    });
  });

  describe("a ticket or persona path standing alone is removed whatever surrounds it", () => {
    const LT = "AAAAtkLIC0123456789.BBBBtkCLAIM0123456789.CCCCtkSIG0123.DDDDtkENG.EEEEtkCS";
    const LP = "/home/u/My Prof --x/ant0-persona.profile";
    const lvals = launchSecretValues([`--fingerprint-profile-file=${LP}`, `--ant0-launch=${LT}`]);
    const AFTER = [": denied","'",")",">","|",";x","#","\t","\r\n","&","!","?","*","+","/","~","@","-","_x","%","`","$","^"];
    const BEFORE = ["<","file://",":","/","\\","`","|","@","*","-","x","\\\\?\\"];
    const gone = (out: string) => !/tk(lic|claim|sig|eng|cs)|ant0-persona|my prof/i.test(out);
    it.each(AFTER)("ticket and path followed by %j", (c) => {
      expect(gone(redactLaunchSecrets(`ticket=${LT}${c} end open [${LP}${c} end`, lvals))).toBe(true);
    });
    it.each(BEFORE)("ticket and path preceded by %j", (c) => {
      expect(gone(redactLaunchSecrets(`t ${c}${LT} end open ${c}${LP} end`, lvals))).toBe(true);
    });
    it("a quoted ticket keeps both quotes", () => {
      expect(redactLaunchSecrets(`x "${LT}" y '${LP}' z`, lvals)).toBe(`x "<redacted>" y '<redacted>' z`);
    });
    it("matching is anywhere in the JSON-escaped form and ignoring case when asked", () => {
      const w = "C:\\Users\\A B\\ant0-persona.profile";
      const wv = launchSecretValues([`--fingerprint-profile-file=${w}`]);
      expect(redactLaunchSecrets(JSON.stringify({ p: w }), wv)).toBe('{"p":"<redacted>"}');
      expect(redactLaunchSecrets(`cannot open>${w.toLowerCase()}|`, wv, { caseInsensitive: true })).toBe("cannot open><redacted>|");
    });
    it('a quoted short profile directory after the switch is redacted: --user-data-dir="data"', () => {
      expect(redactLaunchSecrets('chrome --user-data-dir="data" --x exitCode=7', launchSecretValues(["--user-data-dir=data"])))
        .toBe('chrome --user-data-dir="<redacted>" --x exitCode=7');
      expect(redactLaunchSecrets("chrome --user-data-dir 'data' --x", boundary("data"))).toBe("chrome --user-data-dir '<redacted>' --x");
    });
  });

  describe("only the secret is redacted, never the text around it", () => {
    // Playwright's launch failure: the command line on one `<launching>` line, then the process's stderr and exit.
    const failure = (argvUdd: string) =>
      "browserType.launchPersistentContext: Target page, context or browser has been closed\nBrowser logs:\n\n" +
      `<launching> /tmp/eng/chrome --headless --user-data-dir=${argvUdd} --metadata-x --no-first-run\n` +
      "[pid=1][err] chrome: exit 7 data\n<process did exit: exitCode=7, signal=null>";
    it.each(["data", "exit", "/tmp", "chrome", "./data", "sub/exit"])("a profile directory %j", (udd) => {
      const abs = resolve(udd);
      const out = redactLaunchSecrets(failure(abs), launchSecretValues([], [udd]));
      expect(out).toContain("--user-data-dir=<redacted> --metadata-x");
      expect(out).toContain("<launching> /tmp/eng/chrome --headless");
      expect(out).toContain("[pid=1][err] chrome: exit 7 data");
      expect(out).toContain("<process did exit: exitCode=7, signal=null>");
      expect(out).toContain("Target page, context or browser has been closed");
      expect(out).not.toContain(`=${abs}`);
    });
    it.each(["data", "exit", "/tmp", "chrome"])("%j as passed in argv (serve) goes only where it is the switch value", (udd) => {
      const argv = [`--user-data-dir=${udd}`, "--keep=1"];
      const out = redactLaunchSecrets(`argv: ${argv.join(" ")} exitCode=7 chrome exit /tmp/eng/chrome data`, launchSecretValues(argv));
      expect(out).toBe("argv: --user-data-dir=<redacted> --keep=1 exitCode=7 chrome exit /tmp/eng/chrome data");
    });
    it("a relative profile directory is redacted in the absolute form Playwright logs, parents included", () => {
      const abs = resolve("rel-profile");
      expect(launchSecretValues([], ["rel-profile"])).toEqual({ exact: [], boundary: ["rel-profile", abs] });
      expect(launchSecretValues(["--user-data-dir", "rel-profile"])).toEqual({ exact: [], boundary: ["rel-profile", abs] });
      const out = redactLaunchSecrets(`--user-data-dir=${abs} x`, launchSecretValues([], ["rel-profile"]));
      expect(out).toBe("--user-data-dir=<redacted> x");
    });
    it("the longest value wins when one secret is a prefix of another with a space", () => {
      expect(redactLaunchSecrets("x /tmp/SECRETdir sub y", boundary("/tmp/SECRETdir", "/tmp/SECRETdir sub"))).toBe("x <redacted> y");
    });
    it("a secret inside a longer token is kept", () => {
      expect(redactLaunchSecrets("a /opt/x/tmp b xABCDEFGHIJKLMNOP c", boundary("/tmp", "ABCDEFGHIJKLMNOP"))).toBe("a /opt/x/tmp b xABCDEFGHIJKLMNOP c");
    });
    it("a path that merely starts with the secret is kept", () => {
      expect(redactLaunchSecrets("a /home/u/profile-2/x b /home/u/profile. c", boundary("/home/u/profile"))).toBe("a /home/u/profile-2/x b <redacted>. c");
    });
    it("a short bare word is redacted after a secret switch only (the standalone minimum)", () => {
      expect(redactLaunchSecrets("chrome exited --user-data-dir chrome --x", boundary("chrome"))).toBe("chrome exited --user-data-dir <redacted> --x");
      expect(redactLaunchSecrets("tok ABCDEFGHIJKLMNOP end", boundary("ABCDEFGHIJKLMNOP"))).toBe("tok <redacted> end");
    });
    it("matching ignores case on Windows only (injectable)", () => {
      const secret = "C:\\Users\\A B\\ant0-persona.profile";
      const text = "[err] cannot open c:\\users\\a b\\ant0-persona.profile";
      expect(redactLaunchSecrets(text, exact(secret), { caseInsensitive: true })).toBe("[err] cannot open <redacted>");
      expect(redactLaunchSecrets(text, exact(secret), { caseInsensitive: false })).toBe(text);
    });
  });

  const fakeEngine = (dir: string, body: string, mode = 0o755) => {
    const exe = join(dir, "chrome");
    writeFileSync(exe, `#!/bin/sh\n# ${MARKER}\n${body}`);
    chmodSync(exe, mode);
    return exe;
  };
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ant0-leak-")); dirs.push(d); return d; };
  const serveOpts = (exe: string, extra: Record<string, unknown> = {}) =>
    ({ executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: TICKET, readyTimeoutMs: 5000, ...extra }) as Parameters<typeof serve>[0];

  it.skipIf(process.platform === "win32")("serve(): a profile directory with ' --x' that the engine echoes is fully redacted", async () => {
    const dir = tmp();
    const udd = join(dir, "udd --xSECRETtail");
    const exe = fakeEngine(dir, 'echo "argv: $@" >&2\nexit 1\n');
    const error = await serve(serveOpts(exe, { userDataDir: udd })).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("sdk.engine_not_ready");
    const text = everything(error);
    expect(text).toContain("<redacted>");
    expect(text).not.toContain("SECRET");
  });

  // The call sites hand the secrets over: launch() has the ticket, launchPersistentContext() also the profile
  // directory (Playwright adds `--user-data-dir=<abs>` itself, so only the call site knows it). A ticket and a
  // directory holding ' --x' are not caught by the switch pattern: only the exact values remove them whole.
  const SPACEY_TICKET = "SECRETlic.SECRETclaim --xSECRETsig.SECRETeng.SECRETcs.SECRETlast";
  it.skipIf(process.platform === "win32")("launch() with ephemeralProfile:false (the incognito path) passes the ticket to the redaction", async () => {
    const dir = tmp();
    const exe = fakeEngine(dir, 'echo "argv: $@" >&2\nexit 1\n');
    const error = await launch({ executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: SPACEY_TICKET, headless: true, ephemeralProfile: false } as Parameters<typeof launch>[0]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = everything(error);
    expect(text).toContain("--ant0-launch=<redacted>");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("--xSECRET");
    expect(text).toContain("exitCode=1");
  }, 30_000);

  it.skipIf(process.platform === "win32")("launchPersistentContext() passes the profile directory to the redaction", async () => {
    const dir = tmp();
    const udd = join(dir, "udd --xSECRETtail");
    const exe = fakeEngine(dir, 'echo "argv: $@" >&2\nexit 1\n');
    const error = await launchPersistentContext(udd, { executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: SPACEY_TICKET, headless: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = everything(error);
    expect(text).toContain("--user-data-dir=<redacted>");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("--xSECRET");
    expect(text).toContain("exitCode=1");
  }, 30_000);

  // A spawn error (here EACCES: the file is not executable) carries `spawnargs`, the whole command line.
  it.skipIf(process.platform === "win32")("serve(): a spawn error does not carry the command line", async () => {
    const dir = tmp();
    const exe = fakeEngine(dir, "exit 0\n", 0o644);
    const error = await serve(serveOpts(exe)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("EACCES");
    expect(everything(error)).not.toContain("SECRET");
    expect("spawnargs" in (error as object)).toBe(false);
  });

  // Stderr shorter than the 8 KiB window is not truncated: nothing is dropped, the secret is still redacted.
  it.skipIf(process.platform === "win32")("serve(): a short stderr keeps its first line and redacts the ticket in it", async () => {
    const dir = tmp();
    const exe = fakeEngine(dir, 'echo "FIRSTLINE argv: $@" >&2\necho "SECONDLINE" >&2\nexit 1\n');
    const error = await serve(serveOpts(exe)).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("sdk.engine_not_ready");
    const text = everything(error);
    expect(text).toContain("FIRSTLINE argv:");
    expect(text).toContain("SECONDLINE");
    expect(text).toContain("<redacted>");
    expect(text).not.toContain("SECRET");
  });

  // The 8 KiB window starts inside the ticket's value; the partial first line must go, or its tail leaks.
  it.skipIf(process.platform === "win32")("serve(): a tail cut inside a switch value leaves no fragment of the secret", async () => {
    const dir = tmp();
    const head = "x".repeat(300) + ` --ant0-launch=${TICKET}`;
    const insideTicket = 12; // the window starts 12 characters into the ticket
    const rest = "TAILMARK" + "z".repeat(8192 + insideTicket - TICKET.length - 1 - "TAILMARK".length);
    const dump = join(dir, "stderr.txt");
    writeFileSync(dump, `${head}\n${rest}`);
    const exe = fakeEngine(dir, `cat '${dump}' >&2\nexit 1\n`);
    const error = await serve(serveOpts(exe)).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("sdk.engine_not_ready");
    const text = everything(error);
    expect(text).toContain("TAILMARK");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(TICKET.slice(insideTicket));
  });
});
