// The data layer behind the five entity MCP tools (#2095, epic section 8).
//
// Separate from the tool handlers for the same reason `controllers/entities.ts`
// is separate from `cli/commands/entities.ts`: the store access and the
// question-answering are testable without an MCP server, and the handlers stay
// thin enough to read.
//
// Everything here reuses what #2092 built — `loadEntityMap`, `filterEntityMap`,
// `findEntity`, `diffEntityMaps` and the report renderers — rather than asking
// the store the same questions a second way. Two paths to one answer is two
// places for it to be wrong.

import type {
  EntityMap,
  EntityMapNode,
} from "@squirrelscan/core-contracts/entity-map";

import {
  diffEntityMaps,
  toJsonLd,
} from "@squirrelscan/audit-engine/entity-map";
import {
  ENTITY_MCP_LIMITS,
  type EntityMcpEdge,
  type EntityMcpFinding,
  type EntityMcpGraphFormat,
  type EntityMcpListRow,
  type EntityMcpTruncation,
  NO_TRUNCATION,
  truncationNotice,
} from "@squirrelscan/core-contracts/entity-mcp";
import {
  renderEntitiesDot,
  renderEntitiesGraphml,
  renderEntitiesMermaid,
  MERMAID_NODE_CAP,
} from "@squirrelscan/report/entities-export";
import { loadAllRules } from "@squirrelscan/rules";
import { Effect } from "effect";
import { existsSync } from "node:fs";

import {
  listEntityMaps,
  loadEntityMap,
  type StoredEntityMap,
} from "@/controllers/entities";
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
import {
  filterEntityMap,
  findEntity,
  isEntityProblem,
  type EntityFilters,
  type EntityProblem,
} from "@/entities/filters";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pageTotal(node: EntityMapNode): number {
  return node.pages.length + node.morePages;
}

/**
 * The filters every entity tool accepts, as they arrive from a tool call.
 *
 * Arrays rather than comma-separated strings: an MCP client sends JSON, so
 * there is no shell to split for. The CLI's comma handling exists because a
 * terminal has no arrays.
 */
export interface EntityToolFilters {
  type?: string[];
  page?: string[];
  problem?: string[];
  q?: string;
  includePageLocal?: boolean;
}

/** Resolve a crawl reference to the stored map, or say why not. */
export async function resolveMap(
  runId?: string
): Promise<Result<StoredEntityMap>> {
  return loadEntityMap(runId);
}

/**
 * Apply the tool filters, including the two the CLI does not have.
 *
 * `q` and `include_page_local` are MCP-only: the CLI viewer has a page-local
 * toggle in its UI and a person greps the table, but an agent has neither.
 */
export function applyToolFilters(
  map: EntityMap,
  filters: EntityToolFilters
): EntityMap {
  const base: EntityFilters = {};
  if (filters.type?.length) base.types = filters.type;
  if (filters.page?.length) base.pages = filters.page;
  const problems = (filters.problem ?? []).filter(isEntityProblem);
  if (problems.length > 0) base.problems = problems as EntityProblem[];

  let result = filterEntityMap(map, base);

  // Page-local entities outnumber a site's actual subject matter — 233 of 363
  // on squirrelscan.com — so an agent that fetched them would spend most of its
  // window on a site's own breadcrumbs.
  if (!filters.includePageLocal) {
    result = narrow(result, (node) => !node.pageLocal);
  }

  const needle = filters.q?.trim().toLowerCase();
  if (needle) {
    result = narrow(
      result,
      (node) =>
        (node.name?.toLowerCase().includes(needle) ?? false) ||
        (node.id?.toLowerCase().includes(needle) ?? false)
    );
  }

  return result;
}

/**
 * Keep the nodes a predicate accepts, carrying edges and counts with them.
 *
 * Mirrors `filterEntityMap`'s contract: edges follow their endpoints, a
 * dangling edge follows its source, and the summary counts describe what
 * survived rather than the whole site.
 */
