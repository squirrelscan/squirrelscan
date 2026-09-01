// #1418 — refused off-site seed redirect. The crawler pins the crawl to the
// seed when a seed redirect leaves the seed's registrable domain, so `baseUrl`
// is the site the user asked for and `finalUrl` records where the redirect
// pointed. Every renderer has to say so, or the report reads as a clean audit
// of a URL nobody requested.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { seedRedirect, seedRedirectLine } from "../src/coverage";
import { renderText } from "../src/output/text";
import { renderMarkdown } from "../src/output/markdown";
import { renderHtml } from "../src/output/html";
import { renderLlm } from "../src/output/llm";

// Built rather than typed as literals so this file carries no raw control
// characters of its own.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

const NOTE =
  "Seed redirected off-site to https://other.example/landing, not followed. This audit graded https://example.com.";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

const redirected = baseReport({ finalUrl: "https://other.example/landing" });

describe("seedRedirect", () => {
  test("names the refused target AND the URL that was actually graded", () => {
    expect(seedRedirect(redirected)).toEqual({
      finalUrl: "https://other.example/landing",
      baseUrl: "https://example.com",
      note: NOTE,
    });
    expect(seedRedirectLine(redirected)).toBe(NOTE);
  });

  test("null without a finalUrl: older reports and every seed that stayed on-site", () => {
    expect(seedRedirect(baseReport())).toBeNull();
    expect(seedRedirectLine(baseReport())).toBeNull();
  });

  test("null when finalUrl is only an equivalent spelling of baseUrl", () => {
    // Canonical comparison: a bare origin and a trailing-slash origin are the
    // same place, and a line saying the seed redirected to itself is worse
    // than no line.
    expect(seedRedirect(baseReport({ finalUrl: "https://example.com" }))).toBeNull();
    expect(seedRedirect(baseReport({ finalUrl: "https://example.com/" }))).toBeNull();
    expect(seedRedirect(baseReport({ finalUrl: " https://example.com " }))).toBeNull();
    expect(seedRedirect(baseReport({ finalUrl: "HTTPS://Example.com" }))).toBeNull();
  });

  test("null for a blank finalUrl, rather than an empty placeholder line", () => {
    expect(seedRedirect(baseReport({ finalUrl: "" }))).toBeNull();
    expect(seedRedirect(baseReport({ finalUrl: "   " }))).toBeNull();
  });

  test("null without a baseUrl: with nothing to contrast against the line says nothing", () => {
    expect(seedRedirect(baseReport({ baseUrl: "", finalUrl: "https://other.example/" }))).toBeNull();
  });

  test("canonicalizes the site's URL: control characters cannot survive as themselves", () => {
    // The redirect target is whatever `Location` the audited site sent and
    // reaches the report as a stored string, so a raw newline or ESC survives
    // validation. Re-serializing through the URL parser drops the newline and
    // percent-encodes the rest, so nothing can break out of the line below.
    const result = seedRedirect(
      baseReport({ finalUrl: `https://evil.example/a${LF}${CR}b${TAB}c d${ESC}[2Je${DEL}` }),
    );
    expect(result?.finalUrl).toBe("https://evil.example/abc%20d%1B[2Je%7F");
    expect(result?.note).toContain(`to ${result?.finalUrl},`);
    for (const char of [LF, CR, TAB, ESC, DEL]) {
      expect(result?.note.includes(char)).toBe(false);
    }
  });

  test("invisible and homograph characters become visible, not silently dropped", () => {
    // Escaping stops syntax injection; it does nothing about a URL that LOOKS
    // like another one. A bidi override would reverse how the rest of the path
    // reads, and a Cyrillic host would read as the site's own.
    const result = seedRedirect(
      baseReport({
        finalUrl: `https://еxample.com/${RTL_OVERRIDE}gnp.exe${ZERO_WIDTH_SPACE}`,
      }),
    );
    expect(result?.finalUrl).toBe("https://xn--xample-2of.com/%E2%80%AEgnp.exe%E2%80%8B");
    expect(result?.finalUrl.includes(RTL_OVERRIDE)).toBe(false);
    expect(result?.finalUrl.includes(ZERO_WIDTH_SPACE)).toBe(false);
  });

  test("a value that is not an http(s) URL still gets disclosed, with the same characters dropped", () => {
    // Better than staying silent about a redirect that happened. The fallback
    // is lossy on purpose: it only has to be safe to print.
    const result = seedRedirect(baseReport({ finalUrl: `javascript:alert(1)${LF}x` }));
    expect(result?.finalUrl).toBe("javascript:alert(1)x");
  });
});

