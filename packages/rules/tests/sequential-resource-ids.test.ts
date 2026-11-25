// security/sequential-resource-ids: a passive advisory on endpoints keyed by a
// small integer. Opaque ids and counters are not flagged, and nothing is sent.

import { afterEach, describe, expect, test } from "bun:test";

import {
  findSequentialId,
  MAX_SEQUENTIAL_ID_FINDINGS,
  sequentialResourceIdsRule,
} from "../src/security/sequential-resource-ids";
import {
  BASE,
  candidate,
  ruleCtx,
  stubFetch,
  surface,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const get = (path: string, over: Parameters<typeof candidate>[1] = {}) =>
  candidate(path, { method: undefined, ...over });

function run(
  paths: Array<ReturnType<typeof candidate>>,
  level?: "passive" | "active" | "aggressive"
) {
  return sequentialResourceIdsRule.run(
    ruleCtx({ surface: surface(paths), level })
  ) as { checks: Array<import("../src/types").CheckResult> };
}

describe("findSequentialId", () => {
  test("flags a small integer after a collection word", () => {
    const hit = findSequentialId(get("/api/orders/42"), BASE);
    expect(hit?.pattern).toBe("/api/orders/{id}");
    expect(hit?.id).toBe("42");
  });

  test("flags an id-named query key on an API path", () => {
    const hit = findSequentialId(get("/api/orders?user_id=7"), BASE);
    expect(hit?.where).toBe("query");
  });

  test.each([
    "/api/orders?id=7",
    "/api/orders?ID=7",
    "/api/orders?uid=7",
    "/api/orders?userId=7",
    "/api/orders?order-id=7",
    "/api/orders?ORDER_ID=7",
  ])("flags the id query key in %s", (path) => {
    expect(findSequentialId(get(path), BASE)?.where).toBe("query");
  });

  test.each([
    "/api/orders/3f2b8c1e-9d4a-4b6e-8f10-2a7c5e9d1b34",
    "/api/orders/01HZX3K9Q2M8N4P6R7S9T1V2W3",
    "/api/orders/5f4dcc3b5aa765d61d8327deb882cf99",
    "/api/orders/1234567",
    "/api/orders/007",
    "/api/orders/0",
    "/api/orders/my-order",
    "/api/v1",
    "/api/products?page=2",
    "/api/items/page/2",
    "/api/archive/year/2024",
    "/api/orders?limit=10",
    "/api/orders?paid=1",
    "/api/orders?valid=1",
    "/api/orders?grid=3",
  ])("does not flag %s", (path) => {
    expect(findSequentialId(get(path), BASE)).toBeNull();
  });

  test("does not flag a plain navigation link or a cross-origin URL", () => {
    expect(
      findSequentialId(
        get("/blog/3", { source: "static-html", discoveredVia: "link-href" }),
        BASE
      )
    ).toBeNull();
    expect(
      findSequentialId(get("https://api.other.com/api/orders/42"), BASE)
    ).toBeNull();
  });
});

describe("rule", () => {
  test("groups sequential ids of one pattern into one advisory warning", () => {
    const { checks } = run([
      get("/api/orders/1"),
      get("/api/orders/2"),
      get("/api/orders/3"),
    ]);
    expect(checks).toHaveLength(1);
    const c = checks[0]!;
    expect(c.status).toBe("warn");
    expect(c.message).toContain("IDOR-prone");
    expect(c.message).toContain("not a confirmed vulnerability");
    expect(c.message).toContain("unauthenticated crawl cannot show");
    expect(c.items).toHaveLength(3);
    expect(c.message).toContain("3 ids seen (1, 2, 3)");
  });

  test("passes when endpoints are found and none has a small id", () => {
    const { checks } = run([
      get("/api/orders/3f2b8c1e-9d4a-4b6e-8f10-2a7c5e9d1b34"),
      get("/api/users"),
    ]);
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("emits nothing when discovery found no endpoints", () => {
    expect(run([]).checks).toEqual([]);
    expect(
      sequentialResourceIdsRule.run(ruleCtx({ surface: undefined }))
    ).toEqual({ checks: [] });
  });

  test("caps the findings it lists", () => {
    const many = Array.from(
      { length: MAX_SEQUENTIAL_ID_FINDINGS + 5 },
      (_, i) => get(`/api/res${String.fromCharCode(97 + (i % 26))}${i}/9`)
    );
    expect(run(many).checks).toHaveLength(MAX_SEQUENTIAL_ID_FINDINGS);
  });

  test("sends no request at any probe level", () => {
    const stub = stubFetch({});
    restore = stub.restore;
    for (const level of ["passive", "active", "aggressive"] as const)
      run([get("/api/orders/1")], level);
    expect(stub.sent).toHaveLength(0);
  });
});
