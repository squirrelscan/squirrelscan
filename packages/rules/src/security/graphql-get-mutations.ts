// security/graphql-get-mutations - GraphQL mutations executed over GET
//
// A GET is a simple cross-site request: an image tag, a link prefetch or a
// top-level navigation on another site sends it with the visitor's cookies.
// A GraphQL server that executes a mutation sent over GET therefore exposes
// every mutation to cross-site request forgery, and breaks the rule that GET
// is safe and idempotent. The GraphQL-over-HTTP spec says a server must reject
// a mutation over GET (405).
//
// A probing rule: it runs only when the probing intensity allows it
// (`ctx.probe`) and sends nothing on a passive run. Per endpoint it sends one
// GET carrying the no-op mutation `mutation{__typename}`, which selects no
// schema field, so no resolver runs and nothing can be written. It never sends
// a schema-specific mutation and never sends a POST. Endpoint selection, the
// request and the response parsing live in graphql-probe.ts.

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  type GraphqlBody,
  type GraphqlCandidate,
  isSuccessStatus,
  parseGraphqlBody,
  selectGraphqlCandidates,
  sendGraphqlProbe,
} from "./graphql-probe";

const CHECK = "graphql-get-mutations";

/**
 * The mutation root type name when the server executed the no-op mutation, or
 * null. The name is whatever the schema calls its mutation root (`Mutation`,
 * `mutation_root` in Hasura, `RootMutationType` in Absinthe), so it must
 * contain "mutation". A `Query` answer means the operation ran as a query,
 * which is not a mutation over GET.
 */
export function executedMutationType(body: GraphqlBody | null): string | null {
  const typename = body?.data?.__typename;
  if (typeof typename !== "string") return null;
  return /mutation/i.test(typename) ? typename : null;
}

export const graphqlGetMutationsRule: Rule = {
  meta: {
    id: "security/graphql-get-mutations",
    name: "GraphQL Mutations over GET",
    description:
      "Probes the site's GraphQL endpoints with a no-op mutation sent over GET and flags an endpoint that executes it, which exposes every mutation to cross-site request forgery. Runs only when probing is active or aggressive.",
    solution:
      "Reject every operation other than a query when the request is a GET, with a 405 Method Not Allowed, as the GraphQL-over-HTTP spec requires. Accept mutations only over POST, and require a non-simple Content-Type such as `application/json` (which a cross-site form or image cannot send without a CORS preflight) or a CSRF token. Apollo Server, graphql-http and express-graphql already refuse a mutation over GET, so a finding usually points at a custom HTTP handler that passes GET query strings straight to the executor: check the operation type before you execute it.",
    category: "security",
    scope: "site",
    severity: "error",
    weight: 7,
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no GraphQL endpoint was probed. Run with --probe active to check whether mutations run over GET.",
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
    let budgetStopped = false;
    const executed: Array<{ candidate: GraphqlCandidate; typename: string }> = [];
    for (const candidate of selection.candidates) {
      const outcome = await sendGraphqlProbe(ctx.probe, candidate.url, {
        op: "noop-mutation",
        method: "GET",
      });
      if (!outcome.sent) {
        budgetStopped = true;
        break;
      }
      probed++;
      if ("error" in outcome) continue;
      const body = parseGraphqlBody(outcome.response);
      if (!body) continue;
      graphqlAnswers++;
      const typename = isSuccessStatus(outcome.response.status) ? executedMutationType(body) : null;
      if (typename) executed.push({ candidate, typename });
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

    for (const { candidate, typename } of executed) {
      checks.push({
        name: CHECK,
        status: "fail",
        message: `${candidate.url} executes GraphQL mutations sent over GET: any site can trigger a state-changing operation with your visitors' cookies (CSRF), and GET is no longer safe and idempotent. Reject non-query operations over GET and require POST with a non-simple Content-Type or a CSRF token.`,
        items: [
          {
            id: candidate.url,
            label: `${candidate.url}: GET mutation{__typename} answered ${typename}`,
            meta: {
              mutationType: typename,
              source: candidate.source,
              discoveredVia: candidate.discoveredVia,
            },
          },
        ],
        details: { endpoint: candidate.url, mutationType: typename },
      });
    }

    if (executed.length === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: `No GraphQL endpoint executed a mutation sent over GET (${probed} endpoint(s) probed, ${graphqlAnswers} answered as GraphQL)`,
        details: { ...details, probed, graphqlAnswers, budgetStopped },
      });
    }
    return { checks };
  },
};
