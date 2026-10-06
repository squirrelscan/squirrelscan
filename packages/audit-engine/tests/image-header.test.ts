// The image header parser behind images/responsive-size's pixel test (#470).
//
// Fixtures in fixtures/image-header/ are real encoder output (Pillow: libpng,
// giflib-style GIF, libwebp, libavif, libjpeg), named for the size each one
// declares. The parser reads whatever a server sent, so beyond the formats it
// must be total: truncated, mutated and random input returns null or a size,
// and never throws or spins.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseImageHeader } from "../src/image-header";

const FIXTURES = join(import.meta.dir, "fixtures", "image-header");

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

describe("every format, static and animated", () => {
  test.each([
    ["static-37x23.png", "png", 37, 23, false],
    ["animated-40x30.png", "png", 40, 30, true],
    ["static-17x9.gif", "gif", 17, 9, false],
    ["animated-20x10.gif", "gif", 20, 10, true],
    ["lossy-33x21.webp", "webp", 33, 21, false],
    ["lossless-31x19.webp", "webp", 31, 19, false],
    ["extended-29x15.webp", "webp", 29, 15, false],
    ["animated-24x18.webp", "webp", 24, 18, true],
    ["still-41x27.avif", "avif", 41, 27, false],
    ["animated-26x14.avif", "avif", 26, 14, true],
    ["baseline-45x35.jpg", "jpeg", 45, 35, false],
    ["progressive-45x35.jpg", "jpeg", 45, 35, false],
  ] as const)("%s", (name, format, width, height, animated) => {
    expect(parseImageHeader(fixture(name))).toEqual({ format, width, height, animated });
  });

  test("a JPEG whose SOF sits past the 32 KiB read is unknown, not guessed", () => {
    const file = fixture("big-icc-46x36.jpg");
    expect(file.length).toBeGreaterThan(32 * 1024);
    // The whole file parses; the first 32 KiB, which is all the check reads, does not.
    expect(parseImageHeader(file)).toEqual({ format: "jpeg", width: 46, height: 36, animated: false });
    expect(parseImageHeader(file.subarray(0, 32 * 1024))).toBeNull();
  });

  test("non-image bytes are null", () => {
    const text = new TextEncoder();
    expect(parseImageHeader(text.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(parseImageHeader(text.encode("<!doctype html><title>404</title>"))).toBeNull();
    expect(parseImageHeader(new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]))).toBeNull(); // ICO
    expect(parseImageHeader(new Uint8Array(0))).toBeNull();
  });
});

// ============================================
// Hand-built ISO BMFF, for the AVIF paths an encoder's simple output skips.
// ============================================

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
}

const FULL_BOX_HEADER = [0, 0, 0, 0];
const ftyp = (brand: string) => box("ftyp", [...brand].map((c) => c.charCodeAt(0)), u32(0));
const ispe = (w: number, h: number) => box("ispe", FULL_BOX_HEADER, u32(w), u32(h));

function avif(opts: { primary?: number; withIpma: boolean }): Uint8Array {
  // Item 1 is a large non-primary item (property 1), item 2 the primary image
  // (property 2): only pitm + ipma can tell them apart.
  const ipma = box(
    "ipma",
    FULL_BOX_HEADER,
    u32(2),
    [0, 1, 1, 0x81],
    [0, 2, 1, 0x82]
  );
  const iprp = box("iprp", box("ipco", ispe(400, 300), ispe(41, 27)), opts.withIpma ? ipma : []);
  const pitm = opts.primary ? box("pitm", FULL_BOX_HEADER, [0, opts.primary]) : [];
  return new Uint8Array([...ftyp("avif"), ...box("meta", FULL_BOX_HEADER, pitm, iprp)]);
}

