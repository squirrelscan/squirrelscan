#!/usr/bin/env bun
// Main-text extractors against a gold set (#2359): precision and recall of the kept text, plus the
// time the new extractor adds per page.
//
//   bun scripts/bench-main-text.ts                      # the public synthetic gold set
//   bun scripts/bench-main-text.ts --gold ./corpus      # any dir with <name>.html + <name>.gold.txt
//   bun scripts/bench-main-text.ts --rounds 9 --verbose --json
//   bun scripts/bench-main-text.ts --timing-dir ./html  # time on real pages (no gold needed)
//
// Metric: word-token multiset overlap (lowercase, punctuation stripped), micro-averaged over pages.
// Precision is the share of extracted tokens that are in the gold text, recall the share of gold
// tokens that were extracted. The gold file is the exact text a human would keep from the page.
//
// Timing: per page the minimum of `--rounds` runs (so a scheduling hiccup is not a p95), then p50 and
// p95 over pages. The model is loaded before timing starts. The added time is the p95 of
// (classify + extract) minus the p95 of getMainContent; extraction alone is reported too.

import { classifyDocument, elementPlacer } from "@squirrelscan/page-classifier";
import {
  collectTextExcluding,
  extractMainText,
  getMainContent,
  parseDocument,
} from "@squirrelscan/parser";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadBundledClassifier } from "../src/classifier";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(name);

const goldDir = resolve(
  arg("--gold") ?? join(import.meta.dir, "../tests/fixtures/main-text-gold")
);
const rounds = Math.max(1, Number(arg("--rounds") ?? 5));
const asJson = flag("--json");
const verbose = flag("--verbose");
const timingDir = arg("--timing-dir");

// ---------------------------------------------------------------------------
// Readability-style baseline, reimplemented (no dependency may be added). Follows the shape of
// Mozilla's algorithm: score paragraphs by commas and length, propagate to the parent and
// grandparent, penalise link density, weigh class and id names, take the top candidate and the
// siblings that qualify. It does not mutate the document.
// ---------------------------------------------------------------------------

type Doc = ReturnType<typeof parseDocument>;
type El = ReturnType<Doc["createElement"]>;

const UNLIKELY =
  /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
const MAYBE = /and|article|body|column|content|main|shadow/i;
const POSITIVE =
  /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i;
const NEGATIVE =
  /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget/i;
const DROP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "form",
  "fieldset",
  "footer",
  "aside",
  "button",
  "select",
]);
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
  "main",
  "header",
  "nav",
  "aside",
  "footer",
  "form",
  "dd",
  "dt",
  "figure",
  "figcaption",
]);

