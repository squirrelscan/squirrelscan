// The serialization codec is the only place that knows the hoisted wire form,
// so its round-trip and its tolerance of the older un-hoisted layout are what
// keep four separate readers honest.

import { describe, expect, test } from "bun:test";
import type { ComponentOccurrence } from "../src/index";
import {
  COMPONENT_EVIDENCE_FORMAT,
  packComponentOccurrences,
  unpackComponentOccurrences,
} from "../src/component-evidence";

/** Realistic width: `componentHash` emits `s128:` + 32 hex, and the saving the
 * hoist buys is proportional to that, so stub values would understate it. */
function sig(seed: string): string {
  return `s128:${seed.repeat(32).slice(0, 32)}`;
}

function occurrence(overrides: Partial<ComponentOccurrence> = {}): ComponentOccurrence {
  return {
    version: 1,
    pageUrl: "https://example.test/a",
    siteOrigin: "https://example.test",
    provenance: { source: "page-dom", rendered: true },
    groupable: true,
    confidence: "observed",
    region: { role: "footer", nestedIn: "none", structuralSignature: sig("a") },
    family: { key: sig("b"), structuralSignature: sig("b") },
    variant: { key: sig("c"), structuralSignature: sig("c"), contentHash: sig("d") },
    element: { locator: "footer:1>footer>a:1", structuralSignature: sig("e") },
    defect: { kind: "link-text-generic", values: { text: "read more" }, valueHashes: { text: sig("f") } },
    ...overrides,
  };
}

describe("component evidence codec", () => {
  test("round-trips occurrences unchanged, in order", () => {
    const input = [
      occurrence({ element: { locator: "a:1", structuralSignature: sig("1") } }),
      occurrence({ element: { locator: "a:2", structuralSignature: sig("2") } }),
      occurrence({
        pageUrl: "https://example.test/b",
        groupable: false,
        confidence: "uncertain",
        uncertainReason: "region-main",
      }),
    ];
    const packed = packComponentOccurrences(input);
    expect(packed.v).toBe(COMPONENT_EVIDENCE_FORMAT);
    expect(unpackComponentOccurrences(packed)).toEqual(input);
  });

  test("the shared region/family/variant triple is stored once", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      occurrence({ element: { locator: `a:${i}`, structuralSignature: sig(String(i % 10)) } }),
    );
    const packed = packComponentOccurrences(many);
    expect(packed.shapes).toHaveLength(1);
    expect(packed.occurrences.every((row) => row.shape === 0)).toBe(true);
    // Measured on the 1,000-link page the hoist was built for: 1,031 KB -> 619 KB,
    // about 40%. The triple is roughly half of an occurrence, so ~0.6x is the
    // real ceiling; a tighter bound here would be aspiration, not a fact.
    const hoisted = Buffer.byteLength(JSON.stringify(packed));
    const unhoisted = Buffer.byteLength(JSON.stringify(many));
    expect(hoisted).toBeLessThan(unhoisted * 0.7);

    // Structural guarantee behind the number: the shape table does not grow
    // with occurrence count, so the saving widens as a page gets worse.
    const twice = packComponentOccurrences([...many, ...many]);
    expect(twice.shapes).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(twice)) - hoisted).toBeLessThan(hoisted);
  });

  test("distinct shapes stay distinct", () => {
    const packed = packComponentOccurrences([
      occurrence(),
      occurrence({ variant: { key: sig("9"), structuralSignature: sig("9"), contentHash: sig("8") } }),
      occurrence(),
    ]);
    expect(packed.shapes).toHaveLength(2);
    expect(packed.occurrences.map((row) => row.shape)).toEqual([0, 1, 0]);
  });

  test("a plain occurrence array (the un-hoisted form) still reads", () => {
    // Rows written before the codec, and anything that hands us the in-memory
    // shape directly. A reader must not require the hoisted layout.
    const input = [occurrence(), occurrence({ pageUrl: "https://example.test/b" })];
    expect(unpackComponentOccurrences(input)).toEqual(input);
  });

  test("malformed or empty evidence yields undefined rather than throwing", () => {
    expect(unpackComponentOccurrences(undefined)).toBeUndefined();
    expect(unpackComponentOccurrences(null)).toBeUndefined();
    expect(unpackComponentOccurrences([])).toBeUndefined();
    expect(unpackComponentOccurrences("nonsense")).toBeUndefined();
    expect(unpackComponentOccurrences({ shapes: "no", occurrences: [] })).toBeUndefined();
    // An unresolvable shape index skips that row instead of taking the finding
    // down: evidence is additive and must never break the surrounding check.
    expect(
      unpackComponentOccurrences({ v: 1, shapes: [], occurrences: [{ shape: 7 }] }),
    ).toBeUndefined();
  });
});
