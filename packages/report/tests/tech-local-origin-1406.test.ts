import { describe, expect, test } from "bun:test";

import type { ReportTechnologies } from "@squirrelscan/core-contracts";

import { techChangeSummary, techLocalOnlyNote } from "../src/technologies";

const base = { added: [], removed: [], firstScan: false };
const item = (id: string, origin?: "local") => ({
  id,
  name: id,
  category: "framework" as const,
  version: null,
  confidence: "high" as const,
  detectedBy: "t",
  ...(origin ? { origin } : {}),
});

describe("technologies found only by the local scan, in a cloud section (#1406)", () => {
  const merged: ReportTechnologies = { ...base, source: "cloud", items: [item("react"), item("svelte", "local"), item("vue", "local")] };

  test("the summary says how many have no scan history", () => {
    expect(techLocalOnlyNote(merged)).toBe("2 found only by the local scan of the crawled bundles (no scan history)");
    expect(techChangeSummary(merged)).toContain("No changes since last scan");
    expect(techChangeSummary(merged)).toContain("2 found only by the local scan");
  });

  test("no note for a local section or when every item came from the cloud", () => {
    expect(techLocalOnlyNote({ ...merged, source: "local" })).toBeNull();
    expect(techLocalOnlyNote({ ...base, source: "cloud", items: [item("react")] })).toBeNull();
  });
});
