// `squirrel keys revoke <prefix-or-id>` — resolve a key by id or prefix match
// against the org's key list, then DELETE /v1/organizations/:id/api-keys/:keyId
// (organizations.ts:921, soft-revoke, login-session only). Confirmation is the
// command layer's job (cli/commands/keys.ts) — this controller just resolves
// + revokes.

import { listApiKeys, type OrgApiKeySummary } from "@/controllers/keys/list";
import {
  type Result,
  ok,
  err,
  commandError,
  apiErrorMessage,
} from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import { resolveCredential } from "@/self/credentials";

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

/** Resolve a key by exact id, or a prefix that uniquely matches one ACTIVE key. */
export function resolveKeyMatch(
  keys: OrgApiKeySummary[],
  idOrPrefix: string
): Result<OrgApiKeySummary> {
  const active = keys.filter((k) => !k.revokedAt);

  const byId = active.find((k) => k.id === idOrPrefix);
  if (byId) return ok(byId);

  const matches = active.filter((k) => k.prefix.startsWith(idOrPrefix));
  if (matches.length === 1) return ok(matches[0]);
  if (matches.length === 0) {
    return err(
      commandError("KEY_NOT_FOUND", `No active key matches "${idOrPrefix}".`)
    );
  }
  return err(
    commandError(
      "AMBIGUOUS_PREFIX",
      `"${idOrPrefix}" matches ${matches.length} active keys. Use a longer prefix or the full id.`
    )
  );
}

/** Look up the key a prefix/id resolves to, WITHOUT revoking it — used by the
 * command layer to show what it's about to revoke before confirming. */
export async function findKeyToRevoke(
  idOrPrefix: string
): Promise<Result<{ orgId: string; key: OrgApiKeySummary }>> {
  const credential = resolveCredential();
  if (!credential || credential.source !== "login") {
    return err(
      commandError(
        "LOGIN_REQUIRED",
        "Revoking an API key requires a login session (not an API key). Run 'squirrel auth login' first."
      )
    );
  }

  const listResult = await listApiKeys();
  if (!listResult.ok) return listResult;
  const { orgId, keys } = listResult.data;

  const matchResult = resolveKeyMatch(keys, idOrPrefix);
  if (!matchResult.ok) return matchResult;

  return ok({ orgId, key: matchResult.data });
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
    `/v1/organizations/${orgId}/api-keys/${key.id}`,
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
