// What the CLI says when credits run out.
//
// Measured on prod 2026-08-26: 12 of the 13 orgs that ever ran their balance
// below the cost of one audit never ran another audit. The CLI's answer at that
// moment was the server's bare sentence, and `squirrel credits` pointed at
// https://squirrelscan.com/account/credits — a URL that has never been a route.
// So these assert the two things that were missing: a working URL, and a price.

import { computeCost } from "@squirrelscan/core-contracts/credits";
import { getPlan } from "@squirrelscan/core-contracts/plans";
import { describe, expect, test } from "bun:test";

import {
  computePreflightAffordability,
  lowBalanceFooterLines,
  registerFailureLines,
} from "../../src/cli/commands/audit";
import {
  AUDIT_BASE_CREDITS,
  offerPitchLines,
  PRO_HEADLINE,
  proPitchLines,
  resetDateLabel,
  upgradeUrl,
} from "../../src/lib/upgrade";

const PRO = getPlan("starter");
const UPGRADE = "https://squirrelscan.com/upgrade?src=cli-audit";
const text = (lines: string[]) => lines.join("\n");

describe("the upgrade offer", () => {
  test("names the price, the term price and the monthly grant", () => {
    expect(PRO_HEADLINE).toContain(`$${PRO.priceMonthUsd}`);
    expect(PRO_HEADLINE).toContain(`$${PRO.priceYearUsd}`);
    expect(PRO_HEADLINE).toContain(PRO.monthlyCredits.toLocaleString("en-US"));
  });

  test('says "Pro", never the internal plan id', () => {
    const pitch = text(proPitchLines("cli-credits"));
    expect(pitch).toContain("Pro");
    expect(pitch).not.toContain("starter");
  });

  test("carries a squirrelscan.com/upgrade URL, not the dead /account/credits", () => {
    const pitch = text(proPitchLines("cli-credits"));
    expect(pitch).toContain("https://squirrelscan.com/upgrade?src=cli-credits");
    expect(pitch).not.toContain("/account/credits");
    expect(upgradeUrl("cli")).toBe("https://squirrelscan.com/upgrade?src=cli");
  });

  test("the audit base tracks the shared pricing source", () => {
    expect(AUDIT_BASE_CREDITS).toBe(computeCost("audit_base", 1));
  });
});

describe("registerFailureLines", () => {
  const insufficient = {
    code: "INSUFFICIENT_CREDITS",
    message: "Insufficient credits for the audit base",
    balance: 12,
    // #2183: the server now states the cost, the reset date and the offer.
    // Null here is the OLD server's answer, which every assertion below still
    // has to survive — a released binary talks to whatever API it finds.
    required: null,
    resetAt: null,
    upgrade: null,
  };

  test("out of credits gets the balance, the price and a working upgrade URL", () => {
    const out = text(registerFailureLines(insufficient));
    expect(out).toContain("12 credits");
    expect(out).toContain(String(AUDIT_BASE_CREDITS));
    expect(out).toContain(`$${PRO.priceMonthUsd}`);
    expect(out).toContain(UPGRADE);
  });

  test("says the audit itself still ran, so the warning isn't read as a failure", () => {
    expect(text(registerFailureLines(insufficient)).toLowerCase()).toContain(
      "ran locally"
    );
  });

  test("degrades without a balance rather than printing null", () => {
    const out = text(registerFailureLines({ ...insufficient, balance: null }));
    expect(out).not.toContain("null");
    expect(out).toContain(UPGRADE);
  });

  test("other definitive failures are not turned into a plan pitch", () => {
    for (const code of ["WEBSITE_LIMIT", "ORG_LOCKED"]) {
      const out = text(
        registerFailureLines({
          code,
          message: "Website limit reached.",
          balance: null,
          required: null,
          resetAt: null,
          upgrade: null,
        })
      );
      expect(out).toContain("Website limit reached.");
      expect(out).not.toContain(UPGRADE);
      expect(out).not.toContain(`$${PRO.priceMonthUsd}`);
    }
  });
});

