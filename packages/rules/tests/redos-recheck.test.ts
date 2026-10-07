// Super-linear regexes found by rechecking the slowest rules with a static ReDoS
// checker. Each was confirmed with a timing harness, then rewritten to an
// equivalent linear form. These tests feed each one its attack shape at a size
// where the old pattern took seconds, and pin that real matches still match.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { splitTitle } from "../src/content/title-pattern-outlier";
import { fingerprintPage } from "../src/integrity/fingerprint";
import { classifyKeyContext, FAST_PATTERNS, scanContent } from "../src/security/leaked-secrets";
import { heldAsCredential } from "../src/security/secrets/confidence";

/** Wall time of `fn` in ms. */
function timed(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function fastPattern(name: string): RegExp {
  const p = FAST_PATTERNS.find((x) => x.name === name);
  if (!p) throw new Error(`no fast pattern ${name}`);
  return new RegExp(p.pattern.source, p.pattern.flags);
}

// Old patterns took 1.8 s (JWT) and 3.7 s (OAuth) on 100 KB of this; now ~ms on 1 MB.
const LINEAR_MS = 500;

describe("leaked-secrets patterns stay linear", () => {
  test("JSON Web Token: a run of `eyJ` with no `.`", () => {
    const re = fastPattern("JSON Web Token");
    expect(timed(() => ("eyJ".repeat(333_333) + "\x00").match(re))).toBeLessThan(LINEAR_MS);

    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"s".repeat(43)}`;
    // Still found after a base64url character, e.g. URL-encoded `Bearer%20eyJ…`.
    expect("Authorization: Bearer%20" + jwt).toMatch(re);
    expect(`token="${jwt}"`.match(re)?.[0]).toBe(jwt);
    // A later `eyJ` in the same run is the same failure the first one was.
    expect(`eyJ${"a".repeat(20)}eyJ${"b".repeat(20)}`.match(re)).toBeNull();
  });

  test("Google OAuth Client ID: a long run of digits", () => {
    const re = fastPattern("Google OAuth Client ID");
    expect(timed(() => "0".repeat(1_000_000).match(re))).toBeLessThan(LINEAR_MS);
    const id = `1234567890-${"a".repeat(32)}.apps.googleusercontent.com`;
    expect(`client_id: "${id}"`.match(re)?.[0]).toBe(id);
  });

  test("the key read off a look-back window is no longer cubic", () => {
    // The worst window the look-back can hand over: 128 key characters, then
    // whitespace up to its 512-character reach. The old pattern took ~19 ms per
    // call here, once per candidate value on a page.
    const before = "$".repeat(128) + "=" + "\t".repeat(380) + '"$:';
    expect(timed(() => {
      for (let i = 0; i < 100; i++) {
        heldAsCredential(before);
        classifyKeyContext(before, "key");
      }
    })).toBeLessThan(LINEAR_MS);
    expect(heldAsCredential('api_key = "')).toBe(true);
    expect(classifyKeyContext('sha256: "', "key")).toBe("digest");
    expect(classifyKeyContext('cfg["apiKey"] = "', "key")).toBe("credential");
  });

  test("`<script` open tags with no `>` after them", () => {
    const token = "0123456789abcdef0123456789abcdef";
    const page =
      `<script id="shopify-features" type="application/json">{"accessToken":"${token}"}</script>` +
      "<script".repeat(30_000);
    const ms = timed(() => scanContent(page, "html"));
    expect(ms).toBeLessThan(LINEAR_MS * 2);
    // The script block before them is still read as the public storefront token.
    const found = scanContent(page, "html").find((s) => s.value.includes(token));
    expect(found?.publicByDesign).toBe(true);
  });
});

describe("other rechecked rules stay linear", () => {
  test("template fingerprint: CSS custom properties in a <style>", () => {
    const url = "https://example.com/";
    const attack = parsePage(`<html><head><style>${"--0".repeat(100_000)}\t--0:</style></head><body></body></html>`, url);
    expect(timed(() => fingerprintPage(attack, url))).toBeLessThan(LINEAR_MS);

    const real = parsePage(
      "<html><head><style>:root{--brand-color: red; --Gap:4px} a{--x-y:1}</style></head><body></body></html>",
      url
    );
    expect([...(fingerprintPage(real, url)?.cssVars ?? [])].toSorted()).toEqual(["--brand-color", "--gap", "--x-y"]);
  });

  test("title separators: a long run of whitespace", () => {
    expect(timed(() => splitTitle("a" + "\t".repeat(200_000) + "\t:|b"))).toBeLessThan(LINEAR_MS);
    expect(splitTitle("Pricing | Acme")).toEqual({ segments: ["Pricing", "Acme"], seps: ["|"] });
    // A separator straight after one whose trailing space a match consumed.
    expect(splitTitle("Docs :: >> Guide - Acme").segments).toEqual(["Docs", "Guide", "Acme"]);
  });
});
