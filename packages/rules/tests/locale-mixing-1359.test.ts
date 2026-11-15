// i18n/locale-mixing (repo#1359): one page following two locale conventions at once.
// The risk is false positives, so the consistent-dialect and non-English fixtures matter most.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { localeMixingRule } from "../src/i18n/locale-mixing";
import type { ParsedPage, RuleContext } from "../src/types";

async function run(body: string, lang: string | null = "en-US", alternates = 0) {
  const html = `<html${lang === null ? "" : ` lang="${lang}"`}><head><title>t</title></head><body>${body}</body></html>`;
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: {
      document,
      hreflangAlternates: Array.from({ length: alternates }, () => ({})),
    } as unknown as ParsedPage,
    options: {},
  };
  return (await localeMixingRule.run(ctx)).checks;
}

describe("i18n/locale-mixing", () => {
  test("pass: a consistently US-spelled page", async () => {
    const checks = await run(
      "<p>Pick a color, then organize the center panel. Read the license.</p>",
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([["locale-mixing", "pass"]]);
  });

  test("pass: an en-GB page using UK spellings alone is not flagged", async () => {
    const checks = await run(
      "<p>Pick a colour, organise the centre panel, read the licence. Behaviour matters.</p>",
      "en-GB",
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([["locale-mixing", "pass"]]);
  });

  test("pass: a UK page using license as a verb", async () => {
    const checks = await run(
      "<p>We licence the font and license it to you. Your colour, our centre.</p>",
      "en-GB",
    );
    expect(checks[0]!.status).toBe("pass");
  });

  test("warn: US and UK spellings of the same word on one page", async () => {
    const checks = await run("<p>Choose a color. Our colour range, the center and the centre.</p>");
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("spelling-mix");
    expect(checks[0]!.status).toBe("warn");
    expect(checks[0]!.message).toContain("color/colour");
    expect(checks[0]!.message).toContain("center/centre");
  });

  test("warn: organize and organise together", async () => {
    const checks = await run("<p>We organize events. Our organisation is small.</p>", null);
    expect(checks[0]!.name).toBe("spelling-mix");
  });

  test("warn: license as a noun next to licence", async () => {
    const checks = await run("<p>Read the license. Then buy a licence.</p>");
    expect(checks[0]!.name).toBe("spelling-mix");
    expect(checks[0]!.message).toContain("license/licence");
  });

  test("warn: UK spellings on an en-US page, and US spellings on an en-GB page", async () => {
    const uk = await run("<p>The colour and the centre.</p>", "en-US");
    expect(uk[0]!.name).toBe("spelling-lang");
    const us = await run("<p>The color and the center.</p>", "en-GB");
    expect(us[0]!.name).toBe("spelling-lang");
    const one = await run("<p>The colour.</p>", "en-US");
    expect(one[0]!.status).toBe("pass");
  });

  test("fail: DD/MM/YYYY and MM/DD/YYYY on one page", async () => {
    const checks = await run("<p>Posted 25/03/2026. Updated 03/25/2026.</p>");
    const c = checks.find((x) => x.name === "date-mix")!;
    expect(c.status).toBe("fail");
    expect(c.message).toContain("25/03/2026");
  });

  test("pass: ambiguous dates alone, one order alone, and ISO dates", async () => {
    expect((await run("<p>3/4/2026 and 5/6/2026</p>"))[0]!.status).toBe("pass");
    expect((await run("<p>25/03/2026 and 14/02/2026</p>"))[0]!.status).toBe("pass");
    expect((await run("<p>2026-03-25 and 2026-25-03</p>"))[0]!.status).toBe("pass");
  });

  test("warn: bare $ next to a currency code", async () => {
    const checks = await run(
      "<p>Plans from $20 a month, or CAD 25 for Canada. 30 AUD in Australia.</p>",
    );
    const c = checks.find((x) => x.name === "currency-mix")!;
    expect(c.status).toBe("warn");
    expect(c.message).toContain("CAD");
    expect(c.message).toContain("AUD");
  });

  test("pass: bare $ alone, a code alone, and qualified symbols", async () => {
    expect((await run("<p>Only $20 or $30.</p>"))[0]!.status).toBe("pass");
    expect((await run("<p>Only USD 20.</p>"))[0]!.status).toBe("pass");
    expect((await run("<p>US$20 and C$25 and A$30.</p>"))[0]!.status).toBe("pass");
  });

  test("skipped: a page that declares another language, with or without hreflang", async () => {
    const fr = await run("<p>Color colour 25/03/2026 03/25/2026 $5 USD 5</p>", "fr-FR", 3);
    expect(fr).toHaveLength(1);
    expect(fr[0]!.status).toBe("skipped");
    expect(fr[0]!.skipReason).toBe("other-locale");
    expect(fr[0]!.message).toContain("hreflang");
    expect((await run("<p>colour color</p>", "de"))[0]!.status).toBe("skipped");
  });

  test("skipped: no body", async () => {
    const { document } = parseHTML('<html lang="en"></html>');
    (document as unknown as Document).body?.remove();
    const ctx = {
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document: { querySelector: () => null } } as unknown as ParsedPage,
      options: {},
    } as RuleContext;
    expect((await localeMixingRule.run(ctx)).checks[0]!.status).toBe("skipped");
  });

  test("code and script text is not read", async () => {
    const checks = await run(
      "<pre><code>color colour</code></pre><script>var colour = 1</script><p>Fine.</p>",
    );
    expect(checks[0]!.status).toBe("pass");
  });
});
