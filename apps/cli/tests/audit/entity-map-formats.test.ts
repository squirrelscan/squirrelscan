// `--entity-map-format` decides which files a run writes, so a typo that
// silently wrote nothing would defeat the flag's only purpose. These cover the
// parse, the default, and where the files land.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENTITY_MAP_FORMATS,
  parseEntityMapFormats,
  resolveEntityMapDir,
  writeEntityMap,
} from "@/audit/entity-map";

const PAGE = {
  url: "https://example.com/",
  raw: JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://example.com/#org",
    name: "Acme",
  }),
};

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "squirrel-entity-map-"));
}

describe("parseEntityMapFormats", () => {
  test("defaults to every format", () => {
    expect(parseEntityMapFormats(undefined).formats).toEqual([
      ...ENTITY_MAP_FORMATS,
    ]);
    expect(parseEntityMapFormats("").formats).toEqual([...ENTITY_MAP_FORMATS]);
    expect(parseEntityMapFormats(undefined).unknown).toEqual([]);
  });

  test("accepts a comma-separated list and a repeated flag", () => {
    expect(parseEntityMapFormats("json,md").formats).toEqual(["json", "md"]);
    expect(parseEntityMapFormats(["json", "md"]).formats).toEqual([
      "json",
      "md",
    ]);
    expect(parseEntityMapFormats(["json,html", "md"]).formats).toEqual([
      "json",
      "html",
      "md",
    ]);
  });

  test("normalises case, spacing and duplicates, and keeps a canonical order", () => {
    expect(parseEntityMapFormats(" MD , json ,md").formats).toEqual([
      "json",
      "md",
    ]);
  });

  test("reports an unknown format instead of dropping it", () => {
    const parsed = parseEntityMapFormats("json,markdown,xml");
    expect(parsed.unknown).toEqual(["markdown", "xml"]);
    expect(parsed.formats).toEqual(["json"]);
  });
});

describe("writeEntityMap", () => {
  test("writes all four files by default", () => {
    const dir = scratch();
    const { output } = writeEntityMap({
      pages: [PAGE],
      siteUrl: "https://example.com/",
      dir,
      cwd: dir,
    });

    expect(readdirSync(dir).sort()).toEqual([
      "entity-map.html",
      "entity-map.json",
      "entity-map.jsonld",
      "entity-map.md",
    ]);
    expect(Object.keys(output).sort()).toEqual([
      "html",
      "json",
      "jsonld",
      "md",
    ]);
    expect(readFileSync(output.md!, "utf8")).toContain("# Entity map");
    expect(readFileSync(output.html!, "utf8")).toContain("entity-map-data");
    expect(JSON.parse(readFileSync(output.json!, "utf8")).format).toBe(
      "squirrelscan/entity-map"
    );
    expect(JSON.parse(readFileSync(output.jsonld!, "utf8"))["@context"]).toBe(
      "https://schema.org"
    );
  });

  test("writes only the requested formats", () => {
    const dir = scratch();
    const { output } = writeEntityMap({
      pages: [PAGE],
      siteUrl: "https://example.com/",
      formats: ["md", "json"],
      dir,
      cwd: dir,
    });

    expect(readdirSync(dir).sort()).toEqual([
      "entity-map.json",
      "entity-map.md",
    ]);
    expect(output.html).toBeUndefined();
    expect(output.jsonld).toBeUndefined();
  });

  test("returns the built map so the caller can attach it to the report", () => {
    const dir = scratch();
    const { map } = writeEntityMap({
      pages: [PAGE],
      siteUrl: "https://example.com/",
      formats: ["json"],
      dir,
      cwd: dir,
    });
    expect(map.summary.nodeCount).toBe(1);
    expect(map.nodes[0]!.name).toBe("Acme");
  });
});

describe("resolveEntityMapDir", () => {
  const base = { pages: [], siteUrl: "https://example.com/", cwd: "/work" };

  test("prefers an explicit directory", () => {
    expect(resolveEntityMapDir({ ...base, dir: "/opt/maps" })).toBe(
      "/opt/maps"
    );
  });

  test("resolves a relative directory against the working directory", () => {
    expect(resolveEntityMapDir({ ...base, dir: "out/maps" })).toBe(
      "/work/out/maps"
    );
  });

  test("falls back to the directory of --output", () => {
    expect(
      resolveEntityMapDir({ ...base, outputPath: "reports/site.json" })
    ).toBe("/work/reports");
  });

  test("an explicit directory wins over --output", () => {
    expect(
      resolveEntityMapDir({
        ...base,
        dir: "/opt/maps",
        outputPath: "reports/site.json",
      })
    ).toBe("/opt/maps");
  });

  test("falls back to the working directory", () => {
    expect(resolveEntityMapDir(base)).toBe("/work");
  });
});
