// #1418 — refused off-site seed redirect. The crawler pins the crawl to the
// seed when a seed redirect leaves the seed's registrable domain, so `baseUrl`
// is the site the user asked for and `finalUrl` records where the redirect
// pointed. Every renderer has to say so, or the report reads as a clean audit
// of a URL nobody requested.

import { describe, expect, test } from "bun:test";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { AuditReport } from "../src/types";
import { seedRedirect, seedRedirectLine } from "../src/coverage";
import { renderText } from "../src/output/text";
import { renderMarkdown } from "../src/output/markdown";
import { renderHtml } from "../src/output/html";
import { renderLlm } from "../src/output/llm";
import { renderJson } from "../src/output/json";
import { renderXml } from "../src/output/xml";

// Built rather than typed as literals so this file carries no raw control
// characters of its own.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
/** 8-bit CSI: a terminal acts on it exactly as it does on ESC-[. */
const CSI = String.fromCharCode(0x9b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
/** In JavaScript's whitespace set, but invisible formatting rather than space. */
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0x00a0);

const NOTE =
  "Seed redirected off-site to https://other.example/landing, not followed. This audit graded https://example.com.";
const WITHHELD_NOTE =
  "Seed redirected off-site and was not followed. The redirect target was not a valid URL and is withheld. This audit graded https://example.com.";

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

