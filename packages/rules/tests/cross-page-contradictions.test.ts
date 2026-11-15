import { describe, expect, test } from "bun:test";

import type { PageClaim, PageClaimsResponse } from "@squirrelscan/core-contracts";

import type { CloudResultStore } from "../src/cloud";
import {
  crossPageContradictionsRule,
  findContradictions,
} from "../src/content/cross-page-contradictions";

const claim = (o: Partial<PageClaim> & Pick<PageClaim, "url" | "type" | "value">): PageClaim => ({
  subject: "pro",
  context: "usd monthly",
  quote: `quote ${o.value}`,
  confidence: 0.95,
  ...o,
});

describe("findContradictions", () => {
  test("same plan, same currency, different price conflicts and cites both pages", () => {
    const r = findContradictions([
      claim({ url: "https://x.test/pricing", type: "price", value: "$29/month", quote: "Pro is $29 per month" }),
      claim({ url: "https://x.test/faq", type: "price", value: "$39", quote: "Pro costs $39 a month" }),
    ]);
    expect(r).toHaveLength(1);
    expect([r[0]!.a.quote, r[0]!.b.quote].sort()).toEqual(
      ["Pro costs $39 a month", "Pro is $29 per month"],
    );
    expect(new Set([r[0]!.a.url, r[0]!.b.url]).size).toBe(2);
  });

  test("different phone numbers for the same department conflict, formatting is ignored", () => {
    const base = { type: "phone" as const, subject: "support", context: "" };
    expect(
      findContradictions([
        claim({ ...base, url: "https://x.test/a", value: "+1 (555) 010-2000" }),
        claim({ ...base, url: "https://x.test/b", value: "555.010.2000" }),
      ]),
    ).toHaveLength(0);
    expect(
      findContradictions([
        claim({ ...base, url: "https://x.test/a", value: "+1 (555) 010-2000" }),
        claim({ ...base, url: "https://x.test/b", value: "555-010-9999" }),
      ]),
    ).toHaveLength(1);
  });

  test("different business hours conflict", () => {
    const base = { type: "hours" as const, subject: "monday", context: "store" };
    expect(
      findContradictions([
        claim({ ...base, url: "https://x.test/a", value: "9am to 5pm" }),
        claim({ ...base, url: "https://x.test/b", value: "9am to 6pm" }),
      ]),
    ).toHaveLength(1);
  });

  describe("precision fixtures: legitimate differences are never findings", () => {
    const cases: Array<[string, PageClaim[]]> = [
      [
        "different plans",
        [
          claim({ url: "https://x.test/a", type: "price", subject: "pro", value: "$29" }),
          claim({ url: "https://x.test/b", type: "price", subject: "team", value: "$99" }),
        ],
      ],
      [
        "different currencies",
        [
          claim({ url: "https://x.test/us", type: "price", context: "usd monthly", value: "$29" }),
          claim({ url: "https://x.test/eu", type: "price", context: "eur monthly", value: "27 EUR" }),
        ],
      ],
      [
        "different billing periods",
        [
          claim({ url: "https://x.test/a", type: "price", context: "usd monthly", value: "$29" }),
          claim({ url: "https://x.test/b", type: "price", context: "usd yearly", value: "$290" }),
        ],
      ],
      [
        "different regions",
        [
          claim({ url: "https://x.test/a", type: "shipping", subject: "standard", context: "us", value: "3 to 5 days" }),
          claim({ url: "https://x.test/b", type: "shipping", subject: "standard", context: "eu", value: "7 to 10 days" }),
        ],
      ],
      [
        "different departments",
        [
          claim({ url: "https://x.test/a", type: "phone", subject: "sales", context: "", value: "555-010-1111" }),
          claim({ url: "https://x.test/b", type: "phone", subject: "support", context: "", value: "555-010-2222" }),
        ],
      ],
      [
        "one page states both values (old and sale price)",
        [
          claim({ url: "https://x.test/a", type: "price", value: "$39" }),
          claim({ url: "https://x.test/a", type: "price", value: "$29" }),
          claim({ url: "https://x.test/b", type: "price", value: "$29" }),
        ],
      ],
      [
        "same value written two ways",
        [
          claim({ url: "https://x.test/a", type: "price", value: "$1,299.00" }),
          claim({ url: "https://x.test/b", type: "price", value: "1299" }),
        ],
      ],
      [
        "low confidence",
        [
          claim({ url: "https://x.test/a", type: "price", value: "$29" }),
          claim({ url: "https://x.test/b", type: "price", value: "$39", confidence: 0.5 }),
        ],
      ],
      [
        "missing subject or quote",
        [
          claim({ url: "https://x.test/a", type: "price", value: "$29" }),
          claim({ url: "https://x.test/b", type: "price", value: "$39", subject: " " }),
          claim({ url: "https://x.test/c", type: "price", value: "$49", quote: "" }),
        ],
      ],
      [
        "one page only",
        [claim({ url: "https://x.test/a", type: "founded", subject: "company", context: "", value: "2015" })],
      ],
    ];
    for (const [name, claims] of cases) {
      test(name, () => expect(findContradictions(claims)).toEqual([]));
    }
  });

  test("result is independent of input order", () => {
    const claims = [
      claim({ url: "https://x.test/b", type: "founded", subject: "company", context: "", value: "2016" }),
      claim({ url: "https://x.test/a", type: "founded", subject: "company", context: "", value: "2015" }),
      claim({ url: "https://x.test/c", type: "headcount", subject: "team", context: "", value: "40 people" }),
      claim({ url: "https://x.test/d", type: "headcount", subject: "team", context: "", value: "55 people" }),
    ];
    expect(findContradictions(claims)).toEqual(findContradictions([...claims].reverse()));
    expect(findContradictions(claims)).toHaveLength(2);
  });
});

