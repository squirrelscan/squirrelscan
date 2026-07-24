// squirrel credits - cloud credit balance + pricing

import { defineCommand } from "citty";

import { warnIfSessionUnreadable } from "@/self/credentials";
import { safeExit } from "@/self/updater";

const TOP_UP_URL = "https://squirrelscan.com/account/credits";

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
  },
  async run({ args }) {
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
      console.log(`Plan:    ${plan.name}`);
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
      console.log(`Top up: ${TOP_UP_URL}`);
    } catch (error) {
      console.error(`Could not fetch balance: ${(error as Error).message}`);
      return safeExit(1);
    }
  },
});
