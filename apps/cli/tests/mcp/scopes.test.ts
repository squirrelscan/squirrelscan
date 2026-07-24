// Unit tests for the MCP tool → scope/credential map (#160).

import { isApiKeyScope } from "@squirrelscan/core-contracts/api-keys";
import { describe, expect, test } from "bun:test";

import { authNote, TOOL_AUTH } from "@/mcp/scopes";

describe("TOOL_AUTH", () => {
  test("every entry maps to a real grantable scope", () => {
    for (const auth of Object.values(TOOL_AUTH)) {
      expect(isApiKeyScope(auth.scope)).toBe(true);
    }
  });

  test("read tools map to audits:read, the write tool to audits:write", () => {
    expect(TOOL_AUTH.get_report.scope).toBe("audits:read");
    expect(TOOL_AUTH.comment_on_issue.scope).toBe("audits:write");
  });

  test("get_report is the only currently API-key-usable cloud tool", () => {
    const apiKeyUsable = Object.entries(TOOL_AUTH)
      .filter(([, a]) => a.apiKey)
      .map(([name]) => name);
    expect(apiKeyUsable).toEqual(["get_report"]);
  });
});

describe("authNote", () => {
  test("api-key tools advertise the scope", () => {
    expect(authNote(TOOL_AUTH.get_report)).toContain("audits:read");
    expect(authNote(TOOL_AUTH.get_report)).toContain("org API key");
  });

  test("session-only tools say a user session is required", () => {
    expect(authNote(TOOL_AUTH.comment_on_issue)).toContain("user session");
  });
});
