// Auth status controller — resolves the active credential (SQUIRRELSCAN_API_KEY
// env, or its SQUIRREL_API_TOKEN alias → settings.json login), verifies it
// with the API, and reports the auth SOURCE + scopes. Env tokens are
// authoritative / fail-closed: an invalid env token errors here rather than
// silently reporting a cached login session.

import {
  type ApiKeyScope,
  isApiKey,
} from "@squirrelscan/core-contracts/api-keys";

import { STATUS_REQUEST_TIMEOUT_MS } from "@/constants";
import { fetchActiveOrgContext } from "@/controllers/orgs/resolve";
import { type Result, ok, err, commandError } from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import {
  API_TOKEN_ENV_VAR,
  activeEnvTokenVar,
  apiKeyNotVerifiableMessage,
  type CredentialSource,
  describeEnvToken,
  envTokenRejectedMessage,
  resolveCredential,
} from "@/self/credentials";
import { loadUserSettings } from "@/self/settings";

interface StatusResult {
  /** Where the active credential came from. */
  source: CredentialSource;
  /** Set when source === "env" and a logged-in session is being shadowed. */
  shadowedLoginEmail?: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  token: {
    deviceName: string | null;
    expiresAt: string | null;
    createdAt?: string;
  };
  /** Present when the credential is an org API key (scoped). */
  apiKey?: {
    name: string | null;
    scopes: ApiKeyScope[];
    keyEnv: string | null;
  };
  /**
   * The org this credential acts for: the key's org binding for an API key, and
   * for a login session the server's `users.activeOrgId` — the org an audit's
   * credits are actually spent from (#1971). Absent when it could not be
   * resolved (offline, or an API without the field).
   */
  org?: {
    id: string;
    slug: string | null;
    name: string | null;
  };
  /** How many orgs the account belongs to, when known. >1 means `keys create`
   *  and any org-scoped command needs `--org`. */
  orgCount?: number;
}

interface WhoamiResponse {
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
  };
  token?: {
    id?: string;
    deviceName?: string | null;
    expiresAt?: string | null;
    createdAt?: string;
    lastUsedAt?: string | null;
  };
  // Present once the API resolves API keys (#156). Tolerated-absent so this
  // CLI ships ahead of the server change and lights up when the API lands.
  authSource?: "login" | "api-key";
  apiKey?: {
    name?: string | null;
    scopes?: string[];
    keyEnv?: string | null;
  };
  org?: {
    id: string;
    name?: string | null;
  };
}

/**
 * Get current authentication status. Fail-closed for env credentials: a 401 on
 * an env-supplied token is a hard error (no fall-back to a cached login).
 */
