// A check that does not apply to a page resolves that page's prior finding (pub#1011).
//
// A page-scope rule that skips because the page has nothing for the check to look
// at (no images, no form fields, no `Link` header, a page below the minimum size)
// is not "the check did not run": it used to carry the prior forever (#508), on
// local audits and in the cloud. It now skips with `not-applicable`, which the
// resolution signal and the merge read as evaluated and clean, while a gap
// (`no_data`, `scan-truncated`) still carries.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  ResolutionSignal,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { CHECK_NOT_APPLICABLE_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import {
  computeMerge,
  createNotEvaluatedCollector,
  findingKey,
  type FlatFinding,
} from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

const SITE = "web_1011";
const RULE = "perf/ttfb";
const CHECK = "ttfb";
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
  message: "slow",
  pageUrl: url,
});
const pass = (url: string): CheckResult => ({
  name: CHECK,
  status: "pass",
  message: "ok",
  pageUrl: url,
});
const skip = (url: string, skipReason = "no_data"): CheckResult => ({
  name: CHECK,
  status: "skipped",
  message: "no timing data",
  skipReason,
  pageUrl: url,
});

const meta = { id: RULE, name: "TTFB", category: "performance", severity: "warning" };

type SignalOf = (crawled: string[], ruleResults: never) => ResolutionSignal | undefined;

const healthy: SignalOf = (crawled, ruleResults) => buildResolutionSignal(ruleResults, crawled);
/** The check's key dropped past the key cap: the signal never heard of it. */
const keyDropped: SignalOf = (crawled) => ({ crawledUrls: crawled, failing: {} });
/** The key's not-evaluated complement was over budget: listed truncated, no page set. */
const keyTruncated: SignalOf = (crawled) => ({
  crawledUrls: crawled,
  failing: {},
  truncated: [`${RULE}|${CHECK}`],
});

/** Run 1 fails TTFB on A; run 2 is `checks`. Returns A's row. */
async function priorAfterRerun(checks: CheckResult[], signal: SignalOf) {
  const store = new MemStore();
  const publish = async (crawlId: string, list: CheckResult[], sig: SignalOf) => {
    const ruleResults = { [RULE]: { meta, checks: list } } as never;
    const crawled = [...new Set(list.map((c) => c.pageUrl!))];
    await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId,
      ruleResults,
      pageStatuses: crawled.map((url) => ({ url, status: 200 })),
      resolutionSignal: sig(crawled, ruleResults),
    });
  };
  await publish("audit_1", [fail(A), pass(B)], healthy);
  await publish("audit_2", checks, signal);
  return [...store.findings.values()].find(
    (f) => f.normalizedUrl === normalizePageUrl(A) && f.ruleId === RULE,
  )!;
}

const na = (url: string): CheckResult => ({
  name: CHECK,
  status: "skipped",
  message: "Nothing here for the check to look at",
  skipReason: CHECK_NOT_APPLICABLE_SKIP_REASON,
  details: { foldKey: CHECK_NOT_APPLICABLE_SKIP_REASON },
  pageUrl: url,
});

const SIGNALS = { healthy, "key dropped": keyDropped };

for (const [label, signal] of Object.entries(SIGNALS)) {
  describe(`sampled publish merge, signal: ${label} (#1011)`, () => {
    test("the repro: A fails, then A is not applicable and B passes: A's prior resolves", async () => {
      const row = await priorAfterRerun([na(A), pass(B)], signal);
      expect(row.state).toBe("resolved");
    });

    test("a page whose check did not run (a gap) still carries", async () => {
      const row = await priorAfterRerun([skip(A), pass(B)], signal);
      expect(row.state).toBe("open");
    });

    test("not applicable on every page resolves too", async () => {
      const row = await priorAfterRerun([na(A), na(B)], signal);
      expect(row.state).toBe("resolved");
    });
  });
}

describe("sampled publish merge, folded rows (#1011)", () => {
  const folded = (details: Record<string, unknown>): CheckResult => ({
    name: CHECK,
    status: "skipped",
    message: "Nothing here for the check to look at (+1 more pages)",
    skipReason: CHECK_NOT_APPLICABLE_SKIP_REASON,
    pages: [A, B],
    details: { aggregated: true, occurrences: 2, ...details },
  });
  const other = (url: string): CheckResult => ({
    name: "other",
    status: "pass",
    message: "ok",
    pageUrl: url,
  });

  test("an aggregate that carries the fold key resolves the pages it lists", async () => {
    const row = await priorAfterRerun(
      [other(A), folded({ foldKey: CHECK_NOT_APPLICABLE_SKIP_REASON }), pass(C)],
      healthy,
    );
    expect(row.state).toBe("resolved");
  });

  test("an aggregate without the fold key is not trusted: it carries", async () => {
    const row = await priorAfterRerun([other(A), folded({}), pass(C)], healthy);
    expect(row.state).toBe("open");
  });
});

describe("local merge, no signal (#1011)", () => {
  const priorFinding = (url: string): PageFindingRecord => ({
    siteKey: SITE,
    normalizedUrl: normalizePageUrl(url),
    ruleId: RULE,
    checkName: CHECK,
    locator: "",
    status: "fail",
    severity: "warning",
    message: "slow",
    value: null,
    expected: null,
    payload: null,
    fingerprint: "f",
    firstSeenAt: 1,
    lastSeenCrawlId: "audit_1",
    lastSeenAt: 1,
    provenance: "fresh",
    state: "open",
  });

  const merge = (checks: CheckResult[]) => {
    const collector = createNotEvaluatedCollector(normalizePageUrl);
    for (const c of checks) collector.add(RULE, c);
    const fresh: FlatFinding[] = [];
    const out = computeMerge({
      siteKey: SITE,
      crawlId: "audit_2",
      crawledUrls: new Set([A, B].map(normalizePageUrl)),
      freshFindings: fresh,
      removedUrls: new Set(),
      severityByRule: new Map([[RULE, "warning"]]),
      statusByUrl: new Map(),
      priorFindings: [priorFinding(A)],
      priorPages: [],
      now: 2,
      notEvaluated: collector.result(),
    });
    return out.persisted.find((f) => f.normalizedUrl === normalizePageUrl(A))!;
  };

  test("a page the check does not apply to resolves its prior", () => {
    expect(merge([na(A), pass(B)]).state).toBe("resolved");
  });

  test("a page whose check did not run still carries its prior", () => {
    expect(merge([skip(A), pass(B)]).state).toBe("open");
  });
});

describe("the signal reads a not-applicable page as evaluated and clean (#1011)", () => {
  test("it is evaluated, not failing, and not listed as not evaluated", () => {
    const signal = buildResolutionSignal({ [RULE]: { checks: [na(A), pass(B)] } }, [A, B])!;
    expect(signal.failing[`${RULE}|${CHECK}`]).toEqual([]);
    expect(signal.notEvaluated).toBeUndefined();
  });

  test("a gap is still listed as not evaluated", () => {
    const signal = buildResolutionSignal({ [RULE]: { checks: [skip(A), pass(B)] } }, [A, B])!;
    expect(signal.notEvaluated?.[`${RULE}|${CHECK}`]).toHaveLength(1);
  });
});

describeSitePagesContract("not-applicable-resolves-1011.test.ts MemStore", () => new MemStore());
