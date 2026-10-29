// #1253: a blocked seed fails the audit and every output says who blocked it,
// what matched, the code and the remedies; other blocked pages are counted and
// listed in every output and never scored. Site-chosen strings are escaped.

import { describe, expect, test } from "bun:test";

import type { WafBlockedPage } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../src/types";
import { getAuditFailureNotice } from "../src/failure-notice";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { safeBlockedPage } from "../src/waf-blocked";

const seed: WafBlockedPage = {
  url: "https://shop.example.com/",
  status: 403,
  provider: "Cloudflare",
  providerId: "cloudflare",
  signal: "cf-mitigated: challenge header",
  code: "blocked_by_cloudflare",
};

const other: WafBlockedPage = {
  url: "https://shop.example.com/cart",
  status: 200,
  provider: "DataDome",
  providerId: "datadome",
  signal: "DataDome challenge on a near-empty page",
  code: "blocked_by_datadome",
};

const base: AuditReport = {
  baseUrl: "https://shop.example.com",
  timestamp: "2026-10-29T00:00:00.000Z",
  totalPages: 0,
  passed: 0,
  warnings: 0,
  failed: 0,
  ruleResults: {},
};

const seedBlocked: AuditReport = {
  ...base,
  status: "blocked",
  statusReason:
    "Site blocked the crawler (bot protection / auth / rate limit): blocked_by_cloudflare: Cloudflare served a challenge",
  statusReasonCode: "http_4xx",
  wafBlocked: { total: 1, seed, pages: [], providers: ["Cloudflare"] },
};

const someBlocked: AuditReport = {
  ...base,
  totalPages: 12,
  healthScore: {
    overall: 90,
    categories: [],
    groups: [],
    errorCount: 0,
    warningCount: 0,
    passedCount: 1,
    debug: { base: 90, curved: 90, penalties: 0 },
  },
  wafBlocked: { total: 3, pages: [other], providers: ["DataDome"] },
};

describe("a blocked seed", () => {
  test("text names the provider, signal, code and remedies", () => {
    const text = renderText(seedBlocked);
    expect(text).toContain("AUDIT BLOCKED");
    expect(text).toContain(
      "Cloudflare served a challenge or block page instead of shop.example.com",
    );
    expect(text).toContain("cf-mitigated: challenge header, HTTP 403");
    expect(text).toContain("blocked_by_cloudflare");
    expect(text).toContain("Allowlist the `SquirrelScan` user agent");
    expect(text).toContain("[crawler] headers");
    expect(text).not.toContain("Bot Fight");
  });

  test("markdown and llm say the same", () => {
    const md = renderMarkdown(seedBlocked);
    expect(md).toContain("## Audit blocked");
    expect(md).toContain("blocked_by_cloudflare");
    expect(md).toContain("Allowlist the `SquirrelScan` user agent");
    const xml = renderLlm(seedBlocked);
    expect(xml).toContain('<status state="blocked"');
    expect(xml).toContain("<remedy>Allowlist the `SquirrelScan` user agent");
    expect(xml).toContain(
      '<waf-blocked pages="1" providers="Cloudflare" code="blocked_by_cloudflare">',
    );
  });

  test("json carries the machine-readable block and no score", () => {
    const json = JSON.parse(renderJson(seedBlocked));
    expect(json.status).toBe("blocked");
    expect(json.statusReasonCode).toBe("http_4xx");
    expect(json.wafBlocked.seed).toMatchObject({
      code: "blocked_by_cloudflare",
      status: 403,
      provider: "Cloudflare",
    });
    expect(json.score.overall).toBeNull();
  });

  test("html explains the block and lists the remedies", () => {
    const notice = getAuditFailureNotice(
      "blocked",
      "shop.example.com",
      undefined,
      "http_4xx",
      seed,
    );
    expect(notice?.heading).toBe("Cloudflare blocked the audit");
    expect(notice?.steps[0]).toContain("Allowlist the `SquirrelScan` user agent");
    const html = renderHtml(seedBlocked);
    expect(html).toContain("Cloudflare blocked the audit");
  });
});

describe("blocked pages that did not stop the audit", () => {
  test("every output counts them and lists the pages", () => {
    const line =
      "3 of 15 pages blocked by DataDome. Blocked pages were not audited and do not count in the score.";
    expect(renderText(someBlocked)).toContain(line);
    expect(renderText(someBlocked)).toContain("https://shop.example.com/cart: DataDome, HTTP 200");
    expect(renderMarkdown(someBlocked)).toContain(line);
    expect(renderLlm(someBlocked)).toContain(
      '<waf-blocked pages="3" providers="DataDome" code="blocked_by_datadome">',
    );
    expect(renderLlm(someBlocked)).toContain("Do not report them as broken pages.");
    expect(renderHtml(someBlocked)).toContain("3 of 15 pages blocked by DataDome");
    expect(JSON.parse(renderJson(someBlocked)).wafBlocked).toMatchObject({
      total: 3,
      providers: ["DataDome"],
    });
  });

  test("a report with nothing blocked prints none of it", () => {
    expect(renderText(base)).not.toContain("BLOCKED PAGES");
    expect(renderLlm(base)).not.toContain("waf-blocked");
    expect(JSON.parse(renderJson(base)).wafBlocked).toBeUndefined();
  });
});

describe("site-chosen fields are escaped", () => {
  const hostile: WafBlockedPage = {
    url: 'https://evil.example.com/a\u001b[2Jb"><script>alert(1)</script>',
    status: 403,
    provider: "Evil\u001b[2J<b>",
    providerId: "evil",
    signal: "x\u001b[2J\n\n## injected",
    code: "blocked_by_<script>",
  };

  test("the page is made printable before any renderer sees it", () => {
    const page = safeBlockedPage(hostile);
    expect(page.url).toContain("https://evil.example.com/");
    expect(page.url).not.toContain("\u001b");
    expect(page.url).not.toContain("<");
    expect(page.signal).not.toContain("\u001b");
    expect(page.signal).not.toContain("\n");
    expect(page.code).toBe("blocked_by_waf");
  });

  test("no output carries the raw escape or an unescaped tag", () => {
    const report: AuditReport = {
      ...someBlocked,
      wafBlocked: { total: 1, pages: [hostile], providers: ["Evil\u001b[2J<b>"] },
    };
    for (const out of [
      renderText(report),
      renderMarkdown(report),
      renderLlm(report),
      renderHtml(report),
    ]) {
      expect(out).not.toContain("\u001b");
      expect(out).not.toContain("<script>alert(1)</script>");
    }
  });
});
