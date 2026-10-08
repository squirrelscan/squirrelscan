// security/graphql-introspection - GraphQL introspection open on the audited site
//
// A probing rule: it sends requests beyond the crawl, so it runs only when the
// probing intensity allows it (`ctx.probe`, see probe-budget.ts) and sends
// nothing on a passive run. Endpoint selection, the requests and the response
// parsing live in graphql-probe.ts, shared with security/graphql-get-mutations.
//
// Per endpoint: one GET carrying the introspection query in the URL. When that
// answer is GraphQL-shaped but carries no schema (and does not say
// introspection is off), and only on an aggressive run, one POST of the same
// read-only query follows. Nothing else is sent.

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  errorSummary,
  type GraphqlBody,
  type GraphqlCandidate,
  type GraphqlProbeOutcome,
  isSuccessStatus,
  parseGraphqlBody,
  selectGraphqlCandidates,
  sendGraphqlProbe,
  truncatedSchemaTypeNames,
} from "./graphql-probe";

const CHECK = "graphql-introspection";

/** Type names every GraphQL schema has, whatever the API. */
const BUILT_IN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

export interface SchemaSummary {
  /** Every type the schema listed. */
  types: number;
  /** Types the API defines itself: not `__*` introspection types or built-in scalars. */
  apiTypes: number;
  /**
   * The truncated verdict: the answer opened as a schema but was longer than
   * the read cap, so it is open but too large to count. The counts are what the
   * first 1 MB held (lower bounds), and the finding is lower confidence.
   */
  truncated?: true;
}

function isApiType(name: string): boolean {
  return !name.startsWith("__") && !BUILT_IN_SCALARS.has(name);
}

/**
 * The schema in an introspection answer, or null. Needs `data.__schema.types`
 * to be a non-empty array of objects that each have a string `name`.
 */
export function readSchema(body: GraphqlBody | null): SchemaSummary | null {
  const schema = body?.data?.__schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return null;
  const types = (schema as Record<string, unknown>).types;
  if (!Array.isArray(types) || types.length === 0) return null;
  let apiTypes = 0;
  for (const t of types) {
    if (typeof t !== "object" || t === null) return null;
    const name = (t as Record<string, unknown>).name;
    if (typeof name !== "string") return null;
    if (isApiType(name)) apiTypes++;
  }
  return { types: types.length, apiTypes };
}

/** An error that says introspection is turned off. A POST would get the same answer. */
function saysIntrospectionDisabled(body: GraphqlBody): boolean {
  return body.errors.some((e) => /introspection/i.test(e.message));
}

type EndpointVerdict =
  | { kind: "exposed"; method: "GET" | "POST"; schema: SchemaSummary }
  | { kind: "graphql"; errors: string[] }
  | { kind: "not-graphql" }
  | { kind: "errored" }
  | { kind: "not-sent" };

/**
 * The schema in a 2xx answer: parsed in full, or, when the answer was longer
 * than the read cap, counted from its first bytes (lower bounds).
 */
function schemaFrom(outcome: GraphqlProbeOutcome): SchemaSummary | null {
  if (!outcome.sent || "error" in outcome) return null;
  if (!isSuccessStatus(outcome.response.status)) return null;
  const full = readSchema(parseGraphqlBody(outcome.response));
  if (full) return full;
  const names = truncatedSchemaTypeNames(outcome.response);
  if (!names) return null;
  return { types: names.length, apiTypes: names.filter(isApiType).length, truncated: true };
}

async function probeEndpoint(ctx: RuleContext, candidate: GraphqlCandidate): Promise<EndpointVerdict> {
  const get = await sendGraphqlProbe(ctx.probe, candidate.url, { op: "introspection", method: "GET" });
  if (!get.sent) return { kind: "not-sent" };
  if ("error" in get) return { kind: "errored" };
  const schema = schemaFrom(get);
  if (schema) return { kind: "exposed", method: "GET", schema };
  const body = parseGraphqlBody(get.response);
  if (!body) return { kind: "not-graphql" };

  // GraphQL answered without a schema. One POST, only when aggressive, and not
  // when the server already said introspection is off.
  if (ctx.probe?.level === "aggressive" && !saysIntrospectionDisabled(body)) {
    const post = await sendGraphqlProbe(ctx.probe, candidate.url, {
      op: "introspection",
      method: "POST",
    });
    const postSchema = schemaFrom(post);
    if (postSchema) return { kind: "exposed", method: "POST", schema: postSchema };
  }
  return { kind: "graphql", errors: errorSummary(body) };
}

