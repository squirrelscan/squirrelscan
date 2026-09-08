// THE PRECONDITIONS #1951's FAN-OUT RESTS ON.
//
// #1950 says a rule declaring `verdictScope: "template"` gives the same verdict to
// every member of a template cluster. #1951 acts on that by running the rule once
// and COPYING the verdict onto the members. Copying is only sound if the verdict
// carries nothing about the page it happened to be computed on, and that is a
// stronger property than "the members agreed on a corpus": two members of one
// cluster can agree on everything the parity gate compares while the rule still
// resolves a relative href against its own path, or interpolates its own url.
//
// The fan-out deliberately does NOT rewrite urls inside a copied check. Rewriting
// would need the inverse of a normalisation that is not injective (`pageUrl`, the
// url without its trailing slash and the bare path all normalise to one token), so
// the honest design is to require that there is nothing to rewrite and to fail a
// declaration that breaks it. This file is that requirement.
//
// It is checked by RUNNING each declaring rule on the same HTML twice under two
// urls that share nothing but the scheme and host. Anything the rule derives from
// its url — an interpolated path, a resolved relative src, a hostname comparison
// that happens to depend on depth — makes the two verdicts differ. A substring
// scan alone would miss a resolution difference that lands in an item id; the
// equality is the gate and the scan only names the field.
//
// The second precondition is a response header. `core/charset` came out of #269
// declared "template" and is constant on every corpus in every gate, because all of
// them declare the charset in a `<meta>` tag — so its fall-through to the
// `Content-Type` header, which the cluster key constrains in no way, was never
// reached by any measurement. #1951 demoted it, and the case that says why is
// pinned below so a future re-declaration fails a named test.
//
// The third precondition is `skipOnSoft404`. That gate is decided PER PAGE
// (`parsed.isSoft404`), so a rule carrying both declarations could have a sibling's
// real verdict fanned onto a page that serves 404 content. The runner orders the
// gates so this cannot happen, but a rule declaring both is a classification
// mistake and should be a named failure rather than a silently degraded path.

import { describe, expect, test } from "bun:test";

import { RuleRunner } from "../src/runner";
import { loadAllRules } from "../src/loader";
import { mayFanOutAcrossTemplate } from "../src/types";
import type { PageData, SiteData } from "../src/types";

const rules = [...loadAllRules().values()];
const fannable = rules.filter((r) => mayFanOutAcrossTemplate(r.meta));

const ORIGIN = "https://shop.test";
// Two urls that share ONLY scheme and host: different depth, different segment
// spelling, one with a query. A rule that reads its url for any purpose other than
// the origin produces different output under these.
const URL_A = `${ORIGIN}/a`;
const URL_B = `${ORIGIN}/collections/winter/products/parka-9271?variant=42`;

/**
 * One page of template chrome carrying the inputs the declared rules read, with
 * every kind of reference a page can make: root-relative, DOCUMENT-relative (the
 * one that actually depends on the url), protocol-relative and absolute. Without
 * the document-relative ones the equality below would pass on rules that resolve
 * against `ctx.page.url`, which is the failure most worth catching.
 */
const HTML =
  `<!DOCTYPE html><html lang="en"><head><title>Chrome</title>` +
  `<meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta http-equiv="refresh" content="7;url=/next">` +
  `<link rel="icon" href="/favicon.ico">` +
  `<link rel="stylesheet" href="/assets/site.css">` +
  `<link rel="stylesheet" href="theme.css">` +
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">` +
  `<script src="https://cdn.shopkit.test/app.js" defer></script>` +
  `<script src="bundle.js"></script>` +
  `<script src="//cdn.other.test/widget.js"></script>` +
  `<script src="https://cdn.shopkit.test/jquery-1.7.2.js"></script>` +
  `<script>window.__cfg={locale:"en"};var x=document.all;</script>` +
  `<style>:root{--brand:#101010}</style>` +
  `</head><body class="tpl-chrome">` +
  `<nav aria-label="Primary"><a href="/">Home</a></nav>` +
  `<main><h1>Chrome</h1><img src="hero.jpg" width="8" height="6" alt="hero">` +
  `<p>Body copy.</p></main>` +
  `<footer><p>&copy; 2026</p></footer></body></html>`;

/**
 * The same page with its `<meta charset>` removed, so `core/charset` falls
 * through to the `Content-Type` header. Kept next to HTML rather than inlined in
 * the test, because the whole point of the case below is that the header branch
 * is REACHED — a fixture that still declares a charset makes both arms pass and
 * the counterexample proves nothing.
 */
const HEADER_ONLY_HTML = HTML.replace(`<meta charset="utf-8">`, "");

function pageData(url: string, html: string = HTML): PageData {
  return {
    url,
    html,
    statusCode: 200,
    loadTime: 12,
    headers: { "content-type": "text/html; charset=utf-8" },
    finalUrl: url,
  };
}

