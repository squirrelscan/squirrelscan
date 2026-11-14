// Shared plumbing for the rules that probe (GraphQL, unauthenticated API): a
// response body read up to a fixed number of DECODED bytes, so a site cannot
// answer a probe with an endless or compression-bomb body (#722).

import { decodedBody } from "@squirrelscan/utils/response-body";

// The per-chunk cap is the guard; `content-length` is not trusted. A stalled
// body is bounded by the request signal, which also aborts `reader.read()`.
// The cap applies to the DECODED body: `decodedBody` undoes the response's
// Content-Encoding lazily, so a compressed answer is inflated no further than
// the cap (#722). A body that does not decode fails the read and so the probe.
export async function readCapped(
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const body = decodedBody(res);
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Release the reader on a cap, an abort or a read error alike. This does
    // not close the connection: the caller aborts the request for that.
    if (!finished) await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}
