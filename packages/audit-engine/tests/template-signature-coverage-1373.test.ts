// Signature coverage mode (#1373). The authored corpus is a CEILING on coverage,
// not an estimate: its pages vary only the ways the author chose. The real
// numbers come from `template-fanout-bench.ts --coverage` on real crawls.

import { describe, expect, test } from "bun:test";

import { SIGNATURE_ATTRIBUTES, SIGNATURE_SELECTORS } from "@squirrelscan/rules";

import { parseHtmlForRules } from "../src/adapter";
import { derivedFanoutSignature, measureSignatureCoverage } from "../src/index";
import { CORPUS, ORIGIN } from "./helpers/template-corpus";

describe("measureSignatureCoverage on the template corpus (ceiling, not an estimate)", () => {
  test("current mode finds the authored clusters", () => {
    const cur = measureSignatureCoverage(CORPUS, "current");
    expect(cur.pages).toBe(CORPUS.length);
    expect(cur.keyed).toBe(CORPUS.length);
    expect(cur.clusters).toBeLessThan(CORPUS.length);
    expect(cur.singletons).toBeGreaterThanOrEqual(2);
    expect(cur.fannedPages).toBe(cur.keyed - cur.clusters);
    expect(cur.coverage).toBeGreaterThan(0);
  });

  test("derived mode refines current: never more coverage, never fewer clusters", () => {
    const cur = measureSignatureCoverage(CORPUS, "current");
    const der = measureSignatureCoverage(CORPUS, "derived");
    expect(der.pages).toBe(cur.pages);
    expect(der.clusters).toBeGreaterThanOrEqual(cur.clusters);
    expect(der.coverage).toBeLessThanOrEqual(cur.coverage);
  });

  test("derived mode splits siblings that differ only in an unkeyed read", () => {
    const page = (src: string) =>
      `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body class="x"><main><img src="${src}"></main></body></html>`;
    const pages = [
      { url: `${ORIGIN}/a`, html: page("/one.jpg") },
      { url: `${ORIGIN}/b`, html: page("/two.jpg") },
    ];
    // img src is not in today's signature: one cluster. Derived keys it: two.
    expect(measureSignatureCoverage(pages, "current").clusters).toBe(1);
    expect(measureSignatureCoverage(pages, "derived").clusters).toBe(2);
  });

  test("empty input and a page without a document are counted, not dropped", () => {
    expect(measureSignatureCoverage([], "derived")).toMatchObject({ pages: 0, coverage: 0 });
    expect(derivedFanoutSignature(null)).toBeNull();
  });

  test("every declared selector is a valid selector for the DOM", () => {
    const doc = parseHtmlForRules("<html><body><main></main></body></html>", `${ORIGIN}/`).document!;
    for (const selector of SIGNATURE_SELECTORS) {
      expect(() => doc.querySelectorAll(selector)).not.toThrow();
    }
    expect(SIGNATURE_ATTRIBUTES.length).toBeGreaterThan(0);
  });
}, 30_000);
