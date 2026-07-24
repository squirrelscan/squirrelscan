// integrity Phase 3 (#118) — differential cloaking probe. Unit-tests the pure
// selection + comparison helpers and the orchestration over an injected fetch
// stub (no network). The integrity/cloaking RULE is covered separately in
// packages/rules/tests/integrity-cloaking.test.ts.

import { describe, expect, test } from "bun:test";

import {
  appendProbeToken,
  classifyDivergence,
  jaccard,
  parseLastmod,
  probeSiteForCloaking,
  resolveCloakingProbes,
  runCloakingProbe,
  selectSuspiciousPaths,
  visibleTokens,
  type CloakingCandidate,
  type ProbeFetch,
  type ProbeResponse,
} from "../src/cloaking-probe";

const NOW = Date.parse("2026-06-28T00:00:00Z");
const SITE = "https://example.com";

// ── selection ───────────────────────────────────────────────────────

function candidate(over: Partial<CloakingCandidate>): CloakingCandidate {
  return {
    url: `${SITE}/a`,
    normalizedUrl: `${SITE}/a`,
    status: 200,
    lastmod: null,
    inboundCount: 5,
    inSitemap: true,
    ...over,
  };
}

describe("selectSuspiciousPaths", () => {
  test("flags orphan pages (no inbound + not in sitemap)", () => {
    const sel = selectSuspiciousPaths(
      [
        candidate({
          url: `${SITE}/hidden`,
          normalizedUrl: `${SITE}/hidden`,
          inboundCount: 0,
          inSitemap: false,
        }),
      ],
      { maxPages: 10, recentDays: 14, hasSitemap: true, now: NOW },
    );
    expect(sel).toEqual([{ url: `${SITE}/hidden`, reason: "orphan" }]);
  });

  test("flags recently-modified sitemap pages", () => {
    const recent = new Date(NOW - 2 * 86_400_000).toISOString();
    const sel = selectSuspiciousPaths(
      [candidate({ url: `${SITE}/fresh`, normalizedUrl: `${SITE}/fresh`, lastmod: recent })],
      { maxPages: 10, recentDays: 14, hasSitemap: true, now: NOW },
    );
    expect(sel).toEqual([{ url: `${SITE}/fresh`, reason: "recent-lastmod" }]);
  });

  test("ignores well-linked, old pages", () => {
    const old = new Date(NOW - 400 * 86_400_000).toISOString();
    const sel = selectSuspiciousPaths(
      [candidate({ lastmod: old, inboundCount: 9, inSitemap: true })],
      { maxPages: 10, recentDays: 14, hasSitemap: true, now: NOW },
    );
    expect(sel).toEqual([]);
  });

  test("ignores future lastmod dates", () => {
    const future = new Date(NOW + 5 * 86_400_000).toISOString();
    const sel = selectSuspiciousPaths([candidate({ lastmod: future })], {
      maxPages: 10,
      recentDays: 14,
      hasSitemap: true,
      now: NOW,
    });
    expect(sel).toEqual([]);
  });

  test("skips non-2xx pages", () => {
    const sel = selectSuspiciousPaths(
      [candidate({ status: 404, inboundCount: 0, inSitemap: false })],
      { maxPages: 10, recentDays: 14, hasSitemap: true, now: NOW },
    );
    expect(sel).toEqual([]);
  });

  test("orphans rank before recent, then capped at maxPages", () => {
    const recent = new Date(NOW - 1 * 86_400_000).toISOString();
    const sel = selectSuspiciousPaths(
      [
        candidate({ url: `${SITE}/r`, normalizedUrl: `${SITE}/r`, lastmod: recent }),
        candidate({
          url: `${SITE}/o`,
          normalizedUrl: `${SITE}/o`,
          inboundCount: 0,
          inSitemap: false,
        }),
      ],
      { maxPages: 1, recentDays: 14, hasSitemap: true, now: NOW },
    );
    expect(sel).toEqual([{ url: `${SITE}/o`, reason: "orphan" }]);
  });

  test("with no sitemap, orphan = zero inbound alone", () => {
    const sel = selectSuspiciousPaths(
      [
        candidate({
          url: `${SITE}/x`,
          normalizedUrl: `${SITE}/x`,
          inboundCount: 0,
          inSitemap: false,
        }),
      ],
      { maxPages: 10, recentDays: 14, hasSitemap: false, now: NOW },
    );
    expect(sel).toEqual([{ url: `${SITE}/x`, reason: "orphan" }]);
  });
});

describe("parseLastmod", () => {
  test("parses ISO + RFC dates, rejects junk", () => {
    expect(parseLastmod("2026-06-01")).toBe(Date.parse("2026-06-01"));
    expect(parseLastmod(null)).toBeNull();
    expect(parseLastmod("not-a-date")).toBeNull();
  });
});

// ── comparison ──────────────────────────────────────────────────────

