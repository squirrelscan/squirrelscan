// #1740: a link to a host that does not resolve is reported as broken (never as "not requested"), the main
// check never says all links work while some were unverified or never requested, and a refused address stays
// informational under a message that no longer mentions DNS.

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

describe("a dead host is reported as broken, not as refused (#1740)", () => {
  test("a reserved suffix (.invalid) is a broken link with 'no such domain suffix', not under refused-external-links", () => {
    const checks = run([
      link({ href: "https://nut-supplier.invalid/", status: null, error: EXTERNAL_LINK_INVALID_SUFFIX_ERROR }),
    ]);
    const check = named(checks, "broken-external-links")!;
    expect(check.message).toBe("1 broken external link(s): 1 no such domain suffix");
    expect(check.items?.[0]?.label).toContain("no such domain suffix");
    expect(named(checks, "refused-external-links")).toBeUndefined();
    expect(named(checks, "not-requested-external-links")).toBeUndefined();
  });

  test("a non-resolving name on a real TLD is still broken with 'domain does not exist' (today's behaviour)", () => {
    const checks = run([
      link({ href: "https://gone.nutshop-fault.example-live.net/", status: null, error: EXTERNAL_LINK_HOST_UNRESOLVED_ERROR }),
    ]);
    expect(named(checks, "broken-external-links")!.message).toBe("1 broken external link(s): 1 domain does not exist");
    expect(named(checks, "refused-external-links")).toBeUndefined();
  });

  test("the solution says a lapsed domain can be registered by someone else", () => {
    expect(brokenExternalLinksRule.meta.solution).toContain("lapsed domain can be registered by someone else");
  });
});

describe("the main check never says all links work when some are not verified (#1740)", () => {
  test("all verified: 'All N external link(s) are working'", () => {
    const check = named(run([link(), link({ href: "https://b.example-live.net/" })]), "broken-external-links")!;
    expect(check.status).toBe("pass");
    expect(check.message).toBe("All 2 external link(s) are working");
  });

  test("some unverified, rate limited or never requested: how many were verified out of how many were found", () => {
    const check = named(
      run(
        [
          link(),
          link({ href: "https://wall.example-live.net/", status: 403, wafBlocked: true }),
          link({ href: "https://throttled.example-live.net/", status: 429 }),
        ],
        { found: 5, checked: 3, cap: 200, refused: 1, refusedLinks: [{ href: "http://10.0.0.1/", sourcePages: [`${BASE}/`] }], notRequested: 1 },
      ),
      "broken-external-links",
    )!;
    expect(check.status).toBe("pass");
    expect(check.message).toBe("1 of 5 external link(s) verified working; 4 could not be verified or were not checked");
    expect(check.message).not.toContain("All ");
  });
});

describe("refused addresses stay informational, and the message no longer mentions DNS (#1740)", () => {
  test("private, loopback, link-local and metadata addresses are listed as not requested, never broken", () => {
    const checks = run([link()], {
      found: 2,
      checked: 1,
      cap: 200,
      refused: 1,
      refusedByUrl: 1,
      refusedLinks: [{ href: "http://192.168.1.1/admin", sourcePages: [`${BASE}/`] }],
    });
    const refused = named(checks, "refused-external-links")!;
    expect(refused.status).toBe("info");
    expect(refused.message).not.toMatch(/DNS|resolve/i);
    expect(refused.message).toContain("private, loopback, link-local or cloud metadata address");
    expect(named(checks, "broken-external-links")?.status).toBe("pass");
  });
});