function narrow(
  map: EntityMap,
  keep: (node: EntityMapNode) => boolean
): EntityMap {
  const nodes = map.nodes.filter(keep);
  if (nodes.length === map.nodes.length) return map;
  const keys = new Set(nodes.map((node) => node.key));
  const edges = map.edges.filter(
    (edge) => keys.has(edge.source) && (edge.dangling || keys.has(edge.target))
  );
  const withId = nodes.filter((node) => node.id !== null).length;
  return {
    ...map,
    summary: {
      ...map.summary,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingCount: edges.filter((edge) => edge.dangling).length,
      nodesWithStableId: withId,
      stableIdShare: nodes.length === 0 ? 0 : withId / nodes.length,
      pageLocalCount: nodes.filter((node) => node.pageLocal).length,
      conflictCount: nodes.filter((node) => node.conflicts.length > 0).length,
    },
    nodes,
    edges,
  };
}

/** One page of `list_entities`, widest reach first. */
export function listRows(
  map: EntityMap,
  limit: number,
  offset: number
): { rows: EntityMcpListRow[]; total: number; hasMore: boolean } {
  const ordered = [...map.nodes].sort(
    (a, b) => pageTotal(b) - pageTotal(a) || compareStrings(a.key, b.key)
  );
  const page = ordered.slice(offset, offset + limit);
  return {
    rows: page.map((node) => ({
      key: node.key,
      id: node.id,
      types: node.types,
      name: node.name,
      occurrences: node.occurrences,
      pageCount: pageTotal(node),
      conflictCount: node.conflicts.length,
      danglingRefs: node.danglingRefs,
      pageLocal: node.pageLocal,
    })),
    total: ordered.length,
    hasMore: offset + page.length < ordered.length,
  };
}

/** One entity with both directions of its edges resolved to names. */
export function entityDetail(
  map: EntityMap,
  query: string
): {
  node: EntityMapNode;
  outgoing: EntityMcpEdge[];
  incoming: EntityMcpEdge[];
  truncation: EntityMcpTruncation;
} | null {
  const node = findEntity(map, query);
  if (!node) return null;

  const byKey = new Map(map.nodes.map((n) => [n.key, n] as const));
  const name = (key: string): string | null => byKey.get(key)?.name ?? null;

  const out = map.edges
    .filter((edge) => edge.source === node.key)
    .sort(
      (a, b) =>
        compareStrings(a.predicate, b.predicate) ||
        compareStrings(a.target, b.target)
    );
  const inbound = map.edges
    .filter((edge) => edge.target === node.key)
    .sort(
      (a, b) =>
        compareStrings(a.predicate, b.predicate) ||
        compareStrings(a.source, b.source)
    );

  const toEdge = (
    key: string,
    predicate: string,
    dangling: boolean,
    occurrences: number
  ): EntityMcpEdge => ({
    predicate,
    key,
    name: name(key),
    dangling,
    occurrences,
  });

  const cap = ENTITY_MCP_LIMITS.entityEdges;
  const cut = Math.max(0, out.length - cap) + Math.max(0, inbound.length - cap);
  const pagesCut = Math.max(0, pageTotal(node) - ENTITY_MCP_LIMITS.entityPages);

  return {
    node,
    outgoing: out
      .slice(0, cap)
      .map((edge) =>
        toEdge(edge.target, edge.predicate, edge.dangling, edge.occurrences)
      ),
    incoming: inbound
      .slice(0, cap)
      .map((edge) =>
        toEdge(edge.source, edge.predicate, false, edge.occurrences)
      ),
    truncation:
      cut + pagesCut === 0
        ? NO_TRUNCATION
        : {
            truncated: true,
            notice: `${cut} reference(s) and ${pagesCut} declaring page(s) not listed. Use get_entity_graph with format="json" for the complete record.`,
          },
  };
}

/** Render the graph, capping the two formats that have to fit a context window. */
export function renderGraph(
  map: EntityMap,
  format: EntityMcpGraphFormat
): { content: string; truncation: EntityMcpTruncation } {
  switch (format) {
    case "json":
      return {
        content: JSON.stringify(map, null, 2),
        truncation: NO_TRUNCATION,
      };
    case "jsonld":
      return {
        content: JSON.stringify(toJsonLd(map), null, 2),
        truncation: NO_TRUNCATION,
      };
    case "dot":
      return { content: renderEntitiesDot(map), truncation: NO_TRUNCATION };
    case "graphml":
      return { content: renderEntitiesGraphml(map), truncation: NO_TRUNCATION };
    case "mermaid":
      // The renderer caps and says so in a comment; the payload says so too,
      // because an agent reading `content` as data will not parse a comment.
      return {
        content: renderEntitiesMermaid(map),
        truncation: truncationNotice(
          Math.min(map.nodes.length, MERMAID_NODE_CAP),
          map.nodes.length,
          "entities",
          'Use format="dot" or format="graphml" for the whole graph.'
        ),
      };
    case "markdown":
      return renderMarkdown(map);
  }
}

