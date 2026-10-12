import type { Transform } from "node:stream";
// A namespace import: a runtime whose node:zlib lacks a decoder (zstd is the
// newest) still loads this module, and that coding fails to decode instead.
import * as zlib from "node:zlib";

import { truncateToBytes } from "./bytes";

/** Default cap for small probe responses. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/** Default cap for crawled documents after content decoding. */
export const DEFAULT_MAX_DOCUMENT_BODY_BYTES = 10 * 1024 * 1024;

/**
 * What Bun's fetch asks for when it decodes bodies itself. With `decompress:
 * false` it asks for nothing, and an origin would then answer uncompressed,
 * changing what the compression rules see, so fetchUndecoded sends it instead.
 */
export const ACCEPT_ENCODING = "gzip, deflate, br, zstd";

/**
 * Whether this runtime's fetch hands back the raw bytes when asked to
 * (`decompress: false`). Bun does, and it runs every crawl (the CLI and the
 * cloud containers). Elsewhere fetch has already decoded the body and its
 * Content-Encoding header is history, not an instruction.
 */
const FETCH_RETURNS_RAW_BODY = "Bun" in globalThis;

type Coding = "gzip" | "deflate" | "br" | "zstd";

/**
 * The codings Bun's own decoding undoes, plus the `x-gzip` alias. Anything
 * else, stacked codings included, is passed through as it arrived, which is
 * what Bun does with them too.
 */
const CODINGS = new Map<string, Coding>([
  ["gzip", "gzip"],
  ["x-gzip", "gzip"],
  ["deflate", "deflate"],
  ["br", "br"],
  ["zstd", "zstd"],
]);

/** Responses from fetchUndecoded whose body still carries its Content-Encoding. */
const stillEncoded = new WeakMap<Response, Coding>();

/**
 * A body whose Content-Encoding does not decode: corrupt, truncated, or not
 * encoded the way the header says.
 */
export class ContentDecodingError extends Error {
  override readonly name = "ContentDecodingError";

  constructor(coding: string, cause: unknown) {
    const code = (cause as { code?: unknown } | null)?.code;
    const detail =
      typeof code === "string" ? code : (cause as Error | null)?.message || "corrupt data";
    super(`${coding} body does not decode (${detail})`, { cause });
  }
}

/**
 * A body that could not be decoded, by our own decoding (ContentDecodingError)
 * or by the runtime's, which Bun reports as "BrotliDecompressionError" /
 * "ZlibError" with no stable code, so the message is what is matched.
 */
export function isDecompressionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ContentDecodingError" ||
      error.message.includes("DecompressionError") ||
      error.message.includes("ZlibError"))
  );
}

/**
 * `fetch` with the runtime's own body decoding turned off (#2717).
 *
 * Bun's fetch inflates a `Content-Encoding` body in full the moment it
 * arrives, ahead of any reader and whether or not the body is read: a 1 MB
 * gzip body that inflates to 1 GiB cost 1.8 to 2.9 GB of RSS whether it was
 * read under a cap, cancelled unread or never touched, so no byte cap on the
 * reader bounded it. Fetched raw, the body is decoded by `decodedBody` (and so
 * `readBodyCapped`) only as far as the reader pulls, which keeps a compression
 * bomb inside the cap.
 *
 * Passes `decompress: false` on THIS request; a caller that follows redirects
 * by hand must send every hop through here, while `redirect: "follow"` carries
 * it to each hop itself. The request is otherwise what fetch would have sent,
 * Accept-Encoding included.
 *
 * Read the body only through `decodedBody` or `readBodyCapped`. Anything else
 * (`.text()`, `.json()`, `.arrayBuffer()`, a reader on `.body`, a `clone()`)
 * gets the bytes still encoded, with no error to say so.
 */
