// The engine's fail-closed persona file (exit code 91) surfaces as sdk.persona_file_rejected.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LaunchTicketRejectedError, rethrowIfTicketRejected } from "../src/launch-ticket.js";
import {
  InactiveProfileWatch, PERSONA_FILE_EXIT_CODE, PersonaFileRejectedError, personaFileRejection, personaInactiveReason, sanitizeReason,
} from "../src/persona-rejected.js";
import { serve } from "../src/index.js";

const MARKER = "ant0-browser-capabilities/persona-profile-v1";
const FATAL = "fatal: --fingerprint-profile-file: ";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const catching = (e: unknown): unknown => { try { rethrowIfTicketRejected(e); } catch (x) { return x; } return undefined; };

describe("persona file rejection (exit code 91)", () => {
  it("finds the fatal line at line start and behind Playwright's prefix, and nowhere else", () => {
    expect(personaFileRejection(`noise\n${FATAL}base64 decoding failed\nmore`)).toBe("base64 decoding failed");
    expect(personaFileRejection(`[pid=123][err] ${FATAL}the path must be absolute`)).toBe("the path must be absolute");
    expect(personaFileRejection(`x ${FATAL}not at the start of a line`)).toBeUndefined();
    expect(personaFileRejection("nothing")).toBeUndefined();
    expect(personaFileRejection(undefined)).toBeUndefined();
  });
  it("the exit code alone is enough, with an unspecified reason", () => {
    expect(personaFileRejection("", 91)).toBe("unspecified");
    expect(personaFileRejection("", 1)).toBeUndefined();
    expect(PERSONA_FILE_EXIT_CODE).toBe(91);
  });
  it("the reason is printable ASCII and at most 200 characters", () => {
    expect(sanitizeReason("café\u0000 \u001b[31mred\u007f\ttab")).toBe("caf [31mredtab");
    expect(sanitizeReason("a".repeat(500))).toHaveLength(200);
    expect(new PersonaFileRejectedError("b".repeat(500)).reason).toHaveLength(200);
    expect(new PersonaFileRejectedError("éè").reason).toBe("unspecified");
    expect(personaFileRejection(FATAL + "x".repeat(300))).toBe("x".repeat(200));
  });
  it("Playwright's failure is rethrown by exit code and line", () => {
    const e = catching(new Error(`Failed to launch\n<process did exit: exitCode=91, signal=null>\n[pid=7][err] ${FATAL}schema_version: unsupported`));
    expect(e).toBeInstanceOf(PersonaFileRejectedError);
    expect((e as PersonaFileRejectedError).reason).toBe("schema_version: unsupported");
    expect((e as PersonaFileRejectedError).code).toBe("sdk.persona_file_rejected");
    expect((e as PersonaFileRejectedError).errorClass).toBe("expected");
    expect((catching(new Error("Failed\n<process did exit: exitCode=91, signal=null>")) as PersonaFileRejectedError).reason).toBe("unspecified");
  });
  it("exit code 90 stays the launch ticket error", () => {
    const missing = catching(new Error("Failed\n<process did exit: exitCode=90, signal=null>")) as LaunchTicketRejectedError;
    expect(missing).toBeInstanceOf(LaunchTicketRejectedError);
    expect(missing.reason).toBe("missing");
    const named = catching(new Error("<process did exit: exitCode=90, signal=null>\nant0: launch ticket invalid (past_grace)")) as LaunchTicketRejectedError;
    expect(named.reason).toBe("past_grace");
    const other = new Error("unrelated <process did exit: exitCode=1, signal=null>");
    expect(catching(other)).toBe(other);
  });
  describe("profile remains inactive (engine keeps running on host values)", () => {
    const LINE = "Invalid persona-format-v4; profile remains inactive: requires.8: capability is not implemented";
    it("matches the engine's lines, not renderer log lines or other notices", () => {
      expect(personaInactiveReason(`noise\n${LINE}\n`)).toBe(LINE);
      expect(personaInactiveReason("Invalid persona handle; profile remains inactive\n")).toBe("Invalid persona handle; profile remains inactive");
      expect(personaInactiveReason("Invalid --fingerprint-profile-file: too large; profile remains inactive\n")).toContain("too large");
      expect(personaInactiveReason("[1:2:ERROR:persona.cc(1)] Invalid persona handle; profile remains inactive\n")).toBeUndefined();
      expect(personaInactiveReason("persona-format-v4: 2 optional surface(s) absent\n")).toBeUndefined();
    });
    it("the stream watch waits for the complete line and survives chunk splits", () => {
      const w = new InactiveProfileWatch();
      w.push("Invalid persona-format-v4; profile rem"); expect(w.reason).toBeUndefined();
      w.push("ains inactive: bad"); expect(w.reason).toBeUndefined(); // no newline yet: the reason may still grow
      w.push(" thing\n"); expect(w.reason).toBe("Invalid persona-format-v4; profile remains inactive: bad thing");
    });
  });
  describe("serve()", () => {
    const engine = (body: string): string => {
      const d = mkdtempSync(join(tmpdir(), "ant0-pr-")); dirs.push(d);
      const exe = join(d, "chrome");
      writeFileSync(exe, `#!/bin/sh\n# ${MARKER}\n${body}\n`);
      chmodSync(exe, 0o755);
      return exe;
    };
    const run = (exe: string) => serve({ executablePath: exe, identity: { mode: "native" }, quiet: true, launchTicket: false, readyTimeoutMs: 5000 }).catch((e) => e);
    it.skipIf(process.platform === "win32")("exit 91 with the line", async () => {
      const err = await run(engine(`echo '${FATAL}the file cannot be opened' >&2\nexit 91`));
      expect(err).toBeInstanceOf(PersonaFileRejectedError);
      expect(err.reason).toBe("the file cannot be opened");
    });
    it.skipIf(process.platform === "win32")("a running engine that prints profile remains inactive is stopped and rejected", async () => {
      const t0 = Date.now();
      const err = await run(engine(`echo 'Invalid persona-format-v4; profile remains inactive: bad field' >&2\nexec sleep 30`));
      expect(err).toBeInstanceOf(PersonaFileRejectedError);
      expect(err.reason).toBe("Invalid persona-format-v4; profile remains inactive: bad field");
      expect(Date.now() - t0).toBeLessThan(10000); // rejected at once, not after the readiness timeout
    });
    it.skipIf(process.platform === "win32")("an engine that never prints it is not rejected as a persona failure", async () => {
      const err = await run(engine(`echo 'some other notice' >&2\nexit 1`));
      expect(err).not.toBeInstanceOf(PersonaFileRejectedError);
      expect(err.code).toBe("sdk.engine_not_ready");
    });
    it.skipIf(process.platform === "win32")("exit 91 without the line", async () => {
      const err = await run(engine("exit 91"));
      expect(err).toBeInstanceOf(PersonaFileRejectedError);
      expect(err.reason).toBe("unspecified");
    });
    it.skipIf(process.platform === "win32")("exit 90 is still the ticket error", async () => {
      expect(await run(engine("echo 'ant0: launch ticket invalid (unknown_kid)' >&2\nexit 90"))).toBeInstanceOf(LaunchTicketRejectedError);
    });
  });
});
