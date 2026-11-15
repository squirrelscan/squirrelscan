// Aggregate-only benchmark for content-language detectors
// (squirrelscan/repo#2360). Driven by benchmarks/harness/content-language.ts.
//
// PRIVACY CONTRACT: the report holds counts, rates, latencies and language codes
// only. It never carries page text, URLs, hosts, file names or any per-sample
// label, so it can be published from a private corpus. Samples live in memory
// for one detection and are dropped. Not re-exported from the package: a
// measurement tool, not part of the product.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { parseHTML } from "../dom";
import { normalizeLanguageTag, prepareLanguageText, type LanguageDetector } from "./detector";
import { mainContentLanguageText } from "./page";

/** One labelled sample, in memory only. */
export interface BenchmarkSample {
  /** Gold language tag (any BCP 47 form; normalised to its primary subtag). */
  lang: string;
  /** Text to detect on (already extracted from HTML when the corpus held HTML). */
  text: string;
}

/** Upper bounds (exclusive) of the text-length buckets, in characters of prepared text. */
export const LENGTH_BUCKET_BOUNDS = [20, 40, 80, 160, 320, 640, 1280, 2560] as const;
/** Width of one confidence-histogram bucket. */
export const CONFIDENCE_BUCKET_WIDTH = 0.025;
/** A suggested floor must keep at least this many answers, so a handful of samples cannot set it. */
export const MIN_BUCKET_SUPPORT = 20;

