// security/sitemap-sensitive-urls (#2331): sensitive-looking sitemap entries,
// reported only when they answer.

import type { SitemapData } from "@squirrelscan/core-contracts";

import { afterEach, describe, expect, test } from "bun:test";

import {
  MAX_SENSITIVE_PROBES,
  buildProbeInit,
  selectSensitiveEntries,
  sensitiveWords,
  sitemapSensitiveUrlsRule,
} from "../src/security/sitemap-sensitive-urls";
import {
  BASE,
  html,
  robots,
  ruleCtx,
  stubFetch,
  type Route,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const SITEMAP = `${BASE}/sitemap.xml`;

function sitemap(locs: string[], url = SITEMAP): SitemapData {
  return {
    url,
    type: "urlset",
    urls: locs.map((loc) => ({ loc })),
    childSitemaps: [],
    errors: [],
    urlCount: locs.length,
  };
}

function ctxWith(
  locs: string[],
  opts: Parameters<typeof ruleCtx>[0] = {},
  extra: SitemapData[] = []
) {
  const ctx = ruleCtx(opts);
  ctx.site!.sitemaps = {
    discovered: [sitemap(locs), ...extra],
    sources: { robotsTxt: [], commonLocations: [] },
    totalUrls: locs.length,
    orphanPages: [],
    missingPages: [],
    failed: [],
    readState: "complete",
  };
  return ctx;
}

const ok =
  (body = "<h1>Admin console</h1>"): Route =>
  () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html" },
    });

describe("sensitiveWords", () => {
  test("matches whole decoded path segments only", () => {
    expect(sensitiveWords("/admin/users")).toEqual(["admin"]);
    expect(sensitiveWords("/Staging/admin/")).toEqual(["staging", "admin"]);
    expect(sensitiveWords("/%61dmin/")).toEqual(["admin"]);
    expect(sensitiveWords("/blog/draft-post-staging")).toEqual([]);
    expect(sensitiveWords("/admin-tools/")).toEqual([]);
    expect(sensitiveWords("/blog/admin.html")).toEqual([]);
    expect(sensitiveWords("/a%2Fadmin/")).toEqual([]);
    expect(sensitiveWords("/administration")).toEqual([]);
    expect(sensitiveWords("/blog/hello")).toEqual([]);
  });

  test("a sitemap of content slugs that contain a word is clean", async () => {
    const stub = stubFetch({});
    restore = stub.restore;
    const { checks } = await sitemapSensitiveUrlsRule.run(
      ctxWith([
        `${BASE}/blog/draft-post-staging`,
        `${BASE}/blog/how-to-backup-your-mac`,
      ])
    );
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
    expect(stub.sent).toHaveLength(0);
  });
});

describe("selection", () => {
  test("same origin only, deduped, with the sitemaps that name each URL", () => {
    const other = sitemap([`${BASE}/admin/`], `${BASE}/sitemap-2.xml`);
    const ctx = ctxWith(
      [`${BASE}/admin/`, "https://other.example.com/admin/", `${BASE}/about`],
      {},
      [other]
    );
    const sel = selectSensitiveEntries(ctx);
    expect(sel.entries.map((e) => e.url)).toEqual([`${BASE}/admin/`]);
    expect(sel.entries[0]!.sitemaps).toEqual([
      SITEMAP,
      `${BASE}/sitemap-2.xml`,
    ]);
  });

  test("caps probes", () => {
    const locs = Array.from(
      { length: MAX_SENSITIVE_PROBES + 3 },
      (_, i) => `${BASE}/admin/p${i}`
    );
    const sel = selectSensitiveEntries(ctxWith(locs));
    expect(sel.entries).toHaveLength(MAX_SENSITIVE_PROBES);
    expect(sel.skippedCap).toBe(3);
  });
});

