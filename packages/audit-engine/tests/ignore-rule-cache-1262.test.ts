// `[[ignore]]` waivers and the per-page rule-result cache (#1262): a waiver changes
// a rule's verdict, so editing one must miss the cache, for the rules it names only.

import { describe, expect, test } from "bun:test";

import { RuleRunner, type IgnoreEntry, type RulesConfig } from "@squirrelscan/rules";

import { computeRunContextHash, withoutStoringAfterIgnoreTimeout } from "../src/rule-cache";

const COOKIE = "security/cookie-flags";
const TITLE = "core/meta-title";

function signature(ignore: IgnoreEntry[] | undefined) {
  const config: RulesConfig = { rule_options: {}, rules: { enable: [COOKIE, TITLE] }, ...(ignore ? { ignore } : {}) };
  return new RuleRunner({ config }).pageRuleSignature();
}

async function hashOf(ignore: IgnoreEntry[] | undefined, only?: string): Promise<string> {
  const pageRules = signature(ignore).filter((r) => only === undefined || r.id === only);
  const out = await computeRunContextHash({
    engineVersion: "test",
    rulesVersion: "test",
    pageRules,
    siteData: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null },
    siteMetadata: undefined,
    cloudResults: undefined,
    ignoreApplicability: false,
    utcYear: 2026,
    timeZone: "UTC",
  });
  if (!("hash" in out)) throw new Error(`disabled: ${out.disabled}`);
  return out.hash;
}

describe("the run context hash", () => {
  const a: IgnoreEntry[] = [{ rule: COOKIE, items: ["localization"] }];
  const b: IgnoreEntry[] = [{ rule: COOKIE, items: ["localization", "cart_currency"] }];

  test("is unchanged when there is no ignore list (existing caches stay valid)", async () => {
    expect(await hashOf(undefined)).toBe(await hashOf([]));
  });

  test("moves when an entry is added or edited", async () => {
    const none = await hashOf(undefined);
    const first = await hashOf(a);
    const edited = await hashOf(b);
    expect(first).not.toBe(none);
    expect(edited).not.toBe(first);
  });

  test("an entry for one rule does not move another rule's key", async () => {
    // The key of the rule an entry does NOT name is identical with and without it.
    expect(await hashOf(a, TITLE)).toBe(await hashOf(undefined, TITLE));
    expect(await hashOf(a, COOKIE)).not.toBe(await hashOf(undefined, COOKIE));
  });

  test("moves when the order of entries changes (indexes appear in reports)", async () => {
    const two: IgnoreEntry[] = [
      { rule: COOKIE, items: ["x"] },
      { rule: COOKIE, items: ["y"] },
    ];
    expect(await hashOf(two)).not.toBe(await hashOf([...two].reverse()));
  });
});

describe("the rule cache after an ignore entry timed out (review of #1333)", () => {
  test("verdicts are not stored once an entry ran over its budget, loading and carrying are unchanged", () => {
    const stored: string[] = [];
    let timedOut = 0;
    const inner = {
      keyFor: async () => "k",
      load: async () => new Map(),
      putFresh: (key: string) => void stored.push(key),
      carryForward: () => {},
    } as unknown as Parameters<typeof withoutStoringAfterIgnoreTimeout>[0];
    const cache = withoutStoringAfterIgnoreTimeout(inner, () => timedOut);
    const page = { normalizedUrl: "https://e.com/" } as never;
    cache.putFresh("before", page, {} as never);
    timedOut = 1;
    cache.putFresh("after", page, {} as never);
    expect(stored).toEqual(["before"]);
    expect(cache.keyFor).toBe(inner.keyFor);
  });
});
