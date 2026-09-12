// `squirrel audit --entity-map` (#2061, prototype) — write the site-wide
// JSON-LD entity graph as three side files.
//
// Deliberately a side artifact: the map does not feed the rules, the score or
// the report, and the flag is off by default, so a normal audit pays nothing
// for it.

import {
  buildEntityMap,
  renderEntityMapHtml,
  toJsonLd,
  type EntityMapPageInput,
} from "@squirrelscan/audit-engine/entity-map";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { EntityMapOutput } from "@/types";

import { logger } from "@/utils/logger";

export interface WriteEntityMapOptions {
  pages: EntityMapPageInput[];
  siteUrl: string;
  /** `--entity-map-dir`, when given. */
  dir?: string;
  /** `--output`, so the map lands next to the report a run already writes. */
  outputPath?: string;
  cwd: string;
}

/**
 * Where the three files go: `--entity-map-dir` if given, else the directory of
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
 * Build the map and write `entity-map.json`, `entity-map.jsonld` and
 * `entity-map.html`. Returns the three absolute paths.
 *
 * Throws on a write failure — the caller decides whether that is fatal. It is
 * not: the audit itself succeeded, and losing a side artifact must not lose the
 * report.
 */
export function writeEntityMap(
  options: WriteEntityMapOptions
): EntityMapOutput {
  const directory = resolveEntityMapDir(options);
  mkdirSync(directory, { recursive: true });

  const map = buildEntityMap(options.pages, options.siteUrl);
  const output: EntityMapOutput = {
    json: join(directory, "entity-map.json"),
    jsonld: join(directory, "entity-map.jsonld"),
    html: join(directory, "entity-map.html"),
  };

  writeFileSync(output.json, `${JSON.stringify(map, null, 2)}\n`);
  writeFileSync(output.jsonld, `${JSON.stringify(toJsonLd(map), null, 2)}\n`);
  writeFileSync(output.html, renderEntityMapHtml(map));

  logger.debug(
    "entity map",
    `${map.summary.nodeCount} nodes, ${map.summary.edgeCount} edges, ${map.summary.danglingCount} dangling`
  );
  return output;
}
