// The CLI names the pages whose body could not be decoded (repo#2557).

import { describe, expect, test } from "bun:test";

import { decodeFailureLines, isDecodeFailure } from "@/audit/decode-failures";

const decodeMessage = (path: string) =>
  `Could not decode response body from https://example.com${path} (content-encoding: gzip): incorrect header check`;

describe("decode failures", () => {
  test("recognises the crawler's decode message and nothing else", () => {
    expect(isDecodeFailure(decodeMessage("/a"))).toBe(true);
    expect(isDecodeFailure("Request timed out")).toBe(false);
  });

  test("no lines when no page could not be decoded", () => {
    expect(decodeFailureLines([])).toEqual([]);
  });

  test("names each undecodable URL with its encoding", () => {
    const lines = decodeFailureLines([
      decodeMessage("/a"),
      decodeMessage("/b"),
    ]);
    expect(lines[0]).toBe(
      "2 page(s) could not be decoded, so their content is missing from this audit:"
    );
    expect(lines).toContain(`  ${decodeMessage("/a")}`);
    expect(lines).toContain(`  ${decodeMessage("/b")}`);
  });

  test("caps the list and counts the rest", () => {
    const messages = Array.from({ length: 7 }, (_, i) =>
      decodeMessage(`/p${i}`)
    );
    const lines = decodeFailureLines(messages, 5);
    expect(lines).toHaveLength(1 + 5 + 1);
    expect(lines.at(-1)).toBe("  ...and 2 more");
  });
});
