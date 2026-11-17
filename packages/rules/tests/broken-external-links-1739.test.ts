// #1739/#2747: an external link CONFIRMED broken (404, 410, TLS, or a host confirmed not to resolve) is a
// failure and the rule's severity is `error`; links that may be broken (5xx and connection errors,
// other 4xx) warn under their own check; links that cannot be verified inform; and the main check never
// says all links work while some were broken, unverified or never requested.

import { describe, expect, test } from "bun:test";

import {
  EXTERNAL_LINK_HOST_UNRESOLVED_ERROR,
  EXTERNAL_LINK_INVALID_SUFFIX_ERROR,
} from "@squirrelscan/core-contracts";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import type { CheckResult, ExternalLinkCheckData, ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";

function ctx(
  externalLinks: ExternalLinkCheckData[],
  externalLinkCheck?: NonNullable<RuleContext["site"]>["externalLinkCheck"],
): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null, externalLinks, externalLinkCheck },
    options: {},
  } as unknown as RuleContext;
}

const link = (over: Partial<ExternalLinkCheckData> = {}): ExternalLinkCheckData => ({
  href: "https://other.example/",
  status: 200,
  error: null,
  sourcePages: [`${BASE}/`, `${BASE}/about`],
  ...over,
});

const run = async (links: ExternalLinkCheckData[], linkCheck?: Parameters<typeof ctx>[1]) =>
  ((await brokenExternalLinksRule.run(ctx(links, linkCheck))) as { checks: CheckResult[] }).checks;
const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

describe("the rule's severity (#1739)", () => {
  test("severity is error", () => {
    expect(brokenExternalLinksRule.meta.severity).toBe("error");
  });
});

describe("confirmed broken fails (#1739)", () => {
  test.each([404, 410])("a link answering %i fails, naming the link, its status and the pages that carry it", async (status) => {
    const check = named(await run([link({ href: "https://gone.example-live.net/x", status })]), "broken-external-links")!;
    expect(check.status).toBe("fail");
    expect(check.message).toBe(`1 broken external link(s): 1 with ${status}`);
    expect(check.items?.[0]).toMatchObject({
      id: "https://gone.example-live.net/x",
      sourcePages: [`${BASE}/`, `${BASE}/about`],
      meta: { status },
    });
    expect(check.items?.[0]?.label).toContain(`(${status})`);
  });

  test("a dead domain and a reserved suffix fail, with the reason in the message and the label", async () => {
    const check = named(
      (await run([
        link({ href: "https://gone.nutshop-fault.example-live.net/", status: null, error: EXTERNAL_LINK_HOST_UNRESOLVED_ERROR }),
        link({ href: "https://nut-supplier.invalid/", status: null, error: EXTERNAL_LINK_INVALID_SUFFIX_ERROR }),
      ])),
      "broken-external-links",
    )!;
    expect(check.status).toBe("fail");
    expect(check.message).toBe("2 broken external link(s): 1 domain does not exist, 1 no such domain suffix");
    expect(check.items?.map((i) => i.label)).toEqual([
      expect.stringContaining("(domain does not exist)"),
      expect.stringContaining("(no such domain suffix)"),
    ]);
    expect(check.items?.[0]?.meta).toMatchObject({ deadHost: true });
    expect(check.details).toMatchObject({ totalBroken: 2, deadHosts: 2 });
  });

  test("one check holds every confirmed link, mixed reasons counted", async () => {
    const check = named(
      (await run([
        link({ href: "https://a.example-live.net/", status: 404 }),
        link({ href: "https://b.example-live.net/", status: 410 }),
        link({ href: "https://c.example-gone.net/", status: null, error: EXTERNAL_LINK_HOST_UNRESOLVED_ERROR }),
      ])),
      "broken-external-links",
    )!;
    expect(check.message).toBe("3 broken external link(s): 1 with 404, 1 with 410, 1 domain does not exist");
  });

  test("a TLS failure is confirmed broken", async () => {
    const check = named(
      await run([link({ href: "https://tls.example-live.net/", status: null, error: "certificate has expired" })]),
      "broken-external-links",
    )!;
    expect(check.status).toBe("fail");
    expect(check.message).toBe("1 broken external link(s): 1 TLS failure");
    expect(check.items?.[0]?.label).toContain("(TLS failure)");
  });
});

describe("possibly broken warns, under its own check (#1739)", () => {
  test.each([
    ["a 503", link({ href: "https://down.example-live.net/", status: 503 })],
    ["a 500", link({ href: "https://err.example-live.net/", status: 500 })],
    ["another 4xx", link({ href: "https://teapot.example-live.net/", status: 418 })],
    ["a connection reset", link({ href: "https://reset.example-live.net/", status: null, error: "ECONNRESET" })],
  ])("%s warns and is not a failure", async (_name, l) => {
    const checks = (await run([l]));
    expect(named(checks, "possibly-broken-external-links")?.status).toBe("warn");
    expect(named(checks, "broken-external-links")).toBeUndefined();
  });

  test("confirmed and possible are separate checks with their own names", async () => {
    const checks = (await run([
      link({ href: "https://gone.example-live.net/", status: 404 }),
      link({ href: "https://down.example-live.net/", status: 503 }),
    ]));
    expect(named(checks, "broken-external-links")?.status).toBe("fail");
    expect(named(checks, "possibly-broken-external-links")?.status).toBe("warn");
    expect(named(checks, "possibly-broken-external-links")?.message).toBe("1 external link(s) may be broken: 1 with 503");
  });
});

