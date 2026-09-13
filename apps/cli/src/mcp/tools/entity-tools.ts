// The five entity tools on the CLI MCP server (#2095, epic section 8).
//
// Local and free: they read the project store, so they need no auth and cost
// no credits. The cloud server exposes the same five names against the API.
//
// Every name, description, accepted value and limit comes from
// `@squirrelscan/core-contracts/entity-mcp` rather than being written here,
// because the two servers have to agree and the only way to guarantee that is
// to have one source. The zod shapes below are assembled from those constants:
// the SDK's `inputSchema` takes zod only, so the schema object itself cannot be
// shared, but nothing an agent reads or sends differs between the servers.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  ENTITY_MCP_DESCRIPTIONS,
  ENTITY_MCP_FIELD_DESCRIPTIONS,
  ENTITY_MCP_GRAPH_FORMATS,
  ENTITY_MCP_LIMITS,
  ENTITY_MCP_PROBLEMS,
  NO_TRUNCATION,
} from "@squirrelscan/core-contracts/entity-mcp";
import { z } from "zod";

import {
  applyToolFilters,
  diffEntityMaps,
  entityDetail,
  listRows,
  loadEntityFindings,
  renderGraph,
  resolveComparison,
  resolveMap,
  type EntityToolFilters,
} from "@/controllers/entity-mcp";

import { errorResult, jsonResult } from "../result";

const F = ENTITY_MCP_FIELD_DESCRIPTIONS;

/**
 * The filter fields every entity tool accepts.
 *
 * Arrays rather than comma-separated strings: a client sends JSON, so there is
 * no shell to split for. The CLI's comma handling exists because a terminal
 * has no arrays, and copying it here would be cargo.
 */
const filterShape = {
  type: z.array(z.string()).optional().describe(F.common.type),
  page: z.array(z.string()).optional().describe(F.common.page),
  problem: z
    .array(z.enum(ENTITY_MCP_PROBLEMS))
    .optional()
    .describe(F.common.problem),
  q: z.string().optional().describe(F.common.q),
  include_page_local: z
    .boolean()
    .optional()
    .describe(F.common.include_page_local),
};

/** `run_id` is what the CLI server keys on; `website_id` is cloud-only. */
const runShape = {
  run_id: z.string().optional().describe(F.common.run_id),
};

interface RawFilters {
  type?: string[];
  page?: string[];
  problem?: string[];
  q?: string;
  include_page_local?: boolean;
}

function toFilters(args: RawFilters): EntityToolFilters {
  const filters: EntityToolFilters = {};
  if (args.type) filters.type = args.type;
  if (args.page) filters.page = args.page;
  if (args.problem) filters.problem = args.problem;
  if (args.q !== undefined) filters.q = args.q;
  if (args.include_page_local !== undefined)
    filters.includePageLocal = args.include_page_local;
  return filters;
}

