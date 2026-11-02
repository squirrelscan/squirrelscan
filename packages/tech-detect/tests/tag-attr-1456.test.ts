// #1456: signatures that read a tag's attribute (a script `src`, a `link href`, a `data-*` flag) read one parsed list of
// the page's tags instead of each scanning the HTML for `<script\s`, `<link\b`: the same answers on real markup, plus
// the unquoted and late-attribute forms the bounded scans missed, and a page of unclosed openers costs seconds, not
// minutes. Synthetic fixtures.

import { describe, expect, test } from "bun:test";

import { ALL_FINGERPRINTS, detectTechnologies } from "../src";
import { assertCollectedTags } from "../src/collected-tags";

const page = (head: string, body = "") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const ids = (html: string, scripts?: Array<{ url: string; content?: string }>): string[] =>
  detectTechnologies({ url: "https://example.com/", headers: {}, html, ...(scripts ? { scripts } : {}) }).map((t) => t.id);
const BODIES = [{ url: "https://example.com/app.js", content: "var a=1;" }];
/** One detection of a page: the milliseconds it took and how many times the per-page time budget cut the scan short. */
const timed = (html: string): { ms: number; exceeded: number } => {
  let exceeded = 0;
  const started = performance.now();
  detectTechnologies({ url: "https://example.com/", headers: {}, html }, ALL_FINGERPRINTS, { onBudgetExceeded: () => exceeded++ });
  return { ms: performance.now() - started, exceeded };
};

describe("script src signatures", () => {
  test("quoted, single-quoted and unquoted src; a src after a long run of other attributes", () => {
    const long = Array.from({ length: 80 }, (_, i) => `data-k${i}="v${i}"`).join(" ");
    for (const tag of [
      '<script src="https://cdn.gpteng.co/lovable.js"></script>',
      "<script src='https://cdn.gpteng.co/lovable.js'></script>",
      "<script src=https://cdn.gpteng.co/lovable.js></script>",
      `<script ${long} src="https://cdn.gpteng.co/lovable.js"></script>`,
      '<SCRIPT SRC="https://cdn.gpteng.co/lovable.js"></SCRIPT>',
    ]) {
      expect(ids(page(tag)), tag).toContain("lovable");
      expect(ids(page(tag), BODIES), tag).toContain("lovable");
    }
  });

  test("a commented-out tag, data-src, an anchor and prose are not a script", () => {
    for (const html of [
      page('<!-- <script src="https://cdn.gpteng.co/lovable.js"></script> -->'),
      page('<script data-src="https://cdn.gpteng.co/lovable.js"></script>'),
      page("", '<a href="https://cdn.gpteng.co/lovable.js">x</a><p>https://cdn.gpteng.co/lovable.js</p>'),
    ]) {
      expect(ids(html)).not.toContain("lovable");
      expect(ids(html, BODIES)).not.toContain("lovable");
    }
  });
});

describe("resource attributes and data attributes", () => {
  test("a stylesheet link and a srcset token", () => {
    expect(ids(page('<link rel="stylesheet" href="https://cdn.example.net/css/bulma.min.css">'))).toContain("bulma");
    expect(ids(page('<link href="/static/bulma.css" rel="stylesheet">'))).toContain("bulma");
  });

  test("a link is not an anchor", () => {
    expect(ids(page("", '<a href="/css/bulma.min.css">x</a>'))).not.toContain("bulma");
  });

  test("a script's data attribute flags (Clerk, RequireJS)", () => {
    expect(ids(page('<script data-clerk-js-script src="/c.js"></script>'))).toContain("clerk");
    expect(ids(page('<script data-clerk-publishable-key="pk_test_abc" src="/c.js"></script>'))).toContain("clerk");
    expect(ids(page('<script data-main="js/app" src="require.js"></script>'))).toContain("requirejs");
    expect(ids(page('<script data-clerk-publishable-key="nope" src="/c.js"></script>'))).not.toContain("clerk");
  });

  test("Meta Pixel by its script src", () => {
    expect(ids(page('<script async src="https://connect.facebook.net/en_US/fbevents.js"></script>'))).toContain("facebook-pixel");
  });
});

test("a tag-attr detector on a tag the page pass does not collect is refused where it is built", () => {
  expect(() => assertCollectedTags(["script", "link"])).not.toThrow();
  expect(() => assertCollectedTags(["a"])).toThrow(/does not collect/);
});

describe("hostile pages (5 MB)", () => {
  const rep = (unit: string): string => page("", unit.repeat(Math.ceil(5_000_000 / unit.length)));
  for (const tag of ["script", "link", "img", "iframe"]) {
    for (const [label, unit] of [["unclosed openers", `<${tag} `], ["unbalanced quotes", `<${tag} x="`]] as const) {
      test(`${tag}: ${label}`, () => {
        const { ms, exceeded } = timed(rep(unit));
        // Minutes before the change (every signature rescanned 400 characters after each opener); 0.2 to 0.55 s now.
        expect(ms).toBeLessThan(tag === "iframe" ? 6_000 : 2_000);
        // The page pass is read once for every signature: a rescan per signature would run into the per-page budget.
        expect(exceeded).toBe(0);
      }, 120_000);
    }
  }
});

