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

describeSitePagesContract("rule-error-no-resolve-999.test.ts MemStore", () => new MemStore());
