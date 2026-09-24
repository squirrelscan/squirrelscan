// send_feedback on the local server (#370): the channel hosted MCP clients
// already have, sent through the same path as `squirrel feedback`. No login,
// no credits; it needs the network and an email the team can reply to.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { FEEDBACK_CATEGORIES } from "@squirrelscan/utils/constants";
import { z } from "zod";

import {
  FEEDBACK_FALLBACK_URL,
  FEEDBACK_ID_MAX_LENGTH,
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_MIN_LENGTH,
  clampFeedbackMessage,
  defaultFeedbackEmail,
  submitFeedback,
} from "@/lib/feedback";
import { loadUserSettings } from "@/self/settings";

import { errorResult, jsonResult } from "../result";

export function registerFeedbackTools(server: McpServer): void {
  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback",
      description:
        "Report your experience using squirrelscan: a bug, a missing feature, what worked, what confused you, missing report data, or tool ergonomics. Reviewed by the team; use it any time something surprises you, not just at the end of a session. No login required. The team needs an email to reply to: pass `email`, or it uses the one `squirrel feedback` last saved, then the signed-in account's.",
      inputSchema: {
        category: z
          .enum(FEEDBACK_CATEGORIES)
          .describe(
            "bug_report (a defect in squirrelscan itself: wrong or missing rule result, crash, broken tool), feature_request (something squirrelscan should do but doesn't), what_worked, confusing (unclear response or behavior), missing_data (a report or tool response lacked something you needed), tool_ergonomics (awkward tool shape, args or naming), or other."
          ),
        message: z
          .string()
          .describe(
            `Free-text feedback, at least ${FEEDBACK_MIN_LENGTH} characters (cut at ${FEEDBACK_MAX_LENGTH}).`
          ),
        email: z
          .string()
          .email()
          .optional()
          .describe(
            "Email the team can reply to. Defaults to the one `squirrel feedback` last saved, then the signed-in account's."
          ),
        run_id: z
          .string()
          .trim()
          .min(1)
          .max(FEEDBACK_ID_MAX_LENGTH)
          .optional()
          .describe("Audit run id this feedback relates to, if any."),
        website_id: z
          .string()
          .trim()
          .min(1)
          .max(FEEDBACK_ID_MAX_LENGTH)
          .optional()
          .describe("Website id this feedback relates to, if any."),
      },
    },
    async ({ category, message, email, run_id, website_id }) => {
      const text = clampFeedbackMessage(message);
      if (text.text.length < FEEDBACK_MIN_LENGTH) {
        return errorResult(
          `Feedback must be at least ${FEEDBACK_MIN_LENGTH} characters.`
        );
      }
      const replyTo = email ?? defaultFeedbackEmail(loadUserSettings());
      if (!replyTo) {
        return errorResult(
          "No email to send with. Pass `email`, or sign in on this machine with `squirrel auth login` to use the account's."
        );
      }

      const result = await submitFeedback({
        email: replyTo,
        message: text.text,
        category,
        runId: run_id,
        websiteId: website_id,
        via: "mcp",
      });
      if (!result.ok) {
        const reason = result.rateLimited
          ? "too many submissions, try again in a few minutes"
          : result.status === 0
            ? "couldn't reach the squirrelscan API"
            : `HTTP ${result.status}`;
        return errorResult(
          `Failed to submit feedback (${reason}). It can also be sent at ${FEEDBACK_FALLBACK_URL}.`
        );
      }
      return jsonResult({
        received: true,
        category,
        truncated: text.truncated,
        message: "Thanks, this was recorded for the team.",
      });
    }
  );
}
