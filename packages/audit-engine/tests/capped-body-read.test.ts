// Shared streamed body reader (#1201) — both cloaking-probe.ts and
// soft404-confirm.ts previously did `(await res.text()).slice(0, MAX)`, fully
// buffering the response before the cap applied. readBodyCapped streams and
// stops pulling chunks once the cap is hit; these tests assert that with an
// instrumented ReadableStream that counts every byte actually pulled off it.

import { describe, expect, test } from "bun:test";

import { readBodyCapped } from "../src/lib/capped-body-read";

/** A ReadableStream of `chunkCount` chunks of `chunkSize` bytes each, all the
 * byte value `fill`, that records how many bytes were actually pulled. */
function countingStream(
  chunkCount: number,
  chunkSize: number,
  fill: number,
): { stream: ReadableStream<Uint8Array>; bytesPulled: () => number } {
  let pulled = 0;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunkCount) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(chunkSize).fill(fill);
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
      i++;
    },
  });
  return { stream, bytesPulled: () => pulled };
}

function responseFromStream(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream);
}

/** Temporarily spy on a prototype method, recording every call's args, then
 * restore the original — for asserting which slice implementation actually
 * ran without permanently mutating a shared global prototype. */
function spyOnMethod<T extends object, K extends keyof T>(
  proto: T,
  method: K,
): { calls: unknown[][]; restore: () => void } {
  const original = proto[method] as unknown as (...args: unknown[]) => unknown;
  const calls: unknown[][] = [];
  (proto[method] as unknown) = function (this: unknown, ...args: unknown[]) {
    calls.push(args);
    return original.apply(this, args);
  };
  return { calls, restore: () => ((proto[method] as unknown) = original) };
}

describe("readBodyCapped", () => {
  test("reads the full body unchanged when under the cap", async () => {
    const text = "hello world, this is a small body";
    const res = new Response(text);
    const body = await readBodyCapped(res, 1_000_000);
    expect(body).toBe(text);
  });

  test("reads an exactly-at-cap body in full", async () => {
    const { stream, bytesPulled } = countingStream(10, 100, 0x61 /* 'a' */);
    const res = responseFromStream(stream);
    const body = await readBodyCapped(res, 1000);
    expect(body).toBe("a".repeat(1000));
    expect(bytesPulled()).toBe(1000);
  });

  test("truncates an oversized body at the cap without fully buffering", async () => {
    const CAP = 1000;
    const CHUNK_SIZE = 100;
    const TOTAL_CHUNKS = 100_000; // 10MB if fully drained — must not happen
    const { stream, bytesPulled } = countingStream(TOTAL_CHUNKS, CHUNK_SIZE, 0x62 /* 'b' */);
    const res = responseFromStream(stream);

    const body = await readBodyCapped(res, CAP);

    expect(body).toBe("b".repeat(CAP));
    expect(body.length).toBe(CAP);
    // Only a handful of chunks near the cap should have been pulled — nowhere
    // near the full 10MB stream. Bounds it well under 1% of the full size.
    expect(bytesPulled()).toBeLessThan(CAP * 2);
    expect(bytesPulled()).toBeLessThan(CHUNK_SIZE * TOTAL_CHUNKS);
  });

  test("cancels the reader once the cap is reached (stops pulling more chunks)", async () => {
    let cancelled = false;
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        controller.enqueue(new Uint8Array(200).fill(0x63));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = responseFromStream(stream);

    const body = await readBodyCapped(res, 500);

    expect(body.length).toBe(500);
    expect(cancelled).toBe(true);
    // 500 bytes at 200/chunk needs 3 pulls (200, 200, 200 -> total 600 >= 500
    // stops); should not keep pulling toward some huge/unbounded count.
    expect(pullCount).toBeLessThanOrEqual(5);
  });

  test("handles a body-less response by falling back safely", async () => {
    const res = new Response(null, { status: 204 });
    const body = await readBodyCapped(res, 1000);
    expect(body).toBe("");
  });

  test("caps by raw bytes, not decoded length, and doesn't throw mid-codepoint", async () => {
    // The old `res.text().slice(0, MAX)` capped by UTF-16 code units of the
    // ALREADY-DECODED string; readBodyCapped caps by raw bytes pre-decode, so
    // for multi-byte text these differ. Confirm the byte-cap boundary landing
    // inside a 4-byte codepoint (😀 = F0 9F 98 80) decodes cleanly rather than
    // throwing, degrading to a trailing replacement character.
    const emoji = "\u{1F600}"; // 😀, 4 bytes in UTF-8, 2 UTF-16 code units
    const bytes = new TextEncoder().encode(emoji.repeat(10)); // 40 bytes total
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const res = responseFromStream(stream);

    // 5 whole emoji (20 bytes) + 2 bytes into the 6th's 4-byte sequence.
    const CAP = 4 * 5 + 2;
    const body = await readBodyCapped(res, CAP);

    expect(body.startsWith(emoji.repeat(5))).toBe(true);
    // The dangling partial codepoint decodes to the replacement character
    // instead of throwing or silently dropping.
    expect(body.endsWith("�")).toBe(true);
    expect(body.length).toBe(emoji.repeat(5).length + 1);
  });

  test("a single oversized chunk (one read() call) is copy-trimmed to the cap, not retained at full size", async () => {
    // Regression for a real finding: a decompression transform can hand back
    // one enormous chunk from a single read(). Pushing that chunk reference
    // as-is (or even `.subarray()`-ing it) keeps the WHOLE backing buffer
    // alive; only a copy of just the needed prefix actually bounds retained
    // memory to the cap. Spy on the base TypedArray slice (what the fix
    // dispatches through) to prove it's called with exactly the cap size.
    const spy = spyOnMethod(Uint8Array.prototype, "slice");
    try {
      const CAP = 1000;
      const GIANT = CAP * 10; // 10x the cap delivered in a single enqueue.
      let pullCount = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount++;
          // Deliberately never closes on its own — proves the loop stops
          // (and cancels) because it hit the cap, not because the source ran
          // dry.
          controller.enqueue(new Uint8Array(GIANT).fill(0x7a /* 'z' */));
        },
        cancel() {
          cancelled = true;
        },
      });
      const res = responseFromStream(stream);

      const body = await readBodyCapped(res, CAP);

      expect(body).toBe("z".repeat(CAP));
      expect(pullCount).toBe(1);
      expect(cancelled).toBe(true);
      // The retained bytes for this chunk were copy-trimmed to exactly the
      // cap — not kept at the full 10x size the stream handed back.
      expect(spy.calls).toEqual([[0, CAP]]);
    } finally {
      spy.restore();
    }
  });

  test("does not dispatch through a chunk's own overridden .slice() (e.g. Buffer)", async () => {
    // Node/Bun Buffer extends Uint8Array but overrides .slice() to return a
    // zero-copy VIEW of the same backing memory, not a copy — exactly the
    // footgun the fix must avoid. Spy on Buffer.prototype.slice (restored
    // after) to prove readBodyCapped never calls the overridden version, i.e.
    // it truly dispatches through the base TypedArray slice regardless of
    // what class the chunk happens to be.
    const spy = spyOnMethod(Buffer.prototype, "slice");
    try {
      const CAP = 1000;
      const GIANT = CAP * 10;
      const chunk = Buffer.alloc(GIANT, 0x79 /* 'y' */);
      let pullCount = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount++;
          controller.enqueue(chunk);
        },
      });
      const res = responseFromStream(stream);

      const body = await readBodyCapped(res, CAP);

      expect(body).toBe("y".repeat(CAP));
      expect(pullCount).toBe(1);
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
    }
  });
});
