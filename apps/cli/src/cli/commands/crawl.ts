// squirrel crawl <url> - crawl only (no analysis)

import type { ResolvedAuditSettings } from "@squirrelscan/core-contracts/audit-levels";

import { defineCommand } from "citty";
import { platform } from "node:os";

import { getGlobalConfigPath, loadConfig } from "@/config";
import { MAX_PAGES_CAP } from "@/constants";
import { runCrawl, type CrawlerEvent } from "@/controllers/crawl";
import {
  pageLimitNotice,
  resolvePageLimit,
  type PageLimit,
} from "@/lib/page-limit";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { loadUserSettings, updateSettings } from "@/self/settings";
import { CWD_UNAVAILABLE, cwdOr } from "@/utils/cwd";
import { logger, setLogInterceptor } from "@/utils/logger";
import { getProjectNameContext, parseUserUrl } from "@/utils/url";

import { version as packageVersion } from "../../../package.json";
import {
  AUDIT_LEVELS,
  type AuditLevel,
  configMaxPagesChoice,
  levelBannerValue,
  levelCoverageMode,
  levelHelpList,
  levelMaxPages,
  parseAuditLevel,
  readLevelFlag,
  resolveLocalAuditLevel,
  unknownLevelMessage,
} from "../audit-level";
import {
  printHeader,
  printUpdateNotification,
  shouldShowAutoUpdateDisabledReminder,
  printAutoUpdateDisabledReminder,
  promptForUpdate,
  printFooter,
} from "../banner";
import { printDatabaseLockWarningIfNeeded } from "../db-lock-warning";
import { fmt, pageLimitHint } from "../format";
import { createProgress } from "../progress";
import { promptForProjectName } from "../prompt";
import { parsePositiveIntFlag } from "./audit";

/** What `squirrel crawl` crawls: its level and page budget, or why it refused. */
export type CrawlBudget =
  | {
      ok: true;
      level: AuditLevel;
      /** The crawler's coverage mode for the level's crawl strategy. */
      coverageMode: AuditLevel;
      pageLimit: PageLimit;
      resolved: ResolvedAuditSettings;
    }
  | { ok: false; error: string };

/**
 * Resolve the crawl's level and page budget: --level / -C > [crawler] coverage
 * > quick, and --max-pages > a non-default [crawler] max_pages > the level's
 * budget, capped at the hard limit. Shared parsing with `audit`, so `fast` is
 * quick here too, and a value that is not a level is refused instead of
 * becoming a NaN page cap and an unbounded crawl.
 */
export function resolveCrawlBudget(input: {
  level?: unknown;
  coverage?: unknown;
  maxPages?: string;
  config: { crawler: { coverage?: AuditLevel; max_pages: number } };
}): CrawlBudget {
  const flag = readLevelFlag(input);
  if (!flag.ok) return { ok: false, error: flag.error };
  const raw = flag.raw ?? input.config.crawler.coverage ?? "quick";
  const level = parseAuditLevel(raw);
  if (level === null) return { ok: false, error: unknownLevelMessage(raw) };

  let requested: number;
  if (input.maxPages !== undefined) {
    requested = Number.parseInt(input.maxPages, 10);
    if (!Number.isInteger(requested) || requested < 1) {
      return {
        ok: false,
        error: `--max-pages must be a positive integer (got '${input.maxPages}').`,
      };
    }
  } else {
    // A config that sets max_pages = 100 (the schema default) reads as unset.
    requested = configMaxPagesChoice(input.config) ?? levelMaxPages(level);
  }
  const pageLimit = resolvePageLimit(requested);
  const resolved = resolveLocalAuditLevel(level, {
    pages: pageLimit.effective,
  });
  return {
    ok: true,
    level,
    coverageMode: levelCoverageMode(resolved),
    pageLimit,
    resolved,
  };
}

