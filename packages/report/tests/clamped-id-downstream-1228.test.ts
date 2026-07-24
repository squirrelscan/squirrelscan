// #1228 finding 3: check-item ids are CLAMPED at publish (#996 — oversize ids
// used to 400 the whole publish), and those ids flow downstream as dedup keys
// (grouping), affected-page URLs (affected-pages), and rendered hrefs (html).
// A clamped id is `prefix + "~" + hash` and may not parse as a clean URL, so the
// renderers must (a) keep two distinct oversize ids DISTINCT (no dedup merge of
// unrelated findings) and (b) degrade gracefully — never throw — on a
// non-parseable id.

import { describe, expect, test } from "bun:test";

import { clampItemId } from "@squirrelscan/core-contracts/clamp";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

import type { CheckResult } from "../src/types";
import { checkAffectedPages, isPageUrl, ruleAffectedPages } from "../src/affected-pages";
import { getPathname } from "../src/url";
import { sanitizeUrl } from "../src/utils";

const CAP = REPORT_LIMITS.maxMediumString;

// Two distinct page URLs that agree for well past the cap and differ only in the
// tail — the exact collision plain truncation would cause.
const sharedPrefix = "https://example.com/" + "a".repeat(CAP);
const urlA = clampItemId(sharedPrefix + "/alpha", CAP);
const urlB = clampItemId(sharedPrefix + "/bravo", CAP);
// A `data:` URL id (a real rule-emitted id class) — not a page URL.
const dataId = clampItemId("data:image/png;base64," + "Q".repeat(CAP + 500), CAP);

describe("clamped id downstream integrity (#1228)", () => {
  test("two oversize page-URL ids sharing a >cap prefix stay distinct after clamping", () => {
    expect(urlA).not.toBe(urlB);
    expect(urlA.length).toBeLessThanOrEqual(CAP);
    expect(urlB.length).toBeLessThanOrEqual(CAP);
  });

  test("affected-pages counts the two clamped URL ids as TWO distinct pages (no merge)", () => {
    const check: CheckResult = {
      name: "some-page-rule",
      status: "warn",
      message: "issue",
      items: [
        { id: urlA, label: "a" },
        { id: urlB, label: "b" },
      ],
    };
    // Both still look like page URLs (scheme survived truncation) and are unique.
    expect(isPageUrl(urlA)).toBe(true);
    expect(isPageUrl(urlB)).toBe(true);
    const pages = checkAffectedPages(check);
    expect(pages.size).toBe(2);
  });

  test("aggregation degrades gracefully on a non-URL (data:) clamped id — no throw, not a page", () => {
    const check: CheckResult = {
      name: "resource-rule",
      status: "warn",
      message: "issue",
      items: [{ id: dataId, label: "data resource" }],
    };
    expect(isPageUrl(dataId)).toBe(false);
    let pages: Set<string> | undefined;
    expect(() => {
      pages = ruleAffectedPages([check]);
    }).not.toThrow();
    // A data: id is not a page, so it contributes nothing (no crash, no bogus page).
    expect(pages!.size).toBe(0);
  });

  test("render helpers never throw on clamped ids (getPathname / sanitizeUrl)", () => {
    for (const id of [urlA, urlB, dataId]) {
      expect(() => getPathname(id)).not.toThrow();
      expect(() => sanitizeUrl(id)).not.toThrow();
    }
    // A data: id is never emitted as an href — sanitizeUrl neutralizes it.
    expect(sanitizeUrl(dataId)).toBe("#");
    // A clamped page-URL id still yields a usable href + a parseable pathname.
    expect(sanitizeUrl(urlA)).toBe(urlA);
    expect(getPathname(urlA).startsWith("/")).toBe(true);
  });
});
