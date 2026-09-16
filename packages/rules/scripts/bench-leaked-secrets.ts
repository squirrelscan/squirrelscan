// Benchmark for security/leaked-secrets: the scanner over a synthetic corpus.
//
// The corpus is every case from tests/security/leaked-secrets (the pages and
// their external scripts) plus filler that looks like what a crawl actually
// hands the scanner: 50–500 KB minified bundles with the CONTEXT_PATTERNS
// keywords `segment`, `cloudflare` and `twilio` sprinkled in every few KB so
// the keyword-window path runs, and a few 2–5 MB vendor bundles.
//
// What is timed is scanContent alone — the pages are parsed and serialized
// once up front, so the number is the detector's cost and not the parser's.
//
//   bun run scripts/bench-leaked-secrets.ts --out /tmp/secrets-bench.json
//   bun run scripts/bench-leaked-secrets.ts --iterations 5 --pages 200 --seed 1
//
// Deterministic: same seed, same corpus, same findings count. Times vary.

import { writeFileSync } from "node:fs";

import { parsePage } from "@squirrelscan/parser";

import { scanContent, scanPageForSecrets } from "../src/security/leaked-secrets";
import { CASES } from "../tests/security/leaked-secrets/cases";
import { mixedRun, runOf, seededRng, type Rng } from "../tests/security/leaked-secrets/generators";

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

const ITERATIONS = Number(arg("iterations", "3"));
const PAGES = Number(arg("pages", "200"));
const SEED = Number(arg("seed", "1"));
const OUT = arg("out", "");

type Body = { location: "html" | "inline-script" | "external-script"; text: string; url: string };

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const IDENT = LOWER + "0123456789_$";
const KEYWORDS = ["segment", "cloudflare", "twilio"];

/** Minified-JS-looking filler of about `bytes` characters. No credential shapes. */
function minifiedFiller(r: Rng, bytes: number): string {
  const parts: string[] = ['"use strict";'];
  let size = parts[0]!.length;
  let n = 0;
  while (size < bytes) {
    const a = runOf(r, LOWER, 1) + runOf(r, IDENT, 1 + Math.floor(r() * 4));
    const b = runOf(r, LOWER, 1) + runOf(r, IDENT, 1 + Math.floor(r() * 4));
    const kind = Math.floor(r() * 6);
    let chunk: string;
    if (kind === 0) chunk = `function ${a}(${b},t){return ${b}?t(${b}):null}`;
    else if (kind === 1) chunk = `var ${a}=${b}.exports={};`;
    else if (kind === 2) chunk = `${a}.${b}=function(e){for(var n=0;n<e.length;n++)e[n]&&e[n]()};`;
    else if (kind === 3) chunk = `${a}["${runOf(r, LOWER, 6)}"]=${Math.floor(r() * 1e6)};`;
    else if (kind === 4) chunk = `if(${a}!==${b}){${a}=${b}.slice(0,${1 + Math.floor(r() * 9)})}`;
    else chunk = `${a}.push({id:"${runOf(r, LOWER, 4)}-${runOf(r, "0123456789", 3)}",label:"${runOf(r, LOWER, 5)} ${runOf(r, LOWER, 7)}"});`;
    // A brand keyword every ~2 KB, inside ordinary code so the window path runs
    // and finds nothing: a comment, a string, a property name.
    if (++n % 40 === 0) {
      const kw = KEYWORDS[n % KEYWORDS.length]!;
      const form = n % 3;
      chunk +=
        form === 0 ? `/* ${kw} integration */` : form === 1 ? `${a}.provider="${kw}";` : `${a}.${kw}Enabled=!0;`;
    }
    parts.push(chunk);
    size += chunk.length;
  }
  return parts.join("");
}

