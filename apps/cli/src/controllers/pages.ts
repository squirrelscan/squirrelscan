// `squirrel pages` controller (#701): reads the page map of a stored audit out of the project
// store. Everything is already stored by the crawl (the pages, their features, the link graph and
// the rule results), so nothing is fetched or recomputed.

import type { PageFeatureRow } from "@squirrelscan/core-contracts";

import {
  PAGE_MAP_FLAG_RULES,
  PAGE_MAP_RULE_IDS,
  type PageMapRow,
} from "@squirrelscan/report";
import { normalizeUrl } from "@squirrelscan/utils";
import { Effect } from "effect";
import { existsSync } from "node:fs";

import type { CrawlMetadata } from "@/crawler/storage/types";

import {
  getProjectStoragePaths,
  isReportRenderable,
  reportUnavailableReason,
} from "@/controllers/report";
import {
  type Result,
  ok,
  err,
  commandError,
  ErrorCodes,
} from "@/controllers/types";
import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

/** One audit's page map, with the audit it came from. */
export interface StoredPageMap {
  crawl: CrawlMetadata;
  rows: PageMapRow[];
}

/** Pages read per batch, so a 10,000 page audit is never one resident array. */
const BATCH = 500;

/** What the page map reads out of a page's stored parse. */
interface StoredParse {
  links?: Array<{ url?: string; isInternal?: boolean }>;
  h1?: { texts?: unknown };
  headings?: { headings?: unknown };
  schemas?: { _schemas?: unknown };
}

function storedParse(parsedData: string | null): StoredParse {
  if (!parsedData) return {};
  try {
    const parsed = JSON.parse(parsedData) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as StoredParse)
      : {};
  } catch {
    return {};
  }
}

/** Most `@id` values kept per page, and the longest one: a page can declare thousands. */
const MAX_SCHEMA_IDS = 20;
const MAX_SCHEMA_ID_CHARS = 500;

/** The first h1, the number of headings and the JSON-LD `@id` values of one parsed page. */
function pageFacts(parse: StoredParse): {
  h1: string | null;
  headingCount: number | null;
  schemaIds: string[];
} {
  const texts = parse.h1?.texts;
  const first = Array.isArray(texts)
    ? texts.find((t) => typeof t === "string" && t.length > 0)
    : undefined;
  const headings = parse.headings?.headings;
  const nodes = parse.schemas?._schemas;
  const ids = new Set<string>();
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const id = (node as { "@id"?: unknown } | null)?.["@id"];
      if (
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= MAX_SCHEMA_ID_CHARS
      )
        ids.add(id);
      if (ids.size >= MAX_SCHEMA_IDS) break;
    }
  }
  return {
    h1: typeof first === "string" ? first : null,
    headingCount: Array.isArray(headings) ? headings.length : null,
    schemaIds: [...ids],
  };
}

interface LinkCounts {
  internalOut: Map<string, number>;
  externalOut: Map<string, number>;
  externalHosts: Map<string, string[]>;
  inbound: Map<string, number>;
  /** Per page, by stored url. */
  facts: Map<string, ReturnType<typeof pageFacts>>;
}

/**
 * The page's key in the link counts: the same `normalizeUrl` the orphan and internal-link rules
 * key their counts with, applied to the page's stored URL AND to every link target. The stored
 * url keeps a trailing slash and a query string, the normalised form drops them, so keying one
 * side with each loses every link to such a page. Pages that differ only by those collapse to one
 * key and share their counts, as they do in the rules.
 */
const linkKey = (url: string): string => normalizeUrl(url);

/**
 * Link counts and per-page facts from the pages' stored parse, which is where the internal link
 * graph lives (`link_appearances` holds external links only). Out-links count every link on the
 * page; in-links count each crawled page that links here once, however many times it does; a page
 * linking to itself is neither. Read a batch at a time.
 */
