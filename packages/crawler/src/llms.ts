import { Effect } from "effect";
import { byteLength, truncateToBytes } from "@squirrelscan/utils/bytes";
import { readBodyCapped } from "@squirrelscan/utils/response-body";

import { budgetedTimeoutMs, safeFetchWithDeadline, ungated } from "./deadline";
import { noteRefusal } from "./refusals";

import type { PhaseBudget, ProbeGate } from "./deadline";
import type { LlmsTxtData, LlmsTxtFile } from "@squirrelscan/core-contracts";

const LLMS_FETCH_TIMEOUT_MS = 30_000;
// Cap stored content so a pathological/huge file can't bloat memory or SQLite.
const LLMS_MAX_BYTES = 1_000_000;

function emptyFile(url: string): LlmsTxtFile {
  return { url, exists: false, content: null, sizeBytes: 0 };
}

// Fetch one well-known file; a 404/error-status/oversize file is "absent", never
// a throw. null when there was no answer at all: the budget was spent before the
// request went out, it failed or timed out in flight, or the site refused it
// (401/403/429, a bot wall). Nothing learned (#409).
async function fetchOne(
  url: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
): Promise<LlmsTxtFile | null> {
  const timeoutMs = budgetedTimeoutMs(budget, LLMS_FETCH_TIMEOUT_MS);
  if (timeoutMs === null) return null;
  try {
    return await safeFetchWithDeadline(
      url,
      { headers: { "User-Agent": userAgent, Accept: "text/plain, text/markdown, */*", ...customHeaders } },
      timeoutMs,
      async (response) => {
        if (noteRefusal(budget?.refusals, url, "llms.txt", response)) {
          await response.body?.cancel().catch(() => {});
          return null;
        }
        if (response.status === 404 || !response.ok) {
          await response.body?.cancel().catch(() => {});
          return emptyFile(url);
        }
        // The content-length pre-check is a cheap fast path only: it is absent on a
        // chunked response and reports the COMPRESSED size on an encoded one, so it
        // cannot bound the read. readBodyCapped enforces the limit against the
        // decoded stream and cancels at the cap, which is what stops a small
        // compressed body from expanding to gigabytes in memory.
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > LLMS_MAX_BYTES) {
          await response.body?.cancel().catch(() => {});
          return emptyFile(url);
        }
        const raw = await readBodyCapped(response, LLMS_MAX_BYTES);
        // #1293: byte-accurate cap — a `.length` slice over-keeps a multi-byte body.
        // Still applied after the capped read: decoding can emit replacement chars
        // that are wider than the bytes they replace.
        const content = truncateToBytes(raw, LLMS_MAX_BYTES);
        return { url, exists: true, content, sizeBytes: byteLength(content) };
      },
    );
  } catch {
    return null;
  }
}

// Fetch /llms.txt + /llms-full.txt from the domain root once per audit. null
// when /llms.txt got no answer (skipped by the budget, refused, timed out):
// there is no finding to store, and the rule reports "not checked" rather than
// a missing file (#409).
export function fetchLlmsTxt(
  baseUrl: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
  gate: ProbeGate = ungated,
): Effect.Effect<LlmsTxtData | null, never, never> {
  const llmsUrl = new URL("/llms.txt", baseUrl).toString();
  const fullUrl = new URL("/llms-full.txt", baseUrl).toString();
  return Effect.promise(async () => {
    const [llmsTxt, llmsFullTxt] = await Promise.all([
      gate(llmsUrl, () => fetchOne(llmsUrl, userAgent, customHeaders, budget)),
      gate(fullUrl, () => fetchOne(fullUrl, userAgent, customHeaders, budget)),
    ]);
    if (!llmsTxt) return null;
    // A skipped /llms-full.txt only ever costs the rule a note, so it records as absent.
    return { llmsTxt, llmsFullTxt: llmsFullTxt ?? emptyFile(fullUrl) };
  });
}
