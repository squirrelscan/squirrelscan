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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadAllRules } from "../src/loader";
import { mayFanOutAcrossTemplate } from "../src/types";

const SRC = join(import.meta.dir, "../src");

type Reviewed = { keyed: string[]; unkeyed: string[] };

/**
 * `getCWVHints` (src/performance/cwv.ts), which three rules hand their document
 * and raw HTML to. The scan counts every read in that file, so this is all of
 * them: preload, prefetch, preconnect and dns-prefetch links, script `type`,
 * `async`, `defer` and `nomodule`, stylesheet `media`, images and iframes with
 * their size and style, and the raw HTML.
 */
const CWV_HINTS: Reviewed = {
  keyed: ["page.url", "script[src]"],
  unkeyed: [
    "@async",
    "@defer",
    "@height",
    "@href",
    "@language",
    "@media",
    "@nomodule",
    "@src",
    "@style",
    "@type",
    "@width",
    "helper:analyzeCWVHints",
    "helper:collectImagePreloadKeys",
    "helper:findLcpCandidates",
    "helper:get",
    "helper:getCWVHints",
    "helper:set",
    "iframe",
    "img",
    'link[rel="dns-prefetch"]',
    'link[rel="preconnect"]',
    'link[rel="prefetch"]',
    'link[rel="preload"]',
    'link[rel="stylesheet"]:not([media="print"])',
    "page.html",
    "script[src], link[href], img[src]",
  ],
};

/**
 * Every read the scan finds in each template-declared rule, by rule id.
 *
 * KEYED means the fan-out key checks the value the rule reads, for every
 * element it reads it from: script srcs and stylesheet hrefs with their
 * `integrity`, every meta's name and the content of the metas rules read, the
 * `<main>` count, the `<html>` lang / xml:lang / aria-hidden, the `<body>`
 * aria-hidden, icon link rel and href in document order (#614), and the page
 * origin (which is what the `ctx.page.url` readers compare hosts against). An
 * attribute a rule also reads from an element the key does not cover (`@src` on
 * an image) is UNKEYED for that rule.
 *
 * UNKEYED means two pages can share the key and still differ here, so the
 * declaration rests on the site's templates being built that way (see the
 * VerdictScope doc, which also names what no entry here captures: order,
 * `<noscript>` ancestry and head placement). Fixing one means extending
 * `fanoutInputSignature` and moving it to KEYED, or making the rule page-scoped.
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
  "a11y/meta-refresh": {
    keyed: ["@content", "@http-equiv", "meta"],
    unkeyed: [],
  },
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
    keyed: CWV_HINTS.keyed,
    // Every `<link href>` (preloads included), on top of the CWV hints.
    unkeyed: [...CWV_HINTS.unkeyed, "link[href]"],
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
  "perf/preconnect": CWV_HINTS,
  "perf/render-blocking": CWV_HINTS,
  "perf/unminified-css": {
    keyed: ["@href"],
    // An exact `rel="stylesheet"`: the key matches the token, so
    // `rel="alternate stylesheet"` keys the same and selects differently here.
    unkeyed: ['link[rel="stylesheet"]', "style", "textContent"],
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
    keyed: ["page.url", "script[src]"],
    // Iframes and images, their `src` included, and their size.
    unkeyed: ["@height", "@src", "@width", "iframe[src]", "img[src]"],
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

/**
 * Source with its comments removed and its strings, template literals and regex
 * literals kept, so a commented-out read neither counts nor hides behind a `//`
 * inside a url or a regex. A `/` opens a regex where an operand is expected: at
 * the start, after an operator or punctuation, or after a keyword like `return`.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
      continue;
    }
    let end = -1;
    if (c === '"' || c === "'" || c === "`") {
      end = i + 1;
      while (end < src.length && src[end] !== c && (c === "`" || src[end] !== "\n")) {
        end += src[end] === "\\" ? 2 : 1;
      }
    } else if (c === "/") {
      const before = out.trimEnd();
      const operandBefore =
        /[\w$)\]}]$/.test(before) &&
        !/\b(?:return|typeof|case|in|of|new|delete|void|throw|yield|await)$/.test(before);
      if (!operandBefore) {
        end = i + 1;
        let inClass = false;
        while (end < src.length && src[end] !== "\n") {
          const d = src[end];
          if (d === "\\") end++;
          else if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          end++;
        }
      }
    }
    if (end >= 0) {
      out += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The reads the scan finds in one rule source, in the notation REVIEWED uses. */