export function registerEntityTools(server: McpServer): void {
  server.registerTool(
    "list_entities",
    {
      title: "List the entities a site declares",
      description: ENTITY_MCP_DESCRIPTIONS.list_entities,
      inputSchema: {
        ...runShape,
        ...filterShape,
        limit: z
          .number()
          .int()
          .min(1)
          .max(ENTITY_MCP_LIMITS.maxLimit)
          .optional()
          .describe(F.common.limit),
        offset: z.number().int().min(0).optional().describe(F.common.offset),
      },
    },
    async (args) => {
      const loaded = await resolveMap(args.run_id);
      if (!loaded.ok) return errorResult(loaded.error.message);

      const filtered = applyToolFilters(loaded.data.map, toFilters(args));
      const { rows, total, hasMore } = listRows(
        filtered,
        args.limit ?? ENTITY_MCP_LIMITS.defaultLimit,
        args.offset ?? 0
      );

      return jsonResult({
        site: loaded.data.map.site,
        runId: loaded.data.crawl.id,
        auditedAt: new Date(loaded.data.crawl.startedAt).toISOString(),
        summary: filtered.summary,
        entities: rows,
        total,
        hasMore,
        // `hasMore` already says the page is partial, so the notice only fires
        // for what `hasMore` does NOT cover: nothing here, today. Kept so the
        // shape matches the other four and a future cap has somewhere to go.
        truncation: NO_TRUNCATION,
      });
    }
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get one entity in full",
      description: ENTITY_MCP_DESCRIPTIONS.get_entity,
      inputSchema: {
        ...runShape,
        key: z.string().describe(F.get_entity.key),
      },
    },
    async (args) => {
      const loaded = await resolveMap(args.run_id);
      if (!loaded.ok) return errorResult(loaded.error.message);

      // The UNFILTERED map: a lookup by key is a direct question, and hiding
      // page-local entities here would make a key that list_entities returned
      // unfetchable if the caller had passed include_page_local.
      const found = entityDetail(loaded.data.map, args.key);
      if (!found) {
        return errorResult(
          `No entity matching "${args.key}" in audit ${loaded.data.crawl.id}. Use list_entities to see what this site declares.`
        );
      }

      return jsonResult({
        site: loaded.data.map.site,
        runId: loaded.data.crawl.id,
        entity: found.node,
        declaredOn: found.node.pages.slice(0, ENTITY_MCP_LIMITS.entityPages),
        morePages: found.node.morePages,
        outgoing: found.outgoing,
        incoming: found.incoming,
        truncation: found.truncation,
      });
    }
  );

  server.registerTool(
    "get_entity_graph",
    {
      title: "Get the entity graph in a chosen format",
      description: ENTITY_MCP_DESCRIPTIONS.get_entity_graph,
      inputSchema: {
        ...runShape,
        ...filterShape,
        format: z
          .enum(ENTITY_MCP_GRAPH_FORMATS)
          .optional()
          .describe(F.get_entity_graph.format),
      },
    },
    async (args) => {
      const loaded = await resolveMap(args.run_id);
      if (!loaded.ok) return errorResult(loaded.error.message);

      const filtered = applyToolFilters(loaded.data.map, toFilters(args));
      const format = args.format ?? "json";
      // The UNFILTERED count, so an empty result can say "no match" rather
      // than "this site declares nothing" — two very different facts.
      const { content, truncation } = renderGraph(
        filtered,
        format,
        loaded.data.map.nodes.length
      );

      return jsonResult({
        site: loaded.data.map.site,
        runId: loaded.data.crawl.id,
        format,
        content,
        nodeCount: filtered.nodes.length,
        edgeCount: filtered.edges.length,
        truncation,
      });
    }
  );

  server.registerTool(
    "compare_entities",
    {
      title: "Compare two audits of a site",
      description: ENTITY_MCP_DESCRIPTIONS.compare_entities,
      inputSchema: {
        from_run_id: z
          .string()
          .optional()
          .describe(F.compare_entities.from_run_id),
        to_run_id: z.string().optional().describe(F.compare_entities.to_run_id),
      },
    },
    async (args) => {
      const resolved = await resolveComparison(
        args.from_run_id,
        args.to_run_id
      );
      if (!resolved.ok) return errorResult(resolved.error.message);

      const { older, newer } = resolved.data;
      const diff = diffEntityMaps(older.map, newer.map);

      return jsonResult({
        site: newer.map.site,
        fromRunId: older.crawl.id,
        toRunId: newer.crawl.id,
        diff,
        // The diff document caps its own lists and reports the true counts in
        // the summary, so there is nothing here the caller cannot see.
        truncation: NO_TRUNCATION,
      });
    }
  );

  server.registerTool(
    "get_entity_findings",
    {
      title: "Get the entity rule verdicts for an audit",
      description: ENTITY_MCP_DESCRIPTIONS.get_entity_findings,
      inputSchema: { ...runShape },
    },
    async (args) => {
      const loaded = await resolveMap(args.run_id);
      if (!loaded.ok) return errorResult(loaded.error.message);

      const result = await loadEntityFindings(loaded.data.crawl.id);
      if (!result.ok) return errorResult(result.error.message);

      return jsonResult({
        site: loaded.data.map.site,
        runId: loaded.data.crawl.id,
        findings: result.data.findings,
        passed: result.data.passed,
        skipped: result.data.skipped,
        truncation: NO_TRUNCATION,
      });
    }
  );
}