/**
 * A compact table, capped by rows.
 *
 * Not the report's markdown renderer: that one is written for a person reading
 * a report and carries prose, headings and a conflicts section. An agent wants
 * the rows.
 */
function renderMarkdown(map: EntityMap): {
  content: string;
  truncation: EntityMcpTruncation;
} {
  const cap = ENTITY_MCP_LIMITS.markdownRows;
  const ordered = [...map.nodes].sort(
    (a, b) => pageTotal(b) - pageTotal(a) || compareStrings(a.key, b.key)
  );
  const shown = ordered.slice(0, cap);

  const lines = [
    `# Entities on ${map.site}`,
    "",
    `${map.summary.nodeCount} entities, ${map.summary.edgeCount} references, ${Math.round(map.summary.stableIdShare * 100)}% with a stable @id, across ${map.summary.pagesTotal} pages.`,
    "",
    "| Type | Name | @id | Pages | Conflicts |",
    "| --- | --- | --- | ---: | ---: |",
  ];
  for (const node of shown) {
    lines.push(
      `| ${cell(node.types.join(", "))} | ${cell(node.name ?? "(unnamed)")} | ${cell(node.id ?? "none")} | ${pageTotal(node)} | ${node.conflicts.length} |`
    );
  }

  const truncation = truncationNotice(
    shown.length,
    ordered.length,
    "entities",
    'Use format="json" for the complete document, or narrow with type, page or problem.'
  );
  if (truncation.truncated) {
    lines.push("", `_${truncation.notice}_`);
  }
  return { content: `${lines.join("\n")}\n`, truncation };
}

/** Escape a value for a markdown table cell. */
function cell(value: string): string {
  // Backslash FIRST: escaping the pipe first would then escape the escape.
  const clipped = value.length > 60 ? `${value.slice(0, 59)}…` : value;
  return clipped
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

/** The two crawls a comparison runs over, defaulting to previous versus latest. */
export async function resolveComparison(
  fromRunId?: string,
  toRunId?: string
): Promise<Result<{ older: StoredEntityMap; newer: StoredEntityMap }>> {
  if (fromRunId && toRunId) {
    const a = await loadEntityMap(fromRunId);
    if (!a.ok) return err(a.error);
    const b = await loadEntityMap(toRunId);
    if (!b.ok) return err(b.error);
    // Chronological regardless of the order they were named.
    const [older, newer] =
      a.data.crawl.startedAt <= b.data.crawl.startedAt
        ? [a.data, b.data]
        : [b.data, a.data];
    return ok({ older, newer });
  }

  // Same rule as `squirrel entities --diff`: anchor on the newer audit, then
  // take the previous one OF THE SAME SITE. The store holds every project, so
  // "the two newest audits" are routinely two different sites.
  const listed = await listEntityMaps(50);
  if (!listed.ok) return err(listed.error);
  const withMaps = listed.data.filter((row) => row.entities > 0);

  const anchorIndex = toRunId
    ? withMaps.findIndex(
        (row) => row.crawlId === toRunId || row.crawlId.startsWith(toRunId)
      )
    : 0;
  const anchor = anchorIndex >= 0 ? withMaps[anchorIndex] : undefined;
  if (!anchor) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        toRunId
          ? `No audit with an entity map matches "${toRunId}".`
          : "No audit with an entity map found. Run an audit first."
      )
    );
  }

  const sameSite = await listEntityMaps(200, { baseUrl: anchor.baseUrl });
  if (!sameSite.ok) return err(sameSite.error);
  const previous = sameSite.data.find(
    (row) => row.entities > 0 && row.startedAt < anchor.startedAt
  );
  if (!previous) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        `Only one audit of ${anchor.baseUrl} has an entity map, so there is nothing to compare it against yet.`
      )
    );
  }

  const older = await loadEntityMap(previous.crawlId);
  if (!older.ok) return err(older.error);
  const newer = await loadEntityMap(anchor.crawlId);
  if (!newer.ok) return err(newer.error);
  return ok({ older: older.data, newer: newer.data });
}