describe("lowBalanceFooterLines", () => {
  const free = getPlan("free").monthlyCredits;

  test("warns at 20% of the grant, while credits remain to spend", () => {
    const out = text(
      lowBalanceFooterLines({ balance: 80, monthlyCredits: free, plan: "free" })
    );
    expect(out).toContain("80 credits left");
    expect(out).toContain(UPGRADE);
  });

  test("stays quiet on a healthy balance", () => {
    expect(
      lowBalanceFooterLines({
        balance: 100,
        monthlyCredits: free,
        plan: "free",
      })
    ).toEqual([]);
    expect(
      lowBalanceFooterLines({
        balance: free,
        monthlyCredits: free,
        plan: "free",
      })
    ).toEqual([]);
  });

  test("a stranded sub-base balance says the next audit can't start", () => {
    const out = text(
      lowBalanceFooterLines({ balance: 12, monthlyCredits: free, plan: "free" })
    );
    expect(out).toContain(`below the ${AUDIT_BASE_CREDITS}-credit audit base`);
    expect(out).toContain(UPGRADE);
  });

  test("paid plans get a top-up link, not a pitch for the plan they're on", () => {
    const out = text(
      lowBalanceFooterLines({ balance: 12, monthlyCredits: 3000, plan: "paid" })
    );
    expect(out).toContain(UPGRADE);
    expect(out).not.toContain(`$${PRO.priceMonthUsd}`);
  });

  test("anonymous and unknown balances print nothing", () => {
    expect(
      lowBalanceFooterLines({
        balance: 0,
        monthlyCredits: free,
        plan: "anonymous",
      })
    ).toEqual([]);
    expect(
      lowBalanceFooterLines({
        balance: null,
        monthlyCredits: free,
        plan: "free",
      })
    ).toEqual([]);
  });

  test("a plan with no monthly grant warns only once it can't buy an audit", () => {
    // Team pools credits per seat, so there is no share to measure against.
    expect(
      lowBalanceFooterLines({
        balance: AUDIT_BASE_CREDITS,
        monthlyCredits: 0,
        plan: "paid",
      })
    ).toEqual([]);
    expect(
      lowBalanceFooterLines({ balance: 10, monthlyCredits: 0, plan: "paid" })
        .length
    ).toBeGreaterThan(0);
  });
});

// #2183: the wall is now built from the API's refusal, not from copy compiled
// into the binary. That is what lets the link name the ORG that hit the wall —
// credits are not transferable, so a link that lands on the user's default org
// sells credits the blocked audit cannot spend.
describe("the server's offer", () => {
  const OFFER = {
    url: "https://app.squirrelscan.com/upgrade?plan=pro&interval=month&org=01TEST0000000000000000000A",
    plan: "pro",
    interval: "month",
    name: "Pro",
    priceMonthUsd: 19,
    priceYearUsd: 190,
    monthlyCredits: 3000,
  };

  test("the pitch carries the org-targeted link, not the static marketing URL", () => {
    const pitch = text(offerPitchLines(OFFER, "cli-audit"));
    expect(pitch).toContain("org=01TEST0000000000000000000A");
    expect(pitch).toContain("plan=pro");
    expect(pitch).toContain("interval=month");
    expect(pitch).not.toContain(UPGRADE);
  });

  test("the price comes from the offer, so a binary cannot quote a stale one", () => {
    const pitch = text(
      offerPitchLines({ ...OFFER, priceMonthUsd: 29 }, "cli-audit")
    );
    expect(pitch).toContain("$29");
  });

  test("falls back to the static pitch when the server sent no offer", () => {
    expect(text(offerPitchLines(null, "cli-audit"))).toBe(
      text(proPitchLines("cli-audit"))
    );
  });

  test("the reset date is a calendar day, and absent rather than invented", () => {
    expect(resetDateLabel("2026-10-01T00:00:00.000Z")).toBe("2026-10-01");
    expect(resetDateLabel(null)).toBeNull();
    expect(resetDateLabel(undefined)).toBeNull();
    expect(resetDateLabel("not a date")).toBeNull();
  });
});

