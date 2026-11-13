// The rows of the page map (#701, repo#4172), read from an open crawl store.
//
// Everything in a row is already stored by the crawl (page features, the link graph in the pages'
// stored parse, the rule results), so building it costs no request and no credit. One reader
// serves `squirrel pages`, the CLI publish and the cloud runtime, so the local table and the
// hosted `pageMap` carry the same rows.

import type { PageFeatureRow } from "@squirrelscan/core-contracts";
import type { SQLiteStorage } from "@squirrelscan/crawler";

import {
  PAGE_MAP_FLAG_RULES,
  PAGE_MAP_RULE_IDS,
  type PageMapRow,
} from "@squirrelscan/report/page-map";
import { normalizeUrl } from "@squirrelscan/utils";
import { Effect } from "effect";

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

/**
 * The page rows of audit `crawl`, read from an open store. Shared by `squirrel pages` and the
 * publish path, so the hosted `pageMap` carries the rows the local table shows.
 */
export function readPageMapRows(
  storage: SQLiteStorage,
  crawl: { id: string }
): Effect.Effect<PageMapRow[], unknown> {
  return Effect.gen(function* () {
    const links = yield* readLinkCounts(storage, crawl.id);
    const flagged = yield* storage.getFlaggedPages(crawl.id, PAGE_MAP_RULE_IDS);
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
          externalDomains: links.externalHosts.get(page.normalizedUrl) ?? [],
          loadTimeMs: page.loadTimeMs ?? null,
          lastModified: page.lastModified ?? null,
          flags: [...flags].sort(),
        });
      }
      if (pages.length < BATCH) break;
    }
    return out;
  });
}

