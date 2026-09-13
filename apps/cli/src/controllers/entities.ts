// `squirrel entities` controller (#2092) — reads entity maps out of the project
// store and filters them.
//
// Same shape as `controllers/report.ts`: walk the project databases, open each
// with SQLiteStorage, close it in a `finally`. Nothing here renders; the command
// layer picks a format.

import { Value } from "@sinclair/typebox/value";
import {
  ENTITY_MAP_FORMAT,
  ENTITY_MAP_PAGES_CAP,
  ENTITY_MAP_VERSION,
  EntityMapSchema,
  isPageLocalEntity,
  type EntityMap,
  type EntityMapConflict,
  type EntityMapEdge,
  type EntityMapNode,
  type EntityMapPage,
  type EntityMapProperties,
} from "@squirrelscan/core-contracts/entity-map";
import { Effect } from "effect";
import { existsSync, readFileSync } from "node:fs";

import type { CrawlMetadata } from "@/crawler/storage/types";

import { getProjectStoragePaths } from "@/controllers/report";
import {
  type Result,
  ok,
  err,
  commandError,
  ErrorCodes,
} from "@/controllers/types";
import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

/** One crawl's entity map, with the crawl it came from. */
export interface StoredEntityMap {
  crawl: CrawlMetadata;
  map: EntityMap;
  /**
   * A newer crawl that was passed over because it stored no entity rows.
   *
   * Present only when auto-selecting. It means the map shown is not from the
   * most recent audit, which the caller has to say out loud.
   */
  skipped?: { crawlId: string; startedAt: number };
}

