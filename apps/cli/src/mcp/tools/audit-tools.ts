// Local deterministic audit tools — free, no auth; cloud enrichment when authed.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";

import { resolveProbeIntensity } from "@squirrelscan/config";
import {
  AUDIT_LEVEL_PRESETS,
  type AuditLevel,
  DEFAULT_AUDIT_LEVEL,
} from "@squirrelscan/core-contracts/audit-levels";
import { renderLlm } from "@squirrelscan/report";
import {
  isValidHeaderName,
  isValidHeaderValue,
} from "@squirrelscan/utils/headers";
import { z } from "zod";

import type { Result } from "@/controllers/types";
import type { AuditReport } from "@/types";

import {
  AUDIT_LEVELS,
  configLevelOverrides,
  levelCoverageMode,
  levelHelpList,
  parseAuditLevel,
  resolveLocalAuditLevel,
} from "@/cli/audit-level";
import { resolveExplicitRenderMode } from "@/cli/commands/audit";
import { findConfigFile, getGlobalConfigPath, loadConfig } from "@/config";
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

// Mirror the CLI: honor --config-file, else auto-discover the project's squirrel config from cwd.
function localConfigPath(): string | undefined {
  return getGlobalConfigPath() ?? findConfigFile() ?? undefined;
}

/**
 * The run options an audit level gives a local MCP audit: the level's
 * settings, with the project config's choices laid over them the same way
 * `squirrel audit` lays them (`[crawler] max_pages`, `[cloud] render`,
 * `[security] probe`, `[external_links] enabled = false`), and the caller's
 * `maxPages` over those. The report carries the result as `auditLevel`.
 *
 * Rendering stays opt-in here, as it always was: a tool call never starts
 * paid cloud renders on its own, so the level's render setting is a limit
 * the run may not reach (like a signed-out CLI run). A render setting in the
 * config is applied as the fetch mode, so a configured one is what runs.
 */
export async function levelRunOptions(
  level: AuditLevel,
  maxPages?: number
): Promise<
  Pick<
    RunAuditOptions,
    | "coverageMode"
    | "maxPages"
    | "auditLevel"
    | "externalLinksEnabled"
    | "probe"
    | "renderStrategy"
    | "cloudRendering"
  >
> {
  const config = await loadConfig(localConfigPath(), { silent: true });
  const render = resolveExplicitRenderMode({}, config);
  const configOverrides = configLevelOverrides(config);
  const pages = maxPages ?? configOverrides.pages;
  const levelProbe = AUDIT_LEVEL_PRESETS[level].probe;
  const probe = resolveProbeIntensity({
    flags: {},
    config: config.security,
    context: {
      surface: "local",
      signedIn: false,
      discoveryProbesDisabled: config.crawler.disable_discovery_probes === true,
    },
    ...(levelProbe !== "aggressive" ? { levelDefault: levelProbe } : {}),
  });
  // No flags reach this resolution, so it cannot fail; passive if it ever did.
  const probing = probe.ok
    ? { level: probe.value.level, budgetMs: probe.value.budgetMs }
    : { level: "passive" as const, budgetMs: 0 };
  const resolved = resolveLocalAuditLevel(level, {
    ...(pages !== undefined ? { pages } : {}),
    ...(render !== undefined ? { render } : {}),
    ...(configOverrides.externalLinks !== undefined
      ? { externalLinks: configOverrides.externalLinks }
      : {}),
    probe: probing.level,
  });
  const strategy = resolved.settings.render;
  return {
    coverageMode: levelCoverageMode(resolved),
    maxPages: resolved.settings.pages,
    auditLevel: resolved,
    externalLinksEnabled: resolved.settings.externalLinks,
    probe: probing,
    ...(strategy === "auto" || strategy === "all"
      ? { renderStrategy: strategy }
      : {}),
    // Only a configured render setting picks the fetch mode; unset keeps the
    // controller's default (plain HTTP unless [cloud] rendering says browser).
    ...(render === undefined
      ? {}
      : { cloudRendering: render === "off" ? "http" : "browser" }),
  };
}

// Run runAudit non-interactively and render the LLM report, or a clean MCP error.
async function runLocalAudit(options: Omit<RunAuditOptions, "configPath">) {
  const result = await runAudit({
    ...options,
    configPath: localConfigPath(),
  });
  return renderAuditResult(result);
}

const LEVEL_DESCRIPTION = `Audit level: ${levelHelpList()}. Default ${DEFAULT_AUDIT_LEVEL}`;

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "audit_website",
    {
      title: "Audit a website",
      description:
        "Run a full deterministic website audit (performance, security, accessibility, content, structured data, and more) on a URL and return an LLM-optimized report. Free + local; adds cloud enrichment automatically when logged in (charges credits per your plan). Pass offline:true to force local-only.",
      inputSchema: z.object({
        url: z.string().describe("The URL to audit (e.g. https://example.com)"),
        level: z.enum(AUDIT_LEVELS).optional().describe(LEVEL_DESCRIPTION),
        coverage: z
          .enum(AUDIT_LEVELS)
          .optional()
          .describe("Old name for level, still accepted"),
        maxPages: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Override the max pages to crawl (default: the level's page budget)"
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
      }),
    },
    async ({ url, level, coverage, maxPages, offline, headers }) => {
      if (level !== undefined && coverage !== undefined && level !== coverage) {
        return errorResult(
          `level ${level} and coverage ${coverage} name different levels. Pass one (coverage is the old name for level).`
        );
      }
      const auditLevel =
        parseAuditLevel(level ?? coverage ?? DEFAULT_AUDIT_LEVEL) ??
        DEFAULT_AUDIT_LEVEL;
      const levelOptions = await levelRunOptions(auditLevel, maxPages);
      // No cloud checks (the quick level) means no cloud at all here, as before
      // audit levels: a tool call at quick runs the local rules only.
      const cloudAvailable =
        !levelOptions.auditLevel?.settings.cloudChecks || offline
          ? false
          : await resolveCloudAvailability();
      return runLocalAudit({
        url,
        ...levelOptions,
        cloudAvailable,
        offline,
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }
  );

  server.registerTool(
    "quick_check",
    {
      title: "Quick check",
      description: `Fast, local-only audit at the quick level: the URL and its sitemaps, up to ${AUDIT_LEVEL_PRESETS.quick.pages} pages, with no link following and no cloud checks. Works offline. Use for a rapid health snapshot of a site.`,
      inputSchema: z.object({
        url: z.string().describe("The URL to check (e.g. https://example.com)"),
      }),
    },
    async ({ url }) =>
      runLocalAudit({
        url,
        ...(await levelRunOptions("quick")),
        cloudAvailable: false,
        offline: true,
      })
  );
}
