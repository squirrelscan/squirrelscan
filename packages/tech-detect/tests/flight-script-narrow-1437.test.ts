// #1437: a Next.js flight script is read for the script elements it carries, not as one block of text, so a
// vendor URL that the page renders as content (JSON-LD sameAs, a meta description, a CSP meta, a link, prose)
// is not detected, while the layout's real loader (a `script` element, or a `next/script` component) still is.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { pageMarkup } from "../src/detect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SNIPPET =
  '(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;' +
  't.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","abc123");';
const URL_ = "https://www.clarity.ms/tag/abc123";
const SCRIPT_MODULE = '6:I["(app-pages-browser)/./node_modules/next/dist/client/script.js",["chunk"],""]';
const LINK_MODULE = '7:I["(app-pages-browser)/./node_modules/next/dist/client/link.js",["chunk"],""]';

const push = (rows: string[]): string => `self.__next_f.push([1,${JSON.stringify(`${rows.join("\n")}\n`)}])`;
const el = (type: string, props: object): string => JSON.stringify(["$", type, null, props]);
/** A flight script over 16 KB: the rows, then padding chunks of page content. */
const flight = (rows: string[]): string =>
  `${push(rows)};${Array.from({ length: 300 }, (_, n) => push([`${(100 + n).toString(16)}:["$","div",null,{"children":"${"filler ".repeat(10)}"}]`])).join(";")}`;
const page = (script: string): string =>
  `<!doctype html><html><head><title>t</title><script>${script}</script></head><body><p>Hello</p></body></html>`;
const ids = (html: string, withBodies: boolean): string[] =>
  detectTechnologies({
    url: "https://example.com/",
    headers: {},
    html,
    ...(withBodies ? { scripts: [{ url: "https://example.com/a.js", content: "var a=1;" }] } : {}),
  }).map((t) => t.id);
const both = (script: string): string[][] => [ids(page(script), true), ids(page(script), false)];

const NEGATIVES: Record<string, string[]> = {
  "a JSON-LD sameAs": [
    `5:${el("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: JSON.stringify({ sameAs: ["https://www.clarity.ms/"] }) } })}`,
  ],
  "a meta description": [`5:${el("meta", { name: "description", content: "Measured with https://www.clarity.ms/tag/x and more" })}`],
  "a CSP meta": [`5:${el("meta", { httpEquiv: "Content-Security-Policy", content: "script-src https://www.clarity.ms" })}`],
  "an <a href>": [`5:${el("a", { href: "https://www.clarity.ms/", children: "Clarity" })}`],
  "prose inside an element": [`5:${el("p", { children: "We use clarity.ms for analytics, see https://www.clarity.ms/tag/x" })}`],
  "prose inside a component that is not next/script": [LINK_MODULE, `5:${el("$L7", { children: "We use https://www.clarity.ms/tag/x" })}`],
  "a script src nested in a data script type": [`5:${el("script", { type: "application/json", src: URL_ })}`],
  "a bare string row": [`5:"https://www.clarity.ms/tag/x"`, `8:T5,https://www.clarity.ms/tag/x`],
};

describe("a flight script over 16 KB does not detect a vendor it only renders as content", () => {
  for (const [name, rows] of Object.entries(NEGATIVES)) {
    test(name, () => {
      const script = flight(rows);
      expect(script.length).toBeGreaterThan(16 * 1024);
      for (const found of both(script)) expect(found).not.toContain("clarity");
    });
  }

  test("all of them together, in one payload", () => {
    for (const found of both(flight(Object.values(NEGATIVES).flat()))) expect(found).not.toContain("clarity");
  });
});

describe("the layout's loader in the same payload is still detected", () => {
  const positives: Record<string, string[]> = {
    "a script element's src": [`5:${el("script", { src: URL_, async: true })}`],
    "a script element's inline __html": [`5:${el("script", { id: "c", dangerouslySetInnerHTML: { __html: SNIPPET } })}`],
    "a script element's string children": [`5:${el("script", { children: SNIPPET })}`],
    "a next/script component's children": [SCRIPT_MODULE, `5:${el("$L6", { id: "clarity", strategy: "afterInteractive", children: SNIPPET })}`],
    "a next/script component's src, declared after use": [`5:${el("$L6", { src: URL_ })}`, SCRIPT_MODULE],
    "a script nested in head": [`5:${el("head", { children: [["$", "meta", null, {}], ["$", "script", null, { src: URL_ }]] })}`],
  };
  for (const [name, rows] of Object.entries(positives)) {
    test(name, () => {
      const script = flight(rows);
      expect(script.length).toBeGreaterThan(16 * 1024);
      for (const found of both(script)) expect(found).toContain("clarity");
    });
  }

  test("positives and every negative in one fixture", () => {
    const rows = [...Object.values(NEGATIVES).flat(), SCRIPT_MODULE, `5:${el("$L6", { children: SNIPPET })}`];
    for (const found of both(flight(rows))) expect(found).toContain("clarity");
  });

  test("a chunk split in the middle of a row is joined before it is read", () => {
    const row = `6:I["x/next/dist/client/script.js",[],""]\n5:${el("$L6", { children: SNIPPET })}\n`;
    const cut = Math.floor(row.length / 2);
    const script = `self.__next_f.push([1,${JSON.stringify(row.slice(0, cut))}]);self.__next_f.push([1,${JSON.stringify(row.slice(cut))}])`;
    for (const found of both(script)) expect(found).toContain("clarity");
  });
});

