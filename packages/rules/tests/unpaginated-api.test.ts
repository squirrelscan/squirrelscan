// security/unpaginated-api: a collection endpoint that answers a whole table.
// Every test runs the rule against a stubbed fetch, so what is sent is pinned.

import { afterEach, describe, expect, test } from "bun:test";

import type { CheckResult } from "../src/types";

import { API_RESPONSE_CAP } from "../src/security/unauthenticated-api";
import {
  hasNextLinkHeader,
  hasPaginationMetadata,
  MIN_BYTES,
  MIN_RECORD_FIELDS,
  MIN_ROWS,
  PAGING_QUERY,
  unpaginatedApiRule,
} from "../src/security/unpaginated-api";
import {
  BASE,
  candidate,
  json,
  robots,
  ruleCtx,
  stubFetch,
  surface,
  type Route,
  type SentRequest,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const ORDERS = `${BASE}/api/orders`;
// A marker that must never appear in a finding.
const SECRET = "value-that-must-not-leak";

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `${SECRET}-${i}`,
    customer_note: "open",
    total: i,
  }));

const get = (path: string) => candidate(path, { method: "GET" });

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {}
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const { checks } = await unpaginatedApiRule.run(
    ruleCtx({ surface: surface([get("/api/orders")]), ...ctxOpts })
  );
  return { checks, sent: stub.sent };
}

const names = (checks: CheckResult[]) => checks.map((c) => c.name);

describe("security/unpaginated-api: activation", () => {
  test("passive or no probe budget: skipped, nothing sent", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run(
        { [ORDERS]: () => json(rows(MIN_ROWS)) },
        opts
      );
      expect(sent).toHaveLength(0);
      expect(checks).toEqual([
        expect.objectContaining({
          name: "unpaginated-api-unchecked",
          skipReason: "probing-passive",
        }),
      ]);
    }
  });

  test("a cross-origin endpoint is never probed", async () => {
    const { checks, sent } = await run(
      { "https://api.other.com/orders": () => json(rows(MIN_ROWS)) },
      {
        surface: surface([
          candidate("https://api.other.com/orders", { method: "GET" }),
        ]),
      }
    );
    expect(sent).toHaveLength(0);
    expect(checks[0]).toEqual(
      expect.objectContaining({ skipReason: "no-endpoints" })
    );
  });

  test("a POST-only endpoint is never probed", async () => {
    const { sent } = await run(
      { [ORDERS]: () => json(rows(MIN_ROWS)) },
      { surface: surface([candidate("/api/orders", { method: "POST" })]) }
    );
    expect(sent).toHaveLength(0);
  });

  test("an exhausted budget sends nothing and is not a pass", async () => {
    const { checks, sent } = await run(
      { [ORDERS]: () => json(rows(MIN_ROWS)) },
      { budgetMs: 0 }
    );
    expect(sent).toHaveLength(0);
    expect(names(checks)).toEqual(["unpaginated-api-unchecked"]);
  });
});

describe("security/unpaginated-api: flagging", () => {
  test("a whole table that ignores the paging parameters is flagged with rows and size only", async () => {
    const { checks, sent } = await run({
      [ORDERS]: () => json(rows(MIN_ROWS + 20)),
    });
    expect(names(checks)).toEqual(["unpaginated-api-list"]);
    const check = checks[0]!;
    expect(check.status).toBe("warn");
    const item = check.items![0]!;
    expect(item.id).toBe(ORDERS);
    expect(item.meta).toEqual(
      expect.objectContaining({ rows: MIN_ROWS + 20, method: "GET" })
    );
    expect(item.label).toContain(`${MIN_ROWS + 20} rows`);
    expect(item.label).toContain("KB");
    // Never a record value, and no field names either.
    expect(JSON.stringify(checks)).not.toContain(SECRET);
    expect(JSON.stringify(checks)).not.toContain("customer_note");

    // One plain GET, then one GET with the paging query. Both anonymous GETs.
    expect(sent.map((s) => s.url)).toEqual([
      ORDERS,
      `${ORDERS}?${PAGING_QUERY}`,
    ]);
    for (const req of sent) {
      expect(req.method).toBe("GET");
      expect(req.body).toBeNull();
      expect(req.credentials).toBe("omit");
      expect(
        Object.keys(req.headers).map((h) => h.toLowerCase())
      ).not.toContain("authorization");
    }
  });

  test("a wrapped list is read too", async () => {
    const { checks } = await run({
      [ORDERS]: () => json({ data: rows(MIN_ROWS) }),
    });
    expect(names(checks)).toEqual(["unpaginated-api-list"]);
  });

  test("a body over the read cap is flagged by size, row count unknown", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => ({
      id: i,
      a: "x".repeat(60),
      b: 1,
      c: 2,
    }));
    const { checks } = await run({ [ORDERS]: () => json(big) });
    expect(JSON.stringify(big).length).toBeGreaterThan(API_RESPONSE_CAP);
    const item = checks[0]!.items![0]!;
    expect(item.meta).toEqual(
      expect.objectContaining({ rows: null, truncated: true })
    );
    expect(item.label).toContain("at least");
  });

  test("few rows but a large body is flagged by size", async () => {
    const fat = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      body: "x".repeat(MIN_BYTES / 10),
      b: 1,
      c: 2,
    }));
    const { checks } = await run({ [ORDERS]: () => json(fat) });
    expect(names(checks)).toEqual(["unpaginated-api-list"]);
  });
});

