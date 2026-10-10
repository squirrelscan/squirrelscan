// Transport and delivery rules skip a local or private-network target, pub#629.
//
// A clean site on `localhost` scored 66/D: HTTPS, HSTS, caching, compression and
// HTTP/2 judged a dev server as if it were the production edge, and the same
// cause (no HTTPS, no compression, no caching policy) cost the score in several
// rules at once. Rules that declare `skipOnPrivateTarget` now emit one visible
// `skipped` check instead, decided from the audit URL by the classifier the CLI's
// cloud preflight already used. Public hosts run exactly as before.

import { describe, expect, test } from "bun:test";

import { type CheckResult, PRIVATE_TARGET_SKIP_REASON } from "@squirrelscan/core-contracts";

import { loadAllRules } from "../src/loader";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { PageData, SiteData } from "../src/types";

const PAGE_GATED = ["security/https", "perf/http2", "perf/compression", "perf/cache-headers"];
const SITE_GATED = [
  "security/hsts",
  "security/http-to-https",
  "perf/bad-caching",
  "perf/asset-compression",
];
const GATED = [...PAGE_GATED, ...SITE_GATED].sort();

// Rules that judge the markup, the build or headers the app itself sets. They
// look like transport rules and must keep running on a private target.
const UNGATED_PAGE = [
  "security/mixed-content",
  "security/form-https",
  "security/cookie-flags",
  "links/https-downgrade",
  "perf/ttfb",
  "core/meta-title",
];
const UNGATED_SITE = ["security/csp", "security/x-frame-options"];

const PRIVATE_SKIP: CheckResult = {
  status: "skipped",
  message: "Not applicable: local or private-network host",
  skipReason: PRIVATE_TARGET_SKIP_REASON,
  details: { foldKey: PRIVATE_TARGET_SKIP_REASON },
  name: "",
};

// Big enough that perf/compression has an opinion on a public host.
const HTML = `<!doctype html><html lang="en"><head><title>Acme Studio: dependable websites</title></head><body><h1>Hello</h1><p>${"Plain words for a page. ".repeat(400)}</p><form action="/contact"></form></body></html>`;

// What a dev server sends: no caching, no compression, no security headers.
const DEV_HEADERS = { "content-type": "text/html; charset=utf-8" };

function pageData(url: string): PageData {
  return { url, html: HTML, statusCode: 200, loadTime: 12, headers: DEV_HEADERS };
}

function site(baseUrl: string): SiteData {
  return {
    baseUrl,
    pages: [
      {
        url: `${baseUrl}/`,
        statusCode: 200,
        headers: DEV_HEADERS,
        contentType: "text/html; charset=utf-8",
      },
    ],
    robotsTxt: null,
    sitemaps: null,
    resourceSizes: { css: [], images: [] },
  } as unknown as SiteData;
}

function makeRunner(enable: string[]): RuleRunner {
  const config: RulesConfig = { rule_options: {}, rules: { enable } };
  return new RuleRunner({ config });
}

async function runPage(url: string, siteData?: SiteData) {
  const { ruleResults } = await makeRunner([...PAGE_GATED, ...UNGATED_PAGE]).runPageRules(
    pageData(url),
    siteData,
  );
  return (id: string): CheckResult[] => ruleResults.get(id)?.checks ?? [];
}

async function runSite(baseUrl: string) {
  const { ruleResults } = await makeRunner([...SITE_GATED, ...UNGATED_SITE]).runSiteRules(
    site(baseUrl),
  );
  return (id: string): CheckResult[] => ruleResults.get(id)?.checks ?? [];
}

const isPrivateSkip = (c: CheckResult) =>
  c.status === "skipped" && c.skipReason === PRIVATE_TARGET_SKIP_REASON;

describe("the skip list is explicit and conservative", () => {
  test("exactly the transport and delivery rules declare skipOnPrivateTarget", () => {
    const declared = [...loadAllRules().values()]
      .filter((r) => r.meta.skipOnPrivateTarget)
      .map((r) => r.meta.id)
      .sort();
    expect(declared).toEqual(GATED);
  });

  test("rules that judge the markup, the build or app-set headers do not", () => {
    const rules = loadAllRules();
    for (const id of [
      ...UNGATED_PAGE,
      ...UNGATED_SITE,
      "perf/unminified-js",
      "perf/unminified-css",
      "perf/source-maps",
      "security/referrer-policy",
      "security/permissions-policy",
      "security/x-content-type",
    ]) {
      expect(rules.get(id)?.meta.skipOnPrivateTarget).toBeUndefined();
    }
  });
});

