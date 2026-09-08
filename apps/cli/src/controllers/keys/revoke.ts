// `squirrel keys revoke <prefix-or-id>` — resolve a key by id or prefix match
// against the user's key list, then DELETE /v1/organizations/:id/api-keys/:keyId
// (organizations.ts, soft-revoke, login-session only). Confirmation is the
// command layer's job (cli/commands/keys.ts) — this controller just resolves
// + revokes.
//
// Resolution spans EVERY org the user belongs to (#1971), because a prefix is
// all the user has and they should not have to know which org a key lives in to
// revoke it. The org travels with the match so the DELETE always goes to the
// org that actually owns the key. A prefix matching keys in two orgs is
// ambiguous and refused, naming both.

import type { CliOrg } from "@/controllers/orgs/resolve";

import {
  listApiKeys,
  type OrgApiKeySummary,
  type OrgKeys,
} from "@/controllers/keys/list";
import {
  type Result,
  ok,
  err,
  commandError,
  apiErrorMessage,
} from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import { resolveCredential } from "@/self/credentials";

/** One key together with the org that owns it. */
export interface OrgKeyRef {
  org: CliOrg;
  key: OrgApiKeySummary;
}

export interface RevokedKey {
  id: string;
  name: string | null;
  prefix: string;
  revokedAt: string;
}

interface RevokeApiKeyRawResponse {
  id?: string;
  revokedAt?: string;
  // Typed envelope `{ error: { code, message } }`; older deploys used a bare string.
  error?: string | { code?: string; message?: string };
}

/** Flatten a per-org listing into the (org, key) pairs resolution runs over. */
export function flattenOrgKeys(orgs: OrgKeys[]): OrgKeyRef[] {
  return orgs.flatMap((entry) =>
    entry.keys.map((key) => ({ org: entry.org, key }))
  );
}

/** `nikz` — how an org is named inside a revoke error message. */
function orgLabel(org: CliOrg): string {
  return org.slug || org.id;
}

/** Resolve a key by exact id, or a prefix that uniquely matches one ACTIVE key. */
export function resolveKeyMatch(
  refs: OrgKeyRef[],
  idOrPrefix: string
): Result<OrgKeyRef> {
  const active = refs.filter((ref) => !ref.key.revokedAt);

  const byId = active.find((ref) => ref.key.id === idOrPrefix);
  if (byId) return ok(byId);

  const matches = active.filter((ref) => ref.key.prefix.startsWith(idOrPrefix));
  if (matches.length === 1) return ok(matches[0]);
  if (matches.length === 0) {
    return err(
      commandError("KEY_NOT_FOUND", `No active key matches "${idOrPrefix}".`)
    );
  }

  const orgs = Array.from(new Set(matches.map((ref) => orgLabel(ref.org))));
  const where =
    orgs.length > 1 ? ` across organizations ${orgs.join(", ")}` : "";
  return err(
    commandError(
      "AMBIGUOUS_PREFIX",
      `"${idOrPrefix}" matches ${matches.length} active keys${where}. Use a longer prefix or the full id${orgs.length > 1 ? ", and --org to narrow the search" : ""}.`
    )
  );
}

export interface FindKeyOptions {
  /** Org slug or id to search. Omitted = every org the user is a member of. */
  org?: string;
}

/** Look up the key a prefix/id resolves to, WITHOUT revoking it — used by the
 * command layer to show what it's about to revoke before confirming. */
export async function findKeyToRevoke(
  idOrPrefix: string,
  options: FindKeyOptions = {}
): Promise<Result<OrgKeyRef>> {
  const credential = resolveCredential();
  if (!credential || credential.source !== "login") {
    return err(
      commandError(
        "LOGIN_REQUIRED",
        "Revoking an API key requires a login session (not an API key). Run 'squirrel auth login' first."
      )
    );
  }

  const listResult = await listApiKeys(
    options.org !== undefined ? { org: options.org } : {}
  );
  if (!listResult.ok) return listResult;
  const { orgs } = listResult.data;

  const matchResult = resolveKeyMatch(flattenOrgKeys(orgs), idOrPrefix);
  if (matchResult.ok) return matchResult;

  // A key hiding in an org whose listing 403'd would otherwise read as "no such
  // key" — say so instead of sending the user hunting for a key that is there.
  const unreadable = orgs.filter((entry) => entry.error);
  if (matchResult.error.code === "KEY_NOT_FOUND" && unreadable.length > 0) {
    return err(
      commandError(
        matchResult.error.code,
        `${matchResult.error.message} Note: keys could not be read for ${unreadable
          .map((entry) => orgLabel(entry.org))
          .join(", ")}.`
      )
    );
  }
  return matchResult;
}

export async function revokeApiKey(
  orgId: string,
  key: OrgApiKeySummary
): Promise<Result<RevokedKey>> {
  const {
    ok: reqOk,
    status,
    data,
  } = await cliApi.request<RevokeApiKeyRawResponse>(
    `/v1/organizations/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(key.id)}`,
    { method: "DELETE", auth: "required" }
  );

  if (!reqOk || !data?.revokedAt) {
    return err(
      commandError(
        "API_ERROR",
        apiErrorMessage(data?.error) ??
          `Could not revoke key (status ${status}).`
      )
    );
  }

  return ok({
    id: data.id ?? key.id,
    name: key.name,
    prefix: key.prefix,
    revokedAt: data.revokedAt,
  });
}
