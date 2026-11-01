// #1509: the standard Clarity snippet carried as the text of an inline script in a framework bundle (a `next/script`
// `children` string, a `dangerouslySetInnerHTML` `__html` template literal) is the loader, found. The same snippet in a
// docs string, a code sample or any other string is not. Hosts and ids are synthetic.

import { describe, expect, test } from "bun:test";

import { detectTechnologies, SEGMENT_SEPARATOR, sampleBundleExtras } from "../src";

const SHELL = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>`;
const WHOLE = { maxScriptChars: 32 * 1024 * 1024 };
const ids = (content: string, options = WHOLE): string[] =>
  detectTechnologies({ url: "https://example.com/", headers: {}, html: SHELL, scripts: [{ url: "https://example.com/assets/app.js", content }] }, undefined, options).map((t) => t.id);
const filler = (n: number): string => "var q=(a<<3)+b;if(q>9){q-=9}\n".repeat(n);

const BODY =
  '(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)})(window,document,"clarity","script","abc123");';
const ESCAPED = BODY.replaceAll('"', '\\"').replaceAll("/", "\\/");

describe("the snippet as the text of a script element", () => {
  test("a template literal __html value (dangerouslySetInnerHTML)", () => {
    const code = `${filler(50)}h("script",{dangerouslySetInnerHTML:{__html:\`${BODY}\`}});${filler(50)}`;
    expect(ids(code)).toContain("clarity");
  });
  test("a single-quoted children value on a props object with strategy and id", () => {
    const code = `${filler(50)}(0,a.jsx)(i.default,{id:"clarity-script",strategy:"afterInteractive",children:'${BODY}'});${filler(50)}`;
    expect(ids(code)).toContain("clarity");
  });
  test("children first with the strategy after it, and a JSON-style string with escaped quotes and slashes", () => {
    expect(ids(`h(Script,{children:'${BODY}',strategy:"lazyOnload"});`)).toContain("clarity");
    expect(ids(`h(Script,{id:"c",strategy:"afterInteractive",children:"${ESCAPED}"});`)).toContain("clarity");
    expect(ids(`h("script",{"dangerouslySetInnerHTML":{"__html":"${ESCAPED}"}});`)).toContain("clarity");
  });
});

// The real shapes of three targets, with fake ids: next/script's default export passed to the JSX runtime (no "script"
// tag, no `type`), unquoted keys, a `strategy` on all three.
const IIFE = (len: number): string => {
  const base = BODY.replace("abc123", "p0fakeid01");
  return base + " ".repeat(Math.max(0, len - base.length));
};
const D55 = `(0,x.jsx)(y.default,{id:"c1",strategy:"lazyOnload",dangerouslySetInnerHTML:{__html:\`${IIFE(387)}\`}})`;
const D49 = `(0,x.jsx)(y.default,{id:"c2",strategy:"afterInteractive",dangerouslySetInnerHTML:{__html:\`${IIFE(343)}\`}})`;
const D04 = `(0,x.jsx)(y.default,{id:"c3",strategy:"afterInteractive",children:'${IIFE(560)}'}),z&&(0,x.jsxs)("div",{className:"k"})`;

describe("the real shapes of the string-carried targets", () => {
  test("d55-shape: __html template literal on next/script props, after a separate element with type and src", () => {
    const lead = `(0,x.jsx)("link",{type:"text/javascript",src:"/a.js"}),`;
    expect(ids(`${filler(40)}[${lead}${D55}]${filler(40)}`)).toContain("clarity");
  });
  test("d49-shape: the same with strategy afterInteractive and a 343-character literal", () => {
    expect(ids(`${filler(40)}[${D49}]${filler(40)}`)).toContain("clarity");
  });
  test("d04-shape: a single-quoted children string of 560 characters, no dangerouslySetInnerHTML", () => {
    expect(ids(`${filler(40)}[${D04}]${filler(40)}`)).toContain("clarity");
  });
  test("the three shapes in a bundle too big to send whole: the sampled windows still detect them", () => {
    for (const [name, code] of [["d55", D55], ["d49", D49], ["d04", D04]] as const) {
      const body = `${filler(8_000)}\n[${code}]\n${filler(8_000)}`;
      const head = body.slice(0, 16 * 1024);
      const extras = sampleBundleExtras(body, head.length, 24 * 1024);
      expect(ids(`${head}${SEGMENT_SEPARATOR}${extras}`, { maxScriptChars: 256 * 1024 }), name).toContain("clarity");
    }
  });
});

