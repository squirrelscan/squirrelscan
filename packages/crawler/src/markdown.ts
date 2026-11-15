import { Effect } from "effect";

import { optionalProbeTimeoutMs, safeFetchWithDeadline, ungated } from "./deadline";
import { noteRefusal } from "./refusals";

import type { PhaseBudget, ProbeGate } from "./deadline";
import type { MarkdownProbeData } from "@squirrelscan/core-contracts";
import { mergeHeaderRecords } from "@squirrelscan/utils/headers";

const PROBE_TIMEOUT_MS = 30_000;

const isMarkdown = (ct: string | null): boolean => ct != null && /markdown/i.test(ct);

// Parse a `Link:` response header for a `rel="alternate"; type="text/markdown"`
// entry and resolve it to an absolute URL. Returns null if none matches.
export function parseAlternateMarkdownLink(
  linkHeader: string | null,
  baseUrl: string,
): string | null {
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
  status: number | null;
  contentType: string | null;
  vary: string | null;
  markdownTokens: string | null;
  originalTokens: string | null;
  alternateMarkdownUrl: string | null;
}

const unreachableProbe = (): ProbeResult => ({
  ok: false,
  status: null,
  contentType: null,
  vary: null,
  markdownTokens: null,
  originalTokens: null,
  alternateMarkdownUrl: null,
});

// Probe one URL for its status + headers only; never downloads the body.
// null when there was no answer: skipped by the budget, failed in flight, or
// refused by the site (401/403/429, a bot wall). A 5xx or another non-ok status is
// also null unless `keepEveryStatus` is set: the strict negotiation probe needs
// the 5xx itself, because a server error on strict negotiation is the defect it
// looks for, and a 406 Not Acceptable is a healthy answer to it (repo#1322).
async function probeOne(
  url: string,
  userAgent: string,
  accept: string,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
  keepEveryStatus = false,
): Promise<ProbeResult | null> {
  const timeoutMs = optionalProbeTimeoutMs(budget, PROBE_TIMEOUT_MS);
  if (timeoutMs === null) return null;
  try {
    return await safeFetchWithDeadline(
      url,
      // The negotiation IS the Accept, so it is laid last (repo#3346).
      {
        headers: mergeHeaderRecords({ "User-Agent": userAgent }, customHeaders, { Accept: accept }),
      },
      timeoutMs,
      async (res) => {
        if (noteRefusal(budget?.refusals, url, "markdown", res)) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        // A 404/410 is an answer (no Markdown here). A 5xx or other non-ok status is
        // no answer, so it is not stored as "no Markdown" (#1760), except on the
        // strict probe, where every status but a refusal is its answer.
        if (!res.ok && res.status !== 404 && res.status !== 410 && !keepEveryStatus) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const contentType = res.headers.get("content-type");
        const result: ProbeResult = {
          ok: res.ok,
          status: res.status,
          contentType,
          vary: res.headers.get("vary"),
          markdownTokens: res.headers.get("x-markdown-tokens"),
          originalTokens: res.headers.get("x-original-tokens"),
          alternateMarkdownUrl: parseAlternateMarkdownLink(res.headers.get("link"), url),
        };
        await res.body?.cancel().catch(() => {});
        return result;
      },
      budget?.egress,
    );
  } catch {
    return null;
  }
}

// The Accept a Markdown-only agent sends. The lenient probe below ends in `*/*`,
// so a server can answer it with HTML even when it errors on this one (repo#1322).
const STRICT_MARKDOWN_ACCEPT = "text/markdown";

// Probe homepage markdown negotiation (lenient and strict Accept) + a /index.md
// variant, once per audit. null when a request got no answer and the rest found
// no Markdown: that is no finding, so the rule reports "not checked" rather than
// "no Markdown" (#409). A strict-negotiation 5xx is a finding only when the
// lenient probe got an answer: a homepage that 5xxs on every Accept is a site
// that is down, not a negotiation defect, and stays unknown (#1760).
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
    const [negAnswer, strictAnswer, mdAnswer] = await Promise.all([
      gate(homeUrl, () =>
        probeOne(homeUrl, userAgent, "text/markdown, text/x-markdown, */*", customHeaders, budget),
      ),
      gate(homeUrl, () =>
        probeOne(homeUrl, userAgent, STRICT_MARKDOWN_ACCEPT, customHeaders, budget, true),
      ),
      gate(mdUrl, () =>
        probeOne(mdUrl, userAgent, "text/markdown, text/plain, */*", customHeaders, budget),
      ),
    ]);
    const neg = negAnswer ?? unreachableProbe();
    const md = mdAnswer ?? unreachableProbe();
    // A strict 5xx only counts when the lenient probe answered (see above). With
    // no lenient answer it is no answer either: the strict probe is unanswered.
    const strict =
      strictAnswer && strictAnswer.status !== null && strictAnswer.status >= 500 && !negAnswer
        ? null
        : strictAnswer;
    const strictServesMarkdown = strict !== null && strict.ok && isMarkdown(strict.contentType);
    const data: MarkdownProbeData = {
      negotiatedUrl: homeUrl,
      negotiatedContentType: neg.contentType,
      servesMarkdown: isMarkdown(neg.contentType) || strictServesMarkdown,
      negotiatedStatus: neg.status,
      strictNegotiatedStatus: strict?.status ?? null,
      strictNegotiatedContentType: strict?.contentType ?? null,
      // Unanswered (refused, throttled, timed out, the budget, or a 5xx on every
      // Accept) is its own state, never a clean strict answer (repo#1322).
      strictNegotiationAnswered: strict !== null,
      mdVariantAnswered: mdAnswer !== null,
      mdVariantUrl: mdUrl,
      mdVariantExists: md.ok && isMarkdown(md.contentType),
      mdVariantContentType: md.contentType,
      negotiatedVary: neg.vary,
      markdownTokensHeader: neg.markdownTokens,
      originalTokensHeader: neg.originalTokens,
      alternateMarkdownUrl: neg.alternateMarkdownUrl,
    };
    const strictServerError = strict?.status != null && strict.status >= 500;
    const found =
      data.servesMarkdown ||
      data.mdVariantExists ||
      data.alternateMarkdownUrl !== null ||
      strictServerError;
    if ((!negAnswer || !mdAnswer) && !found) return null;
    return data;
  });
}