export interface LanguageScore {
  /** Gold samples in this language. */
  support: number;
  /** Samples the detector labelled with this language. */
  predicted: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface LengthBucketScore {
  minChars: number;
  /** Exclusive; null for the open last bucket. */
  maxChars: number | null;
  support: number;
  /** Correct / support (an abstention counts as a miss). */
  accuracy: number | null;
  abstained: number;
}

export interface ConfidenceBucket {
  min: number;
  max: number;
  correct: number;
  incorrect: number;
}

export interface SuggestedFloor {
  /** Target precision the floor was chosen for. */
  targetPrecision: number;
  /** Length floor (a bucket lower bound) of the (length, confidence) pair that keeps the most answers at the target; null if none. */
  minChars: number | null;
  /** Lowest confidence at which answers at or above `minChars` reach the target; null if none. */
  minConfidence: number | null;
  /** Precision of the answers kept by the suggested floor. */
  precisionAtFloor: number | null;
  /** Share of ALL samples still answered under the suggested floor. */
  coverageAtFloor: number | null;
}

export interface DetectorReport {
  id: string;
  overall: {
    samples: number;
    answered: number;
    abstained: number;
    /** Correct / samples: an abstention counts as a miss. */
    accuracy: number | null;
    /** Correct / answered. */
    precision: number | null;
    /** Mean F1 over the gold languages. */
    macroF1: number | null;
  };
  perLanguage: Record<string, LanguageScore>;
  byLength: LengthBucketScore[];
  latencyMs: { mean: number; p50: number; p95: number; p99: number; max: number; total: number };
  confidenceHistogram: ConfidenceBucket[];
  suggestedFloor: SuggestedFloor;
}

export interface BenchmarkReport {
  schema: "squirrelscan.content-language-benchmark/v1";
  samples: number;
  /** Gold samples per language. */
  samplesPerLanguage: Record<string, number>;
  /** Corpus records skipped (no usable label or no text), counted only. */
  skipped: number;
  detectors: DetectorReport[];
}

interface Outcome {
  gold: string;
  predicted: string | null;
  confidence: number;
  length: number;
}

const round = (n: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const ratio = (a: number, b: number): number | null => (b > 0 ? round(a / b) : null);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function lengthBucketIndex(length: number): number {
  for (let i = 0; i < LENGTH_BUCKET_BOUNDS.length; i++) {
    if (length < LENGTH_BUCKET_BOUNDS[i]) return i;
  }
  return LENGTH_BUCKET_BOUNDS.length;
}

function bucketLowerBound(i: number): number {
  return i === 0 ? 0 : LENGTH_BUCKET_BOUNDS[i - 1];
}

function scoreLanguages(outcomes: Outcome[]): Record<string, LanguageScore> {
  const support = new Map<string, number>();
  const predicted = new Map<string, number>();
  const tp = new Map<string, number>();
  for (const o of outcomes) {
    support.set(o.gold, (support.get(o.gold) ?? 0) + 1);
    if (o.predicted) predicted.set(o.predicted, (predicted.get(o.predicted) ?? 0) + 1);
    if (o.predicted === o.gold) tp.set(o.gold, (tp.get(o.gold) ?? 0) + 1);
  }
  const langs = [...new Set([...support.keys(), ...predicted.keys()])].sort();
  const out: Record<string, LanguageScore> = {};
  for (const lang of langs) {
    const s = support.get(lang) ?? 0;
    const p = predicted.get(lang) ?? 0;
    const t = tp.get(lang) ?? 0;
    const precision = ratio(t, p);
    const recall = ratio(t, s);
    const f1 =
      precision !== null && recall !== null
        ? precision + recall > 0
          ? round((2 * precision * recall) / (precision + recall))
          : 0
        : null;
    out[lang] = { support: s, predicted: p, precision, recall, f1 };
  }
  return out;
}

/** Lowest confidence at which the kept answers meet `target`, or null; `answered` sorted by confidence ascending. */
function lowestConfidenceFor(answered: Outcome[], target: number): { minConfidence: number; kept: number; correct: number } | null {
  let correctAbove = answered.filter((o) => o.predicted === o.gold).length;
  for (let i = 0; i < answered.length; i++) {
    const kept = answered.length - i;
    if (kept < MIN_BUCKET_SUPPORT) return null;
    if (correctAbove / kept >= target) {
      return { minConfidence: answered[i].confidence, kept, correct: correctAbove };
    }
    if (answered[i].predicted === answered[i].gold) correctAbove--;
    // Ties share a threshold: skip to the last sample with this confidence.
    while (i + 1 < answered.length && answered[i + 1].confidence === answered[i].confidence) {
      i++;
      if (answered[i].predicted === answered[i].gold) correctAbove--;
    }
  }
  return null;
}

/**
 * The (length, confidence) floor that keeps the most answers while the kept
 * answers reach `target` precision. Length candidates are the bucket lower
 * bounds; for each, the lowest confidence that reaches the target. A candidate
 * must keep at least {@link MIN_BUCKET_SUPPORT} answers. Ties on coverage go to
 * the shorter length floor.
 */
function suggestFloor(outcomes: Outcome[], target: number): SuggestedFloor {
  const answered = outcomes
    .filter((o) => o.predicted !== null)
    .sort((a, b) => a.confidence - b.confidence);
  let best: SuggestedFloor | null = null;
  let bestKept = 0;
  for (let i = 0; i <= LENGTH_BUCKET_BOUNDS.length; i++) {
    const minChars = bucketLowerBound(i);
    const found = lowestConfidenceFor(
      answered.filter((o) => o.length >= minChars),
      target,
    );
    if (!found || found.kept <= bestKept) continue;
    bestKept = found.kept;
    best = {
      targetPrecision: target,
      minChars,
      minConfidence: round(found.minConfidence),
      precisionAtFloor: round(found.correct / found.kept),
      coverageAtFloor: ratio(found.kept, outcomes.length),
    };
  }
  return (
    best ?? { targetPrecision: target, minChars: null, minConfidence: null, precisionAtFloor: null, coverageAtFloor: null }
  );
}

function reportFor(id: string, outcomes: Outcome[], latencies: number[], target: number): DetectorReport {
  const answered = outcomes.filter((o) => o.predicted !== null).length;
  const correct = outcomes.filter((o) => o.predicted === o.gold).length;
  const perLanguage = scoreLanguages(outcomes);
  const goldF1 = Object.values(perLanguage)
    .filter((s) => s.support > 0)
    .map((s) => s.f1 ?? 0);

  const lengthCounts = Array.from({ length: LENGTH_BUCKET_BOUNDS.length + 1 }, () => ({
    support: 0,
    correct: 0,
    abstained: 0,
  }));
  for (const o of outcomes) {
    const b = lengthCounts[lengthBucketIndex(o.length)];
    b.support++;
    if (o.predicted === o.gold) b.correct++;
    if (o.predicted === null) b.abstained++;
  }
  const byLength: LengthBucketScore[] = lengthCounts.map((b, i) => ({
    minChars: bucketLowerBound(i),
    maxChars: i < LENGTH_BUCKET_BOUNDS.length ? LENGTH_BUCKET_BOUNDS[i] : null,
    support: b.support,
    accuracy: ratio(b.correct, b.support),
    abstained: b.abstained,
  }));

  const nBuckets = Math.round(1 / CONFIDENCE_BUCKET_WIDTH);
  const histogram: ConfidenceBucket[] = Array.from({ length: nBuckets }, (_, i) => ({
    min: round(i * CONFIDENCE_BUCKET_WIDTH),
    max: round((i + 1) * CONFIDENCE_BUCKET_WIDTH),
    correct: 0,
    incorrect: 0,
  }));
  for (const o of outcomes) {
    if (o.predicted === null) continue;
    const i = Math.min(nBuckets - 1, Math.max(0, Math.floor(o.confidence / CONFIDENCE_BUCKET_WIDTH)));
    if (o.predicted === o.gold) histogram[i].correct++;
    else histogram[i].incorrect++;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.reduce((a, b) => a + b, 0);
  return {
    id,
    overall: {
      samples: outcomes.length,
      answered,
      abstained: outcomes.length - answered,
      accuracy: ratio(correct, outcomes.length),
      precision: ratio(correct, answered),
      macroF1: goldF1.length > 0 ? round(goldF1.reduce((a, b) => a + b, 0) / goldF1.length) : null,
    },
    perLanguage,
    byLength,
    latencyMs: {
      mean: sorted.length > 0 ? round(total / sorted.length) : 0,
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted[sorted.length - 1] ?? 0),
      total: round(total),
    },
    confidenceHistogram: histogram,
    suggestedFloor: suggestFloor(outcomes, target),
  };
}

export interface BenchmarkOptions {
  /** Precision the suggested floor must reach. Default 0.95. */
  targetPrecision?: number;
}

/**
 * Run every detector over every sample (RAW: no floor, so the floor can be
 * chosen from the results) and return the aggregate report. Samples are
 * consumed one at a time and not retained.
 */
export function runLanguageBenchmark(
  samples: Iterable<BenchmarkSample>,
  detectors: readonly LanguageDetector[],
  options: BenchmarkOptions = {},
): BenchmarkReport {
  const target = options.targetPrecision ?? 0.95;
  const outcomes = detectors.map(() => [] as Outcome[]);
  const latencies = detectors.map(() => [] as number[]);
  const perLanguage = new Map<string, number>();
  let skipped = 0;
  let count = 0;

  for (const sample of samples) {
    const gold = normalizeLanguageTag(sample.lang);
    const text = prepareLanguageText(sample.text ?? "");
    if (!gold || text.length === 0) {
      skipped++;
      continue;
    }
    count++;
    perLanguage.set(gold, (perLanguage.get(gold) ?? 0) + 1);
    for (const [i, detector] of detectors.entries()) {
      const start = performance.now();
      const result = detector.detectLanguage(text);
      latencies[i].push(performance.now() - start);
      outcomes[i].push({
        gold,
        predicted: result ? normalizeLanguageTag(result.lang) : null,
        confidence: result?.confidence ?? 0,
        length: text.length,
      });
    }
  }

  return {
    schema: "squirrelscan.content-language-benchmark/v1",
    samples: count,
    samplesPerLanguage: Object.fromEntries([...perLanguage.entries()].sort(([a], [b]) => a.localeCompare(b))),
    skipped,
    detectors: detectors.map((d, i) => reportFor(d.id, outcomes[i], latencies[i], target)),
  };
}

const TEXT_EXTENSIONS = new Set([".txt"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

function htmlToText(html: string): string {
  const { document } = parseHTML(html);
  return mainContentLanguageText(document);
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) yield* walkFiles(path);
    else if (st.isFile()) yield path;
  }
}

/** Corpus records the loader could not use, by reason. Counted only, never named. */
export interface CorpusLoadStats {
  unreadable: number;
}

/**
 * Stream labelled samples from a corpus directory. Two layouts, mixable:
 *
 * - `*.jsonl` anywhere: one JSON object per line, `{ "lang": "de", "text": "..." }`
 *   or `{ "lang": "de", "html": "..." }` (HTML goes through the same main-content
 *   extraction production uses). Any other fields are ignored.
 * - `<dir>/<lang>/...` with `*.txt` or `*.html` files: the label is the name of
 *   the top-level directory the file sits under.
 *
 * Unparseable lines and files are counted in `stats`, never reported by name.
 *
 * @yields {BenchmarkSample} One labelled sample per usable record, in sorted path order.
 */
export function* loadLanguageCorpus(dir: string, stats?: CorpusLoadStats): Generator<BenchmarkSample> {
  const counts = stats ?? { unreadable: 0 };
  for (const path of walkFiles(dir)) {
    const ext = extname(path).toLowerCase();
    if (ext === ".jsonl") {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        counts.unreadable++;
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { lang?: unknown; text?: unknown; html?: unknown };
          const lang = typeof rec.lang === "string" ? rec.lang : "";
          const text =
            typeof rec.text === "string" ? rec.text : typeof rec.html === "string" ? htmlToText(rec.html) : "";
          yield { lang, text };
        } catch {
          counts.unreadable++;
        }
      }
      continue;
    }
    if (!TEXT_EXTENSIONS.has(ext) && !HTML_EXTENSIONS.has(ext)) continue;
    const rel = path.slice(dir.length).replace(/^[\\/]+/, "");
    const parts = rel.split(/[\\/]/);
    if (parts.length < 2) continue; // a file at the top level has no label directory
    try {
      const body = readFileSync(path, "utf8");
      yield { lang: parts[0], text: HTML_EXTENSIONS.has(ext) ? htmlToText(body) : body };
    } catch {
      counts.unreadable++;
    }
  }
}