export async function runAuthStatus(): Promise<Result<StatusResult>> {
  const credential = resolveCredential();

  if (!credential) {
    return err(
      commandError("NOT_AUTHENTICATED", "Not currently authenticated")
    );
  }

  // The logged-in session being shadowed by an env token (for the warning).
  const shadowedLoginEmail =
    credential.source === "env" ? loadLoginEmail() : undefined;

  try {
    // Timeout is load-bearing: a wedged server (e.g. a stuck local dev API)
    // accepts the connection but never responds — cliApi.fetch applies the
    // signal so this never hangs the command, and still throws on transport
    // failure (the catch below renders the offline view).
    const res = await cliApi.fetch(
      "/v1/auth/whoami",
      { headers: cliApi.headers(credential.token) },
      { timeoutMs: STATUS_REQUEST_TIMEOUT_MS }
    );

    if (!res.ok) {
      if (res.status === 401) {
        // An org API key is ALWAYS 401 here: /v1/auth/whoami is the CLI-session
        // endpoint and only accepts a `sqcli_…` login token. Saying "invalid,
        // revoked, expired, or wrong environment" about a key that works for
        // every other cloud call sends the user hunting for a problem that
        // isn't there, so name the real reason first.
        if (isApiKey(credential.token)) {
          return err(
            commandError(
              "API_KEY_NOT_VERIFIABLE",
              apiKeyNotVerifiableMessage(
                credential.source === "env" ? activeEnvTokenVar() : null
              )
            )
          );
        }
        // FAIL-CLOSED: an env token rejected by the server is a hard error; we
        // never fall back to (or silently report) the local login session.
        if (credential.source === "env") {
          return err(
            commandError(
              "TOKEN_INVALID",
              envTokenRejectedMessage().replace(/^Error: /, "")
            )
          );
        }
        return err(
          commandError(
            "TOKEN_INVALID",
            "Authentication token is invalid or revoked"
          )
        );
      }
      return err(commandError("API_ERROR", `API error: ${res.status}`));
    }

    const data = (await res.json()) as WhoamiResponse;
    const scopes = (data.apiKey?.scopes ?? []) as ApiKeyScope[];
    const isApiKeyAuth =
      data.authSource === "api-key" || data.apiKey !== undefined;

    const orgFields = await resolveOrgFields(credential.token, data.org);

    return ok({
      source: credential.source,
      ...(shadowedLoginEmail ? { shadowedLoginEmail } : {}),
      user: {
        id: data.user.id,
        email: data.user.email ?? "",
        name: data.user.name ?? null,
      },
      token: {
        deviceName: data.token?.deviceName ?? null,
        expiresAt: data.token?.expiresAt ?? credential.expiresAt ?? null,
        ...(data.token?.createdAt ? { createdAt: data.token.createdAt } : {}),
      },
      ...(isApiKeyAuth
        ? {
            apiKey: {
              name: data.apiKey?.name ?? null,
              scopes,
              keyEnv: data.apiKey?.keyEnv ?? null,
            },
          }
        : {}),
      ...orgFields,
    });
  } catch {
    // Network/timeout failure. For an env token we cannot confirm validity and
    // there is no cached identity — report a best-effort offline view labeled by
    // source. (We do NOT hard-error on transport failure: only a definitive 401
    // is fail-closed; an unreachable API is a transient outage.)
    if (credential.source === "env") {
      return ok({
        source: "env",
        ...(shadowedLoginEmail ? { shadowedLoginEmail } : {}),
        user: {
          id: "",
          email: `${activeEnvTokenVar() ?? API_TOKEN_ENV_VAR} (${describeEnvToken(credential.token)})`,
          name: null,
        },
        token: { deviceName: null, expiresAt: null },
      });
    }
    // Logged-in session: fall back to cached info.
    return ok({
      source: "login",
      user: loadCachedLoginUser(),
      token: {
        deviceName: null,
        expiresAt: credential.expiresAt ?? null,
      },
    });
  }
}

/**
 * The org lines for `auth status`.
 *
 * `/v1/auth/whoami` does not resolve an org for a LOGIN session (it runs under
 * `cliTokenAuth` alone, with no orgContext), so the CLI has to ask separately —
 * and it MUST be the server's active org, not "the first org you belong to":
 * those two disagree for a multi-org account, which is how a key got minted
 * against one org while audits spent another's credits (#1971).
 *
 * Best-effort: an unreachable API drops the org lines, never the command.
 */
async function resolveOrgFields(
  token: string,
  whoamiOrg: WhoamiResponse["org"]
): Promise<Pick<StatusResult, "org" | "orgCount">> {
  // Keyed on the TOKEN TYPE, not on where the token was stored. A `sqcli_`
  // login token supplied through the env var authenticates here exactly like
  // one loaded from settings.json, and the org routes accept it just the same —
  // gating on `source === "login"` would drop the org lines for it.
  if (!isApiKey(token)) {
    const context = await fetchActiveOrgContext(STATUS_REQUEST_TIMEOUT_MS);
    if (context) {
      return {
        ...(context.active
          ? {
              org: {
                id: context.active.id,
                slug: context.active.slug || null,
                name: context.active.name,
              },
            }
          : // Active org id with no matching membership row: still name the id
            // rather than print nothing, since that id is what gets charged.
            context.activeOrgId
            ? { org: { id: context.activeOrgId, slug: null, name: null } }
            : {}),
        ...(context.orgs.length ? { orgCount: context.orgs.length } : {}),
      };
    }
  }

  // API-key credentials carry their org binding on the whoami response itself.
  return whoamiOrg
    ? { org: { id: whoamiOrg.id, slug: null, name: whoamiOrg.name ?? null } }
    : {};
}

/** Email of the logged-in session (for shadow warnings). */
function loadLoginEmail(): string | undefined {
  const settings = loadUserSettings();
  return settings.ok ? (settings.data.auth?.email ?? undefined) : undefined;
}

/** Cached login identity for the offline fall-back. */
function loadCachedLoginUser(): StatusResult["user"] {
  const settings = loadUserSettings();
  const auth = settings.ok ? settings.data.auth : null;
  return {
    id: auth?.userId ?? "",
    email: auth?.email ?? "",
    name: auth?.name ?? null,
  };
}
