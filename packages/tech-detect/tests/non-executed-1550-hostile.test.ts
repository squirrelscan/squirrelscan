// #1550: the structural pass that takes out inert regions stays in budget on hostile pages, at 5 MB and 10 MiB.

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { detectTechnologies } from "../src";

setDefaultTimeout(120_000);

const YOUTUBE = '<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>';

describe("hostile pages stay in budget, at 5 MB and 10 MiB", () => {
  const MB5 = 5_000_000;
  const MIB10 = 10 * 1_048_576;
  const time = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const fill = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));
  const cases: Array<[string, (n: number) => string]> = [
    ["comments", (n) => fill("<!-- a -->", n)],
    ["unclosed comment openers", (n) => fill("<!--", n)],
    ["templates", (n) => fill("<template><b>x</b></template>", n)],
    ["unclosed templates", (n) => fill("<template>", n)],
    ["nested templates", (n) => fill("<template>", n / 2) + fill("</template>", n / 2)],
    ["data scripts", (n) => fill('<script type="application/json">{"a":1}</script>', n)],
    ["one huge data script", (n) => `<script type="application/json">${"x".repeat(n)}</script>`],
    ["script openers", (n) => fill("<script>", n)],
    ["tags with a quote", (n) => fill('<a "', n)],
    ["angle brackets", (n) => fill("<", n)],
    ["real tags between comments and templates", (n) => fill(`<!-- c --><template>t</template>${YOUTUBE}`, n)],
  ];
  for (const [label, bytes] of [["5 MB", MB5], ["10 MiB", MIB10]] as const) {
    for (const [name, build] of cases) {
      test(`${label}: ${name}`, () => {
        const html = build(bytes);
        const elapsed = time(() => detectTechnologies({ url: "https://example.com/", headers: {}, html }));
        console.log(`TIMING ${label} ${name}: ${elapsed.toFixed(0)} ms`);
        expect(elapsed).toBeLessThan(20_000);
      });
    }
  }
});
