// #1270 and #1276: no rule may throw on a page with no markup, and none may
// build a selector from a page-controlled id, `for`, `role` or `name`.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { parsePage } from "@squirrelscan/parser";

import { ariaCommandNameRule } from "../src/a11y/aria-command-name";
import { ariaInputFieldNameRule } from "../src/a11y/aria-input-field-name";
import { ariaMeterNameRule } from "../src/a11y/aria-meter-name";
import { ariaProgressbarNameRule } from "../src/a11y/aria-progressbar-name";
import { ariaRequiredParentRule } from "../src/a11y/aria-required-parent";
import { ariaToggleFieldNameRule } from "../src/a11y/aria-toggle-field-name";
import { formFieldMultipleLabelsRule } from "../src/a11y/form-field-multiple-labels";
import { formLabelsRule } from "../src/a11y/form-labels";
import { selectNameRule } from "../src/a11y/select-name";
import { formCaptchaRule } from "../src/security/form-captcha";
import { RuleRunner } from "../src/runner";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

const URL_ = "https://example.com/";

function runRule(rule: Rule, html: string) {
  const ctx: RuleContext = {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL_) as ParsedPage,
    options: {},
  };
  return rule.run(ctx);
}

describe("#1270: no rule throws on a page without markup", () => {
  const BODIES = ["", "   ", "<!-- c -->", "plain text", '{"json":1}', "<!doctype html>"];
  for (const html of BODIES) {
    test(`every rule on ${JSON.stringify(html)}`, async () => {
      const runner = new RuleRunner({
        config: { rule_options: {}, rules: { enable: ["*"], disable: [] } } as never,
      });
      const result = await runner.runPageRules({
        url: URL_,
        html,
        statusCode: 200,
        loadTime: 0,
        headers: { "content-type": "text/html" },
      });
      const errors = result.checks.filter((c) => c.message?.startsWith("Rule error:"));
      expect(errors.map((c) => `${c.name}: ${c.message}`)).toEqual([]);
    });
  }
});

// Ids that broke `label[for="${id}"]`: a quote, a backslash, a bracket, a space.
const HOSTILE = ['a"b', "a\\b", "a]b", "a b", `a"]x[y="`];

