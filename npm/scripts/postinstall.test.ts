import { describe, expect, test } from "bun:test";

const { resolveVersion } = require("./postinstall.js") as {
  resolveVersion: (
    env?: Record<string, string>,
    latest?: (channel: string) => Promise<string>,
  ) => Promise<{ version: string; message: string }>;
};
const packageVersion = require("../package.json").version as string;

describe("npm postinstall version resolution", () => {
  test("defaults to the version selected through npm", async () => {
    let contactedLatest = false;
    const result = await resolveVersion({}, async () => {
      contactedLatest = true;
      return "v9.9.9";
    });

    expect(result.version).toBe(`v${packageVersion}`);
    expect(contactedLatest).toBe(false);
  });

  test("normalizes an explicit pinned version", async () => {
    const result = await resolveVersion({ SQUIRREL_VERSION: "1.2.3" });
    expect(result.version).toBe("v1.2.3");
  });

  test("only follows latest when a channel is explicitly requested", async () => {
    const result = await resolveVersion(
      { SQUIRREL_CHANNEL: "beta" },
      async (channel) => (channel === "beta" ? "v2.0.0-beta.1" : "v1.0.0"),
    );
    expect(result.version).toBe("v2.0.0-beta.1");
  });
});
