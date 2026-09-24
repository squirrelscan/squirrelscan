// #370: reading piped input without hanging on a pipe nobody closes.

import { describe, expect, test } from "bun:test";

import { readStreamText } from "@/cli/stdin";

const encoder = new TextEncoder();

/** A stream that emits `chunks`, then either closes or stays open forever. */
function streamOf(
  chunks: string[],
  { close }: { close: boolean }
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
}

describe("readStreamText", () => {
  test("reads to EOF", async () => {
    const result = await readStreamText(
      streamOf(["hello ", "world\n"], { close: true }),
      { maxBytes: 1024, idleMs: 1000 }
    );
    expect(result).toEqual({ text: "hello world\n", timedOut: false });
  });

  test("an open pipe with nothing on it gives up after idleMs", async () => {
    const started = performance.now();
    const result = await readStreamText(streamOf([], { close: false }), {
      maxBytes: 1024,
      idleMs: 50,
    });
    expect(result).toEqual({ text: "", timedOut: true });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("an open pipe keeps what arrived before it went quiet", async () => {
    const result = await readStreamText(
      streamOf(["written but ", "never closed"], { close: false }),
      { maxBytes: 1024, idleMs: 50 }
    );
    expect(result).toEqual({
      text: "written but never closed",
      timedOut: true,
    });
  });

  test("stops once past maxBytes, without waiting for EOF", async () => {
    const result = await readStreamText(
      streamOf(["a".repeat(600), "b".repeat(600), "c".repeat(600)], {
        close: false,
      }),
      { maxBytes: 1000, idleMs: 60_000 }
    );
    expect(result.timedOut).toBe(false);
    expect(result.text).toBe("a".repeat(600) + "b".repeat(600));
  });
});
