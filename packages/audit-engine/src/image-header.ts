// Natural pixel dimensions from the first bytes of an image file (#470).
//
// images/responsive-size compares an image's natural pixel area with its
// displayed box, the way Lighthouse's uses-responsive-images does, and the
// resource check reads only the first RESOURCE_SIZE_LIMITS.IMAGE_HEADER_BYTES
// of each image. PNG, GIF, WebP and AVIF keep their dimensions within the
// first few hundred bytes. JPEG is the exception: its SOF segment follows the
// APPn segments, so a large EXIF or ICC block can push it past what was read,
// and that returns null rather than a guess.
//
// The bytes are whatever a server sent, so the parser is total: every read is
// bounds-checked, every loop advances, and truncated or malformed input
// returns null (or `animated: null`) instead of throwing.

export type ImageHeaderFormat = "png" | "gif" | "webp" | "avif" | "jpeg";

export interface ImageHeaderInfo {
  format: ImageHeaderFormat;
  width: number;
  height: number;
  /**
   * APNG, animated GIF, animated WebP or an AVIF image sequence. Null when the
   * bytes read do not settle it: a GIF cut off inside its first frame, or a PNG
   * cut off before its first IDAT.
   */
  animated: boolean | null;
}

// ============================================
// Bounds-checked readers: -1 (or "") past the end, never a throw.
// ============================================

function u8(b: Uint8Array, i: number): number {
  return i >= 0 && i < b.length ? b[i]! : -1;
}

function u16be(b: Uint8Array, i: number): number {
  return i >= 0 && i + 2 <= b.length ? (b[i]! << 8) | b[i + 1]! : -1;
}

function u16le(b: Uint8Array, i: number): number {
  return i >= 0 && i + 2 <= b.length ? b[i]! | (b[i + 1]! << 8) : -1;
}

function u24le(b: Uint8Array, i: number): number {
  return i >= 0 && i + 3 <= b.length ? b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) : -1;
}

function u32be(b: Uint8Array, i: number): number {
  return i >= 0 && i + 4 <= b.length
    ? b[i]! * 0x1000000 + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!)
    : -1;
}

function ascii(b: Uint8Array, i: number, n: number): string {
  if (i < 0 || i + n > b.length) return "";
  let s = "";
  for (let k = i; k < i + n; k++) s += String.fromCharCode(b[k]!);
  return s;
}

function info(
  format: ImageHeaderFormat,
  width: number,
  height: number,
  animated: boolean | null
): ImageHeaderInfo | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { format, width, height, animated };
}

// ============================================
// PNG: IHDR is the first chunk; an APNG declares acTL before its first IDAT.
// ============================================

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function parsePng(b: Uint8Array): ImageHeaderInfo | null {
  if (ascii(b, 12, 4) !== "IHDR") return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  // The PNG spec caps both at 2^31 - 1.
  if (width > 0x7fffffff || height > 0x7fffffff) return null;

  let animated: boolean | null = null;
  let offset = 8;
  for (;;) {
    const length = u32be(b, offset);
    const type = ascii(b, offset + 4, 4);
    if (length < 0 || type === "") break;
    if (type === "acTL") {
      const frames = u32be(b, offset + 8);
      animated = frames < 0 ? null : frames > 1;
      break;
    }
    if (type === "IDAT") {
      animated = false;
      break;
    }
    // length + type + data + CRC: always at least 12 bytes forward.
    offset += 12 + length;
  }
  return info("png", width, height, animated);
}

// ============================================
// GIF: the logical screen size, then frames counted up to a second one.
// ============================================

/** Offset past a run of data sub-blocks and its terminator, or -1 if cut off. */
function skipSubBlocks(b: Uint8Array, start: number): number {
  let offset = start;
  for (;;) {
    const size = u8(b, offset);
    if (size < 0) return -1;
    offset += 1 + size;
    if (size === 0) return offset;
  }
}

function parseGif(b: Uint8Array): ImageHeaderInfo | null {
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  const screen = u8(b, 10);
  if (screen < 0) return info("gif", width, height, null);

  let offset = 13;
  if (screen & 0x80) offset += 3 * (1 << ((screen & 0x07) + 1));

  let frames = 0;
  let animated: boolean | null = null;
  for (;;) {
    const block = u8(b, offset);
    if (block === 0x3b) {
      animated = frames > 1;
      break;
    }
    if (block === 0x21) {
      // Extension: introducer, label, data sub-blocks.
      offset = skipSubBlocks(b, offset + 2);
      if (offset < 0) break;
      continue;
    }
    if (block === 0x2c) {
      frames++;
      if (frames > 1) {
        animated = true;
        break;
      }
      const packed = u8(b, offset + 9);
      if (packed < 0) break;
      offset += 10;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
      // LZW minimum code size, then the image data sub-blocks.
      offset = skipSubBlocks(b, offset + 1);
      if (offset < 0) break;
      continue;
    }
    // Cut off (-1) or not a GIF block: the frame count is not settled.
    break;
  }
  return info("gif", width, height, animated);
}

