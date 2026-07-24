import { describe, expect, test } from "bun:test";
import { ALL_FINGERPRINTS } from "../src/fingerprints";
import { detectTechnologies } from "../src/detect";
import type { TechDetectInput } from "../src/types";

const VALID_CATEGORIES = new Set([
  "cms",
  "framework",
  "analytics",
  "cdn",
  "ad-network",
  "payment",
  "web-server",
  "hosting",
  "security",
  "tag-manager",
  "chat",
  "font",
  "video",
  "widget",
  "other",
]);

describe("fingerprint set integrity", () => {
  test("has a large, curated + generated set", () => {
    expect(ALL_FINGERPRINTS.length).toBeGreaterThan(300);
  });

  test("no duplicate ids", () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const fp of ALL_FINGERPRINTS) {
      if (seen.has(fp.id)) dups.push(fp.id);
      seen.add(fp.id);
    }
    expect(dups).toEqual([]);
  });

  test("every fingerprint has a valid category and at least one detector", () => {
    for (const fp of ALL_FINGERPRINTS) {
      expect(VALID_CATEGORIES.has(fp.category)).toBe(true);
      expect(fp.detectors.length).toBeGreaterThan(0);
    }
  });

  test("every detector pattern is a usable RegExp", () => {
    for (const fp of ALL_FINGERPRINTS) {
      for (const d of fp.detectors) {
        if ("pattern" in d) {
          expect(d.pattern).toBeInstanceOf(RegExp);
          // exercising .test must not throw
          expect(() => d.pattern.test("x")).not.toThrow();
        }
      }
      if (fp.versionPattern) {
        expect(fp.versionPattern).toBeInstanceOf(RegExp);
      }
    }
  });
});

function input(partial: Partial<TechDetectInput>): TechDetectInput {
  return { url: "https://example.com", headers: {}, html: "", ...partial };
}