export async function fetchUndecoded(input: string, init: RequestInit = {}): Promise<Response> {
  if (!FETCH_RETURNS_RAW_BODY) return fetch(input, init);
  const headers = new Headers(init.headers);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", ACCEPT_ENCODING);
  const response = await fetch(input, { ...init, headers, decompress: false } as RequestInit);
  const coding = CODINGS.get(response.headers.get("content-encoding")?.trim().toLowerCase() ?? "");
  if (coding) stillEncoded.set(response, coding);
  return response;
}

/**
 * The two bytes open a zlib stream (RFC 1950), which is what HTTP's `deflate`
 * means, as opposed to the raw deflate some servers send under that name.
 */
function isZlibHeader(bytes: Uint8Array): boolean {
  const cmf = bytes[0] ?? 0;
  const flg = bytes[1] ?? 0;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
}

/** A gzip header longer than this (a runaway file name or comment) is not read. */
const MAX_GZIP_HEADER_BYTES = 128 * 1024;

/**
 * Where the deflate data starts in a gzip member (RFC 1952), `null` while
 * `head` is too short to say, or `-1` when it is not a gzip header.
 */
function gzipDataOffset(head: Uint8Array): number | null {
  if (head.byteLength < 10) return head.byteLength >= 1 && head[0] !== 0x1f ? -1 : null;
  if (head[0] !== 0x1f || head[1] !== 0x8b || head[2] !== 8) return -1;
  const flags = head[3]!;
  if (flags & 0xe0) return -1;
  let at = 10;
  if (flags & 0x04) {
    if (head.byteLength < at + 2) return null;
    at += 2 + (head[at]! | (head[at + 1]! << 8));
  }
  for (const flag of [0x08, 0x10]) {
    if (!(flags & flag)) continue;
    const nul = head.indexOf(0, at);
    if (nul === -1) return head.byteLength > MAX_GZIP_HEADER_BYTES ? -1 : null;
    at = nul + 1;
  }
  if (flags & 0x02) at += 2;
  if (at > MAX_GZIP_HEADER_BYTES) return -1;
  return head.byteLength >= at ? at : null;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a);
  joined.set(b, a.byteLength);
  return joined;
}

/**
 * The decoder for `coding`, given the bytes that open its data. gzip is read
 * past its header as raw deflate, so it ends where the first member's data
 * ends: bytes after it (the trailer, padding, junk a server appended, a second
 * member) are ignored, as a browser does. Every node:zlib decoder already
 * ignores trailing bytes once its stream is complete, where Bun's
 * DecompressionStream rejects them and drops the output still buffered.
 */
function createDecoder(coding: Coding, opening: Uint8Array): Transform {
  switch (coding) {
    case "gzip":
      return zlib.createInflateRaw();
    case "deflate":
      return isZlibHeader(opening) ? zlib.createInflate() : zlib.createInflateRaw();
    case "br":
      return zlib.createBrotliDecompress();
    case "zstd":
      return zlib.createZstdDecompress();
  }
}

/**
 * Decode `raw` lazily: input goes to the decoder only once its last chunk has
 * been decoded and read, and node:zlib stops decoding while its output is
 * unread, so nothing is inflated ahead of the reader. Cancelling the result
 * cancels `raw`. A failure of `raw` itself (the request aborted at its
 * deadline, the connection dropped) passes through as it is; a failure to
 * decode becomes a ContentDecodingError.
 */
