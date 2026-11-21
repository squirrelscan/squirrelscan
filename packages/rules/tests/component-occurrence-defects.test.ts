// Review findings against the #2307 rule-side evidence code. Each test names
// the defect it pins rather than the function it calls.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { linkTextRule } from "../src/a11y/link-text";
import { staleCopyrightRule } from "../src/content/stale-copyright";
import type { Element } from "linkedom";
import { ComponentOccurrenceCache, componentOccurrence } from "../src/shared/component-occurrence";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(html: string, pageUrl = "https://example.test/p"): RuleContext {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return {
    page: { url: pageUrl, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: { current_year: 2026 },
  };
}

describe("region evidence is linear in the number of faulty elements", () => {
  const page = (n: number) =>
    ctx(
      `<footer><nav>${Array.from({ length: n }, (_, i) => `<a href="/t${i}">Read more</a>`).join("")}</nav></footer>`,
    );

  /**
   * DOM work one rule run does, counted rather than timed so a loaded host
   * cannot move it (#2201): elements yielded by `children` (every digest,
   * sibling index and child-tag sequence walks through it) and characters read
   * through `textContent`. The getters are wrapped on linkedom's prototypes for
   * the run only; parsing happens before, so it is not counted.
   */
  async function domWork(n: number): Promise<{ elements: number; characters: number }> {
    const c = page(n);
    const nav = c.parsed.document!.querySelector("nav")!;
    const owner = (name: string) => {
      let proto: object | null = nav;
      while (proto && !Object.getOwnPropertyDescriptor(proto, name)) proto = Object.getPrototypeOf(proto);
      return { proto: proto!, descriptor: Object.getOwnPropertyDescriptor(proto!, name)! };
    };
    const children = owner("children");
    const textContent = owner("textContent");
    const counted = { elements: 0, characters: 0 };
    Object.defineProperty(children.proto, "children", {
      ...children.descriptor,
      get(this: Element) {
        const value = children.descriptor.get!.call(this) as ArrayLike<unknown>;
        counted.elements += value.length;
        return value;
      },
    });
    Object.defineProperty(textContent.proto, "textContent", {
      ...textContent.descriptor,
      get(this: Element) {
        const value = textContent.descriptor.get!.call(this) as string | null;
        counted.characters += value?.length ?? 0;
        return value;
      },
    });
    try {
      const checks = (await linkTextRule.run(c)).checks;
      expect(checks[0]?.componentOccurrences).toHaveLength(n);
    } finally {
      Object.defineProperty(children.proto, "children", children.descriptor);
      Object.defineProperty(textContent.proto, "textContent", textContent.descriptor);
    }
    return counted;
  }

  // 4x the links is ~4x the work when linear and ~16x when the region is
  // re-walked per link. The counts are deterministic, so the bound has no
  // timing slack to absorb and sits between the two.
  const MAX_GROWTH = 6;

  async function growth(smallSize: number): Promise<{ elements: number; characters: number }> {
    const small = await domWork(smallSize);
    const large = await domWork(smallSize * 4);
    return { elements: large.elements / small.elements, characters: large.characters / small.characters };
  }

  test("a 5,000-link nav does not re-walk the region per link", async () => {
    const ratio = await growth(1250);
    expect(ratio.elements).toBeLessThan(MAX_GROWTH);
    expect(ratio.characters).toBeLessThan(MAX_GROWTH);
  });

  test("the counter catches a per-link region re-walk", async () => {
    // A deliberately quadratic variant: the region's child-tag sequence rebuilt
    // for every link, the regression the cache's own comment records. Smaller
    // sizes than the guard: the ratio is the same, and the quadratic variant at
    // 5,000 links is slow enough to hit the test timeout on a loaded host.
    const original = ComponentOccurrenceCache.prototype.childTagSequence;
    ComponentOccurrenceCache.prototype.childTagSequence = function (this: ComponentOccurrenceCache, element) {
      this.childTagSequences.delete(element);
      return original.call(this, element);
    };
    try {
      expect((await growth(250)).elements).toBeGreaterThan(MAX_GROWTH);
    } finally {
      ComponentOccurrenceCache.prototype.childTagSequence = original;
    }
  });
});

describe("content nested BELOW a chrome region is not site chrome", () => {
  test("an article inside the footer keeps its links page-scoped", async () => {
    const html =
      "<footer><article><a href='/related'>Read more</a></article><a href='/pricing'>Read more</a></footer>";
    const occurrences = (await linkTextRule.run(ctx(html))).checks[0]!.componentOccurrences!;
    const inArticle = occurrences.find((o) => o.element.locator.includes("article"))!;
    const siteChrome = occurrences.find((o) => !o.element.locator.includes("article"))!;

    // The region is the footer either way, so ancestry ABOVE the region cannot
    // tell these apart — the nesting BETWEEN element and region is what does.
    expect(inArticle).toMatchObject({
      groupable: false,
      confidence: "uncertain",
      uncertainReason: "content-nested",
    });
    expect(siteChrome.groupable).toBe(true);
  });

  // `<main>` IS itself a region role, so `findRegion` stops at the main rather
  // than the footer and the reason is `region-main`. Different label, same
  // conservative outcome; asserted as it actually behaves.
  test("a main nested inside a footer is likewise not groupable", () => {
    const { document } = parseHTML(
      "<html><body><footer><main><p>© 2019 Acme</p></main></footer></body></html>",
    );
    const target = document.querySelector("p") as unknown as Element;
    const occurrence = componentOccurrence(
      { pageUrl: "https://example.test/p", rendered: false, element: target, kind: "stale-copyright", values: {} },
      new ComponentOccurrenceCache(),
    );
    expect(occurrence.groupable).toBe(false);
    expect(occurrence.uncertainReason).toBe("region-main");
  });
});

describe("stale-copyright detection is byte-identical to the baseline", () => {
  // The baseline concatenates the matches of EVERY footer selector, so one
  // element matching both `footer` and `.footer` contributes its text twice.
  // That duplication is load-bearing: the pattern needs the © marker BEFORE a
  // year, and only the seam between the two copies supplies it.
  test("an element matching two selectors still warns", async () => {
    const checks = (await staleCopyrightRule.run(ctx('<footer class="footer">2025 &copy;</footer>'))).checks;
    expect(checks[0]).toMatchObject({
      name: "footer-copyright-year",
      status: "warn",
      value: 2025,
    });
  });

  test("that finding carries NO evidence, because no element asserts the year", async () => {
    // The year is a concatenation artifact: it exists only at the seam between
    // the two copies, so no single element's text asserts it. The finding must
    // still stand (parity), and evidence must stay empty rather than blaming an
    // element that does not say what the finding claims.
    const check = (await staleCopyrightRule.run(ctx('<footer class="footer">2025 &copy;</footer>'))).checks[0]!;
    expect(check.status).toBe("warn");
    expect(check.componentOccurrences ?? []).toHaveLength(0);
  });

  test("deep wrapper chains keep evidence on the innermost element", async () => {
    const depth = 400;
    const inner = `${"<div>".repeat(depth)}<p>&copy; 2019 Acme</p>${"</div>".repeat(depth)}`;
    const check = (await staleCopyrightRule.run(ctx(`<footer>${inner}</footer>`))).checks[0]!;
    expect(check.status).toBe("warn");
    // Evidence belongs to the innermost element asserting the year.
    expect(check.componentOccurrences).toHaveLength(1);
  });
});
