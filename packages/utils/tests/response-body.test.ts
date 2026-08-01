// readBodyCapped must bound what it PULLS, not just what it returns: a
// decompressed (gzip/chunked) stream can be orders of magnitude larger than
// the declared content-length, and the no-stream fallback must not buffer or
// retain more than the cap either.
import { describe, expect, test } from "bun:test";

import { byteLength } from "../src/bytes";
import { readBodyCapped } from "../src/response-body";

/** A stream of `chunkCount` chunks of `chunkSize` bytes that records how many
 * bytes were actually pulled off it. */
function countingStream(
  chunkCount: number,
  chunkSize: number,
): { stream: ReadableStream<Uint8Array>; bytesPulled: () => number } {
  let pulled = 0;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunkCount) {
        controller.close();
        return;
      }
      i++;
      const chunk = new Uint8Array(chunkSize).fill(0x61);
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { stream, bytesPulled: () => pulled };
}

function responseFromStream(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Response {
  return new Response(stream, { headers });
}

describe("readBodyCapped (streamed)", () => {
  test("stops pulling at the cap on an oversized body (robots.txt bomb shape)", async () => {
    const total = 64 * 1024;
    const cap = 8 * 1024;
    const { stream, bytesPulled } = countingStream(total / 1024, 1024);
    const out = await readBodyCapped(responseFromStream(stream), cap);
    expect(byteLength(out)).toBe(cap);
    // At most one chunk of overshoot past the cap; nowhere near the full body.
    expect(bytesPulled()).toBeLessThanOrEqual(cap + 1024);
  });

  test("caps decoded bytes even when content-length declares far less (gzip bomb shape)", async () => {
    // content-length describes the wire (compressed) size; res.body yields
    // decoded bytes. Declare 512 bytes, stream 4 MiB.
    const cap = 16 * 1024;
    const { stream, bytesPulled } = countingStream(4096, 1024);
    const res = responseFromStream(stream, { "content-length": "512" });
    const out = await readBodyCapped(res, cap);
    expect(byteLength(out)).toBe(cap);
    expect(bytesPulled()).toBeLessThanOrEqual(cap + 1024);
  });

  test("returns short bodies whole", async () => {
    const { stream } = countingStream(2, 100);
    const out = await readBodyCapped(responseFromStream(stream), 1024);
    expect(byteLength(out)).toBe(200);
  });
});

describe("readBodyCapped (no-stream fallback)", () => {
  function fakeResponse(text: string, headers: Record<string, string>): {
    res: Response;
    textCalls: () => number;
  } {
    let calls = 0;
    const res = {
      body: null,
      headers: new Headers(headers),
      text: async () => {
        calls++;
        return text;
      },
    } as unknown as Response;
    return { res, textCalls: () => calls };
  }

  test("refuses a body whose declared content-length exceeds the cap without buffering it", async () => {
    const { res, textCalls } = fakeResponse("x".repeat(1000), { "content-length": "1000" });
    const out = await readBodyCapped(res, 100);
    expect(out).toBe("");
    expect(textCalls()).toBe(0);
  });

  test("slices an undeclared body by bytes, not UTF-16 code units", async () => {
    // "€" is 3 bytes in UTF-8 but 1 code unit: a .slice(0, cap) would keep
    // cap code units = 3x cap bytes.
    const { res } = fakeResponse("€".repeat(100), {});
    const out = await readBodyCapped(res, 30);
    expect(byteLength(out)).toBeLessThanOrEqual(30);
    expect(out).toBe("€".repeat(10));
  });

  test("returns a small declared body whole", async () => {
    const { res } = fakeResponse("hello", { "content-length": "5" });
    expect(await readBodyCapped(res, 100)).toBe("hello");
  });
});
