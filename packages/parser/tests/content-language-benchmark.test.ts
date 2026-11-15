// The content-language benchmark script (benchmarks/harness/content-language.ts)
// on a tiny synthetic corpus written for this test. The
// report must be aggregate-only: no page text, URLs, hosts, file names or
// per-sample labels, because it is published from a private corpus.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { LanguageDetector } from "../src/language";

import {
  runLanguageBenchmark,
  type BenchmarkSample,
} from "../src/language/benchmark";

const SCRIPT = resolve(
  import.meta.dir,
  "../../../benchmarks/harness/content-language.ts"
);

// Distinctive markers: none may appear anywhere in the report.
const HOST = "secret-corpus-host.example";
const URL = `https://${HOST}/private/page-7`;
const FILE_MARKER = "page-file-marker";
const TEXT_MARKER = "Quokkapalooza";

const EN = `${TEXT_MARKER} the squirrel buried twelve acorns under the old oak tree before the first snow of winter arrived in the valley. Visit ${URL} for more.`;
const DE = `${TEXT_MARKER} das Eichhörnchen hat vor dem ersten Schnee zwölf Eicheln unter der alten Eiche im Garten vergraben, weil es den Winter fürchtet.`;
const FR = `${TEXT_MARKER} l'écureuil a caché douze glands sous le vieux chêne avant que la première neige de l'hiver ne tombe sur la vallée.`;

let dir: string;
let detectorModule: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "content-language-bench-"));
  const corpus = join(dir, "corpus");
  mkdirSync(join(corpus, "en"), { recursive: true });
  mkdirSync(join(corpus, "de-DE"), { recursive: true });
  writeFileSync(join(corpus, "en", `${FILE_MARKER}-1.txt`), EN);
  writeFileSync(
    join(corpus, "de-DE", `${FILE_MARKER}-2.html`),
    `<html lang="de"><head><title>${TEXT_MARKER}</title></head><body><nav><a href="${URL}">${TEXT_MARKER}</a></nav><main><p>${DE}</p></main></body></html>`
  );
  writeFileSync(
    join(corpus, `${FILE_MARKER}.jsonl`),
    [
      JSON.stringify({ lang: "fr", text: FR, url: URL, host: HOST }),
      JSON.stringify({
        lang: "en",
        html: `<html><body><main><p>${EN}</p></main></body></html>`,
        url: URL,
      }),
      JSON.stringify({ lang: "", text: FR }),
      "{not json",
    ].join("\n")
  );
  // A third candidate supplied as a module, the way an eld or tinyld adapter would be.
  detectorModule = join(dir, "always-en.ts");
  writeFileSync(
    detectorModule,
    `export default () => ({ id: "always-en", detectLanguage: () => ({ lang: "en", confidence: 0.5 }) });\n`
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Every string anywhere in a JSON value, keys included. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allStrings(v, out);
    }
  }
  return out;
}

/** String values only (not keys). */
function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) stringValues(v, out);
  return out;
}

describe("runLanguageBenchmark floor suggestion", () => {
  test("suggests the lowest length bucket and confidence that reach the target precision", () => {
    // Synthetic outcomes: short text (< 40 chars) is confidently wrong, long text is right
    // when confidence is at least 0.5 and wrong below it.
    const samples: BenchmarkSample[] = [];
    for (let i = 0; i < 30; i++)
      samples.push({ lang: "en", text: `short ${i}`.padEnd(30, "x") });
    for (let i = 0; i < 40; i++)
      samples.push({ lang: "en", text: `long ${i} hi`.padEnd(100, "y") });
    for (let i = 0; i < 40; i++)
      samples.push({ lang: "en", text: `long ${i} lo`.padEnd(100, "z") });
    const detector: LanguageDetector = {
      id: "synthetic",
      detectLanguage(text) {
        if (text.length < 40) return { lang: "de", confidence: 0.9 };
        return text.includes(" hi")
          ? { lang: "en", confidence: 0.8 }
          : { lang: "de", confidence: 0.2 };
      },
    };
    const [d] = runLanguageBenchmark(samples, [detector]).detectors;
    expect(d.suggestedFloor).toEqual({
      targetPrecision: 0.95,
      minChars: 40,
      minConfidence: 0.8,
      precisionAtFloor: 1,
      coverageAtFloor: round4(40 / 110),
    });
    expect(d.overall).toMatchObject({
      samples: 110,
      answered: 110,
      accuracy: round4(40 / 110),
    });
  });
});

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

