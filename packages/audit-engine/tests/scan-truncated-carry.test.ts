// A scan cut short by a work cap is not a clean page (pub#501).
//
// `content/hidden-text` stops walking at 20,000 elements (and its stylesheet
// index at its own budget), `content/dev-leakage` at its element, attribute and
// copy caps. When the part they did read held nothing, both used to report
// `pass`, and a pass is evaluation evidence: the publish resolution signal
// counted the page as evaluated clean, so the merge resolved a prior finding on it
// even when that finding sits past the cap and is still there.
//
// Now they skip with `skipReason: "scan-truncated"`, and the signal lists the page
// as not evaluated, so the prior carries.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { SCAN_TRUNCATED_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import { parsePage } from "@squirrelscan/parser";
import { loadAllRules } from "@squirrelscan/rules";
import { foldOverflowChecks } from "@squirrelscan/rules/fold";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import type { RuleContext } from "@squirrelscan/rules/types";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";

const SITE = "web_501";
const PAGE = "https://www.acme-shop.com/big";
const OTHER = "https://www.acme-shop.com/small";

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

const rules = loadAllRules();

/** Run one rule on one page, stamping `pageUrl` as the runner does. */
function runRule(ruleId: string, url: string, html: string): CheckResult[] {
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = rules.get(ruleId)!.run(ctx);
  if (result instanceof Promise) throw new Error(`${ruleId} is async`);
  return result.checks.map((c) => ({ ...c, pageUrl: url }));
}

const doc = (body: string) =>
  `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

/** Past hidden-text's 20,000-element walk, with nothing hidden anywhere. */
const BIG_HIDDEN = doc(Array.from({ length: 20_100 }, (_, i) => `<p>row ${i}</p>`).join(""));
/** Past dev-leakage's 500,000-character copy cap, with no development host. */
const BIG_COPY = doc(`<p>${"plain production copy. ".repeat(23_000)}</p>`);
const SMALL = doc("<p>A small page with nothing wrong on it.</p>");

interface Case {
  ruleId: string;
  checkName: string;
  bigHtml: string;
  /** What run 1 found on the big page. */
  prior: CheckResult;
}

const CASES: Case[] = [
  {
    ruleId: "content/hidden-text",
    checkName: "hidden-text",
    bigHtml: BIG_HIDDEN,
    prior: {
      name: "hidden-text",
      status: "warn",
      message: "1 hidden element(s) containing 80 characters of text",
      pageUrl: PAGE,
      items: [{ id: "div#keywords", label: "div#keywords — display: none" }],
      details: { hiddenElements: 1, hiddenLinks: 0, hiddenChars: 80, scanTruncated: false },
    },
  },
  {
    ruleId: "content/dev-leakage",
    checkName: "dev-leakage",
    bigHtml: BIG_COPY,
    prior: {
      name: "dev-leakage",
      status: "warn",
      message: "1 development host reference(s) on a production page (localhost): example localhost:3000",
      pageUrl: PAGE,
      value: 1,
      items: [{ id: "localhost", label: "localhost", snippet: "localhost:3000" }],
      details: { kinds: [], scanTruncated: false },
    },
  },
];

const metaOf = (ruleId: string) => ({ ...rules.get(ruleId)!.meta });

/**
 * Publish twice to one store through the sampled path, each run with the
 * resolution signal its producer builds, and return the run-1 finding's row.
 */
async function priorAfterRerun(c: Case, run2: Record<string, CheckResult[]>) {
  const store = new MemStore();
  const publish = async (crawlId: string, byPage: Record<string, CheckResult[]>) => {
    const checks = Object.values(byPage).flat();
    const ruleResults = { [c.ruleId]: { meta: metaOf(c.ruleId), checks } };
    const crawled = Object.keys(byPage);
    await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId,
      ruleResults: ruleResults as never,
      pageStatuses: crawled.map((url) => ({ url, status: 200 })),
      resolutionSignal: buildResolutionSignal(ruleResults, crawled),
    });
  };
  await publish("audit_1", {
    [PAGE]: [c.prior],
    [OTHER]: runRule(c.ruleId, OTHER, SMALL),
  });
  await publish("audit_2", run2);
  const [row] = [...store.findings.values()].filter(
    (f) => f.normalizedUrl === normalizePageUrl(PAGE) && f.ruleId === c.ruleId,
  );
  return row!;
}

describe("the other caps reach the same skip (pub#501)", () => {
  test("hidden-text: the stylesheet index's rule budget", () => {
    const css = Array.from({ length: 4_100 }, (_, i) => `.c${i} { color: #123; }`).join("\n");
    const html = `<!doctype html><html lang="en"><head><title>t</title><style>${css}</style></head><body><p>ok</p></body></html>`;
    const [check] = runRule("content/hidden-text", PAGE, html);
    expect(check!.status).toBe("skipped");
    expect(check!.skipReason).toBe(SCAN_TRUNCATED_SKIP_REASON);
  });

  test("dev-leakage: the href and src value cap", () => {
    const links = Array.from({ length: 2_100 }, (_, i) => `<a href="/p/${i}">p${i}</a>`).join("");
    const [check] = runRule("content/dev-leakage", PAGE, doc(links));
    expect(check!.status).toBe("skipped");
    expect(check!.skipReason).toBe(SCAN_TRUNCATED_SKIP_REASON);
  });

  test("a folded aggregate of the skip still leaves its pages not evaluated", () => {
    // Many capped pages fold into one aggregate with `pages[]`; its own foldKey
    // keeps it apart from the rule's other skips.
    const pages = Array.from({ length: 3 }, (_, i) => `https://www.acme-shop.com/big/${i}`);
    const skips = pages.map((url) => ({ ...runRule("content/hidden-text", url, BIG_HIDDEN)[0]! }));
    const noBody: CheckResult = {
      name: "hidden-text",
      status: "skipped",
      message: "No body content to analyze",
      skipReason: "no-body",
      pageUrl: "https://www.acme-shop.com/empty",
    };
    const folded = foldOverflowChecks([...skips, noBody], {
      maxChecks: 2,
      maxItemsPerCheck: 1000,
      maxPagesPerCheck: 1000,
      maxSourcePagesPerItem: 100,
    });
    const aggregate = folded.find((c) => c.skipReason === SCAN_TRUNCATED_SKIP_REASON)!;
    expect(aggregate.details?.aggregated).toBe(true);
    expect(aggregate.pages).toHaveLength(3);
    const signal = buildResolutionSignal({ "content/hidden-text": { checks: folded } }, pages)!;
    expect(signal.notEvaluated?.["content/hidden-text|hidden-text"]).toHaveLength(3);
  });
});

