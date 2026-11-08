// a11y/aria-required-parent skips implicit roles under presentational-children ancestors (#1640).
//
// `ol[role=progressbar]` resolves to progressbar, so its four `li` children
// were each reported as a listitem with no list parent. A progressbar's
// children are presentational (WAI-ARIA 1.2), and Chromium marks those `li`
// nodes ignored with `presentationalRole`, so only a genuine orphan `li` is
// actionable. A focusable descendant keeps its semantics and is still checked.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { ariaRequiredParentRule } from "../src/a11y/aria-required-parent";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string): CheckResult {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body><h1>Repro</h1>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = ariaRequiredParentRule.run(ctx);
  if (result instanceof Promise) throw new Error("aria-required-parent is async");
  const check = result.checks.find((c) => c.name === "aria-required-parent");
  if (!check) throw new Error("no aria-required-parent check");
  return check;
}

const ORPHAN_LI = { id: 'li (implicit role="listitem"): needs parent with role=list|group' };

describe("#1640 presentational-children ancestors", () => {
  test("the issue repro reports only the true orphan li", () => {
    const check = run(
      `<ol role="progressbar" aria-label="Bundle progress" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0">` +
        `<li>One</li><li>Two</li><li>Three</li><li>Four</li></ol>` +
        `<ul><li>Valid list control</li></ul>` +
        `<li>True orphan control</li>`
    );
    expect(check.status).toBe("fail");
    expect(check.message).toBe("1 element(s) missing required parent role");
    expect(check.items).toEqual([ORPHAN_LI]);
  });

  test("a plain ul > li passes", () => {
    expect(run(`<ul><li>One</li></ul>`).status).toBe("pass");
  });

  test("a genuine orphan li still fails", () => {
    expect(run(`<div><li>Orphan</li></div>`).items).toEqual([ORPHAN_LI]);
  });

  test.each([
    "progressbar",
    "img",
    "button",
    "checkbox",
    "slider",
    "PROGRESSBAR",
    "progressbar list",
  ])("implicit roles under role=%s are not flagged", (role) => {
    const check = run(
      `<div role="${role}" aria-label="x">` +
        `<li>a</li><table><tr><td>c</td><th>h</th></tr></table>` +
        `<tr><td>row</td></tr><tbody></tbody><option>o</option></div>`
    );
    expect(check.status).toBe("pass");
  });

  test("native <progress> and <meter> fallback content is not flagged", () => {
    expect(run(`<progress value="1" max="4"><li>fallback</li></progress>`).status).toBe("pass");
    expect(run(`<meter value="1" max="4"><li>fallback</li></meter>`).status).toBe("pass");
  });

  test.each([
    ["tabindex", `<li tabindex="0">Focusable</li>`],
    ["tabindex=-1", `<li tabindex="-1">Focusable</li>`],
    ["contenteditable", `<li contenteditable="true">Editable</li>`],
  ])("a focusable li (%s) under a progressbar is still evaluated", (_label, li) => {
    const check = run(`<ol role="progressbar" aria-label="x">${li}<li>Plain</li></ol>`);
    expect(check.status).toBe("fail");
    expect(check.items).toEqual([ORPHAN_LI]);
  });

  test('contenteditable="false" does not make the li focusable', () => {
    expect(run(`<ol role="progressbar" aria-label="x"><li contenteditable="false">x</li></ol>`).status).toBe(
      "pass"
    );
  });

  test("an implicit button (summary, native button) does not exempt its descendants", () => {
    expect(run(`<div><summary><li>Orphan</li></summary></div>`).items).toEqual([ORPHAN_LI]);
    expect(run(`<button><li>Orphan</li></button>`).items).toEqual([ORPHAN_LI]);
  });

  test("a role=tab ancestor inside a tablist exempts its implicit descendants", () => {
    expect(run(`<div role="tablist"><div role="tab"><li>a</li></div></div>`).status).toBe("pass");
  });

  test("an unrelated role (region) does not exempt its descendants", () => {
    expect(run(`<div role="region" aria-label="x"><li>Orphan</li></div>`).items).toEqual([ORPHAN_LI]);
  });

  test("explicit child roles under a progressbar are still checked", () => {
    const check = run(`<div role="progressbar" aria-label="x"><span role="tab">t</span></div>`);
    expect(check.items).toEqual([{ id: 'span[role="tab"]: needs parent with role=tablist' }]);
  });
});