/** Every renderer, so a disclosure can never be wired into only some of them. */
const RENDERERS: ReadonlyArray<{ name: string; render: (r: AuditReport) => string }> = [
  { name: "text", render: (r) => renderText(r) },
  { name: "markdown", render: (r) => renderMarkdown(r) },
  { name: "html", render: (r) => renderHtml(r, { reportId: "rep_1" }) },
  { name: "llm", render: (r) => renderLlm(r) },
  { name: "json", render: (r) => renderJson(r) },
  { name: "xml", render: (r) => renderXml(r) },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // Every value here is a URL or a sentence; coercing "false" to a boolean or a
  // numeric-looking path segment to a number would hide what was actually written.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/**
 * Validate, then parse. The parser alone is lenient about mismatched tags and
 * stray roots, so a hostile value that broke out of an attribute could still
 * come back as a plausible-looking object; the validator is what makes an
 * assertion about the parsed tree an assertion about well-formed XML.
 */
const xml = {
  parse(document: string): ReturnType<XMLParser["parse"]> {
    expect(XMLValidator.validate(document)).toBe(true);
    return parser.parse(document);
  },
};

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

  test("null when the only difference is a scheme's default port", () => {
    // The parser drops :443 on https and :80 on http, so these are the same
    // origin spelled two ways — not a redirect anywhere.
    expect(seedRedirect(baseReport({ finalUrl: "https://example.com:443/" }))).toBeNull();
    expect(seedRedirect(baseReport({ finalUrl: "https://example.com:443" }))).toBeNull();
    expect(
      seedRedirect(baseReport({ baseUrl: "http://example.com", finalUrl: "http://example.com:80/" })),
    ).toBeNull();
    // A NON-default port is a different place and still discloses.
    expect(seedRedirect(baseReport({ finalUrl: "https://example.com:8443/" }))?.finalUrl).toBe(
      "https://example.com:8443/",
    );
  });

  test("null when a Unicode host and its punycode are the same host", () => {
    // Both sides go through IDNA, so the two spellings compare equal instead of
    // producing a line claiming the seed redirected off its own domain.
    const unicodeHost = "https://例え.jp";
    const punycodeHost = "https://xn--r8jz45g.jp/";
    expect(
      seedRedirect(baseReport({ baseUrl: unicodeHost, finalUrl: punycodeHost })),
    ).toBeNull();
    expect(
      seedRedirect(baseReport({ baseUrl: punycodeHost, finalUrl: unicodeHost })),
    ).toBeNull();
  });

  test("null for a blank finalUrl, rather than an empty placeholder line", () => {
    expect(seedRedirect(baseReport({ finalUrl: "" }))).toBeNull();
    expect(seedRedirect(baseReport({ finalUrl: "   " }))).toBeNull();
    expect(seedRedirect(baseReport({ finalUrl: `${TAB}${LF}${CR}` }))).toBeNull();
    // A no-break space really is a space, so it reads as blank too.
    expect(seedRedirect(baseReport({ finalUrl: NBSP }))).toBeNull();
  });

  test("a BOM-only finalUrl is a stored value, not a blank field", () => {
    // U+FEFF is in JavaScript's whitespace set, so `trim()` would call this
    // blank — which would let an invisible value buy the silence the whole
    // disclosure exists to prevent.
    const result = seedRedirect(baseReport({ finalUrl: BOM }));
    expect(result?.finalUrl).toBeNull();
    expect(result?.note).toBe(WITHHELD_NOTE);
  });

  test("a finalUrl that is not a string is treated as absent, not thrown on", () => {
    // Out of contract rather than hostile: a renderer must not crash on it.
    // The one place untrusted data enters (slim-JSON reconstruction) maps a
    // malformed field to its own stand-in, so the disclosure survives there.
    for (const malformed of [42, {}, [], true, null]) {
      const report = baseReport();
      (report as { finalUrl?: unknown }).finalUrl = malformed;
      expect(seedRedirect(report)).toBeNull();
      expect(() => renderText(report)).not.toThrow();
    }
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
    expect(result?.finalUrl?.includes(RTL_OVERRIDE)).toBe(false);
    expect(result?.finalUrl?.includes(ZERO_WIDTH_SPACE)).toBe(false);
  });

  test("a value that is not an http(s) URL is withheld, and the redirect still disclosed", () => {
    // Refusing beats sanitizing: the only producer of this field resolves a
    // `Location` against an absolute http(s) seed, so a value that does not
    // parse is already off the legitimate path and has no shape worth keeping.
    // Sanitizing would mean maintaining a denylist of unsafe code points
    // forever; withholding keeps the WHATWG parser's allowlist. The disclosure
    // — the load-bearing half — still fires.
    for (const hostile of [
      `javascript:alert(1)${LF}x`,
      "not-a-url",
      `not-a-url${CSI}2J${RTL_OVERRIDE}txt`,
      "//protocol-relative/only",
      "data:text/html,<script>alert(1)</script>",
      // Invisible characters only. Still a stored value, so still disclosed:
      // being unprintable must not be a way to buy silence.
      `${RTL_OVERRIDE}${CSI}`,
    ]) {
      const result = seedRedirect(baseReport({ finalUrl: hostile }));
      expect(result?.finalUrl).toBeNull();
      expect(result?.note).toBe(WITHHELD_NOTE);
    }
  });

  test("baseUrl loses C1 and bidi controls too, not only C0 and whitespace", () => {
    // baseUrl is not canonicalized (it is shown the way the rest of the report
    // shows it), so it gets the same floor by subtraction.
    const result = seedRedirect(
      baseReport({
        baseUrl: `https://exa${CSI}mple.com/${RTL_OVERRIDE}p${ZERO_WIDTH_SPACE}`,
        finalUrl: "https://other.example/",
      }),
    );
    expect(result?.baseUrl).toBe("https://example.com/p");
    for (const char of [CSI, RTL_OVERRIDE, ZERO_WIDTH_SPACE]) {
      expect(result?.note.includes(char)).toBe(false);
    }
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
    const doc = xml.parse(renderLlm(redirected));
    expect(doc.audit["seed-redirect"]).toEqual({
      "@final-url": "https://other.example/landing",
      "@followed": "false",
      "#text": NOTE,
    });
    expect(xml.parse(renderLlm(baseReport())).audit["seed-redirect"]).toBeUndefined();
  });

  test("json carries the canonical URL as a structured field beside baseUrl", () => {
    const meta = JSON.parse(renderJson(redirected)).meta;
    expect(meta.seedRedirect).toEqual({
      finalUrl: "https://other.example/landing",
      followed: false,
      note: NOTE,
    });
    // The graded URL and the refused target are both present and distinct.
    expect(meta.baseUrl).toBe("https://example.com");
    expect(JSON.parse(renderJson(baseReport())).meta.seedRedirect).toBeUndefined();
  });

  test("xml carries the canonical URL as a structured element", () => {
    const doc = xml.parse(renderXml(redirected));
    expect(doc["squirrelscan-audit"]["seed-redirect"]).toEqual({
      "@followed": "false",
      "final-url": "https://other.example/landing",
      note: NOTE,
    });
    expect(xml.parse(renderXml(baseReport()))["squirrelscan-audit"]["seed-redirect"]).toBeUndefined();
  });

  test("every renderer discloses it — none can be added and left unwired", () => {
    for (const { name, render } of RENDERERS) {
      const output = render(redirected);
      expect(`${name}: ${output.includes("https://other.example/landing")}`).toBe(`${name}: true`);
      expect(`${name}: ${output.includes("not followed")}`).toBe(`${name}: true`);
    }
  });
});

