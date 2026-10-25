// squirrelscan/repo#3066: a11y/aria-text and a11y/aria-hidden-focus scanned a
// whole subtree per matching element, so nested role="text" or aria-hidden
// containers made them quadratic (aria-hidden-focus cubic: an ancestor walk per
// descendant per container). Both now do one walk. These pin (1) that they
// report exactly what the previous implementations reported, on seeded random
// pages full of the shapes that decide the verdicts, and (2) a time budget on
// the deeply nested shapes.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { ariaHiddenFocusRule } from "../src/a11y/aria-hidden-focus";
import { ariaTextRule } from "../src/a11y/aria-text";
import type { ParsedPage, Rule, RuleContext } from "../src/types";
import { referenceAriaHiddenFocusRule } from "./fixtures/reference-3066/aria-hidden-focus";
import { referenceAriaTextRule } from "./fixtures/reference-3066/aria-text";

const URL = "https://example.com/";

function run(rule: Rule, html: string) {
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  };
  return rule.run(ctx);
}

/** mulberry32: a small seeded PRNG, so every failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;

const CONTAINER_ATTRS = [
  "",
  ' aria-hidden="true"',
  ' aria-hidden="true"',
  ' role="text"',
  ' role="text"',
  " inert",
  " hidden",
  ' hidden="until-found"',
  ' aria-hidden="true" inert',
  ' aria-hidden="true" tabindex="0"',
  ' aria-hidden="true" tabindex="-1"',
  ' role="text" tabindex="0"',
  ' style="display:none"',
  ' style="visibility:hidden"',
  ' style="visibility:visible"',
  ' class="no-js"',
  ' class="m-hide"',
  ' class="maybe"',
];

const LEAVES = [
  '<a href="/x">x</a>',
  "<a>no href</a>",
  "<button>b</button>",
  "<button disabled>b</button>",
  '<input type="text">',
  '<input type="hidden">',
  '<input name="hp_field">',
  '<input id="trap" tabindex="-1">',
  "<select><option>o</option></select>",
  "<textarea></textarea>",
  '<span tabindex="0">t</span>',
  '<span tabindex="2">t</span>',
  '<span tabIndex="0">t</span>',
  '<span tabindex="-1">t</span>',
  '<span tabindex="abc">t</span>',
  '<div contenteditable="true">e</div>',
  "<video controls></video>",
  "<details><summary>s</summary>d</details>",
  '<button style="display:none">b</button>',
  '<button style="visibility:visible">b</button>',
  "<p>text</p>",
  // Container attributes on the controls themselves.
  '<input name="hp_field" aria-hidden="true">',
  '<input id="hp-x" aria-hidden="true" style="display:none">',
  '<a href="/x" aria-hidden="true">x</a>',
  '<button aria-hidden="true" class="maybe">b</button>',
  '<span role="text" tabindex="0">t</span>',
  // Templates: the old document-wide queries never entered their content.
  '<template><a href="/t">t</a></template>',
  '<template aria-hidden="true"><button>b</button></template>',
  '<template role="text"><a href="/t">t</a></template>',
  '<svg><a href="/s">s</a></svg>',
];

/** A random tree of containers and leaves, `depth` levels at most. */
function tree(r: () => number, depth: number): string {
  if (depth === 0 || r() < 0.25) return pick(r, LEAVES);
  const tag = pick(r, ["div", "span", "section", "button", 'a href="/c"', "form", "template"]);
  const name = tag.split(" ")[0]!;
  const id = r() < 0.3 ? ` id="c${Math.floor(r() * 1000)}"` : "";
  const children = Array.from({ length: 1 + Math.floor(r() * 3) }, () => tree(r, depth - 1)).join(
    "",
  );
  return `<${tag}${pick(r, CONTAINER_ATTRS)}${id}>${children}</${name}>`;
}