describe("#1276: hostile ids and roles do not break the selector rules", () => {
  const pageWith = (body: string) =>
    `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

  for (const id of HOSTILE) {
    const esc = id.replace(/"/g, "&quot;");
    test(`label for=${JSON.stringify(id)} still associates`, () => {
      const labelled = (type: string, extra = "") =>
        pageWith(`<label for="${esc}">Name</label><input type="${type}" id="${esc}"${extra}>`);
      for (const rule of [formLabelsRule, formFieldMultipleLabelsRule, ariaInputFieldNameRule, selectNameRule]) {
        expect(() => runRule(rule, labelled("text"))).not.toThrow();
      }
      // The label names the field, so the name rules stay quiet.
      const named = runRule(formLabelsRule, labelled("text")).checks;
      expect(named.every((c) => c.status !== "fail" && c.status !== "warn")).toBe(true);
      const roleNamed = runRule(
        ariaInputFieldNameRule,
        pageWith(`<label for="${esc}">Name</label><div role="textbox" id="${esc}" tabindex="0"></div>`)
      ).checks;
      expect(roleNamed.every((c) => c.status !== "fail")).toBe(true);
      const sel = runRule(
        selectNameRule,
        pageWith(`<label for="${esc}">Pick</label><select id="${esc}"><option>a</option></select>`)
      ).checks;
      expect(sel.every((c) => c.status !== "fail")).toBe(true);
    });

    test(`two labels for ${JSON.stringify(id)} are counted`, () => {
      const html = pageWith(`<label for="${esc}">A</label><label for="${esc}">B</label><input type="text" id="${esc}">`);
      const checks = runRule(formFieldMultipleLabelsRule, html).checks;
      expect(checks.some((c) => c.status === "warn")).toBe(true);
    });

    test(`toggle, meter, progressbar, command, parent with id ${JSON.stringify(id)}`, () => {
      const html = pageWith(
        `<label for="${esc}">L</label><div role="checkbox" id="${esc}" tabindex="0"></div>` +
          `<div role="meter" id="${esc}2"></div><div role="progressbar" id="${esc}3"></div>` +
          `<div role="button" id="${esc}4" tabindex="0">x</div><div role="listitem" id="${esc}5">i</div>`
      );
      for (const rule of [
        ariaToggleFieldNameRule,
        ariaMeterNameRule,
        ariaProgressbarNameRule,
        ariaCommandNameRule,
        ariaRequiredParentRule,
        formCaptchaRule,
      ]) {
        expect(() => runRule(rule, html)).not.toThrow();
      }
    });
  }

  test("a label for the right id is not confused with a similar one", () => {
    const html = pageWith(`<label for="a b">L</label><input type="text" id="a">`);
    const checks = runRule(formLabelsRule, html).checks;
    expect(checks.some((c) => c.status === "fail" || c.status === "warn")).toBe(true);
  });
});

// Guard: a selector built with a template substitution is how #1276 happened.
// Every selector call (querySelector, querySelectorAll, closest, matches and the
// noscript-aware helper) is read across lines, and a call that passes a variable
// is traced to the template the variable was assigned. Any `${...}` in it fails
// unless it is one of the known constant interpolations below: values from a
// fixed table in the rule itself, never from the page. Page values go through
// src/shared/attribute-lookup.ts instead.
const CONSTANT_SELECTORS: Array<{ file: string; snippet: string }> = [
  { file: "security/form-captcha.ts", snippet: "`.${className}`" },
  { file: "security/form-captcha.ts", snippet: "`#${fieldName}`" },
  { file: "a11y/duplicate-id-aria.ts", snippet: "`[${attr}]`" },
  // The attribute NAME, a literal at every call site; the value is compared as a string.
  { file: "shared/attribute-lookup.ts", snippet: "`[${attr}]`" },
  { file: "security/mixed-content.ts", snippet: "`${selector}[${attribute}]`" },
];

const SELECTOR_CALL = /\b(querySelectorAll|querySelector|closest|matches|querySelectorAllOutsideNoscript)\(/g;

/** The text of the call's first argument, from just after `(` to the top-level `,` or the closing `)`. */
function firstArgument(source: string, open: number): string {
  let depth = 0;
  let template = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "`") template = !template;
    if (template) continue;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return source.slice(open, i);
      depth--;
    } else if (c === "," && depth === 0) return source.slice(open, i);
  }
  return source.slice(open);
}

describe("#1276 guard", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  walk(SRC);

  /** Every selector argument in `source`, with a bare variable replaced by what it was assigned. */
  function selectorArguments(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(SELECTOR_CALL)) {
      let arg = firstArgument(source, match.index! + match[0].length).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
        for (const a of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(`[^`]*`)/g)) {
          if (a[1] === arg) found.push(a[2]!);
        }
        arg = "";
      }
      found.push(arg);
    }
    return found;
  }

  test("no selector interpolates a value, except the known constants", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(SRC.length + 1);
      for (const arg of selectorArguments(readFileSync(file, "utf8"))) {
        if (!arg.includes("${")) continue;
        if (CONSTANT_SELECTORS.some((c) => c.file === rel && arg.includes(c.snippet))) continue;
        offenders.push(`${rel}: ${arg.replace(/\s+/g, " ").slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the guard sees multi-line calls, variables and #/. selectors", () => {
    expect(
      selectorArguments("doc.querySelector(\n  `label[for='${id}']`\n)").some((a) => a.includes("${"))
    ).toBe(true);
    expect(selectorArguments("const sel = `#${id}`;\ndoc.querySelector(sel);").some((a) => a.includes("${"))).toBe(true);
    expect(selectorArguments("el.closest(`.${cls}`)").some((a) => a.includes("${"))).toBe(true);
    expect(selectorArguments('doc.querySelectorAll("a[href]")').some((a) => a.includes("${"))).toBe(false);
  });
});
