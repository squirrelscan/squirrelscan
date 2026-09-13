// The entity MCP tool contract, shared by the CLI server and the cloud server
// (#2095, epic #2061 section 8).
//
// The two servers read different sources — the CLI reads the project store,
// the cloud reads the API — and must expose the SAME five tools, with the same
// names, the same accepted values and the same descriptions. This module is
// what makes that true by construction rather than by two people remembering.
//
// WHY CONSTANTS AND NOT A SCHEMA. The obvious design is one shared TypeBox
// schema per tool input. The MCP SDK will not take it: `inputSchema` accepts
// `z3.ZodTypeAny | z4.$ZodType` or a raw shape of those, and handing it a
// TypeBox object throws at runtime with "inputSchema must be a Zod schema or
// raw shape, received an unrecognized object". Nor can this package carry zod
// instead: it dropped zod for TypeBox precisely because the private API is on
// zod 3 while the CLI and rules are on zod 4, and the two do not compose.
//
// So each server assembles its own zod shape from the constants below. What
// has to match — names, wording, accepted values, limits — lives here. What
// cannot be shared is the validator object, and only the validator object.
//
// RESULT shapes ARE schemas here, because a handler's return value never passes
// through the SDK as a schema, so that half of the contract is shared and typed
// in the ordinary way.

import { Type, type Static } from "@sinclair/typebox";

import { EntityMapDiffSchema, EntityMapSchema } from "./entity-map";

// ── Names ──────────────────────────────────────────────────────────

export const ENTITY_MCP_TOOL_NAMES = [
  "list_entities",
  "get_entity",
  "get_entity_graph",
  "compare_entities",
  "get_entity_findings",
] as const;

export type EntityMcpToolName = (typeof ENTITY_MCP_TOOL_NAMES)[number];

// ── Accepted values ────────────────────────────────────────────────

/**
 * The problem classes `list_entities` and `get_entity_graph` accept.
 *
 * Identical to the CLI's `--problem` values, deliberately: an agent that has
 * read the CLI docs must not find a different vocabulary here.
 */
export const ENTITY_MCP_PROBLEMS = [
  "no-id",
  "conflict",
  "dangling",
  "single-page",
  "split-identity",
] as const;

export type EntityMcpProblem = (typeof ENTITY_MCP_PROBLEMS)[number];

/** What `get_entity_graph` can render. Same list the CLI's `-f` accepts. */
export const ENTITY_MCP_GRAPH_FORMATS = [
  "json",
  "jsonld",
  "mermaid",
  "dot",
  "graphml",
  "markdown",
] as const;

export type EntityMcpGraphFormat = (typeof ENTITY_MCP_GRAPH_FORMATS)[number];

// ── Limits ─────────────────────────────────────────────────────────

/**
 * Paging and truncation limits.
 *
 * Every one of these exists because the caller is a model with a context
 * window. A tool that returns a site's whole graph does not fail, it fills the
 * window and leaves no room for the work the graph was fetched for.
 */
export const ENTITY_MCP_LIMITS = {
  /** `list_entities` page size when the caller does not ask. */
  defaultLimit: 25,
  /** Largest page `list_entities` will return. */
  maxLimit: 100,
  /** Nodes drawn by `get_entity_graph` in `mermaid`. */
  mermaidNodes: 150,
  /** Rows rendered by `get_entity_graph` in `markdown`. */
  markdownRows: 50,
  /** Edges listed on one node by `get_entity`, in each direction. */
  entityEdges: 50,
  /** Declaring pages listed on one node by `get_entity`. */
  entityPages: 20,
  /** Findings returned by `get_entity_findings`. */
  findings: 50,
} as const;

// ── Descriptions ───────────────────────────────────────────────────

/**
 * The loop every description points at.
 *
 * Stated the same way in all five, because an agent reads one tool's
 * description and has to learn from it that the others exist and what order
 * they go in. Repeating it is not redundancy, it is the only place an agent
 * that called one tool will look.
 */
export const ENTITY_MCP_LOOP =
  "Fix-and-verify loop: call list_entities with problem=\"no-id\" to find entities declared on several pages with nothing to tie them together, give each one an absolute @id, re-run the audit with run_audit, then call compare_entities and check that gainedId contains the keys you fixed. gainedId is the only confirmation that the fix landed: an entity that gained an @id changes key, so it would otherwise look like one removal plus one addition.";

/**
 * Tool descriptions, identical on both servers.
 *
 * These are the contract an agent actually reads. A description that overstates
 * what a tool returns is the same class of error as a rule that fires on
 * correct markup, so they say what is capped and what is not.
 */
