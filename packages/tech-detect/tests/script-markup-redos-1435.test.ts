// #1435 review: every pattern in `pageMarkup` (tag ends, the `type` attribute, the data-type list, the flight
// script start) is linear on hostile input. Each shape is built at 5 MB and must finish in seconds; the
// comment-prefix shape is the one a nested-quantifier pattern for the flight start took a second per script on.

import { describe, expect, test } from "bun:test";

import { pageMarkup } from "../src/detect";

const rep = (s: string, bytes: number): string => s.repeat(Math.ceil(bytes / s.length));
const MB5 = 5_000_000;
const LIMIT_MS = 3_000;

const SHAPES: Record<string, string> = {
  "script openers with no `>`": rep("<script", MB5),
  "unbalanced double quotes": rep('<img alt="', MB5),
  "alternating quote kinds": rep("<img alt=\"<img alt='", MB5),
  "a quote then a `>`, repeated": rep("<a x='>", MB5),
  "a very long script type": `<script type="${"a-".repeat(MB5 / 2)}">x</script>`,
  "an unterminated long script type": `<script type="${"a-".repeat(MB5 / 2)}`,
  "hex and dashes before -text/javascript (Rocket Loader)": `<script type="${"0123456789abcdef-".repeat(MB5 / 16)}-text/javascript">x</script>`,
  "type with a run of spaces before the equals sign": `<script type${" ".repeat(MB5)}>x</script>`,
  "many ` type` words in one tag": `<script ${" type".repeat(MB5 / 5)}>x</script>`,
  "many flight openers in one script": `<script>${rep("self.__next_f.push(", MB5)}</script>`,
  "many small flight scripts": rep('<script>self.__next_f.push([1,"x"])</script>', MB5),
  "comment prefixes before the flight start, in many scripts": rep(`<script>${"/* x */ ".repeat(70)}self.__next_f.push(1)</script>`, MB5),
  "one script of comment openers": `<script>${rep("/*", MB5)}self.__next_f.push(1)</script>`,
  "many small scripts": rep("<script>a</script>", MB5),
  "a script that never closes": `<script>${"a".repeat(MB5)}`,
  "runs of `<`": "<".repeat(MB5),
  "a tag then a run of `>`": `<a ${">".repeat(MB5)}`,
};

describe("pageMarkup is linear on hostile input (5 MB)", () => {
  for (const [name, html] of Object.entries(SHAPES)) {
    test(name, () => {
      const started = performance.now();
      const markup = pageMarkup(html);
      const elapsed = performance.now() - started;
      expect(typeof markup).toBe("string");
      expect(elapsed).toBeLessThan(LIMIT_MS);
    }, 60_000);
  }
});
