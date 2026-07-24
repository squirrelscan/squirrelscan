// Auth status controller — resolves the active credential (SQUIRRELSCAN_API_KEY
// env, or its SQUIRREL_API_TOKEN alias → settings.json login), verifies it
// with the API, and reports the auth SOURCE + scopes. Env tokens are
// authoritative / fail-closed: an invalid env token errors here rather than
// silently reporting a cached login session.

import type { ApiKeyScope } from "@squirrelscan/core-contracts/api-keys";

import { STATUS_REQUEST_TIMEOUT_MS } from "@/constants";
import { type Result, ok, err, commandError } from "@/controllers/types";
import { cliApi } from "@/lib/api-client";
import {
  API_TOKEN_ENV_VAR,
  activeEnvTokenVar,
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
  /** Org binding, when the whoami response carries it (API keys). */
  org?: {
    id: string;
    name: string | null;
  };
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
      ...(data.org
        ? { org: { id: data.org.id, name: data.org.name ?? null } }
        : {}),
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
