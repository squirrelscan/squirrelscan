// `squirrel keys list` — org API keys via GET /v1/organizations/:id/api-keys
// (login-session only, same guard as create/revoke).

import type { ApiKeyScope } from "@squirrelscan/core-contracts/api-keys";

import { resolveLoginOrg } from "@/controllers/keys/org";
import {
  type Result,
  ok,
  err,
  commandError,
  apiErrorMessage,
} from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import { resolveCredential } from "@/self/credentials";

export interface OrgApiKeySummary {
  id: string;
  name: string | null;
  prefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ListKeysResult {
  orgId: string;
  keys: OrgApiKeySummary[];
}

interface ListApiKeysRawResponse {
  apiKeys?: OrgApiKeySummary[];
  // Typed envelope `{ error: { code, message } }`; older deploys used a bare string.
  error?: string | { code?: string; message?: string };
}

export async function listApiKeys(): Promise<Result<ListKeysResult>> {
  const credential = resolveCredential();
  if (!credential || credential.source !== "login") {
    return err(
      commandError(
        "LOGIN_REQUIRED",
        "Listing API keys requires a login session (not an API key). Run 'squirrel auth login' first."
      )
    );
  }

  const orgResult = await resolveLoginOrg();
  if (!orgResult.ok) return orgResult;
  const org = orgResult.data;

  const {
    ok: reqOk,
    status,
    data,
  } = await cliApi.request<ListApiKeysRawResponse>(
    `/v1/organizations/${org.id}/api-keys`,
    { method: "GET", auth: "required" }
  );

  if (!reqOk || !data) {
    return err(
      commandError(
        "API_ERROR",
        apiErrorMessage(data?.error) ??
          `Could not list keys (status ${status}).`
      )
    );
  }

  return ok({ orgId: org.id, keys: data.apiKeys ?? [] });
}
