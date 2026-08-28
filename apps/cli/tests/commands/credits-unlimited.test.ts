// Command-level coverage for an UNMETERED account (the internal enterprise
// plan), driving the real citty `run({ args })` rather than only the exported
// formatters.
//
// Why command-level: the first cut of this feature made every pure helper
// unlimited-aware and still shipped a Pro pitch, because one CALLER never passed
// the flag through. Helper tests cannot see a caller that forgets to ask. So
// these assert on what the command actually prints.
//
// Seams stubbed, following tests/commands/feedback.test.ts:
//   - @/tools/cloud createCloudClientFromSettings — spyOn (NOT mock.module,
//     which leaks process-wide per #1037) returning a client whose getBalance
//     replays a scripted /v1/credits payload. No network, no credentials.
//   - @/self/credentials warnIfSessionUnreadable — spyOn to a no-op so a real
//     ~/.squirrel read never happens.
//   - console.log — captured so the assertions read the actual output.

import { describe, expect, spyOn, test, beforeEach, afterAll } from "bun:test";

import { credits } from "@/cli/commands/credits";
import { AUDIT_BASE_CREDITS } from "@/lib/upgrade";
import * as credentialsModule from "@/self/credentials";
import * as cloudModule from "@/tools/cloud";

type Balance = {
  monthly: number;
  pack: number;
  total: number;
  periodEnd: string | null;
  unlimited?: boolean;
};

let balancePayload: Balance;
let planPayload: { id: string; name: string; monthlyCredits: number };

const PRICING = {
  audit_base: { cost: AUDIT_BASE_CREDITS, per: 1, unit: "audit" },
  render: { cost: 2, per: 1, unit: "page" },
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
        balance: balancePayload,
        plan: planPayload,
        pricing: PRICING,
        pricingVersion: 10,
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

// Restore EVERY top-level spy, not just console.log: these patch shared module
// namespaces, so a leaked credential or cloud-client stub would silently serve a
// canned balance to any later test file in the same bun process.
afterAll(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  cloudClientSpy.mockRestore();
});

beforeEach(() => {
  logged = [];
  // The realistic enterprise shape: nothing granted, nothing deducted, so the
  // stored total sits at 0 forever.
  balancePayload = {
    monthly: 0,
    pack: 0,
    total: 0,
    periodEnd: null,
    unlimited: true,
  };
  planPayload = { id: "enterprise", name: "Enterprise", monthlyCredits: 0 };
});

const output = () => logged.join("\n");

async function runCredits(): Promise<void> {
  await (
    credits.run as unknown as (ctx: {
      args: Record<string, unknown>;
    }) => Promise<void>
  )({ args: {} });
}

describe("`squirrel credits` on an unmetered account", () => {
  test('prints "unlimited", never the frozen zero', async () => {
    await runCredits();
    expect(output()).toContain("Balance: unlimited");
    // The frozen number would read as "you cannot afford anything".
    expect(output()).not.toContain("Balance: 0 credits");
  });

  test("says the usage is still recorded, so it does not read as free", async () => {
    await runCredits();
    expect(output()).toContain("invoiced");
  });

  test("never warns about being below the audit base", async () => {
    await runCredits();
    expect(output()).not.toContain("audit base");
    expect(output()).not.toContain("cloud audits can't start");
  });

  // The regression that shipped once: every helper was correct and a caller
  // still pitched Pro.
  test("shows NO Pro pitch, no upgrade URL and no top-up link", async () => {
    await runCredits();
    const text = output();
    expect(text).not.toContain("Pro:");
    expect(text).not.toContain("$19");
    expect(text).not.toContain("Top up");
    expect(text).not.toContain("squirrelscan.com/upgrade");
    expect(text).not.toContain("credits --upgrade");
  });

  test("still prints the pricing table: the spend is real, just invoiced", async () => {
    await runCredits();
    expect(output()).toContain("Pricing:");
    expect(output()).toContain(String(AUDIT_BASE_CREDITS));
  });

  test("--json passes the flag through untouched for scripts", async () => {
    await (
      credits.run as unknown as (ctx: {
        args: Record<string, unknown>;
      }) => Promise<void>
    )({ args: { json: true } });
    const parsed = JSON.parse(output()) as { balance: Balance };
    expect(parsed.balance.unlimited).toBe(true);
    expect(parsed.balance.total).toBe(0);
  });
});

describe("`squirrel credits` on a metered account (control)", () => {
  test("a free account still gets the Pro pitch", async () => {
    balancePayload = { monthly: 10, pack: 0, total: 10, periodEnd: null };
    planPayload = { id: "free", name: "Free", monthlyCredits: 500 };
    await runCredits();
    const text = output();
    expect(text).toContain("Balance: 10 credits");
    expect(text).toContain("Pro:");
    // 10 credits cannot buy the 50-credit base, so the warning must fire.
    expect(text).toContain("audit base");
  });

  test("a paid account still gets the top-up link", async () => {
    balancePayload = { monthly: 3000, pack: 0, total: 3000, periodEnd: null };
    planPayload = { id: "starter", name: "Pro", monthlyCredits: 3000 };
    await runCredits();
    expect(output()).toContain("Top up");
  });

  // An older server omits the field; reading absent as unlimited would hide a
  // real empty balance.
  test("an absent `unlimited` field is treated as metered", async () => {
    balancePayload = { monthly: 0, pack: 0, total: 0, periodEnd: null };
    planPayload = { id: "starter", name: "Pro", monthlyCredits: 3000 };
    await runCredits();
    const text = output();
    expect(text).toContain("Balance: 0 credits");
    expect(text).toContain("audit base");
    expect(text).not.toContain("Balance: unlimited");
  });
});
