// A rule that THROWS is not a clean rule either (pub#999, same class as #968).
//
// A rule that throws is recorded as a failed `<rule>-error` check. It names none
// of the rule's real checks, so a rule that threw on every page left no key for
// them in the resolution signal, and an absent key resolves a prior finding on a
// crawled page although the rule never finished. The `<rule>|*` rule-wide key of
// #968 now covers a thrown error too, and the merge carries on it.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  ResolutionSignal,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { resolutionRuleKey } from "@squirrelscan/core-contracts/resolution";
import { RESOLUTION_SIGNAL_LIMITS } from "@squirrelscan/core-contracts/limits";
import { buildPublishResolution, buildResolutionSignal } from "@squirrelscan/rules/resolution";
import { decodeResolutionSignal } from "@squirrelscan/rules/resolution-decode";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { aggregateUntouchedCarried } from "../src/complete-store-fold";
import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

const SITE = "web_999";
const RULE = "security/leaked-secrets";
const CHECK = "leaked-secrets";
const A = "https://www.acme-shop.com/a";
const B = "https://www.acme-shop.com/b";
const C = "https://www.acme-shop.com/c";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();
  async getFindings(_siteKey: string, states?: FindingState[]): Promise<PageFindingRecord[]> {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    for (const f of findings) {
      this.findings.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), { ...f });
    }
  }
  async upsertSitePages(pages: SitePageRecord[]): Promise<void> {
    for (const p of pages) this.pages.set(p.normalizedUrl, { ...p });
  }
  async markPageRemoved(): Promise<void> {}
  async markPagesRemoved(): Promise<void> {}
  async compactFindings(): Promise<number> {
    return 0;
  }
}

const fail = (url: string): CheckResult => ({
  name: CHECK,
  status: "fail",
  message: "secret in page",
  pageUrl: url,
  items: [{ id: "key", label: "key" }],
});
const pass = (url: string): CheckResult => ({
  name: CHECK,
  status: "pass",
  message: "ok",
  pageUrl: url,
});

/** What the runner leaves for a page the rule threw on (the page is stamped by the engine). */
const threw = (url?: string): CheckResult => ({
  name: `${RULE}-error`,
  status: "fail",
  message: "Rule error: boom",
  ...(url ? { pageUrl: url } : {}),
});

const meta = { id: RULE, name: "Leaked secrets", category: "security", scope: "page" as const };

const legacyTimeout = (url: string, budgetMs = 1000): CheckResult => ({
  name: `${RULE}-error`,
  status: "fail",
  message: `Rule not evaluated: exceeded its ${budgetMs} ms time budget`,
  pageUrl: url,
  details: { timedOut: true, ruleId: RULE, budgetMs },
});

type Mode = "sampled" | "compact";

/** Run 1 finds a secret on A; run 2 is `byPage`. Returns A's row. */
async function priorAfterRerun(byPage: Record<string, CheckResult[]>, mode: Mode) {
  const store = new MemStore();
  const publish = async (crawlId: string, pages: Record<string, CheckResult[]>) => {
    const ruleResults = { [RULE]: { meta, checks: Object.values(pages).flat() } };
    const crawled = Object.keys(pages);
    const resolutionSignal =
      mode === "compact"
        ? await decodeResolutionSignal(
            buildPublishResolution(
              ruleResults as never,
              crawled.map((url) => ({ url, statusCode: 200 })),
            ).resolutionSignalCompact!,
          )
        : buildResolutionSignal(ruleResults as never, crawled);
    await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId,
      ruleResults: ruleResults as never,
      pageStatuses: crawled.map((url) => ({ url, status: 200 })),
      resolutionSignal,
    });
  };
  await publish("audit_1", { [A]: [fail(A)], [B]: [pass(B)] });
  await publish("audit_2", byPage);
  return [...store.findings.values()].find(
    (f) => f.normalizedUrl === normalizePageUrl(A) && f.ruleId === RULE,
  )!;
}

