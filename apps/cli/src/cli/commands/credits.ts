// squirrelscan credits - cloud credit balance + pricing

import { defineCommand } from "citty";

import { fmt } from "@/cli/format";
import { isUnlimitedBalance } from "@/lib/balance";
import { openBrowser } from "@/lib/browser";
import { AUDIT_BASE_CREDITS, proPitchLines, upgradeUrl } from "@/lib/upgrade";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { safeExit } from "@/self/updater";

const UPGRADE_URL = upgradeUrl("cli-credits");

export const credits = defineCommand({
  meta: {
    name: "credits",
    description: "Show cloud credit balance and feature pricing",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
    upgrade: {
      type: "boolean",
      description: "Open the upgrade page in your browser",
    },
  },
  async run({ args }) {
    // --upgrade is deliberately answered BEFORE the credential check: someone
    // who wants to pay should not have to log in to the CLI first to be told
    // where. It is also the whole point of the flag for users who never open
    // the dashboard.
    if (args.upgrade) {
      console.log(`Upgrade: ${fmt.cyan(UPGRADE_URL)}`);
      // Best-effort: a headless box, WSL without a handler, or no DESKTOP
      // session just leaves the printed URL above as the answer.
      await openBrowser(UPGRADE_URL).catch(() => {
        console.log(fmt.dim("Couldn't open a browser. Copy the URL above."));
      });
      return;
    }

    warnIfSessionUnreadable();
    const { createCloudClientFromSettings } = await import("@/tools/cloud");

    const client = createCloudClientFromSettings();
    if (!client) {
      console.error(
        "Not logged in. Run `squirrel auth login` to enable cloud features."
      );
      return safeExit(1);
    }

    try {
      const res = await client.getBalance();

      if (args.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      const { balance, plan, pricing } = res;
      const unlimited = isUnlimitedBalance(balance);
      console.log(`Plan:    ${plan.name}`);
      if (unlimited) {
        // The stored numbers are frozen on an unmetered plan, so printing them
        // (or the monthly/reset/below-base lines) would describe a balance that
        // does not govern anything. Usage is still recorded and invoiced.
        console.log("Balance: unlimited");
        console.log(
          fmt.dim("         usage is recorded on your account and invoiced")
        );
      } else {
        console.log(
          `Balance: ${balance.total} credits` +
            (balance.monthly > 0
              ? ` (${balance.monthly} monthly + ${balance.pack} purchased)`
              : "")
        );
        if (balance.periodEnd) {
          console.log(
            `         monthly credits reset ${balance.periodEnd.slice(0, 10)}`
          );
        }
        // A balance under the flat base can buy NOTHING, however positive it
        // reads. Say so here rather than letting the next `squirrel audit`
        // silently drop to local-only.
        if (balance.total < AUDIT_BASE_CREDITS) {
          console.log(
            `         ${fmt.yellow(`below the ${AUDIT_BASE_CREDITS}-credit audit base — cloud audits can't start`)}`
          );
        }
      }
      console.log("");
      console.log("Pricing:");
      // Pricing v10: flat headline (base + per rendered page); cost-0 features
      // are included in the base, so only itemize what still charges.
      const priced = pricing as Record<
        string,
        { cost: number; per: number; unit: string } | undefined
      >;
      const auditBase = priced.audit_base?.cost;
      if (auditBase != null) {
        console.log(
          `  audit                ${String(auditBase).padStart(3)} base + ${priced.render?.cost ?? 2} per rendered page`
        );
        console.log(
          "                           (analysis, tech detection, domain stats, publishing included)"
        );
      }
      const entries = Object.entries(pricing)
        .filter(
          ([feature, price]) =>
            price.cost > 0 &&
            (auditBase == null ||
              (feature !== "audit_base" &&
                feature !== "render" &&
                feature !== "render_cached"))
        )
        .sort(([a], [b]) => a.localeCompare(b));
      for (const [feature, price] of entries) {
        const per =
          price.per === 1
            ? `per ${price.unit}`
            : `per ${price.per} ${price.unit}s`;
        console.log(
          `  ${feature.padEnd(20)} ${String(price.cost).padStart(3)} ${per}`
        );
      }
      console.log("");
      // The free plan is where the wall gets hit, so that is where the offer
      // goes. Paid plans get the top-up link, not a plan pitch they're on.
      // An unmetered plan gets NEITHER: there is no balance to top up and no
      // plan above it to sell (see SELF_SERVE_PLAN_IDS).
      if (unlimited) {
        // nothing to sell
      } else if (plan.id === "free") {
        for (const line of proPitchLines("cli-credits")) console.log(line);
        console.log(fmt.dim("  Or run `squirrel credits --upgrade`."));
      } else {
        console.log(`Top up: ${fmt.cyan(UPGRADE_URL)}`);
      }
    } catch (error) {
      console.error(`Could not fetch balance: ${(error as Error).message}`);
      return safeExit(1);
    }
  },
});
