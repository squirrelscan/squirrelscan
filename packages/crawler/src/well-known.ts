import { Effect } from "effect";
import { byteLength, truncateToBytes } from "@squirrelscan/utils/bytes";
import { readBodyCapped } from "@squirrelscan/utils/response-body";

import { WELL_KNOWN_PATHS } from "@squirrelscan/core-contracts/storage";

import { BUDGET_EXHAUSTED_ERROR, budgetedTimeoutMs, safeFetchWithDeadline, ungated } from "./deadline";

import type { PhaseBudget, ProbeGate } from "./deadline";
import type { WellKnownProbe, WellKnownProbeData } from "@squirrelscan/core-contracts";

// Fixed probe list, owned by core-contracts so rules can declare the paths they
// read (#409). Rules decide what each hit/miss means; the crawler only fetches +
// records validation hints so rules can reject SPA-fallback 200s.
export { WELL_KNOWN_PATHS };

const PROBE_TIMEOUT_MS = 15_000;
// Small cap: agent/manifest files are tiny; an SPA-fallback HTML page can be big.
export const WELL_KNOWN_MAX_BYTES = 256 * 1024;
// Excerpt kept for rules to inspect without storing whole bodies.
export const EXCERPT_MAX_BYTES = 2_048;
// OAuth metadata docs need full-field access (registration_endpoint, CIMD, …),
// so keep a larger excerpt for those two paths.
export const OAUTH_EXCERPT_MAX_BYTES = 64 * 1024;

// The two OAuth metadata paths whose specific fields rules read.
export function isOAuthMetadataPath(path: string): boolean {
  return path.includes("oauth-authorization-server") || path.includes("oauth-protected-resource");
}

// Body sniff for an HTML document — the #1 false positive is a site returning
// 200 + SPA index.html for every path, including /.well-known/mcp.json.
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

// Parse as JSON; return the top-level object keys (empty for arrays/scalars).
export function sniffJson(body: string): { valid: boolean; keys: string[] } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { valid: true, keys: Object.keys(parsed as Record<string, unknown>) };
    }
    return { valid: true, keys: [] };
  } catch {
    return { valid: false, keys: [] };
  }
}

// Extract the OAuth AS/PRM metadata fields rules need from a JSON body.
export function extractOAuthFields(body: string): {
  registrationEndpoint: string | null;
  clientIdMetadataDocumentSupported: boolean | null;
} {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { registrationEndpoint: null, clientIdMetadataDocumentSupported: null };
    }
    const obj = parsed as Record<string, unknown>;
    const endpoint = obj.registration_endpoint;
    const cimd = obj.client_id_metadata_document_supported;
    return {
      registrationEndpoint: typeof endpoint === "string" ? endpoint : null,
      clientIdMetadataDocumentSupported: typeof cimd === "boolean" ? cimd : null,
    };
  } catch {
    return { registrationEndpoint: null, clientIdMetadataDocumentSupported: null };
  }
}

// A markdown-ish body: starts with an ATX heading or carries markdown links.
export function looksLikeMarkdown(body: string): boolean {
  const trimmed = body.trimStart();
  if (/^#{1,6}\s/.test(trimmed)) return true;
  return /\[[^\]]+\]\([^)]+\)/.test(trimmed.slice(0, 4_096));
}

const unreachableProbe = (path: string, url: string, error: string): WellKnownProbe => ({
  path,
  url,
  status: 0,
  contentType: null,
  bodySize: 0,
  looksHtml: false,
  jsonValid: false,
  jsonKeys: [],
  markdownLike: false,
  excerpt: "",
  oauthRegistrationEndpoint: null,
  oauthClientIdMetadataDocumentSupported: null,
  error,
});

async function probeOne(
  baseUrl: string,
  path: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
): Promise<WellKnownProbe> {
  const url = new URL(path, baseUrl).toString();
  const timeoutMs = budgetedTimeoutMs(budget, PROBE_TIMEOUT_MS);
  if (timeoutMs === null) return unreachableProbe(path, url, BUDGET_EXHAUSTED_ERROR);
  try {
    return await safeFetchWithDeadline(
      url,
      {
        headers: {
          "User-Agent": userAgent,
          Accept: "application/json, text/markdown, */*",
          ...customHeaders,
        },
      },
      timeoutMs,
      async (response) => {
        const contentType = response.headers.get("content-type");
        const isOAuth = isOAuthMetadataPath(path);
        // Skip reading a pathologically large body (18 probes run concurrently).
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > WELL_KNOWN_MAX_BYTES) {
          await response.body?.cancel().catch(() => {});
          return {
            path,
            url,
            status: response.status,
            contentType,
            bodySize: declared,
            looksHtml: false,
            jsonValid: false,
            jsonKeys: [],
            markdownLike: false,
            excerpt: "",
            oauthRegistrationEndpoint: null,
            oauthClientIdMetadataDocumentSupported: null,
            error: "body exceeds cap",
          };
        }
        const raw = await readBodyCapped(response, WELL_KNOWN_MAX_BYTES);
        const body = truncateToBytes(raw, WELL_KNOWN_MAX_BYTES);
        const looksHtml = looksLikeHtml(body);
        // A SPA-fallback HTML page must never count as valid JSON/markdown.
        const json = looksHtml ? { valid: false, keys: [] } : sniffJson(body);
        // Extract OAuth AS/PRM fields rules need; only for real JSON on the two paths.
        const oauth =
          isOAuth && json.valid && !looksHtml
            ? extractOAuthFields(body)
            : { registrationEndpoint: null, clientIdMetadataDocumentSupported: null };
        return {
          path,
          url,
          status: response.status,
          contentType,
          bodySize: byteLength(body),
          looksHtml,
          jsonValid: json.valid,
          jsonKeys: json.keys,
          markdownLike: !looksHtml && looksLikeMarkdown(body),
          excerpt: truncateToBytes(body, isOAuth ? OAUTH_EXCERPT_MAX_BYTES : EXCERPT_MAX_BYTES),
          oauthRegistrationEndpoint: oauth.registrationEndpoint,
          oauthClientIdMetadataDocumentSupported: oauth.clientIdMetadataDocumentSupported,
          error: null,
        };
      },
    );
  } catch (e) {
    return unreachableProbe(path, url, (e as Error).message);
  }
}

// Probe the well-known/agent-file list once per audit: every path by default,
// or only `paths` (the ones an enabled rule reads, #409). Requests go out
// through `gate`, which is how the crawl applies its per-host throttle.
export function probeWellKnown(
  baseUrl: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
  options: { paths?: readonly string[]; gate?: ProbeGate } = {},
): Effect.Effect<WellKnownProbeData, never, never> {
  const { paths = WELL_KNOWN_PATHS, gate = ungated } = options;
  return Effect.promise(async () => {
    const probes = await Promise.all(
      paths.map((path) =>
        gate(new URL(path, baseUrl).toString(), () =>
          probeOne(baseUrl, path, userAgent, customHeaders, budget),
        ),
      ),
    );
    return { probes };
  });
}
