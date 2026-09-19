import { describe, expect, test } from "bun:test";
import type { CapturedPage } from "../labeler/types.ts";
import { FAMILY_HINT_CAP, qualityReasons, selectCaptures, type Candidate } from "./quality.ts";

function page(id: string, url: string, text = "Useful visible content") {
  return {
    id: `page_${id.padEnd(24, "0").slice(0, 24)}`,
    url,
    sourceUrl: url,
    sourceKind: "fresh_capture",
    title: "A rendered page",
    capturedAt: "2026-09-19T00:00:00.000Z",
    contentHash: `sha256:${id.padEnd(64, "a").slice(0, 64)}`,
    captureHash: `sha256:${id.padEnd(64, "b").slice(0, 64)}`,
    width: 1000,
    height: 800,
    viewport: { width: 1000, height: 800, deviceScaleFactor: 1 },
    screenshotUrl: "",
    split: "training-review",
    nodes: [
      {
        id: `node_${"1".repeat(24)}`,
        parentId: null,
        tag: "main",
        role: "main",
        text,
        selector: "html > main",
        rect: { x: 0, y: 0, width: 1000, height: 600 },
        depth: 2,
        suggestion: null,
      },
      {
        id: `node_${"2".repeat(24)}`,
        parentId: null,
        tag: "a",
        role: null,
        text: "Read more",
        selector: "html > a",
        rect: { x: 0, y: 610, width: 100, height: 30 },
        depth: 2,
        suggestion: null,
      },
      {
        id: `node_${"3".repeat(24)}`,
        parentId: null,
        tag: "img",
        role: null,
        text: "",
        selector: "html > img",
        rect: { x: 120, y: 610, width: 100, height: 80 },
        depth: 2,
        suggestion: null,
      },
      {
        id: `node_${"4".repeat(24)}`,
        parentId: null,
        tag: "footer",
        role: "contentinfo",
        text: "Footer",
        selector: "html > footer",
        rect: { x: 0, y: 720, width: 1000, height: 80 },
        depth: 2,
        suggestion: null,
      },
      {
        id: `node_${"5".repeat(24)}`,
        parentId: null,
        tag: "p",
        role: null,
        text: "More content",
        selector: "html > p",
        rect: { x: 0, y: 650, width: 100, height: 20 },
        depth: 2,
        suggestion: null,
      },
      {
        id: `node_${"6".repeat(24)}`,
        parentId: null,
        tag: "section",
        role: null,
        text: "Section",
        selector: "html > section",
        rect: { x: 250, y: 610, width: 100, height: 80 },
        depth: 2,
        suggestion: null,
      },
      {
        id: `node_${"7".repeat(24)}`,
        parentId: null,
        tag: "button",
        role: null,
        text: "Continue",
        selector: "html > button",
        rect: { x: 360, y: 610, width: 100, height: 40 },
        depth: 2,
        suggestion: null,
      },
      {
        id: `node_${"8".repeat(24)}`,
        parentId: null,
        tag: "nav",
        role: "navigation",
        text: "Navigation",
        selector: "html > nav",
        rect: { x: 470, y: 610, width: 100, height: 40 },
        depth: 2,
        suggestion: null,
      },
    ],
  } as CapturedPage;
}

function candidate(id: string, host: string, feature = id, familyHint = "inner") {
  const capture = page(id, `https://${host}/${id}`);
  return {
    page: capture,
    stage: "/private/stage",
    source: { sourceBucket: "public", sourceSeed: `https://${host}/`, familyHint },
    domainGroup: host,
    templateFingerprint: feature,
    templateFeatures: new Set([feature]),
  } satisfies Candidate;
}

describe("diverse corpus quality selection", () => {
  test("holds dominant challenge, soft-404, and inadequate rendered DOM pages out", () => {
    const challenge = page("challenge", "https://example.com/", "Checking your browser");
    challenge.title = "Just a moment…";
    expect(qualityReasons(challenge)).toContain("challenge_or_access_gate");
    const missing = page("missing", "https://example.com/", "Page not found");
    missing.title = "404 — page not found";
    expect(qualityReasons(missing)).toContain("soft_404");
    const sparse = page("sparse", "https://example.com/");
    sparse.nodes = sparse.nodes.slice(0, 2);
    expect(qualityReasons(sparse)).toContain("empty_or_insufficient_dom");
    expect(qualityReasons(sparse)).toContain("inadequate_dom_targets");
  });

  test("keeps legitimate pages with embedded captcha text or outside child geometry", () => {
    const embeddedCaptcha = page(
      "embedded-captcha",
      "https://example.com/",
      `A complete article with enough substantive text ${"to retain the page ".repeat(30)} CAPTCHA`,
    );
    expect(qualityReasons(embeddedCaptcha)).not.toContain("challenge_or_access_gate");
    const overflowChild = page("overflow", "https://example.com/");
    overflowChild.nodes[1]!.rect.x = 1_100;
    expect(qualityReasons(overflowChild)).not.toContain("invalid_dom_geometry");
  });

  test("deduplicates exact bodies but retains template groups for later split handling", () => {
    const first = candidate("first", "one.example", "template-one");
    const sameBody = candidate("body", "two.example", "template-two");
    sameBody.page.contentHash = first.page.contentHash;
    const sameTemplate = candidate("template", "three.example", "template-one");
    const otherDomain = candidate("other", "four.example", "template-four");
    const result = selectCaptures([first, sameBody, sameTemplate, otherDomain], 3);
    expect(result.selected.map((item) => item.page.id).sort()).toEqual(
      [first.page.id, sameTemplate.page.id, otherDomain.page.id].sort(),
    );
    expect(result.heldOut.find((item) => item.pageId === sameBody.page.id)?.reasons).toEqual([
      "exact_body_duplicate",
    ]);
    expect(result.nearDuplicates).toContainEqual(
      expect.objectContaining({ keptPageId: first.page.id, heldOutPageId: sameTemplate.page.id }),
    );
  });

  test("enforces the provisional family sampling cap without treating it as a label", () => {
    const candidates = Array.from({ length: FAMILY_HINT_CAP + 2 }, (_, index) =>
      candidate(`family${index}`, `host${index}.example`, `template-${index}`, "product"),
    );
    const result = selectCaptures(candidates, 500);
    expect(result.selected).toHaveLength(FAMILY_HINT_CAP);
    expect(result.diagnostics).toMatchObject({ familyHints: { product: FAMILY_HINT_CAP } });
    expect(String(result.diagnostics.note)).toContain("not a DOM");
  });
});
