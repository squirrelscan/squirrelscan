// #2333: in a probing run, a page whose stored perf/source-maps verdict came
// from a live answer runs again; every other page replays.

import { describe, expect, test } from "bun:test";

import type { PageRuleCacheEntry, StreamRuleCache } from "../src/rule-cache";

import {
  PROBING_PAGE_RULE_ID,
  withoutReplayingProbedVerdicts,
} from "../src/rule-cache";

type Checks = PageRuleCacheEntry["ruleResults"][number][1];

function entry(ruleId: string, checks: Checks): PageRuleCacheEntry {
  return {
    ruleResults: [[ruleId, checks]],
    features: {} as PageRuleCacheEntry["features"],
    signals: {},
  };
}

const ENTRIES: Record<string, PageRuleCacheEntry> = {
  noMap: entry(PROBING_PAGE_RULE_ID, [
    { name: "source-maps", status: "pass", message: "m" },
  ]),
  reported: entry(PROBING_PAGE_RULE_ID, [
    { name: "source-maps-exposed", status: "warn", message: "m" },
  ]),
  allUnreachable: entry(PROBING_PAGE_RULE_ID, [
    {
      name: "source-maps",
      status: "pass",
      message: "m",
      details: { unreachable: 1 },
    },
  ]),
  // Another rule's warning is not a live answer.
  otherRule: entry("core/meta-title", [
    { name: "meta-title", status: "warn", message: "m" },
  ]),
};

const inner: StreamRuleCache = {
  keyFor: async () => null,
  load: async (keys) =>
    new Map(keys.flatMap((k) => (ENTRIES[k] ? [[k, ENTRIES[k]]] : []))),
  putFresh() {},
  carryForward() {},
};

describe("withoutReplayingProbedVerdicts (#2333)", () => {
  test("drops only entries whose source-maps verdict depends on a probe", async () => {
    const loaded = await withoutReplayingProbedVerdicts(inner).load(
      Object.keys(ENTRIES)
    );
    expect([...loaded.keys()].sort()).toEqual(["noMap", "otherRule"]);
  });
});