const pct = (n: number | null): string => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);

/**
 * Render a report as markdown tables (aggregates only, the same fields as the
 * JSON), for pasting into a PR or issue.
 */
export function formatBenchmarkTable(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`Samples: ${report.samples} (skipped ${report.skipped})`, "");
  lines.push("| detector | accuracy | precision | macro F1 | abstained | p50 ms | p95 ms | floor chars | floor confidence | precision at floor | coverage at floor |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const d of report.detectors) {
    const f = d.suggestedFloor;
    lines.push(
      `| ${d.id} | ${pct(d.overall.accuracy)} | ${pct(d.overall.precision)} | ${d.overall.macroF1 ?? "n/a"} | ${d.overall.abstained} | ${d.latencyMs.p50} | ${d.latencyMs.p95} | ${f.minChars ?? "n/a"} | ${f.minConfidence ?? "n/a"} | ${pct(f.precisionAtFloor)} | ${pct(f.coverageAtFloor)} |`,
    );
  }
  const langs = Object.keys(report.samplesPerLanguage);
  lines.push("", `| lang | samples | ${report.detectors.map((d) => `${d.id} F1`).join(" | ")} |`);
  lines.push(`|---|---|${report.detectors.map(() => "---").join("|")}|`);
  for (const lang of langs) {
    const cells = report.detectors.map((d) => String(d.perLanguage[lang]?.f1 ?? "n/a"));
    lines.push(`| ${lang} | ${report.samplesPerLanguage[lang]} | ${cells.join(" | ")} |`);
  }
  const first = report.detectors[0];
  if (first) {
    lines.push("", `| length bucket | samples | ${report.detectors.map((d) => `${d.id} accuracy`).join(" | ")} |`);
    lines.push(`|---|---|${report.detectors.map(() => "---").join("|")}|`);
    for (const [i, b] of first.byLength.entries()) {
      const label = `${b.minChars}-${b.maxChars === null ? "" : b.maxChars - 1}`;
      const cells = report.detectors.map((d) => pct(d.byLength[i]?.accuracy ?? null));
      lines.push(`| ${label} | ${b.support} | ${cells.join(" | ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}
