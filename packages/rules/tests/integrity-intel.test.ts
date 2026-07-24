// integrity Phase B — threat-intel rules (#117). The rules read the opt-in
// `ctx.intel` handle: kit-signature runs the page-scope signature matcher,
// known-malicious-url cross-references site URLs + external links against the
// intel verdicts. Both must be no-ops when `ctx.intel` is undefined (opt-in off).
//
// `ctx.intel` is stubbed here — the real engine is covered in
// packages/threat-intel/tests. This file proves the WIRING + rule logic.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  IntelContext,
  IntelSource,
  IntelUrlVerdict,
  SignatureMatch,
} from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { kitSignatureRule } from "../src/integrity/kit-signature";
import { knownMaliciousUrlRule } from "../src/integrity/known-malicious-url";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const SITE = "https://sydneyavspecialists.com.au";

// ── stub intel handles ──────────────────────────────────────────────

/** Intel stub whose signature matcher fires when the html contains a marker. */
function signatureIntel(marker: string): IntelContext {
  return {
    providers: [],
    signatureCount: 1,
    lookupUrl: (url) => ({ url, listed: false, checked: false, sources: [] }),
    matchSignatures: (input): SignatureMatch[] =>
      input.html.includes(marker)
        ? [
            {
              id: "calendly-kit",
              name: "Calendly phishing kit",
              severity: "critical",
              matchedStrings: ["calendly_brand", "google_auth_overlay"],
            },
          ]
        : [],
  };
}

/** Intel stub that flags an explicit set of URLs as listed. */
function feedIntel(listed: Record<string, IntelSource[]>): IntelContext {
  return {
    providers: ["openphish"],
    signatureCount: 0,
    matchSignatures: () => [],
    lookupUrl: (url): IntelUrlVerdict => ({
      url,
      listed: Boolean(listed[url]),
      checked: true, // a provider was consulted for every URL
      sources: listed[url] ?? [],
    }),
  };
}

// ── fixtures ────────────────────────────────────────────────────────

function pageCtx(url: string, html: string, intel?: IntelContext): RuleContext {
  const parsed = parsePage(html, url);
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    intel,
    options: {},
  };
}

