// pub#1015: a page over the style reader's rule cap answers "unknown" for any
// element a rule could hide, never "shown". Before, the reader dropped every rule
// at the cap, so an element hidden by 5,000 flat rules read shown (and an unnamed
// control inside it FAILED) while at 4,900 it read hidden.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { buttonNameRule } from "../src/a11y/button-name";
import { createStaticVisibility } from "../src/shared/static-hidden";
import type { ParsedPage, RuleContext } from "../src/types";

const page = (rules: number, body: string): string => {
  const filler = Array.from({ length: rules - 1 }, (_, i) => `.f${i}{display:none}`).join("");
  return `<!doctype html><html lang="en"><head><title>t</title><style>.gone{display:none}${filler}</style></head><body>${body}</body></html>`;
};

function state(rules: number, id = "t"): string {
  const html = page(rules, `<div class="gone" id="t"><p id="u">x</p></div><p id="s">shown</p>`);
  const { document } = parsePage(html, "https://example.com/") as unknown as { document: Document };
  const vis = createStaticVisibility({ ariaHidden: true });
  return vis.visibility(document.getElementById(id) as Element).state;
}

function buttonChecks(rules: number): string[] {
  const html = page(rules, `<main><div class="gone"><button></button></div></main>`);
  const url = "https://example.com/";
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  return (buttonNameRule.run(ctx).checks as CheckResult[]).map((c) => `${c.name}:${c.status}`);
}

function stateOf(css: string, body: string, id = "t"): string {
  const html = `<!doctype html><html lang="en"><head><title>t</title><style>${css}</style></head><body>${body}</body></html>`;
  const { document } = parsePage(html, "https://example.com/") as unknown as { document: Document };
  return createStaticVisibility({ ariaHidden: true }).visibility(
    document.getElementById(id) as Element,
  ).state;
}

describe("the style rule cap (pub#1015)", () => {
  test("4,900 hiding rules read the element hidden; 5,000 and 5,100 read it unknown", () => {
    expect(state(4_900)).toBe("hidden");
    expect(state(5_000)).toBe("unknown");
    expect(state(5_100)).toBe("unknown");
  });

  test("a descendant of the hidden element and an unrelated element are unknown over the cap", () => {
    expect(state(5_100, "u")).toBe("unknown");
    expect(state(5_100, "s")).toBe("unknown");
    expect(state(4_900, "s")).toBe("shown");
  });

  test("an unnamed button in the hidden element is unconfirmed over the cap, not a failure", () => {
    expect(buttonChecks(4_900)).not.toContain("button-name:fail");
    expect(buttonChecks(5_000)).toEqual(["button-name-unconfirmed:warn"]);
    expect(buttonChecks(5_100)).toEqual(["button-name-unconfirmed:warn"]);
  });

  test("reading the over-cap page costs about the same as the capped one", () => {
    const time = (n: number) => {
      const start = performance.now();
      for (let i = 0; i < 3; i++) state(n);
      return performance.now() - start;
    };
    time(5_100); // warm up
    expect(time(5_100)).toBeLessThan(time(4_900) * 3 + 50);
  });

  test("a no-break space in the stylesheet: the rules in it are unknown, not absent", () => {
    // U+00A0 is part of a CSS name, so the reader does not read the rule.
    const css = "\u00a0.gone{display:none}";
    expect(stateOf(css, '<div class="gone" id="t"><p id="u">x</p></div>')).toBe("unknown");
    expect(stateOf(css, '<div class="gone"><p id="u">x</p></div>', "u")).toBe("unknown");
  });

  test("more selector entries than the cap: unknown, not shown", () => {
    // 4 rules x 6,000 selectors: under the rule cap, over the entry cap.
    const list = (from: number) =>
      Array.from({ length: 6_000 }, (_, i) => `.e${from + i}`).join(",");
    const css = `.gone{display:none}${[0, 1, 2, 3].map((k) => `${list(k * 6_000)}{display:none}`).join("")}`;
    expect(stateOf(css, '<div class="gone" id="t"></div>')).toBe("unknown");
  });

  test("the give-up result is fresh per page: one page spending its steps leaves the next whole", () => {
    expect(state(5_100)).toBe("unknown");
    expect(state(4_900)).toBe("hidden");
    expect(stateOf(".gone{display:none}", '<div class="gone" id="t"></div>')).toBe("hidden");
  });
});
