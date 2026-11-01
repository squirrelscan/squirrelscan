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

  // The real build of a page of client components (Note) with the vendor URL in props and prose: n1 has an
  // id and parenthesised prose, n2 a strategy-less title, n3 an id and a src, n4 an id and function-like
  // children. n3 and n4 ARE script-shaped (indistinguishable from next/script), so a page that has them still
  // detects the vendor; n1, n2 and the rest are not loaders.
  test("client components: prose with an id is not a loader; an id with a src or function-like children still is", () => {
    const html = real("client-components-no-loader");
    const detect = (page: string): boolean =>
      detectTechnologies({ url: "https://example.com/", headers: {}, html: page }).some((t) => t.id === "clarity");
    expect(detect(html)).toBe(true);
    const withoutScriptShaped = html.replaceAll("clarity.ms/tag/z", "example.com/tag/z").replaceAll("clarity.ms/tag/q", "example.com/tag/q");
    expect(withoutScriptShaped).not.toBe(html);
    expect(detect(withoutScriptShaped)).toBe(false);
  });

  test("prose naming the vendor with the word function, window., =>, = or a query string is not a loader", () => {
    const prose = [
      "as a function of the plan, see https://www.clarity.ms/tag/x.",
      "see https://www.clarity.ms/tag/x?ref=docs for the docs",
      "Set x = 1 and use https://www.clarity.ms/tag/x here.",
      "window. and https://www.clarity.ms/tag/x then a => b",
      "a (b = c) https://www.clarity.ms/tag/x then window. only",
    ];
    for (const text of prose) {
      const html = `<!doctype html><html><body><script>${push([`5:${el("$L2", { id: "n1", children: text })}`])}</script></body></html>`;
      expect(detectTechnologies({ url: "https://example.com/", headers: {}, html }).some((t) => t.id === "clarity")).toBe(false);
    }
  });

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
    expect(clarity([`5:${el("$L2", { id: "c", src: URL_, strategy: "lazyOnload" })}`])).toBe(true);
  });

  test("parenthesised prose with an id, and a client component with only a src, are not scripts (#1444)", () => {
    const prose = "We installed (and liked) https://www.clarity.ms/tag/x; see the notes";
    expect(clarity([`5:${el("$L2", { id: "n1", children: prose })}`])).toBe(false);
    expect(clarity([`5:${el("$L2", { src: URL_ })}`])).toBe(false);
    expect(clarity([`5:${el("$L2", { src: URL_, alt: "x", width: 10 })}`])).toBe(false);
  });

  test("a src beside an id or a strategy is still a script", () => {
    expect(clarity([`5:${el("$L2", { id: "c", src: URL_ })}`])).toBe(true);
    expect(clarity([`5:${el("$L2", { strategy: "lazyOnload", src: URL_ })}`])).toBe(true);
  });

  test("a component whose children are prose, with or without an id, is not a script", () => {
    expect(clarity([`5:${el("$L2", { id: "intro", children: "We installed https://www.clarity.ms/tag/x last week" })}`])).toBe(false);
    expect(clarity([`5:${el("$L2", { children: "We installed https://www.clarity.ms/tag/x last week" })}`])).toBe(false);
  });
});

// #1477: React Flight writes a string of 1 KB or more as its own text row, `id:T<hex byte length>,<text>`, and the
// element points at it (`"children":"$7"`). A long inline snippet (a loader beside other trackers in one
// `next/script`) is such a row, and its text can hold newlines and multi-byte characters.
describe("a long snippet in a flight text row (#1477)", () => {
  const textRow = (id: string, text: string): string => `${id}:T${Buffer.byteLength(text).toString(16)},${text}`;
  const longSnippet = (extra = ""): string =>
    `${extra}window.dataLayer=window.dataLayer||[];\n// ${"padding to pass 1 KB ".repeat(60)}\n${SNIPPET}\nconsole.log("done");`;
  const flightPage = (chunks: string[]): string =>
    `<!doctype html><html><head><title>t</title></head><body>${chunks.map((c) => `<script>self.__next_f.push([1,${JSON.stringify(c)}])</script>`).join("")}</body></html>`;
  // A text row carries its own newlines, so the rows are joined by hand into one chunk.
  const page = (rows: string[]): string => flightPage([`${rows.join("\n")}\n`]);
  const found = (html: string): string[] => detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id);
  const GTM = el("script", { src: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123", async: true });

  test("children that point at a text row are read: an id'd next/script, a strategy, and a plain script", () => {
    const text = longSnippet();
    expect(text.length).toBeGreaterThan(1024);
    for (const component of [
      el("$L2", { id: "analytics", children: "$7" }),
      el("$L2", { id: "analytics", strategy: "afterInteractive", children: "$7" }),
      el("script", { children: "$7" }),
      el("$L2", { id: "analytics", children: ["$7"] }),
    ]) {
      expect(found(page([`5:${component}`, textRow("7", text)]))).toContain("clarity");
    }
  });

  test("dangerouslySetInnerHTML.__html that points at a text row is read", () => {
    const html = page([`5:${el("$L2", { id: "a", strategy: "lazyOnload", dangerouslySetInnerHTML: { __html: "$7" } })}`, textRow("7", longSnippet())]);
    expect(found(html)).toContain("clarity");
  });

  test("the text row may come first, hold newlines and multi-byte characters, and the rows after it are still read", () => {
    const text = longSnippet("/* éè 中文 🚀 */\n");
    const html = page([textRow("7", text), `5:${el("$L2", { id: "a", children: "$7" })}`, `6:${GTM}`]);
    const ids = found(html);
    expect(ids).toContain("clarity");
    expect(ids).toContain("google-tag-manager");
  });

  test("the text row is split over chunks like any other row", () => {
    const rows = `5:${el("$L2", { id: "a", children: "$7" })}\n${textRow("7", longSnippet())}\n6:${GTM}\n`;
    const cut = Math.floor(rows.length / 3);
    const ids = found(flightPage([rows.slice(0, cut), rows.slice(cut, cut * 2), rows.slice(cut * 2)]));
    expect(ids).toContain("clarity");
    expect(ids).toContain("google-tag-manager");
  });

  test("prose and data in a text row are still not read", () => {
    const prose = "A privacy policy mentions https://www.clarity.ms/tag/abc123 in a paragraph. ".repeat(20);
    expect(prose.length).toBeGreaterThan(1024);
    for (const component of [
      el("p", { children: "$7" }),
      el("$L2", { id: "intro", children: "$7" }),
      el("script", { type: "application/ld+json", children: "$7" }),
      el("a", { href: "$7" }),
    ]) {
      expect(found(page([`5:${component}`, textRow("7", prose)]))).not.toContain("clarity");
    }
    expect(found(page([`5:${el("$L2", { id: "a", children: "$8" })}`]))).not.toContain("clarity");
  });

  test("hostile text rows stay bounded: a declared length past the data, and many heads", () => {
    const started = performance.now();
    const over = `7:Tffffffffff,${"x".repeat(100_000)}`;
    const many = "1:Tff,".repeat(50_000);
    for (const rows of [[over], [many], [over, `5:${el("$L2", { id: "a", children: "$7" })}`]]) {
      expect(() => found(page(rows))).not.toThrow();
    }
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
