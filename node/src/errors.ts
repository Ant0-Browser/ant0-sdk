/**
 * Stable error identity for SDK failures.
 *
 * Every SDK error carries a `code` (a fixed dotted word), an `errorClass` (`defect`,
 * `environment` or `expected`) and an optional local `cause`. Nothing here reports, logs or
 * sends anything: the SDK stays offline. {@link reportFields} returns the only two values that
 * are safe to forward to a reporter; messages and causes may hold paths or values.
 *
 * The subclasses extend the builtin types the SDK threw before, so `instanceof Error`,
 * `TypeError` and `RangeError` checks keep working.
 */

export type ErrorClass = "defect" | "environment" | "expected";

export interface SdkErrorOptions {
  cause?: unknown;
  errorClass?: ErrorClass;
}

export interface CodedError extends Error {
  readonly code: string;
  readonly errorClass: ErrorClass;
  /** A code already clamped to a known shape, for errors whose `code` comes from outside. */
  readonly reportCode?: string;
}

/** The fixed fields that are safe to report. Never the message or cause. */
export function reportFields(error: CodedError): { code: string; class: ErrorClass } {
  return { code: String(error.reportCode ?? error.code), class: error.errorClass };
}

export class SdkError extends Error implements CodedError {
  readonly errorClass: ErrorClass;
  constructor(readonly code: string, message: string, options: SdkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.errorClass = options.errorClass ?? "environment";
  }
}

export class SdkTypeError extends TypeError implements CodedError {
  readonly errorClass: ErrorClass;
  constructor(readonly code: string, message: string, options: SdkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.errorClass = options.errorClass ?? "expected";
  }
}

export class SdkRangeError extends RangeError implements CodedError {
  readonly errorClass: ErrorClass;
  constructor(readonly code: string, message: string, options: SdkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.errorClass = options.errorClass ?? "expected";
  }
}

/** Invalid input from the caller (a bad option or file). */
export class SdkInputError extends Error implements CodedError {
  readonly errorClass: ErrorClass;
  constructor(readonly code: string, message: string, options: SdkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.errorClass = options.errorClass ?? "expected";
  }
}
