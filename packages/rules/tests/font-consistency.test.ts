// content/font-consistency (repo#1376): font sprawl, rogue families, unreferenced @font-face.
// Every case runs through the legacy path (ctx.site.pages) and the streaming path
// (collectedSignals + siteQuery) and asserts the same checks.

import { describe, expect, test } from "bun:test";

import type { SiteQuery } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../src/collected-signals";
import { extractFontUsage, fontConsistencyRule } from "../src/content/font-consistency";
import type { RuleContext } from "../src/types";

const BASE = {
  page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
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

function parse(s: Spec) {
  return parsePage(html(s), s.url);
}

function legacy(specs: Spec[], options: Record<string, unknown> = {}): RuleContext {
  return {
    ...BASE,
    options,
    site: {
      pages: specs.map((s) => ({ url: s.url, statusCode: 200, headers: {}, parsed: parse(s) })),
    },
  } as unknown as RuleContext;
}

function streaming(specs: Spec[], options: Record<string, unknown> = {}): RuleContext {
  const pages = specs.map((s) => buildCollectedPageSignal({ url: s.url, parsed: parse(s) }));
  const siteQuery = { pageCount: () => specs.length } as unknown as SiteQuery;
  return { ...BASE, options, collectedSignals: { pages }, siteQuery } as unknown as RuleContext;
}

function both(specs: Spec[], options: Record<string, unknown> = {}) {
  const a = fontConsistencyRule.run(legacy(specs, options)) as { checks: any[] };
  const b = fontConsistencyRule.run(streaming(specs, options)) as { checks: any[] };
  expect(b.checks).toEqual(a.checks);
  return a.checks;
}

const pages = (n: number, mk: (i: number) => Partial<Spec>): Spec[] =>
  Array.from({ length: n }, (_, i) => ({ url: `https://example.com/p${i}`, ...mk(i) }));

const BODY = "body{font-family:'Inter',-apple-system,Arial,sans-serif}";

describe("content/font-consistency", () => {
  test("skipped below the page floor", () => {
    const [c] = both(pages(3, () => ({ style: BODY })));
    expect(c!.status).toBe("skipped");
    expect(c!.message).toContain("Only 3 page(s)");
  });

  test("skipped, not passed, when no inline font data exists", () => {
    const [c] = both(pages(12, () => ({ link: true })));
    expect(c!.status).toBe("skipped");
    expect(c!.message).toContain("not a clean pass");
    expect(c!.details.coverage).toBe("inline-only");
  });

  test("pass: one text family plus an icon font stays clean, and says inline only", () => {
    const style = `${BODY} .fa{font-family:FontAwesome} .i{font-family:'Material Icons'} @font-face{font-family:FontAwesome;src:url(a.woff2)}`;
    const checks = both(pages(12, () => ({ style })));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.message).toContain("inline styles only");
    expect(checks[0]!.details.families).toBe(1);
  });

  test("system stacks and generics are not families", () => {
    const style = "body{font-family:system-ui,sans-serif} code{font-family:ui-monospace,monospace} p{font-family:var(--f)}";
    expect(extractFontUsage(parse({ url: "https://example.com/", style }).document).families).toEqual([]);
  });

  test("warn: more families than the ceiling", () => {
    const fams = ["A", "B", "C", "D", "E"];
    const style = fams.map((f, i) => `.c${i}{font-family:'${f}'}`).join("");
    const checks = both(pages(12, () => ({ style })));
    const c = checks.find((x) => x.name === "font-sprawl")!;
    expect(c.status).toBe("warn");
    expect(c.value).toBe(5);
    expect(c.message).toContain("limit 4");
  });

  test("the ceiling is configurable", () => {
    const style = ".a{font-family:A}.b{font-family:B}.c{font-family:C}";
    const checks = both(pages(12, () => ({ style })), { max_families: 2 });
    expect(checks.find((x) => x.name === "font-sprawl")!.status).toBe("warn");
  });

  test("fail: far over the ceiling", () => {
    const style = "ABCDEFGHI".split("").map((f) => `.${f}{font-family:${f}x}`).join("");
    const checks = both(pages(12, () => ({ style })));
    expect(checks.find((x) => x.name === "font-sprawl")!.status).toBe("fail");
  });

  test("warn: a family on exactly one page is rogue, from style= too", () => {
    const specs = pages(12, (i) => ({ style: BODY, ...(i === 7 ? { attr: "font-family: Papyrus" } : {}) }));
    const checks = both(specs);
    const c = checks.find((x) => x.name === "rogue-font-family")!;
    expect(c.status).toBe("warn");
    expect(c.items[0].id).toBe("papyrus");
    expect(c.items[0].sourcePages).toEqual(["https://example.com/p7"]);
  });

  test("info: @font-face family nothing names", () => {
    const style = `${BODY} @font-face{font-family:Ghost;font-weight:700;font-style:italic;src:url(g.woff2)}`;
    const checks = both(pages(12, () => ({ style })));
    const c = checks.find((x) => x.name === "unreferenced-font-face")!;
    expect(c.status).toBe("info");
    expect(c.items[0].label).toContain("700 italic");
  });

  test("an @font-face family named only as a fallback is referenced", () => {
    const style = "body{font-family:Inter,Ghost} @font-face{font-family:Ghost;src:url(g.woff2)}";
    const checks = both(pages(12, () => ({ style })));
    expect(checks.find((x) => x.name === "unreferenced-font-face")).toBeUndefined();
  });

  test("comments are ignored and an unclosed one is safe", () => {
    const style = "/* font-family: Hidden */ body{font-family:Real} /* unclosed font-family: Gone";
    expect(extractFontUsage(parse({ url: "https://example.com/", style }).document).families).toEqual(["real"]);
  });
});
