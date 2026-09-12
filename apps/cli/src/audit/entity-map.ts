// `squirrel audit --entity-map` (#2061, prototype) — write the site-wide
// JSON-LD entity graph as side files.
//
// Deliberately a side artifact: the map does not feed the rules, the score or
// the report, and the flag is off by default, so a normal audit pays nothing
// for it.

import {
  buildEntityMap,
  renderEntityMapHtml,
  renderEntityMapMarkdown,
  toJsonLd,
  type EntityMap,
  type EntityMapPageInput,
} from "@squirrelscan/audit-engine/entity-map";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { EntityMapFormat, EntityMapOutput } from "@/types";

import { logger } from "@/utils/logger";

/** Every `--entity-map-format` value, in the order the files are written. */
export const ENTITY_MAP_FORMATS = [
  "json",
  "jsonld",
  "html",
  "md",
] as const satisfies readonly EntityMapFormat[];

/** Filename per format. The basename is fixed so a re-run overwrites in place. */
const FILENAMES: Record<EntityMapFormat, string> = {
  json: "entity-map.json",
  jsonld: "entity-map.jsonld",
  html: "entity-map.html",
  md: "entity-map.md",
};

export interface WriteEntityMapOptions {
  pages: EntityMapPageInput[];
  siteUrl: string;
  /** `--entity-map-format`. Empty or absent means every format. */
  formats?: readonly EntityMapFormat[];
  /** `--entity-map-dir`, when given. */
  dir?: string;
  /** `--output`, so the map lands next to the report a run already writes. */
  outputPath?: string;
  cwd: string;
}

export interface WriteEntityMapResult {
  /** Absolute path per format actually written. */
  output: EntityMapOutput;
  /** The built map, so the caller can attach it to the report. */
  map: EntityMap;
}

/**
 * Parse `--entity-map-format`.
 *
 * Accepts a comma-separated list or a repeated flag, in any order and any case.
 * Returns the unknown values instead of guessing: a typo that silently wrote
 * nothing would be the worst outcome of a flag whose whole job is writing files.
 */
export function parseEntityMapFormats(raw: string | string[] | undefined): {
  formats: EntityMapFormat[];
  unknown: string[];
} {
  const parts = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  if (parts.length === 0)
    return { formats: [...ENTITY_MAP_FORMATS], unknown: [] };

  const known = new Set<string>(ENTITY_MAP_FORMATS);
  const unknown = parts.filter((part) => !known.has(part));
  // Deduplicate and emit in the canonical order, so the printed paths do not
  // depend on the order the user happened to type.
  const wanted = new Set(parts);
  return {
    formats: ENTITY_MAP_FORMATS.filter((format) => wanted.has(format)),
    unknown,
  };
}

/**
 * Where the files go: `--entity-map-dir` if given, else the directory of
 * `--output`, else the working directory. A relative directory resolves against
 * the working directory, never against the output path.
 */
export function resolveEntityMapDir(options: WriteEntityMapOptions): string {
  if (options.dir) {
    return isAbsolute(options.dir)
      ? options.dir
      : resolve(options.cwd, options.dir);
  }
  if (options.outputPath) {
    return dirname(resolve(options.cwd, options.outputPath));
  }
  return options.cwd;
}

/**
 * Build the map and write the requested formats. Returns the paths written and
 * the map itself.
 *
 * Throws on a write failure — the caller decides whether that is fatal. It is
 * not: the audit itself succeeded, and losing a side artifact must not lose the
 * report.
 */
export function writeEntityMap(
  options: WriteEntityMapOptions
): WriteEntityMapResult {
  const directory = resolveEntityMapDir(options);
  const formats =
    options.formats && options.formats.length > 0
      ? options.formats
      : ENTITY_MAP_FORMATS;
  mkdirSync(directory, { recursive: true });

  const map = buildEntityMap(options.pages, options.siteUrl);
  const output: EntityMapOutput = {};

  for (const format of ENTITY_MAP_FORMATS) {
    if (!formats.includes(format)) continue;
    const path = join(directory, FILENAMES[format]);
    switch (format) {
      case "json":
        writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
        break;
      case "jsonld":
        writeFileSync(path, `${JSON.stringify(toJsonLd(map), null, 2)}\n`);
        break;
      case "html":
        writeFileSync(path, renderEntityMapHtml(map));
        break;
      case "md":
        writeFileSync(path, renderEntityMapMarkdown(map));
        break;
    }
    output[format] = path;
  }

  logger.debug(
    "entity map",
    `${map.summary.nodeCount} nodes, ${map.summary.edgeCount} edges, ${map.summary.danglingCount} dangling`
  );
  return { output, map };
}