const tagOf = (el: El): string => el.tagName?.toLowerCase() ?? "";
const nameOf = (el: El): string =>
  `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;

function isHiddenEl(el: El): boolean {
  return (
    el.hasAttribute("hidden") ||
    el.getAttribute("aria-hidden") === "true" ||
    /display\s*:\s*none/i.test(el.getAttribute("style") ?? "")
  );
}

function classWeight(el: El): number {
  let weight = 0;
  for (const value of [el.getAttribute("class"), el.getAttribute("id")]) {
    if (!value) continue;
    if (NEGATIVE.test(value)) weight -= 25;
    if (POSITIVE.test(value)) weight += 25;
  }
  return weight;
}

function textOf(el: El): string {
  return collectTextExcluding(
    el as never,
    (e) => DROP_TAGS.has(tagOf(e as never)) || isHiddenEl(e as never),
    " "
  )
    .replace(/\s+/g, " ")
    .trim();
}

function linkDensity(el: El): number {
  const total = textOf(el).length;
  if (total === 0) return 0;
  let linked = 0;
  for (const a of el.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    linked += textOf(a as never).length * (href.startsWith("#") ? 0.3 : 1);
  }
  return linked / total;
}

function readabilityStyle(doc: Doc): string {
  const body = doc.body;
  if (!body) return "";
  const scores = new Map<El, number>();
  const init = (el: El): number => {
    let score = classWeight(el);
    const tag = tagOf(el);
    if (tag === "div") score += 5;
    else if (["pre", "td", "blockquote"].includes(tag)) score += 3;
    else if (
      ["address", "ol", "ul", "dl", "dd", "dt", "li", "form"].includes(tag)
    )
      score -= 3;
    else if (/^h[1-6]$|^th$/.test(tag)) score -= 5;
    return score;
  };

  // Unlikely subtrees are skipped whole, as Readability does before scoring.
  const skipped = (el: El): boolean => {
    const tag = tagOf(el);
    if (DROP_TAGS.has(tag) || isHiddenEl(el)) return true;
    if (tag === "body" || tag === "a" || tag === "main" || tag === "article")
      return false;
    const name = nameOf(el);
    return UNLIKELY.test(name) && !MAYBE.test(name);
  };
  const live = (el: El): boolean => {
    for (
      let n: El | null = el;
      n && n !== body;
      n = n.parentElement as El | null
    )
      if (skipped(n)) return false;
    return true;
  };

  for (const p of body.querySelectorAll("p, pre, td, div, blockquote")) {
    const el = p as El;
    const tag = tagOf(el);
    // A div with no block children is a paragraph in disguise.
    if (
      tag === "div" &&
      el.querySelector(
        "p, div, table, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6"
      )
    )
      continue;
    if (!live(el)) continue;
    const text = textOf(el);
    if (text.length < 25) continue;
    const ancestors: El[] = [];
    for (
      let n = el.parentElement as El | null;
      n && ancestors.length < 5 && n !== body.parentElement;
      n = n.parentElement as El | null
    )
      ancestors.push(n);
    const add =
      1 + text.split(",").length + Math.min(Math.floor(text.length / 100), 3);
    for (const [level, anc] of ancestors.entries()) {
      if (!scores.has(anc)) scores.set(anc, init(anc));
      scores.set(
        anc,
        scores.get(anc)! + add / (level === 0 ? 1 : level === 1 ? 2 : level * 3)
      );
    }
  }

  let top: El | null = null;
  let topScore = -Infinity;
  for (const [el, raw] of scores) {
    const score = raw * (1 - linkDensity(el));
    scores.set(el, score);
    if (score > topScore) {
      top = el;
      topScore = score;
    }
  }
  if (!top) return textOf(body as never);

  const parent = top.parentElement as El | null;
  if (!parent || top === body) return cleanText(top);
  const threshold = Math.max(10, topScore * 0.2);
  const parts: string[] = [];
  const topClass = top.getAttribute("class") ?? "";
  for (const sib of parent.children as unknown as Iterable<El>) {
    if (skipped(sib)) continue;
    let keep = sib === top;
    if (!keep) {
      let bonus = 0;
      if (topClass && sib.getAttribute("class") === topClass)
        bonus += topScore * 0.2;
      if ((scores.get(sib) ?? -Infinity) + bonus >= threshold) keep = true;
      else if (tagOf(sib) === "p") {
        const text = textOf(sib);
        const density = linkDensity(sib);
        if (
          (text.length > 80 && density < 0.25) ||
          (text.length > 0 &&
            text.length < 80 &&
            density === 0 &&
            /\.( |$)/.test(text))
        )
          keep = true;
      }
    }
    if (keep) parts.push(cleanText(sib));
  }
  return parts.join("\n\n");
}

// The article is cleaned as Readability's post-processing does: negative class weight or a mostly
// link block goes.
function cleanText(root: El): string {
  const excluded = (node: unknown): boolean => {
    const el = node as El;
    const tag = tagOf(el);
    if (DROP_TAGS.has(tag) || isHiddenEl(el)) return true;
    if (el === root) return false;
    if (["ul", "ol", "div", "section", "table"].includes(tag)) {
      if (classWeight(el) < 0 && !POSITIVE.test(nameOf(el))) return true;
      if (linkDensity(el) > 0.5 && textOf(el).length > 0) return true;
    }
    return false;
  };
  return collectTextExcluding(root as never, excluded as never, "\n", (e) =>
    BLOCK_TAGS.has(tagOf(e as never))
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function counts(list: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of list) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}

interface Score {
  overlap: number;
  predicted: number;
  gold: number;
}

function score(predicted: string, gold: string): Score {
  const p = counts(tokens(predicted));
  const g = counts(tokens(gold));
  let overlap = 0;
  for (const [token, n] of p) overlap += Math.min(n, g.get(token) ?? 0);
  return {
    overlap,
    predicted: [...p.values()].reduce((a, b) => a + b, 0),
    gold: [...g.values()].reduce((a, b) => a + b, 0),
  };
}

const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);
const prf = (s: Score) => {
  const precision = ratio(s.overlap, s.predicted);
  const recall = ratio(s.overlap, s.gold);
  return {
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
  };
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]!;
}

function minTime(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface Page {
  name: string;
  url: string;
  html: string;
  gold: string;
}

function readDir(dir: string, withGold: boolean): Page[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.html$/, "");
      return {
        name,
        url: `https://bench.example/${name}`,
        html: readFileSync(join(dir, f), "utf8"),
        gold: withGold
          ? readFileSync(join(dir, `${name}.gold.txt`), "utf8")
          : "",
      };
    });
}

