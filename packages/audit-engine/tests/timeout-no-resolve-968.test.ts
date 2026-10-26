// A rule that timed out is not a clean rule (pub#968).
//
// A rule abandoned for its time budget leaves a skipped `<rule>-error` check
// (`rule-timed-out`, pub#960), which names none of the rule's real checks. When it
// timed out on EVERY page, the resolution signal had no key for the rule at all,
// and an absent key resolves a prior finding on a crawled page. The signal now
// carries a rule-wide `<rule>|*` key in `notEvaluated`, and the merge carries on it.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  ResolutionSignal,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import {
  RULE_TIMED_OUT_SKIP_REASON,
  resolutionRuleKey,
} from "@squirrelscan/core-contracts/resolution";
import { RESOLUTION_SIGNAL_LIMITS } from "@squirrelscan/core-contracts/limits";
import {
  buildPublishResolution,
  buildResolutionSignal,
} from "@squirrelscan/rules/resolution";
import { decodeResolutionSignal } from "@squirrelscan/rules/resolution-decode";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

const SITE = "web_968";
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
/** What the runner leaves for a page the rule timed out on. */
const timedOut = (url: string): CheckResult => ({
  name: `${RULE}-error`,
  status: "skipped",
  message: "Rule not evaluated: exceeded its time budget",
  skipReason: RULE_TIMED_OUT_SKIP_REASON,
  pageUrl: url,
  details: { timedOut: true, ruleId: RULE, budgetMs: 50 },
});

const meta = { id: RULE, name: "Leaked secrets", category: "security" };

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

describe("the signal names a rule that timed out (pub#968)", () => {
  test("every page timed out: a rule-wide not-evaluated key, no failing key", () => {
    const checks = [timedOut(A), timedOut(B)];
    const signal = buildResolutionSignal({ [RULE]: { checks } }, [A, B])!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(2);
    expect(signal.failing[resolutionRuleKey(RULE)]).toBeUndefined();
  });

  test("some pages timed out: only those are listed under the rule-wide key", () => {
    const checks = [timedOut(A), pass(B)];
    const signal = buildResolutionSignal({ [RULE]: { checks } }, [A, B])!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(1);
    // The per-check key still lists A as not evaluated, as before.
    expect(signal.notEvaluated?.[`${RULE}|${CHECK}`]).toHaveLength(1);
  });

  test("a rule that never timed out gets no rule-wide key", () => {
    const signal = buildResolutionSignal({ [RULE]: { checks: [pass(A), pass(B)] } }, [A, B])!;
    expect(signal.notEvaluated).toBeUndefined();
  });

  test("a timed-out skip that names no page marks every crawled page", () => {
    const { pageUrl: _drop, ...bare } = timedOut(A);
    const signal = buildResolutionSignal({ [RULE]: { checks: [bare, pass(B)] } }, [A, B])!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(2);
  });
});

for (const mode of ["sampled", "compact"] as const) {
  describe(`a prior finding when the rule times out (${mode} signal, pub#968)`, () => {
    test("every page timed out: it carries, not resolves", async () => {
      const row = await priorAfterRerun({ [A]: [timedOut(A)], [B]: [timedOut(B)] }, mode);
      expect(row.state).toBe("open");
      expect(row.provenance).toBe("carried");
    });

    test("only some pages timed out: its page carries", async () => {
      const row = await priorAfterRerun({ [A]: [timedOut(A)], [B]: [pass(B)] }, mode);
      expect(row.state).toBe("open");
      expect(row.provenance).toBe("carried");
    });

    test("it timed out elsewhere only: the page the rule cleared resolves", async () => {
      const row = await priorAfterRerun(
        { [A]: [pass(A)], [B]: [timedOut(B)], [C]: [timedOut(C)] },
        mode,
      );
      expect(row.state).toBe("resolved");
    });

    test("no timeout: a clean page still resolves", async () => {
      const row = await priorAfterRerun({ [A]: [pass(A)], [B]: [pass(B)] }, mode);
      expect(row.state).toBe("resolved");
    });
  });
}

/** Publish `runs` in order to one store, run 1 finding a secret on A; A's row after the last. */
async function rowAfterRuns(
  runs: Array<{
    pages: Record<string, CheckResult[]>;
    signal?: (crawled: string[], ruleResults: never) => ResolutionSignal | undefined;
  }>,
) {
  const store = new MemStore();
  let n = 0;
  for (const run of runs) {
    const ruleResults = { [RULE]: { meta, checks: Object.values(run.pages).flat() } } as never;
    const crawled = Object.keys(run.pages);
    await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: `audit_${++n}`,
      ruleResults,
      pageStatuses: crawled.map((url) => ({ url, status: 200 })),
      resolutionSignal: run.signal
        ? run.signal(crawled, ruleResults)
        : buildResolutionSignal(ruleResults, crawled),
    });
  }
  return [...store.findings.values()].find(
    (f) => f.normalizedUrl === normalizePageUrl(A) && f.ruleId === RULE,
  )!;
}

describe("the rule-wide key's edge cases (pub#968)", () => {
  test("a truncated rule key carries every page of the rule", async () => {
    // The check key is present and says A is clean, so only the truncated
    // rule-wide key keeps the finding open.
    const row = await rowAfterRuns([
      { pages: { [A]: [fail(A)], [B]: [pass(B)] } },
      {
        pages: { [A]: [pass(A)], [B]: [pass(B)] },
        signal: (crawled) => ({
          crawledUrls: crawled,
          failing: { [`${RULE}|${CHECK}`]: [] },
          truncated: [resolutionRuleKey(RULE)],
        }),
      },
    ]);
    expect(row.state).toBe("open");
    expect(row.provenance).toBe("carried");
  });

  test("a crawl past the collection cap marks the rule-wide key truncated", () => {
    const filler = Array.from(
      { length: RESOLUTION_SIGNAL_LIMITS.maxCrawledUrls },
      (_, i) => `https://www.acme-shop.com/p/${i}`,
    );
    const signal = buildResolutionSignal(
      { [RULE]: { checks: [timedOut(A), pass(B)] } },
      [A, B, ...filler],
    )!;
    expect(signal.truncated).toContain(resolutionRuleKey(RULE));
  });

  test("the carry clears on the next normal run", async () => {
    const row = await rowAfterRuns([
      { pages: { [A]: [fail(A)], [B]: [pass(B)] } },
      { pages: { [A]: [timedOut(A)], [B]: [timedOut(B)] } },
      { pages: { [A]: [pass(A)], [B]: [pass(B)] } },
    ]);
    expect(row.state).toBe("resolved");
  });

  test("per-check keys yield to the rule-wide key under the key cap", () => {
    const many: CheckResult[] = Array.from(
      { length: RESOLUTION_SIGNAL_LIMITS.maxChecks + 5 },
      (_, i) => ({ ...pass(A), name: `c${i}` }),
    );
    const signal = buildResolutionSignal(
      { [RULE]: { checks: [...many, timedOut(B)] } },
      [A, B],
    )!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(1);
    expect(Object.keys(signal.failing).length).toBeLessThan(RESOLUTION_SIGNAL_LIMITS.maxChecks);
  });
});

describeSitePagesContract("timeout-no-resolve-968.test.ts MemStore", () => new MemStore());