describe("the signal names a rule that threw (pub#999)", () => {
  test("every page threw: a rule-wide not-evaluated key, no failing rule-wide key", () => {
    const signal = buildResolutionSignal({ [RULE]: { checks: [threw(A), threw(B)] } }, [A, B])!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(2);
    expect(signal.failing[resolutionRuleKey(RULE)]).toBeUndefined();
  });

  test("some pages threw: only those are listed under the rule-wide key", () => {
    const signal = buildResolutionSignal({ [RULE]: { checks: [threw(A), pass(B)] } }, [A, B])!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(1);
  });

  test("an error row that names no page marks every crawled page", () => {
    const signal = buildResolutionSignal({ [RULE]: { checks: [threw(), pass(B)] } }, [A, B])!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(2);
  });

  test("a folded error row lists its pages; a clipped one marks every page", () => {
    const folded: CheckResult = {
      name: `${RULE}-error`,
      status: "fail",
      message: "Rule error: boom (+1 more pages)",
      pages: [A, B],
      details: { aggregated: true, occurrences: 2 },
    };
    const listed = buildResolutionSignal({ [RULE]: { checks: [folded, pass(C)] } }, [A, B, C])!;
    expect(listed.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(2);
    const clipped = buildResolutionSignal(
      {
        [RULE]: {
          checks: [
            { ...folded, details: { aggregated: true, occurrences: 5, pagesTruncated: 5 } },
            pass(C),
          ],
        },
      },
      [A, B, C],
    )!;
    expect(clipped.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(3);
  });

  test("a replayed error row is an earlier run's, not a thrown rule", () => {
    for (const provenance of ["carried", "unrendered"] as const) {
      const replay: CheckResult = { ...threw(A), provenance };
      const signal = buildResolutionSignal({ [RULE]: { checks: [replay, pass(B)] } }, [A, B])!;
      expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toBeUndefined();
    }
  });

  test("a rule that never threw gets no rule-wide key", () => {
    const signal = buildResolutionSignal({ [RULE]: { checks: [pass(A), pass(B)] } }, [A, B])!;
    expect(signal.notEvaluated).toBeUndefined();
  });

  test("a check that merely fails is not a thrown rule", () => {
    const signal = buildResolutionSignal({ [RULE]: { checks: [fail(A), pass(B)] } }, [A, B])!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toBeUndefined();
  });
});

for (const mode of ["sampled", "compact"] as const) {
  describe(`a prior finding when the rule throws (${mode} signal, pub#999)`, () => {
    test("every page threw: it carries, not resolves", async () => {
      const row = await priorAfterRerun({ [A]: [threw(A)], [B]: [threw(B)] }, mode);
      expect(row.state).toBe("open");
      expect(row.provenance).toBe("carried");
    });

    test("only some pages threw: its page carries", async () => {
      const row = await priorAfterRerun({ [A]: [threw(A)], [B]: [pass(B)] }, mode);
      expect(row.state).toBe("open");
      expect(row.provenance).toBe("carried");
    });

    test("it threw elsewhere only: the page the rule cleared resolves", async () => {
      const row = await priorAfterRerun({ [A]: [pass(A)], [B]: [threw(B)], [C]: [threw(C)] }, mode);
      expect(row.state).toBe("resolved");
    });

    test("no error: a clean page still resolves", async () => {
      const row = await priorAfterRerun({ [A]: [pass(A)], [B]: [pass(B)] }, mode);
      expect(row.state).toBe("resolved");
    });
  });
}

describe("prior rule errors are run-local (repo#1075)", () => {
  async function publish(
    store: MemStore,
    crawlId: string,
    checks: CheckResult[],
    pageStatuses: Array<{ url: string; status: number }>,
  ) {
    return runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId,
      ruleResults: { [RULE]: { meta, checks } } as never,
      pageStatuses,
    });
  }

  test("an untouched page does not carry an older timeout row", async () => {
    const store = new MemStore();
    await publish(store, "audit_1", [legacyTimeout(A)], [{ url: A, status: 200 }]);

    const current = await publish(store, "audit_2", [pass(B)], [{ url: B, status: 200 }]);
    expect(current.unionRuleResults.get(RULE)?.checks.some((c) => c.name === `${RULE}-error`)).toBe(
      false,
    );

    const row = [...store.findings.values()].find(
      (finding) =>
        finding.normalizedUrl === normalizePageUrl(A) && finding.checkName === `${RULE}-error`,
    );
    expect(row?.state).toBe("resolved");
    expect(row?.lastSeenCrawlId).toBe("audit_2");
  });

  test("a fresh error in the current run still reports normally", async () => {
    const store = new MemStore();
    await publish(store, "audit_1", [legacyTimeout(A)], [{ url: A, status: 200 }]);

    const current = await publish(store, "audit_2", [legacyTimeout(A, 2000)], [
      { url: A, status: 200 },
    ]);
    const row = current.unionRuleResults
      .get(RULE)
      ?.checks.find((check) => check.name === `${RULE}-error`);
    expect(row?.message).toContain("2000 ms time budget");

    const persisted = [...store.findings.values()].find(
      (finding) =>
        finding.normalizedUrl === normalizePageUrl(A) && finding.checkName === `${RULE}-error`,
    );
    expect(persisted).toMatchObject({ state: "open", lastSeenCrawlId: "audit_2" });
  });

  test("the complete-store materialized path retires the same prior row", async () => {
    const store = new MemStore();
    await publish(store, "audit_1", [legacyTimeout(A)], [{ url: A, status: 200 }]);
    const priorOpenFindings = await store.getFindings(SITE, ["open"]);
    async function* noFindingPages(): AsyncGenerator<readonly PageFindingRecord[]> {}

    const current = await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: "audit_2",
      ruleResults: { [RULE]: { meta, checks: [pass(B)] } } as never,
      pageStatuses: [{ url: B, status: 200 }],
      completeStore: {
        priorOpenFindings,
        findingPages: noFindingPages(),
        crawledUrls: [B],
      },
    });

    expect(current.unionRuleResults.get(RULE)?.checks.some((c) => c.name === `${RULE}-error`)).toBe(
      false,
    );
    expect(priorOpenFindings[0]).toMatchObject({ checkName: `${RULE}-error`, state: "open" });
    expect([...store.findings.values()].find((finding) => finding.checkName === `${RULE}-error`))
      .toMatchObject({ state: "resolved", lastSeenCrawlId: "audit_2" });
  });

  test("the untouched aggregate excludes rule-error rows from counts and samples", async () => {
    const store = new MemStore();
    await publish(store, "audit_1", [legacyTimeout(A), fail(A)], [{ url: A, status: 200 }]);
    const rows = await store.getFindings(SITE, ["open"]);

    const { aggregate, sample } = aggregateUntouchedCarried([
      { normalizedUrl: normalizePageUrl(A), rows, rendered: true, active: true },
    ]);

    expect(rows.some((row) => row.checkName === `${RULE}-error`)).toBe(true);
    expect(aggregate.findings).toBe(1);
    expect(aggregate.classes.map((entry) => entry.checkName)).toEqual([CHECK]);
    expect(sample.flatMap((page) => page.sample).map((row) => row.checkName)).toEqual([CHECK]);
  });

  test("an oversized untouched sample cannot replay an excluded rule-error row", async () => {
    const store = new MemStore();
    await publish(store, "audit_1", [legacyTimeout(A), fail(A)], [{ url: A, status: 200 }]);
    const rows = await store.getFindings(SITE, ["open"]);
    const { aggregate } = aggregateUntouchedCarried([
      { normalizedUrl: normalizePageUrl(A), rows, rendered: true, active: true },
    ]);

    const current = await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: "audit_2",
      ruleResults: { [RULE]: { meta, checks: [pass(B)] } } as never,
      pageStatuses: [{ url: B, status: 200 }],
      completeStore: {
        crawledUrls: [B],
        untouchedCarried: async () => {
          async function* pages() {
            yield {
              normalizedUrl: normalizePageUrl(A),
              untouched: true as const,
              sample: rows,
            };
          }
          return { pages: pages(), aggregate };
        },
      },
    });

    const checks = current.unionRuleResults.get(RULE)?.checks ?? [];
    expect(checks.some((check) => check.name === `${RULE}-error`)).toBe(false);
    expect(checks.some((check) => check.name === CHECK)).toBe(true);
    expect(current.coverage.carriedFindings).toBe(1);
  });
});

describeSitePagesContract("rule-error-no-resolve-999.test.ts MemStore", () => new MemStore());
