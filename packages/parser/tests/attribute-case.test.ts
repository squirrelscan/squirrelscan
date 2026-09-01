// HTML attribute names are ASCII case-insensitive; linkedom compares them
// exactly. Every rule that reads an attribute by name was exposed in both
// directions: `getAttribute("inputmode")` missed `inputMode="url"` (React-style
// SSR emits camelCase), and on a lowercase page `getAttribute("inputMode")`
// missed it too. #1507.
//
// These tests pin three things together: HTML lookups ignore case, SVG does
// NOT, and parsing never rewrites what the document said. Writing is the one
// place a name changes, because a browser's setAttribute lowercases too. The
// two gaps left open on purpose, MathML and `dataset`, are pinned as well.

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";

import { installHtmlAttributeCaseInsensitivity, parseHTML } from "../src/dom";

function parse(body: string) {
  return parseHTML(`<!DOCTYPE html><html><body>${body}</body></html>`).document;
}

describe("HTML attribute lookup ignores case (#1507)", () => {
  test("a camelCase-authored attribute is found by its lowercase name", () => {
    const el = parse(`<input id="a" inputMode="url">`).getElementById("a")!;

    expect(el.getAttribute("inputmode")).toBe("url");
    expect(el.hasAttribute("inputmode")).toBe(true);
  });

  test("a lowercase attribute is found when the caller spells it in camelCase", () => {
    const el = parse(`<input id="b" inputmode="url">`).getElementById("b")!;

    expect(el.getAttribute("inputMode")).toBe("url");
    expect(el.hasAttribute("inputMode")).toBe(true);
  });

  test("the issue's reproduction now agrees with a browser", () => {
    const doc = parse(`
      <input id="a" inputMode="url">
      <input id="b" inputmode="url">
      <div id="c" DATA-Foo="1" aria-LABEL="hi"></div>
    `);
    const c = doc.getElementById("c")!;

    expect(doc.getElementById("a")!.getAttribute("inputmode")).toBe("url");
    expect(doc.getElementById("b")!.getAttribute("inputmode")).toBe("url");
    expect(c.getAttributeNames()).toEqual(["id", "data-foo", "aria-label"]);
    expect(c.getAttribute("data-foo")).toBe("1");
    expect(c.getAttribute("aria-label")).toBe("hi");
  });

  test("installing twice does not wrap the prototype twice", () => {
    // The install runs on import; a second call must be a no-op, or each extra
    // one adds a frame to every attribute read in the process.
    const el = parse(`<input id="a" inputMode="url">`).getElementById("a")!;
    const before = el.getAttributeNode;

    installHtmlAttributeCaseInsensitivity();
    installHtmlAttributeCaseInsensitivity();

    expect(el.getAttributeNode).toBe(before);
    expect(el.getAttribute("inputmode")).toBe("url");
  });

  test("case folding is ASCII, not Unicode", () => {
    // KELVIN SIGN lowercases to "k" under toLowerCase(), but HTML case
    // insensitivity is ASCII only, so a browser leaves this name as authored.
    // Spelled as a code point: as a literal it is indistinguishable from "K".
    const kelvin = "\u212A";
    const el = parse(`<div id="a" ${kelvin}="kelvin" ASCII-K="plain"></div>`).getElementById(
      "a",
    )!;

    expect(el.getAttribute("k")).toBeNull();
    expect(el.getAttribute(kelvin)).toBe("kelvin");
    expect(el.getAttributeNames()).toEqual(["id", kelvin, "ascii-k"]);
  });

  test("an absent attribute is still absent", () => {
    const el = parse(`<div id="a" data-foo="1"></div>`).getElementById("a")!;

    expect(el.getAttribute("data-bar")).toBeNull();
    expect(el.hasAttribute("data-bar")).toBe(false);
    expect(el.getAttributeNode("data-bar")).toBeNull();
  });

  test("an attribute selector matches whichever case either side spells", () => {
    const doc = parse(`
      <input id="a" inputMode="url">
      <input id="b" inputmode="url">
    `);

    expect(doc.querySelectorAll("[inputmode]")).toHaveLength(2);
    expect(doc.querySelectorAll("[inputMode]")).toHaveLength(2);
    expect(doc.querySelectorAll('[inputmode="url"]')).toHaveLength(2);
    expect(doc.getElementById("a")!.matches("[inputmode]")).toBe(true);
  });

  test("an uppercase CLASS reaches className, classList and class selectors", () => {
    // linkedom builds its DOMTokenList from getAttributeNode("class"), so
    // before the fix an uppercase CLASS was invisible to all three.
    const doc = parse(`<div id="a" CLASS="alpha beta"></div>`);
    const el = doc.getElementById("a")!;

    expect(el.className).toBe("alpha beta");
    expect(el.classList.contains("alpha")).toBe(true);
    expect(el.getAttribute("class")).toBe("alpha beta");
    expect(doc.querySelectorAll(".alpha")).toHaveLength(1);
  });

  test("the first spelling wins when a document repeats an attribute in two cases", () => {
    const el = parse(`<div id="a" DATA-Foo="1" DATA-FOO="2"></div>`).getElementById("a")!;

    expect(el.getAttribute("data-foo")).toBe("1");
  });

  test("an exact match still wins over an earlier mixed-case one", () => {
    // Documented divergence: a browser drops the second of two attributes that
    // differ only in case, so it would answer "1". Resolving that here would
    // mean indexing every attribute of every element on every lookup, to be
    // exact about markup that is invalid to begin with.
    const el = parse(`<div id="a" DATA-Foo="1" data-foo="2"></div>`).getElementById("a")!;

    expect(el.getAttribute("data-foo")).toBe("2");
  });
});

