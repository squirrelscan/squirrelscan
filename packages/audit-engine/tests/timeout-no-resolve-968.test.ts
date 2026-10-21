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
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import {
  RULE_TIMED_OUT_SKIP_REASON,
  resolutionRuleKey,
} from "@squirrelscan/core-contracts/resolution";
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

describeSitePagesContract("timeout-no-resolve-968.test.ts MemStore", () => new MemStore());
