/**
 * Best-effort sync of an authed audit's detected stack to the dashboard
 * (per-website + global per-domain views). Bounded via `cliApi.send`: awaited so
 * the write lands when the API is reachable, capped at a short timeout so a
 * slow/unreachable API can't noticeably hang the audit, and it NEVER throws.
 * Mirrors the worker-agent / report-publish server-side sync.
 */
import type { ReportTechnology } from "@squirrelscan/core-contracts";

import { cliApi } from "@/lib/api-client";

// Short bound: keep the post-audit sync from hanging on a slow/unreachable API.
const SYNC_TIMEOUT_MS = 3_000;

export interface SyncTechnologiesInput {
  websiteId: string;
  auditId: string;
  technologies: ReportTechnology[];
}

/**
 * POST the detected technologies to the per-website sync endpoint. The server
 * derives the global per-domain key from the owned website, so no domain is
 * sent. Never throws (cliApi.send swallows non-2xx + transport failures); a lost
 * sync just leaves the dashboard a beat behind until the next audit.
 */
export async function syncTechnologies(
  input: SyncTechnologiesInput
): Promise<void> {
  await cliApi.send(`/v1/technologies/${encodeURIComponent(input.websiteId)}`, {
    method: "POST",
    auth: "required",
    timeoutMs: SYNC_TIMEOUT_MS,
    body: {
      auditId: input.auditId,
      technologies: input.technologies,
    },
  });
}
