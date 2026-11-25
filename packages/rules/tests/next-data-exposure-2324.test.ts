// security/next-data-exposure (repo#2324): reads the buildId from a crawled
// page's __NEXT_DATA__, requests its /_next/data file and judges pageProps.

import { parsePage } from "@squirrelscan/parser";
import { afterEach, describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

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

  test("a 404 (stale buildId) is answered and clean", async () => {
    const { checks } = await run({}, [nextPage("/a")]);
    expect(checks[0]?.status).toBe("pass");
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
});