describe("AVIF item selection", () => {
  test("the primary item's ispe wins when pitm and ipma name it", () => {
    expect(parseImageHeader(avif({ primary: 2, withIpma: true }))).toMatchObject({
      width: 41,
      height: 27,
    });
  });

  test("without them, different sizes are unknown rather than guessed", () => {
    expect(parseImageHeader(avif({ withIpma: false }))).toBeNull();
    expect(parseImageHeader(avif({ primary: 2, withIpma: false }))).toBeNull();
  });

  test("an ipma pushed past the bytes read does not hand over another item's size", () => {
    // A large property after the ispes (an ICC profile in `colr`) moves ipma
    // beyond the 32 KiB the check reads, while both ispes stay readable.
    const colr = box("colr", [..."prof"].map((c) => c.charCodeAt(0)), new Array(40_000).fill(0));
    const ipma = box("ipma", FULL_BOX_HEADER, u32(2), [0, 1, 1, 0x81], [0, 2, 1, 0x82]);
    const iprp = box("iprp", box("ipco", ispe(400, 300), ispe(41, 27), colr), ipma);
    const pitm = box("pitm", FULL_BOX_HEADER, [0, 2]);
    const file = new Uint8Array([...ftyp("avif"), ...box("meta", FULL_BOX_HEADER, pitm, iprp)]);
    expect(parseImageHeader(file)).toMatchObject({ width: 41, height: 27 });
    expect(parseImageHeader(file.subarray(0, 32 * 1024))).toBeNull();
  });

  test("one size, however many ispes carry it, needs no primary item", () => {
    const iprp = box("iprp", box("ipco", ispe(41, 27), ispe(41, 27)));
    const file = new Uint8Array([...ftyp("avif"), ...box("meta", FULL_BOX_HEADER, iprp)]);
    expect(parseImageHeader(file)).toMatchObject({ width: 41, height: 27 });
  });

  test("a sequence with no still item falls back to its track header", () => {
    const file = fixture("animated-26x14.avif").slice();
    // Rename the meta box to `free`, so only moov/trak/tkhd is left to read.
    const at = Buffer.from(file).indexOf("meta");
    expect(at).toBeGreaterThan(0);
    file.set([..."free"].map((c) => c.charCodeAt(0)), at);
    expect(parseImageHeader(file)).toEqual({ format: "avif", width: 26, height: 14, animated: true });
  });

  test("an ISO BMFF file that is not AVIF is null", () => {
    expect(parseImageHeader(new Uint8Array([...ftyp("isom"), ...box("moov")]))).toBeNull();
    expect(parseImageHeader(new Uint8Array([...ftyp("heic"), ...box("meta", FULL_BOX_HEADER)]))).toBeNull();
  });
});

// ============================================
// Totality: truncated, mutated and random input.
// ============================================

const ALL_FIXTURES = [
  "static-37x23.png",
  "animated-40x30.png",
  "static-17x9.gif",
  "animated-20x10.gif",
  "lossy-33x21.webp",
  "lossless-31x19.webp",
  "extended-29x15.webp",
  "animated-24x18.webp",
  "still-41x27.avif",
  "animated-26x14.avif",
  "baseline-45x35.jpg",
  "progressive-45x35.jpg",
];

