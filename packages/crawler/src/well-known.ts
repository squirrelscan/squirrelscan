import { Effect } from "effect";
import { byteLength, truncateToBytes } from "@squirrelscan/utils/bytes";

import type { WellKnownProbe, WellKnownProbeData } from "@squirrelscan/core-contracts";

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

// Fixed probe list. Rules decide what each hit/miss means; the crawler only
// fetches + records validation hints so rules can reject SPA-fallback 200s.
export const WELL_KNOWN_PATHS: readonly string[] = [
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp.json",
  "/.well-known/mcp",
  "/.well-known/mcp-server",
  "/.well-known/agent-card.json",
  "/.well-known/agent-skills/index.json",
  "/.well-known/api-catalog",
  "/openapi.json",
  "/swagger.json",
  "/api/openapi.json",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/AGENTS.md",
  "/agents.md",
  "/.well-known/agents.md",
  "/docs/AGENTS.md",
  "/ai-plugin.json",
  "/.well-known/ai-plugin.json",
  "/.well-known/llms.txt",
  "/docs/llms.txt",
];

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

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

async function probeOne(
  baseUrl: string,
  path: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
): Promise<WellKnownProbe> {
  const url = new URL(path, baseUrl).toString();
  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": userAgent,
          Accept: "application/json, text/markdown, */*",
          ...customHeaders,
        },
      },
      PROBE_TIMEOUT_MS,
    );
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
    const raw = await response.text();
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
  } catch (e) {
    return {
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
      error: (e as Error).message,
    };
  }
}

// Probe the fixed well-known/agent-file list concurrently, once per audit.
export function probeWellKnown(
  baseUrl: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
): Effect.Effect<WellKnownProbeData, never, never> {
  return Effect.promise(async () => {
    const probes = await Promise.all(
      WELL_KNOWN_PATHS.map((path) => probeOne(baseUrl, path, userAgent, customHeaders)),
    );
    return { probes };
  });
}
