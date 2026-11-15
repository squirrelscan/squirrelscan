// Auth requirements for the cloud MCP tools (#160) — single source of truth.
// Reflected in each tool's description (so `tools/list` advertises what a
// credential needs) and used to keep scope-aware errors honest. Local tools
// (audit_website, quick_check, list_rules, get_rule) are free + unauthenticated
// and intentionally absent here.

import type { ApiKeyScope } from "@squirrelscan/core-contracts/api-keys";

// Support scopes are not grantable on a key yet (a private follow-up adds them to API_KEY_SCOPES); named here for intent only.
export type ToolScope = ApiKeyScope | "support:read" | "support:write";

export interface ToolAuth {
  // Scope the underlying API route enforces (semantic intent + #113 forward-compat).
  scope: ToolScope;
  // Whether an org API key may call it today. Several cloud routes are
  // session-only (rejectApiKey) until the hosted MCP (#113) lifts that.
  apiKey: boolean;
}

// Only get_report is apiKey-usable today; #113 flips more entries to apiKey:true.
export const TOOL_AUTH = {
  get_report: { scope: "audits:read", apiKey: true },
  list_audits: { scope: "audits:read", apiKey: false },
  list_issues: { scope: "audits:read", apiKey: false },
  get_issue: { scope: "audits:read", apiKey: false },
  comment_on_issue: { scope: "audits:write", apiKey: false },
  // #1090: the support routes take a login session today; apiKey flips with the scopes.
  create_support_ticket: { scope: "support:write", apiKey: false },
  list_support_tickets: { scope: "support:read", apiKey: false },
  get_support_ticket: { scope: "support:read", apiKey: false },
  reply_to_support_ticket: { scope: "support:write", apiKey: false },
} as const satisfies Record<string, ToolAuth>;

// Shared phrasing for the session-only restriction so the tool note and the API 403 fallback can't drift (both flip with #113).
export const API_KEYS_NOT_YET_SUPPORTED = "org API keys are not yet supported";

// One-line description suffix so the tool listing reflects each tool's credential needs.
export function authNote(auth: ToolAuth): string {
  return auth.apiKey
    ? ` Requires the \`${auth.scope}\` scope (org API key) or a logged-in session.`
    : ` Requires a logged-in user session (${API_KEYS_NOT_YET_SUPPORTED} for this tool).`;
}