export { diffEntityMaps };

/**
 * The `schema/entity-*` verdicts stored for a crawl.
 *
 * Read from `rule_results` rather than re-running the rules: the point of the
 * tool is to hand an agent what the audit already decided, and a second
 * evaluation could disagree with the report the user is looking at.
 */
export async function loadEntityFindings(
  crawlId: string
): Promise<
  Result<{
    findings: EntityMcpFinding[];
    passed: string[];
    skipped: Array<{ ruleId: string; reason: string }>;
  }>
> {
  try {
    for (const dbPath of getProjectStoragePaths()) {
      if (!existsSync(dbPath)) continue;
      const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
      try {
        await Effect.runPromise(storage.init());
        const crawl = await Effect.runPromise(
          storage
            .getCrawl(crawlId)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
        );
        if (!crawl) continue;
        const byRule = await Effect.runPromise(
          storage.getRuleResultsByRuleId(crawlId)
        );
        return ok(shapeFindings(byRule));
      } finally {
        await Effect.runPromise(
          storage.close().pipe(Effect.catchAll(() => Effect.void))
        );
      }
    }
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        `No audit found matching "${crawlId}".`
      )
    );
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Could not read the entity findings: ${String(error)}`
      )
    );
  }
}

/** Split the stored checks into findings, passes and skips. */
function shapeFindings(
  byRule: Map<
    string,
    Array<{
      name: string;
      status: string;
      message: string;
      items?: unknown;
      pages?: string[];
      skipReason?: string;
    }>
  >
): {
  findings: EntityMcpFinding[];
  passed: string[];
  skipped: Array<{ ruleId: string; reason: string }>;
} {
  const findings: EntityMcpFinding[] = [];
  const passed: string[] = [];
  const skipped: Array<{ ruleId: string; reason: string }> = [];

  for (const [ruleId, checks] of [...byRule.entries()].sort((a, b) =>
    compareStrings(a[0], b[0])
  )) {
    if (!ruleId.startsWith("schema/entity-")) continue;
    for (const check of checks) {
      if (check.status === "pass") {
        passed.push(ruleId);
        continue;
      }
      if (check.status === "skipped") {
        skipped.push({ ruleId, reason: check.skipReason ?? check.message });
        continue;
      }
      findings.push(buildFinding(ruleId, check));
    }
  }

  return {
    findings: findings.slice(0, ENTITY_MCP_LIMITS.findings),
    passed,
    skipped,
  };
}

function buildFinding(
  ruleId: string,
  check: { status: string; message: string; items?: unknown; pages?: string[] }
): EntityMcpFinding {
  const items = Array.isArray(check.items)
    ? (check.items as Array<{ id?: string; sourcePages?: string[] }>)
    : [];
  const keys = items.map((item) => item.id ?? "").filter((id) => id.length > 0);
  const pages = [
    ...new Set([
      ...(check.pages ?? []),
      ...items.flatMap((item) => item.sourcePages ?? []),
    ]),
  ];

  const meta = ruleMeta(ruleId);
  return {
    ruleId,
    status: check.status,
    severity: meta.severity,
    message: check.message,
    solution: meta.solution,
    docsUrl: `https://docs.squirrelscan.com/rules/${ruleId}`,
    keys: keys.slice(0, ENTITY_MCP_LIMITS.findings),
    pages: pages.slice(0, ENTITY_MCP_LIMITS.entityPages),
    more: Math.max(0, keys.length - ENTITY_MCP_LIMITS.findings),
  };
}

/**
 * The rule's own severity and fix text.
 *
 * Loaded from the registry rather than stored on the check, so the fix text an
 * agent acts on is the current one rather than whatever was written when the
 * audit ran.
 */
let metaCache: Map<string, { severity: string; solution: string }> | null =
  null;
function ruleMeta(ruleId: string): { severity: string; solution: string } {
  if (!metaCache) {
    // Memoized: the built-in rule set is static for the process lifetime, and
    // an MCP server answers many calls from one process.
    metaCache = new Map();
    for (const [id, rule] of loadAllRules()) {
      metaCache.set(id, {
        severity: rule.meta.severity,
        solution: rule.meta.solution ?? "",
      });
    }
  }
  return metaCache.get(ruleId) ?? { severity: "warning", solution: "" };
}