describe("registerFailureLines with a server offer (#2183)", () => {
  const OFFER = {
    url: "https://app.squirrelscan.com/upgrade?plan=pro&interval=month&org=01TEST0000000000000000000A",
    plan: "pro",
    interval: "month",
    name: "Pro",
    priceMonthUsd: 19,
    priceYearUsd: 190,
    monthlyCredits: 3000,
  };
  const walled = {
    code: "INSUFFICIENT_CREDITS",
    message: "Insufficient credits for the audit base",
    balance: 12,
    required: 50,
    resetAt: "2026-10-01T00:00:00.000Z",
    upgrade: OFFER,
  };

  test("states the cost, what is left, the reset date and the deep link", () => {
    const out = text(registerFailureLines(walled));
    expect(out).toContain("12 credits");
    expect(out).toContain("needs 50");
    expect(out).toContain("2026-10-01");
    expect(out).toContain(OFFER.url);
  });

  test("quotes the SERVER's cost, not the compiled-in base", () => {
    // A price change ships in the API long before every installed binary is
    // replaced, so the number on screen has to be the one that refused the run.
    const out = text(registerFailureLines({ ...walled, required: 75 }));
    expect(out).toContain("needs 75");
  });

  test("still names a cost when the balance is unknown", () => {
    const out = text(registerFailureLines({ ...walled, balance: null }));
    expect(out).not.toContain("null");
    expect(out).toContain("needs 50");
    expect(out).toContain(OFFER.url);
  });

  test("drops the reset clause rather than guessing a date", () => {
    const out = text(registerFailureLines({ ...walled, resetAt: null }));
    expect(out).not.toContain("reset on");
    expect(out).toContain(OFFER.url);
  });

  test("an unmetered account is still never pitched, offer or no offer", () => {
    const out = text(registerFailureLines(walled, true));
    expect(out).not.toContain(OFFER.url);
    expect(out).toContain("unmetered");
  });
});

describe("lowBalanceFooterLines with a server offer (#2183)", () => {
  const OFFER = {
    url: "https://app.squirrelscan.com/upgrade?plan=pro&interval=month&org=01TEST0000000000000000000A",
    plan: "pro",
    interval: "month",
    name: "Pro",
    priceMonthUsd: 19,
    priceYearUsd: 190,
    monthlyCredits: 3000,
  };

  test("a free plan gets the org-targeted link and the reset date", () => {
    const out = text(
      lowBalanceFooterLines({
        balance: 12,
        monthlyCredits: getPlan("free").monthlyCredits,
        plan: "free",
        upgrade: OFFER,
        resetAt: "2026-10-01T00:00:00.000Z",
      })
    );
    expect(out).toContain(OFFER.url);
    expect(out).toContain("2026-10-01");
    expect(out).not.toContain(UPGRADE);
  });

  test("a paid plan tops up through the same org-targeted link", () => {
    const out = text(
      lowBalanceFooterLines({
        balance: 12,
        monthlyCredits: 3000,
        plan: "paid",
        upgrade: OFFER,
      })
    );
    expect(out).toContain(OFFER.url);
    // Still no plan pitch for someone already paying.
    expect(out).not.toContain(`$${PRO.priceMonthUsd}/month`);
  });

  test("without an offer it falls back to the static URL, as an old API leaves it", () => {
    const out = text(
      lowBalanceFooterLines({
        balance: 12,
        monthlyCredits: getPlan("free").monthlyCredits,
        plan: "free",
      })
    );
    expect(out).toContain(UPGRADE);
  });

  test("an unmetered account says nothing, whatever offer is passed", () => {
    expect(
      lowBalanceFooterLines({
        balance: 0,
        monthlyCredits: 3000,
        plan: "paid",
        unlimited: true,
        upgrade: OFFER,
        resetAt: "2026-10-01T00:00:00.000Z",
      })
    ).toEqual([]);
  });
});

