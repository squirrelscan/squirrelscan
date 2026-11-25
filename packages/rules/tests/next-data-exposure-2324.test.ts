// security/next-data-exposure (repo#2324): reads the buildId from a crawled
// page's __NEXT_DATA__, requests its /_next/data file and judges pageProps.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";
import { afterEach, describe, expect, test } from "bun:test";

import type { CollectedPageSignal } from "../src/collected-signals";
import type { RuleContext } from "../src/types";

import { buildCollectedPageSignal } from "../src/collected-signals";
import {
  MAX_NEXT_DATA_PAGES,
  nextDataExposureRule,
  nextDataPath,
  selectNextDataCandidates,
} from "../src/security/next-data-exposure";
import {
  BASE,
  json,
  robots,
  html,
  ruleCtx,
  stubFetch,
  type Route,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const BUILD = "abc123XYZ_-9";
const BCRYPT = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";

function nextPage(path: string, next?: Record<string, unknown>, origin = BASE) {
  const url = `${origin}${path}`;
  const data = JSON.stringify({
    buildId: BUILD,
    page: path,
    ...(next ?? { gssp: true }),
  });
  const html = `<!doctype html><html><head><title>t</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${data}</script></body></html>`;
  return {
    url,
    statusCode: 200,
    parsed: parsePage(html, url),
  } as NonNullable<RuleContext["site"]>["pages"][number];
}

function ctxFor(
  pages: ReturnType<typeof nextPage>[],
  opts: Parameters<typeof ruleCtx>[0] = {}
): RuleContext {
  const ctx = ruleCtx(opts);
  ctx.site = { ...ctx.site!, pages };
  return ctx;
}

const dataUrl = (path: string) => `${BASE}${nextDataPath(path, BUILD)}`;

async function run(
  routes: Record<string, Route>,
  pages: ReturnType<typeof nextPage>[],
  opts: Parameters<typeof ruleCtx>[0] = {}
) {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const result = await nextDataExposureRule.run(ctxFor(pages, opts));
  return { checks: result.checks, sent: stub.sent };
}

describe("candidate selection", () => {
  test("maps page paths to data files", () => {
    expect(nextDataPath("/", BUILD)).toBe(`/_next/data/${BUILD}/index.json`);
    expect(nextDataPath("/blog/post/", BUILD)).toBe(
      `/_next/data/${BUILD}/blog/post.json`
    );
  });

  test("an i18n page's data file sits under its locale", () => {
    // Default locale: the page URL has no prefix, the data file has one.
    expect(nextDataPath("/about", BUILD, "en")).toBe(
      `/_next/data/${BUILD}/en/about.json`
    );
    expect(nextDataPath("/", BUILD, "en")).toBe(`/_next/data/${BUILD}/en.json`);
    // Other locales: the URL prefix is not doubled.
    expect(nextDataPath("/fr/about/", BUILD, "fr")).toBe(
      `/_next/data/${BUILD}/fr/about.json`
    );
    expect(nextDataPath("/fr", BUILD, "fr")).toBe(
      `/_next/data/${BUILD}/fr.json`
    );
    // A path that only starts with the same letters keeps them.
    expect(nextDataPath("/french", BUILD, "fr")).toBe(
      `/_next/data/${BUILD}/fr/french.json`
    );
  });

  test("the locale in __NEXT_DATA__ is used, and an unsafe one is not requested", () => {
    const sel = selectNextDataCandidates(
      ctxFor([
        nextPage("/fr/a", { gssp: true, locale: "fr" }),
        nextPage("/b", { gssp: true, locale: "en-US" }),
        nextPage("/c", { gssp: true, locale: "../x" }),
      ])
    );
    expect(sel.candidates.map((c) => c.url)).toEqual([
      `${BASE}/_next/data/${BUILD}/fr/a.json`,
      `${BASE}/_next/data/${BUILD}/en-US/b.json`,
    ]);
  });

  test("only server-rendered pages with a safe buildId are requested", () => {
    const sel = selectNextDataCandidates(
      ctxFor([
        nextPage("/ssr", { gssp: true }),
        nextPage("/ssg", { gsp: true }),
        nextPage("/static", { autoExport: true }),
        nextPage("/evil", { gssp: true, buildId: "../../x" }),
      ])
    );
    expect(sel.candidates.map((c) => c.url)).toEqual([
      dataUrl("/ssr"),
      dataUrl("/ssg"),
    ]);
  });

  test("other origins are never requested", () => {
    const sel = selectNextDataCandidates(
      ctxFor([nextPage("/a", { gssp: true }, "https://other.example.org")])
    );
    expect(sel.candidates).toEqual([]);
  });

  test("caps the pages requested", () => {
    const pages = Array.from({ length: MAX_NEXT_DATA_PAGES + 3 }, (_, i) =>
      nextPage(`/p${i}`)
    );
    const sel = selectNextDataCandidates(ctxFor(pages));
    expect(sel.candidates).toHaveLength(MAX_NEXT_DATA_PAGES);
    expect(sel.skippedCap).toBe(3);
  });

  test("robots-disallowed data files are skipped unless aggressive", () => {
    const disallow = robots(["/_next/data/"]);
    const pages = [nextPage("/a")];
    expect(
      selectNextDataCandidates(ctxFor(pages, { robotsTxt: disallow }))
        .skippedRobots
    ).toBe(1);
    expect(
      selectNextDataCandidates(
        ctxFor(pages, { robotsTxt: disallow, level: "aggressive" })
      ).candidates
    ).toHaveLength(1);
  });
});

describe("streaming engine: the DOM is gone by the site pass", () => {
  // The streaming engine nulls `parsed.document` before site rules run, so the
  // __NEXT_DATA__ read must come from the page-time collected signal.
  function detachedWithSignal(path: string) {
    const live = nextPage(path);
    const signal = buildCollectedPageSignal({
      url: live.url,
      parsed: live.parsed,
    });
    const detached = {
      ...live,
      parsed: { ...live.parsed, document: null },
    } as unknown as typeof live;
    return { page: detached, signal };
  }

  test("the collector records the buildId of a server-rendered page", () => {
    const { signal } = detachedWithSignal("/account");
    expect(signal.nextData).toEqual({ buildId: BUILD, locale: null });
    const auto = nextPage("/static", { nextExport: true });
    expect(
      buildCollectedPageSignal({ url: auto.url, parsed: auto.parsed }).nextData
    ).toBeNull();
  });

  test("a detached page is selected through ctx.collectedSignals", () => {
    const { page, signal } = detachedWithSignal("/account");
    const ctx = ctxFor([page]);
    expect(selectNextDataCandidates(ctx).candidates).toEqual([]);
    ctx.collectedSignals = { pages: [signal as CollectedPageSignal] };
    expect(selectNextDataCandidates(ctx).candidates).toEqual([
      { page: page.url, url: dataUrl("/account"), buildId: BUILD },
    ]);
  });

  test("a collected null wins over the page's document", () => {
    const page = nextPage("/account");
    const ctx = ctxFor([page]);
    ctx.collectedSignals = {
      pages: [{ url: page.url, nextData: null } as CollectedPageSignal],
    };
    expect(selectNextDataCandidates(ctx).nextPages).toBe(0);
  });
});

describe("run", () => {
  test("passive or absent probe sends nothing", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run({}, [nextPage("/a")], opts);
      expect(sent).toHaveLength(0);
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.skipReason).toBe("probing-passive");
    }
  });

  test("no Next.js page is not checked", async () => {
    const { checks, sent } = await run({}, []);
    expect(sent).toHaveLength(0);
    expect(checks[0]?.skipReason).toBe("no-next-data");
  });

  test("a token and a password hash in pageProps fail, values redacted", async () => {
    const { checks, sent } = await run(
      {
        [dataUrl("/account")]: () =>
          json({
            pageProps: {
              title: "Account",
              user: {
                name: "Ann",
                passwordHash: BCRYPT,
                accessToken: "tok_live_aaaaaaaaaaaaaaaaaaaaaaaa",
              },
            },
            __N_SSP: true,
          }),
      },
      [nextPage("/account")]
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.credentials).toBe("omit");
    expect(sent[0]!.redirect).toBe("manual");
    const fail = checks.find((c) => c.status === "fail");
    expect(fail?.name).toBe("next-data-sensitive-fields");
    expect(
      fail?.items?.some((i) => String(i.meta?.path).startsWith("pageProps"))
    ).toBe(true);
    expect(JSON.stringify(checks)).not.toContain(BCRYPT);
  });

  test("bulk personal data warns", async () => {
    const people = Array.from({ length: 8 }, (_, i) => ({
      name: `P${i}`,
      email: `p${i}@example.org`,
    }));
    const { checks } = await run(
      { [dataUrl("/team")]: () => json({ pageProps: { people } }) },
      [nextPage("/team")]
    );
    expect(
      checks.some((c) => c.name === "next-data-bulk-pii" && c.status === "warn")
    ).toBe(true);
  });

  test("ordinary public props pass", async () => {
    const { checks } = await run(
      {
        [dataUrl("/")]: () =>
          json({
            pageProps: {
              title: "Home",
              posts: [
                { slug: "hello", excerpt: "Hi", contact: "hello@example.org" },
              ],
            },
          }),
      },
      [nextPage("/")]
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("sensitive data outside pageProps is not judged", async () => {
    const { checks } = await run(
      {
        [dataUrl("/a")]: () =>
          json({ pageProps: { title: "x" }, meta: { passwordHash: BCRYPT } }),
      },
      [nextPage("/a")]
    );
    expect(checks[0]?.status).toBe("pass");
  });

  test("a 404 (stale buildId) is not checked", async () => {
    const { checks, sent } = await run({}, [nextPage("/a")]);
    expect(sent).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.value).toBe("not-checked");
  });

  test("a redirect or an HTML page is not checked", async () => {
    for (const reply of [
      () =>
        new Response(null, {
          status: 307,
          headers: { location: `${BASE}/login` },
        }),
      () => html("<!doctype html><title>Home</title>", 200),
    ]) {
      const { checks } = await run({ [dataUrl("/a")]: reply }, [
        nextPage("/a"),
      ]);
      expect(checks).toHaveLength(1);
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.value).toBe("not-checked");
      restore?.();
      restore = undefined;
    }
  });

  test("one JSON file and one 404 is not a pass", async () => {
    const { checks } = await run(
      { [dataUrl("/a")]: () => json({ pageProps: { title: "x" } }) },
      [nextPage("/a"), nextPage("/b")]
    );
    expect(checks.some((c) => c.status === "pass")).toBe(false);
    expect(checks[0]?.value).toBe("not-checked");
  });

  test("a 5xx leaves the run not checked", async () => {
    const { checks } = await run(
      { [dataUrl("/a")]: () => new Response("x", { status: 503 }) },
      [nextPage("/a")]
    );
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.value).toBe("not-checked");
  });

  test("a 429 stops further requests", async () => {
    const { checks, sent } = await run(
      { [dataUrl("/a")]: () => new Response("slow", { status: 429 }) },
      [nextPage("/a"), nextPage("/b")]
    );
    expect(sent).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("an exhausted budget sends nothing and is not checked", async () => {
    const { checks, sent } = await run({}, [nextPage("/a")], { budgetMs: 0 });
    expect(sent).toHaveLength(0);
    expect(checks[0]?.skipReason).toBe("probe-budget");
  });

  test("data files left out by the cap are not checked, never a pass", async () => {
    const pages = Array.from({ length: MAX_NEXT_DATA_PAGES + 2 }, (_, i) =>
      nextPage(`/p${i}`)
    );
    const routes = Object.fromEntries(
      pages.map((_, i) => [
        dataUrl(`/p${i}`),
        () => json({ pageProps: { title: `P${i}` } }),
      ])
    );
    const { checks, sent } = await run(routes, pages);
    expect(sent).toHaveLength(MAX_NEXT_DATA_PAGES);
    expect(checks.some((c) => c.status === "pass")).toBe(false);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
    });
    expect(checks[0]?.details).toMatchObject({ skippedCap: 2, unverified: 2 });
  });

  test("a robots-disallowed data file beside a clean one is not a pass", async () => {
    const { checks, sent } = await run(
      {
        [dataUrl("/a")]: () => json({ pageProps: { title: "A" } }),
      },
      [nextPage("/a"), nextPage("/private/b")],
      { robotsTxt: robots(["/_next/data/" + BUILD + "/private/"]) }
    );
    expect(sent).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
    });
  });

  test("every data file robots-disallowed is not checked, not 'no Next.js page'", async () => {
    const { checks, sent } = await run({}, [nextPage("/a")], {
      robotsTxt: robots(["/_next/data/"]),
    });
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
    });
  });

  test("robots.txt is read as the crawl's robots group", () => {
    const disallow = robots(["/_next/data/"]);
    disallow.rules = [{ ...disallow.rules[0]!, userAgent: "SquirrelScan" }];
    const ctx = ctxFor([nextPage("/a")], { robotsTxt: disallow });
    expect(selectNextDataCandidates(ctx).skippedRobots).toBe(0);
    ctx.site = { ...ctx.site!, robotsUserAgent: "SquirrelScan" };
    expect(selectNextDataCandidates(ctx).skippedRobots).toBe(1);
  });
});
