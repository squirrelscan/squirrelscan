// Feedback to the squirrelscan team: the one submit path shared by
// `squirrel feedback` and the local MCP server's send_feedback tool, so both
// send the same payload to the same endpoint (#370).

import {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
} from "@squirrelscan/utils/constants";

import type { Result } from "@/controllers/types";
import type { UserSettings } from "@/self/types";

import { cliApi } from "@/lib/api-client";
import { getInstallId } from "@/self/install-id";

import { version } from "../../package.json";

export const FEEDBACK_FALLBACK_URL = "https://squirrelscan.com/feedback";

/** The API rejects shorter feedback. */
export const FEEDBACK_MIN_LENGTH = 5;

/** The website form's cap. Longer text is cut to it, never rejected. */
export const FEEDBACK_MAX_LENGTH = 5000;

/** Real run and website ids are short; this only keeps junk out of the metadata. */
export const FEEDBACK_ID_MAX_LENGTH = 128;

export function isFeedbackCategory(value: string): value is FeedbackCategory {
  return (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/** Trim, then cut to FEEDBACK_MAX_LENGTH without splitting a surrogate pair. */
export function clampFeedbackMessage(raw: string): {
  text: string;
  truncated: boolean;
} {
  const text = raw.trim();
  if (text.length <= FEEDBACK_MAX_LENGTH) return { text, truncated: false };
  let cut = text.slice(0, FEEDBACK_MAX_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}

/**
 * The email a submission uses when none is given: the one `squirrel feedback`
 * last saved, then the signed-in account's.
 */
export function defaultFeedbackEmail(
  settings: Result<UserSettings>
): string | null {
  if (!settings.ok) return null;
  return settings.data.user_feedback_email || settings.data.auth?.email || null;
}

export interface FeedbackSubmission {
  email: string;
  message: string;
  category?: FeedbackCategory | null;
  runId?: string;
  websiteId?: string;
  /**
   * The CLI surface that sent it, when not the command itself. Metadata only:
   * the API records every CLI submission with source "cli".
   */
  via?: "mcp";
}

export type SubmitFeedbackResult =
  | { ok: true }
  | { ok: false; status: number; rateLimited: boolean };

/**
 * POST the feedback, unauthenticated. The API has no run or website columns
 * for this route (it can't check ownership without auth), so the ids travel
 * in metadata.
 */
export async function submitFeedback(
  submission: FeedbackSubmission
): Promise<SubmitFeedbackResult> {
  const metadata: Record<string, unknown> = {
    platform: process.platform,
    arch: process.arch,
  };
  if (submission.runId) metadata.run_id = submission.runId;
  if (submission.websiteId) metadata.website_id = submission.websiteId;
  if (submission.via) metadata.via = submission.via;

  const payload: Record<string, unknown> = {
    email: submission.email,
    feedback: submission.message,
    source: "cli",
    client_version: version,
    metadata,
  };
  const installId = getInstallId();
  if (installId) payload.install_id = installId;
  if (submission.category) payload.category = submission.category;

  const { ok, status } = await cliApi.request("/v1/feedback", {
    method: "POST",
    auth: "none",
    body: payload,
  });
  return ok ? { ok: true } : { ok: false, status, rateLimited: status === 429 };
}
