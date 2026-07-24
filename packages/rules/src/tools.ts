// Tool injection points — CLI provides real implementations at startup.
//
// These injectors hold PROCESS-WIDE tool implementations (HTTP client, LLM
// client) wired once at startup and identical for every audit. They are NOT
// per-audit state, so they are safe to share across concurrent audits in one
// isolate. Per-audit state (resolved site metadata, prefetched cloud results)
// is threaded through the RULE CONTEXT instead — see `RuleContext.siteMetadata`,
// `RuleContext.cloudResults`, and `readCloudResult()` in `cloud.ts`.

import type { ZodType } from "zod";

// HTTP request tool
export type RequestAsyncFn = (url: string, options?: RequestInit) => Promise<Response>;

let _requestAsync: RequestAsyncFn = () => {
  throw new Error("requestAsync not injected — call setRequestAsync() first");
};

export function setRequestAsync(fn: RequestAsyncFn): void {
  _requestAsync = fn;
}

export function requestAsync(url: string, options?: RequestInit): Promise<Response> {
  return _requestAsync(url, options);
}

// LLM tool
export type LlmCallFn = (system: string, prompt: string) => Promise<string>;

let _llmCall: LlmCallFn | null = null;

export function setLlmCall(fn: LlmCallFn): void {
  _llmCall = fn;
}

export function isLLMAvailable(): boolean {
  return _llmCall !== null;
}

// Overload: no schema → returns raw string
export function llmCallWithSystem(system: string, prompt: string): Promise<string>;
// Overload: with schema → returns parsed result
export function llmCallWithSystem<T>(
  system: string,
  prompt: string,
  schema: ZodType<T>
): Promise<{ success: true; data: T } | { success: false; error: string }>;
// Implementation
export async function llmCallWithSystem<T>(
  system: string,
  prompt: string,
  schema?: ZodType<T>
): Promise<string | { success: true; data: T } | { success: false; error: string }> {
  if (!_llmCall) throw new Error("LLM not injected — call setLlmCall() first");
  const raw = await _llmCall(system, prompt);

  if (!schema) return raw;

  try {
    const parsed = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error.message };
  } catch (e) {
    return { success: false, error: `Failed to parse LLM response as JSON: ${(e as Error).message}` };
  }
}