/** Deterministic xorshift, so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function expectWellFormed(result: ReturnType<typeof parseImageHeader>): void {
  if (result === null) return;
  expect(Number.isSafeInteger(result.width) && result.width > 0).toBe(true);
  expect(Number.isSafeInteger(result.height) && result.height > 0).toBe(true);
  expect([true, false, null]).toContain(result.animated);
}

describe("the parser is total", () => {
  test("every truncation of every fixture returns null or a well-formed size", () => {
    for (const name of ALL_FIXTURES) {
      const file = fixture(name);
      for (let length = 0; length <= file.length; length++) {
        expectWellFormed(parseImageHeader(file.subarray(0, length)));
      }
    }
  });

  test("a truncation never reports a different size than the whole file", () => {
    for (const name of ALL_FIXTURES) {
      const file = fixture(name);
      const whole = parseImageHeader(file)!;
      for (let length = 0; length <= file.length; length++) {
        const partial = parseImageHeader(file.subarray(0, length));
        if (partial === null) continue;
        expect([partial.width, partial.height]).toEqual([whole.width, whole.height]);
        // Animation is either settled the same way or left open.
        if (partial.animated !== null) expect<boolean | null>(partial.animated).toBe(whole.animated);
      }
    }
  });

  test("random byte mutations of every fixture never throw or spin", () => {
    const next = rng(470);
    const started = performance.now();
    for (const name of ALL_FIXTURES) {
      const file = fixture(name);
      for (let round = 0; round < 400; round++) {
        const mutated = file.slice();
        const flips = 1 + Math.floor(next() * 8);
        for (let f = 0; f < flips; f++) {
          // Bias toward the header, where the parser actually reads.
          const at = Math.floor(next() * Math.min(mutated.length, next() < 0.8 ? 64 : mutated.length));
          mutated[at] = Math.floor(next() * 256);
        }
        expectWellFormed(parseImageHeader(mutated));
      }
    }
    // 4,800 parses of sub-KB inputs; a loop that failed to advance would hang here.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("random garbage behind each format's prefix never throws or spins", () => {
    const next = rng(32_768);
    const bytesOf = (text: string) => [...text].map((c) => c.charCodeAt(0));
    // Each prefix gets the parser past format detection and into one branch,
    // so the garbage lands where that branch reads.
    const prefixes: number[][] = [
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...bytesOf("IHDR")],
      bytesOf("GIF89a"),
      [...bytesOf("RIFF"), ...u32(0), ...bytesOf("WEBPVP8 ")],
      [...bytesOf("RIFF"), ...u32(0), ...bytesOf("WEBPVP8L")],
      [...bytesOf("RIFF"), ...u32(0), ...bytesOf("WEBPVP8X")],
      [0xff, 0xd8, 0xff],
      ftyp("avif"),
      [...ftyp("avis"), ...u32(400), ...bytesOf("meta"), ...FULL_BOX_HEADER],
      [...ftyp("avis"), ...u32(400), ...bytesOf("moov"), ...u32(392), ...bytesOf("trak")],
    ];
    for (const prefix of prefixes) {
      for (let round = 0; round < 300; round++) {
        const bytes = new Uint8Array(prefix.length + Math.floor(next() * 512));
        bytes.set(prefix);
        for (let i = prefix.length; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
        expectWellFormed(parseImageHeader(bytes));
      }
    }
  });

  test("hostile lengths: zero-size and 64-bit boxes, huge PNG chunks, endless GIF blocks", () => {
    // A box claiming size 0 (to end of file) and one claiming 2^64 - 1.
    const zero = new Uint8Array([...ftyp("avif"), ...u32(0), ...[..."meta"].map((c) => c.charCodeAt(0))]);
    expectWellFormed(parseImageHeader(zero));
    const huge = new Uint8Array([
      ...ftyp("avif"),
      ...u32(1),
      ...[..."meta"].map((c) => c.charCodeAt(0)),
      ...u32(0xffffffff),
      ...u32(0xffffffff),
    ]);
    expectWellFormed(parseImageHeader(huge));

    // A PNG whose second chunk claims 4 GiB.
    const png = fixture("static-37x23.png").slice(0, 33);
    const bigChunk = new Uint8Array([...png, ...u32(0xffffffff), 0x74, 0x45, 0x58, 0x74]);
    expect(parseImageHeader(bigChunk)).toEqual({ format: "png", width: 37, height: 23, animated: null });

    // A GIF that is nothing but extension blocks with no terminator.
    const gif = fixture("static-17x9.gif").slice(0, 13);
    const blocks = new Uint8Array([...gif, ...Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? 0x21 : 0xf9))]);
    expectWellFormed(parseImageHeader(blocks));

    // A JPEG of nothing but fill bytes.
    expect(parseImageHeader(new Uint8Array(4096).fill(0xff).fill(0xd8, 1, 2))).toBeNull();
  });
});