function page(seed: number): string {
  const r = rng(seed);
  const style =
    r() < 0.5
      ? "<style>.m-hide{display:none} @media (max-width:600px){.maybe{display:none}}</style>"
      : "";
  const external = r() < 0.2 ? '<link rel="stylesheet" href="/site.css">' : "";
  const body = Array.from({ length: 1 + Math.floor(r() * 4) }, () => tree(r, 6)).join("");
  // Document shapes: wrapped; no <html> tag; a warning printed ahead of the
  // doctype; content after </html>. All but the first have several top-level
  // elements in the parsed document.
  switch (Math.floor(r() * 4)) {
    case 1:
      return `<!doctype html><title>t</title>${style}${external}${body}`;
    case 2:
      return `<br />\n<b>Warning</b>: x<!doctype html><html><head>${style}${external}</head><body>${body}</body></html>`;
    case 3:
      return `<!doctype html><html><head>${style}${external}</head><body><p>p</p></body></html>${body}`;
    default:
      return `<!doctype html><html lang="en"><head>${style}${external}</head><body><main>${body}</main></body></html>`;
  }
}

describe("the single-pass rewrites report what the old rules did (#3066)", () => {
  for (const [name, rule, reference] of [
    ["aria-text", ariaTextRule, referenceAriaTextRule],
    ["aria-hidden-focus", ariaHiddenFocusRule, referenceAriaHiddenFocusRule],
  ] as const) {
    test(`${name}: identical results on 600 seeded random pages`, { timeout: 30_000 }, () => {
      let nonTrivial = 0;
      for (let seed = 1; seed <= 600; seed++) {
        const html = page(seed);
        const actual = run(rule, html);
        const expected = run(reference, html);
        // The seed in the message makes a failure reproducible.
        expect({ seed, ...actual }).toEqual({ seed, ...expected });
        if (expected.checks.some((c) => c.status === "warn" || c.status === "fail")) nonTrivial++;
      }
      // Non-vacuous: most pages produce findings.
      expect(nonTrivial).toBeGreaterThan(200);
    });
  }

  test("nested containers file a control once per container, in container order", () => {
    const html = `<!doctype html><html><body>
      <div aria-hidden="true" id="outer"><a href="/1">1</a>
        <div aria-hidden="true" id="inner"><button id="b">b</button></div>
      </div>
      <span role="text" id="t1"><a href="/2">2</a><span role="text" id="t2"><a href="/3">3</a></span></span>
    </body></html>`;
    for (const [rule, reference] of [
      [ariaHiddenFocusRule, referenceAriaHiddenFocusRule],
      [ariaTextRule, referenceAriaTextRule],
    ] as const) {
      expect(run(rule, html)).toEqual(run(reference, html));
    }
    const fail = run(ariaHiddenFocusRule, html).checks.find((c) => c.name === "aria-hidden-focus");
    expect(fail?.message).toBe("3 focusable element(s) inside aria-hidden");
    expect(fail?.items).toEqual([{ id: "a" }, { id: "button#b" }, { id: "button#b" }]);
  });
});

/** `depth` nested `open` elements, each with a focusable link beside the next level. */
function nested(depth: number, open: string, close: string): string {
  return `<!doctype html><html lang="en"><body><main>${`${open}<a href="/x">x</a>`.repeat(depth)}${close.repeat(depth)}</main></body></html>`;
}

describe("deeply nested shapes run in bounded time (#3066)", () => {
  // Before: aria-text 35 s and aria-hidden-focus well over a minute at 5,000
  // levels. The budget leaves room for a loaded CI runner.
  test.each([
    ["aria-text", ariaTextRule, '<span role="text">', "</span>"],
    ["aria-hidden-focus", ariaHiddenFocusRule, '<div aria-hidden="true">', "</div>"],
  ] as const)("%s at 5,000 levels stays under 1 s", (_name, rule, open, close) => {
    const html = nested(5000, open, close);
    const ctx: RuleContext = {
      page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, URL) as ParsedPage,
      options: {},
    };
    const started = performance.now();
    const result = rule.run(ctx);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.checks.some((c) => c.status === "warn" || c.status === "fail")).toBe(true);
  });
});
