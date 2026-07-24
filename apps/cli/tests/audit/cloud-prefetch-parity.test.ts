import {
  selectCloudRules as aeSelectCloudRules,
  buildCloudPagePayloads as aeBuildCloudPagePayloads,
  buildMetadataPayload as aeBuildMetadataPayload,
  buildBlocklistPayload as aeBuildBlocklistPayload,
  buildGapsPayloads as aeBuildGapsPayloads,
  gateStage1 as aeGateStage1,
  truncateUtf8Bytes as aeTruncate,
} from "@squirrelscan/audit-engine";
import { getDefaultConfig } from "@squirrelscan/config";
import {
  computeCost,
  estimateAuditCap,
} from "@squirrelscan/core-contracts/credits";
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  selectCloudRules as cliSelectCloudRules,
  buildCloudPagePayloads as cliBuildCloudPagePayloads,
  buildMetadataPayload as cliBuildMetadataPayload,
  truncateUtf8Bytes as cliTruncate,
} from "../../src/audit/cloud";
import { gateStage1 as cliGateStage1 } from "../../src/audit/cloud-gating";
import { buildBlocklistPayload as cliBuildBlocklistPayload } from "../../src/audit/cloud-payloads-blocklist";
import { buildGapsPayloads as cliBuildGapsPayloads } from "../../src/audit/cloud-payloads-gaps";

// CLI-parity guard for the cloud-audit charging (#353, approach B). The container
// (audit-engine) REPLICATES the CLI's prefetch input-builders rather than importing
// the CLI's (which would touch the live CLI billing path). This test pins that the
// replicas produce BYTE-IDENTICAL inputs to the CLI's — same inputs → prefetchCloudData
// charges the same credits + produces the same results cloud vs CLI. Extend with the
// metadata/blocklist/gaps builders as those services land.

function fixtureSiteContext() {
  const mk = (url: string, status: number, title: string, text: string) => ({
    page: { url, status } as never,
    parsed: {
      meta: {
        title,
        description: `${title} description`,
        canonical: null,
        robots: null,
      },
      content: { textContent: text },
      headings: {
        headings: [{ text: `H1 ${title}` }, { text: `H2 ${title}` }],
      },
    } as never,
  });
  return [
    mk("https://example.com/", 200, "Home", "home page body text ".repeat(50)),
    mk(
      "https://example.com/about",
      200,
      "About",
      "about page body ".repeat(40)
    ),
    mk("https://example.com/redirect", 301, "Redirect", "should be skipped"),
    mk("https://example.com/error", 500, "Error", "should be skipped"),
  ];
}