/** A row of `squirrel entities --list`. */
export interface EntityMapListRow {
  crawlId: string;
  baseUrl: string;
  startedAt: number;
  pages: number;
  entities: number;
  stableIdShare: number;
  conflicts: number;
  retiredAt?: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rebuild an `EntityMap` from the three store tables plus the crawl's page list.
 *
 * The store is relational on purpose (#2091) so a query can ask "which pages
 * declare this entity" without parsing a blob, which means the document has to
 * be reassembled here. Three fields are approximations, and a caller that needs
 * them exactly should read the audit's own `-f json` report rather than this:
 *
 * - An edge's `pages` and a page's `references` are not stored, because nothing
 *   queries them. They come back EMPTY rather than invented. Nothing in the
 *   diff reads them; it derives an edge's evidence from its source entity's
 *   declaring pages, which are stored in full.
 * - A page's `entityCount` counts DECLARATIONS in the original document, and
 *   what survives the store is the set of distinct keys. The two differ only
 *   when one page declares the same entity twice, so this is a lower bound that
 *   is exact for every page that does not. `pagesWithoutEntities` is unaffected:
 *   zero declarations and zero distinct keys are the same page.
 *
 * `pages` comes from the crawl's own page table, NOT from `entity_occurrences`.
 * A page the crawl visited that declares nothing has no occurrence row, and
 * omitting it would make `pagesWithoutEntities` zero on every reconstructed map
 * and break the diff's not-crawled test.
 */
function reassembleMap(
  crawl: CrawlMetadata,
  rows: {
    nodes: Array<{
      key: string;
      id: string | null;
      types: string[];
      name: string | null;
      properties: Record<string, unknown>;
      occurrences: number;
      pageCount: number;
      conflicts: unknown[];
      danglingRefs: number;
      pageLocal: boolean;
    }>;
    edges: Array<{
      source: string;
      predicate: string;
      target: string;
      dangling: boolean;
      occurrences: number;
    }>;
    occurrences: Array<{ key: string; normalizedUrl: string }>;
  },
  pageUrls: string[]
): EntityMap {
  const pagesByKey = new Map<string, string[]>();
  const declaresByPage = new Map<string, string[]>();
  for (const row of rows.occurrences) {
    const forKey = pagesByKey.get(row.key);
    if (forKey) forKey.push(row.normalizedUrl);
    else pagesByKey.set(row.key, [row.normalizedUrl]);

    const forPage = declaresByPage.get(row.normalizedUrl);
    if (forPage) forPage.push(row.key);
    else declaresByPage.set(row.normalizedUrl, [row.key]);
  }

  const typeCounts = new Map<string, number>();
  let nodesWithStableId = 0;
  let pageLocalCount = 0;
  let nodesWithoutIdCount = 0;
  let conflictCount = 0;

  const nodes: EntityMapNode[] = rows.nodes.map((row) => {
    const allPages = (pagesByKey.get(row.key) ?? []).sort(compareStrings);
    const conflicts = row.conflicts as EntityMapConflict[];

    if (row.id) nodesWithStableId += 1;
    if (row.pageLocal) pageLocalCount += 1;
    if (conflicts.length > 0) conflictCount += 1;
    if (!row.id && allPages.length > 1) nodesWithoutIdCount += 1;
    for (const type of row.types) {
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + row.occurrences);
    }

    return {
      key: row.key,
      id: row.id,
      types: row.types,
      name: row.name,
      properties: row.properties as EntityMapProperties,
      occurrences: row.occurrences,
      pages: allPages.slice(0, ENTITY_MAP_PAGES_CAP),
      morePages: Math.max(0, allPages.length - ENTITY_MAP_PAGES_CAP),
      conflicts,
      danglingRefs: row.danglingRefs,
      pageLocal: row.pageLocal,
    };
  });

  const edges: EntityMapEdge[] = rows.edges.map((row) => ({
    source: row.source,
    predicate: row.predicate,
    target: row.target,
    dangling: row.dangling,
    occurrences: row.occurrences,
    // Not stored: no query needs them, and an empty list is honest about this
    // copy rather than a guess about the crawl.
    pages: [],
    morePages: 0,
  }));

  const pages: EntityMapPage[] = pageUrls.sort(compareStrings).map((url) => {
    const declares = (declaresByPage.get(url) ?? []).sort(compareStrings);
    return {
      url,
      declares,
      // Not stored, for the same reason as an edge's pages.
      references: [],
      // Distinct entities, not declarations: see the note above.
      entityCount: declares.length,
    };
  });

  return {
    format: ENTITY_MAP_FORMAT,
    version: ENTITY_MAP_VERSION,
    site: crawl.baseUrl,
    // The crawl's own timestamp: the document's `generatedAt` is not stored, and
    // inventing `now` would make two reads of one crawl look like two maps.
    generatedAt: new Date(crawl.startedAt).toISOString(),
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingCount: edges.filter((edge) => edge.dangling).length,
      pagesTotal: pages.length,
      pagesWithoutEntities: pages.filter((page) => page.declares.length === 0)
        .length,
      nodesWithStableId,
      stableIdShare: nodes.length === 0 ? 0 : nodesWithStableId / nodes.length,
      pageLocalCount,
      nodesWithoutIdCount,
      conflictCount,
      countsByType: Object.fromEntries(
        [...typeCounts.entries()].sort((a, b) => compareStrings(a[0], b[0]))
      ),
    },
    nodes,
    edges,
    pages,
  };
}

/**
 * Every project database that exists, newest crawl first within each.
 *
 * A single unreadable project must not hide the others, so a failure is
 * COLLECTED rather than thrown — but it is collected, not swallowed. Turning a
 * failed read into an empty result is how "your store is corrupt" becomes "this
 * site declares no entities", which is the same sentence a clean site gets.
 */