function buildCorpus(): { bodies: Body[]; bytes: number; pages: number; scripts: number } {
  const r = seededRng(SEED);
  const bodies: Body[] = [];
  let pages = 0;
  let scripts = 0;

  // 1. Half the page budget is corpus cases, sampled evenly across the list so
  //    every context and tier is represented, serialized the way the rule
  //    sees them.
  const all = CASES.filter((c) => c.id !== "probe:no-size-cap-on-external-script");
  const budget = Math.min(all.length, Math.floor(PAGES / 2));
  const step = all.length / budget;
  const sampled = Array.from({ length: budget }, (_, i) => all[Math.floor(i * step)]!);
  for (const c of sampled) {
    const doc = parsePage(c.html, c.url).document!;
    bodies.push({ location: "html", text: doc.toString(), url: c.url });
    for (const s of doc.querySelectorAll("script:not([src])")) {
      const t = s.textContent || "";
      if (t.trim()) bodies.push({ location: "inline-script", text: t, url: c.url });
    }
    for (const s of c.scripts ?? []) {
      bodies.push({ location: "external-script", text: s.content, url: s.url });
      scripts++;
    }
    pages++;
  }

  // 2. Filler pages: a small HTML shell whose weight is one inline bundle of
  //    50–500 KB, plus an external bundle of the same shape on every 4th page.
  while (pages < PAGES) {
    const kb = 50 + Math.floor(r() * 450);
    const inlineJs = minifiedFiller(r, kb * 1024);
    const html = `<!DOCTYPE html><html><head><title>p${pages}</title></head><body><div id="root"></div><script>${inlineJs}</script></body></html>`;
    bodies.push({ location: "html", text: html, url: `https://bench.test/p${pages}` });
    bodies.push({ location: "inline-script", text: inlineJs, url: `https://bench.test/p${pages}` });
    if (pages % 4 === 0) {
      bodies.push({
        location: "external-script",
        text: minifiedFiller(r, (50 + Math.floor(r() * 450)) * 1024),
        url: `https://bench.test/static/chunk-${pages}.js`,
      });
      scripts++;
    }
    pages++;
  }

  // 3. A few 2–5 MB vendor bundles, one of them carrying a real finding at the
  //    end so the scan of a large body provably runs to completion.
  for (let i = 0; i < 3; i++) {
    const mb = 2 + Math.floor(r() * 4);
    let text = minifiedFiller(r, mb * 1024 * 1024);
    if (i === 0) text += `var t={${["gh", "p_"].join("")}:"${["gh", "p_"].join("")}${mixedRun(r, 36)}"};`;
    bodies.push({ location: "external-script", text, url: `https://bench.test/static/vendor-${i}.js` });
    scripts++;
  }

  const bytes = bodies.reduce((n, b) => n + b.text.length, 0);
  return { bodies, bytes, pages, scripts };
}

function main() {
  const t0 = performance.now();
  const corpus = buildCorpus();
  const buildMs = performance.now() - t0;
  const mb = corpus.bytes / (1024 * 1024);

  // Warm the JIT on one pass that is not measured.
  for (const b of corpus.bodies) scanContent(b.text, b.location, b.url);

  let peakRss = process.memoryUsage().rss;
  const runs: number[] = [];
  let findings = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    findings = 0;
    const start = performance.now();
    for (const b of corpus.bodies) {
      findings += scanContent(b.text, b.location, b.url).length;
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
    }
    runs.push(performance.now() - start);
  }

  const best = Math.min(...runs);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  const result = {
    date: new Date().toISOString(),
    seed: SEED,
    iterations: ITERATIONS,
    corpus: {
      pages: corpus.pages,
      externalScripts: corpus.scripts,
      bodies: corpus.bodies.length,
      bytes: corpus.bytes,
      mb: Number(mb.toFixed(2)),
      buildMs: Number(buildMs.toFixed(0)),
    },
    scan: {
      runsMs: runs.map((r) => Number(r.toFixed(1))),
      bestMs: Number(best.toFixed(1)),
      meanMs: Number(mean.toFixed(1)),
      msPerMb: Number((best / mb).toFixed(2)),
      findings,
      peakRssMb: Number((peakRss / (1024 * 1024)).toFixed(0)),
    },
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
  };

  console.log(JSON.stringify(result, null, 2));
  if (OUT) {
    writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
    console.error(`wrote ${OUT}`);
  }
}

// scanPageForSecrets is what the rule calls per page; referenced so a future
// change to its signature breaks this script at typecheck rather than silently.
void scanPageForSecrets;

main();
