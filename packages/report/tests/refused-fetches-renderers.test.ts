// A blocked report names the root fetches the site refused, in every
// renderer, so a missing robots.txt or sitemap reads as "the site would not say"
// and never as "the site has none".

import { describe, expect, test } from "bun:test";

import type { RefusedFetch } from "@squirrelscan/core-contracts";

import type { AuditReport } from "../src/types";
import { refusedFetchLines } from "../src/failure-notice";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";

const REFUSED: RefusedFetch[] = [
  { url: "https://example.com/robots.txt", resource: "robots.txt", status: 403, provider: "Cloudflare" },
  { url: "https://example.com/sitemap.xml", resource: "sitemap", status: 403, provider: "Cloudflare" },
  { url: "https://example.com/sitemap_index.xml", resource: "sitemap", status: 403, provider: "Cloudflare" },
];

function blocked(refusedFetches?: RefusedFetch[]): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-07T00:00:00.000Z",
    totalPages: 0,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    status: "blocked",
    statusReason: "Site blocked the crawler (bot protection / auth / rate limit)",
    statusReasonCode: "http_4xx",
    ...(refusedFetches ? { refusedFetches } : {}),
  };
}

describe("refusedFetchLines", () => {
  test("collapses a resource refused at many locations into one line", () => {
    expect(refusedFetchLines(blocked(REFUSED))).toEqual([
      "/robots.txt: HTTP 403 (Cloudflare)",
      "sitemap, 2 requests (first /sitemap.xml): HTTP 403 (Cloudflare)",
    ]);
  });

  test("is empty when nothing was refused", () => {
    expect(refusedFetchLines(blocked())).toEqual([]);
  });
});

describe("renderers name the refusals", () => {
  test("text", () => {
    const out = renderText(blocked(REFUSED));
    expect(out).toContain("Refused by the site (not checked, so not reported as missing):");
    expect(out).toContain("/robots.txt: HTTP 403 (Cloudflare)");
  });

  test("markdown", () => {
    const out = renderMarkdown(blocked(REFUSED));
    expect(out).toContain("Refused by the site (not checked, so not reported as missing):");
    // Origin-influenced text is escaped for markdown, parentheses included.
    expect(out).toContain("- /robots.txt: HTTP 403 \\(Cloudflare\\)");
  });

  test("llm: tells the agent the resources are unknown, not missing", () => {
    const out = renderLlm(blocked(REFUSED));
    expect(out).toContain("<refused-fetches>");
    expect(out).toContain("UNKNOWN");
    expect(out).toContain("<fetch>/robots.txt: HTTP 403 (Cloudflare)</fetch>");
  });

  test("json: a machine-readable list", () => {
    const parsed = JSON.parse(renderJson(blocked(REFUSED)));
    expect(parsed.refusedFetches).toEqual(REFUSED);
  });

  test("a report with nothing refused prints no refusal section", () => {
    const report = blocked();
    expect(renderText(report)).not.toContain("Refused by the site");
    expect(renderMarkdown(report)).not.toContain("Refused by the site");
    expect(renderLlm(report)).not.toContain("<refused-fetches>");
    expect(JSON.parse(renderJson(report))).not.toHaveProperty("refusedFetches");
  });
});