describe("other script-shaped carriers", () => {
  test("a \"script\" element tag, with or without a strategy; a script type; the loader pair instead of the signature", () => {
    expect(ids(`h("script",{children:'${BODY}'});`)).toContain("clarity");
    expect(ids(`(0,a.jsx)("script",{id:"x",children:\`${BODY}\`});`)).toContain("clarity");
    expect(ids(`h("script",{dangerouslySetInnerHTML:{__html:\`${BODY}\`}});`)).toContain("clarity");
    expect(ids(`h(Tag,{type:"text/javascript",children:'${BODY}'});`)).toContain("clarity");
    expect(ids(`React.createElement("script",null);h(Script,{strategy:"lazyOnload",children:'var s=document.createElement("script");s.src="https://www.clarity.ms/tag/abc";'});`)).toContain("clarity");
  });
});

describe("any other string is still not the loader", () => {
  test("markup, quotes of the loader, and elements that are not scripts (the reviewed false-positive matrix)", () => {
    const loader = 't.src="https://www.clarity.ms/tag/"+i';
    for (const code of [
      `h("div",{dangerouslySetInnerHTML:{__html:'<pre><code>${loader}</code></pre>'}});`, // docs as markup on a div
      `h("div",{dangerouslySetInnerHTML:{__html:'${BODY}'}});`, // the real snippet on a div
      `h(Markdown,{dangerouslySetInnerHTML:{__html:'${BODY}'}});`,
      `h("pre",{dangerouslySetInnerHTML:{__html:'${loader}'}});`,
      `var ld={dangerouslySetInnerHTML:{__html:'{"@type":"HowTo","text":"${loader.replaceAll('"', '\\"')}"}'}};`, // JSON-LD embedding it
      `var fixture={__html:'${loader}'};`, // a test fixture
      `h("div",{id:"docs",children:'${loader}'});`,
      `h("pre",{id:"x",children:'${loader}'});`,
      `h(CodeBlock,{id:"x",children:'${BODY}'});`,
      `h(Markdown,{id:"x",children:'${BODY}'});`,
      `h(Script,{title:"Tracking id: abc",children:'${BODY}'});`, // prose in the window
      `h(Script,{title:"{strategy:",children:'${BODY}'});`,
      `h(Script,{title:"{id:",children:'${BODY}'});`,
      `h("div",{note:"\"script\",{",children:'${BODY}'});`, // a string that looks like the tag
      `h(Code,{id:"x",children:'<script>${loader}</script>'});`, // markup in the string
      `h(Script,{strategy:"afterInteractive",children:'<div>${BODY}</div>'});`,
      `h(Script,{strategy:"afterInteractive",children:'${loader}'});`, // a bare quote of the loader line, no signature
    ]) {
      expect(ids(`${filler(3)}${code}${filler(3)}`), code).not.toContain("clarity");
    }
  });
  test("a bare __html or children on a props object with only an id is not enough", () => {
    expect(ids(`h(Script,{id:"clarity",children:'${BODY}'});`)).not.toContain("clarity");
    expect(ids(`h(Script,{id:"clarity",dangerouslySetInnerHTML:{__html:'${BODY}'}});`)).not.toContain("clarity");
  });
  test("docs strings, code samples, other keys, children without a script-shaped object", () => {
    for (const code of [
      `var docs='${BODY}';`,
      `var docs=\`${BODY}\`;`,
      `h(Docs,{title:"Install",body:'${BODY}'});`,
      `h(Docs,{html:\`${BODY}\`});`, // not __html
      `h(Code,{children:'${BODY}'});`, // children, but no strategy or id on the object
      `h(Code,{lang:"js",children:'${BODY}'});`,
      `h(Script,{strategy:"afterInteractive"});h(Code,{children:'${BODY}'});`, // the sibling belongs to another object
      `h(Code,{children:'${BODY}'});h(Script,{strategy:"afterInteractive"});`,
      `h(Code,{wrap:{strategy:"afterInteractive"},children:'${BODY}'});`, // a nested key is not the object's own
      `h(Code,{wrap:[{strategy:"afterInteractive"}],children:'${BODY}'});`,
      `/* h(Script,{id:"c",children:'${BODY}'}) */`,
      `var s="__html:";var d='${BODY}';`, // the key is text, not the key of this string
      `h(Script,{id:"c",children:["see ",'${BODY}']});`, // an array item is not the value
    ]) {
      expect(ids(`${filler(5)}${code}${filler(5)}`), code).not.toContain("clarity");
    }
  });
  test("near misses inside a script-text string: scheme-less, another host, a dot that is not a dot, another path", () => {
    for (const loader of ["www.clarity.ms/tag/", "https://clarity.ms.evil.invalid/tag/", "https://clarityXms/tag/", "https://www.clarity.ms/tags/", "https://www.clarity-ms/tag/"]) {
      const text = BODY.replace("https://www.clarity.ms/tag/", loader);
      expect(ids(`h("script",{dangerouslySetInnerHTML:{__html:\`${text}\`}});`), loader).not.toContain("clarity");
    }
  });
});

