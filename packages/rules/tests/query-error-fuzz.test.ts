// security/query-error-fuzz (repo#2335): changes one query value at a time to a
// fixed token list. Runs against a local HTTP server that logs every request,
// so "GET only", "one value changed" and the request cap are observed on the wire.

import type { LinkData } from "@squirrelscan/core-contracts";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext, SiteData } from "../src/types";

import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import {
  buildFuzzProbe,
  findErrorSignature,
  FUZZ_TOKENS,
  MAX_FUZZ_PARAMS,
  MAX_FUZZ_REQUESTS,
  queryErrorFuzzRule,
  selectFuzzCandidates,
} from "../src/security/query-error-fuzz";
import { clearRequestAsync, setRequestAsync } from "../src/tools";

interface Hit {
  method: string;
  path: string;
  search: string;
  params: URLSearchParams;
}

let server: ReturnType<typeof Bun.serve>;
let BASE = "";
const hits: Hit[] = [];

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html" } });

beforeAll(() => {
  setRequestAsync(fetch);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push({
        method: req.method,
        path: u.pathname,
        search: u.search,
        params: u.searchParams,
      });
      const id = u.searchParams.get("id") ?? "";
      switch (u.pathname) {
        // Leaks a MySQL error on a quote.
        case "/product":
          return id.includes("'")
            ? html(
                "You have an error in your SQL syntax; check the manual",
                500
              )
            : html("<p>product</p>");
        // Rejects bad input with a clean 400.
        case "/clean400":
          return /^\d+$/.test(id)
            ? html("<p>ok</p>")
            : html("<p>Bad request</p>", 400);
        case "/clean404":
          return html("<p>Not found</p>", 404);
        // Always shows a PHP warning, baseline included.
        case "/noisy":
          return html(
            "<b>Warning</b>: Undefined variable $x in /var/www/a.php on line <b>3</b>"
          );
        // Leaks only on the large number.
        case "/laravel":
          return id === "99999999999999999999"
            ? html("Whoops, looks like something went wrong.", 500)
            : html("<p>ok</p>");
        case "/limited":
          return id.includes('"')
            ? new Response("slow down", { status: 429 })
            : html("<p>ok</p>");
        case "/logout":
          return html("You have an error in your SQL syntax", 500);
        default:
          return html("<p>ok</p>");
      }
    },
  });
  BASE = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  clearRequestAsync();
  server.stop(true);
});

const link = (path: string): LinkData => ({
  url: `${BASE}${path}`,
  text: "link",
  isInternal: true,
});

function page(path: string, links: LinkData[] = []): SiteData["pages"][number] {
  return {
    url: `${BASE}${path}`,
    statusCode: 200,
    parsed: { links } as unknown as SiteData["pages"][number]["parsed"],
  };
}

