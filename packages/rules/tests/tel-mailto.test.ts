// links/tel-mailto — E.164 href vs national-trunk-prefix text is the SAME
// number (#694). Live FP: href="tel:+61414007351" text="0414 007 351" was
// flagged as mismatched, but that's the recommended markup (E.164 href,
// national display) — the trunk "0" just needs to be normalized away.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { looksLikeEmail, telMailtoRule } from "../src/links/tel-mailto";
import type { RuleContext } from "../src/types";

function ctx(html: string): RuleContext {
  const url = "https://example.com/";
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function page(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${bodyHtml}</body></html>`;
}

function mismatchCheck(checks: ReturnType<typeof telMailtoRule.run>["checks"]) {
  return checks.find((c) => c.name === "tel-mismatch");
}

describe("links/tel-mailto — phone number matching", () => {
  test("#694: E.164 href + AU national trunk-zero text is NOT a mismatch", () => {
    const html = page(`<a href="tel:+61414007351">0414 007 351</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)).toBeUndefined();
  });

  test("UK: E.164 href + national trunk-zero text (020) is NOT a mismatch", () => {
    const html = page(`<a href="tel:+442012345678">020 1234 5678</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)).toBeUndefined();
  });

  test("national trunk-zero href + E.164 text is NOT a mismatch (reverse order)", () => {
    const html = page(`<a href="tel:0414007351">+61 414 007 351</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)).toBeUndefined();
  });

  test("existing behavior preserved: omitted country code still matches", () => {
    const html = page(`<a href="tel:+15551234567">5551234567</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)).toBeUndefined();
  });

  test("exact same number still matches", () => {
    const html = page(`<a href="tel:+15551234567">+15551234567</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)).toBeUndefined();
  });

  test("genuinely different numbers still flagged (true positive)", () => {
    const html = page(`<a href="tel:+61414007351">0398765432</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    const mismatch = mismatchCheck(checks);
    expect(mismatch?.status).toBe("warn");
    expect(mismatch?.message).toContain("1 tel link(s)");
  });

  test("different number in same national format still flagged", () => {
    const html = page(`<a href="tel:0414007351">0398765432</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)?.status).toBe("warn");
  });

  test("codex regression: NANP (+1) href with spurious-leading-zero text is still flagged (1-digit calling codes don't use trunk 0)", () => {
    const html = page(`<a href="tel:+15551234567">0555 123 4567</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)?.status).toBe("warn");
  });
});

describe("links/tel-mailto — mailto display text", () => {
  const LEGACY_EMAIL_RE = /.+@.+\..+/;

  test("looksLikeEmail agrees with the regex it replaced", () => {
    const cases = [
      "a@b.co", "hello@example.com", "Email hello@example.com today", "@example.com",
      "a@.c", "a@b.", "a@bc", "a@b.c", "a@@b.c", "a@..c", "a.b@c", "a@b\n.c",
      "line one\nx@y.zz", "a@b\r\n.cd", "a@b\u2028c.d", "", "@", ".", "Contact us",
    ];
    for (const text of cases) expect(looksLikeEmail(text)).toBe(LEGACY_EMAIL_RE.test(text));

    const alphabet = ["a", "@", ".", " ", "\n", "\r", "\u2028", "\u2029", "x.y", "b@c.d"];
    let s = 694;
    for (let i = 0; i < 20_000; i++) {
      let text = "";
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const len = (s >>> 8) % 14;
      for (let j = 0; j < len; j++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        text += alphabet[(s >>> 8) % alphabet.length];
      }
      expect(looksLikeEmail(text)).toBe(LEGACY_EMAIL_RE.test(text));
    }
  });

  test("a different address in the link text is still flagged", () => {
    const html = page(`<a href="mailto:sales@example.com">support@example.com</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(checks.find((c) => c.name === "mailto-mismatch")?.status).toBe("warn");
  });

  test("a mailto link wrapping a 500KB unbroken run finishes well under a second", () => {
    // The shape of inline base64 (a font, an image) inside the link.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const run = Array.from({ length: 500 * 1024 }, (_, i) => alphabet[(i * 7919) % 64]).join("");
    const html = page(`<a href="mailto:hello@example.com">${run}</a>`);
    const context = ctx(html);

    const start = performance.now();
    const { checks } = telMailtoRule.run(context);
    // A few ms in practice; generous so a loaded CI runner cannot flake it.
    expect(performance.now() - start).toBeLessThan(500);
    expect(checks.find((c) => c.name === "mailto-mismatch")).toBeUndefined();
  });
});
