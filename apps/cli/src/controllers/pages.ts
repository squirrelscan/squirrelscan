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

/** The link fields the page map reads out of a page's stored parse. */
interface StoredLink {
  url?: string;
  isInternal?: boolean;
}

/** The links of a stored `parsedData` blob; none for a page that was not parsed. */
function storedLinks(parsedData: string | null): StoredLink[] {
  if (!parsedData) return [];
  try {
    const parsed = JSON.parse(parsedData) as { links?: StoredLink[] };
    return Array.isArray(parsed.links) ? parsed.links : [];
  } catch {
    return [];
  }
}

interface LinkCounts {
  internalOut: Map<string, number>;
  externalOut: Map<string, number>;
  externalHosts: Map<string, string[]>;
  inbound: Map<string, number>;
}

/**
 * Link counts per page from the pages' stored parse, which is where the internal link graph
 * lives (`link_appearances` holds external links only). Out-links count every link on the page;
 * in-links count each crawled page that links here once, however many times it does; a page
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
    for (let offset = 0; ; offset += BATCH) {
      const batch = yield* storage.getPageLinkRows(crawlId, {
        limit: BATCH,
        offset,
      });
      for (const page of batch) {
        const targets = new Set<string>();
        let internal = 0;
        let external = 0;
        for (const link of storedLinks(page.parsedData)) {
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
            const target = normalizeUrl(resolved.href);
            if (target === page.normalizedUrl) continue;
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
    return { internalOut, externalOut, externalHosts, inbound };
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
            const key = page.normalizedUrl;
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
              wordCount: f?.wordCount ?? null,
              schemaTypes: f?.schemaTypes ?? [],
              inlinks: links.inbound.get(key) ?? 0,
              internalOutlinks: links.internalOut.get(key) ?? 0,
              externalOutlinks: links.externalOut.get(key) ?? 0,
              externalDomains: links.externalHosts.get(key) ?? [],
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
