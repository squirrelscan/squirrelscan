// #1739: an external link CONFIRMED broken (404, 410, or a host confirmed not to resolve) is a
// failure and the rule's severity is `error`; links that may be broken (5xx, TLS and connection errors,
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

const run = (links: ExternalLinkCheckData[], linkCheck?: Parameters<typeof ctx>[1]) =>
  (brokenExternalLinksRule.run(ctx(links, linkCheck)) as { checks: CheckResult[] }).checks;
const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

describe("the rule's severity (#1739)", () => {
  test("severity is error", () => {
    expect(brokenExternalLinksRule.meta.severity).toBe("error");
  });
});

describe("confirmed broken fails (#1739)", () => {
  test.each([404, 410])("a link answering %i fails, naming the link, its status and the pages that carry it", (status) => {
    const check = named(run([link({ href: "https://gone.example-live.net/x", status })]), "broken-external-links")!;
    expect(check.status).toBe("fail");
    expect(check.message).toBe(`1 broken external link(s): 1 with ${status}`);
    expect(check.items?.[0]).toMatchObject({
      id: "https://gone.example-live.net/x",
      sourcePages: [`${BASE}/`, `${BASE}/about`],
      meta: { status },
    });
    expect(check.items?.[0]?.label).toContain(`(${status})`);
  });

  test("a dead domain and a reserved suffix fail, with the reason in the message and the label", () => {
    const check = named(
      run([
        link({ href: "https://gone.nutshop-fault.example-live.net/", status: null, error: EXTERNAL_LINK_HOST_UNRESOLVED_ERROR }),
        link({ href: "https://nut-supplier.invalid/", status: null, error: EXTERNAL_LINK_INVALID_SUFFIX_ERROR }),
      ]),
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

  test("one check holds every confirmed link, mixed reasons counted", () => {
    const check = named(
      run([
        link({ href: "https://a.example-live.net/", status: 404 }),
        link({ href: "https://b.example-live.net/", status: 410 }),
        link({ href: "https://c.example-gone.net/", status: null, error: EXTERNAL_LINK_HOST_UNRESOLVED_ERROR }),
      ]),
      "broken-external-links",
    )!;
    expect(check.message).toBe("3 broken external link(s): 1 with 404, 1 with 410, 1 domain does not exist");
  });
});

describe("possibly broken warns, under its own check (#1739)", () => {
  test.each([
    ["a 503", link({ href: "https://down.example-live.net/", status: 503 })],
    ["a 500", link({ href: "https://err.example-live.net/", status: 500 })],
    ["another 4xx", link({ href: "https://teapot.example-live.net/", status: 418 })],
    ["a TLS error", link({ href: "https://tls.example-live.net/", status: null, error: "certificate has expired" })],
    ["a connection reset", link({ href: "https://reset.example-live.net/", status: null, error: "ECONNRESET" })],
  ])("%s warns and is not a failure", (_name, l) => {
    const checks = run([l]);
    expect(named(checks, "possibly-broken-external-links")?.status).toBe("warn");
    expect(named(checks, "broken-external-links")).toBeUndefined();
  });

  test("confirmed and possible are separate checks with their own names", () => {
    const checks = run([
      link({ href: "https://gone.example-live.net/", status: 404 }),
      link({ href: "https://down.example-live.net/", status: 503 }),
    ]);
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
  test("it warns under awaiting-confirmation-external-links and is not listed as blocked", () => {
    const checks = run([awaiting, link()]);
    const check = named(checks, "awaiting-confirmation-external-links")!;
    expect(check.status).toBe("warn");
    expect(check.message).toBe("1 external link(s) failed a first check and are likely broken, being confirmed");
    expect(check.items?.[0]?.label).toContain("failed once, being confirmed");
    expect(check.items?.[0]?.sourcePages).toEqual([`${BASE}/`, `${BASE}/about`]);
    expect(named(checks, "waf-blocked-external-links")).toBeUndefined();
    expect(named(checks, "broken-external-links")?.status).toBe("pass");
  });
  test("a wall beside it stays a blocked, informational link; once confirmed it is a 404 and fails", () => {
    const wall = link({ href: "https://wall.example-live.net/", status: 403, wafBlocked: true, wafProvider: "cloudflare" });
    const checks = run([awaiting, wall]);
    expect(named(checks, "waf-blocked-external-links")?.items?.map((i) => i.id)).toEqual(["https://wall.example-live.net/"]);
    const confirmed = run([{ ...awaiting, status: 404, wafBlocked: false, unverifiedReason: undefined }]);
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
  test("they inform; the rule has no failure and no warning", () => {
    const checks = run([...unverifiable, link()]);
    expect(checks.map((c) => `${c.name}:${c.status}`).sort()).toEqual([
      "broken-external-links:pass",
      "rate-limited-external-links:info",
      "waf-blocked-external-links:info",
    ]);
  });
});