describe("distances read around a string (pinned)", () => {
  test("the key must sit right before the string: more than 48 characters of space is not a key", () => {
    expect(ids(`h("script",{children:${" ".repeat(10)}'${BODY}'});`)).toContain("clarity");
    expect(ids(`h("script",{children:${" ".repeat(60)}'${BODY}'});`)).not.toContain("clarity");
  });
  test("the object's own keys are found up to 2,000 characters away, not further", () => {
    const pad = (n: number) => `pad:"${"x".repeat(n)}",`;
    expect(ids(`h(Script,{${pad(1_200)}children:'${BODY}'${","}strategy:"lazyOnload"});`)).toContain("clarity");
    expect(ids(`h(Script,{${pad(2_500)}children:'${BODY}',strategy:"lazyOnload"});`)).not.toContain("clarity");
    expect(ids(`h(Script,{children:'${BODY}',${pad(2_500)}strategy:"lazyOnload"});`)).not.toContain("clarity");
  });
  test("a key right at the object's start or end is its own key; `restrategy:` is not `strategy:`", () => {
    expect(ids(`h(Script,{strategy:"lazyOnload",children:'${BODY}'});`)).toContain("clarity");
    expect(ids(`h(Script,{children:'${BODY}',strategy:"lazyOnload"});`)).toContain("clarity");
    expect(ids(`h(Script,{restrategy:"lazyOnload",children:'${BODY}'});`)).not.toContain("clarity");
    // a quoted key is a string, and a string supplies no keys: only an unquoted `strategy` counts
    expect(ids(`h(Script,{"strategy":"lazyOnload",children:'${BODY}'});`)).not.toContain("clarity");
  });
  test("a string longer than 4,096 characters is never a carrier", () => {
    const long = `${BODY}${"/* pad */ ".repeat(500)}`;
    expect(ids(`h("script",{children:'${long}'});`)).not.toContain("clarity");
  });
});