describe("run", () => {
  test("reports a reachable entry with its sitemap, and not a 404", async () => {
    const stub = stubFetch({
      [`${BASE}/admin/`]: ok(),
      [`${BASE}/staging/`]: () => html(),
    });
    restore = stub.restore;
    const ctx = ctxWith([`${BASE}/admin/`, `${BASE}/staging/`, `${BASE}/`]);
    const { checks } = await sitemapSensitiveUrlsRule.run(ctx);
    const fail = checks.find((c) => c.status === "fail")!;
    expect(fail.items!.map((i) => i.id)).toEqual([`${BASE}/admin/`]);
    expect(fail.items![0]!.meta).toMatchObject({
      sitemaps: [SITEMAP],
      status: 200,
    });
  });

  test("a redirect, 401 and 403 are not reported", async () => {
    const stub = stubFetch({
      [`${BASE}/admin/`]: () =>
        new Response(null, {
          status: 302,
          headers: { location: `${BASE}/login` },
        }),
      [`${BASE}/internal/`]: () => new Response("no", { status: 401 }),
      [`${BASE}/backup/`]: () => new Response("no", { status: 403 }),
    });
    restore = stub.restore;
    const { checks } = await sitemapSensitiveUrlsRule.run(
      ctxWith([`${BASE}/admin/`, `${BASE}/internal/`, `${BASE}/backup/`])
    );
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("a catch-all 200 page is not reported", async () => {
    const stub = stubFetch({});
    restore = stub.restore;
    globalThis.fetch = (async () =>
      new Response("<div id=app></div>", {
        status: 200,
      })) as unknown as typeof fetch;
    const { checks } = await sitemapSensitiveUrlsRule.run(
      ctxWith([`${BASE}/admin/`])
    );
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  test("sends credential-free GETs to the audited origin only", async () => {
    const stub = stubFetch({ [`${BASE}/admin/`]: ok() });
    restore = stub.restore;
    await sitemapSensitiveUrlsRule.run(
      ctxWith([`${BASE}/admin/`, "https://other.example.com/admin/"])
    );
    expect(stub.sent.length).toBe(2); // canary + one entry
    for (const r of stub.sent) {
      expect(new URL(r.url).origin).toBe(BASE);
      expect(r.method).toBe("GET");
      expect(r.credentials).toBe(buildProbeInit().credentials);
      expect(r.redirect).toBe("manual");
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
  });

  test("passive sends nothing and is skipped; no sensitive entry passes", async () => {
    const stub = stubFetch({ [`${BASE}/admin/`]: ok() });
    restore = stub.restore;
    const passive = await sitemapSensitiveUrlsRule.run(
      ctxWith([`${BASE}/admin/`], { level: "passive" })
    );
    expect(passive.checks[0]).toMatchObject({
      status: "skipped",
      skipReason: "probing-passive",
    });
    const none = await sitemapSensitiveUrlsRule.run(
      ctxWith([`${BASE}/about`], { noProbe: true })
    );
    expect(none.checks[0]!.status).toBe("pass");
    expect(stub.sent).toHaveLength(0);
  });

  test("an exhausted budget sends nothing", async () => {
    const stub = stubFetch({ [`${BASE}/admin/`]: ok() });
    restore = stub.restore;
    const { checks } = await sitemapSensitiveUrlsRule.run(
      ctxWith([`${BASE}/admin/`], { budgetMs: 0 })
    );
    expect(stub.sent).toHaveLength(0);
    expect(checks[0]!.status).toBe("skipped");
  });

  test("robots-disallowed entries are not requested below aggressive", async () => {
    const stub = stubFetch({ [`${BASE}/admin/`]: ok() });
    restore = stub.restore;
    const { checks } = await sitemapSensitiveUrlsRule.run(
      ctxWith([`${BASE}/admin/`], { robotsTxt: robots(["/admin"]) })
    );
    expect(stub.sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ skipReason: "robots-disallowed" });
  });

  test("no sitemap is skipped", async () => {
    const { checks } = await sitemapSensitiveUrlsRule.run(ruleCtx({}));
    expect(checks[0]).toMatchObject({ status: "skipped" });
  });
});
