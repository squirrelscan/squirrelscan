// #861: `squirrel credits` prints the server's price list, and that list still
// carries `issue_enrich` (3 per issue) from the shared pricing table. The cloud
// has AI issue enrichment switched off, so the line advertised a charge for
// something nobody can buy. The printout leaves it out; the opt-in add-ons it
// does sell still print.
//
// Same seams as credits-unlimited.test.ts: the cloud client and the credential
// warning are spied (never mock.module), console.log is captured.

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { credits } from "@/cli/commands/credits";
import { AUDIT_BASE_CREDITS } from "@/lib/upgrade";
import * as credentialsModule from "@/self/credentials";
import * as cloudModule from "@/tools/cloud";

const PRICING = {
  audit_base: { cost: AUDIT_BASE_CREDITS, per: 1, unit: "run" },
  audit_page: { cost: 2, per: 1, unit: "page" },
  external_link: { cost: 1, per: 1, unit: "url" },
  render: { cost: 2, per: 1, unit: "page" },
  keyword_gaps: { cost: 25, per: 1, unit: "run" },
  content_gaps: { cost: 25, per: 1, unit: "run" },
  issue_enrich: { cost: 3, per: 1, unit: "issue" },
};

const warnSpy = spyOn(
  credentialsModule,
  "warnIfSessionUnreadable"
).mockImplementation(() => {});

const cloudClientSpy = spyOn(
  cloudModule,
  "createCloudClientFromSettings"
).mockImplementation(
  () =>
    ({
      getBalance: async () => ({
        balance: {
          monthly: 2000,
          pack: 340,
          total: 2340,
          periodEnd: "2026-11-08T00:00:00Z",
        },
        plan: { id: "pro", name: "Pro", monthlyCredits: 3000 },
        pricing: PRICING,
        pricingVersion: 12,
      }),
    }) as unknown as ReturnType<
      typeof cloudModule.createCloudClientFromSettings
    >
);

let logged: string[] = [];
const logSpy = spyOn(console, "log").mockImplementation(
  (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  }
);

afterAll(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  cloudClientSpy.mockRestore();
});

beforeEach(() => {
  logged = [];
});

async function runCredits(): Promise<string> {
  await (
    credits.run as unknown as (ctx: {
      args: Record<string, unknown>;
    }) => Promise<void>
  )({
    args: {},
  });
  return logged.join("\n");
}

describe("`squirrel credits` pricing (#861)", () => {
  test("leaves out issue enrichment, which the cloud does not sell", async () => {
    const output = await runCredits();
    expect(output).toContain("Pricing:");
    expect(output).not.toContain("issue_enrich");
  });

  test("still lists the opt-in add-ons", async () => {
    const output = await runCredits();
    expect(output).toContain("content_gaps");
    expect(output).toContain("keyword_gaps");
  });
});
