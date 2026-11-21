// pub#1002: frame-title, object-alt and empty-heading read visibility through
// the shared hidden-control reader (shared/static-hidden.ts), like the rules
// moved in #998: out of the accessibility tree is skipped and counted, a style
// that may hide the element is `<check>-unconfirmed`, a visible one still fails.

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, Rule, RuleContext } from "../src/types";

import { emptyHeadingRule } from "../src/a11y/empty-heading";
import { frameTitleRule } from "../src/a11y/frame-title";
import { objectAltRule } from "../src/a11y/object-alt";
import { SCRIPT_STATE_LABEL } from "../src/shared/static-hidden";

type AnyRule = Pick<Rule, "run">;

async function checks(rule: AnyRule, html: string): Promise<CheckResult[]> {
  const url = "https://example.com/";
  return (
    await rule.run({
      page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, url) as ParsedPage,
      options: {},
    })
  ).checks as CheckResult[];
}

const LINK = '<link rel="stylesheet" href="/site.css">';

function page(head: string, body: string): string {
  return `<!doctype html><html lang="en" class="js"><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

interface Case {
  rule: AnyRule;
  check: string;
  failStatus: "fail" | "warn";
  /** The unnamed element, with `attrs` spliced onto it. */
  el: (attrs: string) => string;
}

const CASES: Case[] = [
  {
    rule: frameTitleRule,
    check: "frame-title",
    failStatus: "fail",
    el: (a) => `<iframe src="https://example.org/embed" ${a}></iframe>`,
  },
  {
    rule: objectAltRule,
    check: "object-alt",
    failStatus: "warn",
    el: (a) => `<object data="/a.pdf" ${a}></object>`,
  },
  {
    rule: emptyHeadingRule,
    check: "empty-heading",
    failStatus: "warn",
    el: (a) => `<h2 ${a}></h2>`,
  },
];

describe.each(CASES)("$check", ({ rule, check, failStatus, el }) => {
  const summary = async (html: string) =>
    (await checks(rule, html)).map((c) => [c.name, c.status]);

  test("a visible unnamed element still fails, with or without an unread sheet", async () => {
    for (const head of ["", LINK, LINK + "<style>.x{display:flex}</style>"]) {
      expect(await summary(page(head, el("")))).toEqual([[check, failStatus]]);
    }
  });

  test("hidden, aria-hidden, display:none, closed dialog: skipped and counted", async () => {
    for (const body of [
      el("hidden"),
      `<div aria-hidden="true">${el("")}</div>`,
      el('style="display:none"'),
      `<dialog>${el("")}</dialog>`,
      `<style>.x{display:none}</style>${el('class="x"')}`,
    ]) {
      const out = await checks(rule, page("", body));
      expect(out).toHaveLength(1);
      expect(out[0]?.status).toBe("pass");
      expect(out[0]?.details).toMatchObject({ hiddenWithoutName: 1 });
    }
  });

  test("a no-js fallback on a page with an unread stylesheet is unconfirmed, with the script-state reason", async () => {
    const out = await checks(rule, page(LINK, el('class="no-js"')));
    expect(out.map((c) => [c.name, c.status])).toEqual([
      [`${check}-unconfirmed`, "warn"],
    ]);
    expect(out[0]?.items?.[0]?.label).toBe(SCRIPT_STATE_LABEL);
  });

  test("all styles read: a no-js fallback keeps failing", async () => {
    expect(await summary(page("", el('class="no-js"')))).toEqual([
      [check, failStatus],
    ]);
  });

  test("a style squirrel cannot settle is unconfirmed, not failed", async () => {
    const head =
      "<style>.x:hover{display:none}@media print{.x{display:none}}</style>";
    expect(await summary(page(head, el('class="x"')))).toEqual([
      [`${check}-unconfirmed`, "warn"],
    ]);
  });

  test("a hidden element beside a visible one: only the visible one is reported", async () => {
    const out = await checks(rule, page("", el("hidden") + el('id="v"')));
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe(failStatus);
    expect(out[0]?.items).toHaveLength(1);
  });
});

describe("naming still wins over hidden state", () => {
  test("a named iframe in a no-js wrapper passes", async () => {
    const out = await checks(
      frameTitleRule,
      page(
        LINK,
        '<div class="no-js"><iframe title="Demo" src="/x"></iframe></div>'
      )
    );
    expect(out.map((c) => [c.name, c.status])).toEqual([
      ["frame-title", "pass"],
    ]);
  });

  test("presentational objects and frames are still skipped", async () => {
    expect(
      (
        await checks(
          objectAltRule,
          page("", '<object role="presentation"></object>')
        )
      )[0]?.status
    ).toBe("pass");
    expect(
      (
        await checks(
          frameTitleRule,
          page("", '<iframe role="none" src="/x"></iframe>')
        )
      )[0]?.status
    ).toBe("pass");
  });
});