function decodingStream(
  raw: ReadableStream<Uint8Array>,
  coding: Coding,
): ReadableStream<Uint8Array> {
  const source = raw.getReader();
  let sourceFailure: { error: unknown } | null = null;
  const readSource = async () => {
    try {
      return await source.read();
    } catch (error) {
      sourceFailure = { error };
      throw error;
    }
  };

  // Undefined until the first read. Null for an empty body, which has nothing
  // to decode: Bun's own decoding reads it as "", where a decoder would call
  // it truncated.
  let decoder: Transform | null | undefined;
  let decodeFailure: { error: unknown } | null = null;
  let finished = false;
  let writing = false;
  let inputDone = false;
  let pending: Uint8Array | null = null;
  let cancelled = false;
  let wake: (() => void) | null = null;
  const signal = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const start = async (): Promise<Transform | null> => {
    // Enough of the body to tell zlib from raw deflate, or to step over a
    // gzip header.
    let head: Uint8Array = new Uint8Array(0);
    let dataAt: number | null = null;
    while (dataAt === null) {
      const { done, value } = await readSource();
      if (done) {
        if (head.byteLength === 0) return null;
        // The body ended inside its opening: a cut-short gzip header is no
        // header, and any other decoder reports the body truncated.
        dataAt = coding === "gzip" ? -1 : 0;
        break;
      }
      head = concatBytes(head, value);
      if (coding === "gzip") dataAt = gzipDataOffset(head);
      else if (head.byteLength >= 2) dataAt = 0;
    }
    if (dataAt === -1) throw new Error("no gzip header");
    pending = head.subarray(dataAt);
    const created = createDecoder(coding, head);
    created.on("readable", signal);
    created.on("end", () => {
      finished = true;
      signal();
    });
    created.on("error", (error) => {
      decodeFailure ??= { error };
      signal();
    });
    return created;
  };

  // Hands the decoder its next input. False when there was none to hand over
  // (an empty chunk), so the caller must not wait on the decoder for it: Bun
  // 1.3 never calls back a zero-length write.
  const feed = async (into: Transform): Promise<boolean> => {
    let chunk = pending;
    pending = null;
    if (!chunk) {
      const next = await readSource();
      if (next.done) {
        inputDone = true;
        into.end();
        return true;
      }
      chunk = next.value;
    }
    if (chunk.byteLength === 0) return false;
    writing = true;
    into.write(chunk, () => {
      writing = false;
      signal();
    });
    return true;
  };

  const stop = (reason?: unknown): Promise<void> => {
    cancelled = true;
    decoder?.destroy();
    return source.cancel(reason).catch(() => {});
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (decoder === undefined) {
            decoder = await start();
            // Cancelled while the opening was read: nothing will read this one.
            if (cancelled) return void decoder?.destroy();
          }
          if (decoder === null) return controller.close();
          for (;;) {
            const out = decoder.read() as Uint8Array | null;
            if (out) return controller.enqueue(out);
            if (decodeFailure) throw new ContentDecodingError(coding, decodeFailure.error);
            if (finished) {
              // Complete: whatever else the body holds is not read.
              controller.close();
              await stop();
              return;
            }
            const progress = new Promise<void>((resolve) => {
              wake = resolve;
            });
            if (!writing && !inputDone && !(await feed(decoder))) continue;
            await progress;
          }
        } catch (error) {
          await stop();
          controller.error(
            sourceFailure
              ? sourceFailure.error
              : error instanceof ContentDecodingError
                ? error
                : new ContentDecodingError(coding, error),
          );
        }
      },
      cancel: stop,
    },
    { highWaterMark: 0 },
  );
}

/**
 * The body as the origin meant it: decoded, when fetchUndecoded left a
 * Content-Encoding on it, and decoded only as far as it is read. Every other
 * response's body is returned as it is.
 */
export function decodedBody(res: Response): ReadableStream<Uint8Array> | null {
  const coding = stillEncoded.get(res);
  return coding && res.body ? decodingStream(res.body, coding) : res.body;
}

/**
 * Read at most `maxBytes` from a response body and cancel the stream at the
 * limit. Retained chunks are copy-trimmed so oversized backing buffers cannot
 * remain pinned in memory. The cap applies to the DECODED body, and a body
 * from fetchUndecoded is inflated no further than the cap (#2717).
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const stream = decodedBody(res);
  if (!stream || typeof stream.getReader !== "function") {
    // No stream to meter (some runtimes and mocks): a partial read is not
    // possible, so refuse bodies that declare themselves over the cap before
    // buffering anything, and slice the rest by BYTES — String#slice counts
    // UTF-16 code units, which can retain up to 2x maxBytes of multibyte text.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return "";
    return truncateToBytes(await res.text(), maxBytes);
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
