// Shared by cloaking-probe.ts and soft404-confirm.ts (#1201): both probe
// fetches previously did `(await res.text()).slice(0, MAX_BODY_BYTES)`, which
// buffers the ENTIRE response in memory before the cap is applied — a
// multi-hundred-MB response gets fully read regardless of the cap. This reads
// the body stream chunk-by-chunk and stops (cancelling the reader) once
// `maxBytes` is reached, so memory and network reads are bounded by the cap
// rather than by the response size.

/** Default body-read cap shared by both probe fetch helpers. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/**
 * Read a fetch `Response` body up to `maxBytes`, decoding what was read as
 * UTF-8. Stops pulling further chunks once the cap is reached and cancels the
 * underlying reader, rather than draining the whole stream first.
 *
 * Falls back to `res.text()` when the runtime doesn't expose a readable body
 * stream (e.g. a body-less response) — that path is already small/empty so
 * buffering it fully is harmless.
 *
 * Truncation can land mid-codepoint at the byte cap; callers here only
 * pattern-match the text so a trailing replacement character is fine.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const stream = res.body;
  if (!stream || typeof stream.getReader !== "function") {
    return (await res.text()).slice(0, maxBytes);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      // A single read() can hand back a chunk far bigger than the cap (e.g. a
      // decompression transform batching a whole block into one chunk). Copy
      // (not subarray) the needed prefix so the oversized backing buffer is
      // NOT kept alive by our retained reference — subarray would still pin
      // the whole underlying ArrayBuffer even though only a slice is visible.
      // Dispatch through the base TypedArray slice explicitly rather than
      // `value.slice(...)`: some Uint8Array subclasses (e.g. Node/Bun
      // `Buffer`) override `.slice()` to return a zero-copy view instead of a
      // copy, which would silently defeat the cap.
      const piece =
        value.byteLength > remaining ? Uint8Array.prototype.slice.call(value, 0, remaining) : value;
      chunks.push(piece);
      total += piece.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed/errored — nothing to cancel */
    }
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}