export const graphqlIntrospectionRule: Rule = {
  meta: {
    id: "security/graphql-introspection",
    name: "GraphQL Introspection",
    description:
      "Probes the site's GraphQL endpoints with a read-only introspection query and flags an endpoint that returns its full schema, which maps the whole API for an attacker. Runs only when probing is active or aggressive.",
    solution:
      "Turn introspection off in production. Most servers have one setting for it: `introspection: false` in Apollo Server, `NoSchemaIntrospectionCustomRule` in graphql-js validation rules, `HASURA_GRAPHQL_ENABLE_INTROSPECTION=false` or per-role introspection limits in Hasura, and `spring.graphql.schema.introspection.enabled=false` in Spring for GraphQL. Keep it on only in development or behind authentication. Turning it off hides the map, not the API: every resolver still needs its own authorization checks.",
    category: "security",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no GraphQL endpoint was probed. Run with --probe active to check for open introspection.",
      });
      return { checks };
    }

    const selection = selectGraphqlCandidates(ctx);
    const details = {
      skippedStateChanging: selection.skippedStateChanging,
      skippedRobots: selection.skippedRobots,
      skippedCap: selection.skippedCap,
    };
    if (selection.candidates.length === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: "No same-origin GraphQL endpoint could be probed",
        details,
      });
      return { checks };
    }

    let probed = 0;
    let graphqlAnswers = 0;
    let errored = 0;
    let budgetStopped = false;
    const exposed: Array<{ candidate: GraphqlCandidate; method: "GET" | "POST"; schema: SchemaSummary }> = [];
    for (const candidate of selection.candidates) {
      const verdict = await probeEndpoint(ctx, candidate);
      if (verdict.kind === "not-sent") {
        budgetStopped = true;
        break;
      }
      probed++;
      if (verdict.kind === "errored") errored++;
      if (verdict.kind === "exposed") exposed.push({ candidate, ...verdict });
      if (verdict.kind === "exposed" || verdict.kind === "graphql") graphqlAnswers++;
    }

    if (probed === 0) {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probe-budget",
        message: "The probe budget ran out before any GraphQL endpoint was probed",
        details,
      });
      return { checks };
    }

    if (errored === probed) {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probe-errors",
        message: `Every GraphQL probe failed with a network error or timeout (${probed} endpoint(s)), so introspection was not checked`,
        details: { ...details, probed, errored },
      });
      return { checks };
    }

    for (const { candidate, method, schema } of exposed) {
      const seen = schema.types > 0 ? `at least ${schema.types} types seen, ` : "";
      const message = schema.truncated
        ? `GraphQL introspection is open at ${candidate.url}: the schema answer is larger than 1 MB, too large to count (${seen}answered over ${method})`
        : `GraphQL introspection is open at ${candidate.url}: the schema lists ${schema.types} types, ${schema.apiTypes} of them defined by the API (answered over ${method})`;
      const label = schema.truncated
        ? `${candidate.url} (${method}): schema over 1 MB, too large to count`
        : `${candidate.url} (${method}): ${schema.types} types, ${schema.apiTypes} API-defined`;
      checks.push({
        name: CHECK,
        status: "warn",
        message,
        items: [
          {
            id: candidate.url,
            label,
            meta: {
              method,
              types: schema.types,
              apiTypes: schema.apiTypes,
              ...(schema.truncated ? { truncated: true, confidence: "lower" } : {}),
              source: candidate.source,
              discoveredVia: candidate.discoveredVia,
            },
          },
        ],
        details: { endpoint: candidate.url, method, ...schema },
      });
    }

    if (exposed.length === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: `No GraphQL endpoint returned its schema (${probed} endpoint(s) probed, ${graphqlAnswers} answered as GraphQL)`,
        details: { ...details, probed, graphqlAnswers, errored, budgetStopped },
      });
    }
    return { checks };
  },
};
