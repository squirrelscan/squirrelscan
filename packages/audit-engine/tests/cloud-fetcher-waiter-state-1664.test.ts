// #1664: a cloud-fetcher waiter's life is one `WaiterState` union, not three booleans whose legal
// combinations lived in comments. The behaviour is covered by cloud-fetcher.test.ts and
// cloud-fetch-headroom.test.ts (racing, claim, abort); this pins the shape so the booleans cannot
// come back next to the union.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "../src/cloud-fetcher.ts"), "utf8");

describe("cloud-fetcher waiter state (#1664)", () => {
  test("the union names the four legal states", () => {
    expect(SOURCE).toContain(
      'export type WaiterState = "queued" | "dispatched" | "racing" | "settled";',
    );
  });

  test("a waiter carries `state`, and no `settled`, `dispatched` or `racing` field", () => {
    const iface = SOURCE.slice(SOURCE.indexOf("interface Waiter {"));
    const body = iface.slice(0, iface.indexOf("\n}\n"));
    expect(body).toContain("state: WaiterState;");
    expect(body).not.toMatch(/\n\s+settled: boolean;/);
    expect(body).not.toMatch(/\n\s+dispatched: boolean;/);
    expect(body).not.toMatch(/\n\s+racing: boolean;/);
  });

  test("nothing reads or writes the old fields", () => {
    expect(SOURCE).not.toMatch(/\bw\.(settled|dispatched|racing)\b/);
  });
});
