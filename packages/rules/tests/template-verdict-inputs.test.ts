// Tripwire for the template fan-out key (#614). A rule that declares
// `verdictScope: "template"` may only read the inputs that the chrome key and
// `fanoutInputSignature` (packages/audit-engine/src/template-fanout.ts) cover, or
// that a reviewer has checked against them. This test lists every DOM selector
// and attribute a template-declared rule reads, and fails on any that is not in
// REVIEWED_INPUTS. Adding a read means adding it here after checking the key.
//
// Limits: only string-literal selectors and getAttribute names are seen. Reads
// through a variable, or a helper defined elsewhere, are not.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");

/**
 * Selector and attribute reads reviewed against the fan-out key. Entries marked
 * GAP are read by a template rule but NOT covered by `fanoutInputSignature`
 * (their verdict could differ between two pages that share a key). They are
 * recorded so the tripwire passes today and the gap stays visible; fixing one
 * means extending the signature and removing it from this list.
 */
const REVIEWED_INPUTS = new Set<string>([
  // Covered by fanoutInputSignature: script src and integrity, stylesheet and
  // icon links (href, rel), meta names and read content, the <main> count, and
  // the <html> lang / xml:lang / aria-hidden and <body> aria-hidden (#614).
  "script[src]",
  "src",
  "integrity",
  "href",
  "rel",
  "content",
  "lang",
  "xml:lang",
  "aria-hidden",
  "meta[name=\"viewport\"]",
  "meta[name='viewport']",
  "meta[name=\"geo.region\"]",
  "meta[name=\"geo.placename\"]",
  "meta[name=\"geo.position\"]",
  "meta[name=\"ICBM\"]",
  "main, [role=\"main\"]",
  // GAP: read but not covered by the signature.
  "head", // GAP: font-delivery reads the head's children
  "class", // GAP: landmark-one-main
  "id", // GAP: landmark-one-main
  "height", // GAP: third-party-cookies (iframe size)
  "width", // GAP: third-party-cookies (iframe size)
  "media", // GAP: font-delivery
  "type", // GAP: legacy-js, unminified-js (script type)
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

function templateReads(): Map<string, string> {
  const reads = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf-8");
    if (!text.includes('verdictScope: "template"')) continue;
    for (const m of text.matchAll(/querySelector(?:All)?\(\s*(["'`])(.*?)\1/g)) {
      reads.set(m[2]!, file);
    }
    for (const m of text.matchAll(/getAttribute\(\s*"([^"]+)"/g)) {
      reads.set(m[1]!, file);
    }
  }
  return reads;
}

describe("template-declared rules read only reviewed inputs (#614)", () => {
  test("every selector and attribute read is in REVIEWED_INPUTS", () => {
    const unreviewed = [...templateReads()].filter(([input]) => !REVIEWED_INPUTS.has(input));
    expect(unreviewed.map(([input, file]) => `${input} in ${file}`)).toEqual([]);
  });

  test("the scan finds the reads it is meant to see", () => {
    const reads = templateReads();
    expect(reads.has("lang")).toBe(true);
    expect(reads.has("aria-hidden")).toBe(true);
    expect(reads.has("href")).toBe(true);
  });
});