// ============================================
// WebP: RIFF container, then a VP8 (lossy), VP8L (lossless) or VP8X
// (extended, which carries the animation flag) chunk.
// ============================================

function parseWebp(b: Uint8Array): ImageHeaderInfo | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // 3-byte frame tag, then the 9d 01 2a start code, then 14-bit sizes.
    if (u8(b, 23) !== 0x9d || u8(b, 24) !== 0x01 || u8(b, 25) !== 0x2a) return null;
    const width = u16le(b, 26);
    const height = u16le(b, 28);
    if (width < 0 || height < 0) return null;
    return info("webp", width & 0x3fff, height & 0x3fff, false);
  }
  if (chunk === "VP8L") {
    if (u8(b, 20) !== 0x2f) return null;
    const b1 = u8(b, 21);
    const b2 = u8(b, 22);
    const b3 = u8(b, 23);
    const b4 = u8(b, 24);
    if (b1 < 0 || b2 < 0 || b3 < 0 || b4 < 0) return null;
    // 14 bits of width - 1, then 14 bits of height - 1, least significant first.
    const width = 1 + (b1 | ((b2 & 0x3f) << 8));
    const height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    return info("webp", width, height, false);
  }
  if (chunk === "VP8X") {
    const flags = u8(b, 20);
    const width = u24le(b, 24);
    const height = u24le(b, 27);
    if (flags < 0 || width < 0 || height < 0) return null;
    // The canvas size is stored minus one; bit 1 of the flags is animation.
    return info("webp", width + 1, height + 1, (flags & 0x02) !== 0);
  }
  return null;
}

// ============================================
// AVIF: ISO BMFF boxes. A still image's size is the `ispe` property of its
// primary item; a sequence (brand `avis`) may carry only a track header.
// ============================================

interface Box {
  type: string;
  /** First byte of the box's payload. */
  body: number;
  /** One past the payload's last byte, clamped to what was read. */
  end: number;
}

/** The boxes laid end to end in [start, end). Stops at the first malformed one. */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const limit = Math.min(end, b.length);
  const out: Box[] = [];
  let offset = start;
  while (offset >= 0 && offset + 8 <= limit) {
    let size = u32be(b, offset);
    const type = ascii(b, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      const high = u32be(b, offset + 8);
      const low = u32be(b, offset + 12);
      if (high < 0 || low < 0) break;
      size = high * 0x100000000 + low;
      header = 16;
    } else if (size === 0) {
      // Extends to the end of the enclosing box (or the file).
      size = end - offset;
    }
    if (size < header) break;
    out.push({ type, body: offset + header, end: Math.min(offset + size, limit) });
    offset += size;
  }
  return out;
}

function find(list: Box[], type: string): Box | undefined {
  return list.find((box) => box.type === type);
}

/** A full box's children start after its 4-byte version and flags. */
function fullBoxChildren(b: Uint8Array, box: Box): Box[] {
  return boxes(b, box.body + 4, box.end);
}