describe("bounds (review of #1467)", () => {
  test("hostile openers: a quote then a newline, and a 1 MB attribute value", () => {
    const rep = (unit: string): string => page("", unit.repeat(Math.ceil(5_000_000 / unit.length)));
    for (const html of [rep('<img a="\n'), rep("<script a='\n"), page("", `<img alt="${"x".repeat(1_000_000)}" src="/a.png">`), page("", `<script src="${"y".repeat(1_000_000)}"></script>`)]) {
      const { ms, exceeded } = timed(html);
      // 60 to 380 ms now (the two 5 MB cases the slowest): the bound is over 5 times that.
      expect(ms).toBeLessThan(2_000);
      expect(exceeded).toBe(0);
    }
  }, 120_000);

  test("a 5 MB page of closed script, img and link tags is read once for every signature", () => {
    const unit = '<script src="https://cdn.example.net/a.js"></script><img src="https://cdn.example.net/i.png"><link rel="stylesheet" href="https://cdn.example.net/s.css">';
    const { ms, exceeded } = timed(page("", unit.repeat(Math.ceil(5_000_000 / unit.length))));
    // 1.3 to 1.6 s now; a rescan of the page for each signature is over the 5 s per-page budget.
    expect(ms).toBeLessThan(2_500);
    expect(exceeded).toBe(0);
  }, 120_000);

  test("a page of tags with 100 attributes each keeps only what a signature reads, and nothing after the call", () => {
    const attributes = Array.from({ length: 100 }, (_, i) => `data-a${i}="value ${i}"`).join(" ");
    const html = page("", `<img ${attributes} src="/a.png">`.repeat(Math.ceil(8_000_000 / (attributes.length + 20))));
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    ids(html);
    Bun.gc(true);
    // Retained after the call: before the fix the 100,000 collected tags each kept a hundred attributes (255 MB).
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(60_000_000);
  }, 120_000);

  test("a signature list that reads no tag attribute keeps none, and a custom list reads its own", () => {
    const custom = [{ id: "x", name: "X", category: "other" as const, detectors: [{ type: "tag-attr" as const, tags: ["img"], attrs: ["data-x"], pattern: /^yes$/ }] }];
    const found = (html: string) => detectTechnologies({ url: "https://example.com/", headers: {}, html }, custom).map((t) => t.id);
    expect(found(page("", '<img data-x="yes">'))).toEqual(["x"]);
    expect(found(page("", '<img data-x="no">'))).toEqual([]);
    // The built-in signatures still read theirs afterwards (the attribute set is per call).
    expect(ids(page('<script src="https://cdn.gpteng.co/lovable.js"></script>'))).toContain("lovable");
  });
});

describe("a real tag with its attributes on separate lines (#1474)", () => {
  test("script src, link rel and href, a clerk key, data-main and a Meta Pixel script", () => {
    for (const [id, tag] of [
      ["lovable", '<script\n async\n src="https://cdn.gpteng.co/lovable.js"\n></script>'],
      ["bulma", '<link\n rel="stylesheet"\n href="https://cdn.example.net/css/bulma.min.css"\n>'],
      ["bulma", '<link\n href="https://cdn.example.net/css/bulma.min.css"\n rel="stylesheet"\n>'],
      ["clerk", '<script\n data-clerk-publishable-key="pk_test_abc"\n src="/c.js"\n></script>'],
      ["requirejs", '<script\n data-main="js/app"\n src="require.js"\n></script>'],
      ["facebook-pixel", '<script\n async\n src="https://connect.facebook.net/en_US/fbevents.js"\n></script>'],
    ] as const) {
      expect([id, tag.slice(0, 30), ids(page(tag))]).toEqual([id, tag.slice(0, 30), expect.arrayContaining([id])]);
    }
  });
});

describe("line-start openers inside one quoted attribute (#1474): 1 MB, script, link and img", () => {
  const MB = 1_048_576;
  const shape = (tag: string): string => {
    const unit = `\n<${tag} `;
    return page("", `<${tag} data-x="${unit.repeat(Math.ceil(MB / unit.length))}" src="/a.js">`);
  };
  const ctx = (html: string) => ({ url: "https://example.com/", headers: {}, html });

  test("every built-in together, twice", () => {
    for (const tag of ["script", "link", "img"]) {
      const html = shape(tag);
      for (let round = 0; round < 2; round++) {
        const started = performance.now();
        detectTechnologies(ctx(html));
        // measured under 350 ms; the Klaviyo patterns took minutes before the tempered in-tag scan
        expect([tag, round, performance.now() - started < 1_500]).toEqual([tag, round, true]);
      }
    }
  }, 120_000);

  test("each fingerprint alone, twice (there is no built-in <img> in-tag fingerprint: the img shape is a guard)", () => {
    const slow: string[] = [];
    for (const tag of ["script", "link", "img"]) {
      const input = ctx(shape(tag));
      for (const fp of ALL_FINGERPRINTS) {
        for (let round = 0; round < 2; round++) {
          const started = performance.now();
          detectTechnologies(input, [fp]);
          const ms = performance.now() - started;
          if (ms > 400) slow.push(`${tag} ${fp.id} ${Math.round(ms)} ms`);
        }
      }
    }
    expect(slow).toEqual([]);
  }, 600_000);
});
