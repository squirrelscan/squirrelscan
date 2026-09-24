// squirrelscan feedback - submit feedback to the team
//
// With the text on --message or piped on stdin it sends without a single
// prompt, for agents and scripts (#370). On a terminal with neither it asks
// for email, feedback and category, as it always has. --json prints one JSON
// object on stdout, never prompts, and every failure exits 1.

import {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
} from "@squirrelscan/utils/constants";
import { defineCommand } from "citty";
import { createInterface } from "node:readline";
import { z } from "zod";

import type { Result } from "@/controllers/types";
import type { UserSettings } from "@/self/types";

import { readStdinText, stdinIsTTY } from "@/cli/stdin";
import { createTheme } from "@/cli/theme";
import {
  FEEDBACK_FALLBACK_URL,
  FEEDBACK_ID_MAX_LENGTH,
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_MIN_LENGTH,
  type FeedbackSubmission,
  clampFeedbackMessage,
  defaultFeedbackEmail,
  isFeedbackCategory,
  submitFeedback,
} from "@/lib/feedback";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { loadUserSettings, updateSettings } from "@/self/settings";
import { safeExit } from "@/self/updater";

/** Past this, piped input is certainly over FEEDBACK_MAX_LENGTH; stop reading. */
const STDIN_MAX_BYTES = 64 * 1024;

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug_report: "Bug report",
  feature_request: "Feature request",
  what_worked: "Something worked well",
  confusing: "Something was confusing",
  missing_data: "Missing data in a report",
  tool_ergonomics: "Tool ergonomics",
  other: "Other",
};

const emailSchema = z.string().email();

type FeedbackErrorCode =
  | "message_required"
  | "message_too_short"
  | "invalid_category"
  | "invalid_email"
  | "email_required"
  | "invalid_run_id"
  | "invalid_website_id"
  | "rate_limited"
  | "submit_failed"
  | "unexpected";

interface Failure {
  ok: false;
  code: FeedbackErrorCode;
  error: string;
  /** HTTP status of a failed submission; 0 when the API was unreachable. */
  status?: number;
}

type Outcome =
  | { ok: true; category: FeedbackCategory | null; truncated: boolean }
  | Failure;

function fail(
  code: FeedbackErrorCode,
  error: string,
  status?: number
): Failure {
  return {
    ok: false,
    code,
    error,
    ...(status === undefined ? {} : { status }),
  };
}

interface FeedbackArgs {
  message?: string;
  category?: string;
  email?: string;
  "run-id"?: string;
  "website-id"?: string;
  json?: boolean;
}

type Settings = Result<UserSettings>;

/** --run-id and --website-id: optional, never blank or oversized. */
function readIds(
  args: FeedbackArgs
): { ok: true; runId?: string; websiteId?: string } | Failure {
  const ids: { runId?: string; websiteId?: string } = {};
  for (const [flag, key, code] of [
    ["run-id", "runId", "invalid_run_id"],
    ["website-id", "websiteId", "invalid_website_id"],
  ] as const) {
    const raw = args[flag];
    if (raw === undefined) continue;
    const value = String(raw).trim();
    if (!value || value.length > FEEDBACK_ID_MAX_LENGTH) {
      return fail(
        code,
        `--${flag} must be 1 to ${FEEDBACK_ID_MAX_LENGTH} characters.`
      );
    }
    ids[key] = value;
  }
  return { ok: true, ...ids };
}

async function submit(
  submission: FeedbackSubmission,
  truncated: boolean
): Promise<Outcome> {
  const result = await submitFeedback(submission);
  if (result.ok) {
    return { ok: true, category: submission.category ?? null, truncated };
  }
  if (result.rateLimited) {
    return fail(
      "rate_limited",
      "Failed to submit feedback: too many submissions. Wait a few minutes and try again.",
      result.status
    );
  }
  return fail(
    "submit_failed",
    result.status === 0
      ? "Failed to submit feedback: couldn't reach the squirrelscan API."
      : `Failed to submit feedback: the API answered HTTP ${result.status}.`,
    result.status
  );
}