describe("content-language benchmark script", () => {
  test("writes an aggregate-only report for every detector", () => {
    const outFile = join(dir, "report.json");
    const res = run(
      join(dir, "corpus"),
      `--out=${outFile}`,
      `--detector=${detectorModule}`
    );
    expect(res.code).toBe(0);
    const raw = readFileSync(outFile, "utf8");
    const report = JSON.parse(raw);

    expect(report.schema).toBe("squirrelscan.content-language-benchmark/v1");
    expect(report.samples).toBe(4);
    expect(report.samplesPerLanguage).toEqual({ de: 1, en: 2, fr: 1 });
    expect(report.skipped).toBe(2); // the unlabelled record and the bad JSON line
    expect(report.detectors.map((d: { id: string }) => d.id)).toEqual([
      "franc",
      "franc-all",
      "always-en",
    ]);

    for (const d of report.detectors) {
      expect(Object.keys(d).sort()).toEqual(
        [
          "byLength",
          "confidenceHistogram",
          "id",
          "latencyMs",
          "overall",
          "perLanguage",
          "suggestedFloor",
        ].sort()
      );
      expect(d.overall.samples).toBe(4);
      expect(typeof d.latencyMs.p95).toBe("number");
      expect(d.confidenceHistogram.length).toBeGreaterThan(0);
      expect(
        d.byLength.reduce(
          (n: number, b: { support: number }) => n + b.support,
          0
        )
      ).toBe(4);
    }
    const franc = report.detectors[0];
    expect(franc.overall.accuracy).toBe(1);
    expect(franc.perLanguage.de).toMatchObject({ support: 1, f1: 1 });
    const alwaysEn = report.detectors[2];
    expect(alwaysEn.overall.accuracy).toBe(0.5);
    expect(alwaysEn.perLanguage.fr).toMatchObject({ support: 1, recall: 0 });

    // No text, URL, host or file name anywhere, keys included.
    for (const marker of [
      TEXT_MARKER,
      HOST,
      URL,
      FILE_MARKER,
      "http",
      "acorns",
      "Eich",
      dir,
    ]) {
      expect(raw).not.toContain(marker);
    }
    const forbiddenKeys = [
      "text",
      "html",
      "url",
      "host",
      "file",
      "path",
      "label",
      "sample",
    ];
    const keys = allStrings(report).map((s) => s.toLowerCase());
    for (const k of forbiddenKeys) expect(keys).not.toContain(k);
    // The only string VALUES are the schema id and the detector ids; every
    // other string is a key (field name or language code).
    expect(stringValues(report).sort()).toEqual(
      [
        "always-en",
        "franc",
        "franc-all",
        "squirrelscan.content-language-benchmark/v1",
      ].sort()
    );
    for (const s of allStrings(report)) expect(s.length).toBeLessThan(64);
  }, 30_000);

  test("--table prints markdown aggregates with no text or URLs", () => {
    const res = run(join(dir, "corpus"), "--table");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("| detector | accuracy |");
    expect(res.stdout).toContain("| de | 1 |");
    for (const marker of [TEXT_MARKER, HOST, FILE_MARKER, "http"])
      expect(res.stdout).not.toContain(marker);
  }, 30_000);

  test("requires a corpus directory argument", () => {
    const res = run();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage:");
    expect(run(join(dir, "missing")).code).toBe(2);
  }, 30_000);
});
