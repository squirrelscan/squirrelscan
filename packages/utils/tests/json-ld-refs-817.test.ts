// pub#817: indexJsonLdIds / resolveJsonLdRef, the @id reference resolution
// schema rules share. Edge cases pinned directly (review of #870).

import { describe, expect, test } from "bun:test";

import { indexJsonLdIds, resolveJsonLdRef } from "../src/schema-rich-results";

const BASE = "https://example.com/page";

describe("indexJsonLdIds / resolveJsonLdRef (pub#817)", () => {
  test("a full node wins over a stub, whichever comes first", () => {
    const stub = { "@id": "#q", "@type": "Question" };
    const full = { "@id": "#q", "@type": "Question", name: "Q?" };
    for (const nodes of [[stub, full], [full, stub]]) {
      const ids = indexJsonLdIds(nodes, BASE);
      expect(resolveJsonLdRef({ "@id": "#q" }, ids, BASE)).toBe(full);
    }
  });

  test("a stub with no full node is the node its references resolve to", () => {
    const stub = { "@id": "#r", "@type": "Review" };
    const ids = indexJsonLdIds([stub], BASE);
    expect(resolveJsonLdRef({ "@id": `${BASE}#r` }, ids, BASE)).toBe(stub);
  });

  test("a non-string or empty @id is not indexed, and a non-reference value comes back as it was", () => {
    const ids = indexJsonLdIds([{ "@id": 7, name: "x" }, { "@id": "", name: "y" }], BASE);
    expect(ids.size).toBe(0);
    for (const value of [null, "text", 3, [{ "@id": "#a" }], { "@id": "#a", name: "inline" }]) {
      expect(resolveJsonLdRef(value, ids, BASE)).toBe(value);
    }
  });

  test("a dangling reference comes back as written", () => {
    const ref = { "@id": "#gone" };
    expect(resolveJsonLdRef(ref, indexJsonLdIds([], BASE), BASE)).toBe(ref);
  });

  test("a base URL that will not parse keys ids as written", () => {
    const node = { "@id": "#q", name: "Q?" };
    const ids = indexJsonLdIds([node], "not a url");
    expect(resolveJsonLdRef({ "@id": "#q" }, ids, "not a url")).toBe(node);
  });

  test("the walk stops at the object cap: an id past it is not indexed", () => {
    const filler = Array.from({ length: 20_000 }, (_, i) => ({ "@type": "Thing", name: `t${i}` }));
    const late = { "@id": "#late", name: "late" };
    const ids = indexJsonLdIds([...filler, late], BASE);
    expect(ids.has(`${BASE}#late`)).toBe(false);
    expect(resolveJsonLdRef({ "@id": "#late" }, ids, BASE)).toEqual({ "@id": "#late" });
  });
});
