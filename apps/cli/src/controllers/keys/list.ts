// `squirrel keys list` — org API keys via GET /v1/organizations/:id/api-keys
// (login-session only, same guard as create/revoke).
//
// Keys are org-scoped, and an account can hold several orgs (#1971), so this
// lists EVERY org the user belongs to and labels each group — "which org is
// this key on" is the question a multi-org user is actually asking. `--org`
// narrows it to one.
//
// Per-org failures are reported per org, not thrown: the list route is
// owner/admin-only, so an account that is merely a `member` of a second org
// gets a 403 for that org and must still see the keys it CAN read.

import type { ApiKeyScope } from "@squirrelscan/core-contracts/api-keys";

import { type CliOrg, listOrgs, matchOrg } from "@/controllers/orgs/resolve";
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

/** One org's keys, or the reason they could not be read. */
export interface OrgKeys {
  org: CliOrg;
  keys: OrgApiKeySummary[];
  /** Set when this org's listing failed; `keys` is then empty. */
  error?: string;
}

export interface ListKeysResult {
  orgs: OrgKeys[];
}

export interface ListKeysOptions {
  /** Org slug or id. Omitted = every org the user is a member of. */
  org?: string;
}

interface ListApiKeysRawResponse {
  apiKeys?: OrgApiKeySummary[];
  // Typed envelope `{ error: { code, message } }`; older deploys used a bare string.
  error?: string | { code?: string; message?: string };
}

/** One org's keys. Never throws: a failure comes back as `error`. */
async function listOrgKeys(org: CliOrg): Promise<OrgKeys> {
  const {
    ok: reqOk,
    status,
    data,
  } = await cliApi.request<ListApiKeysRawResponse>(
    `/v1/organizations/${encodeURIComponent(org.id)}/api-keys`,
    { method: "GET", auth: "required" }
  );

  if (!reqOk || !data) {
    const fallback =
      status === 403
        ? "Only organization owners and admins can list API keys."
        : `Could not list keys (status ${status}).`;
    return { org, keys: [], error: apiErrorMessage(data?.error) ?? fallback };
  }

  return { org, keys: data.apiKeys ?? [] };
}

export async function listApiKeys(
  options: ListKeysOptions = {}
): Promise<Result<ListKeysResult>> {
  const credential = resolveCredential();
  if (!credential || credential.source !== "login") {
    return err(
      commandError(
        "LOGIN_REQUIRED",
        "Listing API keys requires a login session (not an API key). Run 'squirrel auth login' first."
      )
    );
  }

  const listed = await listOrgs();
  if (!listed.ok) return listed;

  let targets = listed.data;
  if (options.org !== undefined) {
    const matched = matchOrg(targets, options.org);
    if (!matched.ok) return matched;
    targets = [matched.data];
  }

  const orgs = await Promise.all(targets.map(listOrgKeys));

  // Every org failed — there is nothing to show, so this is a command failure
  // rather than a listing with holes. (Covers the single-org case exactly.)
  const firstError = orgs.find((entry) => entry.error)?.error;
  if (firstError && orgs.every((entry) => entry.error)) {
    return err(commandError("API_ERROR", firstError));
  }

  return ok({ orgs });
}
