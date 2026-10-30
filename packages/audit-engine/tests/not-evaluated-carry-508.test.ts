// A check the run did not evaluate on a page never resolves that page's prior
// finding (#508).
//
// A page check that was skipped this run (`perf/ttfb` with no timing data,
// `scan-truncated`) is protected from a wrong resolve by the publish resolution
// signal's `notEvaluated` list. Three paths lost that protection: a signal whose
// key was dropped past the key cap, the complete-store finalize, and the CLI's
// local merge (no signal at all). The skipped checks themselves are now read into
// `notEvaluated` evidence, so a prior on such a page carries in the sampled and the
// local merge whatever the signal says. The complete-store finalize holds findings,
// not checks, so it has no skip evidence; docs/guides/smart-audits says so.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  ResolutionSignal,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { NOT_APPLICABLE_SKIP_REASON, PAGE_TYPE_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
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

const SITE = "web_508";
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

const SIGNALS = { healthy, "key dropped": keyDropped, "key truncated": keyTruncated };

for (const [label, signal] of Object.entries(SIGNALS)) {
  describe(`sampled publish merge, signal: ${label} (#508)`, () => {
    test("a page that skipped the check carries its prior", async () => {
      const row = await priorAfterRerun([skip(A), pass(B)], signal);
      expect(row.state).toBe("open");
      expect(row.provenance).toBe("carried");
    });

    test("a scan-truncated skip carries even when no page evaluated the check", async () => {
      const row = await priorAfterRerun(
        [skip(A, "scan-truncated"), skip(B, "scan-truncated")],
        signal,
      );
      expect(row.state).toBe("open");
    });
  });
}

describe("sampled publish merge, signal: key dropped (#508)", () => {
  test("a page whose check passed still resolves", async () => {
    const row = await priorAfterRerun([pass(A), skip(B)], keyDropped);
    expect(row.state).toBe("resolved");
  });

  test("a check skipped on every page gives no evidence about any one (as in the signal)", async () => {
    const row = await priorAfterRerun([skip(A), skip(B)], keyDropped);
    expect(row.state).toBe("resolved");
  });

  test("the noindex verdict still reads as clean", async () => {
    const row = await priorAfterRerun([skip(A, NOT_APPLICABLE_SKIP_REASON), pass(B)], keyDropped);
    expect(row.state).toBe("resolved");
  });

  test("the page-type verdict (pub#841) reads as clean in the local merge too", async () => {
    const row = await priorAfterRerun([skip(A, PAGE_TYPE_SKIP_REASON), pass(B)], keyDropped);
    expect(row.state).toBe("resolved");
  });

  test("a folded skip row clipped past its cap marks every page of the check", async () => {
    const folded: CheckResult = {
      name: CHECK,
      status: "skipped",
      message: "no timing data (+3 more pages)",
      skipReason: "no_data",
      pages: [B, C],
      details: { aggregated: true, occurrences: 5, pagesTruncated: 5 },
    };
    // A is crawled (another check ran there) but the clip left it off the list.
    const other: CheckResult = { name: "other", status: "pass", message: "ok", pageUrl: A };
    const row = await priorAfterRerun([other, folded, pass(B)], keyDropped);
    expect(row.state).toBe("open");
  });
});

describe("local merge, no signal (#508)", () => {
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

  const merge = (checks: CheckResult[], withEvidence: boolean) => {
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
      ...(withEvidence ? { notEvaluated: collector.result() } : {}),
    });
    return out.persisted.find((f) => f.normalizedUrl === normalizePageUrl(A))!;
  };

  test("a page that skipped the check carries its prior", () => {
    expect(merge([skip(A), pass(B)], true).state).toBe("open");
  });

  test("a page whose check passed resolves its prior", () => {
    expect(merge([pass(A), skip(B)], true).state).toBe("resolved");
  });

  const timedOutRow = (url?: string): CheckResult => ({
    name: `${RULE}-error`,
    status: "skipped",
    message: "Rule not evaluated: exceeded its time budget",
    skipReason: "rule-timed-out",
    ...(url ? { pageUrl: url } : {}),
  });
  const thrownRow = (url?: string): CheckResult => ({
    name: `${RULE}-error`,
    status: "fail",
    message: "Rule error: boom",
    ...(url ? { pageUrl: url } : {}),
  });

  test("a rule that timed out on the page keeps its prior; one that later passes clears it", () => {
    expect(merge([timedOutRow(A), pass(B)], true).state).toBe("open");
    expect(merge([pass(A), pass(B)], true).state).toBe("resolved");
  });

  test("a rule that threw on the page keeps its prior", () => {
    expect(merge([thrownRow(A), pass(B)], true).state).toBe("open");
  });

  test("a timeout or error that names no page carries every page of the rule", () => {
    expect(merge([timedOutRow(), pass(B)], true).state).toBe("open");
    expect(merge([thrownRow(), pass(B)], true).state).toBe("open");
  });

  test("a rule that timed out on another page only does not hold this page's prior", () => {
    expect(merge([pass(A), timedOutRow(B)], true).state).toBe("resolved");
  });

  test("a replayed error row is an earlier run's, not a thrown rule", () => {
    const replay = { ...thrownRow(A), provenance: "carried" } as CheckResult;
    expect(merge([replay, pass(B)], true).state).toBe("resolved");
  });

  test("without the evidence the skipped page resolved (the old behaviour)", () => {
    expect(merge([skip(A), pass(B)], false).state).toBe("resolved");
  });
});

describeSitePagesContract("not-evaluated-carry-508.test.ts MemStore", () => new MemStore());