describe("visibleTokens + jaccard", () => {
  test("strips markup/script/style", () => {
    const tokens = visibleTokens(
      "<html><head><style>.x{color:red}</style></head><body><script>var a=1</script><p>Hello World</p></body></html>",
    );
    expect(tokens.has("hello")).toBe(true);
    expect(tokens.has("world")).toBe(true);
    expect(tokens.has("color")).toBe(false); // inside <style>
    expect(tokens.has("var")).toBe(false); // inside <script>
  });

  test("jaccard: identical=1, disjoint=0", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

const resp = (status: number, body: string): ProbeResponse => ({ status, body });

describe("classifyDivergence", () => {
  test("identical 2xx bodies = not divergent", () => {
    const html = "<p>welcome to acme corp the leading widget vendor since 1999</p>";
    const out = classifyDivergence(resp(200, html), resp(200, html), 0.6);
    expect(out.divergent).toBe(false);
    expect(out.similarity).toBe(1);
  });

  test("2xx vs non-2xx flip = divergent", () => {
    const out = classifyDivergence(resp(403, ""), resp(200, "<p>hidden spam payload</p>"), 0.6);
    expect(out.divergent).toBe(true);
    expect(out.similarity).toBe(0);
  });

  test("both 2xx but wholly different content = divergent", () => {
    const a = resp(200, "<p>acme corp widgets and gadgets for industry</p>");
    const b = resp(200, "<p>buy cheap replica watches and luxury handbags online</p>");
    const out = classifyDivergence(a, b, 0.6);
    expect(out.divergent).toBe(true);
  });

  test("network error (status 0) is inconclusive, never divergent", () => {
    const out = classifyDivergence(resp(0, ""), resp(200, "<p>content</p>"), 0.6);
    expect(out.divergent).toBe(false);
  });

  test("both blocked (non-2xx) = not divergent", () => {
    const out = classifyDivergence(resp(404, ""), resp(404, ""), 0.6);
    expect(out.divergent).toBe(false);
  });
});

describe("appendProbeToken", () => {
  test("adds the probe param", () => {
    expect(appendProbeToken("https://example.com/p")).toBe(
      "https://example.com/p?ss_cloak_probe=1",
    );
    expect(appendProbeToken("https://example.com/p?x=1")).toContain("ss_cloak_probe=1");
  });
});

// ── orchestration ───────────────────────────────────────────────────

/** Fetch stub: keyed by `${url}::${ua}` → response. Missing key = 404. */
function stubFetch(table: Record<string, ProbeResponse>): ProbeFetch {
  return async (url, ua) => table[`${url}::${ua}`] ?? { status: 404, body: "" };
}

const GOOGLEBOT = "Googlebot";
const DEFAULT_UA = "Mozilla/Browser";

describe("runCloakingProbe", () => {
  test("detects UA cloaking (googlebot sees payload, visitor blocked)", async () => {
    const url = `${SITE}/p`;
    const fetchImpl = stubFetch({
      [`${url}::${DEFAULT_UA}`]: resp(403, ""),
      [`${url}::${GOOGLEBOT}`]: resp(200, "<p>injected casino spam doorway content here</p>"),
    });
    const [probe] = await runCloakingProbe(
      [{ url, reason: "orphan" }],
      {
        maxPages: 10,
        recentDays: 14,
        queryVariation: false,
        googlebotUserAgent: GOOGLEBOT,
        defaultUserAgent: DEFAULT_UA,
      },
      fetchImpl,
    );
    expect(probe.uaCloaking).toBe(true);
    expect(probe.defaultStatus).toBe(403);
    expect(probe.googlebotStatus).toBe(200);
    expect(probe.error).toBeNull();
  });

  test("identical content = no cloaking", async () => {
    const url = `${SITE}/p`;
    const html = "<p>this is the same honest page for everyone who visits it</p>";
    const fetchImpl = stubFetch({
      [`${url}::${DEFAULT_UA}`]: resp(200, html),
      [`${url}::${GOOGLEBOT}`]: resp(200, html),
    });
    const [probe] = await runCloakingProbe(
      [{ url, reason: "recent-lastmod" }],
      {
        maxPages: 10,
        recentDays: 14,
        queryVariation: false,
        googlebotUserAgent: GOOGLEBOT,
        defaultUserAgent: DEFAULT_UA,
      },
      fetchImpl,
    );
    expect(probe.uaCloaking).toBe(false);
    expect(probe.uaSimilarity).toBe(1);
  });

  test("detects token-gating via query variation", async () => {
    const url = `${SITE}/p`;
    const tokenUrl = appendProbeToken(url);
    const fetchImpl = stubFetch({
      [`${url}::${DEFAULT_UA}`]: resp(200, "<p>nothing to see here move along please</p>"),
      [`${url}::${GOOGLEBOT}`]: resp(200, "<p>nothing to see here move along please</p>"),
      [`${tokenUrl}::${DEFAULT_UA}`]: resp(
        200,
        "<p>secret phishing kit credential harvest form</p>",
      ),
    });
    const [probe] = await runCloakingProbe(
      [{ url, reason: "orphan" }],
      {
        maxPages: 10,
        recentDays: 14,
        queryVariation: true,
        googlebotUserAgent: GOOGLEBOT,
        defaultUserAgent: DEFAULT_UA,
      },
      fetchImpl,
    );
    expect(probe.uaCloaking).toBe(false);
    expect(probe.tokenGated).toBe(true);
    expect(probe.queryUrl).toBe(tokenUrl);
  });

  test("respects maxPages cap", async () => {
    const fetchImpl = stubFetch({});
    const probes = await runCloakingProbe(
      [
        { url: `${SITE}/1`, reason: "orphan" },
        { url: `${SITE}/2`, reason: "orphan" },
        { url: `${SITE}/3`, reason: "orphan" },
      ],
      {
        maxPages: 2,
        recentDays: 14,
        queryVariation: false,
        googlebotUserAgent: GOOGLEBOT,
        defaultUserAgent: DEFAULT_UA,
      },
      fetchImpl,
    );
    expect(probes).toHaveLength(2);
  });
});

describe("probeSiteForCloaking", () => {
  test("selects orphans from parsed pages + sitemap and probes them", async () => {
    const homepage = {
      url: `${SITE}/`,
      statusCode: 200,
      parsed: { links: [{ url: `${SITE}/about`, isInternal: true }] },
    };
    const about = {
      url: `${SITE}/about`,
      statusCode: 200,
      parsed: { links: [] },
    };
    const hidden = {
      url: `${SITE}/hidden-kit`,
      statusCode: 200,
      parsed: { links: [] },
    };
    const fetchImpl = stubFetch({
      [`${SITE}/hidden-kit::${DEFAULT_UA}`]: resp(403, ""),
      [`${SITE}/hidden-kit::${GOOGLEBOT}`]: resp(
        200,
        "<p>hidden injected payload visible only to googlebot</p>",
      ),
    });
    const probes = await probeSiteForCloaking(
      {
        baseUrl: SITE,
        pages: [homepage, about, hidden],
        sitemapUrls: [{ loc: `${SITE}/` }, { loc: `${SITE}/about` }],
      },
      {
        maxPages: 10,
        recentDays: 14,
        queryVariation: false,
        googlebotUserAgent: GOOGLEBOT,
        defaultUserAgent: DEFAULT_UA,
        now: NOW,
      },
      fetchImpl,
    );
    // /hidden-kit is orphan (no inbound, not in sitemap); /about is linked + in sitemap.
    expect(probes).toHaveLength(1);
    expect(probes[0]!.url).toBe(`${SITE}/hidden-kit`);
    expect(probes[0]!.uaCloaking).toBe(true);
  });

  test("never probes the homepage", async () => {
    const probes = await probeSiteForCloaking(
      {
        baseUrl: SITE,
        pages: [{ url: `${SITE}/`, statusCode: 200, parsed: { links: [] } }],
        sitemapUrls: [],
      },
      {
        maxPages: 10,
        recentDays: 14,
        queryVariation: false,
        googlebotUserAgent: GOOGLEBOT,
        defaultUserAgent: DEFAULT_UA,
        now: NOW,
      },
      stubFetch({}),
    );
    expect(probes).toEqual([]);
  });
});

describe("resolveCloakingProbes", () => {
  const site = {
    baseUrl: SITE,
    pages: [{ url: `${SITE}/x`, statusCode: 200, parsed: { links: [] } }],
    sitemapUrls: [],
  };
  const runtime = { defaultUserAgent: DEFAULT_UA };

  test("returns undefined when disabled (rule no-ops)", async () => {
    const out = await resolveCloakingProbes(
      {
        enabled: false,
        max_pages: 10,
        recent_days: 14,
        query_variation: true,
        googlebot_user_agent: GOOGLEBOT,
      },
      site,
      runtime,
      stubFetch({}),
    );
    expect(out).toBeUndefined();
  });

  test("returns undefined when config absent", async () => {
    const out = await resolveCloakingProbes(undefined, site, runtime, stubFetch({}));
    expect(out).toBeUndefined();
  });

  test("returns probe array when enabled", async () => {
    const out = await resolveCloakingProbes(
      {
        enabled: true,
        max_pages: 10,
        recent_days: 14,
        query_variation: false,
        googlebot_user_agent: GOOGLEBOT,
      },
      site,
      runtime,
      stubFetch({
        [`${SITE}/x::${DEFAULT_UA}`]: resp(
          200,
          "<p>same content here for all visitors of the site</p>",
        ),
        [`${SITE}/x::${GOOGLEBOT}`]: resp(
          200,
          "<p>same content here for all visitors of the site</p>",
        ),
      }),
    );
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
  });
});
