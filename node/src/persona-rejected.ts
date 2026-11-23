/**
 * The engine refuses a persona file it cannot use (fail-closed).
 *
 * When `--fingerprint-profile-file` names a file that is missing, unreadable or rejected, the browser
 * process exits with code 91 before any profile directory, window or network activity, after writing one
 * line to stderr:
 *
 *     fatal: --fingerprint-profile-file: <reason>
 *
 * The reason is printable ASCII, at most 200 characters, and never carries a path or profile data. The
 * SDK throws it as {@link PersonaFileRejectedError} (`code: "sdk.persona_file_rejected"`). Exit code 90 is
 * the launch ticket's (see `launch-ticket.ts`); Chromium's own codes stay below 43.
 */
import type { ErrorClass } from "./errors.js";

/** Exit code of an engine that refused its persona file. */
export const PERSONA_FILE_EXIT_CODE = 91;
/** Error code carried by {@link PersonaFileRejectedError}. */
export const PERSONA_FILE_REJECTED_CODE = "sdk.persona_file_rejected";
/** The longest reason the engine prints, and the longest the SDK keeps. */
export const REASON_MAX_LENGTH = 200;

// Raw stderr has the line at the start; Playwright quotes it in its message behind a "[pid=N][err] " prefix.
const FATAL_LINE = /^(?:\[pid=\d+\]\[err\] ?)?fatal: --fingerprint-profile-file: ([^\r\n]*)$/m;
const EXIT_CODE = /process did exit: exitCode=(\d+)/;

/** Printable ASCII only (anything else is dropped), trimmed, at most {@link REASON_MAX_LENGTH} characters. */
export function sanitizeReason(text: unknown): string {
  return String(text).replace(/[^\x20-\x7e]/g, "").trim().slice(0, REASON_MAX_LENGTH).trimEnd();
}

/** The engine exited with code 91: its persona file was missing, unreadable or rejected. */
export class PersonaFileRejectedError extends Error {
  readonly code = PERSONA_FILE_REJECTED_CODE;
  readonly errorClass: ErrorClass = "expected";
  /** The engine's reason, sanitised (printable ASCII, at most 200 characters). */
  readonly reason: string;
  constructor(reason: string) {
    const clean = sanitizeReason(reason) || "unspecified";
    super(`ant0-browser: the engine rejected the persona file (${clean}).`);
    this.name = "PersonaFileRejectedError";
    this.reason = clean;
  }
}

/** The exit code Playwright quotes in a launch failure (`process did exit: exitCode=N`), if any. */
export function playwrightExitCode(text: string | undefined | null): number | undefined {
  const m = EXIT_CODE.exec(text ?? "");
  return m ? Number(m[1]) : undefined;
}

/** The engine's (sanitised) reason if `text` carries the fatal line, `"unspecified"` if only exit code 91 is
 * known, else undefined. `exitCode` is the process exit code when the caller has it. */
export function personaFileRejection(text: string | undefined | null, exitCode?: number | null): string | undefined {
  const m = FATAL_LINE.exec(text ?? "");
  if (m) return sanitizeReason(m[1]) || "unspecified";
  return exitCode === PERSONA_FILE_EXIT_CODE ? "unspecified" : undefined;
}

// The engine keeps running with host values when an inline persona is invalid and writes one line:
//   Invalid persona-format-v4; profile remains inactive: <error>
//   Invalid --fingerprint-profile-file: <why>; profile remains inactive
//   Invalid persona handle; profile remains inactive
// Renderer-process LOG() lines start with "[pid:..." and never match.
const INACTIVE_LINE = /^(?:\[pid=\d+\]\[err\] ?)?(Invalid [^\r\n]*profile remains inactive[^\r\n]*)$/m;

/** The sanitised line (used as the reason) if `text` carries the "profile remains inactive" line, else undefined.
 * Only complete lines count: pass text up to the last newline when scanning a stream. */
export function personaInactiveReason(text: string | undefined | null): string | undefined {
  const m = INACTIVE_LINE.exec(text ?? "");
  return m ? sanitizeReason(m[1]) || "profile remains inactive" : undefined;
}

/** Incremental scanner for a child's stderr: feed chunks, read `reason` once a complete inactive line has been seen. */
export class InactiveProfileWatch {
  reason: string | undefined;
  private pending = "";
  push(chunk: string): void {
    if (this.reason !== undefined) return;
    const text = this.pending + chunk;
    const cut = text.lastIndexOf("\n");
    if (cut < 0) { this.pending = text.slice(-8192); return; }
    this.pending = text.slice(cut + 1).slice(-8192);
    this.reason = personaInactiveReason(text.slice(0, cut + 1));
  }
}