describe("bounds", () => {
  test("8 MB of strings that carry the loader under keys that do not count finishes quickly, never found", () => {
    const hostile = `h(Code,{children:'${BODY}'});\n`.repeat(Math.ceil((8 * 1024 * 1024) / 400));
    const started = performance.now();
    expect(ids(hostile)).not.toContain("clarity");
    expect(ids(`${hostile}h("script",{dangerouslySetInnerHTML:{__html:\`${BODY}\`}});`)).not.toContain("clarity"); // past the candidate bound
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 60_000);

  test("a few thousand decoys before the real one: the real one is reached", () => {
    const decoys = `h(Code,{children:'${BODY}'});\n`.repeat(3_000);
    expect(ids(`${decoys}h("script",{dangerouslySetInnerHTML:{__html:\`${BODY}\`}});`)).toContain("clarity");
  });

  test("8 MB of one string with the loader repeated inside it is one candidate", () => {
    const one = `var x=\`${`${BODY}\n`.repeat(Math.ceil((8 * 1024 * 1024) / 330))}\`;`;
    const started = performance.now();
    expect(ids(one)).not.toContain("clarity");
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 60_000);

  test("a long `{` run before the string and a long gap after it are read to a bounded distance", () => {
    const code = `h(Script,{${"{".repeat(100_000)}children:'${BODY}'${" ".repeat(100_000)},strategy:"afterInteractive"});`;
    const started = performance.now();
    expect(ids(code)).not.toContain("clarity"); // the strategy key is past the distance read
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("in a bundle too big to send whole (the sampler)", () => {
  test("the window around the string keeps its key and its siblings, and detects", () => {
    const body = `${filler(8_000)}\n(0,a.jsx)(i.default,{id:"clarity-script",strategy:"afterInteractive",children:'${BODY}'});\n${filler(8_000)}`;
    expect(body.length).toBeGreaterThan(400 * 1024);
    const head = body.slice(0, 16 * 1024);
    const extras = sampleBundleExtras(body, head.length, 24 * 1024);
    expect(extras).toContain('strategy:"afterInteractive"');
    expect(ids(`${head}${SEGMENT_SEPARATOR}${extras}`, { maxScriptChars: 256 * 1024 })).toContain("clarity");
    expect(ids(head, { maxScriptChars: 256 * 1024 })).not.toContain("clarity");
  });
  test("a sibling after the string is kept in the window (the suffix), and a string past the carry is read whole only in a whole scan", () => {
    const after = `h(Script,{children:'${BODY}',strategy:"afterInteractive"});`;
    const body = `${filler(8_000)}\n${after}\n${filler(8_000)}`;
    const head = body.slice(0, 16 * 1024);
    const extras = sampleBundleExtras(body, head.length, 24 * 1024);
    expect(extras).toContain('strategy:"afterInteractive"');
    expect(ids(`${head}${SEGMENT_SEPARATOR}${extras}`, { maxScriptChars: 256 * 1024 })).toContain("clarity");
    // 700 characters of text in the string: past the carry, so a window cannot keep the key; a whole scan still can
    const longString = `h(Script,{strategy:"afterInteractive",children:'${BODY}${" ".repeat(600)}'});`;
    expect(ids(`${filler(10)}${longString}${filler(10)}`)).toContain("clarity");
  });
  test("the __html form and a children key that comes last in its object", () => {
    for (const code of [
      `h("script",{dangerouslySetInnerHTML:{__html:\`${BODY}\`}});`,
      `h(Script,{strategy:"afterInteractive",id:"c",children:'${BODY}'});`,
    ]) {
      const body = `${filler(8_000)}\n${code}\n${filler(8_000)}`;
      const head = body.slice(0, 16 * 1024);
      const extras = sampleBundleExtras(body, head.length, 24 * 1024);
      expect(ids(`${head}${SEGMENT_SEPARATOR}${extras}`, { maxScriptChars: 256 * 1024 }), code).toContain("clarity");
    }
  });
});

describe("string lengths, `type` values and the brace walk (pinned)", () => {
  const carrier = (len: number): string => BODY + " ".repeat(Math.max(0, len - BODY.length));

  test("a carrier string of 1,000 to 4,096 characters is read in a whole scan; 4,097 is not", () => {
    for (const len of [1_000, 3_500, 4_090]) {
      expect(ids(`h("script",{children:'${carrier(len)}'});`), `${len}`).toContain("clarity");
    }
    expect(ids(`h("script",{children:'${carrier(4_200)}'});`)).not.toContain("clarity");
  });

  test("through the sampler, a string up to 1,536 characters keeps its key and tag; one past that does not", () => {
    const sampled = (len: number): string[] => {
      const body = `${filler(8_000)}\n[h("script",{children:'${carrier(len)}'})]\n${filler(8_000)}`;
      const head = body.slice(0, 16 * 1024);
      const extras = sampleBundleExtras(body, head.length, 24 * 1024);
      return ids(`${head}${SEGMENT_SEPARATOR}${extras}`, { maxScriptChars: 256 * 1024 });
    };
    expect(sampled(1_100)).toContain("clarity");
    expect(sampled(1_500)).toContain("clarity");
    expect(sampled(1_700)).not.toContain("clarity"); // a known limit: past the carry the window cannot hold the key
  });

  test("a script `type` of text/javascript, application/javascript or module counts; another type does not", () => {
    for (const type of ["text/javascript", "application/javascript", "module"]) {
      expect(ids(`h(Tag,{type:"${type}",children:'${BODY}'});`), type).toContain("clarity");
    }
    for (const type of ["text/plain", "application/json", "text/x-docs", "moduleX"]) {
      expect(ids(`h(Tag,{type:"${type}",children:'${BODY}'});`), type).not.toContain("clarity");
    }
    expect(ids(`h(Tag,{children:'${BODY}',type:"module"});`)).toContain("clarity"); // the type may follow the string
  });

  test("the walk back from a string stops at a `(` or `[` that is not closed: the string is then not a direct prop", () => {
    expect(ids(`h(Wrap,{strategy:"lazyOnload",kids:g(children:'${BODY}')});`)).not.toContain("clarity");
    expect(ids(`h(Wrap,{strategy:"lazyOnload",kids:[children:'${BODY}']});`)).not.toContain("clarity");
    // a closed call or array before the key is skipped over
    expect(ids(`h(Script,{kids:g(1),list:[1,2],strategy:"lazyOnload",children:'${BODY}'});`)).toContain("clarity");
  });
});
