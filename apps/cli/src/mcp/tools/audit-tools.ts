// Local deterministic audit tools — free, no auth; cloud enrichment when authed.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { renderLlm } from "@squirrelscan/report";
import {
  isValidHeaderName,
  isValidHeaderValue,
} from "@squirrelscan/utils/headers";
import { z } from "zod";

import type { Result } from "@/controllers/types";
import type { AuditReport } from "@/types";

import { coverageMaxPages, type CoverageMode } from "@/cli/coverage";
import { findConfigFile, getGlobalConfigPath } from "@/config";
import { runAudit, type RunAuditOptions } from "@/controllers/audit";

import { version } from "../../../package.json";
import { resolveCloudAvailability } from "../cloud";
import { errorResult, textResult } from "../result";

// Map a runAudit Result to a tool result: ok → LLM report text, err → clean error.
export function renderAuditResult(result: Result<AuditReport>): CallToolResult {
  if (!result.ok) return errorResult(result.error.message);
  return textResult(
    renderLlm(result.data as Parameters<typeof renderLlm>[0], { version })
  );
}

// Run runAudit non-interactively and render the LLM report, or a clean MCP error.
async function runLocalAudit(
  options: Omit<RunAuditOptions, "configPath"> & { coverageMode: CoverageMode }
) {
  // Mirror the CLI: honor --config-file, else auto-discover the project's squirrel config from cwd.
  const result = await runAudit({
    ...options,
    configPath: getGlobalConfigPath() ?? findConfigFile() ?? undefined,
  });
  return renderAuditResult(result);
}

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "audit_website",
    {
      title: "Audit a website",
      description:
        "Run a full deterministic website audit (performance, security, accessibility, content, structured data, and more) on a URL and return an LLM-optimized report. Free + local; adds cloud enrichment automatically when logged in (charges credits per your plan). Pass offline:true to force local-only.",
      inputSchema: {
        url: z.string().describe("The URL to audit (e.g. https://example.com)"),
        coverage: z
          .enum(["quick", "surface", "full"])
          .optional()
          .describe(
            "Crawl coverage: quick (fast, local, free), surface (one page per pattern, default), full (comprehensive)"
          ),
        maxPages: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Override the max pages to crawl (default: coverage-mode budget)"
          ),
        offline: z
          .boolean()
          .optional()
          .describe("Force a fully local audit with no cloud enrichment"),
        headers: z
          // Reject control chars in names/values — replayed onto outbound requests (#532).
          .record(
            z
              .string()
              .max(255)
              .refine(isValidHeaderName, { message: "Invalid header name" }),
            z.string().max(8192).refine(isValidHeaderValue, {
              message: "Header value contains control characters (CR/LF/NUL)",
            })
          )
          .refine((h) => Object.keys(h).length <= 50, {
            message: "Too many custom headers (max 50)",
          })
          .optional()
          .describe(
            'Custom HTTP request headers attached to every crawl request (pages, assets, robots, sitemap). Map of name → value, e.g. {"Signature-Agent": "\\"https://shopify.com\\""}. Use for authorized-crawler schemes (Shopify/Cloudflare Web Bot Auth). Values are secrets — never echoed back.'
          ),
      },
    },
    async ({ url, coverage, maxPages, offline, headers }) => {
      const coverageMode: CoverageMode = coverage ?? "surface";
      const cloudAvailable =
        coverageMode === "quick" || offline
          ? false
          : await resolveCloudAvailability();
      return runLocalAudit({
        url,
        coverageMode,
        maxPages: maxPages ?? coverageMaxPages(coverageMode),
        cloudAvailable,
        offline,
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }
  );

  server.registerTool(
    "quick_check",
    {
      title: "Quick single-pass check",
      description:
        "Fast, local-only audit (quick coverage): a single-page pass with no crawl discovery or cloud enrichment. Free and works offline. Use for a rapid health snapshot of one URL.",
      inputSchema: {
        url: z.string().describe("The URL to check (e.g. https://example.com)"),
      },
    },
    async ({ url }) =>
      runLocalAudit({
        url,
        coverageMode: "quick",
        maxPages: coverageMaxPages("quick"),
        cloudAvailable: false,
        offline: true,
      })
  );
}
