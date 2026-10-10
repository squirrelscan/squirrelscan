// A clean site scores the same on localhost as on its public host, pub#629.
//
// "Try it on my dev server" is the obvious first audit, and a clean site on
// `localhost` scored a D: the transport and delivery rules (HTTPS, HSTS,
// caching, compression, HTTP/2) judged a dev server as the production edge, and
// one cause (no compression, no caching policy) cost the score in several rules
// at once. This drives the REAL v1 pipeline (storage -> rules -> report) over
// the same four clean pages under three hosts:
//
//   private: http://localhost:4321, with what a dev server sends (no caching,
//            no compression, HTTP/1.1, no HSTS)
//   dev:     the same dev-server responses on a PUBLIC host, which is exactly
//            what the localhost audit scored before the fix
//   edge:    the same pages on https://acme.example.com behind a production
//            edge (compression, caching, validators, HSTS, HTTP/3)
//
// Public hosts must be unchanged: `dev` is still penalised for every one of
// those conditions. The canonical golden tests pin the public synthetic site's
// numbers exactly, so a drift there fails those too.

import { describe, expect, test } from "bun:test";

import type { Config, PageRecord } from "@squirrelscan/audit-engine";
import { type CheckResult, PRIVATE_TARGET_SKIP_REASON } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { getScoreGrade } from "@squirrelscan/report";
import { loadAllRules } from "@squirrelscan/rules";
import { Effect } from "effect";

import { getGoldenBaselineConfig, run, runV1Pipeline } from "./helpers/golden-baseline";

const GATED = [
  "perf/asset-compression",
  "perf/bad-caching",
  "perf/cache-headers",
  "perf/compression",
  "perf/http2",
  "security/hsts",
  "security/http-to-https",
  "security/https",
];

const PAGES = [
  {
    path: "/",
    title: "Acme Studio: dependable websites for small businesses",
    description:
      "Acme Studio designs and builds fast, accessible websites for small businesses, with clear documentation and measured results after every launch.",
    h1: "Dependable websites for small businesses",
    body: [
      "Acme Studio has helped bakeries, clinics and bookshops replace slow, fragile sites with pages that load quickly on any phone.",
      'Every project starts with a short planning call, and our <a href="/services/">design and development services</a> are priced before any work begins.',
      "We write plain documentation for each handover, so the owner can update opening hours or menus without calling anyone.",
      "After launch we measure real visits for a month and report back with numbers rather than adjectives.",
    ],
  },
  {
    path: "/about/",
    title: "About Acme Studio: the team behind your next website",
    description:
      "Meet the Acme Studio team, learn how we plan and build websites, and read about the principles that guide every client project we take on.",
    h1: "About the Acme Studio team",
    body: [
      "Four people run Acme Studio from a converted warehouse near the river, two designers and two engineers.",
      "We started in 2019 after years of fixing other agencies' work, and we still prefer small, careful projects to big rushed ones.",
      'Read how we work with clients on the <a href="/services/">services page</a>, or <a href="/contact/">get in touch</a> to say hello.',
      "Our principles are simple: accessible by default, honest estimates, and no lock-in when a client wants to move on.",
    ],
  },
  {
    path: "/services/",
    title: "Website design and development services at Acme Studio",
    description:
      "Explore the design, development, accessibility and performance services Acme Studio offers to small businesses that need a reliable website.",
    h1: "Website design and development services",
    body: [
      "Design covers brand colours, typography and layouts that stay readable for visitors with low vision.",
      "Development means hand-written pages that pass automated checks and work without a heavy framework.",
      "Accessibility reviews test keyboard navigation, screen readers and contrast, then fix what they find.",
      'Performance tuning trims images and scripts until the slowest page loads in under two seconds. <a href="/contact/">Book a planning call</a> to start.',
    ],
  },
  {
    path: "/contact/",
    title: "Contact Acme Studio to plan your new website project",
    description:
      "Get in touch with Acme Studio to talk about your website project, ask a question about our services, or book a short planning call this week.",
    h1: "Contact Acme Studio",
    body: [
      "Email hello@acme.example and a real person will reply within one working day.",
      "Calls are booked in thirty minute slots on Tuesdays and Thursdays, morning or afternoon.",
      'Not sure what you need yet? The <a href="/about/">about page</a> explains who we are and how a typical project runs.',
      "We are happy to look at an existing site first and tell you honestly whether it needs replacing at all.",
    ],
  },
  {
    path: "/privacy/",
    title: "Privacy policy: how Acme Studio handles your information",
    description:
      "Read how Acme Studio collects, stores and deletes the small amount of personal information you share when you contact us about a project.",
    h1: "Privacy policy",
    body: [
      "We only keep the name, email address and message you send us, and only for as long as a conversation is active.",
      "Nothing is sold or shared with advertisers, and this site sets no tracking cookies at all.",
      'You can ask us to delete your details at any time through the <a href="/contact/">contact page</a>.',
      "This policy was last reviewed in January 2026 and will be dated again whenever it changes.",
    ],
  },
];