describe("a small flight script is narrowed too, and a script with no readable chunk is read as before", () => {
  test("under 16 KB a rendered sameAs is not detected", () => {
    const small = push([`5:${el("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: '{"sameAs":["https://www.clarity.ms/"]}' } })}`]);
    for (const found of both(small)) expect(found).not.toContain("clarity");
  });

  test("a flight-shaped script with no push chunk is read as an ordinary script", () => {
    const odd = `self.__next_f=self.__next_f||[];var s=${JSON.stringify(SNIPPET)};`;
    for (const found of both(odd)) expect(found).toContain("clarity");
  });
});

describe("hostile flight payloads stay bounded", () => {
  test("a deeply nested value and a huge row do not throw and finish quickly", () => {
    const deep = `5:${"[".repeat(200_000)}${"]".repeat(200_000)}`;
    const wide = `6:[${'"x",'.repeat(300_000)}"y"]`;
    const started = performance.now();
    const text = pageMarkup(page(flight([deep, wide, `5:${el("script", { src: URL_ })}`])));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(typeof text).toBe("string");
  });

  test("unterminated and malformed chunks are skipped", () => {
    for (const script of ['self.__next_f.push([1,"abc', 'self.__next_f.push([1,"\\u00zz"])', "self.__next_f.push([1,]);".repeat(50_000)]) {
      expect(() => pageMarkup(page(script))).not.toThrow();
    }
  });
});

// Output of real `next build` runs (Next 15.5 and 14.2, App Router, production), trimmed of build hashes.
// A production build names the Script component `$L2` with a numeric module id and splits the flight
// payload over many <script> elements, cutting rows in the middle.
const real = (name: string): string => readFileSync(join(import.meta.dir, "fixtures/next-build", `${name}.html`), "utf8");
const realIds = (name: string): string[][] => {
  const html = real(name);
  return [
    detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id),
    detectTechnologies({
      url: "https://example.com/",
      headers: {},
      html,
      scripts: [{ url: "https://example.com/a.js", content: "var a=1;" }],
    }).map((t) => t.id),
  ];
};

describe("real next build output", () => {
  const detected: Record<string, string> = {
    "after-children": "next/script afterInteractive, inline children",
    "lazy-html": "next/script lazyOnload, dangerouslySetInnerHTML",
    "lazy-src": "next/script lazyOnload, src (no preload link)",
    "body-children": "next/script afterInteractive placed in <body>",
    "next14-children": "Next 14.2: afterInteractive children",
    "before-inline": "beforeInteractive inline",
    "before-src": "beforeInteractive src",
    "plain-inline": "a plain inline <script>",
    "after-children-big-content": "afterInteractive children on a page over 16 KB with JSON-LD, a link, a meta and prose naming the vendor",
  };
  for (const [name, label] of Object.entries(detected)) {
    test(`detects the loader: ${label}`, () => {
      for (const found of realIds(name)) expect(found).toContain("clarity");
    });
  }

  test("a page with no loader that only renders the vendor as content does not detect it", () => {
    const big = real("none-big-content");
    expect(big.length).toBeGreaterThan(16 * 1024);
    expect(big).toContain("sameAs");
    for (const found of realIds("none-big-content")) expect(found).not.toContain("clarity");
    for (const found of realIds("none")) expect(found).not.toContain("clarity");
  });
});

describe("the Script component is identified by its props, across the page's flight scripts", () => {
  const chunks = (rows: string[]): string => rows.map((r) => `<script>${push([r])}</script>`).join("");
  const html = (rows: string[]): string => `<!doctype html><html><head><title>t</title></head><body>${chunks(rows)}</body></html>`;
  const clarity = (rows: string[]): boolean =>
    detectTechnologies({ url: "https://example.com/", headers: {}, html: html(rows) }).some((t) => t.id === "clarity");

  test("a numeric module id and the usage row in different scripts", () => {
    expect(clarity(['2:I[1402,["177","static/chunks/app/layout.js"],""]', `5:${el("$L2", { id: "c", strategy: "afterInteractive", children: SNIPPET })}`])).toBe(true);
  });

  test("an id with inline __html, an id with code children, and a src", () => {
    expect(clarity([`5:${el("$L2", { id: "c", dangerouslySetInnerHTML: { __html: SNIPPET } })}`])).toBe(true);
    expect(clarity([`5:${el("$L2", { id: "c", children: SNIPPET })}`])).toBe(true);
    expect(clarity([`5:${el("$L2", { src: URL_, strategy: "lazyOnload" })}`])).toBe(true);
  });

  test("a component whose children are prose, with or without an id, is not a script", () => {
    expect(clarity([`5:${el("$L2", { id: "intro", children: "We installed https://www.clarity.ms/tag/x last week" })}`])).toBe(false);
    expect(clarity([`5:${el("$L2", { children: "We installed https://www.clarity.ms/tag/x last week" })}`])).toBe(false);
  });
});