/** --message or piped text: validate everything up front, then send. Never prompts. */
async function sendWithoutPrompts(
  args: FeedbackArgs,
  raw: string,
  settings: Settings
): Promise<Outcome> {
  const message = clampFeedbackMessage(raw);
  if (!message.text) {
    return fail(
      "message_required",
      'No feedback text. Pass it with --message "...", or pipe it on stdin.'
    );
  }
  if (message.text.length < FEEDBACK_MIN_LENGTH) {
    return fail(
      "message_too_short",
      `Feedback must be at least ${FEEDBACK_MIN_LENGTH} characters.`
    );
  }

  let category: FeedbackCategory | null = null;
  if (args.category !== undefined) {
    if (!isFeedbackCategory(args.category)) {
      return fail(
        "invalid_category",
        `Unknown category "${args.category}". Use one of: ${FEEDBACK_CATEGORIES.join(", ")}.`
      );
    }
    category = args.category;
  }

  const ids = readIds(args);
  if (!ids.ok) return ids;

  let email: string;
  if (args.email !== undefined) {
    email = args.email.trim();
    if (!emailSchema.safeParse(email).success) {
      return fail("invalid_email", `"${email}" is not a valid email address.`);
    }
    // Saved like a typed one, so the next run can leave --email off.
    const cachedEmail = settings.ok ? settings.data.user_feedback_email : null;
    if (email !== cachedEmail) updateSettings({ user_feedback_email: email });
  } else {
    const fallback = defaultFeedbackEmail(settings);
    if (!fallback) {
      return fail(
        "email_required",
        "No email to send with. Pass --email <address>, or sign in with `squirrel auth login` to use your account's."
      );
    }
    email = fallback;
  }

  return submit(
    {
      email,
      message: message.text,
      category,
      runId: ids.runId,
      websiteId: ids.websiteId,
    },
    message.truncated
  );
}

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
): Promise<FeedbackCategory | null> {
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

/** A person at a terminal: prompt for whatever the flags didn't give. */
async function sendInteractive(
  args: FeedbackArgs,
  settings: Settings
): Promise<Outcome> {
  const ids = readIds(args);
  if (!ids.ok) return ids;

  const cachedEmail = settings.ok ? settings.data.user_feedback_email : null;

  // An unknown --category (or --email) falls through to its prompt rather
  // than erroring; the server clamps categories anyway.
  let category: FeedbackCategory | null = null;
  let askCategory = true;
  if (args.category) {
    if (isFeedbackCategory(args.category)) {
      category = args.category;
      askCategory = false;
    } else {
      console.log(
        `Unknown category "${args.category}" (valid: ${FEEDBACK_CATEGORIES.join(", ")}).`
      );
    }
  }
  let email = "";
  if (args.email !== undefined) {
    const given = args.email.trim();
    if (emailSchema.safeParse(given).success) email = given;
    else console.log("Invalid email address.");
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let feedbackText: string;
  try {
    const emailPrompt = cachedEmail ? `Email [${cachedEmail}]: ` : "Email: ";
    while (!email) {
      const input = (await prompt(rl, emailPrompt)).trim() || cachedEmail || "";

      if (!input) {
        console.log("Email is required.");
        continue;
      }
      if (!emailSchema.safeParse(input).success) {
        console.log("Invalid email address.");
        continue;
      }
      email = input;
    }

    while (true) {
      feedbackText = (await prompt(rl, "Feedback: ")).trim();
      if (feedbackText.length >= FEEDBACK_MIN_LENGTH) break;
      console.log(
        `Feedback must be at least ${FEEDBACK_MIN_LENGTH} characters.`
      );
    }

    if (askCategory) {
      category = await promptCategory(rl);
    }
  } finally {
    rl.close();
  }
  console.log("");

  // Save email for next time
  if (email !== cachedEmail) {
    updateSettings({ user_feedback_email: email });
  }

  const message = clampFeedbackMessage(feedbackText);
  return submit(
    {
      email,
      message: message.text,
      category,
      runId: ids.runId,
      websiteId: ids.websiteId,
    },
    message.truncated
  );
}

async function collectAndSend(args: FeedbackArgs): Promise<Outcome> {
  const settings = loadUserSettings();
  warnIfSessionUnreadable(settings);

  if (args.message !== undefined) {
    return sendWithoutPrompts(args, String(args.message), settings);
  }
  if (!stdinIsTTY()) {
    return sendWithoutPrompts(
      args,
      await readStdinText(STDIN_MAX_BYTES),
      settings
    );
  }
  if (args.json) {
    return fail(
      "message_required",
      '--json never prompts. Pass the feedback with --message "...", or pipe it on stdin.'
    );
  }
  return sendInteractive(args, settings);
}

/** stderr without console.error: Bun tints console.error output red when colour is forced. */
function writeErr(text: string): void {
  process.stderr.write(`${text}\n`);
}

function printOutcome(outcome: Outcome, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        outcome.ok
          ? outcome
          : { ...outcome, fallback_url: FEEDBACK_FALLBACK_URL }
      )
    );
    return;
  }
  if (outcome.ok) {
    if (outcome.truncated) {
      const e = createTheme(process.stderr);
      writeErr(
        `${e.warn(e.sym.warn)} Feedback over ${FEEDBACK_MAX_LENGTH} characters was cut to fit.`
      );
    }
    const t = createTheme(process.stdout);
    console.log(`${t.ok(t.sym.ok)} Thank you for your feedback!`);
    return;
  }
  const e = createTheme(process.stderr);
  writeErr(
    `${e.error(e.sym.error)} ${outcome.error}\n  ${e.dim("Please try again at:")} ${FEEDBACK_FALLBACK_URL}`
  );
}

export const feedback = defineCommand({
  meta: {
    name: "feedback",
    description: "Send feedback to the squirrelscan team",
  },
  args: {
    message: {
      type: "string",
      alias: "m",
      valueHint: "text",
      description:
        "Feedback text; sends without prompting (or pipe it on stdin)",
    },
    category: {
      type: "string",
      valueHint: "name",
      description: `Feedback category (${FEEDBACK_CATEGORIES.join(", ")})`,
    },
    email: {
      type: "string",
      valueHint: "address",
      description:
        "Email the team can reply to (default: the last one you gave, then your signed-in account's)",
    },
    "run-id": {
      type: "string",
      valueHint: "id",
      description: "Audit run the feedback is about",
    },
    "website-id": {
      type: "string",
      valueHint: "id",
      description: "Website the feedback is about",
    },
    json: {
      type: "boolean",
      description: "Print the result as JSON (never prompts)",
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    let outcome: Outcome;
    try {
      outcome = await collectAndSend(args);
    } catch (error) {
      outcome = fail(
        "unexpected",
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    printOutcome(outcome, json);
    if (!outcome.ok) return safeExit(1);
  },
});