export const ENTITY_MCP_DESCRIPTIONS: Record<EntityMcpToolName, string> = {
  list_entities:
    "List the entities a site declares in its JSON-LD, collapsed across every crawled page into one graph, so the same Organization on 60 pages is one row rather than 60. Filter by @type, by declaring page, by problem class, or by a text match on the name. Page-local entities (a page's own WebPage, BreadcrumbList and unnamed images) usually outnumber the site's actual subject matter and are hidden unless include_page_local is true. Returns a summary, a page of nodes, and total and has_more so you can tell a capped list from a complete one. " +
    ENTITY_MCP_LOOP,
  get_entity:
    "Get one entity in full: every property, the pages that declare it, the properties whose values disagree between those pages, and the references in and out of it. Accepts the entity key, its @id, or its name. Use this after list_entities to see why an entity was flagged, before deciding what to change. Edges and declaring pages are capped; the counts tell you when. " +
    ENTITY_MCP_LOOP,
  get_entity_graph:
    "Get the whole entity graph, or a filtered part of it, in a chosen format: json for the canonical document, jsonld for a validator, mermaid or markdown to read in a conversation, dot or graphml for a graph tool. Takes the same filters as list_entities. mermaid and markdown are capped to fit a context window and say so in the output when they truncate; json, jsonld, dot and graphml are complete. " +
    ENTITY_MCP_LOOP,
  compare_entities:
    "Compare two audits of a site and get the change set: entities added and removed, entities that gained or lost an @id, occurrence changes, new and resolved conflicts and dangling references, summary deltas, and the pages each audit saw that the other did not. Defaults to the previous audit versus the latest. An entity is only reported as removed when every page that declared it was crawled again; anything unproven is reported separately as not crawled, so a smaller crawl never reads as a site that deleted its structured data. " +
    ENTITY_MCP_LOOP,
  get_entity_findings:
    "Get the schema/entity-* rule verdicts for an audit: what is wrong with the site's entity graph, which entity keys and pages each finding affects, and the fix text for each. Use this instead of re-deriving the problems from the graph yourself. Each finding names one problem across the whole site rather than one per entity, so a count of 1 can still mean hundreds of pages. " +
    ENTITY_MCP_LOOP,
};

/**
 * Per-field descriptions, so both servers describe the same input the same way.
 *
 * Keyed by tool then field. A field absent here is one that tool does not take.
 */
export const ENTITY_MCP_FIELD_DESCRIPTIONS = {
  common: {
    website_id: "The registered website to read. Defaults to the latest audit.",
    run_id: "A specific audit run to read. Defaults to the latest audit with an entity map.",
    type: "Only entities carrying one of these @type values. Case-insensitive.",
    page: "Only entities declared on pages matching this URL or prefix.",
    problem: `Only entities with one of these problems: ${ENTITY_MCP_PROBLEMS.join(", ")}.`,
    q: "Only entities whose name or @id contains this text. Case-insensitive.",
    include_page_local:
      "Include entities that describe one page rather than the site's subject matter, such as a page's own WebPage or BreadcrumbList. False by default because they usually outnumber everything else.",
    limit: `Entities to return. Default ${ENTITY_MCP_LIMITS.defaultLimit}, maximum ${ENTITY_MCP_LIMITS.maxLimit}.`,
    offset: "Entities to skip, for paging through a result larger than limit.",
  },
  get_entity: {
    key: "The entity key, its @id, or its name. Tried in that order, exactly before loosely.",
  },
  get_entity_graph: {
    format: `How to render the graph: ${ENTITY_MCP_GRAPH_FORMATS.join(", ")}.`,
  },
  compare_entities: {
    from_run_id: "The older audit. Defaults to the one before the newer audit, for the same site.",
    to_run_id: "The newer audit. Defaults to the latest audit with an entity map.",
  },
} as const;

// ── Result shapes ──────────────────────────────────────────────────

/**
 * Why every result carries `truncated`.
 *
 * An agent that cannot tell a capped list from a complete one will reason about
 * the site from a sample and state its conclusion as though it saw everything.
 * Saying so in the payload is cheaper than any amount of documentation.
 */
export const EntityMcpTruncationSchema = Type.Object({
  truncated: Type.Boolean(),
  /** What was cut, and how to see the rest. Empty when nothing was cut. */
  notice: Type.String(),
});

export type EntityMcpTruncation = Static<typeof EntityMcpTruncationSchema>;

