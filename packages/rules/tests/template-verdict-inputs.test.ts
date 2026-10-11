// Tripwire for the template fan-out key (#614). A rule that declares
// `verdictScope: "template"` has its verdict copied to every page that shares
// its fan-out key: the chrome key, the page origin and `fanoutInputSignature`
// (packages/audit-engine/src/template-fanout.ts). This test scans each declared
// rule's source for the inputs it reads and fails unless every one is listed in
// REVIEWED, marked KEYED (the key covers it) or UNKEYED (it does not). A rule
// that starts reading something new therefore fails CI until someone checks the
// read against the key and either extends `fanoutInputSignature` or records it.
//
// What the scan sees: string-literal selectors passed to `querySelector*` (the
// `@squirrelscan/utils` helpers included), `getAttribute` / `hasAttribute`
// names, `.matches()` selectors, raw `ctx.page.html`, `textContent`,
// `innerHTML`, `documentElement`, `doc.body` and `ctx.page.url`. A selector or
// attribute held in a variable is recorded by the variable's name, and a
// document handed to a helper is recorded by the helper's name: what those read
// is not seen, which is why they are reviewed entries too. The VerdictScope doc
// in src/types.ts names every rule with an UNKEYED read (the last test here
// holds it to that).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadAllRules } from "../src/loader";
import { mayFanOutAcrossTemplate } from "../src/types";

const SRC = join(import.meta.dir, "../src");

type Reviewed = { keyed: string[]; unkeyed: string[] };

/**
 * Every read the scan finds in each template-declared rule, by rule id.
 *
 * KEYED means the fan-out key checks it: script srcs and stylesheet hrefs with
 * their `integrity`, every meta's name and the content of the metas rules read,
 * the `<main>` count, the `<html>` lang / xml:lang / aria-hidden, the `<body>`
 * aria-hidden, icon link rel and href (#614), and the page origin (which is what
 * the `ctx.page.url` readers compare hosts against).
 *
 * UNKEYED means two pages can share the key and still differ here, so the
 * declaration rests on the site's templates being built that way (see the
 * VerdictScope doc). Fixing one means extending `fanoutInputSignature` and
 * moving it to KEYED, or making the rule page-scoped.
 */