function siteCtx(
  pages: SiteData["pages"],
  opts: { intel?: IntelContext; externalLinks?: SiteData["externalLinks"] } = {},
): RuleContext {
  const site: SiteData = {
    baseUrl: SITE,
    pages,
    robotsTxt: null,
    sitemaps: null,
    externalLinks: opts.externalLinks,
  };
  return {
    page: { url: pages[0]?.url ?? SITE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: pages[0]?.parsed ?? ({} as ParsedPage),
    site,
    intel: opts.intel,
    options: {},
  };
}

function checks(result: { checks: CheckResult[] }): CheckResult[] {
  return result.checks;
}

// ── kit-signature (page scope) ──────────────────────────────────────

describe("integrity/kit-signature", () => {
  const KIT = `<html><head><title>Calendly</title></head><body>
    <iframe id="google-auth"></iframe>__KIT__</body></html>`;

  test("no-op when intel is absent (opt-in off)", () => {
    const ctx = pageCtx(`${SITE}/calendly?token=x`, KIT); // no intel
    expect(checks(kitSignatureRule.run(ctx) as { checks: CheckResult[] })).toHaveLength(0);
  });

  test("fails when a signature matches the page", () => {
    const ctx = pageCtx(`${SITE}/calendly?token=x`, KIT, signatureIntel("__KIT__"));
    const out = checks(kitSignatureRule.run(ctx) as { checks: CheckResult[] });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("fail");
    expect(out[0]?.value).toBe("calendly-kit");
    expect(out[0]?.details?.severity).toBe("critical");
  });

  test("silent on a clean page even with intel on", () => {
    const ctx = pageCtx(
      `${SITE}/about`,
      "<html><body>clean</body></html>",
      signatureIntel("__KIT__"),
    );
    expect(checks(kitSignatureRule.run(ctx) as { checks: CheckResult[] })).toHaveLength(0);
  });

  test("matches against external script bodies for the page", () => {
    const url = `${SITE}/p`;
    const parsed = parsePage("<html><body>x</body></html>", url);
    const intel: IntelContext = {
      providers: [],
      signatureCount: 1,
      lookupUrl: (u) => ({ url: u, listed: false, checked: false, sources: [] }),
      matchSignatures: (input) =>
        (input.scripts ?? []).join("").includes("payload")
          ? [{ id: "x", name: "x", severity: "high", matchedStrings: ["s"] }]
          : [],
    };
    const ctx: RuleContext = {
      page: {
        url,
        html: "<html><body>x</body></html>",
        statusCode: 200,
        loadTime: 0,
        headers: {},
        parsed,
      },
      parsed,
      site: {
        baseUrl: SITE,
        pages: [],
        robotsTxt: null,
        sitemaps: null,
        scripts: [
          {
            url: `${SITE}/a.js`,
            status: 200,
            error: null,
            contentType: "text/javascript",
            sizeBytes: 10,
            content: "evil payload()",
            sourcePages: [url],
          },
          {
            url: `${SITE}/other.js`,
            status: 200,
            error: null,
            contentType: "text/javascript",
            sizeBytes: 10,
            content: "clean",
            sourcePages: [`${SITE}/elsewhere`],
          },
        ],
      },
      intel,
      options: {},
    };
    const out = checks(kitSignatureRule.run(ctx) as { checks: CheckResult[] });
    expect(out).toHaveLength(1);
  });
});

// ── known-malicious-url (site scope) ────────────────────────────────

describe("integrity/known-malicious-url", () => {
  function pageEntry(url: string): SiteData["pages"][number] {
    return { url, statusCode: 200, parsed: parsePage("<html></html>", url) };
  }

  test("no-op when intel is absent (opt-in off)", () => {
    const ctx = siteCtx([pageEntry(`${SITE}/`)]);
    expect(checks(knownMaliciousUrlRule.run(ctx) as { checks: CheckResult[] })).toHaveLength(0);
  });

  test("flags a site page listed by a feed", () => {
    const bad = `${SITE}/calendly?token=x`;
    const intel = feedIntel({
      [bad]: [{ provider: "urlhaus", matched: "url", threat: "phishing" }],
    });
    const ctx = siteCtx([pageEntry(`${SITE}/`), pageEntry(bad)], { intel });
    const out = checks(knownMaliciousUrlRule.run(ctx) as { checks: CheckResult[] });
    const fail = out.find((c) => c.status === "fail");
    expect(fail).toBeDefined();
    expect(fail?.pageUrl).toBe(bad);
    expect(fail?.details?.origin).toBe("site");
    expect(fail?.details?.providers).toContain("urlhaus");
  });

  test("flags an outbound external link to a known-malicious host", () => {
    const evil = "https://evil-collector.tk/grab";
    const intel = feedIntel({
      [evil]: [{ provider: "openphish", matched: "url", threat: "phishing" }],
    });
    const ctx = siteCtx([pageEntry(`${SITE}/`)], {
      intel,
      externalLinks: [{ href: evil, status: 200, error: null, sourcePages: [`${SITE}/`] }],
    });
    const out = checks(knownMaliciousUrlRule.run(ctx) as { checks: CheckResult[] });
    const fail = out.find((c) => c.status === "fail");
    expect(fail).toBeDefined();
    expect(fail?.details?.origin).toBe("external-link");
  });

  test("emits a single pass when intel was consulted and nothing matched", () => {
    const intel = feedIntel({}); // checked=true for all, listed for none
    const ctx = siteCtx([pageEntry(`${SITE}/`), pageEntry(`${SITE}/about`)], { intel });
    const out = checks(knownMaliciousUrlRule.run(ctx) as { checks: CheckResult[] });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("pass");
  });

  test("stays silent when NO provider was consulted (checked=false everywhere)", () => {
    const intel: IntelContext = {
      providers: [],
      signatureCount: 0,
      matchSignatures: () => [],
      lookupUrl: (url) => ({ url, listed: false, checked: false, sources: [] }),
    };
    const ctx = siteCtx([pageEntry(`${SITE}/`)], { intel });
    expect(checks(knownMaliciousUrlRule.run(ctx) as { checks: CheckResult[] })).toHaveLength(0);
  });
});
