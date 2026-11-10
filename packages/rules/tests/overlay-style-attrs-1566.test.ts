// #1566: a `<style>` block is read whatever its `media` or `type` attribute says, which the rule page states as a
// limit. Pinned so the page and the code cannot drift apart: a decoy in a block a browser would not apply still
// counts as a decoy (it hides the cover), and a cover in one is still a cover.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { detectFakeAuthOverlay } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

const url = "https://example.com/";
const FIXED = "position:fixed;inset:0;z-index:9999;width:100%;height:100%";
const FRAME = '<iframe id="google-auth" class="cover" srcdoc=""></iframe>';

function fires(styles: string): boolean {
  const html = `<!doctype html><html><head><title>F</title>${styles}</head><body><main><h1>F</h1>${FRAME}</main></body></html>`;
  const parsed = parsePage(html, url);
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
  return detectFakeAuthOverlay(ctx) !== null;
}

const COVER = `<style>.cover{${FIXED}}</style>`;

describe("a <style> block is read whatever its media or type says", () => {
  test("the control: a cover in a plain block fires, and a decoy after it in a plain block hides it", () => {
    expect(fires(COVER)).toBe(true);
    expect(fires(`${COVER}<style>.cover{position:static}</style>`)).toBe(false);
  });

  for (const attrs of ['media="print"', 'type="text/plain"', "disabled", 'media="not all"']) {
    test(`a decoy in <style ${attrs}> still counts as a decoy`, () => {
      expect(fires(`${COVER}<style ${attrs}>.cover{position:static}</style>`)).toBe(false);
    });

    test(`a cover in <style ${attrs}> is still a cover`, () => {
      expect(fires(`<style ${attrs}>.cover{${FIXED}}</style>`)).toBe(true);
    });
  }
});
