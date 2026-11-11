// i18n/hreflang-targets (#1686): where a page's hreflang links go.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { hreflangTargetsRule } from "../src/i18n/hreflang-targets";
import { buildCollectedPageSignal } from "../src/collected-signals";
import type { CheckResult, RuleContext, SiteData } from "../src/types";

const B = "https://example.com";

interface PageSpec {
  path: string;
  links?: Array<[string, string]>;
  status?: number;
  robots?: string;
  canonical?: string;
  headers?: Record<string, string>;
  finalPath?: string;
  noMarkup?: boolean;
}

function sitePage(spec: PageSpec): SiteData["pages"][number] {
  const url = `${B}${spec.path}`;
  const head =
    (spec.links ?? [])
      .map(([l, p]) => `<link rel="alternate" hreflang="${l}" href="${B}${p}">`)
      .join("") +
    (spec.robots ? `<meta name="robots" content="${spec.robots}">` : "") +
    (spec.canonical ? `<link rel="canonical" href="${spec.canonical}">` : "");
  const html = `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body><h1>h</h1></body></html>`;
  const final = spec.finalPath ? `${B}${spec.finalPath}` : undefined;
  return {
    url,
    finalUrl: final,
    statusCode: spec.status ?? 200,
    parsed: parsePage(spec.noMarkup ? "" : html, url),
    headers: spec.headers ?? {},
    ...(final
      ? {
          redirectChain: {
            finalUrl: final,
            hops: [
              { url, statusCode: 301, type: "http" },
              { url: final, statusCode: 200, type: "http" },
            ],
          },
        }
      : {}),
  } as unknown as SiteData["pages"][number];
}

function run(
  specs: PageSpec[],
  opts: { collected?: boolean; fetched?: SiteData["fetchedTargets"] } = {},
): CheckResult[] {
  const pages = specs.map(sitePage);
  const ctx = {
    page: pages[0],
    parsed: pages[0]!.parsed,
    site: { baseUrl: B, pages, fetchedTargets: opts.fetched },
    options: {},
    ...(opts.collected
      ? {
          collectedSignals: {
            pages: pages.map((p) =>
              buildCollectedPageSignal({ url: p.url, parsed: p.parsed, headers: p.headers }),
            ),
          },
        }
      : {}),
  } as unknown as RuleContext;
  return hreflangTargetsRule.run(ctx).checks as CheckResult[];
}

const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name)!;

// Every page names every other page and itself.
const fullSet = (): PageSpec[] => {
  const links: Array<[string, string]> = [
    ["en", "/en"],
    ["de", "/de"],
    ["x-default", "/en"],
  ];
  return [
    { path: "/en", links },
    { path: "/de", links },
  ];
};

