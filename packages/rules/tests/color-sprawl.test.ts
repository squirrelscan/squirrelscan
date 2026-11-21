// content/color-sprawl (repo#1377): near-duplicate colors, palette outliers, token attribution.
// Every case runs through the legacy path (ctx.site.pages) and the streaming path
// (collectedSignals + siteQuery) and asserts the same checks.

import type { SiteQuery } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { RuleContext, StylesheetContentData } from "../src/types";

import { buildCollectedPageSignal } from "../src/collected-signals";
import {
  colorSprawlRule,
  extractColorUsage,
  parseColor,
} from "../src/content/color-sprawl";

const BASE = {
  page: {
    url: "https://example.com/",
    html: "",
    statusCode: 200,
    loadTime: 0,
    headers: {},
  },
  parsed: {} as never,
  options: {},
};

interface Spec {
  url: string;
  style?: string;
  attr?: string;
  link?: boolean;
}

function html(s: Spec): string {
  return `<!doctype html><html><head><title>${s.url}</title>${s.link ? '<link rel="stylesheet" href="/a.css">' : ""}${s.style ? `<style>${s.style}</style>` : ""}</head><body><p ${s.attr ? `style="${s.attr}"` : ""}>hi</p></body></html>`;
}

const parse = (s: Spec) => parsePage(html(s), s.url);

function legacy(
  specs: Spec[],
  options: Record<string, unknown> = {},
  stylesheets?: StylesheetContentData[]
): RuleContext {
  return {
    ...BASE,
    options,
    site: {
      pages: specs.map((s) => ({
        url: s.url,
        statusCode: 200,
        headers: {},
        parsed: parse(s),
      })),
      ...(stylesheets ? { stylesheets } : {}),
    },
  } as unknown as RuleContext;
}

function streaming(
  specs: Spec[],
  options: Record<string, unknown> = {},
  stylesheets?: StylesheetContentData[]
): RuleContext {
  const pages = specs.map((s) =>
    buildCollectedPageSignal({ url: s.url, parsed: parse(s) })
  );
  const siteQuery = { pageCount: () => specs.length } as unknown as SiteQuery;
  return {
    ...BASE,
    options,
    collectedSignals: { pages },
    siteQuery,
    site: { pages: [], ...(stylesheets ? { stylesheets } : {}) },
  } as unknown as RuleContext;
}

function both(
  specs: Spec[],
  options: Record<string, unknown> = {},
  stylesheets?: StylesheetContentData[]
) {
  const a = colorSprawlRule.run(legacy(specs, options, stylesheets)) as {
    checks: any[];
  };
  const b = colorSprawlRule.run(streaming(specs, options, stylesheets)) as {
    checks: any[];
  };
  expect(b.checks).toEqual(a.checks);
  return a.checks;
}

