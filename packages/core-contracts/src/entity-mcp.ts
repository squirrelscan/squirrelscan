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

import {
  EntityMapDiffSchema,
  EntityMapNodeSchema,
  EntityMapSchema,
  EntityMapSummarySchema,
} from "./entity-map";

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
 *
 * It is also paid FIVE TIMES on every `tools/list`, so it carries only what an
 * agent needs wherever it enters the loop. A caveat that can only be acted on
 * while reading one tool's RESULT belongs on that tool's description instead —
 * the gainedId matching rule is on compare_entities for exactly that reason.
 */
export const ENTITY_MCP_LOOP =
  "Fix-and-verify loop: call list_entities with problem=\"no-id\" to find entities declared on several pages with nothing to tie them together, give each one an absolute @id, re-run the audit with run_audit, then call compare_entities and check that gainedId contains the keys you fixed. gainedId is the only confirmation that the fix landed: an entity that gained an @id changes key, so it would otherwise look like one removal plus one addition. Check each entry's coverage field before calling it done: \"proven\" means the newer audit visited every page that declared the broken version AND found the replacement on all of them, \"partial\" means one of those could not be established.";

/**
 * Tool descriptions, identical on both servers.
 *
 * These are the contract an agent actually reads. A description that overstates
 * what a tool returns is the same class of error as a rule that fires on
 * correct markup, so they say what is capped and what is not.
 */
export const ENTITY_MCP_DESCRIPTIONS: Record<EntityMcpToolName, string> = {
  list_entities:
    "List the entities a site declares in its JSON-LD, collapsed across every crawled page into one graph, so an Organization declared identically on 60 pages is one row rather than 60. Declarations collapse by resolved @id, or by type and name when there is no @id, so the SAME real-world thing can still occupy several rows when its declared identity differs between pages: a relative @id such as \"#organization\" resolves against each page and yields one row per page. That is the split-identity problem, not a quirk of this tool. Filter by @type, by declaring page, by problem class, or by a text match on the name. Page-local entities (a page's own WebPage, BreadcrumbList and unnamed images) usually outnumber the site's actual subject matter and are hidden unless include_page_local is true. Returns a filtered summary, a page of nodes, total, and hasMore; keep requesting pages while hasMore is true rather than describing a site from one page. " +
    ENTITY_MCP_LOOP,
  get_entity:
    "Get one entity as the map recorded it: the properties the map keeps (name, url, logo, image, sameAs, telephone, email, address, description), the pages that declare it, the properties whose values disagree between those pages, and the references in and out of it. The map keeps those nine and @type and nothing else, so a property missing here may still be in the page's JSON-LD, and a disagreement in a property outside that set is not detected. Accepts the entity key, its @id, or its name. Use this after list_entities to see why an entity was flagged, before deciding what to change. Edges and declaring pages are capped; the counts tell you when. " +
    ENTITY_MCP_LOOP,
  get_entity_graph:
    "Get the whole entity graph, or a filtered part of it, in a chosen format: json for the canonical document, jsonld for a validator, mermaid or markdown to read in a conversation, dot or graphml for a graph tool. Defaults to json. Takes the same filters as list_entities. mermaid caps declared entities at 150 and markdown caps rows at 50, and both say so in truncation; json, jsonld, dot and graphml apply no node cap. No cap is not the same as complete: every format renders the stored map, and on the local server that map carries no per-edge page list and no per-page reference list, so those arrays are empty because they were never stored rather than because nothing matched. mermaid's cap bounds declared entities only, so one entity referencing thousands of undeclared ids still renders thousands of placeholder nodes. " +
    ENTITY_MCP_LOOP,
  compare_entities:
    "Compare two audits of a site and get the change set: entities added and removed, entities that gained or lost an @id, occurrence changes, new and resolved conflicts and dangling references, summary deltas, and the pages each audit saw that the other did not. Defaults to the previous audit versus the latest. An entity is only reported as removed when every page that declared it was crawled again; anything unproven is reported separately as not crawled, so a smaller crawl never reads as a site that deleted its structured data. Each gainedId and lostId entry carries a coverage field saying whether the newer audit visited every page that declared the old version and found the replacement there. Absence of a gainedId entry is not proof a fix failed: the match needs the type and the name to be unchanged, so changing the @id and the name in one edit appears as a removal plus an addition instead. " +
    ENTITY_MCP_LOOP,
  get_entity_findings:
    "Get the schema/entity-* rule verdicts for an audit: what is wrong with the site's entity graph, which entity keys and pages each finding affects, and the fix text for each. Use this instead of re-deriving the problems from the graph yourself. Each finding names one problem across the whole site rather than one per entity, so a count of 1 can still mean hundreds of pages. The keys and pages on a finding are a SAMPLE: the rule that produced it clipped its own lists before this tool saw them, so the pages listed are never the complete affected set and no field reports how many were left out. Use list_entities with the matching problem filter for the full set. analyzed says whether the rules ran at all: false means this audit was never analyzed, so empty findings are an absence of evidence rather than a clean result. " +
    ENTITY_MCP_LOOP,
};

