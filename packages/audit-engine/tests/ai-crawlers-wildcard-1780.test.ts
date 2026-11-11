// #1780: eleven per-crawler warning rows became one wildcard row. The findings stored for the old rows must continue
// in the new one, not resolve: a finding that resolves sends a "fixed" notification, and nothing was fixed.

import { describe, expect, test } from "bun:test";

import type { PageFindingRecord } from "@squirrelscan/core-contracts";
import { buildSupersededIndex } from "@squirrelscan/core-contracts/resolution";
import { loadAllRules } from "@squirrelscan/rules";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { computeMerge, type FlatFinding } from "../src/merge-core";

const SITE = "web_1780";
const RULE = "ax/ai-crawlers";
const PAGE = normalizePageUrl("https://example.com/");
const superseded = buildSupersededIndex([...loadAllRules().values()].map((r) => r.meta));

const prior = (checkName: string, locator: string, firstSeenAt: number): PageFindingRecord => ({
  siteKey: SITE,
  normalizedUrl: PAGE,
  ruleId: RULE,
  checkName,
  locator,
  status: "warn",
  severity: "warning",
  message: "blocked",
  value: null,
  expected: null,
  payload: null,
  fingerprint: "f",
  firstSeenAt,
  lastSeenCrawlId: "audit_1",
  lastSeenAt: firstSeenAt,
  provenance: "fresh",
  state: "open",
});

const fresh = (checkName: string, locator: string): FlatFinding => ({
  normalizedUrl: PAGE,
  ruleId: RULE,
  checkName,
  locator,
  status: "warn",
  message: "blocked",
  value: null,
  expected: null,
  payload: null,
});

// Before: the old shape, one warning row per crawler (answer engines and archives).
const OLD = [
  prior("ai-answer-access", "OAI-SearchBot", 300),
  prior("ai-answer-access", "ChatGPT-User", 200),
  prior("ai-answer-access", "PerplexityBot", 400),
  prior("archive-crawler-access", "CCBot", 250),
];

function merge(now: FlatFinding[], priors: PageFindingRecord[] = OLD) {
  return computeMerge({
    siteKey: SITE,
    crawlId: "audit_2",
    crawledUrls: new Set([PAGE]),
    freshFindings: now,
    removedUrls: new Set(),
    severityByRule: new Map([[RULE, "warning"]]),
    statusByUrl: new Map(),
    priorFindings: priors,
    priorPages: [],
    now: 1000,
    supersededChecks: superseded,
  });
}

describe("eleven crawler rows become one wildcard row (#1780)", () => {
  test("the old rows retire as stale, none resolves, and the one new row is open", () => {
    const m = merge([fresh("ai-crawlers-wildcard-blocked", "User-agent: *")]);
    expect(m.persisted.filter((f) => f.state === "resolved")).toEqual([]);
    expect(m.persisted.filter((f) => f.state === "stale")).toHaveLength(OLD.length);
    const open = m.persisted.filter((f) => f.state === "open");
    expect(open.map((f) => [f.checkName, f.locator])).toEqual([["ai-crawlers-wildcard-blocked", "User-agent: *"]]);
    // It has been blocked since the earliest of the rows it replaces.
    expect(open[0]!.firstSeenAt).toBe(200);
    expect(m.findings.map((f) => f.checkName)).toEqual(["ai-crawlers-wildcard-blocked"]);
  });

  test("control: the wildcard line is removed, so every row resolves", () => {
    const m = merge([]);
    expect(m.persisted.filter((f) => f.state === "resolved")).toHaveLength(OLD.length);
    expect(m.findings).toEqual([]);
  });

  test("a crawler blocked by its own group stays its own open row beside the wildcard row", () => {
    const m = merge([
      fresh("ai-answer-access", "OAI-SearchBot"),
      fresh("ai-crawlers-wildcard-blocked", "User-agent: *"),
    ]);
    expect(m.persisted.filter((f) => f.state === "resolved")).toEqual([]);
    const open = m.persisted.filter((f) => f.state === "open").map((f) => `${f.checkName}/${f.locator}`).sort();
    expect(open).toEqual(["ai-answer-access/OAI-SearchBot", "ai-crawlers-wildcard-blocked/User-agent: *"]);
  });
});

describe("only a crawler the wildcard row lists continues in it (#1780 review)", () => {
  const withList = (crawlers: string[]): FlatFinding => ({
    ...fresh("ai-crawlers-wildcard-blocked", "User-agent: *"),
    payload: JSON.stringify({ items: [{ id: "User-agent: *", meta: { crawlers } }], i: 0 }),
  });

  test("a crawler allowed by name while the wildcard still blocks the others is reported fixed", () => {
    // ChatGPT-User is no longer in the wildcard row's list: its own Allow group freed it.
    const m = merge([withList(["OAI-SearchBot", "PerplexityBot", "CCBot"])]);
    const by = (locator: string) => m.persisted.find((f) => f.locator === locator && f.checkName !== "ai-crawlers-wildcard-blocked");
    expect(by("ChatGPT-User")?.state).toBe("resolved");
    // the ones it still lists continue, never resolved
    for (const still of ["OAI-SearchBot", "PerplexityBot", "CCBot"]) expect(by(still)?.state, still).toBe("stale");
    expect(m.persisted.find((f) => f.checkName === "ai-crawlers-wildcard-blocked")?.state).toBe("open");
  });

  test("when the list names all of them, none is fixed", () => {
    const m = merge([withList(["OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "CCBot"])]);
    expect(m.persisted.filter((f) => f.state === "resolved")).toEqual([]);
  });
});
