import { describe, expect, test } from "bun:test";

import {
  SEED_VERIFICATION_MAX_PAGES,
  seedVerificationLine,
  summarizeSeedVerification,
} from "../src/seed-verification";

describe("summarizeSeedVerification (#1759)", () => {
  test("is null when no known page carries findings", () => {
    expect(summarizeSeedVerification({ carriedPages: [], pages: [] })).toBeNull();
  });

  test("a 404 and a 410 are gone with their status, a 3xx redirect row is redirected with its destination", () => {
    const sv = summarizeSeedVerification({
      carriedPages: ["https://a.test/x", "https://a.test/y", "https://a.test/z"],
      seeded: ["https://a.test/x", "https://a.test/y", "https://a.test/z"],
      pages: [
        { normalizedUrl: "https://a.test/x", status: 404 },
        { normalizedUrl: "https://a.test/y", status: 410 },
        {
          normalizedUrl: "https://a.test/z",
          status: 308,
          redirect: true,
          finalUrl: "https://a.test/w",
        },
      ],
    })!;
    expect(sv.gone).toBe(2);
    expect(sv.redirected).toBe(1);
    expect(sv.pages.map((p) => [p.outcome, p.status])).toEqual([
      ["redirected", 308],
      ["gone", 404],
      ["gone", 410],
    ]);
    expect(sv.pages[0]!.destination).toBe("https://a.test/w");
  });

  test("a 5xx or a rate limit is unverified, never gone or live", () => {
    const sv = summarizeSeedVerification({
      carriedPages: ["https://a.test/x", "https://a.test/y"],
      pages: [
        { normalizedUrl: "https://a.test/x", status: 503 },
        { normalizedUrl: "https://a.test/y", status: 429 },
      ],
    })!;
    expect(sv).toMatchObject({ unverified: 2, gone: 0, live: 0, reverified: 0, leftCarried: 2 });
  });

  test("not queued and not seeded is no longer linked; queued and pending is the page budget; a budget skip reason too", () => {
    const sv = summarizeSeedVerification({
      carriedPages: [
        "https://a.test/1",
        "https://a.test/2",
        "https://a.test/3",
        "https://a.test/4",
      ],
      pages: [],
      frontier: [
        { normalizedUrl: "https://a.test/2", status: "pending" },
        { normalizedUrl: "https://a.test/3", status: "skipped", reason: "over_max_pages" },
        { normalizedUrl: "https://a.test/4", status: "skipped", reason: "robots" },
      ],
    })!;
    expect(sv).toMatchObject({
      noLongerLinked: 1,
      skippedByBudget: 2,
      unverified: 1,
      leftCarried: 4,
    });
  });

  test("pages outside the known set are ignored and the page list is clipped while the counts stay exact", () => {
    const urls = Array.from(
      { length: SEED_VERIFICATION_MAX_PAGES + 20 },
      (_, i) => `https://a.test/p${i}`,
    );
    const sv = summarizeSeedVerification({
      carriedPages: urls,
      pages: [
        ...urls.map((u) => ({ normalizedUrl: u, status: 200 })),
        { normalizedUrl: "https://a.test/other", status: 404 },
      ],
    })!;
    expect(sv.live).toBe(urls.length);
    expect(sv.gone).toBe(0);
    expect(sv.pages).toHaveLength(SEED_VERIFICATION_MAX_PAGES);
    expect(sv.pagesTruncated).toBe(true);
  });
});

describe("seedVerificationLine", () => {
  test("states re-verified and left carried with the split", () => {
    expect(
      seedVerificationLine({
        reverified: 5,
        gone: 2,
        redirected: 1,
        live: 2,
        leftCarried: 3,
        skippedByBudget: 2,
        noLongerLinked: 1,
      }),
    ).toBe(
      "Known pages with open findings: 5 re-verified (2 gone, 1 redirected, 2 still live), 3 left carried (2 skipped by the page budget, 1 no longer linked).",
    );
  });

  test("a stored report of any origin cannot inject text: only whole numbers print", () => {
    const hostile = {
      reverified: "<b>1</b>" as never,
      leftCarried: 1.5,
      skippedByBudget: Number.NaN,
      gone: -4,
    };
    expect(seedVerificationLine(hostile)).toBeNull();
    expect(seedVerificationLine(null)).toBeNull();
    expect(seedVerificationLine("x" as never)).toBeNull();
  });
});