function scanReads(source: string): string[] {
  const text = stripComments(source);
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
  // The case-insensitive `@squirrelscan/utils` forms: getAttrCI(el, "http-equiv").
  add(String.raw`(?:getAttrCI|hasAttrCI)\(\s*[\w.?]+\s*,\s*${QUOTED}`, (m) => `@${m[2]}`);
  add(
    String.raw`(?:getAttrCI|hasAttrCI)\(\s*[\w.?]+\s*,\s*([A-Za-z_]\w*)\s*\)`,
    (m) => `attribute:${m[1]}`,
  );
  add(String.raw`\.matches\(\s*${QUOTED}`, (m) => `matches:${m[2]}`);
  add(String.raw`\.matches\(\s*([A-Za-z_]\w*)\s*\)`, (m) => `matches:${m[1]}`);
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

/** Helper name → the rules-package file it is imported from, for relative imports. */
function localHelperFiles(text: string, file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
    const base = resolve(dirname(file), m[2]!);
    const target = [`${base}.ts`, join(base, "index.ts")].find((p) => existsSync(p));
    if (!target) continue;
    for (const spec of m[1]!.split(",")) {
      const name = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
      if (name) out.set(name, target);
    }
  }
  return out;
}

/**
 * Rule id → the reads in its source, for every rule declaring `verdictScope:
 * "template"`. A document handed to a helper from this package also counts every
 * read in the helper's file (more than that call may make, never less).
 */
function templateRuleReads(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf-8");
    if (!/verdictScope:\s*"template"/.test(text)) continue;
    const id = text.match(/\bid:\s*"([^"]+)"/)?.[1];
    if (!id) throw new Error(`no rule id in ${file}`);
    const reads = new Set(scanReads(text));
    const helpers = localHelperFiles(text, file);
    for (const read of [...reads]) {
      const helperFile = read.startsWith("helper:") ? helpers.get(read.slice(7)) : undefined;
      if (helperFile) for (const r of scanReads(readFileSync(helperFile, "utf-8"))) reads.add(r);
    }
    out.set(id, [...reads].sort());
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
    expect(scanReads(`getAttrCI(meta, "http-equiv"); el.matches(sel)`)).toEqual([
      "@http-equiv",
      "matches:sel",
    ]);
    expect(scanReads(`getAttrCI(meta, name); hasAttrCI(el, attr)`)).toEqual([
      "attribute:attr",
      "attribute:name",
    ]);
    // A commented-out read is not a read, and a `//` inside a string or a regex
    // literal is not a comment.
    expect(scanReads(`// el.getAttribute("data-x")\nconst u = "https://x"; el.getAttribute("rel")`)).toEqual([
      "@rel",
    ]);
    expect(scanReads(`const re = /https?:\\/\\//; el.getAttribute("data-new");`)).toEqual(["@data-new"]);
    expect(scanReads(`const re = /["']/; // el.getAttribute("data-comment")`)).toEqual([]);
    expect(scanReads(`const half = a / 2; /* el.getAttribute("x") */ el.getAttribute("y")`)).toEqual(["@y"]);
    // And in the real sources: a helper-call selector, a raw-HTML read and a
    // variable selector are all found where the rules make them.
    expect(scanned.get("security/third-party-cookies")).toContain("iframe[src]");
    expect(scanned.get("core/doctype")).toContain("page.html");
    expect(scanned.get("core/favicon")).toContain("selector:selector");
    // A helper from this package is scanned too: getCWVHints reads preconnect links.
    expect(scanned.get("perf/preconnect")).toContain('link[rel="preconnect"]');
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