const REVIEWED: Record<string, Reviewed> = {
  "a11y/aria-hidden-body": {
    keyed: ["@aria-hidden", "body", "documentElement"],
    unkeyed: [],
  },
  "a11y/focus-visible": { keyed: [], unkeyed: ["page.html"] },
  "a11y/html-xml-lang-mismatch": {
    keyed: ["@lang", "@xml:lang", "documentElement"],
    unkeyed: [],
  },
  "a11y/landmark-one-main": {
    keyed: ['main, [role="main"]'],
    // The first main's id and class, which its message names.
    unkeyed: ["@class", "@id"],
  },
  "a11y/meta-refresh": { keyed: ["@content", "meta"], unkeyed: [] },
  "a11y/zoom-disabled": {
    keyed: ["@content", 'meta[name="viewport"]', "meta[name='viewport']"],
    unkeyed: [],
  },
  "analytics/consent-mode": { keyed: [], unkeyed: ["page.html"] },
  "analytics/gtm-present": {
    keyed: ["@src", "script[src]"],
    unkeyed: ["page.html"],
  },
  "core/doctype": { keyed: [], unkeyed: ["page.html"] },
  "core/favicon": {
    // `selector` walks five icon selectors, each a subset of link[rel*="icon"].
    keyed: ["@href", "@rel", "selector:selector"],
    unkeyed: [],
  },
  "local/geo-meta": {
    keyed: [
      'meta[name="ICBM"]',
      'meta[name="geo.placename"]',
      'meta[name="geo.position"]',
      'meta[name="geo.region"]',
    ],
    unkeyed: [],
  },
  "mobile/viewport": {
    keyed: ["@content", 'meta[name="viewport"]', "meta[name='viewport']"],
    unkeyed: [],
  },
  "mobile/viewport-zoom": {
    keyed: ["@content", 'meta[name="viewport"]'],
    unkeyed: [],
  },
  "perf/browser-required": { keyed: [], unkeyed: [] },
  "perf/duplicate-js": { keyed: ["@src", "script[src]"], unkeyed: [] },
  "perf/font-delivery": {
    keyed: ["@href", "head", 'link[rel~="stylesheet"]', "page.url"],
    // The stylesheet `media`, and inline `<style>` bodies.
    unkeyed: ["@media", "style", "textContent"],
  },
  "perf/font-loading": {
    keyed: ["@href", "page.url"],
    // Every `<link href>` (preloads included), and the raw HTML.
    unkeyed: ["helper:getCWVHints", "link[href]", "page.html"],
  },
  "perf/js-libraries": {
    keyed: ["@src"],
    // Inline scripts and their bodies, and the raw HTML.
    unkeyed: ["page.html", "script", "textContent"],
  },
  "perf/legacy-js": {
    keyed: ["@src", "script[src]"],
    unkeyed: [
      "@type",
      "script:not([src])",
      "script[nomodule]",
      'script[type="module"]',
      "textContent",
    ],
  },
  "perf/preconnect": {
    keyed: ["page.url"],
    unkeyed: ["helper:getCWVHints", "page.html"],
  },
  "perf/render-blocking": {
    keyed: ["page.url"],
    unkeyed: ["helper:getCWVHints", "page.html"],
  },
  "perf/unminified-css": {
    keyed: ["@href", 'link[rel="stylesheet"]'],
    unkeyed: ["style", "textContent"],
  },
  "perf/unminified-js": {
    keyed: ["@src", "script[src]"],
    unkeyed: ["@type", "script:not([src])", "textContent"],
  },
  "security/sri": {
    keyed: [
      "@href",
      "@integrity",
      "@src",
      'link[rel~="stylesheet"][href]',
      "page.url",
      "script[src]",
    ],
    unkeyed: [],
  },
  "security/third-party-cookies": {
    keyed: ["@src", "page.url", "script[src]"],
    // Iframes and images, and an image's size.
    unkeyed: ["@height", "@width", "iframe[src]", "img[src]"],
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const QUOTED = String.raw`(["'\x60])(.*?)\1`;
/** An optional leading root argument, as in `querySelectorAllOutsideNoscript(doc, …)`. */
const ROOT_ARG = String.raw`(?:[\w.?]+\s*,\s*)?`;
const DOCUMENT_ARG = String.raw`(?:ctx\.parsed\.document|doc|document|head)\b`;

/** The reads the scan finds in one rule source, in the notation REVIEWED uses. */
function scanReads(text: string): string[] {
  const reads = new Set<string>();
  const add = (re: string, f: (m: RegExpMatchArray) => string) => {
    for (const m of text.matchAll(new RegExp(re, "g"))) reads.add(f(m));
  };
  // querySelectorAllByAttrCI(doc, "script", "nomodule") → script[nomodule]
  add(
    String.raw`querySelector\w*ByAttr\w*\(\s*${ROOT_ARG}(["'])(.*?)\1\s*,\s*(["'])(.*?)\3`,
    (m) => `${m[2]}[${m[4]}]`,
  );
  add(String.raw`querySelector(?:All)?(?:OutsideNoscript)?\(\s*${ROOT_ARG}${QUOTED}`, (m) => m[2]!);
  add(String.raw`querySelector\w*\(\s*${ROOT_ARG}([A-Za-z_]\w*)\s*\)`, (m) => `selector:${m[1]}`);
  add(String.raw`(?:getAttribute|hasAttribute)\(\s*${QUOTED}`, (m) => `@${m[2]}`);
  add(String.raw`(?:getAttribute|hasAttribute)\(\s*([A-Za-z_]\w*)\s*\)`, (m) => `attribute:${m[1]}`);
  add(String.raw`\.matches\(\s*${QUOTED}`, (m) => `matches:${m[2]}`);
  add(String.raw`\b([A-Za-z_]\w*)\(\s*${DOCUMENT_ARG}`, (m) =>
    m[1]!.startsWith("querySelector") ? "" : `helper:${m[1]}`,
  );
  reads.delete("");
  const channels: Array<[string, RegExp]> = [
    ["page.html", /\bctx\.page\.html\b/],
    ["page.url", /\bctx\.page\.url\b/],
    ["textContent", /\.textContent\b/],
    ["innerHTML", /\.innerHTML\b/],
    ["documentElement", /\.documentElement\b/],
    ["body", /\bdoc(?:ument)?\??\.body\b/],
  ];
  for (const [name, re] of channels) if (re.test(text)) reads.add(name);
  return [...reads].sort();
}

/** Rule id → the reads in its source, for every rule declaring `verdictScope: "template"`. */
function templateRuleReads(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf-8");
    if (!/verdictScope:\s*"template"/.test(text)) continue;
    const id = text.match(/\bid:\s*"([^"]+)"/)?.[1];
    if (!id) throw new Error(`no rule id in ${file}`);
    out.set(id, scanReads(text));
  }
  return out;
}

