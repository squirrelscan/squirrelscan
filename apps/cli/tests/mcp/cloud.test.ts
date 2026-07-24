// Unit tests for MCP cloud/auth helpers + the local-audit result mapper.

import { describe, expect, test } from "bun:test";

import type { ApiResult } from "@/lib/api-client";
import type { ResolvedCredential } from "@/self/credentials";

import { apiResultToTool, requireLoginError } from "@/mcp/cloud";
import { renderAuditResult } from "@/mcp/tools/audit-tools";
import {
  API_TOKEN_ENV_VAR,
  LEGACY_API_TOKEN_ENV_VAR,
} from "@/self/credentials";

import { createMinimalReport } from "../reports/fixtures";

const cred: ResolvedCredential = { token: "sqcli_test", source: "login" };

function text(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

describe("requireLoginError", () => {
  test("returns a clean error when no credential resolves", () => {
    const denied = requireLoginError(() => null);
    expect(denied?.isError).toBe(true);
    expect(text(denied!)).toContain("Not authenticated");
  });

  test("names both fixes: the env token (and its legacy alias) and `squirrel auth login`", () => {
    const denied = requireLoginError(() => null);
    const message = text(denied!);
    expect(message).toContain(API_TOKEN_ENV_VAR);
    expect(message).toContain(LEGACY_API_TOKEN_ENV_VAR);
    expect(message).toContain("squirrel auth login");
  });

  test("returns null when a credential resolves", () => {
    expect(requireLoginError(() => cred)).toBeNull();
  });
});

describe("apiResultToTool", () => {
  const make = (
    status: number,
    ok: boolean,
    data: unknown = null
  ): ApiResult<unknown> => ({
    ok,
    status,
    data,
  });

  test("2xx returns the JSON body", () => {
    const out = apiResultToTool(make(200, true, { runs: [] }));
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain("runs");
  });

  test("status 0 is a transport error", () => {
    const out = apiResultToTool(make(0, false));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Could not reach");
  });

  test("401 surfaces an auth error", () => {
    const out = apiResultToTool(make(401, false));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Authentication failed");
  });

  test("403 with no body falls back to forbidden + credential guidance", () => {
    const out = apiResultToTool(make(403, false));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Forbidden");
    expect(text(out)).toContain("logged-in session");
  });

  test("403 with an all-dots reason falls back instead of 'Forbidden — .'", () => {
    const out = apiResultToTool(make(403, false, { error: "..." }));
    expect(text(out)).not.toContain("Forbidden — .");
    expect(text(out)).toContain("logged-in session");
  });

  test("403 surfaces a bare-string (proxy/WAF) body", () => {
    const out = apiResultToTool(make(403, false, "Access denied"));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Access denied");
  });

  test("a verbose server error is capped so it can't flood agent context", () => {
    const out = apiResultToTool(make(500, false, { error: "x".repeat(5000) }));
    expect(text(out).length).toBeLessThan(400);
  });

  test("403 does not double-punctuate a reason ending in ! or ?", () => {
    const out = apiResultToTool(make(403, false, { error: "No access!" }));
    expect(text(out)).toContain("Forbidden — No access!");
    expect(text(out)).not.toContain("!.");
  });

  test("403 surfaces the server's missing-scope reason verbatim", () => {
    const out = apiResultToTool(
      make(403, false, {
        error: "API key missing required scope: audits:write",
      })
    );
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("audits:write");
    expect(text(out)).toContain("Forbidden");
  });

  test("403 surfaces the server's session-only reason", () => {
    const out = apiResultToTool(
      make(403, false, {
        error: "This operation requires a user session, not an API key",
      })
    );
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("requires a user session");
  });

  test("403 does not double the period when the reason already ends in one", () => {
    const out = apiResultToTool(make(403, false, { error: "Missing scope." }));
    expect(text(out)).toContain("Forbidden — Missing scope.");
    expect(text(out)).not.toContain("..");
  });

  test("404 uses the provided hint", () => {
    const out = apiResultToTool(make(404, false), "Website w1 not found.");
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Website w1 not found");
  });

  test("other errors prefer the server-supplied message", () => {
    const out = apiResultToTool(make(409, false, { error: "duplicate" }));
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("duplicate");
  });
});

describe("renderAuditResult", () => {
  test("ok result renders the LLM (XML) report", () => {
    const out = renderAuditResult({ ok: true, data: createMinimalReport() });
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain("<audit");
  });

  test("error result surfaces the command error message", () => {
    const out = renderAuditResult({
      ok: false,
      error: { code: "UNREACHABLE", message: "Cannot reach https://x" },
    });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Cannot reach");
  });
});
