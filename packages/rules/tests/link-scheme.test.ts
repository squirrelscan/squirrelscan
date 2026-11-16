// integrity/link-scheme (repo#3003): fixtures for the three acceptance cases, plus the cloud contract.

import { describe, expect, test } from "bun:test";

import type { CheckResult, LinkSchemeResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { CLOUD_SITE_KEY, type CloudResultStore, UNWIRED_CLOUD_SERVICES } from "../src/cloud";
import { collectLinkSchemeCandidate, linkSchemeRule } from "../src/integrity/link-scheme";
import type { RuleContext } from "../src/types";

import { expectDeclaredChecks } from "./helpers/declared-checks";

const URL_ = "https://example.com/post";

const SELLER = `<html><head><title>Buy guest posts</title></head><body><h1>Guest post placements</h1>
<p>We sell guest posts and paid link placements on our network of blogs. Link insertion from $50.</p>
<a href="https://casino-offers.example/play">best casino</a>
<a href="https://pills.example/buy">cheap pills</a></body></html>`;

const EXPLAINER = `<html><head><title>What are backlinks?</title></head><body><h1>What are backlinks?</h1>
<p>A backlink is a link from another site. Some sites run a link exchange or sell links, and Google calls that link spam. Here is how to earn links honestly.</p>
<a href="https://developers.google.com/search/docs/essentials/spam-policies">Google spam policies</a></body></html>`;

const SPONSORED = `<html><head><title>Sponsored post</title></head><body><h1>Sponsored post: Acme</h1>
<p>This sponsored post is paid for by Acme.</p>
<a rel="sponsored" href="https://acme.example/">Acme</a>
<a rel="nofollow noopener" href="https://acme.example/deal">Deal</a></body></html>`;

const SPONSORED_UNMARKED = SPONSORED.replace('rel="sponsored" ', "").replace('rel="nofollow noopener" ', "");

function ctxFor(html: string, result?: LinkSchemeResult, skip = false): RuleContext {
  const parsed = parsePage(html, URL_);
  let cloudResults: CloudResultStore | undefined;
  if (result || skip) {
    cloudResults = new Map([
      [
        "link-scheme",
        new Map([
          [
            URL_,
            skip
              ? { status: "skipped" as const, skipReason: "not-authenticated" as const }
              : { status: "ok" as const, data: result },
          ],
        ]),
      ],
    ]);
  }
  return {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
    cloudResults,
  };
}

async function run(ctx: RuleContext): Promise<CheckResult> {
  const out = ((await linkSchemeRule.run(ctx)) as { checks: CheckResult[] }).checks;
  expectDeclaredChecks(linkSchemeRule, out);
  expect(out).toHaveLength(1);
  return out[0]!;
}

const verdict = (v: LinkSchemeResult["verdict"], paidLinks: string[] = []): LinkSchemeResult => ({
  url: URL_,
  verdict: v,
  paidLinks,
  evidence: ["quote"],
  confidence: 0.9,
});

describe("integrity/link-scheme", () => {
  test("a page selling link placements with dofollow outbound links warns", async () => {
    const check = await run(
      ctxFor(SELLER, verdict("sells-or-arranges", ["https://casino-offers.example/play", "https://pills.example/buy"])),
    );
    expect(check.status).toBe("warn");
    expect(check.message).toBe("This page sells or arranges links");
    expect(check.items?.map((i) => i.label)).toEqual(["https://casino-offers.example/play", "https://pills.example/buy"]);
  });

  test("a blog post explaining backlinks on an SEO tool's site produces no finding", async () => {
    const ctx = ctxFor(EXPLAINER, verdict("writes-about"));
    expect(collectLinkSchemeCandidate(ctx)).not.toBeNull();
    expect((await run(ctx)).status).toBe("pass");
  });

  test("a sponsored post whose paid links carry rel=sponsored or nofollow produces no finding", async () => {
    const check = await run(ctxFor(SPONSORED, verdict("sponsored-content", ["https://acme.example/", "https://acme.example/deal"])));
    expect(check.status).toBe("pass");
  });

  test("a sponsored post whose paid links carry no rel warns, naming the links", async () => {
    const check = await run(ctxFor(SPONSORED_UNMARKED, verdict("sponsored-content", ["https://acme.example/"])));
    expect(check.status).toBe("warn");
    expect(check.message).toContain('lack rel="sponsored"');
    expect(check.items).toHaveLength(1);
  });

  test("a page with no link scheme wording is clean and never a candidate", async () => {
    const ctx = ctxFor("<html><body><h1>Plumbing</h1><p>We fix pipes.</p></body></html>");
    expect(collectLinkSchemeCandidate(ctx)).toBeNull();
    expect((await run(ctx)).status).toBe("pass");
  });

  test("a candidate page with no cloud result is skipped, never a finding", async () => {
    expect((await run(ctxFor(SELLER))).status).toBe("skipped");
    const skipped = await run(ctxFor(SELLER, undefined, true));
    expect(skipped.status).toBe("skipped");
    expect(skipped.skipReason).toContain("squirrel auth login");
  });

  test("the candidate payload carries only external links, with their rel", () => {
    const payload = collectLinkSchemeCandidate(ctxFor(SPONSORED));
    expect(payload?.links).toEqual([
      { href: "https://acme.example/", text: "Acme", rel: ["sponsored"] },
      { href: "https://acme.example/deal", text: "Deal", rel: ["nofollow", "noopener"] },
    ]);
  });

  test("declares meta.cloud, and its service is not advertised until the endpoint is wired", () => {
    expect(linkSchemeRule.meta.cloud).toEqual({ service: "link-scheme", unit: "page", creditFeature: "llm_rules_page" });
    expect(UNWIRED_CLOUD_SERVICES.has("link-scheme")).toBe(true);
    expect(CLOUD_SITE_KEY).toBe("site");
  });
});