function ctxFor(opts: {
  pages: SiteData["pages"];
  level?: ProbeLevel;
  noProbe?: boolean;
  budgetMs?: number;
}): RuleContext {
  return {
    page: {
      url: `${BASE}/`,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as RuleContext["parsed"],
    site: {
      baseUrl: `${BASE}/`,
      pages: opts.pages,
      robotsTxt: null,
      sitemaps: null,
    },
    probe: opts.noProbe
      ? undefined
      : createProbeBudget({
          level: opts.level ?? "aggressive",
          budgetMs: opts.budgetMs ?? 60_000,
        }),
    options: {},
  };
}

async function run(
  ctx: RuleContext
): Promise<{ checks: CheckResult[]; sent: Hit[] }> {
  hits.length = 0;
  const { checks } = await queryErrorFuzzRule.run(ctx);
  return { checks, sent: [...hits] };
}

const warns = (checks: CheckResult[]) =>
  checks.filter((c) => c.status === "warn");

describe("security/query-error-fuzz", () => {
  test("a database error shown only for a token is flagged with the param and the token", async () => {
    const { checks, sent } = await run(
      ctxFor({ pages: [page("/", [link("/product?id=5")])] })
    );
    const w = warns(checks);
    expect(w).toHaveLength(1);
    expect(w[0]!.items?.[0]?.meta).toMatchObject({
      page: `${BASE}/product`,
      param: "id",
      token: FUZZ_TOKENS[0]!.id,
      signature: "mysql-syntax",
      kind: "database",
      status: 500,
    });
    // Baseline, then the quote token; the parameter stops at its first finding.
    expect(sent.map((h) => h.params.get("id"))).toEqual(["5", "'"]);
  });

  test("a clean 400 or 404 is not flagged", async () => {
    const { checks } = await run(
      ctxFor({
        pages: [page("/", [link("/clean400?id=5"), link("/clean404?id=5")])],
      })
    );
    expect(warns(checks)).toHaveLength(0);
    expect(checks.at(-1)?.status).toBe("pass");
  });

  test("an error already in the unmodified response is not attributed to a token", async () => {
    const { checks } = await run(
      ctxFor({ pages: [page("/", [link("/noisy?id=5")])] })
    );
    expect(warns(checks)).toHaveLength(0);
  });

  test("every token is tried in order, one value changed per request", async () => {
    const { checks, sent } = await run(
      ctxFor({ pages: [page("/", [link("/laravel?id=5&keep=a")])] })
    );
    expect(warns(checks)).toHaveLength(1);
    // Baseline, `id` tokens up to the one that triggers (the large number, fifth),
    // then all six on `keep` with `id` left alone.
    const idTokens = FUZZ_TOKENS.slice(0, 5);
    expect(sent).toHaveLength(1 + idTokens.length + FUZZ_TOKENS.length);
    expect(
      sent.slice(1, 1 + idTokens.length).map((h) => h.params.get("id"))
    ).toEqual(idTokens.map((t) => t.value));
    expect(
      sent
        .slice(1, 1 + idTokens.length)
        .every((h) => h.params.get("keep") === "a")
    ).toBe(true);
    expect(
      sent.slice(1 + idTokens.length).every((h) => h.params.get("id") === "5")
    ).toBe(true);
    // The NUL token goes out percent-encoded.
    expect(sent.some((h) => h.search.includes("id=%00"))).toBe(true);
  });

  test("no request is anything but a GET", async () => {
    const { sent } = await run(
      ctxFor({
        pages: [page("/", [link("/product?id=5"), link("/laravel?id=5")])],
      })
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((h) => h.method === "GET")).toBe(true);
  });

  test("the token set is frozen and buildFuzzProbe accepts only an index into it", () => {
    expect(Object.isFrozen(FUZZ_TOKENS)).toBe(true);
    expect(Object.isFrozen(FUZZ_TOKENS[0])).toBe(true);
    expect(FUZZ_TOKENS.map((t) => t.value)).toEqual([
      "'",
      '"',
      "\u0000",
      "[]",
      "99999999999999999999",
      "-1",
    ]);
    const c = { url: `${BASE}/p?id=1`, param: "id" };
    expect(() => buildFuzzProbe(c, FUZZ_TOKENS.length)).toThrow(RangeError);
    expect(() => buildFuzzProbe(c, -1)).toThrow(RangeError);
    const { url, init } = buildFuzzProbe(c, 5);
    expect(url).toBe(`${BASE}/p?id=-1`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(buildFuzzProbe(c, null).url).toBe(`${BASE}/p?id=1`);
  });

  test("probing below aggressive, or with no budget, sends nothing", async () => {
    for (const ctx of [
      ctxFor({ pages: [page("/product?id=5")], level: "passive" }),
      ctxFor({ pages: [page("/product?id=5")], level: "active" }),
      ctxFor({ pages: [page("/product?id=5")], noProbe: true }),
      ctxFor({ pages: [page("/product?id=5")], budgetMs: 0 }),
    ]) {
      const { checks, sent } = await run(ctx);
      expect(sent).toHaveLength(0);
      expect(checks.every((c) => c.status === "skipped")).toBe(true);
    }
  });

  test("without a request tool (analyze) nothing is sent", async () => {
    clearRequestAsync();
    try {
      const { checks, sent } = await run(
        ctxFor({ pages: [page("/product?id=5")] })
      );
      expect(sent).toHaveLength(0);
      expect(checks[0]?.skipReason).toBe("analyze-offline");
    } finally {
      setRequestAsync(fetch);
    }
  });

  test("state-changing paths, other origins and a cap on parameters", async () => {
    const many = Array.from({ length: MAX_FUZZ_PARAMS + 4 }, (_, i) =>
      link(`/p${String.fromCharCode(97 + i)}?id=1`)
    );
    const { sent } = await run(
      ctxFor({
        pages: [
          page("/", [
            link("/logout?id=1"),
            { url: "https://example.com/x?id=1", text: "x", isInternal: true },
            ...many,
          ]),
        ],
      })
    );
    expect(sent.some((h) => h.path === "/logout")).toBe(false);
    expect(sent.length).toBeLessThanOrEqual(MAX_FUZZ_REQUESTS);
    const mixed = selectFuzzCandidates(
      ctxFor({
        pages: [
          page("/", [
            link("/logout?id=1"),
            { url: "https://example.com/x?id=1", text: "x", isInternal: true },
            link("/product?id=5"),
          ]),
        ],
      })
    );
    expect(mixed.candidates.map((c) => c.page)).toEqual([`${BASE}/product`]);
    expect(mixed.skippedStateChanging).toBe(1);
    expect(
      selectFuzzCandidates(ctxFor({ pages: [page("/", many)] })).candidates
    ).toHaveLength(MAX_FUZZ_PARAMS);
  });

  test("action and one-time links are never replayed", async () => {
    const actions = [
      "/item?action=delete&id=5",
      `/verify?token=${"a1".repeat(16)}`,
      "/news?unsubscribe=1",
      "/cart?add=12",
    ];
    const { sent } = await run(
      ctxFor({
        pages: [page("/", [...actions.map(link), link("/product?id=5")])],
      })
    );
    // The plain link alongside is still probed, so the run did send.
    expect(sent.some((h) => h.path === "/product")).toBe(true);
    for (const path of ["/item", "/verify", "/news", "/cart"]) {
      expect(sent.some((h) => h.path === path)).toBe(false);
    }
    const selection = selectFuzzCandidates(
      ctxFor({ pages: [page("/", actions.map(link))] })
    );
    expect(selection.candidates).toHaveLength(0);
    // One per (page, parameter): `/item` carries two.
    expect(selection.skippedStateChanging).toBe(5);
  });

  test("the worst case stays inside the hard cap", () => {
    expect(MAX_FUZZ_PARAMS * (1 + FUZZ_TOKENS.length)).toBeLessThanOrEqual(
      MAX_FUZZ_REQUESTS
    );
  });

  test("a 429 stops the run as incomplete", async () => {
    const { checks, sent } = await run(
      ctxFor({ pages: [page("/", [link("/limited?id=5")])] })
    );
    expect(warns(checks)).toHaveLength(0);
    expect(checks.at(-1)?.status).toBe("skipped");
    // Baseline, quote, then the double quote answered 429.
    expect(sent).toHaveLength(3);
  });

  test("signatures match error pages and not prose about errors", () => {
    expect(findErrorSignature("SQLSTATE[42000]: Syntax error")?.kind).toBe(
      "database"
    );
    expect(
      findErrorSignature("Traceback (most recent call last):\n  File")?.kind
    ).toBe("framework");
    expect(
      findErrorSignature(
        "<b>Fatal error</b>: Uncaught Error in /a/b.php on line <b>9</b>"
      )?.kind
    ).toBe("php");
    expect(findErrorSignature("<h1>Bad request</h1> Invalid id")).toBeNull();
    expect(
      findErrorSignature("A warning about a fatal error in life")
    ).toBeNull();
  });

  test("the signature scan stays linear on adversarial input", () => {
    const t = (n: number) => {
      const s = performance.now();
      findErrorSignature("fatal error: ".repeat(n));
      findErrorSignature("<b>warning</b>: ".repeat(n));
      findErrorSignature("\n  at ".repeat(n));
      return performance.now() - s;
    };
    t(100);
    expect(t(4000)).toBeLessThan(2000);
  });
});
