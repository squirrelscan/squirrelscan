import { Effect } from "effect";

import { budgetedTimeoutMs, safeFetchWithDeadline, ungated } from "./deadline";

import type { PhaseBudget, ProbeGate } from "./deadline";
import type { MarkdownProbeData } from "@squirrelscan/core-contracts";

const PROBE_TIMEOUT_MS = 30_000;

const isMarkdown = (ct: string | null): boolean => ct != null && /markdown/i.test(ct);

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

const unreachableProbe = (): ProbeResult => ({
  ok: false,
  contentType: null,
  vary: null,
  markdownTokens: null,
  originalTokens: null,
  alternateMarkdownUrl: null,
});

// Probe one URL for its status + headers only; never downloads the body.
// null when the budget was spent before the request went out.
async function probeOne(
  url: string,
  userAgent: string,
  accept: string,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
): Promise<ProbeResult | null> {
  const timeoutMs = budgetedTimeoutMs(budget, PROBE_TIMEOUT_MS);
  if (timeoutMs === null) return null;
  try {
    return await safeFetchWithDeadline(
      url,
      { headers: { "User-Agent": userAgent, Accept: accept, ...customHeaders } },
      timeoutMs,
      async (res) => {
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
      },
    );
  } catch {
    return unreachableProbe();
  }
}

// Probe homepage markdown negotiation + a /index.md variant, once per audit.
// null when the budget cut a request and the rest found no Markdown: that is
// no finding, so the rule reports "not checked" rather than "no Markdown" (#409).
export function probeMarkdownResponse(
  baseUrl: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
  gate: ProbeGate = ungated,
): Effect.Effect<MarkdownProbeData | null, never, never> {
  const homeUrl = new URL("/", baseUrl).toString();
  const mdUrl = new URL("/index.md", baseUrl).toString();
  return Effect.promise(async () => {
    const [negSent, mdSent] = await Promise.all([
      gate(homeUrl, () =>
        probeOne(homeUrl, userAgent, "text/markdown, text/x-markdown, */*", customHeaders, budget),
      ),
      gate(mdUrl, () =>
        probeOne(mdUrl, userAgent, "text/markdown, text/plain, */*", customHeaders, budget),
      ),
    ]);
    const neg = negSent ?? unreachableProbe();
    const md = mdSent ?? unreachableProbe();
    const data: MarkdownProbeData = {
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
    const found = data.servesMarkdown || data.mdVariantExists || data.alternateMarkdownUrl !== null;
    if ((!negSent || !mdSent) && !found) return null;
    return data;
  });
}
