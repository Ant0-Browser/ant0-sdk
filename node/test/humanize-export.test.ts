import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import { installHumanizeOnContext } from "../src/humanize.js";

describe("public humanize export", () => {
  it("exposes installHumanizeOnContext for browsers attached over CDP", () => {
    expect(sdk.installHumanizeOnContext).toBe(installHumanizeOnContext);
  });

  it("does nothing when neither humanize nor showCursor is asked for", () => {
    const context = {
      on: () => {
        throw new Error("must not subscribe");
      },
      pages: () => {
        throw new Error("must not read pages");
      },
      addInitScript: () => {
        throw new Error("must not inject");
      },
    };
    expect(() => sdk.installHumanizeOnContext(context as never, {})).not.toThrow();
  });
});
