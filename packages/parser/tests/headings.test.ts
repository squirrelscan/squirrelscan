// #1216: heading text is capped at extraction — a >1000-char page h1 must
// never leave the parser unbounded (an uncapped one 400'd whole cloud
// publishes before the server-side schema clamp existed).

import { describe, expect, test } from "bun:test";

import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { parseHTML } from "linkedom";

import { parsePage } from "../src/index";
import { extractHeadings } from "../src/extractors/headings";

const GIANT = "H".repeat(5000);

describe("heading text producer cap (#1216)", () => {
  test("extractHeadings clamps oversize heading text to the medium-string cap", () => {
    const { document } = parseHTML(`<html><body><h1>${GIANT}</h1><h2>ok</h2></body></html>`);
    const hierarchy = extractHeadings(document);
    expect(hierarchy.h1Count).toBe(1);
    expect(hierarchy.h1Texts[0]!.length).toBe(REPORT_LIMITS.maxMediumString);
    expect(hierarchy.headings[0]!.text.length).toBe(REPORT_LIMITS.maxMediumString);
    expect(hierarchy.headings[1]!.text).toBe("ok");
    // Outline is built from the clamped texts.
    expect(hierarchy.outline).toContain(`H1: ${GIANT.slice(0, REPORT_LIMITS.maxMediumString)}`);
    expect(hierarchy.outline).not.toContain(GIANT);
  });

  test("parsePage's heading path clamps oversize h1 text too", () => {
    const page = parsePage(
      `<html><head><title>t</title></head><body><h1>${GIANT}</h1></body></html>`,
      "https://example.com",
    );
    expect(page.headings.h1Texts[0]!.length).toBe(REPORT_LIMITS.maxMediumString);
  });

  // #1228 finding 1: the PUBLISHED h1 field is `parsed.h1.texts` (from
  // extractH1), NOT `headings.h1Texts` — both adapters read `parsed?.h1.texts`.
  // Clamping only extractHeadings left the actual publish field unbounded.
  test("parsePage's published h1 field (h1.texts) clamps oversize h1 text", () => {
    const page = parsePage(
      `<html><head><title>t</title></head><body><h1>${GIANT}</h1></body></html>`,
      "https://example.com",
    );
    expect(page.h1.count).toBe(1);
    expect(page.h1.texts[0]!.length).toBe(REPORT_LIMITS.maxMediumString);
    expect(page.h1.texts[0]).toBe(GIANT.slice(0, REPORT_LIMITS.maxMediumString));
  });
});
