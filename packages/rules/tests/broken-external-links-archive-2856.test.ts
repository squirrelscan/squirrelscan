// repo#2856: a confirmed-broken external link carries its web-archive copy when a lookup found one.

import { describe, expect, test } from "bun:test";

import { EXTERNAL_LINK_HOST_UNRESOLVED_ERROR } from "@squirrelscan/core-contracts";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import type { CheckResult, ExternalLinkCheckData, ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";
const SNAP = "https://web.archive.org/web/20240101000000/https://gone.example.net/x";

const link = (over: Partial<ExternalLinkCheckData> = {}): ExternalLinkCheckData => ({
  href: "https://gone.example.net/x",
  status: 404,
  error: null,
  sourcePages: [`${BASE}/`],
  ...over,
});

const run = async (links: ExternalLinkCheckData[]): Promise<CheckResult[]> => {
  const ctx = {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null, externalLinks: links },
    options: {},
  } as unknown as RuleContext;
  return ((await brokenExternalLinksRule.run(ctx)) as { checks: CheckResult[] }).checks;
};
const item = async (l: ExternalLinkCheckData) =>
  (await run([l])).find((c) => c.name === "broken-external-links")?.items?.[0];

describe("web-archive suggestion (repo#2856)", () => {
  test("a confirmed 404 with a snapshot shows the snapshot URL", async () => {
    const i = await item(link({ archive: { url: SNAP, capturedAt: "2024-01-01T00:00:00Z" } }));
    expect(i?.label).toContain(`archived copy: ${SNAP}`);
    expect(i?.meta).toMatchObject({ archiveUrl: SNAP });
  });

  test("a confirmed link the archive had nothing for says so", async () => {
    const i = await item(link({ archive: null }));
    expect(i?.label).toContain("no archived copy found");
    expect(i?.meta).not.toHaveProperty("archiveUrl");
  });

  test("a link with no lookup shows no archive text", async () => {
    const i = await item(link());
    expect(i?.label).not.toContain("archive");
  });

  test("an archive URL that is not https web.archive.org is never shown", async () => {
    for (const url of ["http://web.archive.org/web/1/x", "https://evil.example/web/1/x", "not a url"]) {
      const i = await item(link({ archive: { url } }));
      expect(i?.label).not.toContain("archived copy");
      expect(i?.meta).not.toHaveProperty("archiveUrl");
    }
  });

  test("a possibly-broken link (503) gets no suggestion", async () => {
    const checks = await run([link({ status: 503, archive: { url: SNAP } })]);
    const c = checks.find((x) => x.name === "possibly-broken-external-links");
    expect(c?.items?.[0]?.label).not.toContain("archive");
  });

  test("a dead host with a snapshot shows it", async () => {
    const i = await item(link({ status: null, error: EXTERNAL_LINK_HOST_UNRESOLVED_ERROR, archive: { url: SNAP } }));
    expect(i?.label ?? "").toContain("archived copy");
  });

  test("solution text tells agents to swap only when a copy is named", () => {
    expect(brokenExternalLinksRule.meta.solution).toContain("do not replace a link that has no archived copy");
  });
});