describe("a first failure awaiting confirmation is likely broken, under its own check (#1739)", () => {
  const awaiting = link({
    href: "https://squirrelscan.example-live.net/nutshop-fault-missing-page",
    status: null,
    wafBlocked: true,
    wafProvider: "unknown",
    unverifiedReason: "awaiting-confirmation",
  });
  test("it warns under awaiting-confirmation-external-links and is not listed as blocked", async () => {
    const checks = (await run([awaiting, link()]));
    const check = named(checks, "awaiting-confirmation-external-links")!;
    expect(check.status).toBe("warn");
    expect(check.message).toBe("1 external link(s) failed a first check and are likely broken, being confirmed");
    expect(check.items?.[0]?.label).toContain("failed once, being confirmed");
    expect(check.items?.[0]?.sourcePages).toEqual([`${BASE}/`, `${BASE}/about`]);
    expect(named(checks, "waf-blocked-external-links")).toBeUndefined();
    expect(named(checks, "broken-external-links")?.status).toBe("pass");
  });
  test("a wall beside it stays a blocked, informational link; once confirmed it is a 404 and fails", async () => {
    const wall = link({ href: "https://wall.example-live.net/", status: 403, wafBlocked: true, wafProvider: "cloudflare" });
    const checks = (await run([awaiting, wall]));
    expect(named(checks, "waf-blocked-external-links")?.items?.map((i) => i.id)).toEqual(["https://wall.example-live.net/"]);
    const confirmed = (await run([{ ...awaiting, status: 404, wafBlocked: false, unverifiedReason: undefined }]));
    expect(named(confirmed, "broken-external-links")?.status).toBe("fail");
    expect(named(confirmed, "awaiting-confirmation-external-links")).toBeUndefined();
  });
});

describe("unverifiable links are reported exactly as before and never fail (#1739)", () => {
  const unverifiable = [
    link({ href: "https://wall.example-live.net/", status: 403, wafBlocked: true, wafProvider: "cloudflare" }),
    link({ href: "https://slow.example-live.net/", status: null, wafBlocked: true, unverifiedReason: "unreachable" }),
    link({ href: "https://throttled.example-live.net/", status: 429 }),
  ];
  test("they inform; the rule has no failure and no warning", async () => {
    const checks = (await run([...unverifiable, link()]));
    expect(checks.map((c) => `${c.name}:${c.status}`).sort()).toEqual([
      "broken-external-links:pass",
      "rate-limited-external-links:info",
      "waf-blocked-external-links:info",
    ]);
  });
});

describe("bot-blocked responses do not affect the score (#2747)", () => {
  test("common bot refusals and provider edge errors are informational", async () => {
    const checks = await run([
      link({ href: "https://refused.example-live.net/", status: 403, wafBlocked: true, wafProvider: "cloudflare" }),
      link({ href: "https://linkedin.example-live.net/", status: 999, wafBlocked: true }),
      link({ href: "https://edge.example-live.net/", status: 522, wafBlocked: true, wafProvider: "cloudflare" }),
      link({ href: "https://gone.example-live.net/", status: 404 }),
    ]);
    expect(named(checks, "waf-blocked-external-links")?.status).toBe("info");
    expect(named(checks, "waf-blocked-external-links")?.items?.map((item) => item.id)).toEqual([
      "https://refused.example-live.net/",
      "https://linkedin.example-live.net/",
      "https://edge.example-live.net/",
    ]);
    expect(named(checks, "waf-blocked-external-links")?.items?.[1]?.meta).toMatchObject({ status: 999 });
    expect(named(checks, "broken-external-links")?.items?.map((item) => item.id)).toEqual([
      "https://gone.example-live.net/",
    ]);
    expect(named(checks, "possibly-broken-external-links")).toBeUndefined();
  });
});


describe("the checker's wall verdict is trusted (#2747)", () => {
  test.each([
    ["an object store 403", link({ href: "https://bucket.example-live.net/gone.zip", status: 403 })],
    ["an HTTP auth 401", link({ href: "https://auth.example-live.net/", status: 401 })],
    ["a 405 without GET", link({ href: "https://post-only.example-live.net/", status: 405 })],
  ])("%s the checker kept broken is not reported as bot-blocked", async (_name, l) => {
    const checks = await run([l]);
    expect(named(checks, "waf-blocked-external-links")).toBeUndefined();
    expect(named(checks, "possibly-broken-external-links")?.items?.map((item) => item.id)).toEqual([l.href]);
  });
});
