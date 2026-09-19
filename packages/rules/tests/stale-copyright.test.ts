// content/stale-copyright: a footer year behind the current year is a trust smell.
//
// Every test injects `current_year`. A rule that read the clock itself would pass all
// year and fail every 1 January, which is the worst possible time to learn about it.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { latestCopyrightYear, staleCopyrightRule } from "../src/content/stale-copyright";
import type { ParsedPage, RuleContext } from "../src/types";

const NOW = 2026;

function run(html: string, currentYear: number = NOW, pageUrl = "https://example.com/") {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const ctx: RuleContext = {
    page: { url: pageUrl, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: { current_year: currentYear },
  };
  return staleCopyrightRule.run(ctx).checks;
}

describe("latestCopyrightYear", () => {
  test("reads the plain forms", () => {
    expect(latestCopyrightYear("© 2026 Acme")).toBe(2026);
    expect(latestCopyrightYear("(c) 2026 Acme")).toBe(2026);
    expect(latestCopyrightYear("Copyright 2026 Acme Inc.")).toBe(2026);
    expect(latestCopyrightYear("&copy; 2026 Acme")).toBe(2026);
  });
  test("a range is judged on its END year, not its start", () => {
    expect(latestCopyrightYear("© 2019-2026 Acme")).toBe(2026);
    expect(latestCopyrightYear("© 2019 – 2026 Acme")).toBe(2026);
    expect(latestCopyrightYear("© 2019 to 2026 Acme")).toBe(2026);
  });
  test("the newest notice wins when a footer carries several", () => {
    expect(latestCopyrightYear("© 2019 Acme · © 2026 Acme Labs")).toBe(2026);
  });
  test("no copyright marker means no year, however many numbers are around", () => {
    expect(latestCopyrightYear("Founded 1998. 4000 customers. Suite 2019.")).toBeUndefined();
  });
  test("implausible years are ids or versions, not copyright years", () => {
    // Bounded to 1990-2999: a 4-digit number next to a © is as likely to be a product
    // code or an order id as a year, and inventing a "stale" year from one is worse
    // than staying quiet.
    expect(latestCopyrightYear("© 1200 Acme")).toBeUndefined();
    expect(latestCopyrightYear("© 9999 Acme")).toBeUndefined();
    expect(latestCopyrightYear("© 2026 Acme")).toBe(2026);
  });
});

describe("staleCopyrightRule", () => {
  test("current year in the footer passes", () => {
    const [check] = run("<footer>© 2026 Acme</footer>");
    expect(check?.status).toBe("pass");
  });

  test("a year behind the current year warns — never errors", () => {
    const [check] = run("<footer>© 2024 Acme</footer>");
    expect(check?.status).toBe("warn");
    expect(check?.value).toBe(2024);
    expect(check?.expected).toBe(NOW);
    // Severity is a rule-level property; assert it so nobody promotes this to a hard failure.
    expect(staleCopyrightRule.meta.severity).toBe("warning");
    expect(check?.componentOccurrences).toHaveLength(1);
    expect(check?.componentOccurrences?.[0]).toMatchObject({
      groupable: true,
      confidence: "observed",
      region: { role: "footer", nestedIn: "none" },
      defect: { kind: "stale-copyright", values: { year: 2024, currentYear: NOW } },
    });
  });

  test("preserves distinct copyright elements but not superseded older notices", () => {
    const [check] = run(
      "<footer><span>© 2022 Acme</span><span>© 2024 Acme</span><span>© 2024 Other</span></footer>",
    );
    expect(check?.value).toBe(2024);
    expect(check?.componentOccurrences).toHaveLength(2);
    expect(check?.componentOccurrences?.map((occurrence) => occurrence.element.locator)).toEqual([
      "footer:1>footer>span:2",
      "footer:1>footer>span:3",
    ]);
  });

  test("does not duplicate one nested copyright element matched through overlapping footer selectors", () => {
    const [check] = run('<footer><div class="footer"><p>© 2024 Acme</p></div></footer>');
    expect(check?.componentOccurrences).toHaveLength(1);
    expect(check?.componentOccurrences?.[0]?.element.locator).toBe("footer:1>footer>div:1>p:1");
  });

  test("article-local footers do not shift a shared site footer's region slot", () => {
    const withArticleFooter = run(
      "<article><footer>© 2024 Article</footer></article><footer>© 2024 Acme</footer>",
      NOW,
      "https://example.com/a/",
    )[0]!;
    const plainPage = run("<footer>© 2024 Acme</footer>", NOW, "https://example.com/b/")[0]!;
    const siteFooter = withArticleFooter.componentOccurrences?.find(
      (occurrence) => occurrence.groupable,
    )!;
    const plainFooter = plainPage.componentOccurrences?.[0]!;
    expect(siteFooter.element.locator).toBe("footer:1>footer");
    expect(siteFooter.family).toEqual(plainFooter.family);
    expect(siteFooter.variant).toEqual(plainFooter.variant);
  });

  test("a range ending this year is clean; ending last year is not", () => {
    expect(run("<footer>© 2019-2026 Acme</footer>")[0]?.status).toBe("pass");
    expect(run("<footer>© 2019-2025 Acme</footer>")[0]?.status).toBe("warn");
  });

  test("a year ahead of now is not a finding — sites roll over early", () => {
    expect(run("<footer>© 2027 Acme</footer>")[0]?.status).toBe("pass");
  });

  test("site-chrome regions other than <footer> are matched", () => {
    for (const html of [
      '<div role="contentinfo">© 2024 Acme</div>',
      '<div class="site-footer">© 2024 Acme</div>',
      '<div id="colophon">© 2024 Acme</div>',
    ])
      expect(run(html)[0]?.status).toBe("warn");
  });

  test("no footer at all is skipped, not passed", () => {
    const [check] = run("<main><p>© 2024 Acme</p></main>");
    expect(check?.status).toBe("skipped");
    expect(check?.skipReason).toBe("no-footer");
  });

  test("a footer with no copyright notice is skipped", () => {
    const [check] = run("<footer><a href='/privacy'>Privacy</a></footer>");
    expect(check?.status).toBe("skipped");
    expect(check?.skipReason).toBe("no-copyright-year");
  });

  // The false-positive that would make this rule unshippable: a historical year in
  // body copy is correct as written, and an archived post is SUPPOSED to say 2019.
  test("historical years in body copy stay clean", () => {
    const [check] = run(
      `<article>
         <p>Originally published © 2019 by Acme Press. The 2019-2020 season was our first.</p>
       </article>
       <footer>© 2026 Acme</footer>`,
    );
    expect(check?.status).toBe("pass");
    expect(check?.value).toBe(2026);
  });

  test("a dated legal notice in the body does not drag the footer down", () => {
    const [check] = run(
      `<main><section class="legal">Terms of Service, last revised © 2021.</section></main>
       <footer>© 2026 Acme</footer>`,
    );
    expect(check?.status).toBe("pass");
  });

  test("the year is injected, so the verdict moves with the caller's clock, not ours", () => {
    expect(run("<footer>© 2025 Acme</footer>", 2025)[0]?.status).toBe("pass");
    expect(run("<footer>© 2025 Acme</footer>", 2026)[0]?.status).toBe("warn");
  });
});