const SITE_DATA = {
  baseUrl: ORIGIN,
  pages: [],
  robotsTxt: null,
  sitemaps: null,
} as unknown as SiteData;

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } };

const runner = new RuleRunner({ config: CONFIG });
const [resultA, resultB] = await Promise.all([
  runner.runPageRules(pageData(URL_A), SITE_DATA),
  runner.runPageRules(pageData(URL_B), SITE_DATA),
]);

/** Every distinctive substring of a url that must not survive into a verdict. */
function identities(url: string): string[] {
  const u = new URL(url);
  return [url, u.pathname + u.search, u.pathname, "parka-9271", "collections"].filter(
    (s) => s.length > 1,
  );
}

describe("the fixture exercises the declarations", () => {
  test("the declared set is non-empty and every rule of it reported", () => {
    expect(fannable.length).toBeGreaterThan(20);
    for (const rule of fannable) {
      // A rule that emitted nothing here is compared on nothing, so the gate
      // below would pass on it vacuously — the per-rule vacuity hole #1950 hit.
      expect(resultA.ruleResults.get(rule.meta.id)?.checks.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("the two urls really do differ everywhere but the origin", () => {
    expect(new URL(URL_A).origin).toBe(new URL(URL_B).origin);
    expect(new URL(URL_A).pathname).not.toBe(new URL(URL_B).pathname);
  });
});

describe("a template-scoped verdict does not depend on the page it ran on", () => {
  test.each(fannable.map((r) => [r.meta.id] as const))(
    "%s gives the same verdict under two different urls",
    (ruleId) => {
      const a = resultA.ruleResults.get(ruleId)?.checks ?? [];
      const b = resultB.ruleResults.get(ruleId)?.checks ?? [];
      const leaked = identities(URL_B).find((id) => JSON.stringify(b).includes(id));
      if (leaked) {
        throw new Error(
          `${ruleId} declares verdictScope "template" but its verdict quotes the page ` +
            `it ran on (${leaked}). #1951 copies this verdict onto the cluster's other ` +
            "members verbatim, which would attribute this page's url to them. Either " +
            'stop deriving output from `ctx.page.url`, or declare verdictScope "page".',
        );
      }
      expect(b).toEqual(a);
    },
  );
});

// ---------------------------------------------------------------------------
// The counterexample that demoted a rule
// ---------------------------------------------------------------------------

describe("core/charset reads a response header, so it is page-scoped", () => {
  test("two pages with identical markup disagree on the Content-Type header alone", async () => {
    // #269 declared this rule "template". It is constant on gymshark.com, on
    // openelectricity.org.au and on the authored parity corpus — because every
    // page of all three declares its charset in a `<meta>` tag, so the header
    // branch below is never reached and no measurement over those corpora could
    // see it. The cluster key constrains no response header, and an origin that
    // sets `charset=utf-8` on some routes and a bare `text/html` on others is
    // ordinary. #1951 demoted it; this is the case that says why, and it is here
    // so that re-declaring it fails a named test rather than shipping a `pass`
    // fanned onto a page that fails.
    const a = await runner.runPageRules(
      {
        ...pageData(URL_A, HEADER_ONLY_HTML),
        headers: { "content-type": "text/html; charset=utf-8" },
      },
      SITE_DATA,
    );
    const b = await runner.runPageRules(
      { ...pageData(URL_A, HEADER_ONLY_HTML), headers: { "content-type": "text/html" } },
      SITE_DATA,
    );

    const charsetOf = (r: Awaited<ReturnType<typeof runner.runPageRules>>) =>
      r.ruleResults.get("core/charset")?.checks ?? [];
    expect(charsetOf(a).map((c) => c.status)).toEqual(["pass"]);
    expect(charsetOf(b).map((c) => c.status)).toEqual(["fail"]);

    // The fixture has to reach the header branch for the above to mean anything:
    // a `<meta charset>` anywhere in the head would make both arms pass.
    expect(HEADER_ONLY_HTML).not.toContain("charset");

    const rule = rules.find((r) => r.meta.id === "core/charset");
    expect(rule?.meta.verdictScope).toBe("page");
    expect(mayFanOutAcrossTemplate(rule!.meta)).toBe(false);
  });
});

describe("a template-scoped rule is never also soft-404 gated", () => {
  test.each(fannable.map((r) => [r.meta.id, r.meta] as const))(
    "%s does not declare skipOnSoft404",
    (_id, meta) => {
      // The soft-404 gate is per page and the cluster key says nothing about it,
      // so the two declarations contradict each other. The runner consults a
      // fanned verdict only AFTER this gate, so the live behaviour is safe either
      // way — this keeps the contradiction from being introduced silently.
      expect(meta.skipOnSoft404).toBeUndefined();
    },
  );
});