function readLinkCounts(
  storage: SQLiteStorage,
  crawlId: string
): Effect.Effect<LinkCounts, unknown> {
  return Effect.gen(function* () {
    const internalOut = new Map<string, number>();
    const externalOut = new Map<string, number>();
    const hosts = new Map<string, Set<string>>();
    const inbound = new Map<string, number>();
    const facts = new Map<string, ReturnType<typeof pageFacts>>();
    for (let offset = 0; ; offset += BATCH) {
      const batch = yield* storage.getPageLinkRows(crawlId, {
        limit: BATCH,
        offset,
      });
      for (const page of batch) {
        const parse = storedParse(page.parsedData);
        facts.set(page.normalizedUrl, pageFacts(parse));
        const own = linkKey(page.normalizedUrl);
        const targets = new Set<string>();
        let internal = 0;
        let external = 0;
        for (const link of Array.isArray(parse.links) ? parse.links : []) {
          if (typeof link.url !== "string" || link.url.length === 0) continue;
          let resolved: URL;
          try {
            resolved = new URL(link.url, page.normalizedUrl);
          } catch {
            continue;
          }
          if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
            continue;
          if (link.isInternal) {
            const target = linkKey(resolved.href);
            if (target === own) continue;
            internal++;
            targets.add(target);
          } else {
            external++;
            const known = hosts.get(page.normalizedUrl);
            if (known) known.add(resolved.hostname);
            else hosts.set(page.normalizedUrl, new Set([resolved.hostname]));
          }
        }
        if (internal > 0) internalOut.set(page.normalizedUrl, internal);
        if (external > 0) externalOut.set(page.normalizedUrl, external);
        for (const target of targets)
          inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
      if (batch.length < BATCH) break;
    }
    const externalHosts = new Map<string, string[]>();
    for (const [page, set] of hosts) externalHosts.set(page, [...set].sort());
    return { internalOut, externalOut, externalHosts, inbound, facts };
  });
}

/** The newest renderable audit matching `crawlId` (an id or prefix), in any project; the newest overall without one. */
async function findCrawl(
  crawlId: string | undefined
): Promise<
  Result<{ crawl: CrawlMetadata; dbPath: string; warnings: string[] }>
> {
  const warnings: string[] = [];
  const matches: Array<{ crawl: CrawlMetadata; dbPath: string }> = [];
  let sawUnrenderable: CrawlMetadata | undefined;
  for (const dbPath of getProjectStoragePaths()) {
    if (!existsSync(dbPath)) continue;
    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      await Effect.runPromise(storage.init());
      const crawls = await Effect.runPromise(storage.listCrawls());
      for (const crawl of crawls) {
        if (crawlId && !(crawl.id === crawlId || crawl.id.startsWith(crawlId)))
          continue;
        if (isReportRenderable(crawl)) matches.push({ crawl, dbPath });
        else sawUnrenderable ??= crawl;
      }
    } catch (error) {
      // One unreadable project must not hide the others, and must not hide itself either.
      warnings.push(`${dbPath}: ${String(error)}`);
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
  if (matches.length === 0) {
    if (warnings.length > 0) {
      return err(
        commandError(
          ErrorCodes.CRAWL_ERROR,
          `Could not read the page map: ${warnings.join("; ")}`
        )
      );
    }
    if (crawlId && sawUnrenderable) {
      return err(
        commandError(
          ErrorCodes.CRAWL_NOT_READY,
          `Audit ${reportUnavailableReason(sawUnrenderable)}: ${sawUnrenderable.id}`
        )
      );
    }
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        crawlId
          ? `No audit found matching "${crawlId}".`
          : 'No audit found. Run "squirrel audit <url>" first.'
      )
    );
  }
  matches.sort((a, b) => b.crawl.startedAt - a.crawl.startedAt);
  return ok({ ...matches[0]!, warnings });
}

