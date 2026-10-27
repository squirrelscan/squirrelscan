#!/usr/bin/env bun
// Per-page cost of the page classifier (#2307): `parsePage` with and without the hook.
//
//   bun scripts/bench-classifier.ts                      # 100 synthetic pages
//   bun scripts/bench-classifier.ts --pages 200 --rounds 5
//   bun scripts/bench-classifier.ts --dir ./html-pages   # every *.html in a directory
//   bun scripts/bench-classifier.ts --dir ./html-pages --stripped
//                                                         # what the model says once the markup is silent
//
// Each page is parsed `rounds` times per variant, alternating, and the minimum is kept, so a
// scheduling hiccup does not become a p95. The model is loaded before timing starts (the load is
// reported on its own). Run it on a quiet machine: under swap pressure the absolute numbers are
// not comparable, only the paired difference is.

import { classifyDocument, elementPlacer } from "@squirrelscan/page-classifier";
import {
  makeLinkSectionResolver,
  mergeLinkSection,
  parseDocument,
  parsePage,
} from "@squirrelscan/parser";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadBundledClassifier } from "../src/classifier";
import { createPageClassifierHook } from "../src/classifier/hook";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rounds = Number(arg("--rounds") ?? 3);
const dir = arg("--dir");

interface Sample {
  url: string;
  html: string;
}

async function synthetic(count: number): Promise<Sample[]> {
  // Relative on purpose: the synthetic-site package is a dev tool, not a CLI dependency.
  const { generateSiteModel, renderPageHtml } =
    await import("../../../packages/synthetic-site/src/index.ts");
  const origin = "https://bench.example";
  const model = generateSiteModel({
    seed: "bench-classifier",
    pageCount: count,
  });
  return model.pages
    .filter((page) => page.statusCode === 200)
    .map((page) => ({
      url: `${origin}${page.path}`,
      html: renderPageHtml(page, origin),
    }));
}

function fromDir(path: string): Sample[] {
  return readdirSync(path)
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => ({
      url: `https://bench.example/${name.replace(/\.html$/, "")}`,
      html: readFileSync(join(path, name), "utf8"),
    }));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]!;
}

function row(label: string, values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const f = (n: number): string => n.toFixed(1).padStart(8);
  return `${label.padEnd(26)}${f(percentile(sorted, 50))}${f(percentile(sorted, 95))}${f(sorted[sorted.length - 1] ?? 0)}`;
}

const samples = dir
  ? fromDir(dir)
  : await synthetic(Number(arg("--pages") ?? 100));
if (samples.length === 0) throw new Error("no pages to measure");

const loaded = loadBundledClassifier();
if (!loaded.model) throw new Error(`model unavailable: ${loaded.reason}`);
const classify = createPageClassifierHook();

// --stripped: remove landmark tags and roles from each page so the markup goes silent, then ask the
// model alone where each anchor sits, against what the ORIGINAL markup said. A wiring check, not an
// evaluation: it shows how much of the silence the model fills and how often it agrees.
if (process.argv.includes("--stripped")) {
  const strip = (html: string): string =>
    html
      .replace(/<(\/?)(nav|header|footer|aside|main|article)\b/gi, "<$1div")
      .replace(/\srole\s*=\s*("[^"]*"|'[^']*')/gi, "");
  const table: Record<string, Record<string, number>> = {};
  let anchors = 0;
  let answered = 0;
  for (const { url, html } of samples) {
    const truthOf = makeLinkSectionResolver();
    const truth = [...parseDocument(html).querySelectorAll("a[href]")].map(
      (a) => truthOf(a as never).section
    );
    const stripped = strip(html);
    const document = parseDocument(stripped);
    const elements: unknown[] = [];
    const result = classifyDocument(document, url, {
      model: loaded.model,
      html: stripped,
      elementsOut: elements,
    });
    const place = elementPlacer(result, elements);
    const list = [...document.querySelectorAll("a[href]")];
    if (list.length !== truth.length) continue;
    list.forEach((anchor, i) => {
      anchors++;
      const got = mergeLinkSection(
        "unknown",
        () => place(anchor) as never
      ).section;
      if (got !== "unknown") answered++;
      const row = (table[truth[i]!] ??= {});
      row[got] = (row[got] ?? 0) + 1;
    });
  }
  console.log(
    `${samples.length} pages, ${anchors} anchors: the model alone answers ${answered} (${((100 * answered) / anchors).toFixed(1)}%)`
  );
  console.log(
    "rows: section the original markup gave; columns: the model's answer on the stripped page"
  );
  for (const [section, row] of Object.entries(table)) {
    console.log(`${section.padEnd(12)} ${JSON.stringify(row)}`);
  }
  process.exit(0);
}

let degraded = 0;
let withModel = 0;
// links whose section the classifier changed, as `markup section -> section`
const changed: Record<string, number> = {};
let links = 0;
const off: number[] = [];
const on: number[] = [];
const delta: number[] = [];
for (const { url, html } of samples) {
  let bestOff = Number.POSITIVE_INFINITY;
  let bestOn = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round++) {
    let t = performance.now();
    const plain = parsePage(html, url);
    bestOff = Math.min(bestOff, performance.now() - t);
    t = performance.now();
    const parsed = parsePage(html, url, { classify });
    bestOn = Math.min(bestOn, performance.now() - t);
    if (round === 0) {
      if (parsed.classification?.degraded) degraded++;
      if (parsed.links.some((link) => link.sectionSource === "model"))
        withModel++;
      parsed.links.forEach((link, i) => {
        links++;
        const before = plain.links[i]?.section ?? "unknown";
        const after = link.section ?? "unknown";
        if (before !== after) {
          const key = `${before} -> ${after}`;
          changed[key] = (changed[key] ?? 0) + 1;
        }
      });
    }
  }
  off.push(bestOff);
  on.push(bestOn);
  delta.push(bestOn - bestOff);
}

const kb = samples.map((s) => s.html.length / 1024).sort((a, b) => a - b);
console.log(
  `${samples.length} pages, ${rounds} rounds, html p50 ${percentile(kb, 50).toFixed(0)} KB, max ${kb[kb.length - 1]!.toFixed(0)} KB`
);
console.log(`model load ${loaded.loadMs.toFixed(1)} ms (once)`);
console.log(
  `${"".padEnd(26)}${"p50".padStart(8)}${"p95".padStart(8)}${"max".padStart(8)}  (ms per page)`
);
console.log(row("parsePage, no classifier", off));
console.log(row("parsePage + classifier", on));
console.log(row("classifier overhead", delta));
console.log(
  `degraded pages: ${degraded}; pages with a model-named link section: ${withModel}`
);
const moved = Object.values(changed).reduce((a, b) => a + b, 0);
console.log(`links: ${links}; sections the classifier changed: ${moved}`);
for (const [key, count] of Object.entries(changed).sort(
  (a, b) => b[1] - a[1]
)) {
  console.log(`  ${key.padEnd(28)}${String(count).padStart(6)}`);
}