/** Width and height of an `ispe` property, or null when it is cut off. */
function ispe(b: Uint8Array, box: Box): { width: number; height: number } | null {
  const width = u32be(b, box.body + 4);
  const height = u32be(b, box.body + 8);
  if (box.body + 12 > box.end || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** The 1-based `ipco` property indexes `ipma` associates with `itemId`. */
function itemProperties(b: Uint8Array, ipma: Box, itemId: number): number[] | null {
  const version = u8(b, ipma.body);
  const flags = u8(b, ipma.body + 3);
  const count = u32be(b, ipma.body + 4);
  if (version < 0 || flags < 0 || count < 0) return null;
  let offset = ipma.body + 8;
  for (let entry = 0; entry < count && offset < ipma.end; entry++) {
    const id = version < 1 ? u16be(b, offset) : u32be(b, offset);
    if (id < 0) return null;
    offset += version < 1 ? 2 : 4;
    const associations = u8(b, offset);
    if (associations < 0) return null;
    offset += 1;
    const indexes: number[] = [];
    for (let a = 0; a < associations; a++) {
      const value = flags & 0x01 ? u16be(b, offset) : u8(b, offset);
      if (value < 0) return null;
      offset += flags & 0x01 ? 2 : 1;
      indexes.push(flags & 0x01 ? value & 0x7fff : value & 0x7f);
    }
    if (id === itemId) return indexes;
  }
  return null;
}

function avifStillSize(b: Uint8Array, meta: Box): { width: number; height: number } | null {
  const metaChildren = fullBoxChildren(b, meta);
  const iprp = find(metaChildren, "iprp");
  if (!iprp) return null;
  const iprpChildren = boxes(b, iprp.body, iprp.end);
  const ipco = find(iprpChildren, "ipco");
  if (!ipco) return null;
  const properties = boxes(b, ipco.body, ipco.end);

  // The primary item's own ispe, when pitm and ipma say which one that is.
  const pitm = find(metaChildren, "pitm");
  const ipma = find(iprpChildren, "ipma");
  if (pitm && ipma) {
    const version = u8(b, pitm.body);
    const primary = version === 0 ? u16be(b, pitm.body + 4) : u32be(b, pitm.body + 4);
    const indexes = primary >= 0 ? itemProperties(b, ipma, primary) : null;
    for (const index of indexes ?? []) {
      const property = properties[index - 1];
      if (property?.type !== "ispe") continue;
      const size = ispe(b, property);
      if (size) return size;
    }
  }

  // Otherwise only an unambiguous answer: every ispe read gives the same size
  // (one image, or an image and its same-size alpha plane). Different sizes
  // with no way to tell which is the primary item, such as an ipma pushed past
  // the bytes read by a large ICC profile, could be a thumbnail's or another
  // item's, so the size is unknown rather than guessed.
  let only: { width: number; height: number } | null = null;
  for (const property of properties) {
    if (property.type !== "ispe") continue;
    const size = ispe(b, property);
    if (!size) continue;
    if (only && (only.width !== size.width || only.height !== size.height)) return null;
    only = size;
  }
  return only;
}

/** The largest track header's size, for a sequence with no still image item. */
function avifTrackSize(b: Uint8Array, moov: Box): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  for (const trak of boxes(b, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = find(boxes(b, trak.body, trak.end), "tkhd");
    if (!tkhd) continue;
    // Width and height are 16.16 fixed point at the end of the box, after the
    // version's timestamps, layer, volume and the 36-byte matrix.
    const at = tkhd.body + (u8(b, tkhd.body) === 1 ? 88 : 76);
    if (at + 8 > tkhd.end) continue;
    const width = Math.floor(u32be(b, at) / 0x10000);
    const height = Math.floor(u32be(b, at + 4) / 0x10000);
    if (width <= 0 || height <= 0) continue;
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

function parseAvif(b: Uint8Array): ImageHeaderInfo | null {
  const top = boxes(b, 0, b.length);
  const ftyp = top[0];
  if (ftyp?.type !== "ftyp") return null;
  const brands = new Set<string>([ascii(b, ftyp.body, 4)]);
  for (let i = ftyp.body + 8; i + 4 <= ftyp.end; i += 4) brands.add(ascii(b, i, 4));
  const sequence = brands.has("avis");
  if (!sequence && !brands.has("avif")) return null;

  const meta = find(top, "meta");
  const still = meta ? avifStillSize(b, meta) : null;
  const moov = find(top, "moov");
  const size = still ?? (moov ? avifTrackSize(b, moov) : null);
  if (!size) return null;
  return info("avif", size.width, size.height, sequence);
}

// ============================================
// JPEG: walk the marker segments to the first SOF.
// ============================================

function isStartOfFrame(marker: number): boolean {
  // SOF0-SOF15, less DHT (c4), JPG (c8) and DAC (cc), which share the range.
  return (
    marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
  );
}

function parseJpeg(b: Uint8Array): ImageHeaderInfo | null {
  let offset = 2;
  for (;;) {
    if (u8(b, offset) !== 0xff) return null;
    // Any number of 0xff fill bytes may precede the marker code.
    let marker = u8(b, offset + 1);
    while (marker === 0xff) {
      offset++;
      marker = u8(b, offset + 1);
    }
    if (marker < 0) return null;
    offset += 2;
    if (isStartOfFrame(marker)) {
      // Segment length, sample precision, then height and width.
      const height = u16be(b, offset + 3);
      const width = u16be(b, offset + 5);
      return info("jpeg", width, height, false);
    }
    // TEM, RST0-7 and SOI stand alone with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // End of image, or scan data, before any frame header.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, offset);
    if (length < 2) return null;
    offset += length;
  }
}

// ============================================
// Entry point
// ============================================

function startsWith(b: Uint8Array, bytes: readonly number[]): boolean {
  if (b.length < bytes.length) return false;
  return bytes.every((value, i) => b[i] === value);
}

/**
 * The format, natural size and animation of the image whose first bytes are
 * `bytes`, or null when they are not a PNG, GIF, WebP, AVIF or JPEG header the
 * parser can read to its dimensions. Never throws.
 */
export function parseImageHeader(bytes: Uint8Array): ImageHeaderInfo | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return parsePng(bytes);
  const magic = ascii(bytes, 0, 6);
  if (magic === "GIF87a" || magic === "GIF89a") return parseGif(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return parseWebp(bytes);
  if (ascii(bytes, 4, 4) === "ftyp") return parseAvif(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return parseJpeg(bytes);
  return null;
}
