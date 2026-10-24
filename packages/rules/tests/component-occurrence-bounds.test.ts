// The evidence builder reads crawled markup, so its cost has to follow the size
// of the page, not the shape an author picks for it. Each stress test names the
// shape it pins; the time budgets are generous (the bad shapes took seconds to
// minutes), so a loaded machine does not fail them but a quadratic walk does.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";
import type { Element } from "linkedom";

import { ComponentOccurrenceCache, componentOccurrence } from "../src/shared/component-occurrence";

function parse(body: string) {
  return parseHTML(`<html><body>${body}</body></html>`).document;
}

function occurrenceOf(element: Element, cache = new ComponentOccurrenceCache()) {
  return componentOccurrence(
    {
      pageUrl: "https://example.test/p",
      rendered: false,
      element,
      kind: "link-text-generic",
      values: { nameSource: "text", normalizedText: "read more" },
    },
    cache,
  );
}

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

describe("the output on ordinary pages is unchanged", () => {
  // Captured from the evidence builder before the single-pass landmark index and
  // the memoised ancestry: locator (slot, then path), region role, nesting, and
  // why it is or is not groupable.
  const HTML = `<header><nav><a href="/1">Read more</a></nav></header>
<main><article><footer><a href="/2">Read more</a></footer></article><a href="/3">click here</a></main>
<footer><nav><a href="/4">Read more</a></nav><a href="/5">Read more</a></footer>
<footer><a href="/6">Read more</a></footer>
<footer><a href="/7">Read more</a></footer>
<nav><a href="/8">Read more</a></nav>
<div><a href="/9">here</a></div>`;

  test("slots, nesting and reasons", () => {
    const document = parse(HTML);
    const cache = new ComponentOccurrenceCache();
    const rows = ([...document.querySelectorAll("a")] as Element[]).map((element) => {
      const occurrence = occurrenceOf(element, cache);
      return [
        occurrence.element.locator,
        occurrence.region.role,
        occurrence.region.nestedIn,
        occurrence.uncertainReason ?? "groupable",
      ];
    });
    expect(rows).toEqual([
      ["navigation:1>nav>a:1", "navigation", "none", "groupable"],
      ["footer:1>footer>a:1", "footer", "article", "content-nested"],
      ["main:1>main>a:1", "main", "none", "region-main"],
      ["navigation:1>nav>a:1", "navigation", "none", "groupable"],
      ["footer:1>footer>a:1", "footer", "none", "groupable"],
      ["footer:2>footer>a:1", "footer", "none", "groupable"],
      ["footer:3>footer>a:1", "footer", "none", "groupable"],
      ["navigation:1>nav>a:1", "navigation", "none", "groupable"],
      ["html>body:1>div:1>a:1", "unknown", "unknown", "no-region"],
    ]);
  });

  test("one landmark pass serves every faulty element of a page", () => {
    const document = parse(HTML);
    const cache = new ComponentOccurrenceCache();
    for (const element of [...document.querySelectorAll("a")] as Element[]) occurrenceOf(element, cache);
    expect(cache.landmarkIndexBuilds).toBe(1);
  });
});

describe("hint text is bounded before it is matched", () => {
  /** The ladder's hint for the `<div>` that holds the faulty link, in a page with no landmark. */
  function hintOf(attributes: string, inner = "") {
    const document = parse(`<div ${attributes}>${inner}<a href="/x">Read more</a></div>`);
    const link = document.querySelector("a") as unknown as Element;
    const occurrence = occurrenceOf(link);
    return occurrence.subtreeCandidates?.find((candidate) => candidate.rootHint)?.rootHint;
  }

  test("a 200,000-character aria-label with no @ costs a bounded match", () => {
    const label = "a.".repeat(100_000);
    const { value, ms } = timed(() => hintOf(`aria-label="${label}"`));
    expect(ms).toBeLessThan(3000);
    // Still a hint: the first 59 characters and an ellipsis, as before.
    expect(value?.ariaLabel).toBe(`${label.slice(0, 59)}…`);
  });

  test("a 1 MB heading with no @ costs a bounded match", () => {
    const heading = "a.".repeat(500_000);
    const { value, ms } = timed(() => hintOf("", `<h2>${heading}</h2>`));
    expect(ms).toBeLessThan(3000);
    expect(value?.heading).toBe(`${heading.slice(0, 59)}…`);
  });

  test("sensitive text is still dropped, and nothing past the tested window is emitted", () => {
    expect(hintOf(`aria-label="mail bob@example.com"`)?.ariaLabel).toBeUndefined();
    expect(hintOf(`aria-label="call 555 123 4567"`)?.ariaLabel).toBeUndefined();
    expect(hintOf(`aria-label="see https://example.test/secret"`)?.ariaLabel).toBeUndefined();
    expect(hintOf(`aria-label="token abcdef123456"`)?.ariaLabel).toBeUndefined();
    // Past 256 characters the text is not read for sensitive shapes, but only the first
    // 59 characters can ever be emitted, so the address cannot leave the rule.
    const far = `${"b".repeat(300)} bob@example.com`;
    const hint = hintOf(`aria-label="${far}"`)?.ariaLabel;
    expect(hint).toBe(`${"b".repeat(59)}…`);
    expect(hint).not.toContain("@");
  });
});

