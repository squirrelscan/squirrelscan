// #1293 integration guard: drive probeWellKnown end-to-end with a mocked fetch
// returning a MULTI-BYTE body, and assert the returned excerpt + bodySize are
// bounded by real UTF-8 BYTES (not UTF-16 .length) with no split-codepoint
// artifact. well-known.ts has TWO truncation sites (body + excerpt); a call site
// that reverts to a `.length` slice would fail this, unlike the standalone
// truncateToBytes unit tests.
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { byteLength } from "@squirrelscan/utils/bytes";

import {
  EXCERPT_MAX_BYTES,
  OAUTH_EXCERPT_MAX_BYTES,
  WELL_KNOWN_MAX_BYTES,
  isOAuthMetadataPath,
  probeWellKnown,
} from "../src/well-known";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("probeWellKnown byte-accurate truncation (#1293)", () => {
  test("multi-byte body → excerpt + bodySize bounded by UTF-8 bytes, no split char", async () => {
    // 1000 "中" = 3000 UTF-8 bytes but only 1000 code units. Under WELL_KNOWN_MAX
    // (256KB) so the body isn't truncated, but well over EXCERPT_MAX_BYTES (2KB),
    // so every NON-oauth excerpt must be byte-clipped. An old `.length` slice
    // would have kept 2048 CODE UNITS = 6144 bytes, failing the <= 2048 assert.
    const cjk = "中".repeat(1000);
    globalThis.fetch = (async () =>
      new Response(cjk, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await Effect.runPromise(probeWellKnown("https://x.test/", "test-ua"));

    let sawTruncatedNonOauth = false;
    for (const probe of result.probes) {
      if (probe.error) continue;
      const cap = isOAuthMetadataPath(probe.path) ? OAUTH_EXCERPT_MAX_BYTES : EXCERPT_MAX_BYTES;
      // Excerpt bounded by BYTES, not code units (the bug: a .length slice of CJK
      // over-keeps ~3x). And truncateToBytes never emits a partial-sequence �.
      expect(byteLength(probe.excerpt)).toBeLessThanOrEqual(cap);
      expect(probe.excerpt).not.toContain("�");
      // bodySize is the true UTF-8 byte count of the (byte-capped) body.
      expect(probe.bodySize).toBe(byteLength(cjk));
      expect(probe.bodySize).toBeLessThanOrEqual(WELL_KNOWN_MAX_BYTES);
      if (!isOAuthMetadataPath(probe.path)) {
        expect(byteLength(probe.excerpt)).toBeLessThan(probe.bodySize); // actually clipped
        sawTruncatedNonOauth = true;
      }
    }
    expect(sawTruncatedNonOauth).toBe(true); // the probe set includes non-oauth paths
  });
});
