import { describe, expect, test } from "bun:test";
import { clipNodes, normalizeCorpusCaptureTarget } from "./capture.ts";
import type { CapturedNode } from "./types.ts";

describe("public corpus URL guard", () => {
  test("rejects canonical IPv4-mapped loopback URLs before DNS", () => {
    expect(() => normalizeCorpusCaptureTarget({ url: "https://[::ffff:127.0.0.1]/" })).toThrow(
      "Private network URL",
    );
    expect(() => normalizeCorpusCaptureTarget({ url: "https://[::ffff:7f00:1]/" })).toThrow(
      "Private network URL",
    );
  });

  test("reparents clipped descendants to the nearest retained ancestor", () => {
    const node = (
      id: string,
      parentId: string | null,
      y: number,
      height: number,
    ): CapturedNode => ({
      id,
      parentId,
      tag: "div",
      role: null,
      text: id,
      selector: `#${id}`,
      rect: { x: 0, y, width: 100, height },
      depth: parentId ? 2 : 1,
      suggestion: null,
    });
    const root = node("node_aaaaaaaaaaaaaaaaaaaaaaaa", null, 0, 500);
    const clippedParent = node("node_bbbbbbbbbbbbbbbbbbbbbbbb", root.id, 1_200, 50);
    const fixedChild = node("node_cccccccccccccccccccccccc", clippedParent.id, 20, 40);
    const clipped = clipNodes([root, clippedParent, fixedChild], 200, 900);
    expect(clipped.map((item) => item.id)).toEqual([root.id, fixedChild.id]);
    expect(clipped.find((item) => item.id === fixedChild.id)?.parentId).toBe(root.id);
  });
});