/** One row of `list_entities`: enough to decide what to look at next. */
export const EntityMcpListRowSchema = Type.Object({
  key: Type.String(),
  id: Type.Union([Type.String(), Type.Null()]),
  types: Type.Array(Type.String()),
  name: Type.Union([Type.String(), Type.Null()]),
  occurrences: Type.Integer(),
  pageCount: Type.Integer(),
  conflictCount: Type.Integer(),
  danglingRefs: Type.Integer(),
  pageLocal: Type.Boolean(),
});

export type EntityMcpListRow = Static<typeof EntityMcpListRowSchema>;

export const EntityMcpListResultSchema = Type.Object({
  site: Type.String(),
  runId: Type.String(),
  auditedAt: Type.String(),
  summary: Type.Unknown(),
  entities: Type.Array(EntityMcpListRowSchema),
  total: Type.Integer(),
  hasMore: Type.Boolean(),
  truncation: EntityMcpTruncationSchema,
});

export type EntityMcpListResult = Static<typeof EntityMcpListResultSchema>;

/** One edge, as `get_entity` reports it. */
export const EntityMcpEdgeSchema = Type.Object({
  predicate: Type.String(),
  /** The entity at the other end. */
  key: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  /** True when nothing on the crawled site declares the target. */
  dangling: Type.Boolean(),
  occurrences: Type.Integer(),
});

export type EntityMcpEdge = Static<typeof EntityMcpEdgeSchema>;

export const EntityMcpEntityResultSchema = Type.Object({
  site: Type.String(),
  runId: Type.String(),
  entity: Type.Unknown(),
  declaredOn: Type.Array(Type.String()),
  morePages: Type.Integer(),
  outgoing: Type.Array(EntityMcpEdgeSchema),
  incoming: Type.Array(EntityMcpEdgeSchema),
  truncation: EntityMcpTruncationSchema,
});

export type EntityMcpEntityResult = Static<typeof EntityMcpEntityResultSchema>;

export const EntityMcpGraphResultSchema = Type.Object({
  site: Type.String(),
  runId: Type.String(),
  format: Type.Union(ENTITY_MCP_GRAPH_FORMATS.map((f) => Type.Literal(f))),
  /** The rendered graph. For `json` and `jsonld` this is the serialized document. */
  content: Type.String(),
  nodeCount: Type.Integer(),
  edgeCount: Type.Integer(),
  truncation: EntityMcpTruncationSchema,
});

export type EntityMcpGraphResult = Static<typeof EntityMcpGraphResultSchema>;

export const EntityMcpCompareResultSchema = Type.Object({
  site: Type.String(),
  fromRunId: Type.String(),
  toRunId: Type.String(),
  diff: EntityMapDiffSchema,
  truncation: EntityMcpTruncationSchema,
});

export type EntityMcpCompareResult = Static<typeof EntityMcpCompareResultSchema>;

/** One `schema/entity-*` verdict, as an agent needs it. */
export const EntityMcpFindingSchema = Type.Object({
  ruleId: Type.String(),
  status: Type.String(),
  severity: Type.String(),
  message: Type.String(),
  /** The rule's fix text, so the agent does not have to fetch the rule page. */
  solution: Type.String(),
  docsUrl: Type.String(),
  /** Entity keys the finding is about, capped. */
  keys: Type.Array(Type.String()),
  /** Pages the finding points at, capped. */
  pages: Type.Array(Type.String()),
  /** Matches beyond the listed keys. */
  more: Type.Integer(),
});

export type EntityMcpFinding = Static<typeof EntityMcpFindingSchema>;

export const EntityMcpFindingsResultSchema = Type.Object({
  site: Type.String(),
  runId: Type.String(),
  findings: Type.Array(EntityMcpFindingSchema),
  /** Rules that ran and had nothing to report. */
  passed: Type.Array(Type.String()),
  /** Rules that could not run, with why. */
  skipped: Type.Array(Type.Object({ ruleId: Type.String(), reason: Type.String() })),
  truncation: EntityMcpTruncationSchema,
});

export type EntityMcpFindingsResult = Static<typeof EntityMcpFindingsResultSchema>;

/** Nothing was cut. */
export const NO_TRUNCATION: EntityMcpTruncation = { truncated: false, notice: "" };

/** Build a truncation notice that says what was cut and how to get the rest. */
export function truncationNotice(shown: number, total: number, what: string, remedy: string): EntityMcpTruncation {
  if (shown >= total) return NO_TRUNCATION;
  return {
    truncated: true,
    notice: `Showing ${shown} of ${total} ${what}. ${remedy}`,
  };
}

/** The map document itself, re-exported so a consumer needs one import. */
export { EntityMapSchema, EntityMapDiffSchema };
