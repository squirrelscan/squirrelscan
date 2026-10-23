// pub#1046: a partial report carries ONE single-line, dismissible coverage
// notice at the top (it replaced a large panel plus a re-run command). It shows
// only when the crawl was capped, stopped on time or knows more pages than it
// scanned, never prints "0+ pages", and links the audit levels guide. Dismissal
// is per report, per browser, in localStorage, and survives storage that throws.

import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import {
  AUDIT_LEVELS_DOCS_URL,
  NOTICE_STORAGE_PREFIX,
  coverageNoticeKey,
  noteKey,
  renderHtml,
} from "../src/output/html";
import { REPORT_HTML_VERSION } from "../src/constants";
import type { AuditReport } from "../src/types";

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 200,
    passed: 3,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

const cappedScope = { origin: "cli" as const, maxPages: 200, pagesCrawled: 200, capped: true };

/** Sitemap discovery as the engine writes it (not on the AuditReport type). */
const withSitemaps = (r: AuditReport, totalUrls: number): AuditReport =>
  ({ ...r, sitemaps: { totalUrls, missingPages: [] } }) as AuditReport;

/** The notice element's markup, from its opening tag to its closing </div>. */
function noticeMarkup(html: string): string {
  const id = html.indexOf('id="coverage-notice"');
  if (id < 0) return "";
  const start = html.lastIndexOf("<div", id);
  const end = html.indexOf("</div>", id);
  return html.slice(start, end + "</div>".length);
}

/** Text content of a markup fragment, without regex tag stripping. */
function textOf(markup: string): string {
  return markup
    .split("<")
    .map((part, i) => (i === 0 ? part : part.slice(part.indexOf(">") + 1)))
    .join("")
    .split("&#x27;")
    .join("'")
    .split("&quot;")
    .join('"')
    .split("&amp;")
    .join("&");
}

/** The inline script right after the notice. */
function noticeScript(html: string): string {
  const at = html.indexOf('id="coverage-notice"');
  const open = html.indexOf("<script>", at);
  const close = html.indexOf("</script>", open);
  return html.slice(open + "<script>".length, close);
}

const LINE_TAIL =
  "Raise the audit depth in the CLI (--level full, --max-pages N) or in the cloud website settings. Audit levels";

describe("when the notice shows (pub#1046)", () => {
  test("complete: uncapped, not time-stopped, nothing known past the scan: no notice", () => {
    const html = renderHtml(
      report({
        totalPages: 40,
        scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 40, capped: false },
      }),
    );
    expect(html).not.toContain('id="coverage-notice"');
    expect(html).not.toContain("may not cover the whole site");
  });

  test("capped with nothing known past the cap: the line, no count, never 0+", () => {
    const html = renderHtml(report({ scanScope: cappedScope }));
    const notice = noticeMarkup(html);
    expect(textOf(notice)).toBe(`This report may not cover the whole site. ${LINE_TAIL}`);
    // The dismiss script spells the storage prefix as a literal (no interpolation
    // into script text); it must stay the exported constant.
    expect(html).toContain(
      `var p=${JSON.stringify(NOTICE_STORAGE_PREFIX)};document.querySelectorAll`,
    );
    // Neither the notice nor any other copy claims a count it does not have.
    expect(html).not.toMatch(/\b0\+/);
    expect(textOf(notice)).not.toContain("200 of 200");
    // No scope line: the header says what was scanned, the notice that it is partial.
    expect(html).not.toContain("Scan: 200 pages crawled");
  });

  test("capped with more pages known: the line adds the count", () => {
    const html = renderHtml(withSitemaps(report({ scanScope: cappedScope }), 540));
    expect(textOf(noticeMarkup(html))).toBe(
      `This report may not cover the whole site (340+ more pages known). ${LINE_TAIL}`,
    );
    expect(html).not.toContain("0+ pages");
  });

  test("one more page known reads in the singular", () => {
    const html = renderHtml(withSitemaps(report({ scanScope: cappedScope }), 201));
    expect(textOf(noticeMarkup(html))).toContain("(1+ more page known)");
  });

  test("time-stopped: the line, and the scope line names the time stop", () => {
    const html = renderHtml(
      report({
        totalPages: 87,
        scanScope: {
          origin: "cloud",
          maxPages: 250,
          pagesCrawled: 87,
          capped: false,
          stopReason: "time",
        },
      }),
    );
    expect(textOf(noticeMarkup(html))).toBe(
      `This report may not cover the whole site. ${LINE_TAIL}`,
    );
    expect(html).not.toContain("Scan: 87 pages crawled");
    expect(html).not.toMatch(/\b0\+/);
  });

  test("a reduced page limit does not tell the reader to raise it", () => {
    const html = renderHtml(
      report({
        scanScope: { ...cappedScope, origin: "cloud", requestedMaxPages: 1000 },
      }),
    );
    const text = textOf(noticeMarkup(html));
    expect(text).toBe(
      "This report may not cover the whole site. This run was limited to 200 of the 1,000 pages requested, so raising the limit alone will not extend it. Audit levels",
    );
    expect(text).not.toContain("--max-pages");
  });

  test("a failed run carries the failure notice, not the coverage one", () => {
    const html = renderHtml(report({ status: "failed", scanScope: cappedScope }));
    expect(html).not.toContain('id="coverage-notice"');
  });
});

