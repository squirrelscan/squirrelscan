import { Effect } from "effect";

import type { MarkdownProbeData } from "@squirrelscan/core-contracts";

const PROBE_TIMEOUT_MS = 30_000;

const isMarkdown = (ct: string | null): boolean => ct != null && /markdown/i.test(ct);

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

// Parse a `Link:` response header for a `rel="alternate"; type="text/markdown"`
// entry and resolve it to an absolute URL. Returns null if none matches.
export function parseAlternateMarkdownLink(linkHeader: string | null, baseUrl: string): string | null {
  if (!linkHeader) return null;
  for (const entry of linkHeader.split(/,(?=\s*<)/)) {
    const urlMatch = entry.match(/<([^>]+)>/);
    if (!urlMatch) continue;
    const isAlternate = /rel\s*=\s*"?alternate"?/i.test(entry);
    const isMarkdownType = /type\s*=\s*"?text\/markdown"?/i.test(entry);
    if (isAlternate && isMarkdownType) {
      try {
        return new URL(urlMatch[1]!, baseUrl).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface ProbeResult {
  ok: boolean;
  contentType: string | null;
  vary: string | null;
  markdownTokens: string | null;
  originalTokens: string | null;
  alternateMarkdownUrl: string | null;
}

// Probe one URL for its status + headers only; never downloads the body.
async function probeOne(
  url: string,
  userAgent: string,
  accept: string,
  customHeaders?: Record<string, string>,
): Promise<ProbeResult> {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": userAgent, Accept: accept, ...customHeaders } },
      PROBE_TIMEOUT_MS,
    );
    const contentType = res.headers.get("content-type");
    const result: ProbeResult = {
      ok: res.ok,
      contentType,
      vary: res.headers.get("vary"),
      markdownTokens: res.headers.get("x-markdown-tokens"),
      originalTokens: res.headers.get("x-original-tokens"),
      alternateMarkdownUrl: parseAlternateMarkdownLink(res.headers.get("link"), url),
    };
    await res.body?.cancel().catch(() => {});
    return result;
  } catch {
    return {
      ok: false,
      contentType: null,
      vary: null,
      markdownTokens: null,
      originalTokens: null,
      alternateMarkdownUrl: null,
    };
  }
}

// Probe homepage markdown negotiation + a /index.md variant, once per audit.
export function probeMarkdownResponse(
  baseUrl: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
): Effect.Effect<MarkdownProbeData, never, never> {
  const homeUrl = new URL("/", baseUrl).toString();
  const mdUrl = new URL("/index.md", baseUrl).toString();
  return Effect.promise(async () => {
    const [neg, md] = await Promise.all([
      probeOne(homeUrl, userAgent, "text/markdown, text/x-markdown, */*", customHeaders),
      probeOne(mdUrl, userAgent, "text/markdown, text/plain, */*", customHeaders),
    ]);
    return {
      negotiatedUrl: homeUrl,
      negotiatedContentType: neg.contentType,
      servesMarkdown: isMarkdown(neg.contentType),
      mdVariantUrl: mdUrl,
      mdVariantExists: md.ok && isMarkdown(md.contentType),
      mdVariantContentType: md.contentType,
      negotiatedVary: neg.vary,
      markdownTokensHeader: neg.markdownTokens,
      originalTokensHeader: neg.originalTokens,
      alternateMarkdownUrl: neg.alternateMarkdownUrl,
    };
  });
}
