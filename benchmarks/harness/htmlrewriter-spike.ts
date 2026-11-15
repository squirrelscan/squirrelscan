// Spike (squirrelscan/repo#599): Bun HTMLRewriter (lol-html) vs linkedom for the parse-time extractors.
// Usage: bun benchmarks/harness/htmlrewriter-spike.ts [--runs=N]
// Prints (1) a parity table: prototype HTMLRewriter extractors vs the shipped linkedom extractors on
// generated pages, and (2) min-of-N timings per page size. The prototype is NOT shipped code.

import { parseHTML } from "../../packages/parser/src/dom";
import {
  extractH1,
  extractHeadings,
  extractImages,
  extractLinks,
  extractMeta,
  extractOG,
  extractSchema,
  extractTwitter,
} from "../../packages/parser/src/html";

const runs =
  Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7)) || 7;
const url = "https://example.com/blog/post";

// ---- prototype: one streaming pass, serializable output ----------------------------------------

export interface RewriterExtract {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
  h1: string[];
  headings: Array<{ level: number; text: string }>;
  links: Array<{ href: string; text: string; rel: string | null }>;
  images: Array<{ src: string; alt: string | null }>;
  ldTypes: string[];
}

// lol-html hands BOTH text chunks and attribute values raw (entities are NOT decoded), so the
// prototype decodes them itself. Only the five named entities and &nbsp; are handled here: a
// production port needs the full HTML entity table (htmlparser2 ships one).
const ENT: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};
const decode = (s: string): string =>
  s.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (m) => ENT[m] ?? m);

export async function extractWithRewriter(
  html: string
): Promise<RewriterExtract> {
  const out: RewriterExtract = {
    title: null,
    description: null,
    canonical: null,
    robots: null,
    og: {},
    twitter: {},
    h1: [],
    headings: [],
    links: [],
    images: [],
    ldTypes: [],
  };
  // Open text collectors. A stack handles `<a>` inside `<h2>`; a depth counter for <noscript> is
  // the only ancestor state this prototype needs (images), and it is why `:not(noscript *)` can
  // not be a selector (lol-html has no :not with descendant combinators).
  let title: string[] | null = null;
  let ld: string[] | null = null;
  let noscript = 0;
  const open: Array<{ buf: string[]; done: (t: string) => void }> = [];

  const collect = (
    el: { onEndTag?: (h: () => void) => void },
    done: (t: string) => void
  ) => {
    const c = { buf: [] as string[], done };
    open.push(c);
    el.onEndTag?.(() => {
      open.splice(open.indexOf(c), 1);
      done(c.buf.join(""));
    });
  };

  const rw = new HTMLRewriter()
    .on("title", {
      element(el) {
        if (out.title === null) {
          title = [];
          el.onEndTag(() => {
            out.title = decode(title!.join(""));
            title = null;
          });
        }
      },
      text(t) {
        title?.push(t.text);
      },
    })
    .on("meta", {
      element(el) {
        const name = el.getAttribute("name")?.toLowerCase();
        const prop = el.getAttribute("property");
        const content = el.getAttribute("content");
        if (content === null) return;
        const value = decode(content);
        if (name === "description" && out.description === null)
          out.description = value;
        else if (name === "robots" && out.robots === null) out.robots = value;
        else if (name?.startsWith("twitter:"))
          out.twitter[name.slice(8)] ??= value;
        if (prop?.startsWith("og:")) out.og[prop.slice(3)] ??= value;
      },
    })
    .on("link", {
      element(el) {
        if (out.canonical === null && el.getAttribute("rel") === "canonical")
          out.canonical = decode(el.getAttribute("href") ?? "");
      },
    })
    .on("h1,h2,h3,h4,h5,h6", {
      element(el) {
        const level = Number(el.tagName[1]);
        collect(el, (t) => {
          const text = decode(t).trim();
          out.headings.push({ level, text });
          if (level === 1) out.h1.push(text);
        });
      },
    })
    .on("a[href]", {
      element(el) {
        const href = decode(el.getAttribute("href")!);
        const rel = el.getAttribute("rel");
        collect(el, (t) =>
          out.links.push({ href, text: decode(t).trim(), rel })
        );
      },
    })
    .on("noscript", {
      element(el) {
        noscript++;
        el.onEndTag(() => {
          noscript--;
        });
      },
    })
    .on("img", {
      element(el) {
        if (noscript > 0) return;
        const src = el.getAttribute("data-src") || el.getAttribute("src");
        if (src && !src.startsWith("data:"))
          out.images.push({ src, alt: el.getAttribute("alt") });
      },
    })
    .on('script[type="application/ld+json"]', {
      element(el) {
        ld = [];
        el.onEndTag(() => {
          try {
            const j = JSON.parse(ld!.join(""));
            for (const item of Array.isArray(j) ? j : [j])
              if (item?.["@type"]) out.ldTypes.push(item["@type"]);
          } catch {
            /* invalid JSON-LD */
          }
          ld = null;
        });
      },
      text(t) {
        ld?.push(t.text);
      },
    })
    // One text handler for every open collector (headings and anchors).
    .on("*", {
      text(t) {
        if (open.length > 0) for (const c of open) c.buf.push(t.text);
      },
    });

  await rw.transform(new Response(html)).arrayBuffer();
  return out;
}