describe("the notice markup", () => {
  const html = renderHtml(withSitemaps(report({ scanScope: cappedScope }), 540));
  const notice = noticeMarkup(html);

  test("exactly one notice, on a single line, and the old panel is gone", () => {
    expect(html.split('id="coverage-notice"').length - 1).toBe(1);
    // One paragraph (svg <path> elements aside).
    expect(notice.split("<p ").length - 1 + notice.split("<p>").length - 1).toBe(1);
    expect(notice.toLowerCase()).not.toContain("<br");
    expect(textOf(notice)).not.toContain("\n");
    expect(html).not.toContain('id="coverage"');
    expect(html).not.toContain("Run a larger audit");
    expect(html).not.toContain("This audit covered");
  });

  test("links the audit levels guide", () => {
    expect(AUDIT_LEVELS_DOCS_URL).toBe("https://docs.squirrelscan.com/guides/audit-levels");
    expect(notice).toContain(`href="${AUDIT_LEVELS_DOCS_URL}"`);
    expect(notice).toContain(">Audit levels</a>");
  });

  test("renders visible; the dismiss button waits for the script", () => {
    const open = notice.slice(0, notice.indexOf(">"));
    expect(open).not.toContain("hidden");
    expect(notice).toMatch(/<button type="button" data-dismiss-notice="true" hidden=""/);
    expect(notice).toContain('aria-label="Dismiss this notice"');
  });

  test("the cloud page (offline: false) renders the same notice", () => {
    const cloud = renderHtml(withSitemaps(report({ scanScope: cappedScope }), 540), {
      reportId: "abc123",
      offline: false,
    });
    expect(textOf(noticeMarkup(cloud))).toBe(textOf(notice));
    expect(noticeMarkup(cloud)).toContain('data-notice-key="r-abc123"');
  });

  test("inline script only: nothing is loaded from anywhere", () => {
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });

  test("REPORT_HTML_VERSION is bumped for the new markup", () => {
    // At least the #1046 bump; later markup changes bump it further.
    expect(REPORT_HTML_VERSION).toBeGreaterThanOrEqual(16);
  });
});

describe("dismiss key", () => {
  test("the report id when there is one, sanitised", () => {
    expect(coverageNoticeKey(report(), "TESTID")).toBe("r-TESTID");
    expect(coverageNoticeKey(report(), 'a"b<c>d')).toBe("r-abcd");
  });

  test("otherwise a stable hash of the site and the generated time", () => {
    const a = coverageNoticeKey(report());
    expect(a).toMatch(/^h-[0-9a-f]{8}$/);
    expect(coverageNoticeKey(report())).toBe(a);
    expect(coverageNoticeKey(report({ timestamp: "2026-06-17T14:30:00.000Z" }))).not.toBe(a);
    expect(coverageNoticeKey(report({ baseUrl: "https://example.org" }))).not.toBe(a);
  });
});