for (const collected of [false, true]) {
  describe(`i18n/hreflang-targets (${collected ? "collected signals" : "site pages"})`, () => {
    test("a complete set passes all four checks", () => {
      const checks = run(fullSet(), { collected });
      for (const n of [
        "hreflang-to-redirect",
        "hreflang-to-broken",
        "hreflang-to-non-indexable",
        "hreflang-no-return-link",
      ]) {
        expect(named(checks, n).status).toBe("pass");
      }
      expect(checks.some((c) => c.name === "hreflang-not-checked")).toBe(false);
    });

    test("a target that redirects is reported with source, target and final URL", () => {
      const checks = run(
        [
          { path: "/en", links: [["de", "/old-de"]] },
          { path: "/old-de", finalPath: "/de" },
          { path: "/de" },
        ],
        { collected },
      );
      const c = named(checks, "hreflang-to-redirect");
      expect(c.status).toBe("warn");
      expect(c.items).toHaveLength(1);
      expect(c.items![0]!.id).toBe(`${B}/en -> ${B}/old-de`);
      expect(c.items![0]!.label).toContain(`${B}/de`);
    });

    test("a link to the final URL of a redirect is not a redirect when the destination was crawled", () => {
      const checks = run(
        [
          { path: "/en", links: [["de", "/de"]] },
          { path: "/old-de", finalPath: "/de" },
          { path: "/de", links: [["en", "/en"]] },
        ],
        { collected },
      );
      expect(named(checks, "hreflang-to-redirect").status).toBe("pass");
      expect(checks.some((c) => c.name === "hreflang-not-checked")).toBe(false);
    });

    test("a link to the final URL of a redirect whose destination was not crawled is not checked, never a redirect", () => {
      const checks = run(
        [
          { path: "/en", links: [["de", "/de"]] },
          { path: "/old-de", finalPath: "/de" },
        ],
        { collected },
      );
      expect(named(checks, "hreflang-to-redirect").status).toBe("pass");
      expect(named(checks, "hreflang-to-redirect").items ?? []).toHaveLength(0);
      expect(named(checks, "hreflang-not-checked").value).toBe(1);
    });

    test("a 404 and a 503 target are errors with the status", () => {
      const checks = run(
        [
          {
            path: "/en",
            links: [
              ["de", "/de"],
              ["fr", "/fr"],
            ],
          },
          { path: "/de", status: 404, noMarkup: true },
          { path: "/fr", status: 503, noMarkup: true },
        ],
        { collected },
      );
      const c = named(checks, "hreflang-to-broken");
      expect(c.status).toBe("fail");
      expect(c.items!.map((i) => i.label).join("|")).toContain("returns 404");
      expect(c.items!.map((i) => i.label).join("|")).toContain("returns 503");
    });

    test("noindex (meta and header) and a different canonical are reported with the reason", () => {
      const checks = run(
        [
          {
            path: "/en",
            links: [
              ["de", "/de"],
              ["fr", "/fr"],
              ["es", "/es"],
            ],
          },
          { path: "/de", robots: "noindex" },
          { path: "/fr", headers: { "x-robots-tag": "noindex" } },
          { path: "/es", canonical: `${B}/en` },
        ],
        { collected },
      );
      const c = named(checks, "hreflang-to-non-indexable");
      expect(c.status).toBe("warn");
      const labels = c.items!.map((i) => i.label!).join("|");
      expect(labels).toContain("robots meta tag");
      expect(labels).toContain("X-Robots-Tag header");
      expect(labels).toContain(`canonical is ${B}/en`);
    });

    test("a self canonical is not a problem", () => {
      const checks = run(
        [
          { path: "/en", links: [["de", "/de"]] },
          { path: "/de", canonical: `${B}/de/` },
        ],
        { collected },
      );
      expect(named(checks, "hreflang-to-non-indexable").status).toBe("pass");
    });

    test("a missing return link is reported once, with both URLs", () => {
      const checks = run(
        [
          {
            path: "/en",
            links: [
              ["de", "/de"],
              ["de-at", "/de"],
            ],
          },
          { path: "/de", links: [["fr", "/fr"]] },
          { path: "/fr", links: [["de", "/de"]] },
        ],
        { collected },
      );
      const c = named(checks, "hreflang-no-return-link");
      expect(c.status).toBe("fail");
      const pair = c.items!.filter((i) => i.id === `${B}/en -> ${B}/de`);
      expect(pair).toHaveLength(1);
      expect(pair[0]!.label).toContain(`${B}/en`);
    });

    test("a target with no hreflang at all is not a missing return link", () => {
      const checks = run([{ path: "/en", links: [["de", "/de"]] }, { path: "/de" }], { collected });
      expect(named(checks, "hreflang-no-return-link").status).toBe("pass");
    });

    test("targets the crawl did not fetch are counted as not checked and never fail", () => {
      const checks = run([{ path: "/en", links: [["de", "/missing"]] }], { collected });
      for (const n of [
        "hreflang-to-redirect",
        "hreflang-to-broken",
        "hreflang-to-non-indexable",
        "hreflang-no-return-link",
      ]) {
        expect(named(checks, n).status).toBe("pass");
        expect(named(checks, n).details?.checkedTargets).toBe(0);
      }
      const nc = named(checks, "hreflang-not-checked");
      expect(nc.status).toBe("info");
      expect(nc.value).toBe(1);
    });

    test("a rate-limited target is not checked", () => {
      const checks = run([{ path: "/en", links: [["de", "/de"]] }], {
        collected,
        fetched: [{ url: `${B}/de`, status: 429, rateLimited: true }],
      });
      expect(named(checks, "hreflang-to-broken").status).toBe("pass");
      expect(named(checks, "hreflang-not-checked").value).toBe(1);
    });

    test("no hreflang links gives a skipped result with the reason", () => {
      const checks = run([{ path: "/en" }, { path: "/de" }], { collected });
      expect(checks).toHaveLength(1);
      expect(checks[0]!.status).toBe("skipped");
      expect(checks[0]!.skipReason).toBeTruthy();
    });

    test("the result does not depend on page order", () => {
      const specs: PageSpec[] = [
        {
          path: "/en",
          links: [
            ["de", "/de"],
            ["fr", "/fr"],
          ],
        },
        { path: "/de", status: 404, noMarkup: true },
        { path: "/fr", links: [["it", "/it"]] },
      ];
      expect(JSON.stringify(run(specs, { collected }))).toBe(
        JSON.stringify(run([...specs].reverse(), { collected })),
      );
    });
  });
}

describe("i18n/hreflang-targets makes no requests", () => {
  test("running it never touches fetch", () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("no requests");
    }) as unknown as typeof fetch;
    try {
      run(fullSet());
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(0);
  });
});
