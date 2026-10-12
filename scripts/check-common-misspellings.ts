#!/usr/bin/env bun
// Checks packages/rules/src/content/data/common-misspellings-data.ts, the
// hand-written misspelling list behind content/common-misspellings. Run by hand
// after editing the list:
//
//   bun run scripts/check-common-misspellings.ts <wordlist-english dir> <an-array-of-english-words.json>
//
// <wordlist-english dir> is node_modules/wordlist-english from the npm package
// `wordlist-english` (SCOWL word lists, https://github.com/jacksonrayhamilton/wordlist-english).
// <an-array-of-english-words.json> is index.json from the npm package
// `an-array-of-english-words` (https://github.com/words/an-array-of-english-words).
// Neither is a dependency of this repo or shipped: install them in a scratch
// directory. The versions the list was last checked with are in the data README.
//
// Every line must be `misspelling correction`, two lowercase words, sorted by
// misspelling with no duplicates. The correction must be a common English word
// (SCOWL size 60 or below, any of the US, British, Canadian or Australian
// spellings), and the misspelling must be no word at all in either list, so a
// valid spelling in any variant is never reported.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { COMMON_MISSPELLINGS } from "../packages/rules/src/content/data/common-misspellings-data";

const [scowlDir, wordArrayPath] = process.argv.slice(2);
if (!scowlDir || !wordArrayPath) {
  console.error(
    "usage: bun run scripts/check-common-misspellings.ts <wordlist-english dir> <an-array-of-english-words.json>",
  );
  process.exit(2);
}

const PLAIN_WORD = /^[a-z]+$/;
const SCOWL_FILE = /^(american|british|canadian|australian|english)-words-(\d+)\.json$/;

/** SCOWL words at or below `maxSize`, lowercased plain words only. */
function scowl(maxSize: number): Set<string> {
  const words = new Set<string>();
  for (const file of readdirSync(scowlDir!)) {
    const match = SCOWL_FILE.exec(file);
    if (!match || Number(match[2]) > maxSize) continue;
    for (const word of JSON.parse(readFileSync(join(scowlDir!, file), "utf8")) as string[]) {
      const lower = word.toLowerCase();
      if (PLAIN_WORD.test(lower)) words.add(lower);
    }
  }
  return words;
}

const common = scowl(60);
const known = scowl(Number.POSITIVE_INFINITY);
const wordArray = JSON.parse(readFileSync(wordArrayPath, "utf8")) as string[];
for (const word of wordArray) known.add(word.toLowerCase());
// A wrong path or a truncated install would quietly weaken the check, so each
// list has to be about the size it should be (79,627 common SCOWL words and
// 274,937 array words at the versions in the data README).
if (common.size < 50_000 || wordArray.length < 250_000) {
  console.error(
    `word lists look wrong: ${common.size} common SCOWL words, ${wordArray.length} array words`,
  );
  process.exit(2);
}

const problems: string[] = [];
const lines = COMMON_MISSPELLINGS.split("\n").filter((line) => line !== "");
const misspellings = new Set<string>();
let previous = "";
for (const line of lines) {
  const [misspelling = "", correction = "", ...rest] = line.split(" ");
  if (rest.length > 0 || !PLAIN_WORD.test(misspelling) || !PLAIN_WORD.test(correction)) {
    problems.push(`${line}: not two lowercase words`);
    continue;
  }
  if (misspelling <= previous) problems.push(`${line}: not sorted, or a duplicate`);
  previous = misspelling;
  misspellings.add(misspelling);
  if (misspelling === correction) problems.push(`${line}: corrects to itself`);
  if (known.has(misspelling)) problems.push(`${line}: "${misspelling}" is a word`);
  if (!common.has(correction)) problems.push(`${line}: "${correction}" is not a common word`);
}
for (const line of lines) {
  const correction = line.split(" ")[1] ?? "";
  if (misspellings.has(correction)) problems.push(`${line}: the correction is itself listed`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`${problems.length} problem(s) in ${lines.length} entries`);
  process.exit(1);
}
console.log(
  `${lines.length} entries checked: ${common.size} common words, ${known.size} known words`,
);