async function withEachProject<T>(
  fn: (storage: SQLiteStorage) => Promise<T[]>
): Promise<{ results: T[]; failures: string[] }> {
  const results: T[] = [];
  const failures: string[] = [];
  for (const dbPath of getProjectStoragePaths()) {
    if (!existsSync(dbPath)) continue;
    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      await Effect.runPromise(storage.init());
      results.push(...(await fn(storage)));
    } catch (error) {
      failures.push(`${dbPath}: ${String(error)}`);
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
  return { results, failures };
}

/** Crawls that can carry an entity map, newest first across every project. */
export async function listEntityMaps(
  limit = 10
): Promise<Result<EntityMapListRow[]>> {
  try {
    const { results: rows } = await withEachProject(async (storage) => {
      const crawls = await Effect.runPromise(
        storage.listCrawls().pipe(Effect.catchAll(() => Effect.succeed([])))
      );
      const out: EntityMapListRow[] = [];
      for (const crawl of crawls) {
        // A listing is a survey, so one unreadable crawl is skipped rather than
        // failing the table. `loadEntityMap` does the opposite, deliberately.
        const stored = await Effect.runPromise(
          storage
            .getEntityMapRows(crawl.id)
            .pipe(
              Effect.catchAll(() =>
                Effect.succeed({ nodes: [], edges: [], occurrences: [] })
              )
            )
        );
        const withId = stored.nodes.filter((node) => node.id !== null).length;
        out.push({
          crawlId: crawl.id,
          baseUrl: crawl.baseUrl,
          startedAt: crawl.startedAt,
          pages: crawl.stats.pagesTotal,
          entities: stored.nodes.length,
          stableIdShare:
            stored.nodes.length === 0 ? 0 : withId / stored.nodes.length,
          conflicts: stored.nodes.filter((node) => node.conflicts.length > 0)
            .length,
          ...(crawl.retiredAt !== undefined
            ? { retiredAt: crawl.retiredAt }
            : {}),
        });
      }
      return out;
    });

    rows.sort((a, b) => b.startedAt - a.startedAt);
    return ok(rows.slice(0, limit));
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Could not list entity maps: ${String(error)}`
      )
    );
  }
}

/**
 * Load one crawl's map. Without `crawlId`, the newest crawl that has one.
 *
 * "Newest that HAS one" rather than "newest": a crawl from before #2091, or one
 * whose audit failed before the map was written, has no entity rows, and
 * silently reporting zero entities for it would read as a site with no
 * structured data.
 *
 * That rule has a cost, and `skipped` is the receipt for it. Zero entity rows
 * is ALSO what a site declaring no JSON-LD at all looks like, and the store does
 * not record which of the two happened. So the newest audit is passed over on a
 * guess, and the caller is told which one, rather than quietly showing older
 * data as though it were current.
 */
export async function loadEntityMap(
  crawlId?: string
): Promise<Result<StoredEntityMap>> {
  try {
    const { results: candidates, failures } = await withEachProject(
      async (storage) => {
        const crawls = await Effect.runPromise(
          storage.listCrawls().pipe(Effect.catchAll(() => Effect.succeed([])))
        );
        const matches = crawlId
          ? crawls.filter(
              (crawl) => crawl.id === crawlId || crawl.id.startsWith(crawlId)
            )
          : crawls;

        const out: StoredEntityMap[] = [];
        let skipped: StoredEntityMap["skipped"];
        for (const crawl of [...matches].sort(
          (a, b) => b.startedAt - a.startedAt
        )) {
          // NOT caught: a failed read must not become an empty map, which is
          // the same document a site with no structured data produces.
          const rows = await Effect.runPromise(
            storage.getEntityMapRows(crawl.id)
          );
          if (rows.nodes.length === 0 && !crawlId) {
            skipped ??= { crawlId: crawl.id, startedAt: crawl.startedAt };
            continue;
          }
          const pageUrls = await Effect.runPromise(
            storage.getCrawlPageUrls(crawl.id)
          );
          out.push({
            crawl,
            map: reassembleMap(crawl, rows, pageUrls),
            ...(skipped ? { skipped } : {}),
          });
          // One per project is enough: the newest with a map.
          break;
        }
        return out;
      }
    );

    if (candidates.length === 0) {
      // A store that could not be opened is reported as a failure, never as
      // "nothing found" — those call for opposite next steps.
      if (failures.length > 0) {
        return err(
          commandError(
            ErrorCodes.CRAWL_ERROR,
            `Could not read the entity map: ${failures.join("; ")}`
          )
        );
      }
      return err(
        commandError(
          ErrorCodes.CRAWL_NOT_FOUND,
          crawlId
            ? `No crawl found matching "${crawlId}".`
            : 'No audit with an entity map found. Run "squirrel audit <url>" first.'
        )
      );
    }

    candidates.sort((a, b) => b.crawl.startedAt - a.crawl.startedAt);
    return ok(candidates[0]!);
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Could not read the entity map: ${String(error)}`
      )
    );
  }
}