const run = (data?: PageClaimsResponse, skipped = false) => {
  const store: CloudResultStore = new Map();
  if (data || skipped) {
    store.set(
      "page-claims",
      new Map([
        ["site", skipped ? { status: "skipped", skipReason: "not-authenticated" } : { status: "ok", data }],
      ]),
    );
  }
  return crossPageContradictionsRule.run({ cloudResults: store } as never) as {
    checks: Array<{ status: string; message: string; items?: Array<{ snippet?: string }> }>;
  };
};

describe("content/cross-page-contradictions rule", () => {
  test("is an opt-in cloud rule billed as llm_rules_page", () => {
    expect(crossPageContradictionsRule.meta.optIn).toBe(true);
    expect(crossPageContradictionsRule.meta.cloud).toEqual({
      service: "page-claims",
      unit: "site",
      creditFeature: "llm_rules_page",
    });
  });

  test("skips without a cloud result", () => {
    expect(run().checks[0]!.status).toBe("skipped");
    const s = run(undefined, true).checks[0]!;
    expect(s.status).toBe("skipped");
  });

  test("passes with no conflicts", () => {
    expect(run({ claims: [], pagesSampled: 12 }).checks[0]!.status).toBe("pass");
  });

  test("warns and quotes both claims verbatim with both URLs", () => {
    const c = run({
      pagesSampled: 8,
      claims: [
        claim({ url: "https://x.test/pricing", type: "price", value: "$29", quote: "Pro is $29 per month" }),
        claim({ url: "https://x.test/faq", type: "price", value: "$39", quote: "Pro costs $39 a month" }),
      ],
    }).checks[0]!;
    expect(c.status).toBe("warn");
    const snippet = c.items![0]!.snippet!;
    for (const part of ["https://x.test/pricing", "https://x.test/faq", '"Pro is $29 per month"', '"Pro costs $39 a month"']) {
      expect(snippet).toContain(part);
    }
  });
});
