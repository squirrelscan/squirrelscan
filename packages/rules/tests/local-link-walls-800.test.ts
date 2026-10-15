// pub#800: an unverifiable external link (`wafBlocked`) is never broken,
// whatever status it answered with: a wall's 401/403/405/406/999 or 503
// challenge, or a timeout with no status at all. It is listed under the
// unverifiable row instead. Both link rules that count dead links agree.

import { describe, expect, test } from "bun:test";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import { deadLinksRule } from "../src/links/dead-links";
import type { ExternalLinkCheckData, ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";

function externalCtx(externalLinks: ExternalLinkCheckData[]): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null, externalLinks },
    options: {},
  } as unknown as RuleContext;
}

const link = (over: Partial<ExternalLinkCheckData> = {}): ExternalLinkCheckData => ({
  href: "https://other.example/",
  status: 200,
  error: null,
  sourcePages: [`${BASE}/`],
  ...over,
});

const walled = [401, 403, 405, 406, 999, 503].map((status) =>
  link({ href: `https://walled.example/${status}`, status, wafBlocked: true, wafProvider: "unknown" }),
);
const timedOut = link({ href: "https://stalls.example/", status: null, wafBlocked: true, wafProvider: "unknown" });
const dead = link({ href: "https://gone.example/", status: 404 });

describe("unverifiable links are never broken (pub#800)", () => {
  test("broken-external-links lists them as unverifiable and counts only the 404", () => {
    const { checks } = brokenExternalLinksRule.run(externalCtx([...walled, timedOut, dead]));
    const broken = checks.find((c) => c.name === "broken-external-links")!;
    expect(broken.status).toBe("warn");
    expect(broken.items?.map((i) => i.id)).toEqual(["https://gone.example/"]);
    const unverified = checks.find((c) => c.name === "waf-blocked-external-links")!;
    expect(unverified.items?.map((i) => i.id).sort()).toEqual(
      [...walled.map((l) => l.href), timedOut.href].sort(),
    );
  });

  test("with nothing else, walled links leave the check passing", () => {
    const { checks } = brokenExternalLinksRule.run(externalCtx([...walled, link()]));
    expect(checks.find((c) => c.name === "broken-external-links")!.status).toBe("pass");
  });

  test("dead-links counts the same one dead link", () => {
    const { checks } = deadLinksRule.run(externalCtx([...walled, timedOut, dead]));
    expect(checks[0]!.value).toBe(1);
  });
});
