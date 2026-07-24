// "Pages affected" aggregation (#240): unions check.pages + item-level
// sourcePages + page-URL item ids, without double-counting resource URLs.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "../src/types";
import {
  checkAffectedPageCount,
  ruleAffectedPageCount,
  ruleAffectedPages,
} from "../src/affected-pages";

describe("checkAffectedPageCount", () => {
  test("counts check.pages for page-scope checks", () => {
    const check: CheckResult = {
      name: "thin-content",
      status: "warn",
      message: "x",
      pages: ["https://e.com/a", "https://e.com/b", "https://e.com/a"],
    };
    expect(checkAffectedPageCount(check)).toBe(2);
  });

  test("counts item sourcePages, not the resource id (blocked-links shape)", () => {
    const check: CheckResult = {
      name: "blocked-links",
      status: "warn",
      message: "blocked",
      items: [
        {
          id: "https://ads-twitter.com/uwt.js",
          sourcePages: ["https://e.com/", "https://e.com/about"],
        },
      ],
    };
    // 2 source pages — the resource URL itself is NOT counted as a page.
    expect(checkAffectedPageCount(check)).toBe(2);
  });

  test("counts item id when it IS a page URL with no sourcePages (sitemap shape)", () => {
    const check: CheckResult = {
      name: "sitemap-4xx",
      status: "warn",
      message: "4xx",
      items: [{ id: "https://e.com/gone" }, { id: "https://e.com/missing" }],
    };
    expect(checkAffectedPageCount(check)).toBe(2);
  });

  test("does NOT count a resource URL id when sourcePages is present but empty", () => {
    const check: CheckResult = {
      name: "blocked-links",
      status: "warn",
      message: "unattributed",
      // blocked-links always emits sourcePages; an unattributed resource has []
      // — its URL must NOT be counted as an affected page.
      items: [{ id: "https://ads-twitter.com/uwt.js", sourcePages: [] }],
    };
    expect(checkAffectedPageCount(check)).toBe(0);
  });

  test("ignores non-URL item ids that lack sourcePages (title-unique shape)", () => {
    const check: CheckResult = {
      name: "title-unique",
      status: "warn",
      message: "dupe",
      items: [
        { id: "Home — Example", sourcePages: ["https://e.com/", "https://e.com/index"] },
        { id: "About — Example" }, // non-URL id, no sourcePages → contributes nothing
      ],
    };
    expect(checkAffectedPageCount(check)).toBe(2);
  });
});

describe("ruleAffectedPageCount", () => {
  test("unions and dedups pages across per-resource checks", () => {
    const checks: CheckResult[] = [
      {
        name: "blocked-links",
        status: "warn",
        message: "tw",
        items: [
          {
            id: "https://ads-twitter.com/uwt.js",
            sourcePages: ["https://e.com/", "https://e.com/about"],
          },
        ],
      },
      {
        name: "blocked-links",
        status: "warn",
        message: "fb",
        items: [
          {
            id: "https://connect.facebook.net/fbevents.js",
            sourcePages: ["https://e.com/"], // overlaps with the TW check → dedup
          },
        ],
      },
    ];
    // Union of {/, /about} and {/} = 2 unique pages.
    expect(ruleAffectedPageCount(checks)).toBe(2);
    expect(ruleAffectedPages(checks)).toEqual(
      new Set(["https://e.com/", "https://e.com/about"]),
    );
  });

  test("returns 0 when nothing references a page", () => {
    expect(ruleAffectedPageCount([])).toBe(0);
    expect(
      ruleAffectedPageCount([{ name: "x", status: "warn", message: "m" }]),
    ).toBe(0);
  });
});
