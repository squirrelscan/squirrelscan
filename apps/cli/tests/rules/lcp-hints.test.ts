// perf/lcp-hints: per-page count, no item/image dump (squirrelscan/squirrelscan#16).

import type { RuleContext } from "@squirrelscan/rules";

import { perf } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

const { lcpHintsRule } = perf;

function pageCtx(html: string, url = "https://example.com/"): RuleContext {
  // Provide the pre-parsed document the runner supplies in production — the CWV
  // rules now read ctx.parsed.document (shared, parsed once) rather than
  // re-parsing ctx.page.html. See #262.
  return {
    page: { url, html, headers: {} },
    parsed: { document: parseHTML(html).document },
    options: {},
  } as unknown as RuleContext;
}

describe("perf/lcp-hints output", () => {
  test("reports a count, not a flat image list", () => {
    const html = `<!doctype html><html><head></head><body>
      <img src="/hero.jpg"><img src="/banner.png"></body></html>`;
    const { checks } = lcpHintsRule.run(pageCtx(html)) as { checks: any[] };
    const c = checks.find((x) => x.name === "lcp-preload");

    expect(c.status).toBe("warn");
    expect(c.value).toBe(2);
    expect(c.message).toContain("2 likely-LCP images");
    // No explicit items / image dump — the report auto-generates one per-page
    // item from the message, so the count survives grouping per page.
    expect(c.items).toBeUndefined();
    expect(c.details).toBeUndefined();
  });

  test("singular wording for one image", () => {
    const html = `<!doctype html><html><body><img src="/hero.jpg"></body></html>`;
    const { checks } = lcpHintsRule.run(pageCtx(html)) as { checks: any[] };
    const c = checks.find((x) => x.name === "lcp-preload");
    expect(c.value).toBe(1);
    expect(c.message).toContain("1 likely-LCP image ");
  });

  test("passes when no large unpreloaded images", () => {
    const html = `<!doctype html><html><body>
      <img src="/thumb.jpg" loading="lazy"></body></html>`;
    const { checks } = lcpHintsRule.run(pageCtx(html)) as { checks: any[] };
    const c = checks.find((x) => x.name === "lcp-preload");
    expect(c.status).toBe("pass");
  });
});
