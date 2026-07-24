// Org resolution for `squirrel keys` — every key management endpoint is
// org-scoped and login-session-only (the API `rejectApiKey`s these routes to
// prevent a key minting a key). MAX_ORGS_PER_USER=1 server-side, so the first
// (and only) org IS the org — no picker needed — but this codes defensively
// for the empty-array case (mid-onboarding, no org yet).

import type { Organization } from "@squirrelscan/core-contracts";

import { type Result, ok, err, commandError } from "@/controllers/types";
import { cliApi } from "@/lib/api-client";

export interface OrgWithRole extends Organization {
  role: string;
}

interface OrganizationsResponse {
  organizations?: OrgWithRole[];
  error?: string;
}

/**
 * Fetch the caller's org for org-scoped key management. Requires a login
 * session — call sites must verify `resolveCredential()?.source === "login"`
 * before calling this (the API rejects API-key auth on this route with 401,
 * which would otherwise read as "no organization").
 */
export async function resolveLoginOrg(): Promise<Result<OrgWithRole>> {
  const {
    ok: reqOk,
    status,
    data,
  } = await cliApi.request<OrganizationsResponse>("/v1/organizations", {
    method: "GET",
    auth: "required",
  });

  if (!reqOk || !data) {
    if (status === 401) {
      return err(
        commandError(
          "NOT_AUTHENTICATED",
          "Your login session is invalid or expired. Run 'squirrel auth login' to re-authenticate."
        )
      );
    }
    return err(
      commandError(
        "API_ERROR",
        data?.error ?? `Could not list organizations (status ${status}).`
      )
    );
  }

  const [org] = data.organizations ?? [];
  if (!org) {
    return err(
      commandError(
        "NO_ORGANIZATION",
        "Your account has no organization yet. Finish onboarding at the dashboard, then retry."
      )
    );
  }

  return ok(org);
}