describe("detection (sample of researched fingerprints)", () => {
  const cases: Array<{ id: string; input: TechDetectInput }> = [
    { id: "alpinejs", input: input({ html: `<div x-data="{open:false}"></div>` }) },
    { id: "magento", input: input({ html: `<script type="text/x-magento-init">{}</script>` }) },
    {
      id: "mailchimp",
      input: input({
        html: `<script src="https://chimpstatic.com/mcjs-connected/abc.js"></script>`,
        scripts: [{ url: "https://chimpstatic.com/mcjs-connected/abc.js" }],
      }),
    },
    {
      id: "cloudinary",
      input: input({ html: `<img src="https://res.cloudinary.com/demo/x.jpg">` }),
    },
    { id: "hugo", input: input({ meta: { generator: "Hugo 0.123.0" }, html: "" }) },
    {
      id: "bigcommerce",
      input: input({ html: `<link href="https://cdn11.bigcommerce.com/x.css">` }),
    },
    { id: "prestashop", input: input({ meta: { generator: "PrestaShop" } }) },
    {
      id: "rudderstack",
      input: input({
        html: `<script src="https://cdn.rudderlabs.com/v1.1/rudder-analytics.min.js"></script>`,
        scripts: [{ url: "https://cdn.rudderlabs.com/v1.1/rudder-analytics.min.js" }],
      }),
    },
    {
      id: "fullstory",
      input: input({
        html: `<script src="https://edge.fullstory.com/s/fs.js"></script>`,
        scripts: [{ url: "https://edge.fullstory.com/s/fs.js" }],
      }),
    },
    {
      id: "jsdelivr",
      input: input({ html: `<script src="https://cdn.jsdelivr.net/npm/x"></script>` }),
    },
    {
      id: "braintree",
      input: input({
        html: `<script src="https://js.braintreegateway.com/web/3.0/js/client.js"></script>`,
        scripts: [{ url: "https://js.braintreegateway.com/web/3.0/js/client.js" }],
      }),
    },
    {
      id: "tidio",
      input: input({
        html: `<script src="https://code.tidio.co/abc123.js"></script>`,
        scripts: [{ url: "https://code.tidio.co/abc123.js" }],
      }),
    },
    {
      id: "klaviyo",
      input: input({
        html: `<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>`,
        scripts: [{ url: "https://static.klaviyo.com/onsite/js/klaviyo.js" }],
      }),
    },
  ];

  for (const c of cases) {
    test(`detects ${c.id}`, () => {
      const ids = detectTechnologies(c.input).map((t) => t.id);
      expect(ids).toContain(c.id);
    });
  }

  test("does not flag a bare unrelated page", () => {
    const res = detectTechnologies(
      input({ html: `<!doctype html><html><body><h1>Hello</h1></body></html>` }),
    );
    // A trivial page should not match a pile of vendors (guards over-broad detectors).
    expect(res.length).toBeLessThan(3);
  });

  test("extracts a version when a versionPattern matches", () => {
    const res = detectTechnologies(input({ meta: { generator: "Hugo 0.123.0" } }));
    const hugo = res.find((t) => t.id === "hugo");
    expect(hugo?.version).toBe("0.123.0");
  });

  test("never captures a digit-less version (prose like 'built with Next.js.')", () => {
    const res = detectTechnologies(
      input({
        html: `<script src="/_next/static/app.js"></script><p>This site is built with Next.js. Enjoy!</p>`,
      }),
    );
    const next = res.find((t) => t.id === "nextjs");
    expect(next).toBeDefined();
    expect(next?.version ?? null).toBeNull();
  });

  // Guards against catastrophic regex backtracking (ReDoS) in any of the 385
  // fingerprints, since script-content detectors scan full HTML. Each adversarial
  // input runs every fingerprint; a pathological pattern would blow the budget.
  test("detection is ReDoS-resistant on adversarial input", () => {
    const adversarial = [
      "a".repeat(200_000),
      `https://cdn.${"x".repeat(40)}`.repeat(3000),
      `/${"a".repeat(120)}`.repeat(2000),
      `<script src="${"/".repeat(8000)}"></script>`,
      `<meta name="generator" content="${"x".repeat(60_000)}">`,
      "/wp-".repeat(50_000),
      `${".".repeat(50_000)}`,
    ];
    for (const html of adversarial) {
      const start = performance.now();
      detectTechnologies({
        url: `https://example.com/${"a".repeat(2000)}`,
        headers: { server: "x".repeat(2000) },
        html,
        scripts: [{ url: `https://x.com/${"a".repeat(3000)}`, content: "y".repeat(50_000) }],
      });
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
});

describe("meta auto-extraction from HTML (#407)", () => {
  test("detects a generator-only CMS without a pre-parsed meta map (Wix)", () => {
    // No meta map and no static.wixstatic.com html marker → detection MUST come
    // from the auto-parsed <meta generator> tag.
    const ids = detectTechnologies(
      input({ html: `<head><meta name="generator" content="Wix.com Website Builder"></head>` }),
    ).map((t) => t.id);
    expect(ids).toContain("wix");
  });

  test("handles reversed meta attribute order (content before name)", () => {
    const ids = detectTechnologies(
      input({ html: `<meta content="WordPress 6.5.2" name="generator">` }),
    ).map((t) => t.id);
    expect(ids).toContain("wordpress");
  });

  test("extracts a version from an auto-parsed generator tag", () => {
    const res = detectTechnologies(
      input({ html: `<meta name="generator" content="Hugo 0.123.0">` }),
    );
    expect(res.find((t) => t.id === "hugo")?.version).toBe("0.123.0");
  });

  test("a caller-supplied non-empty meta map still works", () => {
    const ids = detectTechnologies(input({ meta: { generator: "Wix" }, html: "" })).map(
      (t) => t.id,
    );
    expect(ids).toContain("wix");
  });
});

describe("Angular false positive on Tailwind class soup (#1097)", () => {
  test("Tailwind tracking-/leading- utilities and ng- inside a URL slug report NO Angular", () => {
    const html = `
      <html>
        <body>
          <h1 class="tracking-tight leading-none tracking-app">Headline</h1>
          <p class="leading-relaxed tracking-wider text-primary">Body copy.</p>
          <a href="/post/00ti8qo069npm/brazil-tariffs-2026-us-duty-trade-risk-trending-fentanyl-doj-push">link</a>
        </body>
      </html>`;
    const ids = detectTechnologies(input({ html })).map((t) => t.id);
    expect(ids).not.toContain("angular");
  });

  test("timezone.js script does NOT trigger the zone.js signal", () => {
    const ids = detectTechnologies(
      input({
        html: `<script src="/vendor/timezone.js"></script>`,
        scripts: [{ url: "https://example.com/vendor/timezone.js" }],
      }),
    ).map((t) => t.id);
    expect(ids).not.toContain("angular");
  });

  test("ng-version attribute still detects Angular", () => {
    const ids = detectTechnologies(
      input({ html: `<app-root ng-version="17.0.0"></app-root>` }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("ng-app bootstrap attribute (AngularJS 1.x) still detects Angular", () => {
    const ids = detectTechnologies(
      input({ html: `<html ng-app="myApp"><body></body></html>` }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("data-ng-app (HTML5-safe attribute form) detects Angular", () => {
    const ids = detectTechnologies(
      input({ html: `<html data-ng-app="myApp"><body></body></html>` }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("x-ng-app (HTML5-safe attribute form) detects Angular", () => {
    const ids = detectTechnologies(
      input({ html: `<html x-ng-app="myApp"><body></body></html>` }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("data-tracking-app (Tailwind-ish, not a real ng-app form) reports NO Angular", () => {
    const html = `<html><body><div data-tracking-app="promo"></div></body></html>`;
    const ids = detectTechnologies(input({ html })).map((t) => t.id);
    expect(ids).not.toContain("angular");
  });

  test("ng-star-inserted class still detects Angular", () => {
    const ids = detectTechnologies(
      input({ html: `<div class="ng-star-inserted">structural directive output</div>` }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("ng-star-inserted with a single-quoted class attribute still detects Angular", () => {
    const ids = detectTechnologies(
      input({ html: `<div class='x ng-star-inserted'>structural directive output</div>` }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("content-class attribute (Vuetify, not a real class= attribute) reports NO Angular", () => {
    const html = `<div content-class="ng-star-inserted">not Angular</div>`;
    const ids = detectTechnologies(input({ html })).map((t) => t.id);
    expect(ids).not.toContain("angular");
  });

  test("zone.js bundle script src still detects Angular", () => {
    const ids = detectTechnologies(
      input({
        html: `<script src="/zone.js"></script>`,
        scripts: [{ url: "https://example.com/zone.js" }],
      }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  // matchDetector falls back to testing script-url detectors against full
  // page HTML whenever input.scripts is absent — the production path for
  // every non-home sampled page and any caller that omits scripts. A
  // src="..." attribute value ends in a quote, not string-end, so the
  // trailing anchor must accept a quote char too, or zone.js coverage only
  // works on the one page a scripts array happens to be supplied for.
  test("zone.js script src detects Angular via the HTML fallback path (no scripts array)", () => {
    const ids = detectTechnologies(
      input({ html: `<html><body><script src="/zone.js"></script></body></html>` }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("zone-evergreen.min.js on a CDN URL detects Angular via the HTML fallback path", () => {
    const ids = detectTechnologies(
      input({
        html: `<html><body><script src='https://cdn.example.com/vendor/zone-evergreen.min.js'></script></body></html>`,
      }),
    ).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("timezone.js in HTML still does NOT detect Angular via the HTML fallback path", () => {
    const ids = detectTechnologies(
      input({ html: `<html><body><script src="/vendor/timezone.js"></script></body></html>` }),
    ).map((t) => t.id);
    expect(ids).not.toContain("angular");
  });

  test("ng-star-inserted mentioned in prose (no class attribute) reports NO Angular", () => {
    const html = `<html><body><p>
      Angular stamps structural directive output with an ng-star-inserted marker class.
    </p></body></html>`;
    const ids = detectTechnologies(input({ html })).map((t) => t.id);
    expect(ids).not.toContain("angular");
  });

  // Detection is headerless HTML-string scanning (no DOM), so real Angular
  // attribute syntax appearing anywhere in the byte stream — including inside
  // an HTML comment, an inline <script> string literal, or an unescaped code
  // sample — still detects. This residual is inherent to every html-type
  // detector here (ng-version=" in a docs code sample would FP the same way)
  // and isn't something this fix set out to (or can cheaply) close.
  test("[residual, accepted] ng-app inside an HTML comment still detects Angular", () => {
    const html = `<html><body><!-- Example: <html ng-app="myApp"> --></body></html>`;
    const ids = detectTechnologies(input({ html })).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("[residual, accepted] ng-app inside an inline <script> string literal still detects Angular", () => {
    const html = `<html><body><script>const sample = '<html ng-app="myApp">';</script></body></html>`;
    const ids = detectTechnologies(input({ html })).map((t) => t.id);
    expect(ids).toContain("angular");
  });

  test("[residual, accepted] ng-star-inserted in an unescaped code sample (real class= syntax) still detects Angular", () => {
    const html = `<html><body><textarea><div class="ng-star-inserted"></div></textarea></body></html>`;
    const ids = detectTechnologies(input({ html })).map((t) => t.id);
    expect(ids).toContain("angular");
  });
});
