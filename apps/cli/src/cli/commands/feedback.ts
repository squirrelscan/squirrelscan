// squirrelscan feedback - submit feedback to the team

import { FEEDBACK_CATEGORIES } from "@squirrelscan/utils/constants";
import { defineCommand } from "citty";
import { createInterface } from "node:readline";
import { z } from "zod";

import { cliApi } from "@/lib/api-client";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { getInstallId } from "@/self/install-id";
import { loadUserSettings, updateSettings } from "@/self/settings";
import { safeExit } from "@/self/updater";

import { version } from "../../../package.json";

const FEEDBACK_FALLBACK_URL = "https://squirrelscan.com/feedback";

const CATEGORY_LABELS: Record<(typeof FEEDBACK_CATEGORIES)[number], string> = {
  bug_report: "Bug report",
  feature_request: "Feature request",
  what_worked: "Something worked well",
  confusing: "Something was confusing",
  missing_data: "Missing data in a report",
  tool_ergonomics: "Tool ergonomics",
  other: "Other",
};

const emailSchema = z.string().email();

async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function promptCategory(
  rl: ReturnType<typeof createInterface>
): Promise<string | null> {
  console.log("\nCategory (optional):");
  for (const [i, category] of FEEDBACK_CATEGORIES.entries()) {
    console.log(`  ${i + 1}) ${CATEGORY_LABELS[category]}`);
  }

  while (true) {
    const input = (await prompt(rl, "Category [Enter to skip]: ")).trim();
    if (!input) return null;

    const index = Number(input);
    if (
      Number.isInteger(index) &&
      index >= 1 &&
      index <= FEEDBACK_CATEGORIES.length
    ) {
      return FEEDBACK_CATEGORIES[index - 1] ?? null;
    }
    console.log(
      `Enter a number 1-${FEEDBACK_CATEGORIES.length}, or press Enter to skip.`
    );
  }
}

export const feedback = defineCommand({
  meta: {
    name: "feedback",
    description: "Send feedback to the squirrelscan team",
  },
  args: {
    category: {
      type: "string",
      description: `Feedback category (${FEEDBACK_CATEGORIES.join(", ")})`,
    },
  },
  async run({ args }) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const settingsResult = loadUserSettings();
      warnIfSessionUnreadable(settingsResult);
      const cachedEmail = settingsResult.ok
        ? settingsResult.data.user_feedback_email
        : null;

      // Resolve --category up front; an unknown value falls through to the
      // interactive picker rather than erroring (the server clamps anyway).
      let category: string | null = null;
      let askCategory = true;
      if (args.category) {
        if (
          (FEEDBACK_CATEGORIES as readonly string[]).includes(args.category)
        ) {
          category = args.category;
          askCategory = false;
        } else {
          console.log(
            `Unknown category "${args.category}" (valid: ${FEEDBACK_CATEGORIES.join(", ")}).`
          );
        }
      }

      // Prompt for email
      let email: string;
      const emailPrompt = cachedEmail ? `Email [${cachedEmail}]: ` : "Email: ";

      while (true) {
        const input = await prompt(rl, emailPrompt);
        email = input.trim() || cachedEmail || "";

        if (!email) {
          console.log("Email is required.");
          continue;
        }

        const result = emailSchema.safeParse(email);
        if (!result.success) {
          console.log("Invalid email address.");
          continue;
        }

        break;
      }

      // Prompt for feedback
      let feedbackText: string;
      while (true) {
        feedbackText = await prompt(rl, "Feedback: ");
        feedbackText = feedbackText.trim();

        if (feedbackText.length < 5) {
          console.log("Feedback must be at least 5 characters.");
          continue;
        }

        break;
      }

      if (askCategory) {
        category = await promptCategory(rl);
      }

      rl.close();

      // Save email for next time
      if (email !== cachedEmail) {
        updateSettings({ user_feedback_email: email });
      }

      // Submit feedback
      const installId = getInstallId();
      const payload: Record<string, unknown> = {
        email,
        feedback: feedbackText,
        source: "cli",
        client_version: version,
        metadata: { platform: process.platform, arch: process.arch },
      };
      if (installId) {
        payload.install_id = installId;
      }
      if (category) {
        payload.category = category;
      }

      const { ok } = await cliApi.request("/v1/feedback", {
        method: "POST",
        auth: "none",
        body: payload,
      });

      if (!ok) {
        console.error(
          `Failed to submit feedback. Please try again at: ${FEEDBACK_FALLBACK_URL}`
        );
        return safeExit(1);
      }

      console.log("\nThank you for your feedback!");
    } catch (error) {
      rl.close();
      console.error(
        `Error: ${(error as Error).message}\nPlease try again at: ${FEEDBACK_FALLBACK_URL}`
      );
      return safeExit(1);
    }
  },
});