describe("SVG keeps case-sensitive attribute names", () => {
  const svg = () =>
    parse(
      `<svg id="s" viewBox="0 0 10 10" preserveAspectRatio="xMidYMid"><path d="M0 0"/></svg>`,
    ).getElementById("s")!;

  test("viewBox and preserveAspectRatio match only their exact spelling", () => {
    const s = svg();

    expect(s.getAttribute("viewBox")).toBe("0 0 10 10");
    expect(s.getAttribute("viewbox")).toBeNull();
    expect(s.getAttribute("preserveAspectRatio")).toBe("xMidYMid");
    expect(s.getAttribute("preserveaspectratio")).toBeNull();
    expect(s.hasAttribute("viewbox")).toBe(false);
  });

  test("getAttributeNames leaves foreign names alone", () => {
    expect(svg().getAttributeNames()).toEqual(["id", "viewBox", "preserveAspectRatio"]);
  });

  test("known gap: MathML gets the HTML rules, because linkedom has no MathML", () => {
    // linkedom specialises SVG but not MathML, so <math> reports the XHTML
    // namespace and definitionURL is reachable in lowercase, where a browser
    // would say null. Telling MathML elements from the HTML ones a <math>
    // subtree legitimately contains (integration points, breakout tags) needs
    // tree-construction context linkedom never recorded. definitionURL is the
    // only camelCase name the HTML parser produces for MathML, and no rule
    // reads it. Pinned so the gap is visible if that changes.
    const math = parse(`<math id="m" definitionURL="http://x"></math>`).getElementById("m")!;

    expect(math.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(math.getAttribute("definitionurl")).toBe("http://x");
  });
});

describe("no attribute is ever renamed", () => {
  const SOURCE = [
    `<input id="a" inputMode="url">`,
    `<div id="c" DATA-Foo="1" aria-LABEL="hi"></div>`,
    `<svg id="s" viewBox="0 0 10 10"><path d="M0 0" /></svg>`,
  ].join("");

  test("serialisation keeps the source spelling byte for byte", () => {
    const doc = parse(SOURCE);
    // Read every attribute first: a lookup must not disturb what is stored.
    doc.getElementById("c")!.getAttribute("data-foo");
    doc.getElementById("s")!.getAttribute("viewbox");

    expect(doc.body.innerHTML).toBe(SOURCE);
  });

  test("known gap: el.dataset does not see a mixed-case data- attribute", () => {
    // linkedom builds its DOMStringMap by walking el.attributes for a literal
    // "data-" prefix, without going through getAttributeNode. A browser would
    // answer "v" here. Pinned rather than fixed: nothing in the engine reads
    // dataset, and covering it means reimplementing the whole proxy.
    const el = parse(`<div id="c" DATA-Foo="v"></div>`).getElementById("c")!;

    expect(el.getAttribute("data-foo")).toBe("v");
    expect(el.dataset.foo).toBeUndefined();
  });

  test("el.attributes still reports the author's spelling", () => {
    const el = parse(SOURCE).getElementById("c")!;

    expect([...el.attributes].map((a) => a.name)).toEqual(["id", "DATA-Foo", "aria-LABEL"]);
    expect(el.getAttributeNode("data-foo")!.name).toBe("DATA-Foo");
  });
});

describe("mutation keeps the lookup index honest", () => {
  test("setAttribute lowercases the name, as a browser does", () => {
    const el = parse(`<div id="a"></div>`).getElementById("a")!;
    // linkedom's setAttribute asks getAttributeNode first, so an index rebuilt
    // during the call would cache the pre-insert state and hide this forever.
    el.getAttribute("data-bar");
    el.setAttribute("DATA-Bar", "2");

    expect(el.getAttribute("data-bar")).toBe("2");
    expect([...el.attributes].map((a) => a.name).sort()).toEqual(["data-bar", "id"]);
  });

  test("writing a mixed-case class keeps className and class selectors in step", () => {
    // linkedom refreshes its cached class list only for the literal name
    // "class", so writing CLASS wrote the value and left className, classList
    // and every class selector answering the old one.
    const doc = parse(`<div id="a" CLASS="alpha"></div>`);
    const el = doc.getElementById("a")!;
    expect(el.className).toBe("alpha");

    el.setAttribute("CLASS", "beta");

    expect(el.className).toBe("beta");
    expect(el.getAttribute("class")).toBe("beta");
    expect(doc.querySelectorAll(".beta")).toHaveLength(1);
    expect(doc.querySelectorAll(".alpha")).toHaveLength(0);
  });

  test("a foreign attribute is still written with the case given", () => {
    const el = parse(`<svg id="s"></svg>`).getElementById("s")!;
    el.setAttribute("viewBox", "0 0 2 2");

    expect(el.getAttribute("viewBox")).toBe("0 0 2 2");
    expect(el.outerHTML).toContain(`viewBox="0 0 2 2"`);
  });

  test("setAttributeNS does not lowercase, because a browser's does not", () => {
    // linkedom implements setAttributeNS by delegating to setAttribute, which
    // now lowercases; the namespaced form has to keep the name it was given.
    const el = parse(`<div id="a"></div>`).getElementById("a")!;
    el.setAttributeNS(null, "DATA-X", "v");

    expect([...el.attributes].map((a) => a.name).sort()).toEqual(["DATA-X", "id"]);
    expect(el.getAttribute("DATA-X")).toBe("v");
    // A browser would answer null here, having lowercased the argument and
    // found no `data-x`. Reaching a mixed-case stored name by its lowercase
    // spelling is the whole point of the fix, and there is nothing to tell a
    // name set this way apart from one an author wrote.
    expect(el.getAttribute("data-x")).toBe("v");
  });

  test("setAttributeNode keeps a mixed-case class in step with className", () => {
    // These take an Attr node, so they can install a name setAttribute would
    // have lowercased. linkedom rebuilds its cached class list for the literal
    // name "class" only.
    const doc = parse(`<div id="a" class="alpha"></div>`);
    const el = doc.getElementById("a")!;
    expect(el.className).toBe("alpha");

    const attr = doc.createAttribute("CLASS");
    attr.value = "beta";
    el.removeAttribute("class");
    el.setAttributeNode(attr);

    expect(el.className).toBe("beta");
    expect(doc.querySelectorAll(".beta")).toHaveLength(1);
    expect(doc.querySelectorAll(".alpha")).toHaveLength(0);
  });

  test("and leaves the value it was handed exactly as given", () => {
    // Rebuilding the token list writes back its own joined spelling; a browser
    // stores what setAttributeNode was given, whitespace and all.
    const doc = parse(`<div id="a"></div>`);
    const el = doc.getElementById("a")!;
    const attr = doc.createAttribute("CLASS");
    attr.value = "  alpha   beta  ";
    el.setAttributeNode(attr);

    expect(el.getAttributeNode("class")!.value).toBe("  alpha   beta  ");
    expect(el.classList.contains("alpha")).toBe(true);
    expect(el.classList.contains("beta")).toBe(true);
  });

  test("setAttributeNS keeps a mixed-case class in step too", () => {
    // It skips the lowercasing, so a CLASS written this way reaches the class
    // attribute through getAttributeNode but would miss the class list.
    const doc = parse(`<div id="a" class="alpha"></div>`);
    const el = doc.getElementById("a")!;
    expect(el.className).toBe("alpha");

    el.setAttributeNS(null, "CLASS", "beta");

    expect(el.getAttribute("class")).toBe("beta");
    expect(el.className).toBe("beta");
    expect(doc.querySelectorAll(".beta")).toHaveLength(1);
  });

  test("setting a lowercase attribute in mixed case updates it in place", () => {
    const el = parse(`<div id="a" data-foo="1"></div>`).getElementById("a")!;
    el.setAttribute("DATA-Foo", "2");

    expect(el.getAttribute("data-foo")).toBe("2");
    expect([...el.attributes].map((a) => a.name)).toEqual(["id", "data-foo"]);
  });

  test("removeAttribute removes a mixed-case attribute named in lowercase", () => {
    const el = parse(`<div id="a" DATA-Foo="1"></div>`).getElementById("a")!;
    el.removeAttribute("data-foo");

    expect(el.hasAttribute("data-foo")).toBe(false);
    expect(el.outerHTML).toBe(`<div id="a"></div>`);
  });

  test("removing an uppercase CLASS clears the class list with it", () => {
    const el = parse(`<div id="a" CLASS="alpha"></div>`).getElementById("a")!;
    expect(el.classList.contains("alpha")).toBe(true);

    el.removeAttribute("class");

    expect(el.classList.contains("alpha")).toBe(false);
    expect(el.outerHTML).toBe(`<div id="a"></div>`);
  });

  test("toggleAttribute round-trips a mixed-case attribute", () => {
    const el = parse(`<div id="a" DATA-Foo="1"></div>`).getElementById("a")!;

    expect(el.toggleAttribute("data-foo")).toBe(false);
    expect(el.hasAttribute("data-foo")).toBe(false);

    el.toggleAttribute("data-foo");
    expect(el.getAttribute("data-foo")).toBe("");
  });

  test("removing a foreign attribute still needs its exact spelling", () => {
    const el = parse(`<svg id="s" viewBox="0 0 10 10"></svg>`).getElementById("s")!;
    el.removeAttribute("viewbox");

    expect(el.getAttribute("viewBox")).toBe("0 0 10 10");
  });
});

// Every way a module specifier can be named: static, side-effect, dynamic and
// require, in either quote, bare or with a subpath.
const SPECIFIER_RE = /(?:from|import|require)\s*\(?\s*(['"])linkedom(?:\/[\w./-]+)?\1/g;

// Everything a type-only statement may hold between its keyword and `from`.
// Only the `import type` / `export type` form counts: `import { type X }`
// still emits a runtime import under verbatimModuleSyntax.
const TYPE_IMPORT_PREFIX_RE = /^(?:import|export)\s+type\s[^;]*$/;

// As whole words, so the `import` inside an identifier like `important` is not
// mistaken for the start of a statement.
const KEYWORD_RE = /\b(?:import|export)\b/g;

/**
 * Whether the specifier at `match` belongs to a type-only statement, which
 * erases at compile time and pulls in no runtime module. A heuristic, not a
 * parser: it reads back to the nearest preceding import/export keyword, so a
 * keyword sitting inside a comment mid-statement would fool it. It errs toward
 * flagging, and a false positive is a loud test failure rather than a silent
 * regression.
 */
function isTypeOnlyImport(source: string, match: RegExpExecArray): boolean {
  // Only a `from` clause can belong to one. A bare `import "linkedom"`,
  // `import(…)` or `require(…)` is a runtime load whatever precedes it, which
  // is what keeps a preceding semicolonless type import from covering for it.
  if (!match[0].startsWith("from")) return false;

  const head = source.slice(0, match.index);
  KEYWORD_RE.lastIndex = 0;
  let start = -1;
  for (const keyword of head.matchAll(KEYWORD_RE)) start = keyword.index;

  return start >= 0 && TYPE_IMPORT_PREFIX_RE.test(head.slice(start));
}

function importsLinkedomAtRuntime(source: string): boolean {
  SPECIFIER_RE.lastIndex = 0;
  for (const match of source.matchAll(SPECIFIER_RE)) {
    if (!isTypeOnlyImport(source, match)) return true;
  }
  return false;
}

// Bun.Glob brace expansion silently matches nothing, so scan one at a time.
const SOURCE_GLOBS = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.mjs", "**/*.cjs"];

// dom.ts is the door. This file describes the patterns it looks for, in
// comments and in the two regexes above, so it cannot scan itself.
const EXEMPT = new Set([
  "packages/parser/src/dom.ts",
  "packages/parser/tests/attribute-case.test.ts",
]);

describe("linkedom is reachable through one door", () => {
  test.each([
    [true, "a value import", `import { parseHTML } from "linkedom";`],
    [true, "single quotes", `import { parseHTML } from 'linkedom';`],
    [true, "a side-effect import", `import "linkedom";`],
    [true, "a dynamic import", `const m = await import("linkedom");`],
    [true, "require", `const l = require("linkedom");`],
    [true, "a subpath", `import { DOMParser } from "linkedom/worker";`],
    [true, "a re-export", `export { parseHTML } from "linkedom";`],
    [true, "a value import after a semicolonless type import", `import type { X } from "other"\nimport { parseHTML } from "linkedom"`],
    [true, "require after a semicolonless type import", `import type { Y } from "other"\nconst l = require("linkedom")`],
    [true, "an inline type specifier, which still emits the import", `import { type Document } from "linkedom";`],
    [false, "a type import", `import type { Document } from "linkedom";`],
    [false, "a multiline type import", `import type {\n  Document,\n  Element,\n} from "linkedom";`],
    [false, "a type import after another import", `import { a } from "b";\nimport type { Document } from "linkedom";`],
    [false, "a type re-export", `export type { Document } from "linkedom";`],
    [false, "a type import whose binding contains the word import", `import type { important } from "linkedom";`],
  ])("flags %p: %s", (flagged, _label, source) => {
    expect(importsLinkedomAtRuntime(source)).toBe(flagged);
  });

  // The patch makes every linkedom element in the process case-insensitive, but
  // only once src/dom.ts has been loaded. A file reaching linkedom directly is
  // a coin flip on module load order, and in a build that never loads dom.ts it
  // is simply the old case-sensitive behaviour back.
  test("nothing but src/dom.ts pulls linkedom in at runtime", async () => {
    const root = `${import.meta.dir}/../../..`;
    const offenders: string[] = [];
    const seen = new Set<string>();

    for (const pattern of SOURCE_GLOBS) {
      for await (const rel of new Glob(pattern).scan({ cwd: root })) {
        if (rel.includes("node_modules") || EXEMPT.has(rel) || seen.has(rel)) continue;
        seen.add(rel);

        const source = await Bun.file(`${root}/${rel}`).text();
        if (importsLinkedomAtRuntime(source)) offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
    // The scan is only as good as its reach: prove it saw the tree.
    expect(seen.size).toBeGreaterThan(500);
  });
});