function renderPage(base: string, page: (typeof PAGES)[number]): string {
  const nav = PAGES.filter((p) => p.path !== "/privacy/")
    .map((p) => `<li><a href="${p.path}">${p.h1}</a></li>`)
    .join("");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${base}/#org`,
        name: "Acme Studio",
        url: `${base}/`,
        logo: `${base}/logo.png`,
      },
      {
        "@type": "WebPage",
        "@id": `${base}${page.path}#page`,
        url: `${base}${page.path}`,
        name: page.title,
        datePublished: "2026-01-15",
        dateModified: "2026-02-01",
        author: { "@type": "Person", name: "Jamie Rivera" },
        publisher: { "@id": `${base}/#org` },
      },
    ],
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<link rel="canonical" href="${base}${page.path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="${page.title}">
<meta property="og:description" content="${page.description}">
<meta property="og:type" content="website">
<meta property="og:url" content="${base}${page.path}">
<meta property="og:image" content="${base}/og.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<header><nav aria-label="Main"><ul>${nav}</ul></nav></header>
<main>
<h1>${page.h1}</h1>
<p class="byline">By <span class="author">Jamie Rivera</span>, <time datetime="2026-01-15">15 January 2026</time></p>
${page.body.map((sentence) => `<p>${sentence}</p>`).join("\n")}
</main>
<footer><p>Acme Studio, 1 Example Street, Springfield. <a href="/contact/">Contact us</a> or read our <a href="/privacy/">privacy policy</a>.</p></footer>
</body>
</html>`;
}

type Delivery = "dev" | "edge";

function pageRecord(base: string, page: (typeof PAGES)[number], delivery: Delivery): PageRecord {
  const url = `${base}${page.path}`;
  const html = renderPage(base, page);
  const edge = delivery === "edge";
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: page.path === "/" ? 0 : 1,
    status: 200,
    contentType: "text/html; charset=utf-8",
    sizeBytes: html.length,
    loadTimeMs: 40,
    fetchedAt: 1_700_000_000_000,
    etag: edge ? `"${page.path.length}-acme"` : null,
    lastModified: null,
    contentHash: `hash-${page.path}`,
    html,
    parsedData: null,
    headers: {
      contentType: "text/html; charset=utf-8",
      contentEncoding: edge ? "br" : null,
      cacheControl: edge ? "public, max-age=300, stale-while-revalidate=60" : null,
      expires: null,
      vary: edge ? "Accept-Encoding" : null,
      etag: edge ? `"${page.path.length}-acme"` : null,
      server: edge ? "cloudflare" : null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: edge ? 'h3=":443"; ma=86400' : null,
      acceptRanges: null,
      setCookie: null,
    },
    securityHeaders: {
      hsts: edge ? "max-age=31536000; includeSubDomains" : null,
      // Set by the app itself, so the dev server sends them too.
      csp: "default-src 'self'",
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      permissionsPolicy: "camera=()",
      xRobotsTag: null,
    },
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  } as unknown as PageRecord;
}

function config(): Config {
  const base = getGoldenBaselineConfig();
  return {
    ...base,
    rules: {
      ...base.rules,
      // It probes `http://` variants of an https site over the network; the
      // edge run is https. Off in every run so all three score the same rules.
      disable: [...(base.rules.disable ?? []), "security/http-to-https"],
    },
  };
}

interface Audit {
  overall: number;
  grade: string;
  checks: (ruleId: string) => CheckResult[];
}

