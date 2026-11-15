// ax/commerce-readiness: offer completeness, advisory feed and manifest detection, and the site-type gate (repo#3881).

import { describe, expect, test } from "bun:test";

import type { SiteMetadata } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { commerceReadinessRule } from "../src/ax/commerce-readiness";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { CheckResult, RuleContext } from "../src/types";

const URL_ = "https://example.com/p/widget";

function page(head: string, body = "<h1>Widget</h1>"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Widget</title>${head}</head><body>${body}</body></html>`;
}

function ld(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}

async function run(html: string): Promise<CheckResult[]> {
  const ctx = {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL_),
    options: {},
  } as unknown as RuleContext;
  return (await commerceReadinessRule.run(ctx)).checks;
}

const fullProduct = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Widget",
  sku: "W-1",
  offers: {
    "@type": "Offer",
    price: "19.99",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    shippingDetails: {
      "@type": "OfferShippingDetails",
      shippingRate: { "@type": "MonetaryAmount", value: "4.99" },
    },
    hasMerchantReturnPolicy: {
      "@type": "MerchantReturnPolicy",
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
    },
  },
};

describe("ax/commerce-readiness offer completeness", () => {
  test("a complete offer passes", async () => {
    const checks = await run(page(ld(fullProduct)));
    const c = checks.find((x) => x.name === "offer-completeness");
    expect(c?.status).toBe("pass");
  });

  test("missing fields are listed as items and warn", async () => {
    const product = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Widget",
      offers: { "@type": "Offer", price: "19.99" },
    };
    const c = (await run(page(ld(product)))).find((x) => x.name === "offer-completeness");
    expect(c?.status).toBe("warn");
    expect(c?.items?.map((i) => i.id).sort()).toEqual(
      ["availability", "currency", "identifier", "returns", "shipping"].sort(),
    );
  });

  test("a price of 0 is declared, and an organization-level return policy counts", async () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          hasMerchantReturnPolicy: {
            "@type": "MerchantReturnPolicy",
            returnPolicyCategory: "NotPermitted",
          },
        },
        {
          "@type": "Product",
          name: "Free thing",
          gtin13: "5901234123457",
          offers: {
            "@type": "Offer",
            price: 0,
            priceCurrency: "EUR",
            availability: "InStock",
            shippingDetails: {
              "@type": "OfferShippingDetails",
              shippingRate: { "@type": "MonetaryAmount", value: "4.99" },
            },
          },
        },
      ],
    };
    const c = (await run(page(ld(graph)))).find((x) => x.name === "offer-completeness");
    expect(c?.status).toBe("pass");
  });

  test("a truncated page is not judged missing", async () => {
    const html = `<html><head>${ld({ "@type": "Product", name: "W", offers: { "@type": "Offer", price: "1" } })}</head><body><h1>W</h1>`;
    const c = (await run(html)).find((x) => x.name === "offer-completeness");
    expect(c?.status).toBe("info");
  });

  test("a page with no Product markup is informational", async () => {
    const c = (await run(page(""))).find((x) => x.name === "offer-completeness");
    expect(c?.status).toBe("info");
  });
});

describe("ax/commerce-readiness feed and manifest detection", () => {
  test("detects a product feed and a checkout manifest, both informational", async () => {
    const checks = await run(
      page(
        `<link rel="alternate" type="application/rss+xml" href="/product-feed.xml">`,
        `<a href="/.well-known/ucp">ucp</a><a href="/.well-known/acp.json">acp</a>`,
      ),
    );
    const feed = checks.find((x) => x.name === "commerce-feed");
    const manifest = checks.find((x) => x.name === "commerce-manifest");
    expect(feed?.status).toBe("info");
    expect(manifest?.status).toBe("info");
    expect(manifest?.items?.length).toBe(2);
    expect(checks.every((c) => c.status !== "warn" && c.status !== "fail")).toBe(true);
  });

  test("an unrelated feed is not a product feed", async () => {
    const checks = await run(
      page(`<link rel="alternate" type="application/rss+xml" href="/blog/feed.xml">`),
    );
    expect(checks.some((x) => x.name === "commerce-feed")).toBe(false);
  });
});

describe("ax/commerce-readiness gate and override", () => {
  function runner(siteType: SiteMetadata["siteType"] | null, applies?: string): RuleRunner {
    const config: RulesConfig = {
      rule_options: applies ? { "ax/commerce-readiness": { applies } } : {},
      rules: { enable: ["ax/commerce-readiness"] },
    };
    const metadata: SiteMetadata | undefined =
      siteType === null
        ? undefined
        : ({
            siteType,
            isYMYL: false,
            isLocalBusiness: false,
            hasOwnershipVerified: false,
            confidence: "high",
          } as SiteMetadata);
    return new RuleRunner({ config, siteMetadata: metadata });
  }

  async function runPage(r: RuleRunner) {
    const html = page(ld(fullProduct));
    const result = await r.runPageRules({
      url: URL_,
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
      parsed: parsePage(html, URL_),
    } as never);
    return result.checks.filter(
      (c) => c.name === "ax/commerce-readiness" || c.name === "offer-completeness",
    );
  }

  test("a blog gets one skipped check", async () => {
    const checks = await runPage(runner("blog"));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("an ecommerce site runs the rule", async () => {
    const checks = await runPage(runner("ecommerce"));
    expect(checks.some((c) => c.name === "offer-completeness" && c.status === "pass")).toBe(true);
  });

  test("applies = on forces it on for a blog", async () => {
    const checks = await runPage(runner("blog", "on"));
    expect(checks.some((c) => c.name === "offer-completeness")).toBe(true);
  });

  test("applies = off forces it off for a shop", async () => {
    const checks = await runPage(runner("ecommerce", "off"));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toContain("off");
  });
});
