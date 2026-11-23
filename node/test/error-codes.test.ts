import { describe, expect, it } from "vitest";
import {
  IdentityPersistenceError, PersonaMigrationError, PopulationModelError, ReleaseError, RuntimeError,
  SdkError, SignatureError, reportFields,
} from "../src/index.js";

const CLASSES = ["defect", "environment", "expected"];

describe("error codes", () => {
  it("keeps builtin types and carries a local cause", () => {
    const cause = new Error("/home/someone/secret");
    const error = new SdkError("sdk.engine_not_found", "x", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(cause);
    expect(reportFields(error)).toEqual({ code: "sdk.engine_not_found", class: "environment" });
  });
  it("gives existing classes a code and class", () => {
    for (const error of [new ReleaseError("x"), new SignatureError("x"), new PopulationModelError("x"),
      new PersonaMigrationError("x"), new IdentityPersistenceError("x")]) {
      expect(error.code).toMatch(/^sdk\./);
      expect(CLASSES).toContain(error.errorClass);
    }
    expect(new SignatureError("x")).toBeInstanceOf(ReleaseError);
  });
  it("classifies runtime failures", () => {
    expect(new RuntimeError("runtime.timeout").errorClass).toBe("environment");
    expect(new RuntimeError("licence.required").errorClass).toBe("expected");
    expect(new RuntimeError("runtime.invalid_request").errorClass).toBe("defect");
  });
});

describe("review fixes", () => {
  it("uses the same codes as the Python SDK for shared cases", async () => {
    const { resolveIdentity, loadTemplateDirectory } = await import("../src/index.js");
    expect(() => loadTemplateDirectory("/nonexistent-dir-for-test")).toThrowError(
      expect.objectContaining({ code: "sdk.identity_source_unreadable" }));
    expect(() => resolveIdentity(5 as never)).toThrowError(expect.objectContaining({ code: "sdk.identity_invalid" }));
  });
  it("keeps the message when the code changes", async () => {
    const { loadTemplateDirectory } = await import("../src/index.js");
    expect(() => loadTemplateDirectory("/nonexistent-dir-for-test")).toThrowError(
      /^cannot read template directory: .*nonexistent-dir-for-test/);
  });
  it("clamps a daemon code before reporting", async () => {
    const { LaunchTicketUnavailableError } = await import("../src/launch-ticket.js");
    expect(reportFields(new LaunchTicketUnavailableError("licence.required", "m")).code).toBe("licence.required");
    const bad = new LaunchTicketUnavailableError("user@example.com /home/x", "m");
    expect(reportFields(bad)).toEqual({ code: "sdk.launch_ticket_unavailable", class: "environment" });
    expect(bad.code).toBe("user@example.com /home/x");
  });
  it("does not carry a code through structuredClone (documented)", () => {
    const clone = structuredClone(new SdkError("sdk.engine_not_found", "x"));
    expect((clone as unknown as { code?: string }).code).toBeUndefined();
  });
});
