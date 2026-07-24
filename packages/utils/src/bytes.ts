// Byte-size measurement for wire payloads (#1275).
//
// JS string `.length` counts UTF-16 CODE UNITS, not the UTF-8 BYTES a string
// occupies on the wire. For non-ASCII content the two diverge: a CJK glyph is 1
// code unit but 3 UTF-8 bytes, an emoji is 2 code units but 4 bytes. So a size
// gate that compares `body.length` against a BYTE budget (publish size limits,
// request body limits) under-counts a multi-byte-heavy body and can let through
// a payload that is actually over the real byte limit.
//
// `Buffer.byteLength` computes the UTF-8 byte count by scanning WITHOUT
// allocating a second copy of the (potentially multi-MB) string — cheaper than
// `new TextEncoder().encode(str).length`, which materializes a full Uint8Array.
//
// Exact for any WELL-FORMED UTF-16 string, which includes every `JSON.stringify`
// output (JSON escapes any unpaired surrogate to an ASCII `\uXXXX` sequence) —
// so it exactly matches the bytes `fetch` puts on the wire for a serialized
// request body, the case the publish size gates measure. The sole divergence is
// a raw string carrying a LONE/unpaired surrogate: Bun's `Buffer.byteLength`
// counts it as 2 bytes where `TextEncoder`/`fetch` emit the 3-byte U+FFFD
// replacement. That can't reach a JSON body gate; pass JSON (or well-formed
// text) for wire-exact counts.

/** UTF-8 byte size of `str` (no allocation). Wire-exact for well-formed strings
 * — including all `JSON.stringify` output. See the module note on lone surrogates. */
export function byteLength(str: string): number {
  return Buffer.byteLength(str, "utf8");
}

// Module-level singletons — encode/decode are stateless (no `{stream:true}`), so
// reuse them across the per-crawl truncateToBytes slow path rather than
// constructing a fresh pair each call.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Truncate `str` so its UTF-8 encoding is at most `maxBytes` bytes, WITHOUT
 * splitting a multi-byte code point (#1293). A `str.slice(0, maxBytes)` cuts by
 * UTF-16 code units, which both over-keeps bytes (a CJK/emoji body slices to up
 * to ~3-4x the intended byte cap) AND can leave a half-written sequence that
 * renders as `�`. This cuts on a real byte budget and backs the cut off any
 * UTF-8 continuation byte, so a code point (incl. a surrogate-pair emoji, which
 * encodes to 4 bytes) is kept whole or dropped whole — the output never carries
 * a partial sequence or a lone surrogate.
 *
 * Fast path (already within budget) returns `str` unchanged with NO allocation;
 * only an over-cap string is encoded (one transient Uint8Array).
 */
export function truncateToBytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(str) <= maxBytes) return str;
  const bytes = utf8Encoder.encode(str);
  // `end` is the first DROPPED byte index (== maxBytes, guaranteed < bytes.length
  // past the fast path). While it points at a UTF-8 continuation byte
  // (0b10xxxxxx) we'd be splitting a sequence — back off to its leading byte.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return utf8Decoder.decode(bytes.subarray(0, end));
}
