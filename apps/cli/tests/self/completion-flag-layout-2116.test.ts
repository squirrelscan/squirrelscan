import { describe, expect, test } from "bun:test";
// #2116: flag lists stay one per line so PRs adding flags do not conflict.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "../../src/self/completion.ts"),
  "utf8"
);

describe("completion.ts flag list layout (#2116)", () => {
  test("no source line packs several long flags together", () => {
    const packed = source
      .split("\n")
      .filter((line) => (line.match(/ --[a-z]/g) ?? []).length > 12);
    expect(packed).toEqual([]);
  });
});