for (const c of CASES) {
  describe(`${c.ruleId}: a scan cut short by a work cap (pub#501)`, () => {
    test("reports skipped, not pass, when the part scanned held nothing", () => {
      const [check] = runRule(c.ruleId, PAGE, c.bigHtml);
      expect(check!.status).toBe("skipped");
      expect(check!.skipReason).toBe(SCAN_TRUNCATED_SKIP_REASON);
      expect(check!.details?.scanTruncated).toBe(true);
      // Its own fold class, apart from the rule's other skips.
      expect(check!.details?.foldKey).toBe(SCAN_TRUNCATED_SKIP_REASON);
    });

    test("a page it read in full still passes", () => {
      const [check] = runRule(c.ruleId, OTHER, SMALL);
      expect(check!.status).toBe("pass");
    });

    test("the signal lists the page as not evaluated", () => {
      const checks = [...runRule(c.ruleId, PAGE, c.bigHtml), ...runRule(c.ruleId, OTHER, SMALL)];
      const signal = buildResolutionSignal({ [c.ruleId]: { checks } }, [PAGE, OTHER])!;
      const key = `${c.ruleId}|${c.checkName}`;
      expect(signal.failing[key]).toEqual([]);
      expect(signal.notEvaluated?.[key]).toHaveLength(1);
    });

    test("a prior finding on the page carries through the publish merge", async () => {
      const row = await priorAfterRerun(c, {
        [PAGE]: runRule(c.ruleId, PAGE, c.bigHtml),
        [OTHER]: runRule(c.ruleId, OTHER, SMALL),
      });
      expect(row.state).toBe("open");
      expect(row.provenance).toBe("carried");
    });

    test("it carries when no other page evaluated the check either", async () => {
      // With no evaluated page anywhere, the key would be missing from the
      // signal, and a missing key falls back to resolving on a crawled page.
      const row = await priorAfterRerun(c, { [PAGE]: runRule(c.ruleId, PAGE, c.bigHtml) });
      expect(row.state).toBe("open");
      expect(row.provenance).toBe("carried");
    });

    test("a page read in full and clean still resolves it", async () => {
      const row = await priorAfterRerun(c, {
        [PAGE]: runRule(c.ruleId, PAGE, SMALL),
        [OTHER]: runRule(c.ruleId, OTHER, SMALL),
      });
      expect(row.state).toBe("resolved");
    });
  });
}
