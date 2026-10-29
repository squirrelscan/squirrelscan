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

// Guard: a selector string with a template substitution inside an attribute
// value (`[name="${x}"]`, `[for='${x}']`) is how #1276 happened. Use
// src/shared/attribute-lookup.ts instead.
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

  test("no selector interpolates a value into an attribute match", () => {
    const pattern = /\[[\w:-]+[~|^$*]?=["']?\$\{/;
    const offenders = files.filter((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .some((line) => /(querySelector(All)?|closest|matches|OutsideNoscript)\(/.test(line) && pattern.test(line))
    );
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
