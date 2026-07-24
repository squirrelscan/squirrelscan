/** Default cap for small probe responses. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/** Default cap for crawled documents after content decoding. */
export const DEFAULT_MAX_DOCUMENT_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read at most `maxBytes` from a response body and cancel the stream at the
 * limit. Retained chunks are copy-trimmed so oversized backing buffers cannot
 * remain pinned in memory.
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
      const piece =
        value.byteLength > remaining
          ? Uint8Array.prototype.slice.call(value, 0, remaining)
          : value;
      chunks.push(piece);
      total += piece.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
