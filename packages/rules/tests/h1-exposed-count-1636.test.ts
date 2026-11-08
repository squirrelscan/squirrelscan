// core/h1 separates the raw H1 count from the exposed one (#1636).
//
// A page with one shown H1 and two hidden alternatives used to read
// `Multiple H1 tags found (3)`, exactly like a page with three shown H1s. The
// raw count stays on the check as `rawCount`, the exposed count is reported
// beside it, and the message says the audit reads markup, not rendered CSS.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { h1Rule } from "../src/core/h1";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string, head = ""): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = h1Rule.run(ctx);
  if (result instanceof Promise) throw new Error("core/h1 is async");
  return result.checks;
}

function only(checks: CheckResult[]): CheckResult {
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
}

const NOTE = "an HTTP-only audit cannot resolve visibility set by external stylesheets or scripts";

describe("#1636 raw and exposed H1 counts", () => {
  test("/hidden-h1: one exposed H1 and two hidden alternatives is not three visible headings", () => {
    const check = only(
      run(`<h1>Primary</h1><h1 style="display:none">Alternative</h1><h1 hidden>Alternative</h1>`)
    );
    expect(check.name).toBe("h1");
    expect(check.status).toBe("pass");
    expect(check.message).not.toContain("Multiple");
    expect(check.message).toContain("3 in the HTML, 2 hidden");
    expect(check.message).toContain(NOTE);
    expect(check.value).toBe("Primary");
    expect(check.details).toMatchObject({ rawCount: 3, exposedCount: 1, hiddenCount: 2 });
  });

  test("/visible-h1: three exposed H1s still warn as multiple, message unchanged", () => {
    const check = only(run(`<h1>One</h1><h1>Two</h1><h1>Three</h1>`));
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Multiple H1 tags found (3)");
    expect(check.value).toBe(3);
    expect(check.details).toBeUndefined();
  });

  test("two exposed and one hidden warn on the exposed count, with the raw count kept", () => {
    const check = only(run(`<h1>One</h1><h1>Two</h1><h1 hidden>Three</h1>`));
    expect(check.name).toBe("h1");
    expect(check.status).toBe("warn");
    expect(check.message).toContain("Multiple H1 tags found (2 exposed, 3 in the HTML;");
    expect(check.message).toContain(NOTE);
    expect(check.value).toBe(2);
    expect(check.details).toMatchObject({ rawCount: 3, exposedCount: 2, hiddenCount: 1 });
  });

  test("an H1 a style may hide is reported as unconfirmed, not as a visible duplicate", () => {
    const checks = run(
      `<h1>Primary</h1><h1 class="alt">Alternative</h1>`,
      `<link rel="stylesheet" href="/site.css"><style>.alt { display: none }</style>`
    );
    const check = only(checks);
    expect(check.name).toBe("h1-unconfirmed");
    expect(check.status).toBe("warn");
    expect(check.message).toContain("1 may be hidden by a style (unconfirmed;");
    expect(check.details).toMatchObject({ rawCount: 2, exposedCount: 1, hiddenCount: 0, unconfirmedCount: 1 });
  });

  test("an H1 in a closed <dialog> is excluded too", () => {
    const check = only(run(`<h1>Primary</h1><dialog><h1>D</h1></dialog>`));
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({ rawCount: 2, exposedCount: 1, hiddenCount: 1 });
  });

  test("an H1 inside <template> is not in the raw count at all", () => {
    // The parser keeps template contents out of the document, as browsers do.
    const check = only(run(`<h1>Primary</h1><template><h1>T</h1></template>`));
    expect(check).toMatchObject({ status: "pass", message: "Single H1 tag present" });
  });

  test("aria-hidden does not hide an H1 from the page", () => {
    const check = only(run(`<h1>One</h1><h1 aria-hidden="true">Two</h1>`));
    expect(check.message).toBe("Multiple H1 tags found (2)");
  });

  test("the one exposed H1 is checked for emptiness", () => {
    const check = only(run(`<h1></h1><h1 hidden>Alternative</h1>`));
    expect(check.status).toBe("warn");
    expect(check.message).toBe("H1 tag is empty");
    expect(check.details).toMatchObject({ rawCount: 2, exposedCount: 1, hiddenCount: 1 });
  });

  test("when every H1 is hidden the raw count is still reported", () => {
    const check = only(run(`<h1 hidden>One</h1><h1 hidden>Two</h1>`));
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Multiple H1 tags found (2)");
    expect(check.details).toMatchObject({ rawCount: 2, exposedCount: 0, hiddenCount: 2 });
  });

  test("single and missing H1 behaviour is unchanged", () => {
    expect(only(run(`<h1>Only</h1>`))).toMatchObject({ status: "pass", message: "Single H1 tag present" });
    expect(only(run(`<p>none</p>`))).toMatchObject({ status: "fail", message: "No H1 tag found" });
    expect(only(run(`<h1 hidden>Only</h1>`))).toMatchObject({ status: "pass", message: "Single H1 tag present" });
  });
});
