// A page rule that caps its items records the remainder in `details.additional`
// (pub#474).
//
// The smart-audits merge reads a fail/warn check's items as the page's COMPLETE
// list when no remainder is recorded, and resolves a prior item the list leaves
// out. A rule that slices its items without saying so would make a cut-off item
// look fixed. Several a11y and performance rules did exactly that.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { parsePage } from "@squirrelscan/parser";
import { parseHTML } from "@squirrelscan/parser/dom";

import { labelContentNameMismatchRule } from "../src/a11y/label-content-name-mismatch";
import { tabindexRule } from "../src/a11y/tabindex";
import { devLeakageRule } from "../src/content/dev-leakage";
import { hiddenTextRule } from "../src/content/hidden-text";
import type { CheckResult, ParsedPage, Rule, RuleContext } from "../src/types";

function run(rule: Rule, body: string): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body><h1>Repro</h1>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error(`${rule.meta.id} is async`);
  return result.checks;
}

function check(checks: CheckResult[], name: string): CheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no ${name} check`);
  return found;
}

const repeat = (n: number, html: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => html(i)).join("");

describe("rules that cap items record the remainder", () => {
  test("a11y/tabindex: 12 positive tabindex values list 10 and record 2 more", () => {
    const c = check(
      run(tabindexRule, repeat(12, (i) => `<button id="b${i}" tabindex="${i + 1}">b</button>`)),
      "tabindex-positive",
    );
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(10);
    expect(c.details?.additional).toBe(2);
  });

  test("a11y/tabindex: a list under the cap records no remainder", () => {
    const c = check(
      run(tabindexRule, repeat(3, (i) => `<button id="b${i}" tabindex="${i + 1}">b</button>`)),
      "tabindex-positive",
    );
    expect(c.items).toHaveLength(3);
    expect(c.details?.additional).toBeUndefined();
  });

  test("a11y/tabindex: the very-high check records its own remainder", () => {
    const c = check(
      run(tabindexRule, repeat(11, (i) => `<a id="a${i}" href="/" tabindex="${200 + i}">a</a>`)),
      "tabindex-very-high",
    );
    expect(c.status).toBe("fail");
    expect(c.items).toHaveLength(10);
    expect(c.details?.additional).toBe(1);
  });

  test("a11y/label-content-name-mismatch: 11 mismatches list 10 and record 1 more", () => {
    const c = check(
      run(
        labelContentNameMismatchRule,
        repeat(11, (i) => `<button aria-label="Close dialog ${i}">Open menu ${i}</button>`),
      ),
      "label-content-name-mismatch",
    );
    expect(c.status).toBe("fail");
    expect(c.items).toHaveLength(10);
    expect(c.details?.additional).toBe(1);
  });
});

// A rule that stops at a work budget cannot know what it did not look at, so it
// marks the check `scanTruncated` instead of a remainder count.
function runOnDom(rule: Rule, html: string): CheckResult[] {
  const ctx = {
    page: { url: "https://example.com/about", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: parseHTML(html).document } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error(`${rule.meta.id} is async`);
  return result.checks;
}

const HIDDEN = "cheap discount widgets wholesale supplier best prices online now";

describe("rules that stop at a scan budget say so", () => {
  test("content/hidden-text: findings past the 20,000-element walk are marked", () => {
    const html =
      `<html><head><title>t</title></head><body>` +
      `<div id="one" style="display:none">${HIDDEN}</div>` +
      repeat(20_005, () => "<p>v</p>") +
      `<div id="two" style="display:none">${HIDDEN}</div>` +
      `</body></html>`;
    const c = check(runOnDom(hiddenTextRule, html), "hidden-text");
    expect(c.items?.map((i) => i.id)).toEqual(["div#one"]);
    expect(c.details?.scanTruncated).toBe(true);
  });

  test("content/hidden-text: a stylesheet past the 4,000-rule budget is marked", () => {
    const filler = repeat(4_001, (i) => `.f${i}{color:red}`);
    const html =
      `<html><head><title>t</title><style>${filler}.two{display:none}</style></head><body>` +
      `<div id="one" style="display:none">${HIDDEN}</div>` +
      `<div class="two">${HIDDEN}</div>` +
      `</body></html>`;
    const c = check(runOnDom(hiddenTextRule, html), "hidden-text");
    expect(c.items?.map((i) => i.id)).toEqual(["div#one"]);
    expect(c.details?.scanTruncated).toBe(true);
  });

  test("content/hidden-text: a page walked in full says so explicitly", () => {
    const html =
      `<html><head><title>t</title><style>.two{display:none}</style></head><body>` +
      `<div id="one" style="display:none">${HIDDEN}</div>` +
      `<div class="two">${HIDDEN}</div>` +
      `</body></html>`;
    const c = check(runOnDom(hiddenTextRule, html), "hidden-text");
    expect(c.items).toHaveLength(2);
    expect(c.details?.scanTruncated).toBe(false);
  });

  test("content/dev-leakage: stopping at the attribute hit cap is marked", () => {
    const body = repeat(1_001, (i) => `<a href="http://localhost:3000/p${i}">x</a>`);
    const c = check(
      runOnDom(devLeakageRule, `<html><head><title>t</title></head><body>${body}</body></html>`),
      "dev-leakage",
    );
    expect(c.details?.scanTruncated).toBe(true);
  });

  test("content/dev-leakage: a page scanned in full says so explicitly", () => {
    const body = `<a href="http://localhost:3000/p">x</a>`;
    const c = check(
      runOnDom(devLeakageRule, `<html><head><title>t</title></head><body>${body}</body></html>`),
      "dev-leakage",
    );
    expect(c.status).toBe("fail");
    expect(c.details?.scanTruncated).toBe(false);
  });
});

// Source guard: every fail/warn check object in a page rule that writes
// `items: <list>.slice(0, N)` must mention `additional` in the same object. Info
// and pass checks never become findings, so they are exempt.
const SRC = join(import.meta.dir, "../src");
const CAPPED_ITEMS = /\bitems:\s*[\w.]+\.slice\(0,/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The `{ ... }` literal enclosing `index`, by brace depth. Rule sources keep
 * their braces balanced inside strings, which is all this needs. */
function enclosingObject(source: string, index: number): string {
  let depth = 0;
  let start = index;
  for (; start >= 0; start--) {
    const ch = source[start];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) break;
      depth--;
    }
  }
  depth = 0;
  let end = index;
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) break;
      depth--;
    }
  }
  return source.slice(start, end + 1);
}

test("every capped items list in a page rule's fail/warn check records its remainder", () => {
  const offenders: string[] = [];
  let capped = 0;
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes('scope: "page"')) continue;
    for (const match of source.matchAll(CAPPED_ITEMS)) {
      const object = enclosingObject(source, match.index);
      if (/status:\s*"(info|pass)"/.test(object)) continue;
      capped++;
      if (!object.includes("additional")) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${relative(SRC, file)}:${line}`);
      }
    }
  }
  // The scan must keep finding the caps it guards, or it proves nothing.
  expect(capped).toBeGreaterThan(30);
  expect(offenders).toEqual([]);
});