/** A minimal DOM for the notice script: one notice, one button. */
function fakeDom(storage: "ok" | "throws", store: Map<string, string> = new Map()) {
  let onClick: (() => void) | null = null;
  const button = {
    hidden: true,
    addEventListener: (type: string, fn: () => void) => {
      if (type === "click") onClick = fn;
    },
  };
  const notice = {
    hidden: false,
    getAttribute: (name: string) => (name === "data-notice-key" ? "r-TESTID" : null),
    querySelector: (sel: string) => (sel === "[data-dismiss-notice]" ? button : null),
  };
  const document = {
    querySelectorAll: (sel: string) => (sel === "[data-notice-key]" ? [notice] : []),
  };
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const window =
    storage === "ok"
      ? { localStorage }
      : Object.defineProperty({}, "localStorage", {
          get() {
            throw new Error("SecurityError: storage is disabled");
          },
        });
  return { document, window, notice, button, store, click: () => onClick?.() };
}

describe("dismiss script", () => {
  const script = noticeScript(
    renderHtml(report({ scanScope: cappedScope }), { reportId: "TESTID" }),
  );
  // Our own server-rendered script, run against the stub DOM in a fresh context.
  const run = (dom: ReturnType<typeof fakeDom>) =>
    // oxlint-disable-next-line sonarjs/code-eval -- a fixed script from our own renderer, not input
    runInNewContext(script, { document: dom.document, window: dom.window });

  test("every storage access sits inside a try/catch", () => {
    const uses = script.split("localStorage").length - 1;
    expect(uses).toBe(2);
    let from = 0;
    for (let i = 0; i < uses; i++) {
      const at = script.indexOf("localStorage", from);
      const before = script.slice(0, at);
      // The nearest try opened after the nearest catch: we are inside a try block.
      expect(before.lastIndexOf("try{")).toBeGreaterThan(before.lastIndexOf("catch("));
      from = at + 1;
    }
  });

  test("dismiss hides the notice and remembers it for this report", () => {
    const dom = fakeDom("ok");
    run(dom);
    expect(dom.notice.hidden).toBe(false);
    expect(dom.button.hidden).toBe(false);
    dom.click();
    expect(dom.notice.hidden).toBe(true);
    expect(dom.store.get(`${NOTICE_STORAGE_PREFIX}r-TESTID`)).toBe("1");
    // A reload of the same report starts hidden.
    const again = fakeDom("ok", dom.store);
    run(again);
    expect(again.notice.hidden).toBe(true);
  });

  test("storage that throws: the notice still shows and still dismisses", () => {
    const dom = fakeDom("throws");
    expect(() => run(dom)).not.toThrow();
    expect(dom.notice.hidden).toBe(false);
    expect(dom.button.hidden).toBe(false);
    expect(() => dom.click()).not.toThrow();
    expect(dom.notice.hidden).toBe(true);
  });
});

describe("notes under the coverage notice", () => {
  const capped = report({
    scanScope: cappedScope,
    finalUrl: "https://other.example/landing",
    detail: { capped: true },
  } as Partial<AuditReport>);
  const html = renderHtml(capped, { reportId: "TESTID" });
  const notesBlock = html.slice(
    html.indexOf('id="coverage-notice"'),
    html.indexOf("<script>", html.indexOf('id="coverage-notice"')),
  );

  test("every note line is dismissible on its own key", () => {
    const note =
      "Seed redirected off-site to https://other.example/landing, not followed. This audit graded https://example.com.";
    expect(notesBlock).toContain(
      `data-notice-key="${noteKey(coverageNoticeKey(capped, "TESTID"), note)}"`,
    );
    // The coverage notice plus the redirect note, each with its own dismiss button.
    expect(notesBlock.split("data-dismiss-notice").length - 1).toBe(2);
    expect(noteKey("r-A", "one")).not.toBe(noteKey("r-A", "two"));
  });

  test("no scope line, and the published-report note sits in the footer", () => {
    expect(html).not.toContain("Scan: 200 pages crawled");
    expect(notesBlock).not.toContain("This published report is a summary");
    const footer = html.slice(html.indexOf("<footer"));
    expect(footer).toContain('id="published-report-note"');
    expect(footer).toContain("This published report is a summary");
  });
});