const pages = (n: number, mk: (i: number) => Partial<Spec>): Spec[] =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/p${i}`,
    ...mk(i),
  }));

describe("parseColor", () => {
  test("the same color as hex, rgb(), hsl(), oklch() and a name converges", () => {
    expect(parseColor("#ff0000")).toBe("#ff0000");
    expect(parseColor("#f00")).toBe("#ff0000");
    expect(parseColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(parseColor("rgb(255 0 0 / 50%)")).toBe("#ff0000");
    expect(parseColor("hsl(0, 100%, 50%)")).toBe("#ff0000");
    expect(parseColor("red")).toBe("#ff0000");
    expect(parseColor("oklch(0.628 0.2577 29.23)")).toBe("#ff0000");
  });
  test("transparent and non-colors are not colors", () => {
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("rgba(0,0,0,0)")).toBeNull();
    expect(parseColor("currentcolor")).toBeNull();
    expect(parseColor("solid")).toBeNull();
  });
});

describe("content/color-sprawl", () => {
  test("skipped under the page floor", () => {
    const c = both(pages(4, () => ({ style: "p{color:#111}" })));
    expect(c).toHaveLength(1);
    expect(c[0].status).toBe("skipped");
  });

  test("skipped, not passed, when no page declares a color inline", () => {
    const c = both(pages(12, () => ({ link: true })));
    expect(c[0].status).toBe("skipped");
    expect(c[0].message).toContain("not a clean pass");
    expect(c[0].details.coverage).toBe("inline-only");
  });

  test("pass: one palette used everywhere", () => {
    const c = both(
      pages(12, () => ({
        style: "p{color:#111111;background:#ffffff} a{color:#0057b8}",
      }))
    );
    expect(c).toHaveLength(1);
    expect(c[0].status).toBe("pass");
    expect(c[0].message).toContain("inline styles only");
  });

  test("warn: near-duplicate grays are counted and named", () => {
    // Seven grays that collapse to two perceptual clusters, spread over every page.
    const grays = [
      "#303030",
      "#313131",
      "#323232",
      "#333333",
      "#343434",
      "#353535",
      "#363636",
    ];
    const c = both(
      pages(12, () => ({
        style: grays.map((g, i) => `.g${i}{color:${g}}`).join(""),
      })),
      { max_redundant: 3 }
    );
    const sprawl = c.find((x) => x.name === "color-sprawl")!;
    expect(sprawl.status).toBe("warn");
    expect(sprawl.value).toBe(5);
    expect(sprawl.message).toContain("7 gray(s), 5 visually indistinguishable");
    expect(sprawl.items[0].label).toContain("visually indistinguishable");
  });

  test("fail: near-duplicates at three times the limit", () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `#${(0x30 + i).toString(16).repeat(3)}`
    );
    const c = both(
      pages(12, () => ({
        style: many.map((g, i) => `.g${i}{color:${g}}`).join(""),
      }))
    );
    expect(c.find((x) => x.name === "color-sprawl")!.status).toBe("fail");
  });

  test("the same color in hex, rgb() and oklch() clusters as one", () => {
    const styles = [
      "p{color:#ff0000}",
      "p{color:rgb(255,0,0)}",
      "p{color:oklch(0.628 0.2577 29.23)}",
      "p{color:hsl(0 100% 50%)}",
    ];
    const specs = pages(12, (i) => ({ style: styles[i % 4] }));
    const c = both(specs, { max_redundant: 1 });
    // Four literals parse to one hex, so nothing is redundant even at a limit of 1.
    expect(c).toHaveLength(1);
    expect(c[0].status).toBe("pass");
    expect(extractColorUsage(parse(specs[2]!).document).colors).toEqual([
      "#ff0000",
    ]);
  });

  test("warn: a chromatic color used on one page only is a palette outlier", () => {
    const specs = pages(12, (i) => ({
      style: i === 7 ? "p{color:#111111} b{color:#e91e63}" : "p{color:#111111}",
    }));
    const c = both(specs);
    const out = c.find((x) => x.name === "palette-outlier")!;
    expect(out.status).toBe("warn");
    expect(out.items[0].label).toContain("#e91e63");
    expect(out.items[0].sourcePages).toEqual(["https://example.com/p7"]);
  });

  test("no false positive: a token-driven design system stays clean", () => {
    // A 40-step scale defined once in :root, referenced through var() everywhere.
    const scale = Array.from(
      { length: 40 },
      (_, i) => `--gray-${i}:#${(0x20 + i).toString(16).repeat(3)};`
    ).join("");
    const refs =
      "p{color:var(--gray-3)} a{color:var(--gray-4);border-color:var(--gray-5)} h1{background:var(--gray-1)}";
    const specs = pages(12, () => ({ style: `:root{${scale}}${refs}` }));
    const c = both(specs);
    expect(c).toHaveLength(1);
    expect(c[0].status).toBe("pass");
    expect(c[0].details.tokenColorsDefined).toBe(40 * 12);
    expect(c[0].details.distinctColors).toBe(0);
    expect(c[0].message).toContain("var() reference");
  });

  test("a custom property named like a color property is not read as one", () => {
    const u = extractColorUsage(
      parse({
        url: "https://example.com/",
        style: ":root{--x1color:red;--bg-color:#123456}",
      }).document
    );
    expect(u.colors).toEqual([]);
    expect(u.tokenColors).toBe(2);
  });

  describe("linked stylesheets define the palette (ctx.site.stylesheets)", () => {
    const outlierSpecs = () =>
      pages(12, (i) => ({
        link: true,
        style:
          i === 7 ? "p{color:#111111} b{color:#e91e63}" : "p{color:#111111}",
      }));

    test("a brand color a read stylesheet uses on every page is not an outlier", () => {
      const sheets = [
        { url: "https://example.com/a.css", content: ".brand{color:#e91e63}" },
      ];
      const c = both(outlierSpecs(), {}, sheets);
      expect(c.find((x) => x.name === "palette-outlier")).toBeUndefined();
      expect(c[0].status).toBe("pass");
      expect(c[0].details.coverage).toBe("inline-plus-stylesheet-palette");
      expect(c[0].details.stylesheetsRead).toBe(1);
      expect(c[0].message).toContain(
        "1 linked stylesheet(s) read for the palette"
      );
      expect(c[0].message).not.toContain("inline styles only");
    });

    test("a token a stylesheet defines, or a color indistinguishable from one, is palette too", () => {
      const sheets = [
        { url: "https://example.com/a.css", content: ":root{--brand:#e91e64}" },
      ];
      const c = both(outlierSpecs(), {}, sheets);
      expect(c.find((x) => x.name === "palette-outlier")).toBeUndefined();
    });

    test("a color no read stylesheet carries is still an outlier, and unread sheets are reported", () => {
      const sheets = [
        { url: "https://example.com/a.css", content: ".x{color:#0057b8}" },
        { url: "https://example.com/big.css" },
      ];
      const c = both(outlierSpecs(), {}, sheets);
      const out = c.find((x) => x.name === "palette-outlier")!;
      expect(out.status).toBe("warn");
      expect(out.message).toContain(
        "1 color(s) used inline on only one page and in no read stylesheet ("
      );
      expect(out.message).toContain(
        "1 linked stylesheet(s) read for the palette, 1 not read"
      );
      expect(out.details.stylesheetsNotRead).toBe(1);
    });

    test("with no stylesheet body read the result still says inline styles only", () => {
      const c = both(outlierSpecs(), {}, [
        { url: "https://example.com/a.css" },
      ]);
      const out = c.find((x) => x.name === "palette-outlier")!;
      expect(out.message).toContain(
        "1 color(s) used inline on only one page (inline styles only; linked stylesheets are not read"
      );
      expect(out.details.coverage).toBe("inline-only");
    });
  });
});