/**
 * Per-field descriptions, so both servers describe the same input the same way.
 *
 * Keyed by tool then field. A field absent here is one that tool does not take.
 */
export const ENTITY_MCP_FIELD_DESCRIPTIONS = {
  common: {
    website_id:
      "The registered website to read, on the hosted server. Ignored by the local server, which reads the project store. When both this and run_id are given, run_id wins and this is ignored; naming a run of a different website is answered about the run.",
    run_id: "A specific audit run to read. Defaults to the latest audit that stored at least one entity, which is NOT always the latest audit: an audit that stored none is passed over, because the store cannot tell a site that declares nothing from an audit that predates the entity map. When one is passed over, warnings names it. If you are checking whether a change landed, name the run.",
    type: "Only entities carrying one of these @type values. Case-insensitive. Several values are an OR: an entity matching any one of them is kept.",
    page: "Only entities declared on a page whose URL CONTAINS one of these strings. Not a prefix test and not a glob, so \"/blog\" matches https://example.com/blog/post and https://example.com/tag/blog alike. Several values are an OR.",
    problem: `Only entities with one of these problems: ${ENTITY_MCP_PROBLEMS.join(", ")}. Several values are an OR.`,
    q: "Only entities whose name or @id contains this text. Case-insensitive substring, not a pattern.",
    include_page_local:
      "Include entities that describe one page rather than the site's subject matter, such as a page's own WebPage or BreadcrumbList. False by default because they usually outnumber everything else.",
    limit: `Entities to return. Default ${ENTITY_MCP_LIMITS.defaultLimit}, maximum ${ENTITY_MCP_LIMITS.maxLimit}.`,
    offset: "Entities to skip, for paging through a result larger than limit. Default 0. Ordering is by page count descending, then by key, and is stable across calls on one audit, so paging does not repeat or skip a row.",
  },
  get_entity: {
    key: "The entity key, its @id, or its name. Resolved in that order of certainty: an exact @id match, then an exact key match, then the key formed by prefixing the value with \"id:\", then an exact case-insensitive name, and only then a case-insensitive substring of a name. The first match wins.",
  },
  get_entity_graph: {
    format: `How to render the graph: ${ENTITY_MCP_GRAPH_FORMATS.join(", ")}. Defaults to json.`,
  },
  compare_entities: {
    from_run_id: "The older audit. Defaults to the one before the newer audit, for the same site. When both runs are named they are ordered chronologically whichever field named them, so a diff always reads forward in time; read fromRunId and toRunId on the result for the direction actually used.",
    to_run_id: "The newer audit. Defaults to the latest audit that stored at least one entity. When both runs are named they are ordered chronologically whichever field named them.",
  },
} as const;

// ── Input shape ────────────────────────────────────────────────────

/**
 * One accepted input field, precisely enough for a second server to rebuild it.
 *
 * The descriptions above say what a field MEANS. This says what it IS, which is
 * the half that has to match for two independently-written zod shapes to accept
 * and reject the same calls. Prose cannot be asserted against; this can, and
 * both servers have a test that does.
 */
export interface EntityMcpFieldSpec {
  readonly kind: "string" | "string[]" | "boolean" | "integer";
  /** Required fields have no default and a call without them is rejected. */
  readonly required: boolean;
  /** The closed set of accepted values, when there is one. */
  readonly values?: readonly string[];
  /** Applied by the handler when the field is absent, if anything is. */
  readonly default?: string | number | boolean;
  readonly min?: number;
  readonly max?: number;
}

/**
 * Every field each tool accepts, on BOTH servers.
 *
 * Filters combine as an AND ACROSS kinds and an OR WITHIN one: type plus
 * problem keeps entities that match a listed type AND have a listed problem.
 * That asymmetry is the one thing about the input an agent cannot guess, so it
 * is stated here and in every affected field description.
 */
export const ENTITY_MCP_INPUT_FIELDS: Record<
  EntityMcpToolName,
  Readonly<Record<string, EntityMcpFieldSpec>>
> = {
  list_entities: {
    run_id: { kind: "string", required: false },
    type: { kind: "string[]", required: false },
    page: { kind: "string[]", required: false },
    problem: { kind: "string[]", required: false, values: ENTITY_MCP_PROBLEMS },
    q: { kind: "string", required: false },
    include_page_local: { kind: "boolean", required: false, default: false },
    limit: {
      kind: "integer",
      required: false,
      default: ENTITY_MCP_LIMITS.defaultLimit,
      min: 1,
      max: ENTITY_MCP_LIMITS.maxLimit,
    },
    offset: { kind: "integer", required: false, default: 0, min: 0 },
  },
  get_entity: {
    run_id: { kind: "string", required: false },
    key: { kind: "string", required: true },
  },
  get_entity_graph: {
    run_id: { kind: "string", required: false },
    type: { kind: "string[]", required: false },
    page: { kind: "string[]", required: false },
    problem: { kind: "string[]", required: false, values: ENTITY_MCP_PROBLEMS },
    q: { kind: "string", required: false },
    include_page_local: { kind: "boolean", required: false, default: false },
    format: {
      kind: "string",
      required: false,
      values: ENTITY_MCP_GRAPH_FORMATS,
      default: "json",
    },
  },
  compare_entities: {
    from_run_id: { kind: "string", required: false },
    to_run_id: { kind: "string", required: false },
  },
  get_entity_findings: {
    run_id: { kind: "string", required: false },
  },
};