describe("renderers surface the refused redirect", () => {
  test("text", () => {
    expect(renderText(redirected)).toContain(NOTE);
    expect(renderText(baseReport())).not.toContain("Seed redirected");
  });

  test("markdown", () => {
    expect(renderMarkdown(redirected)).toContain(NOTE);
    expect(renderMarkdown(baseReport())).not.toContain("Seed redirected");
  });

  test("markdown keeps it a plain line: a blockquote would swallow the lines below it", () => {
    // CommonMark lazy continuation pulls every following non-blank line into an
    // open blockquote, which would put scan scope, coverage and the version
    // inside the warning.
    const md = renderMarkdown(
      baseReport({
        finalUrl: "https://other.example/landing",
        scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 1, capped: false },
      }),
      { version: "1.2.3" },
    );
    const rendered = md.split("\n");
    const index = rendered.findIndex((line) => line.includes("Seed redirected"));
    expect(index).toBeGreaterThan(-1);
    expect(rendered[index]?.startsWith(">")).toBe(false);
    // The metadata below it is still its own content, not quoted text.
    expect(rendered[index + 1]).toContain("Scan: 1 page crawled");
    expect(rendered.some((line) => line.startsWith("> "))).toBe(false);
  });

  test("html", () => {
    const html = renderHtml(redirected, { reportId: "rep_1" });
    expect(html).toContain("Seed redirected off-site to https://other.example/landing");
    expect(html).toContain("not followed");
    // No node at all when there is nothing to disclose.
    const clean = renderHtml(baseReport(), { reportId: "rep_1" });
    expect(clean).not.toContain("Seed redirected");
    expect(clean).not.toContain('class="scan-hint"');
  });

  test("llm emits a machine-readable element an agent cannot miss", () => {
    const llm = renderLlm(redirected);
    expect(llm).toContain(
      '<seed-redirect final-url="https://other.example/landing" followed="false">',
    );
    expect(llm).toContain(NOTE);
    expect(renderLlm(baseReport())).not.toContain("<seed-redirect");
  });
});

describe("the site-controlled URL is escaped in every format", () => {
  // finalUrl is a string the AUDITED SITE chose. Canonicalization percent-encodes
  // `<`, `>` and backtick, but not the brackets, parens and underscores markdown
  // reads as syntax, so each renderer still has to neutralize it for its own
  // grammar.
  const hostile = baseReport({
    finalUrl: 'https://evil.example/[x](javascript:alert(1))`code`_em_<img/onerror=y>&"q"',
  });
  const canonical =
    "https://evil.example/[x](javascript:alert(1))%60code%60_em_%3Cimg/onerror=y%3E&%22q%22";

  test("the canonical form is what every renderer starts from", () => {
    expect(seedRedirect(hostile)?.finalUrl).toBe(canonical);
  });

  test("html escapes it as a React text child and never links it", () => {
    const html = renderHtml(hostile, { reportId: "rep_1" });
    expect(html).toContain("%3Cimg/onerror=y%3E&amp;");
    expect(html).not.toContain("<img/onerror=y>");
    // The whole point of the line is that we did NOT follow the redirect.
    expect(html).not.toContain('href="https://evil.example/');
  });

  test("markdown escapes link, image, code-span, emphasis and entity syntax", () => {
    const md = renderMarkdown(hostile);
    expect(md).toContain(
      "https://evil.example/\\[x\\]\\(javascript:alert\\(1\\)\\)%60code%60\\_em\\_%3Cimg/onerror=y%3E\\&%22q%22",
    );
    expect(md).not.toContain("[x](javascript:alert(1))");
  });

  test("markdown escapes an ampersand so a numeric entity cannot be decoded back", () => {
    // `&#x202E;` would otherwise reintroduce, at render time, the bidi override
    // canonicalization just percent-encoded away.
    const md = renderMarkdown(baseReport({ finalUrl: "https://evil.example/a&#x202E;b" }));
    expect(md).toContain("https://evil.example/a\\&#x202E;b");
    expect(md).not.toContain("/a&#x202E;b");
  });

  test("llm xml-escapes the attribute value and the sentence", () => {
    const llm = renderLlm(hostile);
    expect(llm).toContain(`final-url="${canonical.replaceAll("&", "&amp;")}"`);
    expect(llm).not.toContain("<img/onerror=y>");
  });

  test("llm escapes a quote that reached the fallback path, so the attribute cannot be closed", () => {
    // Canonicalization percent-encodes a quote, but a value that does not parse
    // as a URL keeps one, and it lands in an XML attribute.
    const llm = renderLlm(baseReport({ finalUrl: 'not a url" onerror="alert(1)' }));
    expect(llm).toContain('final-url="notaurl&quot;onerror=&quot;alert(1)" followed="false"');
  });

  test("no renderer lets a newline in finalUrl start a line of its own", () => {
    const withNewline = baseReport({ finalUrl: `https://evil.example/a${LF}# Everything is fine` });
    for (const output of [
      renderText(withNewline),
      renderMarkdown(withNewline),
      renderLlm(withNewline),
      renderHtml(withNewline, { reportId: "rep_1" }),
    ]) {
      expect(output).toContain("https://evil.example/a#%20Everything%20is%20fine");
      expect(output).not.toContain(`${LF}# Everything is fine`);
    }
  });
});
