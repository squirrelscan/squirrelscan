// #2315: with own-host pinning on (`ctx.ownHostEgress`), the GraphQL probes
// resolve the endpoint's name through the policy's resolver, refuse a
// link-local or cloud metadata answer before anything is sent, and connect to
// the checked address with the original Host and TLS server name. Without it
// they go out by name, as before, and nothing is looked up.

import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { CheckResult, Rule, RuleContext } from "../src/types";

import { createProbeBudget } from "../src/probe-budget";
import { RuleRunner } from "../src/runner";
import { graphqlGetMutationsRule } from "../src/security/graphql-get-mutations";
import { graphqlIntrospectionRule } from "../src/security/graphql-introspection";
import { BASE, candidate, ruleCtx, surface } from "./helpers/graphql-server";

const HOST = new URL(BASE).hostname;
const PUBLIC_ADDRESS = "93.184.215.14";

interface Sent {
  url: string;
  host: string | null;
  serverName: unknown;
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

/** Records every request; answers a GraphQL body that would flag both rules. */
function recordFetch(): Sent[] {
  const sent: Sent[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : String(input);
    sent.push({
      url,
      host: new Headers(init?.headers).get("host"),
      serverName: (init as { tls?: { serverName?: unknown } } | undefined)?.tls
        ?.serverName,
    });
    const query = new URL(url).searchParams.get("query") ?? "";
    const data = query.startsWith("mutation")
      ? { __typename: "Mutation" }
      : {
          __schema: {
            types: ["Query", "Mutation", "User", "String", "__Schema"].map(
              (name) => ({ name })
            ),
          },
        };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return sent;
}

function pinned(answers: string[]): {
  egress: EgressPolicy;
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    egress: {
      allowPrivateNetwork: true,
      resolve: async (name) => {
        lookups.push(name);
        return answers;
      },
    },
  };
}

function ctx(egress?: EgressPolicy): RuleContext {
  return {
    ...ruleCtx({ surface: surface([candidate("/graphql")]) }),
    ...(egress ? { ownHostEgress: egress } : {}),
  };
}

/** A finding: introspection warns, an executed mutation fails. */
function flagged(check: CheckResult): boolean {
  return check.status === "fail" || check.status === "warn";
}

const RULES: Array<[string, Rule]> = [
  ["security/graphql-introspection", graphqlIntrospectionRule],
  ["security/graphql-get-mutations", graphqlGetMutationsRule],
];

describe("GraphQL probes with own-host pinning (#2315)", () => {
  for (const [id, rule] of RULES) {
    test(`${id}: connects to the checked address, with the original Host and server name`, async () => {
      const sent = recordFetch();
      const { egress, lookups } = pinned([PUBLIC_ADDRESS]);
      const { checks } = await rule.run(ctx(egress));
      expect(lookups).toContain(HOST);
      expect(sent.length).toBeGreaterThan(0);
      for (const r of sent) {
        expect(new URL(r.url).hostname).toBe(PUBLIC_ADDRESS);
        expect(r.host).toBe(HOST);
        expect(r.serverName).toBe(HOST);
      }
      // The answer is read as usual: both rules flag what the stub returned.
      expect(checks.some(flagged)).toBe(true);
    });

    for (const answers of [
      ["169.254.169.254"],
      ["fd00:ec2::254"],
      [PUBLIC_ADDRESS, "169.254.169.254"],
    ]) {
      test(`${id}: refuses a name that resolves to ${answers.join(" + ")}, nothing sent`, async () => {
        const sent = recordFetch();
        const { egress } = pinned(answers);
        const { checks } = await rule.run(ctx(egress));
        expect(sent).toHaveLength(0);
        // Not checked, never clean and never an accusation.
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({
          status: "skipped",
          skipReason: "probe-errors",
        });
      });
    }

    test(`${id}: without pinning, the probe goes out by name, unpinned`, async () => {
      const sent = recordFetch();
      const { checks } = await rule.run(ctx());
      expect(sent.length).toBeGreaterThan(0);
      for (const r of sent) {
        expect(new URL(r.url).hostname).toBe(HOST);
        expect(r.host).toBeNull();
      }
      expect(checks.some(flagged)).toBe(true);
    });
  }

  test("the runner scope's ownHostEgress reaches a site rule's ctx", async () => {
    const sent = recordFetch();
    const { egress, lookups } = pinned([PUBLIC_ADDRESS]);
    const runner = new RuleRunner({
      config: {
        rule_options: {},
        rules: { enable: ["security/graphql-get-mutations"] },
      },
      probe: createProbeBudget({ level: "active", budgetMs: 60_000 }),
      ownHostEgress: egress,
    });
    await runner.runSiteRules(ctx().site!);
    expect(lookups).toContain(HOST);
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) expect(new URL(r.url).hostname).toBe(PUBLIC_ADDRESS);
  });
});