describe("runner private-target gate: page rules", () => {
  test.each([
    ["http://localhost:3000/"],
    ["http://127.0.0.1:4321/about"],
    ["http://192.168.1.20/"],
    ["http://10.1.2.3:8080/"],
    ["http://[::1]:5173/"],
    ["http://mac-mini.local/"],
    ["https://localhost:3443/"], // a dev server WITH https is still not the edge
  ])("%s: every gated rule emits exactly one private-target skip", async (url) => {
    const checks = await runPage(url);
    for (const id of PAGE_GATED) {
      expect(checks(id)).toEqual([{ ...PRIVATE_SKIP, name: id }]);
    }
  });

  test("the ungated rules still run on a private target", async () => {
    const checks = await runPage("http://localhost:3000/");
    for (const id of UNGATED_PAGE) {
      expect(checks(id).length).toBeGreaterThan(0);
      expect(checks(id).some(isPrivateSkip)).toBe(false);
    }
  });

  test("a public host runs every gated rule and still fails plain HTTP", async () => {
    const checks = await runPage("http://acme.example.com/");
    for (const id of PAGE_GATED) {
      expect(checks(id).length).toBeGreaterThan(0);
      expect(checks(id).some(isPrivateSkip)).toBe(false);
    }
    expect(checks("security/https")).toEqual([
      expect.objectContaining({ name: "https", status: "fail" }),
    ]);
    expect(checks("perf/compression")[0]?.status).toBe("fail");
  });

  test.each([
    ["https://localhost.example.com/"],
    ["https://local.example.com/"],
    ["https://mylocalhost.com/"],
  ])("%s is a look-alike, not a private target", async (url) => {
    const checks = await runPage(url);
    for (const id of PAGE_GATED) {
      expect(checks(id).some(isPrivateSkip)).toBe(false);
    }
  });

  test("the audit URL decides, not the page url", async () => {
    // Pages share the audited host in practice; when site data is present its
    // base url is the one classified.
    const onPrivateSite = await runPage("http://acme.example.com/", site("http://localhost:3000"));
    for (const id of PAGE_GATED) {
      expect(onPrivateSite(id)).toEqual([{ ...PRIVATE_SKIP, name: id }]);
    }
    const onPublicSite = await runPage("http://localhost:3000/", site("http://acme.example.com"));
    for (const id of PAGE_GATED) {
      expect(onPublicSite(id).some(isPrivateSkip)).toBe(false);
    }
  });
});

describe("runner private-target gate: the audit URL", () => {
  test("an empty base url falls back to the page url", async () => {
    const checks = await runPage("http://localhost:3000/", site(""));
    for (const id of PAGE_GATED) {
      expect(checks(id)).toEqual([{ ...PRIVATE_SKIP, name: id }]);
    }
  });

  test("one runner reused for a public then a private site classifies each", async () => {
    const runner = makeRunner(PAGE_GATED);
    const at = (base: string) => runner.runPageRules(pageData(`${base}/`), site(base));
    const pub = await at("http://acme.example.com");
    const priv = await at("http://localhost:3000");
    const again = await at("http://acme.example.com");
    for (const id of PAGE_GATED) {
      expect(pub.ruleResults.get(id)?.checks.some(isPrivateSkip)).toBe(false);
      expect(priv.ruleResults.get(id)?.checks).toEqual([{ ...PRIVATE_SKIP, name: id }]);
      expect(again.ruleResults.get(id)?.checks.some(isPrivateSkip)).toBe(false);
    }
  });
});

describe("runner private-target gate: site rules", () => {
  test.each([["http://localhost:3000"], ["https://localhost:3443"], ["http://172.20.0.4"]])(
    "%s: every gated site rule emits exactly one private-target skip",
    async (baseUrl) => {
      const checks = await runSite(baseUrl);
      for (const id of SITE_GATED) {
        expect(checks(id)).toEqual([{ ...PRIVATE_SKIP, name: id }]);
      }
      for (const id of UNGATED_SITE) {
        expect(checks(id).length).toBeGreaterThan(0);
        expect(checks(id).some(isPrivateSkip)).toBe(false);
      }
    },
  );

  test("a public host runs them", async () => {
    // Plain http, so security/http-to-https stops at its own "not HTTPS" skip
    // without probing the network.
    const checks = await runSite("http://acme.example.com");
    for (const id of SITE_GATED) {
      expect(checks(id).length).toBeGreaterThan(0);
      expect(checks(id).some(isPrivateSkip)).toBe(false);
    }
    expect(checks("perf/bad-caching").some((c) => c.status === "fail")).toBe(true);
  });
});