// #2183 F6a. The preflight shortfall warning fires when the balance covers the
// 50-credit base but not the pages — an audit that will start and then quietly
// stop rendering. It is the one CLI wall that was left on the org-less
// marketing URL, and it carried no reset date.
describe("computePreflightAffordability with a server offer", () => {
  const OFFER_URL =
    "https://app.squirrelscan.com/upgrade?plan=pro&interval=month&org=01TEST0000000000000000000A&src=cli";
  const opts = {
    balance: 120,
    maxPages: 100,
    cloudRendering: "browser" as const,
    topUpUrl: OFFER_URL,
  };

  test("warns with the org-scoped link rather than the marketing URL", () => {
    const out = text(computePreflightAffordability(opts).warningLines);
    expect(out).toContain(OFFER_URL);
    expect(out).not.toContain(UPGRADE);
  });

  test("names the cost, the balance and the reset date", () => {
    const out = text(
      computePreflightAffordability({
        ...opts,
        resetAt: "2026-10-01T00:00:00.000Z",
      }).warningLines
    );
    // 50 base + 2 x 100 rendered pages.
    expect(out).toContain("250");
    expect(out).toContain("120");
    expect(out).toContain("2026-10-01");
  });

  test("drops the reset clause rather than inventing a date", () => {
    const out = text(computePreflightAffordability(opts).warningLines);
    expect(out).not.toContain("Credits reset");
    expect(out).toContain(OFFER_URL);
  });

  test("stays silent when the balance covers the whole estimate", () => {
    expect(
      computePreflightAffordability({ ...opts, balance: 5000 }).warningLines
    ).toEqual([]);
  });

  test("an unmetered account is never warned, offer or no offer", () => {
    expect(
      computePreflightAffordability({ ...opts, balance: 0, unlimited: true })
        .warningLines
    ).toEqual([]);
  });

  test("http-only rendering has no page charge, so no shortfall to warn about", () => {
    // The base alone is 50 and the balance is 120, so only the render estimate
    // can push this over — proving the warning is about the pages, not the base.
    expect(
      computePreflightAffordability({ ...opts, cloudRendering: "http" })
        .warningLines
    ).toEqual([]);
  });
});

/**
 * #2183 F6a. The pure builders above take `topUpUrl` as an argument, so they
 * prove nothing about which URL the command actually hands them — reverting the
 * call site to `upgradeUrl("cli-audit")` left every test green, which is the
 * same composition gap the review found on the API side.
 *
 * These read the command source. Not elegant, but the alternative is driving a
 * full audit run, and a wall nobody can reach is exactly what this issue exists
 * to fix.
 */
describe("the audit command wires the server offer into its walls", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(
      import.meta.dir,
      "../../src/cli/commands/audit.ts"
    ),
    "utf8"
  ) as string;

  /** The argument object of a call, bounded generously. */
  function callArgs(marker: string): string {
    const at = source.indexOf(marker);
    expect(`${marker} found`).toBe(`${marker} found`);
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, at + 800);
  }

  test("the preflight shortfall warning prefers the offer link", () => {
    const args = callArgs("computePreflightAffordability({");
    expect(args).toContain("upgradeOffer?.url");
    expect(args).toContain("resetAt: creditsResetAt");
  });

  test("the end-of-run low-balance footer gets the offer and the reset date", () => {
    const args = callArgs("lowBalanceFooterLines({");
    expect(args).toContain("upgrade: upgradeOffer");
    expect(args).toContain("resetAt: creditsResetAt");
  });

  test("the local-only preflight line prefers the offer link", () => {
    // The most-seen CLI wall: the run never registers, so it never collects a
    // 402, and this single line is the whole offer.
    expect(source).toContain('upgrade?.url ?? upgradeUrl("cli-audit")');
  });

  test("the probe reads real call arguments, not just any substring", () => {
    // A green suite above means nothing if `callArgs` matched an import line or
    // a comment; prove the window really contains the argument object.
    expect(callArgs("computePreflightAffordability({")).toContain("maxPages");
    expect(callArgs("lowBalanceFooterLines({")).toContain("monthlyCredits");
  });
});