describe("cloud prefetch input parity (container replica == CLI)", () => {
  test("selectCloudRules: replica matches the CLI for the default config", () => {
    const config = getDefaultConfig();
    const ae = aeSelectCloudRules(config as never);
    const cli = cliSelectCloudRules(config as never);
    expect(ae).toEqual(cli);
    expect(ae.length).toBeGreaterThan(0); // there ARE cloud-gated rules
  });

  test("buildCloudPagePayloads: replica matches the CLI byte-for-byte", () => {
    const sc = fixtureSiteContext();
    const ae = aeBuildCloudPagePayloads(sc as never);
    const cli = cliBuildCloudPagePayloads(sc as never);
    expect(ae).toEqual(cli);
    // non-2xx pages dropped on both sides
    expect(ae).toHaveLength(2);
  });

  test("buildMetadataPayload: replica matches the CLI (DOM-derived signals)", () => {
    const html = `<!doctype html><html lang="en"><head>
      <title>Acme</title>
      <meta property="og:site_name" content="Acme Inc">
      <meta name="twitter:site" content="@acme">
      <link rel="alternate" hreflang="fr" href="https://acme.com/fr">
      <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
      </head><body>
      <a href="https://acme.com/contact">Contact</a>
      <a href="mailto:hi@acme.com">Email</a>
      <a href="#skip">skip</a>
      </body></html>`;
    const { document } = parseHTML(html);
    const sc = [
      {
        page: {
          url: "https://acme.com/",
          finalUrl: "https://acme.com/",
          status: 200,
        },
        parsed: {
          document,
          meta: {
            title: "Acme",
            description: null,
            canonical: null,
            robots: null,
          },
        },
      },
    ];
    const ae = aeBuildMetadataPayload(sc as never, "https://acme.com/");
    const cli = cliBuildMetadataPayload(sc as never, "https://acme.com/");
    expect(ae).toEqual(cli);
    expect(ae).toHaveLength(1);
    expect(ae[0]?.metaTags?.["og:site_name"]).toBe("Acme Inc");
  });

  test("truncateUtf8Bytes: replica matches the CLI (incl. multi-byte boundary)", () => {
    const samples = [
      "plain ascii",
      "héllo wörld ".repeat(20),
      "日本語テキスト".repeat(30),
    ];
    for (const s of samples) {
      for (const cap of [5, 16, 64, 1000]) {
        expect(aeTruncate(s, cap)).toBe(cliTruncate(s, cap));
      }
    }
  });

  function siteUnitFixture() {
    const { document } = parseHTML(
      `<html><head><title>Pricing | Acme</title></head><body>
        <h1>Acme Pricing Plans</h1>
        <a href="https://tracker.io/a.js">x</a>
        <img src="https://cdn.evil.com/p.gif">
        <script src="https://ads.example.net/t.js"></script>
        <div class="adbox" id="banner1"></div>
      </body></html>`
    );
    return [
      {
        page: {
          url: "https://acme.com/pricing",
          finalUrl: "https://acme.com/pricing",
          status: 200,
        },
        parsed: {
          document,
          meta: {
            title: "Pricing | Acme",
            description: null,
            canonical: null,
            robots: null,
          },
          h1: { count: 1, texts: ["Acme Pricing Plans"] },
          links: [{ url: "https://tracker.io/a.js", isInternal: false }],
          images: [{ src: "https://cdn.evil.com/p.gif" }],
        },
      },
    ];
  }

  test("buildBlocklistPayload: replica matches the CLI (urls + selectors)", () => {
    const sc = siteUnitFixture();
    expect(aeBuildBlocklistPayload(sc as never)).toEqual(
      cliBuildBlocklistPayload(sc as never)
    );
  });

  test("buildGapsPayloads: replica matches the CLI (seeds + domain + options)", () => {
    const sc = siteUnitFixture();
    const config = getDefaultConfig();
    const ae = aeBuildGapsPayloads(
      sc as never,
      "https://www.acme.com/",
      config as never
    );
    const cli = cliBuildGapsPayloads(
      sc as never,
      "https://www.acme.com/",
      config as never
    );
    expect(ae).toEqual(cli);
  });

  test("estimateAuditCap ≥ actual worst-case across the auto-charged set", () => {
    const maxPages = 50;
    const sampled = 10; // ai-parse/authority sampling cap
    const cap = estimateAuditCap({ maxPages, render: true });
    // Pricing v10: base + renders are the only auto-charges; every folded
    // service must stay 0 for the flat price to hold. Opt-in gaps confirm and
    // charge separately, so they are deliberately OUTSIDE the cap.
    const worstCase =
      computeCost("audit_base", 1) +
      computeCost("render", maxPages) +
      computeCost("ai_parse", sampled) +
      computeCost("authority_signals", sampled) +
      computeCost("site_metadata", 1) +
      computeCost("tech_detect", 1) +
      computeCost("adblock_detect", 1) +
      computeCost("editor_summary", 1) +
      computeCost("domain_stats", 1) +
      computeCost("dead_links", maxPages * 10);
    // The cap must cover every service the audit auto-charges, so it never
    // truncates a full-parity audit (estimate ≥ actual).
    expect(cap).toBeGreaterThanOrEqual(worstCase);
    expect(cap).toBe(
      computeCost("audit_base", 1) + computeCost("render", maxPages)
    );
  });

  test("gateStage1: replica matches the CLI across site types + services", () => {
    const services = [
      "keyword-gaps",
      "content-gaps",
      "authority-signals",
      "ai-parse",
      "site-metadata",
    ] as const;
    const metas = [
      { siteType: "personal", isYMYL: false },
      { siteType: "blog", isYMYL: false },
      { siteType: "ecommerce", isYMYL: false },
      { siteType: "healthcare_provider", isYMYL: true },
    ];
    for (const meta of metas) {
      for (const svc of services) {
        expect(aeGateStage1(meta as never, svc as never)).toBe(
          cliGateStage1(meta as never, svc as never)
        );
      }
    }
  });
});