export const crawl = defineCommand({
  meta: {
    name: "crawl",
    description: "Crawl a website (no analysis)",
  },
  args: {
    url: {
      type: "positional",
      description: "URL to crawl",
      required: true,
    },
    "max-pages": {
      type: "string",
      alias: "m",
      description: `Maximum pages to crawl (default by level: ${AUDIT_LEVELS.map((l) => `${l} ${levelMaxPages(l)}`).join(", ")}; cap ${MAX_PAGES_CAP})`,
    },
    concurrency: {
      type: "string",
      description:
        "Global crawl worker pool size (overrides [crawler] concurrency; suppresses the localhost fast path)",
    },
    "per-host": {
      type: "string",
      description:
        "Max concurrent requests per host (overrides [crawler] per_host_concurrency; suppresses the localhost fast path)",
    },
    level: {
      type: "string",
      description: `Audit level, which sets the crawl's page budget and strategy (default: quick): ${levelHelpList()}`,
    },
    coverage: {
      type: "string",
      alias: "C",
      description: "Old name for --level, still accepted (fast = quick)",
    },
    refresh: {
      type: "boolean",
      alias: "r",
      description: "Ignore cache, fetch all pages fresh",
    },
    "fresh-ua": {
      type: "boolean",
      description:
        "Re-roll this project's pinned random user-agent (the new one is pinned for later runs)",
    },
    resume: {
      type: "boolean",
      description: "Resume interrupted crawl for this domain",
    },
  },
  async run({ args }) {
    const commandStart = Date.now();
    logger.commandStart("crawl", {
      url: args.url,
      maxPages: args["max-pages"],
      refresh: args.refresh,
      cwd: cwdOr(CWD_UNAVAILABLE),
      version: packageVersion,
      bunVersion: Bun.version,
      platform: platform(),
      arch: process.arch,
    });

    let commandResult: "success" | "error" = "success";
    try {
      const settings = loadUserSettings();
      warnIfSessionUnreadable(settings);
      const channel = settings.ok ? settings.data.channel : "stable";
      const config = await loadConfig(getGlobalConfigPath());

      // Level and page budget, validated: an unknown level or a non-numeric
      // --max-pages used to reach the crawler as an `undefined`/NaN cap, which
      // no `pages >= cap` check ever stops (an unbounded crawl). Clamped and
      // reported identically to `audit` (#1909).
      const budget = resolveCrawlBudget({
        level: args.level,
        coverage: args.coverage,
        maxPages: args["max-pages"],
        config,
      });
      if (!budget.ok) {
        console.error(`${fmt.red("Error:")} ${budget.error}`);
        process.exitCode = 1;
        return;
      }
      const { coverageMode, pageLimit } = budget;
      const maxPages = pageLimit.effective;
      const crawlClampNotice = pageLimitNotice(pageLimit);
      if (crawlClampNotice) console.error(fmt.yellow(crawlClampNotice));

      // --concurrency / --per-host: positive-integer crawl parallelism
      // overrides, shared with `audit` (#1068/#1084).
      const concurrency = parsePositiveIntFlag(
        args.concurrency,
        "--concurrency"
      );
      const perHostConcurrency = parsePositiveIntFlag(
        args["per-host"],
        "--per-host"
      );
      if (concurrency === null || perHostConcurrency === null) {
        process.exitCode = 1;
        return;
      }

      // Check if local address needs custom project name
      let projectName: string | undefined;
      const urlParsed = parseUserUrl(args.url);
      if (urlParsed.ok) {
        const nameContext = getProjectNameContext(
          urlParsed.url,
          config.project.name
        );
        if (nameContext.needsCustomName && process.stdout.isTTY) {
          projectName = await promptForProjectName(
            nameContext.suggestedName,
            urlParsed.url
          );
        } else if (config.project.name) {
          // Use config name when available (skips prompt)
          projectName = config.project.name;
        }
      }

      printHeader(channel);
      if (settings.ok) {
        // See audit.ts: the auto-updated notice belongs to the run (#170).
        printUpdateNotification(settings.data);
        if (shouldShowAutoUpdateDisabledReminder(settings.data)) {
          updateSettings({
            auto_update_disabled_reminder: new Date().toISOString(),
          });
          printAutoUpdateDisabledReminder();
        }
        await promptForUpdate(settings.data, {}); // crawl is always interactive
      }
      console.log(`Crawling: ${args.url}`);
      console.log(`Level: ${levelBannerValue(budget.resolved)}`);
      if (args.refresh) {
        console.log("Mode: Fresh crawl (ignoring cache)");
      }
      console.log("");

      const startTime = Date.now();
      const progress = createProgress("Initializing");

      // Route logs through progress to keep progress line at bottom
      setLogInterceptor((msg) => progress.log(msg));

      let pagesCount = 0;
      let pendingCount = 0;
      let discoveredCount = 0;
      let sitemapUrlCount = 0;
      let currentUrl = "";
      let phase: "init" | "crawling" = "init";
      let result: Awaited<ReturnType<typeof runCrawl>>;

      try {
        result = await runCrawl({
          url: args.url,
          maxPages,
          coverageMode,
          refresh: args.refresh,
          freshUa: args["fresh-ua"],
          projectName,
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(perHostConcurrency !== undefined ? { perHostConcurrency } : {}),
          onEvent: (event: CrawlerEvent) => {
            switch (event.type) {
              case "started":
                progress.log(`New crawl: ${event.baseUrl}`);
                break;
              case "resumed":
                progress.log("Resuming interrupted crawl");
                break;
              case "url:enqueued":
                // Count sitemap URLs (logged once at end of init phase)
                if (event.source === "sitemap") {
                  sitemapUrlCount++;
                }
                break;
              case "page:fetching":
                // Switch to "Crawling" on first page fetch
                // This keeps "Initializing" during redirect/robots/sitemap discovery
                if (phase === "init") {
                  // Log sitemap summary if any URLs found
                  if (sitemapUrlCount > 0) {
                    progress.log(`Found ${sitemapUrlCount} URLs in sitemap`);
                  }
                  progress.stop();
                  progress.start("Crawling");
                  phase = "crawling";
                }
                currentUrl = event.url;
                progress.update(pagesCount, maxPages, currentUrl);
                break;
              case "page:fetched":
              case "page:failed":
              case "page:unchanged":
                pagesCount++;
                progress.update(pagesCount, maxPages, currentUrl);
                break;
              case "url:discovered":
                discoveredCount++;
                break;
              case "progress":
                pagesCount =
                  event.fetched +
                  event.failed +
                  event.skipped +
                  event.unchanged;
                pendingCount = event.pending;
                // Show pending + discovered in queue info
                const queueInfo =
                  pendingCount > 0
                    ? ` [${pendingCount} queued, ${discoveredCount} found]`
                    : discoveredCount > 0
                      ? ` [${discoveredCount} found]`
                      : "";
                progress.update(pagesCount, maxPages, currentUrl + queueInfo);
                break;
            }
          },
        });
      } finally {
        // Always clean up progress and log interceptor
        setLogInterceptor(undefined);
        progress.stop();
      }

      if (!result.ok) {
        commandResult = "error";
        logger.error("crawl error", { error: result.error.message });
        console.log(`✗ ${result.error.message}`);
        printDatabaseLockWarningIfNeeded(result.error.message);
        process.exitCode = 1;
        return;
      }

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `✓ Crawled ${result.data.pagesCount} pages in ${durationSec}s`
      );
      // Surface the page-cap override when the limit was the binding constraint. #124
      const limitHint = pageLimitHint(
        result.data.limitReached,
        maxPages,
        budget.resolved.settings.crawlStrategy === "all"
      );
      if (limitHint) console.log(fmt.yellow(limitHint));

      console.log("");
      console.log(`Crawl ID: ${result.data.crawlId.slice(0, 8)}`);
      console.log("");
      console.log("Run 'squirrel analyze' to run audit rules.");

      // Print footer
      printFooter();
    } catch (e) {
      commandResult = "error";
      logger.error("crawl exception", { error: (e as Error).message });
      throw e;
    } finally {
      logger.commandEnd("crawl", commandResult, Date.now() - commandStart);
      await logger.flush();
    }
  },
});
