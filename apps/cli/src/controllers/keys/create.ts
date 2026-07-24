// `squirrel keys create` — mint an org API key for headless / CI use via the
// login-session-only POST /v1/organizations/:id/api-keys (organizations.ts:791).
// The API route rejects API-key auth on this endpoint on purpose (prevents a
// key minting a key), so this hard-requires an active login session.

import {
  API_KEY_SCOPE_PRESETS,
  isApiKeyScope,
  type ApiKeyScope,
} from "@squirrelscan/core-contracts/api-keys";
import { hostname } from "node:os";

import { resolveLoginOrg } from "@/controllers/keys/org";
import {
  type Result,
  ok,
  err,
  commandError,
  apiErrorMessage,
} from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import {
  API_TOKEN_ENV_VAR,
  activeEnvTokenVar,
  resolveCredential,
} from "@/self/credentials";

export interface CreateKeyOptions {
  name?: string;
  /** Raw scope strings (validated here — server validates too, defense in depth). */
  scopes?: string[];
  /** Days from now until expiry; omitted = never (matches the API default). */
  expiresDays?: number;
}

export interface CreatedKey {
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  token: string;
  prefix: string;
  keyEnv: string;
  expiresAt: string | null;
  orgId: string;
  orgName: string | null;
}

interface CreateApiKeyRawResponse {
  id?: string;
  name?: string;
  scopes?: ApiKeyScope[];
  token?: string;
  prefix?: string;
  keyEnv?: string;
  expiresAt?: string | null;
  // API errors use the typed envelope `{ error: { code, message } }`; older
  // deploys returned a bare `{ error: "..." }` string — accept both.
  error?: string | { code?: string; message?: string };
}

/** Default key name when `--name` is omitted: `cli-<hostname>-<yyyymmdd>`. */
export function defaultKeyName(now = new Date()): string {
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `cli-${hostname()}-${yyyymmdd}`;
}

/**
 * Validate raw `--scopes` CSV entries against the known grantable scope set.
 * Returns the valid, deduped scopes, or an error naming the first bad one
 * (reserved scopes are rejected here too — the API rejects them, but a
 * client-side check gives a clearer message without a round-trip).
 */
export function parseScopes(raw: string[]): Result<ApiKeyScope[]> {
  const scopes: ApiKeyScope[] = [];
  for (const s of raw) {
    const trimmed = s.trim();
    if (!isApiKeyScope(trimmed)) {
      return err(
        commandError(
          "INVALID_SCOPE",
          `Unknown or reserved scope "${trimmed}". Valid scopes: ${API_KEY_SCOPE_PRESETS.full.join(", ")}`
        )
      );
    }
    scopes.push(trimmed);
  }
  return ok(Array.from(new Set(scopes)));
}

/** The ready-to-copy line printed once after a key is created. */
export function exportLine(token: string): string {
  return `export ${API_TOKEN_ENV_VAR}='${token}'`;
}

export async function createApiKey(
  options: CreateKeyOptions = {}
): Promise<Result<CreatedKey>> {
  const credential = resolveCredential();
  if (credential?.source === "env") {
    // "Run auth login" alone won't help here: the env key shadows any login.
    return err(
      commandError(
        "LOGIN_REQUIRED",
        `Minting an API key requires a login session, but ${activeEnvTokenVar() ?? API_TOKEN_ENV_VAR} is set and API keys cannot mint keys. Unset it, then run 'squirrel auth login'.`
      )
    );
  }
  if (!credential || credential.source !== "login") {
    return err(
      commandError(
        "LOGIN_REQUIRED",
        "Minting an API key requires a login session (not an API key). Run 'squirrel auth login' first."
      )
    );
  }

  const orgResult = await resolveLoginOrg();
  if (!orgResult.ok) return orgResult;
  const org = orgResult.data;

  const scopesResult = options.scopes?.length
    ? parseScopes(options.scopes)
    : ok([...API_KEY_SCOPE_PRESETS.full]);
  if (!scopesResult.ok) return scopesResult;

  const name = options.name?.trim() || defaultKeyName();
  const expiresAt =
    options.expiresDays !== undefined
      ? new Date(Date.now() + options.expiresDays * 86_400_000).toISOString()
      : null;

  const {
    ok: reqOk,
    status,
    data,
  } = await cliApi.request<CreateApiKeyRawResponse>(
    `/v1/organizations/${org.id}/api-keys`,
    {
      method: "POST",
      auth: "required",
      body: { name, scopes: scopesResult.data, expiresAt },
    }
  );

  if (!reqOk || !data?.token) {
    if (status === 403) {
      return err(
        commandError(
          "FORBIDDEN",
          "Only organization owners and admins can create API keys."
        )
      );
    }
    return err(
      commandError(
        "API_ERROR",
        apiErrorMessage(data?.error) ??
          `Could not create key (status ${status}).`
      )
    );
  }

  return ok({
    id: data.id ?? "",
    name: data.name ?? name,
    scopes: data.scopes ?? scopesResult.data,
    token: data.token,
    prefix: data.prefix ?? "",
    keyEnv: data.keyEnv ?? "",
    expiresAt: data.expiresAt ?? null,
    orgId: org.id,
    orgName: org.name ?? null,
  });
}
