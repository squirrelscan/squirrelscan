// Cloud report tools (authed): fetch a published report, list active runs.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { z } from "zod";

import { cliApi } from "@/lib/api-client";

import {
  apiResultToTool,
  type LoginResolver,
  requireLoginError,
} from "../cloud";
import { jsonResult } from "../result";
import { authNote, TOOL_AUTH } from "../scopes";

/**
 * Shape of GET /v1/agent-runs/active's per-run `pageLimitNotice` (#1274,
 * mirrors `PageLimitClampNotice` in apps/api/src/lib/website-run-config.ts —
 * apps/cli can't import that directly, cross-app imports must stay in
 * packages/). Only the fields the one-line warn actually reads.
 */
interface ActiveRunPageLimitNotice {
  requested: number;
  applied: number;
  upgradeHint: string;
}

// `pageLimitNotice` is typed `unknown` here (not the interface above) — this
// object comes straight off an `as`-cast JSON response, so nothing has
// actually verified its shape yet. isPageLimitNotice() below does that.
interface ActiveRunSummary {
  url: string;
  domain?: string;
  pageLimitNotice?: unknown;
}

function isPageLimitNotice(value: unknown): value is ActiveRunPageLimitNotice {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.applied === "number" &&
    typeof v.requested === "number" &&
    typeof v.upgradeHint === "string"
  );
}

// One line per clamped run — the agent-facing surface for #1274's
// clamp-and-notify signal. The full structured notice is still present in
// the JSON block that follows; this line just makes it impossible to miss.
// A malformed/partial notice (API drift, not expected today) is treated as
// no notice rather than printing "undefined" into the agent-facing text.
function pageLimitWarnLine(run: ActiveRunSummary): string {
  if (!isPageLimitNotice(run.pageLimitNotice)) return "";
  const notice = run.pageLimitNotice;
  const site = run.domain ?? run.url;
  return `Page limit: ${site} was capped to ${notice.applied} pages (requested ${notice.requested}). ${notice.upgradeHint}`;
}

export function registerReportTools(
  server: McpServer,
  resolveLogin?: LoginResolver
): void {
  server.registerTool(
    "get_report",
    {
      title: "Get a published audit report",
      description:
        "Fetch a rendered audit report by its audit/run id. Returns the report's issues, scores, and metadata as JSON." +
        authNote(TOOL_AUTH.get_report),
      inputSchema: {
        auditId: z
          .string()
          .describe("The audit/run id to fetch the report for"),
      },
    },
    async ({ auditId }) => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const result = await cliApi.request(
        `/v1/agent-runs/${encodeURIComponent(auditId)}/report`,
        { auth: "required" }
      );
      return apiResultToTool(result, `No report found for audit ${auditId}.`);
    }
  );

  server.registerTool(
    "list_audits",
    {
      title: "List active audits",
      description:
        "List your organization's currently running or pending audits. Returns each run's url, status, and trigger as JSON." +
        authNote(TOOL_AUTH.list_audits),
      inputSchema: {},
    },
    async () => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const result = await cliApi.request("/v1/agent-runs/active", {
        auth: "required",
      });
      if (!result.ok) return apiResultToTool(result);

      const body = result.data as { runs?: unknown } | null;
      // Filter to object entries before the cast: a null/non-object element
      // in `runs` (server bug, not expected today) must not throw inside
      // pageLimitWarnLine, which reads straight off `run.pageLimitNotice`.
      const runs = Array.isArray(body?.runs)
        ? (body.runs.filter(
            (r): r is Record<string, unknown> => !!r && typeof r === "object"
          ) as unknown as ActiveRunSummary[])
        : [];
      const warnLines = runs.map(pageLimitWarnLine).filter(Boolean);
      const jsonBlock = jsonResult(result.data);
      if (warnLines.length === 0) return jsonBlock;
      return {
        content: [
          { type: "text", text: warnLines.map((l) => `⚠ ${l}`).join("\n") },
          ...jsonBlock.content,
        ],
      };
    }
  );
}
