// Cloud issue tools (authed): list/get audit issues, comment on an issue.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { z } from "zod";

import { cliApi } from "@/lib/api-client";

import {
  apiResultToTool,
  type LoginResolver,
  requireLoginError,
} from "../cloud";
import { authNote, TOOL_AUTH } from "../scopes";

export function registerIssueTools(
  server: McpServer,
  resolveLogin?: LoginResolver
): void {
  server.registerTool(
    "list_issues",
    {
      title: "List a website's audit issues",
      description:
        "List the open, supplant-aware full-site issue state for a website. Superseded issues are excluded by default. Returns issues as JSON." +
        authNote(TOOL_AUTH.list_issues),
      inputSchema: {
        websiteId: z.string().describe("The website id whose issues to list"),
      },
    },
    async ({ websiteId }) => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const result = await cliApi.request(
        `/v1/websites/${encodeURIComponent(websiteId)}/issues`,
        { auth: "required" }
      );
      return apiResultToTool(result, `Website ${websiteId} not found.`);
    }
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get a single audit issue",
      description:
        "Fetch one audit issue by its number for a website. Returns the issue detail + comments as JSON." +
        authNote(TOOL_AUTH.get_issue),
      inputSchema: {
        websiteId: z.string().describe("The website id the issue belongs to"),
        number: z.number().int().positive().describe("The issue number"),
      },
    },
    async ({ websiteId, number }) => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const result = await cliApi.request(
        `/v1/websites/${encodeURIComponent(websiteId)}/issues/${number}`,
        { auth: "required" }
      );
      return apiResultToTool(
        result,
        `Issue #${number} not found for website ${websiteId}.`
      );
    }
  );

  server.registerTool(
    "comment_on_issue",
    {
      title: "Comment on an audit issue",
      description:
        "Post a comment on an audit issue for a website. Returns the created comment as JSON." +
        authNote(TOOL_AUTH.comment_on_issue),
      inputSchema: {
        websiteId: z.string().describe("The website id the issue belongs to"),
        number: z.number().int().positive().describe("The issue number"),
        body: z
          .string()
          .min(1)
          .max(10000)
          .describe("The comment text (1-10000 chars)"),
      },
    },
    async ({ websiteId, number, body }) => {
      const denied = requireLoginError(resolveLogin);
      if (denied) return denied;
      const result = await cliApi.request(
        `/v1/websites/${encodeURIComponent(websiteId)}/issues/${number}/comments`,
        { method: "POST", auth: "required", body: { body, type: "user" } }
      );
      return apiResultToTool(
        result,
        `Issue #${number} not found for website ${websiteId}.`
      );
    }
  );
}