/** Load the page map of audit `crawlId` (id or prefix), or the newest audit. */
export async function loadPageMap(
  crawlId?: string
): Promise<Result<StoredPageMap & { warnings: string[] }>> {
  const found = await findCrawl(crawlId);
  if (!found.ok) return found;
  const { crawl, dbPath, warnings } = found.data;
  const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
  try {
    await Effect.runPromise(storage.init());
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const links = yield* readLinkCounts(storage, crawl.id);
        const flagged = yield* storage.getFlaggedPages(
          crawl.id,
          PAGE_MAP_RULE_IDS
        );
        // Each rule's pages, by the flag it sets.
        const flagsByUrl = new Map<string, Set<string>>();
        for (const [ruleId, urls] of flagged) {
          const flag = PAGE_MAP_FLAG_RULES[ruleId];
          if (!flag) continue;
          for (const url of urls) {
            const known = flagsByUrl.get(url);
            if (known) known.add(flag);
            else flagsByUrl.set(url, new Set([flag]));
          }
        }

        // The stored features, by normalized url, a batch at a time.
        const features = new Map<string, PageFeatureRow>();
        for (let after: string | undefined; ; ) {
          const batch = yield* storage.getPageFeaturesPage(crawl.id, {
            ...(after !== undefined ? { after } : {}),
            limit: BATCH,
          });
          for (const row of batch) features.set(row.normalizedUrl, row);
          if (batch.length < BATCH) break;
          after = batch[batch.length - 1]!.normalizedUrl;
        }

        const out: PageMapRow[] = [];
        for (let offset = 0; ; offset += BATCH) {
          const pages = yield* storage.getPagesWithoutBodies(crawl.id, {
            limit: BATCH,
            offset,
          });
          for (const page of pages) {
            const f = features.get(page.normalizedUrl);
            const flags = new Set<string>([
              ...(flagsByUrl.get(page.normalizedUrl) ?? []),
              ...(flagsByUrl.get(page.url) ?? []),
            ]);
            if (f?.robotsNoindex) flags.add("noindex");
            if (f && f.status < 400 && f.schemaTypes.length === 0)
              flags.add("no-schema");
            const key = linkKey(page.normalizedUrl);
            const parsed = links.facts.get(page.normalizedUrl);
            const title = f?.title ?? null;
            const description = f?.description ?? null;
            out.push({
              url: page.url,
              finalUrl: page.finalUrl || page.url,
              status: page.status,
              depth: f?.depth ?? page.depth,
              canonical: f?.canonical ?? null,
              noindex: f?.robotsNoindex ?? false,
              title,
              titleLength: title?.length ?? 0,
              description,
              descriptionLength: description?.length ?? 0,
              h1Count: f?.reportScalars?.h1Count ?? null,
              h1: parsed?.h1 ?? null,
              headingCount: parsed?.headingCount ?? null,
              schemaIds: parsed?.schemaIds ?? [],
              wordCount: f?.wordCount ?? null,
              schemaTypes: f?.schemaTypes ?? [],
              inlinks: links.inbound.get(key) ?? 0,
              internalOutlinks: links.internalOut.get(page.normalizedUrl) ?? 0,
              externalOutlinks: links.externalOut.get(page.normalizedUrl) ?? 0,
              externalDomains:
                links.externalHosts.get(page.normalizedUrl) ?? [],
              loadTimeMs: page.loadTimeMs ?? null,
              lastModified: page.lastModified ?? null,
              flags: [...flags].sort(),
            });
          }
          if (pages.length < BATCH) break;
        }
        return out;
      })
    );
    return ok({ crawl, rows, warnings });
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Could not read the page map: ${String(error)}`
      )
    );
  } finally {
    await Effect.runPromise(
      storage.close().pipe(Effect.catchAll(() => Effect.void))
    );
  }
}

/**
 * The two audits of a `--diff`, older first.
 *
 * Two ids name both sides (across sites if you like). One id names the newer side and the older
 * one is the audit of the same site before it; none compares the latest audit with the one
 * before it. The store holds every project, so "the two newest audits" would routinely be two
 * different sites, and diffing those reports one site's whole page set as added and the other's
 * as removed.
 */
export async function loadPageMapPair(
  crawlIds: readonly string[]
): Promise<
  Result<{ older: StoredPageMap; newer: StoredPageMap; warnings: string[] }>
> {
  if (crawlIds.length >= 2) {
    const a = await loadPageMap(crawlIds[0]);
    if (!a.ok) return a;
    const b = await loadPageMap(crawlIds[1]);
    if (!b.ok) return b;
    const [older, newer] =
      a.data.crawl.startedAt <= b.data.crawl.startedAt
        ? [a.data, b.data]
        : [b.data, a.data];
    return ok({
      older,
      newer,
      warnings: [...a.data.warnings, ...b.data.warnings],
    });
  }
  const newer = await loadPageMap(crawlIds[0]);
  if (!newer.ok) return newer;
  const previous = await findPreviousCrawl(newer.data.crawl);
  if (!previous.ok) return previous;
  const older = await loadPageMap(previous.data.id);
  if (!older.ok) return older;
  return ok({
    older: older.data,
    newer: newer.data,
    warnings: [...newer.data.warnings, ...older.data.warnings],
  });
}

/** The renderable audit of the same site that ran just before `crawl`. */
async function findPreviousCrawl(
  crawl: CrawlMetadata
): Promise<Result<CrawlMetadata>> {
  let best: CrawlMetadata | undefined;
  // The newest earlier audit that cannot be read (reclaimed, still running): named in the message
  // when it is the only earlier one, so "only one has been run" is never said wrongly.
  let skipped: CrawlMetadata | undefined;
  for (const dbPath of getProjectStoragePaths()) {
    if (!existsSync(dbPath)) continue;
    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      await Effect.runPromise(storage.init());
      for (const other of await Effect.runPromise(storage.listCrawls())) {
        if (
          other.baseUrl !== crawl.baseUrl ||
          other.startedAt >= crawl.startedAt
        )
          continue;
        if (!isReportRenderable(other)) {
          if (!skipped || other.startedAt > skipped.startedAt) skipped = other;
        } else if (!best || other.startedAt > best.startedAt) {
          best = other;
        }
      }
    } catch (error) {
      return err(
        commandError(
          ErrorCodes.CRAWL_ERROR,
          `Could not read the page map: ${dbPath}: ${String(error)}`
        )
      );
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
  if (!best && skipped) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        `The previous audit of ${crawl.baseUrl} (${skipped.id.slice(0, 8)}) ${reportUnavailableReason(skipped)}, so there is nothing to compare with. Run "squirrel audit ${crawl.baseUrl}" again, or name both audits.`
      )
    );
  }
  if (!best) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        `Need two audits of ${crawl.baseUrl} to compare; only one has been run. Run "squirrel audit ${crawl.baseUrl}" again, or name both: squirrel pages --diff --crawl <older> --crawl <newer>`
      )
    );
  }
  return ok(best);
}
