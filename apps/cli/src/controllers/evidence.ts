// `squirrel evidence` controller (repo#2301): reads one stored crawl into the
// evidence-bundle source model and exports it. Everything comes from the store,
// so nothing is fetched and no credit is spent.

import { Effect } from "effect";
import { existsSync } from "node:fs";

import { RULES_VERSION } from "@/audit/rules-version";
import {
  getProjectStoragePaths,
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
import {
  type BundleKind,
  type EvidenceSource,
  type Manifest,
  type SourceFinding,
  type SourcePage,
  ExportTargetError,
  exportEvidenceBundle,
} from "@/evidence/bundle";

import { version } from "../../package.json";

const PAGE_CHUNK = 50;

export interface ExportEvidenceOptions {
  crawlId?: string;
  dir: string;
  kind: BundleKind;
}

function* walkPages(
  storage: SQLiteStorage,
  crawlId: string
): Generator<SourcePage> {
  for (let offset = 0; ; offset += PAGE_CHUNK) {
    const chunk = Effect.runSync(
      storage.getPages(crawlId, { limit: PAGE_CHUNK, offset })
    );
    for (const page of chunk) {
      yield {
        url: page.url,
        normalizedUrl: page.normalizedUrl,
        finalUrl: page.finalUrl,
        depth: page.depth,
        parentUrl: page.parentUrl,
        status: page.status,
        contentType: page.contentType,
        sizeBytes: page.sizeBytes,
        loadTimeMs: page.loadTimeMs,
        fetchedAt: page.fetchedAt,
        headers: page.headers as unknown as Record<string, unknown>,
        requestHeaders: page.requestHeaders,
        fetcherId: page.fetcherId,
        fallbackReason: page.fallbackReason,
        redirectChain: page.redirectChain,
        html: page.html,
      };
    }
    if (chunk.length < PAGE_CHUNK) return;
  }
}

/** Export the audit matching `crawlId` (id or prefix), or the newest, to `dir`. */
export async function exportEvidence(
  options: ExportEvidenceOptions
): Promise<Result<{ manifest: Manifest; dir: string }>> {
  const candidates: Array<{ dbPath: string; id: string; startedAt: number }> =
    [];
  for (const dbPath of getProjectStoragePaths()) {
    if (!existsSync(dbPath)) continue;
    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      await Effect.runPromise(storage.init());
      for (const crawl of await Effect.runPromise(storage.listCrawls())) {
        const wanted =
          !options.crawlId ||
          crawl.id === options.crawlId ||
          crawl.id.startsWith(options.crawlId);
        if (wanted)
          candidates.push({ dbPath, id: crawl.id, startedAt: crawl.startedAt });
      }
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  const chosen = candidates[0];
  if (!chosen) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        options.crawlId
          ? `No audit found matching "${options.crawlId}".`
          : 'No audit found. Run "squirrel audit <url>" first.'
      )
    );
  }

  const storage = new SQLiteStorage(chosen.dbPath, getGlobalContentStore());
  try {
    await Effect.runPromise(storage.init());
    const crawl = await Effect.runPromise(storage.getCrawl(chosen.id));
    if (!crawl) {
      return err(
        commandError(
          ErrorCodes.CRAWL_NOT_FOUND,
          `Audit ${chosen.id} disappeared.`
        )
      );
    }
    if (crawl.retiredAt !== undefined) {
      return err(
        commandError(
          ErrorCodes.CRAWL_NOT_READY,
          `Audit ${reportUnavailableReason(crawl)}: its findings are gone, so there is nothing left to archive.`
        )
      );
    }
    const byRule = await Effect.runPromise(
      storage.getRuleResultsByRuleId(crawl.id)
    );
    const findings: SourceFinding[] = [];
    for (const [ruleId, checks] of byRule) {
      for (const check of checks) {
        findings.push({
          ruleId,
          name: check.name,
          status: check.status,
          message: check.message,
          pageUrl: check.pageUrl,
          value: check.value,
          expected: check.expected,
          skipReason: check.skipReason,
          observation: check.observation,
          items: check.items?.map((i) => ({
            id: i.id,
            label: i.label,
            snippet: i.snippet,
            selector: i.selector,
            sourcePages: i.sourcePages,
          })),
        });
      }
    }
    const scripts = await Effect.runPromise(storage.getCrawlScripts(crawl.id));
    const frontier = await Effect.runPromise(
      storage.getAllFrontierEntries(crawl.id)
    );
    const source: EvidenceSource = {
      crawl: {
        id: crawl.id,
        baseUrl: crawl.baseUrl,
        seedUrl: crawl.seedUrl,
        originalUrl: crawl.originalUrl,
        startedAt: crawl.startedAt,
        completedAt: crawl.completedAt,
        status: crawl.status,
        retiredAt: crawl.retiredAt,
        config: crawl.config as unknown as Record<string, unknown>,
        stats: crawl.stats as unknown as Record<string, unknown>,
        scanScope: crawl.scanScope,
      },
      scanner: { name: "squirrel", version, rulesRevision: RULES_VERSION },
      pages: walkPages(storage, crawl.id),
      scripts: (function* () {
        for (const script of scripts) {
          const body =
            script.status === "stored" && !script.evicted
              ? Effect.runSync(storage.getCrawlScriptBody(crawl.id, script.url))
              : null;
          yield {
            url: script.url,
            finalUrl: script.finalUrl,
            sizeBytes: script.sizeBytes,
            status: script.status,
            skipReason: script.skipReason,
            sourcePages: script.sourcePages,
            evicted: script.evicted,
            body,
          };
        }
      })(),
      scriptsSummary: await Effect.runPromise(
        storage.getCrawlScriptsSummary(crawl.id)
      ),
      failures: frontier
        .filter((f) => f.status === "failed" || f.status === "skipped")
        .map((f) => ({
          url: f.rawUrl,
          status: f.status,
          reason: f.reason,
          depth: f.depth,
          parentUrl: f.parentUrl,
          source: f.source,
          retryCount: f.retryCount,
        })),
      findings,
    };
    const result = exportEvidenceBundle(source, options.dir, {
      kind: options.kind,
    });
    return ok(result);
  } catch (error) {
    if (error instanceof ExportTargetError) {
      return err(commandError(ErrorCodes.FILE_EXISTS, error.message));
    }
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Could not export evidence: ${String(error)}`
      )
    );
  } finally {
    await Effect.runPromise(
      storage.close().pipe(Effect.catchAll(() => Effect.void))
    );
  }
}
