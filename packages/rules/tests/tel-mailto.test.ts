// links/tel-mailto — E.164 href vs national-trunk-prefix text is the SAME
// number (#694). Live FP: href="tel:+61414007351" text="0414 007 351" was
// flagged as mismatched, but that's the recommended markup (E.164 href,
// national display) — the trunk "0" just needs to be normalized away.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import {
  looksLikeEmail,
  telMailtoRule,
  withoutOptionalTrunkZero,
} from "../src/links/tel-mailto";
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

// pub#663: "+49 (0)6061 …" writes the German trunk prefix in parentheses after
// the calling code. The destination omits the 0, so with href
// "tel:+4960616309800" the number shown IS the number dialled. It is
// non-recommended display (ITU-T E.123), reported as advice at info status,
// never a mismatch. Only calling codes whose trunk prefix is 0 read it this way.
describe("links/tel-mailto — optional trunk prefix (0) in the display (pub#663)", () => {
  const trunkCheck = (checks: ReturnType<typeof telMailtoRule.run>["checks"]) =>
    checks.find((c) => c.name === "tel-trunk-prefix");

  test("the German example is advice, not a mismatch, and the href is left alone", () => {
    const html = page(`<a href="tel:+4960616309800">+49 (0)6061 630 980 0</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)).toBeUndefined();
    const advice = trunkCheck(checks);
    expect(advice?.status).toBe("info");
    expect(advice?.message).toBe(
      "1 tel link(s) show the optional trunk prefix (0) in an international number; drop it (ITU-T E.123)"
    );
    expect(advice?.items?.[0]?.id).toBe("tel:+4960616309800");
    expect(advice?.items?.[0]?.label).toBe(`text "+49 (0)6061 630 980 0": use "+49 6061 630 980 0"`);
  });

  test("the control (no (0) in the display) has neither finding", () => {
    const html = page(`<a href="tel:+4960616309800">+49 6061 630 980 0</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)).toBeUndefined();
    expect(trunkCheck(checks)).toBeUndefined();
  });

  test("a genuinely different German number still reports tel-mismatch", () => {
    const html = page(`<a href="tel:+4960616309800">+49 (0)6061 630 980 1</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)?.status).toBe("warn");
    expect(trunkCheck(checks)).toBeUndefined();
  });

  test("other trunk-0 codes read the same way: UK, Switzerland, Austria, Netherlands, Ireland", () => {
    const pairs: Array<[string, string]> = [
      ["tel:+442079460000", "+44 (0)20 7946 0000"],
      ["tel:+41446681800", "+41 (0)44 668 18 00"],
      ["tel:+4315121234", "+43(0)1 512 1234"],
      ["tel:+31201234567", "+31 (0) 20 123 4567"],
      ["tel:+35312345678", "Call +353 (0)1 234 5678"],
    ];
    for (const [href, text] of pairs) {
      const { checks } = telMailtoRule.run(ctx(page(`<a href="${href}">${text}</a>`)));
      expect([href, mismatchCheck(checks)]).toEqual([href, undefined]);
      expect([href, trunkCheck(checks)?.status]).toEqual([href, "info"]);
    }
  });

  test("grouped digits and a national href get the advice too", () => {
    for (const [href, text] of [
      // No three consecutive digits: the mismatch check never reads this text.
      ["tel:+33123456789", "+33 (0)1 23 45 67 89"],
      // The raw digits already match a national href; the display is still advice.
      ["tel:060616309800", "+49 (0)6061 630 980 0"],
    ]) {
      const { checks } = telMailtoRule.run(ctx(page(`<a href="${href}">${text}</a>`)));
      expect([href, mismatchCheck(checks)]).toEqual([href, undefined]);
      expect([href, trunkCheck(checks)?.status]).toEqual([href, "info"]);
    }
  });

  test("a bare '+49 (0)' with no number after it is not read as one", () => {
    const html = page(`<a href="tel:+4930123449">Call +49 (0)</a>`);
    const { checks } = telMailtoRule.run(ctx(html));
    expect(mismatchCheck(checks)).toBeUndefined();
    expect(trunkCheck(checks)).toBeUndefined();
  });

  test("a country with no trunk prefix keeps its zero: Italy and Spain still mismatch", () => {
    // In Italy the leading 0 is part of the number (+39 06 …), and Spain has
    // no trunk prefix, so "(0)" there is not read as optional.
    for (const [href, text] of [
      ["tel:+3961234567", "+39 (0)6 1234 567"],
      ["tel:+34912345678", "+34 (0)91 234 5678"],
    ]) {
      const { checks } = telMailtoRule.run(ctx(page(`<a href="${href}">${text}</a>`)));
      expect([href, mismatchCheck(checks)?.status]).toEqual([href, "warn"]);
      expect([href, trunkCheck(checks)]).toEqual([href, undefined]);
    }
  });

  test("withoutOptionalTrunkZero rewrites the display text only for listed codes", () => {
    expect(withoutOptionalTrunkZero("+49 (0)6061 630 980 0")).toBe("+49 6061 630 980 0");
    expect(withoutOptionalTrunkZero("+49(0)6061")).toBe("+49 6061");
    expect(withoutOptionalTrunkZero("Tel. +44 ( 0 ) 20 7946 0000")).toBe("Tel. +44 20 7946 0000");
    expect(withoutOptionalTrunkZero("+39 (0)6 1234 567")).toBeNull();
    expect(withoutOptionalTrunkZero("+1 (0)555 123 4567")).toBeNull();
    expect(withoutOptionalTrunkZero("+49 6061 630 980 0")).toBeNull();
    expect(withoutOptionalTrunkZero("(0)6061 630 980 0")).toBeNull();
  });
});

// #2307: where the flagged tel: and mailto: links sit.
describe("links/tel-mailto — link sections", () => {
  const html = page(
    `<footer><a href="tel:+61414007351">0400 111 222</a></footer>` +
      `<main><a href="mailto:sales@example.com">support@example.com</a></main>`
  );

  test("mismatch items say where the link sits and carry meta.sections", () => {
    const { checks } = telMailtoRule.run(ctx(html));

    expect(checks.find((c) => c.name === "tel-mismatch")?.items?.[0]).toMatchObject({
      label: 'href "+61414007351" ≠ text "0400 111 222", linked in the footer',
      meta: { sections: { footer: 1 } },
    });
    expect(checks.find((c) => c.name === "mailto-mismatch")?.items?.[0]).toMatchObject({
      label: 'href "sales@example.com" ≠ text "support@example.com", linked in the page content',
      meta: { sections: { content: 1 } },
    });
  });

  test("the trunk prefix advice says it too", () => {
    const { checks } = telMailtoRule.run(
      ctx(page(`<header><a href="tel:+496061630980">+49 (0)6061 630 980</a></header>`))
    );

    expect(checks.find((c) => c.name === "tel-trunk-prefix")?.items?.[0]?.label).toBe(
      'text "+49 (0)6061 630 980": use "+49 6061 630 980", linked in the header'
    );
  });

  test("a mismatch past the parse's contact cap still says where it sits (markup only)", () => {
    const phones = Array.from({ length: 32 }, (_, i) => `<p><a href="tel:+1555000${1000 + i}">call</a></p>`);
    const { checks } = telMailtoRule.run(
      ctx(page(`${phones.join("")}<footer><a href="mailto:a@example.com">b@example.com</a></footer>`))
    );

    expect(checks.find((c) => c.name === "mailto-mismatch")?.items?.[0]).toMatchObject({
      label: 'href "a@example.com" ≠ text "b@example.com", linked in the footer',
      meta: { sections: { footer: 1 } },
    });
  });

  test("without section data the items are as they were", () => {
    const c = ctx(html);
    for (const contact of c.parsed.contactLinks ?? []) delete contact.section;
    const { checks } = telMailtoRule.run(c);

    expect(checks.find((x) => x.name === "tel-mismatch")?.items?.[0]).toEqual({
      id: "tel:+61414007351",
      label: 'href "+61414007351" ≠ text "0400 111 222"',
      snippet: '<a href="tel:+61414007351">0400 111 222</a>',
    });
  });
});