/**
 * Fill in the fields of a v1 document that are DERIVED from the rest of it.
 *
 * `pageLocal` and the three summary counters were added to v1 after the first
 * maps were written, so a file exported by an earlier build is missing them and
 * fails validation outright. Rejecting it would be pedantry: every one of these
 * is recomputable from the nodes and edges with certainty, so this is restating
 * what the document already says, not guessing at what it does not.
 *
 * Deliberately narrow, in two ways. It touches only derived fields, and it only
 * fills fields that are ABSENT: a document that states `pageLocal: "bad"` or
 * `conflictCount: null` keeps what it said and fails validation, because
 * repairing a value the author supplied is no longer restating the document, it
 * is overruling it.
 */
function backfillDerivedFields(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object") return candidate;
  const map = candidate as Record<string, unknown>;
  if (!Array.isArray(map.nodes) || !Array.isArray(map.edges)) return candidate;
  if (!map.summary || typeof map.summary !== "object") return candidate;

  let pageLocalCount = 0;
  let nodesWithoutIdCount = 0;
  let conflictCount = 0;

  const nodes = map.nodes.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const node = raw as Record<string, unknown>;
    const types = Array.isArray(node.types) ? (node.types as string[]) : [];
    const name = typeof node.name === "string" ? node.name : null;
    const pages = Array.isArray(node.pages) ? node.pages : [];
    const morePages = typeof node.morePages === "number" ? node.morePages : 0;
    const conflicts = Array.isArray(node.conflicts) ? node.conflicts : [];
    const stated = "pageLocal" in node;
    const pageLocal = stated
      ? node.pageLocal
      : isPageLocalEntity(types[0] ?? "Thing", name);

    if (pageLocal === true) pageLocalCount += 1;
    if (conflicts.length > 0) conflictCount += 1;
    if (node.id === null && pages.length + morePages > 1)
      nodesWithoutIdCount += 1;

    return stated ? node : { ...node, pageLocal };
  });

  const summary = map.summary as Record<string, unknown>;
  // `in`, not `??`: an explicit null is a statement, and `??` would quietly
  // overwrite it with a plausible number and let a malformed file validate.
  const fill = (name: string, computed: number): Record<string, unknown> =>
    name in summary ? {} : { [name]: computed };
  return {
    ...map,
    nodes,
    summary: {
      ...summary,
      ...fill("pageLocalCount", pageLocalCount),
      ...fill("nodesWithoutIdCount", nodesWithoutIdCount),
      ...fill("conflictCount", conflictCount),
    },
  };
}

/**
 * Read an exported entity map from disk, the way `report --input` does.
 *
 * Validated rather than cast: the file is user-supplied, and a confident
 * misreading of a half-matching document is worse than saying what is wrong.
 */
export function loadEntityMapFile(path: string): Result<EntityMap> {
  if (!existsSync(path)) {
    return err(
      commandError(ErrorCodes.FILE_NOT_FOUND, `File not found: ${path}`)
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.INVALID_FORMAT,
        `${path} is not valid JSON: ${String(error)}`
      )
    );
  }

  // An audit's `-f json` report carries the map under `entities`; an exported
  // map is the document itself. Accept both, because both are things a user
  // has on disk and calling one of them invalid would be pedantry.
  const candidate =
    parsed && typeof parsed === "object" && "entities" in parsed
      ? (parsed as { entities: unknown }).entities
      : parsed;

  const upgraded = backfillDerivedFields(candidate);

  if (!Value.Check(EntityMapSchema, upgraded)) {
    const first = [...Value.Errors(EntityMapSchema, upgraded)][0];
    return err(
      commandError(
        ErrorCodes.INVALID_FORMAT,
        `${path} is not a ${ENTITY_MAP_FORMAT} v${ENTITY_MAP_VERSION} document` +
          (first ? ` (${first.path || "/"}: ${first.message})` : "")
      )
    );
  }
  // `Value.Check` is a guard, but it cannot narrow an `unknown` that came
  // through a property access, so restate the type the check just proved.
  return ok(upgraded as EntityMap);
}