/**
 * Fields the hosted server adds and the local server does not have.
 *
 * The local server reads one machine's project store, where a website id means
 * nothing. Listing the difference here is what lets each server's conformance
 * test assert an exact field set rather than a subset, which is the assertion
 * that actually catches a field added to one server and forgotten on the other.
 */
export const ENTITY_MCP_CLOUD_ONLY_FIELDS = ["website_id"] as const;

/**
 * How a tool reports a failure.
 *
 * Both servers return MCP tool errors (`isError: true` with a text message),
 * never a result object carrying an error field, so an agent never has to check
 * two places. The message names what was looked for and what to call next; it
 * is meant to be read by the model, not matched by a caller.
 */
export const ENTITY_MCP_ERROR_STYLE =
  "MCP tool error with a human-readable message; no error field on a successful result.";

// ── Result shapes ──────────────────────────────────────────────────

/**
 * Why every result carries `truncated`.
 *
 * An agent that cannot tell a capped list from a complete one will reason about
 * the site from a sample and state its conclusion as though it saw everything.
 * Saying so in the payload is cheaper than any amount of documentation.
 */
/**
 * Everything the server could not account for while answering.
 *
 * Separate from `truncation`, which is about what was CUT from a complete
 * answer. A warning is about what could not be read or had to be guessed
 * around: an unreadable project store, or a newer audit passed over because it
 * stored no entities and is therefore indistinguishable from one that predates
 * the entity map. Both change what the answer means, and neither shows up
 * anywhere else in the payload.
 *
 * Always present, empty when clean. A consumer that has to check for an
 * omitted field will forget to.
 */
export const EntityMcpWarningsSchema = Type.Array(Type.String());

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
  /** The summary AFTER filtering, describing what survived rather than the site. */
  summary: EntityMapSummarySchema,
  entities: Type.Array(EntityMcpListRowSchema),
  total: Type.Integer(),
  hasMore: Type.Boolean(),
  truncation: EntityMcpTruncationSchema,
  warnings: EntityMcpWarningsSchema,
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
  /** The node, with `pages` already capped; `declaredOn` repeats that list. */
  entity: EntityMapNodeSchema,
  declaredOn: Type.Array(Type.String()),
  morePages: Type.Integer(),
  outgoing: Type.Array(EntityMcpEdgeSchema),
  incoming: Type.Array(EntityMcpEdgeSchema),
  truncation: EntityMcpTruncationSchema,
  warnings: EntityMcpWarningsSchema,
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
  /**
   * The `@id`s the `jsonld` rendering INVENTED, for entities the site declared
   * without one.
   *
   * A JSON-LD document has nowhere to say "this identifier is not real", so it
   * is said here. Without it the export reads as a site where every entity is
   * already identified, which is the exact opposite of the finding that sent
   * the agent to this tool. Empty for every other format, and for a jsonld
   * rendering in which the site identified everything itself.
   */
  generatedIds: Type.Array(
    Type.Object({
      /** The entity key, as `list_entities` and `get_entity` report it. */
      key: Type.String(),
      /** The placeholder this export used. The site does not publish it. */
      id: Type.String(),
    })
  ),
  truncation: EntityMcpTruncationSchema,
  warnings: EntityMcpWarningsSchema,
});

export type EntityMcpGraphResult = Static<typeof EntityMcpGraphResultSchema>;

export const EntityMcpCompareResultSchema = Type.Object({
  site: Type.String(),
  fromRunId: Type.String(),
  toRunId: Type.String(),
  diff: EntityMapDiffSchema,
  truncation: EntityMcpTruncationSchema,
  warnings: EntityMcpWarningsSchema,
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
  /**
   * Whether the entity rules RAN for this audit.
   *
   * False means the audit was crawled but never analyzed, so the arrays below
   * are empty for lack of evaluation rather than for lack of problems. Those
   * two produce an identical response otherwise, and only one of them is good
   * news.
   */
  analyzed: Type.Boolean(),
  findings: Type.Array(EntityMcpFindingSchema),
  /** Rules that ran and had nothing to report. */
  passed: Type.Array(Type.String()),
  /** Rules that could not run, with why. */
  skipped: Type.Array(Type.Object({ ruleId: Type.String(), reason: Type.String() })),
  /**
   * Always truncated, and says why.
   *
   * A finding's keys and pages are clipped by the RULE that produced them
   * before this tool sees them, so no count anywhere can say how much was left
   * out. The flag is standing rather than conditional because the alternative
   * is a `truncated: false` that an agent would read as a complete affected set.
   */
  truncation: EntityMcpTruncationSchema,
  warnings: EntityMcpWarningsSchema,
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
