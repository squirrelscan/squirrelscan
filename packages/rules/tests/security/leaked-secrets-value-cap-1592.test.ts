// #1592: a finding's stored value is cut to a fixed maximum length, marked
// as cut, and still reported (never skipped). The issue's case is a generic
// assignment with a 1 MB value: before the fix both the page pass and the
// inline-script pass kept the whole value (two records of 1,024,022 chars).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import {
  leakedSecretsRule,
  scanPageForSecrets,
  STORED_VALUE_MAX_LENGTH,
  type LeakedSecret,
} from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const run = (seed: number, n: number): string => {
  let s = seed;
  const chars: string[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    chars.push(ALNUM[Math.floor((s / 4294967296) * ALNUM.length)]);
  }
  return chars.join("");
};

/** A page carrying one generic assignment whose secret body is `body`. */
function pageWithSecret(body: string): string {
  return (
    `<!doctype html><html><head><title>t</title></head>` +
    `<body><script>const password="${body}";</script></body></html>`
  );
}

function scan(body: string): LeakedSecret[] {
  const url = "https://shop.example/p";
  const doc = parsePage(pageWithSecret(body), url).document!;
  return scanPageForSecrets(doc, url);
}

describe("stored value length cap (#1592)", () => {
  test("a 1 MB generic value is cut to the cap, marked, and still reported", () => {
    const body = run(7, 1_024_011);
    const found = scan(body);
    // The page pass and the inline-script pass each report it, as before.
    expect(found.length).toBe(2);
    for (const f of found) {
      expect(f.type).toBe("Generic Secret Assignment");
      expect(f.value.length).toBe(STORED_VALUE_MAX_LENGTH);
      expect(f.truncated).toBe(true);
      // The full length survives on the record, so a reader can tell how
      // much was cut; the stored value itself stays bounded.
      expect(f.length).toBe(body.length);
      // The stored generic value carries its key and quotes, so the cut
      // keeps the recognisable head of the match.
      expect(f.value).toBe(`password="${body}`.slice(0, STORED_VALUE_MAX_LENGTH));
    }
  }, 30_000);

  test("a value at the cap is kept whole and unmarked", () => {
    // The stored generic value carries its key and quotes (`password="`
    // plus a closing quote, 11 chars), so a 2,037-char body lands exactly
    // on the cap.
    const body = run(8, STORED_VALUE_MAX_LENGTH - 11);
    const found = scan(body);
    expect(found.length).toBe(2);
    for (const f of found) {
      expect(f.value.length).toBe(STORED_VALUE_MAX_LENGTH);
      expect(f.truncated).toBeUndefined();
      expect(f.value).toBe(`password="${body}"`);
    }
  }, 30_000);

  test("an ordinary short value is untouched", () => {
    const body = run(9, 40);
    const found = scan(body);
    expect(found.length).toBe(2);
    for (const f of found) {
      expect(f.truncated).toBeUndefined();
      expect(f.value).toContain(body);
    }
  }, 30_000);

  test("the rule check carries the cut marker for report readers", () => {
    const url = "https://shop.example/p";
    const ctx = {
      site: {
        baseUrl: "https://shop.example",
        pages: [
          { url, statusCode: 200, parsed: parsePage(pageWithSecret(run(11, 1_024_011)), url) },
        ],
        robotsTxt: null,
        sitemaps: null,
        scripts: [],
      },
      options: {},
    } as unknown as RuleContext;
    const result = leakedSecretsRule.run(ctx);
    const medium = result.checks.find((c) => c.name === "leaked-secrets-medium");
    expect(medium).toBeDefined();
    expect(medium!.items!.length).toBeGreaterThan(0);
    for (const item of medium!.items!) {
      expect((item.meta as Record<string, unknown>).truncated).toBe(true);
      expect((item.meta as Record<string, unknown>).length).toBe(1_024_011);
    }
  }, 30_000);
});
