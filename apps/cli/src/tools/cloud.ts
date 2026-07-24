// Cloud services client factory — builds a CloudServicesClient from the CLI's
// auth state. Returns null when logged out (or the token is expired); callers
// treat null as "all cloud features skipped: not-authenticated".

import {
  createCloudClient,
  type CloudServicesClient,
} from "@squirrelscan/cloud-client";

import { getApiUrl } from "@/self/api";
import { type CredentialSource, resolveCredential } from "@/self/credentials";

import { version } from "../../package.json";

/**
 * Build a cloud client from the resolved credential (SQUIRRELSCAN_API_KEY env,
 * or its SQUIRREL_API_TOKEN alias → settings.json auth.token). Null when
 * unauthenticated / the login token is expired / settings are unreadable —
 * cloud features degrade to `skipped` rather than erroring the audit.
 *
 * NOTE: a null return here is the UNAUTHENTICATED case only. When the credential
 * comes from the env var (`source === "env"`) and the server rejects it (401),
 * the audit preflight enforces fail-closed (errors) instead of degrading — the
 * client itself can't know validity until a request is made.
 */
export function createCloudClientFromSettings(opts?: {
  /** Override the 120s default — status/balance lines use a short timeout. */
  timeoutMs?: number;
  maxAttempts?: number;
}): CloudServicesClient | null {
  return createCloudClientWithSource(opts)?.client ?? null;
}

/**
 * Same as `createCloudClientFromSettings` but also returns the credential
 * `source`, so callers can apply fail-closed semantics to env-supplied tokens.
 */
export function createCloudClientWithSource(opts?: {
  timeoutMs?: number;
  maxAttempts?: number;
}): { client: CloudServicesClient; source: CredentialSource } | null {
  const cred = resolveCredential();
  if (!cred) return null;

  const client = createCloudClient({
    apiUrl: getApiUrl(),
    token: cred.token,
    userAgent: `squirrel/${version}`,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts?.maxAttempts !== undefined
      ? { maxAttempts: opts.maxAttempts }
      : {}),
  });

  return { client, source: cred.source };
}