// ---- the same set through the shipped linkedom path ---------------------------------------------

export function extractWithLinkedom(html: string) {
  const { document: doc } = parseHTML(html);
  return {
    meta: extractMeta(doc),
    og: extractOG(doc),
    twitter: extractTwitter(doc),
    h1: extractH1(doc),
    headings: extractHeadings(doc),
    links: extractLinks(doc, url),
    images: extractImages(doc, url),
    schema: extractSchema(doc),
  };
}

// ---- generated pages ---------------------------------------------------------------------------

export function makePage(sections: number): string {
  const body: string[] = [];
  for (let i = 0; i < sections; i++) {
    body.push(
      `<section class="card c${i}"><h2 id="s${i}">Section ${i} &amp; friends</h2>` +
        `<p>Lorem ipsum dolor sit amet, <a href="/p/${i}" rel="${i % 7 === 0 ? "nofollow" : "next"}">link ${i}</a> consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua &mdash; ut enim ad minim veniam.</p>` +
        `<ul>${Array.from({ length: 4 }, (_, j) => `<li><a href="https://other.example.org/${i}/${j}?q=1&amp;r=2">ext ${j}</a></li>`).join("")}</ul>` +
        `<img src="/img/${i}.jpg" alt="Image ${i}" width="640" height="360" loading="lazy"><noscript><img src="/px/${i}.gif"></noscript>` +
        `<div class="row"><span>${"Some more filler text for the page body. ".repeat(6)}</span></div></section>`
    );
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Spike page &amp; test</title>
<meta name="description" content="A page used to benchmark parsers &amp; extractors."><meta name="robots" content="index,follow">
<link rel="canonical" href="https://example.com/blog/post"><meta property="og:title" content="OG title"><meta property="og:type" content="article">
<meta name="twitter:card" content="summary"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"x"}</script>
<style>${".a{color:red}".repeat(200)}</style></head><body><header><nav><a href="/">Home</a><a href="/about">About</a></nav></header><main><h1>Main <em>heading</em></h1>${body.join("\n")}</main><footer><a href="/privacy">Privacy</a></footer></body></html>`;
}

// ---- parity ------------------------------------------------------------------------------------

const norm = (s: string | null | undefined) =>
  (s ?? "").replace(/\s+/g, " ").trim();
async function parity(html: string) {
  const a = extractWithLinkedom(html);
  const b = await extractWithRewriter(html);
  const checks: Array<[string, boolean]> = [
    ["title", a.meta.title === b.title],
    ["description", a.meta.description === b.description],
    ["canonical", a.meta.canonical === b.canonical],
    ["robots", a.meta.robots === b.robots],
    ["og.title/type", a.og.title === b.og.title && a.og.type === b.og.type],
    ["twitter.card", a.twitter.card === b.twitter.card],
    [
      "h1 texts",
      JSON.stringify(a.h1.texts.map(norm)) === JSON.stringify(b.h1.map(norm)),
    ],
    [
      "headings (level+text)",
      JSON.stringify(
        a.headings.headings.map((h) => [h.level, norm(h.text)])
      ) === JSON.stringify(b.headings.map((h) => [h.level, norm(h.text)])),
    ],
    [
      "link hrefs (resolved)",
      JSON.stringify(a.links.map((l) => l.url)) ===
        JSON.stringify(b.links.map((l) => new URL(l.href, url).toString())),
    ],
    [
      "image srcs (resolved)",
      JSON.stringify(a.images.map((i) => i.src)) ===
        JSON.stringify(b.images.map((i) => new URL(i.src, url).toString())),
    ],
    [
      "ld+json types",
      JSON.stringify(a.schema.types) === JSON.stringify(b.ldTypes),
    ],
  ];
  return checks;
}

// ---- timing ------------------------------------------------------------------------------------

const minOf = async (f: () => unknown): Promise<number> => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await f();
    best = Math.min(best, performance.now() - s);
  }
  return best;
};

if (import.meta.main) {
  for (const sections of [10, 60, 300, 1500]) {
    const html = makePage(sections);
    const kb = Math.round(html.length / 1024);
    console.log(`\n== ${sections} sections, ${kb} KB ==`);
    for (const [name, ok] of await parity(html))
      console.log(`  parity ${ok ? "ok  " : "DIFF"} ${name}`);
    await extractWithRewriter(html);
    extractWithLinkedom(html); // warm
    const parseOnly = await minOf(() => parseHTML(html));
    const full = await minOf(() => extractWithLinkedom(html));
    const rw = await minOf(() => extractWithRewriter(html));
    const ser = await minOf(async () =>
      structuredClone(await extractWithRewriter(html))
    );
    console.log(
      `  linkedom parseHTML ${parseOnly.toFixed(2)} ms | linkedom parse+extract ${full.toFixed(2)} ms | HTMLRewriter extract ${rw.toFixed(2)} ms | speedup ${(full / rw).toFixed(1)}x (vs parse alone ${(parseOnly / rw).toFixed(1)}x) | +structuredClone ${ser.toFixed(2)} ms`
    );
  }
}