describe("a target that could not be canonicalized is withheld, not sanitized", () => {
  // The repro: unparseable, and carrying both an 8-bit CSI (which a terminal
  // acts on) and a bidi override (which rewrites how the rest reads). Neither
  // is in the C0/whitespace set the old fallback stripped.
  const hostile = baseReport({ finalUrl: `not-a-url${CSI}2J${RTL_OVERRIDE}txt` });

  test("no renderer emits any byte of the stored value", () => {
    for (const { name, render } of RENDERERS) {
      const output = render(hostile);
      // The disclosure still happens, unescaped and identical in every format...
      expect(`${name}: ${output.includes(WITHHELD_NOTE)}`).toBe(`${name}: true`);
      // ...and nothing site-controlled rides along with it, in any spelling.
      for (const [label, needle] of [
        ["raw CSI", CSI],
        ["raw override", RTL_OVERRIDE],
        ["stripped value", "not-a-url"],
        ["escaped override", "%E2%80%AE"],
        ["escaped CSI", "%C2%9B"],
      ] as const) {
        expect(`${name}/${label}: ${output.includes(needle)}`).toBe(`${name}/${label}: false`);
      }
    }
  });

  test("the machine formats say the target is absent rather than inventing one", () => {
    // A consumer reading only the URL field gets nothing, not a placeholder it
    // would treat as a URL; the note carries the explanation.
    expect(JSON.parse(renderJson(hostile)).meta.seedRedirect).toEqual({
      finalUrl: null,
      followed: false,
      note: WITHHELD_NOTE,
    });
    expect(xml.parse(renderXml(hostile))["squirrelscan-audit"]["seed-redirect"]).toEqual({
      "@followed": "false",
      note: WITHHELD_NOTE,
    });
    expect(xml.parse(renderLlm(hostile)).audit["seed-redirect"]).toEqual({
      "@followed": "false",
      "#text": WITHHELD_NOTE,
    });
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

  test("the XML formats stay well-formed and keep the URL out of the markup", () => {
    // Parsed, not string-matched: a broken attribute quote or an unescaped `<`
    // shows up as a parse failure or a stray element, and matching on
    // substrings would miss both.
    const fromLlm = xml.parse(renderLlm(hostile)).audit["seed-redirect"];
    expect(fromLlm["@final-url"]).toBe(canonical);
    expect(fromLlm["#text"]).toContain(canonical);
    const fromXml = xml.parse(renderXml(hostile))["squirrelscan-audit"]["seed-redirect"];
    expect(fromXml["final-url"]).toBe(canonical);
    expect(fromXml.note).toContain(canonical);
    // The `<img>` in the value stayed a text/attribute value in both.
    for (const output of [renderLlm(hostile), renderXml(hostile)]) {
      expect(output).not.toContain("<img/onerror=y>");
    }
  });

  test("json holds the URL as data, with no escaping of its own to get wrong", () => {
    const meta = JSON.parse(renderJson(hostile)).meta;
    expect(meta.seedRedirect.finalUrl).toBe(canonical);
    expect(meta.seedRedirect.note).toContain(canonical);
  });

  test("no renderer lets a newline in finalUrl start a line of its own", () => {
    const withNewline = baseReport({ finalUrl: `https://evil.example/a${LF}# Everything is fine` });
    for (const { name, render } of RENDERERS) {
      const output = render(withNewline);
      expect(`${name}: ${output.includes("https://evil.example/a#%20Everything%20is%20fine")}`).toBe(
        `${name}: true`,
      );
      expect(`${name}: ${output.includes(`${LF}# Everything is fine`)}`).toBe(`${name}: false`);
    }
  });
});

/**
 * Return the single contiguous chunk `after` adds to `before`, failing if the
 * two differ by anything else. Asserting on the reconstruction is what makes
 * this a full-output equality check: everything outside the returned chunk is
 * byte-identical, so a report with no redirect renders exactly as it did before
 * the disclosure existed.
 */
function soleInsertion(before: string, after: string): string {
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  expect(before).toBe(after.slice(0, prefix) + after.slice(after.length - suffix));
  return after.slice(prefix, after.length - suffix);
}

describe("a report with no redirect renders byte-for-byte as it did before", () => {
  const baseline = baseReport({
    scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 1, capped: false },
    coverage: { auditedPages: 1, knownPages: 1, carriedFindings: 0 },
  });

  // Every input on which `seedRedirect` returns null. Each must produce output
  // identical to the field being absent entirely — not merely output that lacks
  // the word "Seed", which a stray blank line or wrapper would still satisfy.
  const suppressed: ReadonlyArray<[string, string]> = [
    ["blank", ""],
    ["whitespace only", "   "],
    ["tab and newline only", `${TAB}${LF}${CR}`],
    ["no-break space only", NBSP],
    ["same as baseUrl", "https://example.com"],
    ["trailing-slash spelling", "https://example.com/"],
    ["default port", "https://example.com:443/"],
    ["case-different scheme and host", "HTTPS://Example.com"],
  ];

  for (const { name, render } of RENDERERS) {
    test(`${name}: identical to the no-field rendering in every suppressed case`, () => {
      const withoutField = render(baseline);
      expect(withoutField).not.toContain("Seed redirected");
      for (const [label, finalUrl] of suppressed) {
        // Compared as one labeled string so a failure names the case.
        const rendered = render(baseReport({ ...baseline, finalUrl }));
        expect(`${label}: ${rendered}`).toBe(`${label}: ${withoutField}`);
      }
    });

    test(`${name}: a redirect adds the disclosure and changes nothing else`, () => {
      const withoutField = render(baseline);
      const withRedirect = render(
        baseReport({ ...baseline, finalUrl: "https://other.example/landing" }),
      );
      // Asserts inside: the two outputs differ by exactly this one insertion.
      const inserted = soleInsertion(withoutField, withRedirect);
      // ...and that insertion is the disclosure. It comes back rotated: the
      // diff boundary lands wherever the two outputs stop matching, which is
      // mid-token when the next line happens to start with the same character.
      // Doubling makes the block contiguous again.
      expect(`${inserted}${inserted}`).toContain(NOTE);
      // Exactly one disclosure in the whole output, so nothing rode along with
      // it. The note survives every format verbatim (nothing in it is markdown,
      // XML or JSON syntax), so this counts the same way in all six.
      expect(withRedirect.split(NOTE).length - 1).toBe(1);
    });
  }
});
