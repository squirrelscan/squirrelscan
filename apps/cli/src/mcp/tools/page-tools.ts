// The `list_pages` tool on the CLI MCP server (#701): the page map of a stored audit.
//
// Local and free like the entity tools: it reads the project store, so it needs no auth and costs
// no credits. Rows have the same shape as `squirrel pages -f json`, filtered by the same code
// (`filterPageMap`) and paged like `list_entities` (`limit`, `offset`, `hasMore`).

import type { McpServer } from "@modelcontextprotocol/server";

import {
  PAGE_MAP_DUPLICATE,
  PAGE_MAP_MISSING,
  filterPageMap,
  type PageMapFilters,
} from "@squirrelscan/report";
import { z } from "zod";

import { loadPageMap } from "@/controllers/pages";

import { errorResult, jsonResult } from "../result";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The store read, injectable so a test can serve rows without a project store. */
export type PageMapLoader = typeof loadPageMap;

export function registerPageTools(
  server: McpServer,
  load: PageMapLoader = loadPageMap
): void {
  server.registerTool(
    "list_pages",
    {
      title: "List the pages of an audit",
      description:
        "One row per crawled page of a stored audit (the latest by default): url, final url, status, canonical, noindex, title and length, description and length, h1, heading count, word count, JSON-LD types and @ids, internal links in and out, external links out with their domains, crawl depth, response time and flags that reuse the audit's rule results. Filters combine. Paged with limit, offset and hasMore. Reads the local project store: no audit is run and no credits are used.",
      inputSchema: z.object({
        run_id: z
          .string()
          .optional()
          .describe("Audit id or prefix. Defaults to the latest audit."),
        missing: z
          .array(z.enum(PAGE_MAP_MISSING))
          .optional()
          .describe("Only pages missing any of these."),
        duplicate: z
          .array(z.enum(PAGE_MAP_DUPLICATE))
          .optional()
          .describe("Only pages the audit flags as duplicate."),
        too_long: z
          .boolean()
          .optional()
          .describe("Only pages with an overlong title or description."),
        orphan: z
          .boolean()
          .optional()
          .describe("Only pages the audit flags as orphans."),
        section: z
          .string()
          .optional()
          .describe("Only pages under this URL path, e.g. /blog."),
        page: z
          .array(z.string())
          .optional()
          .describe("Only pages whose URL contains any of these."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(
            `Rows per call (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`
          ),
        offset: z.number().int().min(0).optional().describe("Rows to skip."),
      }),
    },
    async (args) => {
      const loaded = await load(args.run_id);
      if (!loaded.ok) return errorResult(loaded.error.message);

      const filters: PageMapFilters = {};
      if (args.missing?.length) filters.missing = args.missing;
      if (args.duplicate?.length) filters.duplicate = args.duplicate;
      if (args.too_long) filters.tooLong = true;
      if (args.orphan) filters.orphan = true;
      if (args.section) filters.section = args.section;
      if (args.page?.length) filters.page = args.page;

      const { crawl, rows, storeIntegrity, warnings } = loaded.data;
      const matched = filterPageMap(rows, filters);
      const limit = args.limit ?? DEFAULT_LIMIT;
      const offset = args.offset ?? 0;
      const page = matched.slice(offset, offset + limit);

      return jsonResult({
        site: crawl.baseUrl,
        runId: crawl.id,
        auditedAt: new Date(crawl.startedAt).toISOString(),
        // Pages in the audit, before any filter; `total` is what matched.
        pagesInAudit: rows.length,
        pages: page,
        total: matched.length,
        hasMore: offset + page.length < matched.length,
        ...(storeIntegrity ? { storeIntegrity } : {}),
        warnings,
      });
    }
  );
}
