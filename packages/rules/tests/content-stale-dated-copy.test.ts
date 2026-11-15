import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { staleDatedCopyRule, hasPassed, parseMachineDate } from "../src/content/stale-dated-copy";
import type { ParsedPage, RuleContext } from "../src/types";
import { expectDeclaredChecks } from "./helpers/declared-checks";

const NOW = "2026-06-15";

function run(
  body: string,
  {
    url = "https://example.com/events/summit",
    head = "",
    title = "Summit",
    headers = {},
    now = NOW,
    bodyClass = "",
  } = {},
): CheckResult {
  const html = `<html><head><title>${title}</title>${head}</head><body class="${bodyClass}">${body}</body></html>`;
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url) as ParsedPage,
    options: { now },
  };
  const out = staleDatedCopyRule.run(ctx) as { checks: CheckResult[] };
  expectDeclaredChecks(staleDatedCopyRule, out.checks);
  expect(out.checks).toHaveLength(1);
  return out.checks[0]!;
}

describe("content/stale-dated-copy", () => {
  test("date helpers compare by calendar month", () => {
    expect(hasPassed({ year: 2026, month: 4 }, { year: 2026, month: 5 })).toBe(true);
    expect(hasPassed({ year: 2026, month: 5 }, { year: 2026, month: 5 })).toBe(false);
    expect(hasPassed({ year: 2026 }, { year: 2026, month: 11 })).toBe(false);
    expect(hasPassed({ year: 2025 }, { year: 2026, month: 0 })).toBe(true);
    expect(parseMachineDate("1700000000000")).toEqual({ year: 2023, month: 10 });
    expect(parseMachineDate("not a date")).toBeUndefined();
  });

  test("pass: future-dated and undated copy is clean", () => {
    const c = run("<p>Coming in 2027. Sale ends December 31, 2026. Join us on March 3, 2027.</p>");
    expect(c.status).toBe("pass");
  });

  test("warn: 'Coming in <past year>'", () => {
    const c = run("<p>Our new dashboard is coming in 2024.</p>");
    expect(c.status).toBe("warn");
    expect((c.details as { claims: { kind: string }[] }).claims[0]!.kind).toBe("coming-year");
  });

  test("warn: 'New for <past year>' and 'Launching <past month year>'", () => {
    expect(run("<h2>New for 2025</h2>").status).toBe("warn");
    expect(run("<p>Launching in March 2026.</p>").status).toBe("warn");
  });

  test("current month is not yet passed", () => {
    expect(run("<p>Launching in June 2026.</p>").status).toBe("pass");
  });

  test("warn: sale end date already passed", () => {
    expect(run("<p>Black Friday sale ends November 29, 2024.</p>").status).toBe("warn");
  });

  test("warn: past time element next to 'register now'", () => {
    const c = run(
      '<p>Register now for the summit on <time datetime="2025-03-04">March 4</time>.</p>',
    );
    expect(c.status).toBe("warn");
  });

  test("past time element without future framing stays clean", () => {
    expect(run('<p>Posted <time datetime="2025-03-04">March 4</time>.</p>').status).toBe("pass");
  });

  test("fail: countdown targeting a past timestamp", () => {
    const c = run('<div class="countdown" data-countdown-to="2025-01-01T00:00:00Z">00:00:00</div>');
    expect(c.status).toBe("fail");
  });

  test("a bare 4-digit countdown value is seconds remaining, not a year", () => {
    expect(parseMachineDate("2000")).toEqual({ year: 2000 });
    expect(parseMachineDate("2000", false)).toBeUndefined();
    expect(run('<div class="countdown" data-countdown="2000">00:33:20</div>').status).toBe("pass");
  });

  test("future countdown is clean", () => {
    expect(
      run('<div class="countdown" data-countdown-to="2027-01-01T00:00:00Z">9d</div>').status,
    ).toBe("pass");
  });

  test("fail: three stale claims on one page", () => {
    const c = run(
      "<p>Coming in 2023.</p><p>New for 2024.</p><p>Early bird ends January 5, 2025.</p>",
    );
    expect(c.status).toBe("fail");
  });

  test("no false positive: retrospective post naming several past years", () => {
    const c = run(
      "<p>In 2019 we launched the first version. Launching in 2021 was hard because we had no users.</p>" +
        "<p>It was coming in 2022 when we opened the second office. We celebrated in March 2023.</p>" +
        "<p>The sale ended on November 29, 2024 and the webinar was held on 4 March 2025.</p>",
    );
    expect(c.status).toBe("pass");
  });

  test("no false positive: retrospective title is skipped", () => {
    const c = run("<p>Coming in 2024 we planned a lot.</p>", { title: "2024 year in review" });
    expect(c.status).toBe("skipped");
  });

  test("skipped: noindex archive page stays clean", () => {
    const c = run("<p>Register now! Coming in 2020. Sale ends May 1, 2020.</p>", {
      head: '<meta name="robots" content="noindex">',
    });
    expect(c.status).toBe("skipped");
    expect(c.skipReason).toBe("noindex");
  });

  test("skipped: archive URL and archive body class", () => {
    const body = "<p>Register now! Join us on May 1, 2020.</p>";
    expect(run(body, { url: "https://example.com/archive/2020/summit" }).skipReason).toBe(
      "archival-page",
    );
    expect(run(body, { bodyClass: "archive date-archive" }).skipReason).toBe("archival-page");
  });

  test("the same stale copy on an indexable live page does warn", () => {
    expect(run("<p>Register now! Join us on May 1, 2020.</p>").status).toBe("warn");
  });

  test("now is injected: the same page flips with the option", () => {
    const body = "<p>Coming in 2026.</p>";
    expect(run(body, { now: "2026-12-31" }).status).toBe("pass");
    expect(run(body, { now: "2027-01-01" }).status).toBe("warn");
  });
});
