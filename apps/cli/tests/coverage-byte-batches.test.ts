// Byte-bounded batching for the template fan-out bench's coverage pass (#1373).

import { createCoverageAccumulator } from "@squirrelscan/audit-engine";
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { byteBatches, htmlBytes, takeByteBatch } from "../scripts/byte-batches";

setDefaultTimeout(30_000);

type P = { url: string; html: string };
const page = (i: number, size: number): P => ({
  url: `https://e.test/${i}`,
  html: "x".repeat(size),
});
const sizeOf = (p: P) => htmlBytes(p.html);
const source = (pages: P[]) => async (offset: number, limit: number) =>
  pages.slice(offset, offset + limit);
async function collect(
  pages: P[],
  cap: number,
  max: number,
  read = 3
): Promise<P[][]> {
  const out: P[][] = [];
  for await (const b of byteBatches(source(pages), sizeOf, cap, max, read))
    out.push(b);
  return out;
}

describe("byte batching", () => {
  const pages = [10, 40, 30, 5, 90, 20, 20, 20, 1, 1, 1].map((s, i) =>
    page(i, s)
  );

  test("a batch never exceeds the byte cap unless it is one oversized page", async () => {
    const batches = await collect(pages, 50, 100);
    for (const b of batches) {
      const total = b.reduce((n, p) => n + sizeOf(p), 0);
      if (b.length > 1) expect(total).toBeLessThanOrEqual(50);
    }
    // the 90-byte page is alone, not skipped
    expect(batches.some((b) => b.length === 1 && sizeOf(b[0]!) === 90)).toBe(
      true
    );
  });

  test("the page ceiling still applies", async () => {
    const batches = await collect(pages, 1_000_000, 4);
    expect(batches.map((b) => b.length)).toEqual([4, 4, 3]);
  });

  test("every page is fed exactly once, in order", async () => {
    for (const [cap, max, read] of [
      [50, 100, 3],
      [1, 100, 2],
      [1_000_000, 3, 25],
      [60, 2, 1],
    ] as const) {
      const flat = (await collect(pages, cap, max, read)).flat();
      expect(flat.map((p) => p.url)).toEqual(pages.map((p) => p.url));
    }
  });

  test("empty source yields nothing; takeByteBatch always takes one page", async () => {
    expect(await collect([], 10, 10)).toEqual([]);
    expect(takeByteBatch([page(0, 100)], sizeOf, 10, 5).batch).toHaveLength(1);
  });

  test("reads at most one read page beyond the byte cap", async () => {
    const big = Array.from({ length: 100 }, (_, i) => page(i, 10));
    let maxHeld = 0;
    let read = 0;
    const src = async (offset: number, limit: number) => {
      const got = big.slice(offset, offset + limit);
      read += got.length;
      return got;
    };
    let fed = 0;
    for await (const b of byteBatches(src, sizeOf, 100, 1000, 5)) {
      fed += b.length;
      maxHeld = Math.max(maxHeld, read - fed + b.length);
    }
    expect(maxHeld).toBeLessThanOrEqual(10 + 5 + 5);
  });
});

describe("streamed coverage equals all-at-once", () => {
  const tpl = (n: number, extra: string) =>
    `<!DOCTYPE html><html lang="en"><head><title>t${n}</title></head><body class="c${n % 3}"><main><h1>h</h1>${extra}</main></body></html>`;
  const pages: P[] = Array.from({ length: 23 }, (_, i) => ({
    url: `https://e.test/p${i}`,
    html: tpl(
      i,
      i % 4 === 0
        ? `<img src="/a${i}.jpg">`
        : i % 5 === 0
          ? "<nav></nav>"
          : "<p>x</p>".repeat(i)
    ),
  }));

  for (const mode of ["current", "derived"] as const) {
    test(`signature ${mode}`, async () => {
      const all = createCoverageAccumulator(mode);
      for (const p of pages) all.add(p);
      for (const [cap, max] of [
        [400, 100],
        [1, 100],
        [100_000, 5],
      ] as const) {
        const acc = createCoverageAccumulator(mode);
        for await (const b of byteBatches(source(pages), sizeOf, cap, max, 4))
          for (const p of b) acc.add(p);
        expect(acc.result()).toEqual(all.result());
      }
    });
  }
});