describe("security/unpaginated-api: not flagged", () => {
  test("a small list is clean and sends only one GET", async () => {
    const { checks, sent } = await run({
      [ORDERS]: () => json(rows(MIN_ROWS - 1)),
    });
    expect(names(checks)).toEqual(["unpaginated-api"]);
    expect(sent).toHaveLength(1);
  });

  test("an endpoint that honours limit and page is not flagged", async () => {
    const { checks, sent } = await run({
      [ORDERS]: (req) =>
        json(new URL(req.url).searchParams.has("limit") ? rows(1) : rows(500)),
    });
    expect(names(checks)).toEqual(["unpaginated-api"]);
    expect(sent).toHaveLength(2);
  });

  test("pagination metadata in the body is enough, no second GET", async () => {
    for (const body of [
      { data: rows(500), next_cursor: "abc" },
      { data: rows(500), meta: { page: 1, total_pages: 5 } },
      { items: rows(500), links: { next: "/api/orders?page=2" } },
    ]) {
      const { checks, sent } = await run({ [ORDERS]: () => json(body) });
      expect(names(checks)).toEqual(["unpaginated-api"]);
      expect(sent).toHaveLength(1);
      restore?.();
      restore = undefined;
    }
  });

  test("a Link rel=next header is enough", async () => {
    const { checks, sent } = await run({
      [ORDERS]: () =>
        new Response(JSON.stringify(rows(500)), {
          headers: {
            "content-type": "application/json",
            link: '</api/orders?page=2>; rel="next"',
          },
        }),
    });
    expect(names(checks)).toEqual(["unpaginated-api"]);
    expect(sent).toHaveLength(1);
  });

  test("a list of bare ids or labels is not a table of full records", async () => {
    const { checks } = await run({
      [ORDERS]: () =>
        json(Array.from({ length: 500 }, (_, i) => ({ id: i, name: "n" }))),
    });
    expect(names(checks)).toEqual(["unpaginated-api"]);
  });

  test("HTML, errors and non-JSON are not flagged", async () => {
    for (const res of [
      () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        }),
      () => json({ error: "no" }, 401),
      () =>
        new Response("plain", { headers: { "content-type": "text/plain" } }),
    ]) {
      const { checks } = await run({ [ORDERS]: res });
      expect(names(checks)).toEqual(["unpaginated-api"]);
      restore?.();
      restore = undefined;
    }
  });
});

describe("security/unpaginated-api: one large document", () => {
  // Over the read cap, the body cannot be parsed, so only its opening is read.
  const doc = () => ({
    settings: Object.fromEntries(
      Array.from({ length: 4000 }, (_, i) => [`k${i}`, "x".repeat(60)])
    ),
  });

  test("a single object over the read cap is not a whole table", async () => {
    const body = doc();
    expect(JSON.stringify(body).length).toBeGreaterThan(API_RESPONSE_CAP);
    const { checks, sent } = await run({ [ORDERS]: () => json(body) });
    expect(names(checks)).toEqual(["unpaginated-api"]);
    expect(sent).toHaveLength(1);
  });

  test("a list one wrapper deeper over the read cap is still read", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => ({
      id: i,
      a: "x".repeat(60),
      ...Object.fromEntries(
        Array.from({ length: MIN_RECORD_FIELDS }, (_, j) => [`f${j}`, j])
      ),
    }));
    const { checks } = await run({
      [ORDERS]: () => json({ result: { rows: big } }),
    });
    expect(names(checks)).toEqual(["unpaginated-api-list"]);
  });
});

describe("security/unpaginated-api: robots.txt", () => {
  // Disallows only URLs with a query string, so the plain GET is allowed and
  // only the paged GET is not.
  const robotsTxt = robots(["/api/orders?"]);

  test("below aggressive, a disallowed paged URL is not requested and the endpoint is unchecked", async () => {
    const { checks, sent } = await run(
      { [ORDERS]: () => json(rows(MIN_ROWS + 20)) },
      { robotsTxt }
    );
    expect(sent.map((s) => s.url)).toEqual([ORDERS]);
    expect(names(checks)).toEqual(["unpaginated-api-unchecked"]);
    expect(checks[0]!.message).toContain("robots.txt");
  });

  test("aggressive sends the paged GET anyway", async () => {
    const { checks, sent } = await run(
      { [ORDERS]: () => json(rows(MIN_ROWS + 20)) },
      { robotsTxt, level: "aggressive" }
    );
    expect(sent.map((s) => s.url)).toEqual([
      ORDERS,
      `${ORDERS}?${PAGING_QUERY}`,
    ]);
    expect(names(checks)).toEqual(["unpaginated-api-list"]);
  });
});

describe("security/unpaginated-api: not a clean result when unverified", () => {
  test("a failing paged GET leaves the endpoint unflagged and the run unchecked", async () => {
    const { checks } = await run({
      [ORDERS]: (req) =>
        req.url.includes("limit=")
          ? json({ error: "x" }, 500)
          : json(rows(500)),
    });
    expect(names(checks)).toEqual(["unpaginated-api-unchecked"]);
  });

  test("a 429 stops the run and is not a pass", async () => {
    const { checks } = await run({ [ORDERS]: () => json({}, 429) });
    expect(names(checks)).toEqual(["unpaginated-api-unchecked"]);
  });
});

describe("security/unpaginated-api: helpers", () => {
  test("hasPaginationMetadata", () => {
    expect(hasPaginationMetadata({ data: [], hasMore: true })).toBe(true);
    expect(hasPaginationMetadata({ data: [], meta: { per_page: 10 } })).toBe(
      true
    );
    expect(hasPaginationMetadata({ data: [] })).toBe(false);
    expect(hasPaginationMetadata([])).toBe(false);
  });

  test("hasNextLinkHeader", () => {
    expect(hasNextLinkHeader(new Headers({ link: '<x>; rel="next"' }))).toBe(
      true
    );
    expect(hasNextLinkHeader(new Headers({ link: '<x>; rel="prev"' }))).toBe(
      false
    );
    expect(hasNextLinkHeader(undefined)).toBe(false);
  });
});