describe("landmark slots come from one pass over the page", () => {
  const ROLES = ["header", "footer", "nav", "main"];

  /** Every chain of `depth` nested landmarks over four roles, each ending in a faulty link. */
  function chains(depth: number): string {
    const count = ROLES.length ** depth;
    const out: string[] = [];
    for (let n = 0; n < count; n += 1) {
      const tags: string[] = [];
      for (let level = 0, rest = n; level < depth; level += 1, rest = Math.floor(rest / ROLES.length)) {
        tags.push(ROLES[rest % ROLES.length]!);
      }
      out.push(
        `${tags.map((t) => `<${t}>`).join("")}<a href="/p${n}">Read more</a>${[...tags]
          .reverse()
          .map((t) => `</${t}>`)
          .join("")}`,
      );
    }
    return out.join("");
  }

  test("4,096 distinct nested landmark contexts", () => {
    const document = parse(chains(6));
    const links = [...document.querySelectorAll("a")] as Element[];
    expect(links).toHaveLength(4096);
    const cache = new ComponentOccurrenceCache();
    const { value, ms } = timed(() => links.map((link) => occurrenceOf(link, cache)));
    expect(ms).toBeLessThan(5000);
    expect(cache.landmarkIndexBuilds).toBe(1);
    // Every chain is its own context, so every innermost landmark is the first of its kind.
    expect(new Set(value.map((o) => o.element.locator.split(">")[0])).size).toBe(4);
    expect(value.every((o) => o.element.locator.split(">")[0]!.endsWith(":1"))).toBe(true);
  });

  test("a chain of 3,000 nested landmarks, each holding a faulty link", () => {
    const tags = Array.from({ length: 3000 }, (_, i) => (i % 2 ? "nav" : "footer"));
    const html = `${tags.map((t) => `<${t}><a href="/p">Read more</a>`).join("")}${[...tags]
      .reverse()
      .map((t) => `</${t}>`)
      .join("")}`;
    const document = parse(html);
    const links = [...document.querySelectorAll("a")] as Element[];
    const cache = new ComponentOccurrenceCache();
    const { value, ms } = timed(() => links.map((link) => occurrenceOf(link, cache)));
    expect(ms).toBeLessThan(5000);
    // Real chrome nests a few levels. Shallow ones are judged as before...
    expect(value[0]!.groupable).toBe(true);
    expect(value[10]!.region.role).toBe("footer");
    // ...a landmark under dozens of landmarks is page-scoped, with no ladder.
    const deep = value[2000]!;
    expect(deep.groupable).toBe(false);
    expect(deep.uncertainReason).toBe("no-region");
    expect(deep.subtreeCandidates).toBeUndefined();
  });

  test("two landmarks in one context are numbered in document order", () => {
    const document = parse(
      `<nav><a href="/a">Read more</a></nav><header><nav><a href="/b">Read more</a></nav></header><nav><a href="/c">Read more</a></nav>`,
    );
    const cache = new ComponentOccurrenceCache();
    const slots = ([...document.querySelectorAll("a")] as Element[]).map(
      (link) => occurrenceOf(link, cache).element.locator.split(">")[0],
    );
    expect(slots).toEqual(["navigation:1", "navigation:1", "navigation:2"]);
  });
});