const pages = readDir(goldDir, true);
if (pages.length === 0)
  throw new Error(`no <name>.html + <name>.gold.txt pairs in ${goldDir}`);

const loaded = loadBundledClassifier();
if (!loaded.model) throw new Error(`model unavailable: ${loaded.reason}`);
const model = loaded.model;

function withClassifier(html: string, url: string) {
  const doc = parseDocument(html);
  const elements: unknown[] = [];
  const result = classifyDocument(doc, url, {
    model,
    html,
    elementsOut: elements,
  });
  return { doc, result, elements };
}

const EXTRACTORS: { name: string; run: (page: Page) => string }[] = [
  {
    name: "getMainContent (current)",
    run: (p) => getMainContent(parseDocument(p.html)),
  },
  {
    name: "getMainContent (word-separated)",
    run: (p) => getMainContentSeparated(parseDocument(p.html)),
  },
  {
    name: "readability-style (reimplemented)",
    run: (p) => readabilityStyle(parseDocument(p.html)),
  },
  {
    name: "extractMainText (markup only)",
    run: (p) => extractMainText(parseDocument(p.html)).text,
  },
  {
    name: "extractMainText (classifier)",
    run: (p) => {
      const { doc, result, elements } = withClassifier(p.html, p.url);
      return extractMainText(doc, { place: elementPlacer(result, elements) })
        .text;
    },
  },
];

// getMainContent glues adjacent blocks (`<p>a</p><p>b</p>` reads `ab`), which costs it tokens
// before any choice of region. This control keeps its selector list and exclusions but separates
// blocks, so the comparison is about WHAT is kept, not about missing spaces.
function getMainContentSeparated(doc: Doc): string {
  const selectors = [
    "article",
    "main",
    '[role="main"]',
    ".content",
    ".post-content",
    ".article-content",
    ".entry-content",
    "#content",
    "#main",
  ];
  const drop = new Set(["script", "style", "nav", "footer", "header", "aside"]);
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (!el) continue;
    const text = collectTextExcluding(
      el as never,
      (e) => drop.has(tagOf(e as never)),
      "\n",
      (e) => BLOCK_TAGS.has(tagOf(e as never))
    ).trim();
    if (text && text.replace(/\s+/g, "").length > 100) return text;
  }
  return collectTextExcluding(
    doc.body as never,
    (e) =>
      ["script", "style", "noscript", "template", "svg"].includes(
        tagOf(e as never)
      ),
    "\n",
    (e) => BLOCK_TAGS.has(tagOf(e as never))
  ).trim();
}

const results = EXTRACTORS.map((extractor) => {
  const total: Score = { overlap: 0, predicted: 0, gold: 0 };
  const perPage = pages.map((page) => {
    const s = score(extractor.run(page), page.gold);
    total.overlap += s.overlap;
    total.predicted += s.predicted;
    total.gold += s.gold;
    return { page: page.name, ...prf(s) };
  });
  return {
    extractor: extractor.name,
    ...prf(total),
    tokens: total.predicted,
    perPage,
  };
});

