// `squirrel entities --input <file>` (#2092).
//
// The file is user-supplied, so the property worth pinning is where the loader
// draws the line between restating what a document already determines and
// overruling what it said. A v1 map exported before three derived counters
// existed has to load; a document that states a WRONG value for one of them
// has to fail, because repairing it would make a malformed file validate.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEntityMapFile } from "@/controllers/entities";

const DIR = mkdtempSync(join(tmpdir(), "squirrel-entities-"));

function write(name: string, value: unknown): string {
  const path = join(DIR, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** A complete, valid v1 document. */
function document(): Record<string, unknown> {
  return {
    format: "squirrelscan/entity-map",
    version: 1,
    site: "https://example.com/",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      nodeCount: 1,
      edgeCount: 0,
      danglingCount: 0,
      pagesTotal: 1,
      pagesWithoutEntities: 0,
      nodesWithStableId: 1,
      stableIdShare: 1,
      pageLocalCount: 0,
      nodesWithoutIdCount: 0,
      conflictCount: 0,
      countsByType: { Organization: 1 },
    },
    nodes: [
      {
        key: "id:https://example.com/#org",
        id: "https://example.com/#org",
        types: ["Organization"],
        name: "Acme",
        properties: {},
        occurrences: 1,
        pages: ["https://example.com/"],
        morePages: 0,
        conflicts: [],
        danglingRefs: 0,
        pageLocal: false,
      },
    ],
    edges: [],
    pages: [
      {
        url: "https://example.com/",
        declares: ["id:https://example.com/#org"],
        references: [],
        entityCount: 1,
      },
    ],
  };
}

describe("loadEntityMapFile", () => {
  test("loads a complete document", () => {
    const result = loadEntityMapFile(write("ok.json", document()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nodes).toHaveLength(1);
  });

  test("unwraps a report's `entities` key", () => {
    // An audit's `-f json` report carries the map under `entities`; an exported
    // map is the document itself. Both are things a user has on disk.
    const result = loadEntityMapFile(
      write("report.json", { score: 90, entities: document() })
    );
    expect(result.ok).toBe(true);
  });

  test("fills in derived fields a pre-#2091 export never wrote", () => {
    const old = document();
    const summary = old.summary as Record<string, unknown>;
    delete summary.pageLocalCount;
    delete summary.nodesWithoutIdCount;
    delete summary.conflictCount;
    delete (old.nodes as Array<Record<string, unknown>>)[0]!.pageLocal;

    const result = loadEntityMapFile(write("legacy.json", old));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.summary.pageLocalCount).toBe(0);
      expect(result.data.nodes[0]!.pageLocal).toBe(false);
    }
  });

  test("a WRONG derived value is rejected, not repaired", () => {
    // The distinction that matters: absent means "this build did not know
    // about the field", present-and-invalid means the document is malformed.
    // Recomputing the second would let a broken file pass validation.
    const wrong = document();
    (wrong.nodes as Array<Record<string, unknown>>)[0]!.pageLocal = "bad";
    expect(loadEntityMapFile(write("bad-node.json", wrong)).ok).toBe(false);

    const nulled = document();
    (nulled.summary as Record<string, unknown>).conflictCount = null;
    expect(loadEntityMapFile(write("bad-summary.json", nulled)).ok).toBe(false);
  });

  test("says what is wrong rather than failing blankly", () => {
    const broken = document();
    broken.format = "something/else";
    const result = loadEntityMapFile(write("format.json", broken));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain("squirrelscan/entity-map");
  });

  test("a missing file and invalid JSON are distinct failures", () => {
    const missing = loadEntityMapFile(join(DIR, "nope.json"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain("File not found");

    const path = join(DIR, "broken.json");
    writeFileSync(path, "{not json");
    const invalid = loadEntityMapFile(path);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.message).toContain("not valid JSON");
  });
});
