// Byte-bounded batching for the template fan-out bench's coverage pass (#1373).
// Kept out of `template-fanout-bench.ts` because that file parses argv and may
// `process.exit` at module load, so it cannot be imported by a test.

/** Default byte cap for one coverage batch: about 256 MB of HTML. */
export const DEFAULT_BATCH_BYTES = 256 * 1024 * 1024;

/** Page count of each read from storage; bounds the overshoot past the byte cap. */
export const READ_PAGE_SIZE = 25;

/** UTF-8 byte length of a page's HTML (0 when there is none). */
export function htmlBytes(html: string | null | undefined): number {
  return html ? Buffer.byteLength(html) : 0;
}

/**
 * Take the next batch from the front of `pages`: stop before the page that would
 * push the total past `capBytes` or the count past `maxPages`. A first page bigger
 * than the cap is its own batch, so no page is ever skipped. Always takes at least
 * one page when any remain.
 */
export function takeByteBatch<T>(
  pages: readonly T[],
  sizeOf: (page: T) => number,
  capBytes: number,
  maxPages: number
): { batch: T[]; rest: T[] } {
  let bytes = 0;
  let n = 0;
  while (n < pages.length && n < maxPages) {
    const size = sizeOf(pages[n]!);
    if (n > 0 && bytes + size > capBytes) break;
    bytes += size;
    n++;
  }
  return { batch: pages.slice(0, n), rest: pages.slice(n) };
}

/**
 * Yield batches from a count-paged source. Reads `readSize` pages at a time and
 * fills each batch from them, so at most one read page is held beyond the cap.
 * Every page is yielded exactly once, in source order.
 */
export async function* byteBatches<T>(
  readPage: (offset: number, limit: number) => Promise<T[]>,
  sizeOf: (page: T) => number,
  capBytes: number,
  maxPages: number,
  readSize: number = READ_PAGE_SIZE
): AsyncGenerator<T[]> {
  let offset = 0;
  let carry: T[] = [];
  let exhausted = false;
  for (;;) {
    // Read until the carry alone can decide the batch is full, or the source ends.
    for (;;) {
      if (exhausted) break;
      const { batch, rest } = takeByteBatch(carry, sizeOf, capBytes, maxPages);
      if (rest.length > 0 && batch.length > 0) break; // batch closed inside carry
      const page = await readPage(offset, readSize);
      offset += readSize;
      if (page.length === 0) exhausted = true;
      carry = carry.concat(page);
    }
    if (carry.length === 0) return;
    const { batch, rest } = takeByteBatch(carry, sizeOf, capBytes, maxPages);
    carry = rest;
    yield batch;
  }
}