// Timing. Parsing is not charged to any extractor; it is shared work in a real audit.
const timingPages = timingDir ? readDir(resolve(timingDir), false) : pages;
const baseline: number[] = [];
const extractOnly: number[] = [];
const classifyAndExtract: number[] = [];
for (const page of timingPages) {
  const doc = parseDocument(page.html);
  const classified = withClassifier(page.html, page.url);
  baseline.push(minTime(() => getMainContent(doc)));
  extractOnly.push(
    minTime(() =>
      extractMainText(classified.doc, {
        place: elementPlacer(classified.result, classified.elements),
      })
    )
  );
  classifyAndExtract.push(
    minTime(() => {
      const elements: unknown[] = [];
      const result = classifyDocument(doc, page.url, {
        model,
        html: page.html,
        elementsOut: elements,
      });
      return extractMainText(doc, { place: elementPlacer(result, elements) });
    })
  );
}
const timing = {
  pages: timingPages.length,
  rounds,
  getMainContentMs: {
    p50: percentile(baseline, 50),
    p95: percentile(baseline, 95),
  },
  extractWithPlacerMs: {
    p50: percentile(extractOnly, 50),
    p95: percentile(extractOnly, 95),
  },
  classifyAndExtractMs: {
    p50: percentile(classifyAndExtract, 50),
    p95: percentile(classifyAndExtract, 95),
  },
  addedP95Ms: {
    extractOnly: percentile(extractOnly, 95) - percentile(baseline, 95),
    classifyAndExtract:
      percentile(classifyAndExtract, 95) - percentile(baseline, 95),
  },
};

if (asJson) {
  console.log(
    JSON.stringify({ goldDir, pages: pages.length, results, timing }, null, 2)
  );
  process.exit(0);
}

const pct = (n: number): string => (n * 100).toFixed(1).padStart(6) + "%";
const ms = (n: number): string => n.toFixed(2).padStart(8);
console.log(`Main-text benchmark: ${pages.length} pages from ${goldDir}\n`);
console.log("| Extractor | Precision | Recall | F1 | Tokens kept |");
console.log("| --- | ---: | ---: | ---: | ---: |");
for (const r of results) {
  console.log(
    `| ${r.extractor} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} | ${r.tokens} |`
  );
}
if (verbose) {
  console.log("\nPer page (precision / recall)\n");
  console.log(`| Page | ${results.map((r) => r.extractor).join(" | ")} |`);
  console.log(`| --- | ${results.map(() => "---").join(" | ")} |`);
  for (const [i, page] of pages.entries()) {
    const cells = results.map(
      (r) =>
        `${(r.perPage[i]!.precision * 100).toFixed(0)} / ${(r.perPage[i]!.recall * 100).toFixed(0)}`
    );
    console.log(`| ${page.name} | ${cells.join(" | ")} |`);
  }
}
console.log(
  `\nTiming over ${timing.pages} pages, min of ${rounds} rounds per page (ms)\n`
);
console.log("| Step | p50 | p95 |");
console.log("| --- | ---: | ---: |");
console.log(
  `| getMainContent | ${ms(timing.getMainContentMs.p50)} | ${ms(timing.getMainContentMs.p95)} |`
);
console.log(
  `| extractMainText with placer (classifier already run) | ${ms(timing.extractWithPlacerMs.p50)} | ${ms(timing.extractWithPlacerMs.p95)} |`
);
console.log(
  `| classify + extractMainText | ${ms(timing.classifyAndExtractMs.p50)} | ${ms(timing.classifyAndExtractMs.p95)} |`
);
console.log(
  `\np95 added vs getMainContent: ${timing.addedP95Ms.extractOnly.toFixed(2)} ms extraction only, ${timing.addedP95Ms.classifyAndExtract.toFixed(2)} ms with classification (the classifier normally runs for the page anyway).`
);
const base = results[0]!;
const classifier = results[results.length - 1]!;
const wins =
  classifier.precision > base.precision && classifier.recall > base.recall;
console.log(
  `\nextractMainText (classifier) beats getMainContent on precision and recall: ${wins ? "yes" : "NO"}`
);
if (!wins) process.exitCode = 1;
