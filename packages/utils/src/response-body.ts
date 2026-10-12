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

function decompressionFormat(coding: Coding, head: Uint8Array): string {
  if (coding === "deflate") return isZlibHeader(head) ? "deflate" : "deflate-raw";
  return coding === "br" ? "brotli" : coding;
}

/**
 * Decode `raw` lazily: a chunk is inflated only when the reader asks for the
 * next one, and cancelling the result cancels `raw`. A failure of `raw`
 * itself (the request aborted at its deadline, the connection dropped) passes
 * through as it is; a failure to decode becomes a ContentDecodingError.
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
  let decoded: ReadableStreamDefaultReader<Uint8Array> | null | undefined;
  const start = async (): Promise<ReadableStreamDefaultReader<Uint8Array> | null> => {
    // Enough of the body to tell zlib from raw deflate.
    const head: Uint8Array[] = [];
    let headBytes = 0;
    while (headBytes < 2) {
      const { done, value } = await readSource();
      if (done) break;
      if (value.byteLength === 0) continue;
      head.push(value);
      headBytes += value.byteLength;
    }
    if (headBytes === 0) return null;
    const opening = Uint8Array.of(head[0]![0]!, head[0]![1] ?? head[1]?.[0] ?? 0);
    const format = decompressionFormat(coding, opening);
    const rest = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const replayed = head.shift();
          if (replayed) {
            controller.enqueue(replayed);
            return;
          }
          const { done, value } = await readSource();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel: (reason) => source.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    const decoder = new DecompressionStream(format as CompressionFormat);
    return rest
      .pipeThrough(decoder as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      .getReader();
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (decoded === undefined) decoded = await start();
          const next = decoded ? await decoded.read() : { done: true as const, value: undefined };
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(
            sourceFailure ? sourceFailure.error : new ContentDecodingError(coding, error),
          );
        }
      },
      cancel: (reason) => (decoded ?? source).cancel(reason),
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
