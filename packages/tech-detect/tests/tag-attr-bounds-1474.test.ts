// #1474: the in-tag patterns of every family that reads a script, link, img or iframe tag stay linear on line-start openers inside
// a quoted attribute, and a real tag split over several lines still matches. Synthetic hosts; one 1 MB attribute per family.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const page = (head: string, body = "") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const ids = (html: string): string[] => detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id);
const MB = 1_048_576;
const rep = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));

/** A real tag per family: the technology it names, and the tag written with every attribute on its own line. */
const FAMILIES: Array<{ tag: string; id: string; lines: string; one: string }> = [
  {
    tag: "script",
    id: "lovable",
    lines: '<script\n  data-a="1"\n  async\nsrc="https://cdn.gpteng.co/lovable.js"\n></script>',
    one: '<script src="https://cdn.gpteng.co/lovable.js"></script>',
  },
  {
    tag: "link",
    id: "bulma",
    lines: '<link\n  rel="stylesheet"\n  crossorigin\nhref="https://cdn.example.net/css/bulma.min.css"\n>',
    one: '<link rel="stylesheet" href="https://cdn.example.net/css/bulma.min.css">',
  },
  {
    tag: "img",
    id: "linkedin-insight",
    lines: '<img\n  height="1"\n  alt=""\n  hidden\nsrc="https://px.ads.linkedin.com/collect/?pid=1"\n>',
    one: '<img src="https://px.ads.linkedin.com/collect/?pid=1">',
  },
  {
    tag: "iframe",
    id: "youtube-embed",
    lines: '<iframe\n  width="560"\n  allowfullscreen\nsrc="https://www.youtube.com/embed/abc"\n></iframe>',
    one: '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
  },
];

describe("a real tag split over lines still matches", () => {
  for (const { tag, id, lines, one } of FAMILIES) {
    test(`${tag}: attributes on separate lines, in the head and in the body`, () => {
      expect(ids(page(one))).toContain(id);
      expect(ids(page(lines))).toContain(id);
      expect(ids(page("", lines))).toContain(id);
    });
  }
});

describe("1 MB of line-start openers inside one quoted attribute", () => {
  for (const { tag, id, one } of FAMILIES) {
    test(`${tag}: the tag is read in linear time and a real tag after it still matches`, () => {
      for (const quote of ['"', "'"]) {
        // script and iframe are closed: an open one would hold the real tag as its content, as a browser reads it
        const close = tag === "script" || tag === "iframe" ? `</${tag}>` : "";
        const hostile = `<${tag} a=${quote}${rep(`\n<${tag}`, MB)}${quote}>${close}`;
        const started = performance.now();
        expect(ids(page("", hostile + one))).toContain(id);
        // Seconds were minutes for the Klaviyo patterns before the tempered in-tag scan (3.2 s for the 1 MB script case before the fix);
        // 50 to 85 ms now. The bound is over 20 times that, well over a loaded machine's jitter and under the pre-fix cost.
        expect(performance.now() - started).toBeLessThan(2_000);
      }
    }, 240_000);

    test(`${tag}: 1 MB of '<${tag} a="' newline openers (an opener per line with the quote left open)`, () => {
      const started = performance.now();
      ids(page("", rep(`<${tag} a="\n`, MB)));
      ids(page("", rep(`<${tag} a='\n`, MB)));
      // Two 1 MB pages: 125 to 305 ms now, so the bound is over 6 times that.
      expect(performance.now() - started).toBeLessThan(2_000);
    }, 240_000);
  }
});
