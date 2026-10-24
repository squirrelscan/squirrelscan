// The site-chrome fallback: the mass arithmetic, and what it may change in a prediction.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyPage, tryLoadModel } from "../src/predict";
import { chromeIndices, chromeMass, SITE_CHROME_THRESHOLD } from "../src/region-groups";

const ARTIFACT = join(import.meta.dir, "../assets/classifier-v2.json");

const CLASSES = [
  "site_header",
  "footer",
  "navigation",
  "sidebar",
  "main_content",
  "content_block",
  "article_chrome",
  "form",
  "search",
  "dialog",
];

describe("chrome mass", () => {
  test("indexes the four chrome classes and sums only them", () => {
    const indices = chromeIndices(CLASSES);
    expect(indices).toEqual([0, 1, 2, 3]);
    const probs = [0.2, 0.3, 0.1, 0.25, 0.05, 0.05, 0.02, 0.01, 0.01, 0.01];
    expect(chromeMass(probs, indices)).toBeCloseTo(0.85, 6);
    expect(chromeMass(probs, indices)).toBeGreaterThanOrEqual(SITE_CHROME_THRESHOLD);
  });

  test("a head without chrome classes has no fallback", () => {
    expect(chromeIndices(["main_content", "form"])).toEqual([]);
  });

  test("a class the platform guard abstains does not count towards the group", () => {
    const thresholds = [0.85, 1.01, 0.94, 0.87, 1.01, 0.95, 1.01, 1.01, 1.01, 0.94];
    expect(chromeIndices(CLASSES, thresholds)).toEqual([0, 2, 3]);
    expect(
      chromeIndices(
        CLASSES,
        CLASSES.map(() => 1.01),
      ),
    ).toEqual([]);
  });
});


// A page whose furniture the head names with less than class-level confidence.
const PAGE = `<!doctype html><html lang="en"><head><title>Home - Example Shop</title></head><body>
<div class="top"><div class="logo">Example</div><ul class="links"><li><a href="/a">Shop</a></li><li><a href="/b">Sale</a></li></ul></div>
<div class="content"><h1>Welcome</h1><p>We sell widgets for people who build things in their garage and need parts.</p>
<div class="grid"><div class="card"><a href="/p1">Widget one</a><p>Short text here.</p></div><div class="card"><a href="/p2">Widget two</a><p>Short text here.</p></div></div></div>
<div class="bottom"><div class="cols"><ul><li><a href="/about">About</a></li><li><a href="/contact">Contact</a></li></ul><ul><li><a href="/terms">Terms</a></li><li><a href="/privacy">Privacy</a></li></ul></div><p>Copyright Example Shop 2026</p></div>
</body></html>`;

describe.if(existsSync(ARTIFACT))(
  "site_chrome fallback with the real artifact",
  () => {
    const { model } = tryLoadModel(JSON.parse(readFileSync(ARTIFACT, "utf8")));
    const url = "https://shop.example.org/";

    test("only turns unknown into site_chrome, at or above the threshold, and changes nothing else", () => {
      const withFallback = classifyPage(PAGE, url, { model });
      const without = classifyPage(PAGE, url, { model, groupFallback: false });
      expect(withFallback.nodes.length).toBe(without.nodes.length);
      for (let i = 0; i < without.nodes.length; i++) {
        const a = withFallback.nodes[i]!;
        const b = without.nodes[i]!;
        if (a.label === b.label) {
          expect(a).toEqual(b);
        } else {
          expect(b.label).toBe("unknown");
          expect(a.label).toBe("site_chrome");
          expect(a.confidence).toBeGreaterThanOrEqual(SITE_CHROME_THRESHOLD);
          expect(a.source).toBe("model");
        }
      }
    });

    test("a threshold override is a per-class evaluation: no fallback", () => {
      const out = classifyPage(PAGE, url, { model, threshold: 0.5 });
      expect(out.nodes.some((n) => n.label === "site_chrome")).toBe(false);
    });

    test("the fallback never fires without a model", () => {
      expect(classifyPage(PAGE, url).nodes.some((n) => n.label === "site_chrome")).toBe(false);
    });
  },
);