describe("a very deep page is walked in bounded steps", () => {
  const DEPTH = 20_000;
  const open = "<div>".repeat(DEPTH);
  const close = "</div>".repeat(DEPTH);

  test("a footer above a 20,000-level div chain", () => {
    const document = parse(`<footer>${open}<a href="/x">Read more</a>${close}</footer>`);
    const link = document.querySelector("a") as unknown as Element;
    const { value, ms } = timed(() => occurrenceOf(link));
    expect(ms).toBeLessThan(3000);
    expect(value.region.role).toBe("footer");
    expect(value.groupable).toBe(true);
    // The locator keeps the nearest levels and says it is cut; it does not grow with the depth.
    expect(value.element.locator.startsWith("footer:1>…>")).toBe(true);
    expect(value.element.locator.endsWith("div:1>a:1")).toBe(true);
    expect(value.element.locator.length).toBeLessThan(4000);
  });

  test("a footer below a 20,000-level div chain", () => {
    const document = parse(`${open}<footer><a href="/x">Read more</a></footer>${close}`);
    const link = document.querySelector("a") as unknown as Element;
    const { value, ms } = timed(() => occurrenceOf(link));
    expect(ms).toBeLessThan(3000);
    expect(value.region.role).toBe("footer");
    expect(value.element.locator).toBe("footer:1>footer>a:1");
  });

  test("a page with no landmark and a 20,000-level chain gets a bounded ladder", () => {
    const document = parse(`${open}<a href="/x">Read more</a>${close}`);
    const link = document.querySelector("a") as unknown as Element;
    const { value, ms } = timed(() => occurrenceOf(link));
    expect(ms).toBeLessThan(3000);
    expect(value.uncertainReason).toBe("no-region");
    expect(value.subtreeCandidates?.length ?? 0).toBeLessThanOrEqual(8);
  });

  test("many faulty links at the bottom of the chain share its ancestry", () => {
    const links = Array.from({ length: 300 }, (_, i) => `<a href="/p${i}">Read more</a>`).join("");
    const document = parse(`<footer>${open}${links}${close}</footer>`);
    const elements = [...document.querySelectorAll("a")] as Element[];
    const cache = new ComponentOccurrenceCache();
    const { value, ms } = timed(() => elements.map((element) => occurrenceOf(element, cache)));
    expect(ms).toBeLessThan(3000);
    expect(new Set(value.map((o) => o.element.locator)).size).toBe(300);
  });
});

describe("a page's evidence work is bounded by a budget, not by how its elements nest", () => {
  const DEPTH = 5000;

  function build(html: string) {
    const document = parse(html);
    const elements = [...document.querySelectorAll("a")] as Element[];
    const cache = new ComponentOccurrenceCache();
    return timed(() => elements.map((element) => occurrenceOf(element, cache)));
  }

  test("a chain of 5,000 divs inside main, a faulty link at every level", () => {
    const { value, ms } = build(
      `<main>${"<div><a href='/x'>Read more</a>".repeat(DEPTH)}${"</div>".repeat(DEPTH)}</main>`,
    );
    expect(ms).toBeLessThan(5000);
    expect(value).toHaveLength(DEPTH);
    // Every link is still reported, none is invented as a component, and the work
    // spent on ladders stops at the budget: the later ones carry no ladder.
    expect(value.every((o) => !o.groupable)).toBe(true);
    expect(value[0]!.subtreeCandidates?.length ?? 0).toBeGreaterThan(0);
    expect(value[DEPTH - 1]!.subtreeCandidates).toBeUndefined();
  });

  test("5,000 anchors nested in each other, no landmark", () => {
    const { value, ms } = build(
      `${"<a href='/x'>".repeat(DEPTH)}Read more${"</a>".repeat(DEPTH)}`,
    );
    expect(ms).toBeLessThan(5000);
    expect(value).toHaveLength(DEPTH);
    expect(value.every((o) => o.uncertainReason === "no-region")).toBe(true);
  });

  test("an ordinary page never reaches the budget", () => {
    const cards = Array.from(
      { length: 2000 },
      (_, i) => `<li class="card"><div><a href="/p${i}">Read more</a></div></li>`,
    ).join("");
    const { value } = build(`<main><ul>${cards}</ul></main><footer><a href="/f">Read more</a></footer>`);
    // Region-main cards keep their ladders, and the footer is judged as a component.
    expect(value[0]!.subtreeCandidates?.length ?? 0).toBeGreaterThan(0);
    expect(value[1999]!.subtreeCandidates?.length ?? 0).toBeGreaterThan(0);
    expect(value[2000]!.groupable).toBe(true);
  });
});
