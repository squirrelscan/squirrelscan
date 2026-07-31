import { Effect } from "effect";
import { byteLength, truncateToBytes } from "@squirrelscan/utils/bytes";
import { safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";
import { readBodyCapped } from "@squirrelscan/utils/response-body";

import type { LlmsTxtData, LlmsTxtFile } from "@squirrelscan/core-contracts";

const LLMS_FETCH_TIMEOUT_MS = 30_000;
// Cap stored content so a pathological/huge file can't bloat memory or SQLite.
const LLMS_MAX_BYTES = 1_000_000;

function emptyFile(url: string): LlmsTxtFile {
  return { url, exists: false, content: null, sizeBytes: 0 };
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // #1395: manual redirects — per-hop scheme allowlist + strip secret
  // customHeaders on cross-origin redirects (native redirect:"follow" leaks them).
  return safeRedirectFetch(url, { ...options, signal: controller.signal })
    .then((result) => result.response)
    .finally(() => clearTimeout(timeout));
}

// Fetch one well-known file; a 404/error/oversize file is "absent", never a throw.
async function fetchOne(
  url: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
): Promise<LlmsTxtFile> {
  try {
    const response = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": userAgent, Accept: "text/plain, text/markdown, */*", ...customHeaders } },
      LLMS_FETCH_TIMEOUT_MS,
    );
    if (response.status === 404 || !response.ok) return emptyFile(url);
    // The content-length pre-check is a cheap fast path only: it is absent on a
    // chunked response and reports the COMPRESSED size on an encoded one, so it
    // cannot bound the read. readBodyCapped enforces the limit against the
    // decoded stream and cancels at the cap, which is what stops a small
    // compressed body from expanding to gigabytes in memory.
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > LLMS_MAX_BYTES) return emptyFile(url);
    const raw = await readBodyCapped(response, LLMS_MAX_BYTES);
    // #1293: byte-accurate cap — a `.length` slice over-keeps a multi-byte body.
    // Still applied after the capped read: decoding can emit replacement chars
    // that are wider than the bytes they replace.
    const content = truncateToBytes(raw, LLMS_MAX_BYTES);
    return { url, exists: true, content, sizeBytes: byteLength(content) };
  } catch {
    return emptyFile(url);
  }
}

// Fetch /llms.txt + /llms-full.txt from the domain root once per audit.
export function fetchLlmsTxt(
  baseUrl: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
): Effect.Effect<LlmsTxtData, never, never> {
  const llmsUrl = new URL("/llms.txt", baseUrl).toString();
  const fullUrl = new URL("/llms-full.txt", baseUrl).toString();
  return Effect.promise(async () => {
    const [llmsTxt, llmsFullTxt] = await Promise.all([
      fetchOne(llmsUrl, userAgent, customHeaders),
      fetchOne(fullUrl, userAgent, customHeaders),
    ]);
    return { llmsTxt, llmsFullTxt };
  });
}