describe("template-declared rules read only reviewed inputs (#614)", () => {
  const scanned = templateRuleReads();

  test("the source scan finds exactly the rules the registry fans out", () => {
    const declared = [...loadAllRules().values()]
      .filter((rule) => mayFanOutAcrossTemplate(rule.meta))
      .map((rule) => rule.meta.id)
      .sort();
    expect([...scanned.keys()].sort()).toEqual(declared);
    expect(Object.keys(REVIEWED).sort()).toEqual(declared);
  });

  test("every read of every declared rule is reviewed as KEYED or UNKEYED", () => {
    for (const [id, reads] of scanned) {
      const reviewed = REVIEWED[id] ?? { keyed: [], unkeyed: [] };
      // Both directions: a new read fails, and so does a stale entry, so the list
      // stays the exact set of inputs the doc and the key are checked against.
      expect({ id, reads }).toEqual({
        id,
        reads: [...reviewed.keyed, ...reviewed.unkeyed].sort(),
      });
      expect(reviewed.keyed.filter((r) => reviewed.unkeyed.includes(r))).toEqual([]);
    }
  });

  test("the scan sees each form of read it claims to", () => {
    expect(scanReads(`querySelectorAllOutsideNoscript(doc, "iframe[src]")`)).toEqual(["iframe[src]"]);
    expect(scanReads(`querySelectorAllByAttrCI(doc, "script", "nomodule")`)).toEqual([
      "script[nomodule]",
    ]);
    expect(scanReads(`doc.querySelectorAll(selector)`)).toEqual(["selector:selector"]);
    expect(scanReads(`el.getAttribute("lang"); el.getAttribute(name)`)).toEqual([
      "@lang",
      "attribute:name",
    ]);
    expect(scanReads(`getCWVHints(ctx.parsed.document, ctx.page.html)`)).toEqual([
      "helper:getCWVHints",
      "page.html",
    ]);
    expect(scanReads(`const b = doc.body; s.textContent`)).toEqual(["body", "textContent"]);
    // And in the real sources: a helper-call selector, a raw-HTML read and a
    // variable selector are all found where the rules make them.
    expect(scanned.get("security/third-party-cookies")).toContain("iframe[src]");
    expect(scanned.get("core/doctype")).toContain("page.html");
    expect(scanned.get("core/favicon")).toContain("selector:selector");
  });

  test("the VerdictScope doc names every rule with an UNKEYED read", () => {
    const types = readFileSync(join(SRC, "types.ts"), "utf-8");
    const doc = types.slice(0, types.indexOf("export type VerdictScope"));
    const docBlock = doc.slice(doc.lastIndexOf("/**"));
    const unnamed = Object.entries(REVIEWED)
      .filter(([, r]) => r.unkeyed.length > 0)
      .map(([id]) => id)
      .filter((id) => !docBlock.includes(`\`${id}\``));
    expect(unnamed).toEqual([]);
  });
});