async function audit(base: string, delivery: Delivery): Promise<Audit> {
  const storage = new SQLiteStorage(":memory:");
  try {
    await run(storage.init());
    const crawlId = await run(
      storage.createCrawl({
        baseUrl: base,
        seedUrl: `${base}/`,
        startedAt: 1_700_000_000_000,
        status: "completed",
        config: {} as never,
        stats: {
          pagesTotal: PAGES.length,
          pagesFetched: PAGES.length,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 40,
        },
      } as never),
    );
    for (const page of PAGES) {
      await run(storage.upsertPage(crawlId, pageRecord(base, page, delivery)));
    }
    const sitemapUrl = `${base}/sitemap.xml`;
    const robots = `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;
    await run(
      storage.setRobotsTxt(crawlId, {
        url: `${base}/robots.txt`,
        exists: true,
        content: robots,
        sizeBytes: robots.length,
        sitemaps: [sitemapUrl],
        fetchedAt: 1_700_000_000_000,
        error: null,
      }),
    );
    await run(
      storage.addSitemap(crawlId, {
        url: sitemapUrl,
        type: "urlset",
        urlCount: PAGES.length,
        childSitemaps: [],
        errors: [],
        fetchedAt: 1_700_000_000_000,
      }),
    );
    await run(
      storage.addSitemapUrls(
        crawlId,
        PAGES.map((p) => ({ sitemapUrl, loc: `${base}${p.path}` })),
      ),
    );

    const { report } = await runV1Pipeline(storage, crawlId, config());
    const overall = report.healthScore?.overall;
    if (typeof overall !== "number") throw new Error("audit produced no score");
    return {
      overall,
      grade: getScoreGrade(overall),
      checks: (ruleId) => report.ruleResults[ruleId]?.checks ?? [],
    };
  } finally {
    await Effect.runPromise(storage.close().pipe(Effect.orDie));
  }
}

const isPrivateSkip = (c: CheckResult) =>
  c.status === "skipped" && c.skipReason === PRIVATE_TARGET_SKIP_REASON;

/** Checks that move the score: fail, or warn on a rule that is not advisory. */
function scored(checks: CheckResult[], ruleId: string): CheckResult[] {
  const advisory = loadAllRules().get(ruleId)?.meta.severity === "info";
  return checks.filter((c) => c.status === "fail" || (c.status === "warn" && !advisory));
}

const [privateRun, devRun, edgeRun] = await Promise.all([
  audit("http://localhost:4321", "dev"),
  audit("http://acme.example.com", "dev"),
  audit("https://acme.example.com", "edge"),
]);

describe("pub#629: a clean dev site scores like the clean public site", () => {
  test("the dev server's responses on a public host are what localhost used to score", () => {
    // The reproduction. Before the fix the host made no difference, so this is
    // the localhost score the issue reported: well below an A.
    expect(devRun.grade).not.toBe("A");
    expect(devRun.overall).toBeLessThan(90);
  });

  test("on localhost the same responses score an A", () => {
    expect(privateRun.grade).toBe("A");
    expect(privateRun.overall).toBeGreaterThanOrEqual(90);
    expect(privateRun.overall).toBeGreaterThan(devRun.overall);
  });

  test("and land within a point or two of the site behind a production edge", () => {
    expect(edgeRun.grade).toBe("A");
    expect(Math.abs(privateRun.overall - edgeRun.overall)).toBeLessThanOrEqual(2);
  });

  test("every gated rule is skipped on localhost, never passed or failed", () => {
    for (const id of GATED.filter((g) => g !== "security/http-to-https")) {
      const checks = privateRun.checks(id);
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.every(isPrivateSkip)).toBe(true);
    }
  });
});

describe("pub#629: one cause is not charged several times on a private target", () => {
  // Each condition a dev server has by design, with the rules that charge for
  // it on a public host. On a public host each costs the score more than once,
  // which is the multiplication the issue reported; on a private target none
  // of them is charged at all.
  const CONDITIONS: Record<string, string[]> = {
    "no compression": ["perf/compression", "perf/bad-caching"],
    "no caching policy": ["perf/cache-headers", "perf/bad-caching"],
  };

  test.each(Object.entries(CONDITIONS))(
    "%s: charged by several rules on a public host",
    (_condition, rules) => {
      const charging = rules.filter((id) => scored(devRun.checks(id), id).length > 0);
      expect(charging).toEqual(rules);
    },
  );

  test.each(Object.entries(CONDITIONS))(
    "%s: charged by no rule on localhost",
    (_condition, rules) => {
      for (const id of rules) expect(scored(privateRun.checks(id), id)).toEqual([]);
    },
  );

  test("no HTTPS: charged on a public host, not on localhost", () => {
    expect(scored(devRun.checks("security/https"), "security/https").length).toBeGreaterThan(0);
    expect(scored(privateRun.checks("security/https"), "security/https")).toEqual([]);
  });
});

describe("pub#629: public hosts are unchanged", () => {
  test("no gated rule skips on a public host, plain http or https", () => {
    for (const result of [devRun, edgeRun]) {
      for (const id of GATED) {
        expect(result.checks(id).some(isPrivateSkip)).toBe(false);
      }
    }
  });

  test("plain http on a public host still fails HTTPS", () => {
    expect(devRun.checks("security/https").some((c) => c.status === "fail")).toBe(true);
  });
});
