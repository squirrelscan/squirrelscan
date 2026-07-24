// Auth + cloud helpers for MCP tools: probe availability, gate authed tools.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ApiResult } from "@/lib/api-client";
import type { ResolvedCredential } from "@/self/credentials";

import { STATUS_REQUEST_TIMEOUT_MS } from "@/constants";
import {
  API_TOKEN_ENV_VAR,
  LEGACY_API_TOKEN_ENV_VAR,
  resolveCredential,
} from "@/self/credentials";
import { createCloudClientFromSettings } from "@/tools/cloud";
import { logger } from "@/utils/logger";

import { errorResult, jsonResult } from "./result";
import { API_KEYS_NOT_YET_SUPPORTED } from "./scopes";

// Injectable credential check so authed tools stay deterministically testable.
export type LoginResolver = () => ResolvedCredential | null;

// Cache only a confirmed-available result for the server's lifetime; logged-out is network-free already, and a transient probe failure re-probes next call.
let cloudConfirmed = false;

// True when a credential resolves AND a balance probe succeeds — mirrors the CLI `signedIn` gate.
export async function resolveCloudAvailability(): Promise<boolean> {
  if (cloudConfirmed) return true;
  const client = createCloudClientFromSettings({
    timeoutMs: STATUS_REQUEST_TIMEOUT_MS,
    maxAttempts: 2,
  });
  if (!client) return false;
  try {
    await client.getBalance();
    cloudConfirmed = true;
    return true;
  } catch (error) {
    logger.debug("mcp: cloud unavailable, running local-only", error);
    return false;
  }
}

// Logged-out guard for authed tools — returns a clean MCP error naming both
// fixes (headless env token or interactive login), or null when authed.
export function requireLoginError(
  resolve: LoginResolver = resolveCredential
): CallToolResult | null {
  if (resolve()) return null;
  return errorResult(
    `Not authenticated. Set ${API_TOKEN_ENV_VAR} (or its ${LEGACY_API_TOKEN_ENV_VAR} alias) to an API key for headless/CI use, or run \`squirrel auth login\` for an interactive session.`
  );
}

// Map an ApiResult to a tool result: 2xx → JSON, otherwise a clean (non-throwing) error.
export function apiResultToTool(
  result: ApiResult<unknown>,
  notFoundHint?: string
): CallToolResult {
  if (result.ok) return jsonResult(result.data);
  switch (result.status) {
    case 0:
      return errorResult(
        "Could not reach the squirrelscan API. Check your connection and try again."
      );
    case 401:
      return errorResult(
        "Authentication failed (session expired or token rejected). Run `squirrel auth login`."
      );
    case 403: {
      // Surface the server's reason (missing scope / session requirement); strip trailing dots+space so an all-dots reason falls back, not "Forbidden — .".
      const reason =
        extractApiError(result)?.trim().replace(/\.+$/, "") || null;
      return errorResult(
        reason
          ? `Forbidden — ${reason}${/[!?]$/.test(reason) ? "" : "."}`
          : `Forbidden — your credential lacks access for this tool (${API_KEYS_NOT_YET_SUPPORTED} here; use a logged-in session).`
      );
    }
    case 404:
      return errorResult(notFoundHint ?? "Not found.");
    default:
      return errorResult(
        extractApiError(result) ?? `Request failed (HTTP ${result.status}).`
      );
  }
}

// Pull a server error string: object `error`/`message`, or a JSON string body (response.json() yields a string). Capped so a verbose body can't flood the agent context.
function extractApiError(result: ApiResult<unknown>): string | null {
  const cap = (s: string): string | null =>
    s.length > 0 ? s.slice(0, 300) : null;
  const data = result.data;
  if (typeof data === "string") return cap(data);
  if (data && typeof data === "object") {
    for (const key of ["error", "message"] as const) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return cap(value);
    }
  }
  return null;
}
