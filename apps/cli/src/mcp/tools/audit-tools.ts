// Local deterministic audit tools. Signed out they run on this machine with no
// cloud call; signed in, audit_website is a billed cloud audit like `squirrel
// audit` (#628, see billed-audit.ts). quick_check is always local.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";

import { resolveProbeIntensity } from "@squirrelscan/config";
import {
  AUDIT_LEVEL_PRESETS,
  type AuditLevel,
  DEFAULT_AUDIT_LEVEL,
  type ResolvedAuditSettings,
} from "@squirrelscan/core-contracts/audit-levels";
import { renderLlm } from "@squirrelscan/report";
import {
  isValidHeaderName,
  isValidHeaderValue,
} from "@squirrelscan/utils/headers";
import { z } from "zod";

import type { Config } from "@/config";
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
import {
  billedAuditSummary,
  finalizeMcpRun,
  planMcpAudit,
  startMcpRunHeartbeat,
} from "../billed-audit";
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
 * A render setting in the config is applied as the fetch mode, so a
 * configured one is what runs. Otherwise the fetch mode is left to the caller:
 * a local run fetches over plain HTTP, and a billed one (billed-audit.ts)
 * renders in the cloud browser the way `squirrel audit` does.
 */
export async function levelRunOptions(
  level: AuditLevel,
  maxPages?: number,
  loaded?: Config
): Promise<
  Pick<
    RunAuditOptions,
    "externalLinksEnabled" | "probe" | "renderStrategy" | "cloudRendering"
  > & {
    coverageMode: AuditLevel;
    maxPages: number;
    auditLevel: ResolvedAuditSettings;
  }
> {
  const config =
    loaded ?? (await loadConfig(localConfigPath(), { silent: true }));
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

/** A result with a line in front of it: why the audit ran the way it did. */
function withLeadingText(result: CallToolResult, text: string): CallToolResult {
  return { ...result, content: [{ type: "text", text }, ...result.content] };
}

/**
 * Run `audit_website` for one call: locally (signed out, offline, a host the
 * cloud cannot reach), or as a billed cloud audit, registered before the crawl
 * and closed out with its audited pages after it.
 */
async function runWebsiteAudit(input: {
  url: string;
  level: AuditLevel;
  maxPages?: number;
  offline?: boolean;
  confirm?: boolean;
  headers?: Record<string, string>;
}): Promise<CallToolResult> {
  const config = await loadConfig(localConfigPath(), { silent: true });
  const levelOptions = await levelRunOptions(
    input.level,
    input.maxPages,
    config
  );
  const extra = {
    url: input.url,
    offline: input.offline,
    ...(input.headers && Object.keys(input.headers).length > 0
      ? { headers: input.headers }
      : {}),
  };
  const plan = await planMcpAudit({
    url: input.url,
    offline: input.offline,
    confirm: input.confirm,
    config,
    level: {
      coverageMode: levelOptions.coverageMode,
      maxPages: levelOptions.maxPages,
      auditLevel: levelOptions.auditLevel,
      render: resolveExplicitRenderMode({}, config),
    },
  });
  if (plan.kind === "stop") return plan.result;
  if (plan.kind === "local") {
    const result = await runLocalAudit({
      ...levelOptions,
      ...extra,
      cloudAvailable: false,
    });
    return plan.note ? withLeadingText(result, plan.note) : result;
  }

  const { billed } = plan;
  let pagesFetched = 0;
  const stopHeartbeat = startMcpRunHeartbeat(billed.run, () => ({
    pagesFetched,
    pagesTotal: billed.maxPages,
    pagesFailed: 0,
  }));
  let result: Result<AuditReport>;
  try {
    result = await runAudit({
      ...levelOptions,
      ...extra,
      ...billed.options,
      configPath: localConfigPath(),
      onProgress: (p) => {
        if (p.phase === "crawling" && p.current !== undefined) {
          pagesFetched = p.current;
        }
      },
    });
  } catch (error) {
    stopHeartbeat();
    await finalizeMcpRun(billed.run, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  stopHeartbeat();
  if (!result.ok) {
    await finalizeMcpRun(billed.run, { error: result.error.message });
    return renderAuditResult(result);
  }
  const report = result.data;
  // The same stamps `squirrel audit` puts on a signed-in report, so the
  // locked-checks section speaks to an account, not to a signed-out run.
  report.cloudPlan = billed.accountPlan;
  report.cloudMode = billed.options.cloudRendering;
  report.coverageMode = levelOptions.coverageMode;
  await finalizeMcpRun(billed.run, { report });
  return withLeadingText(
    renderAuditResult(result),
    billedAuditSummary(billed, report)
  );
}

const LEVEL_DESCRIPTION = `Audit level: ${levelHelpList()}. Default ${DEFAULT_AUDIT_LEVEL}`;

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "audit_website",
    {
      title: "Audit a website",
      description:
        "Run a deterministic website audit (performance, security, accessibility, content, structured data, and more) of a URL and return an LLM-optimized report. Signed out it runs on this machine with no cloud call. Signed in it is a billed cloud audit, the same as `squirrel audit`: 50 credits plus 2 per audited page at every level, with pages that need JavaScript rendered in the cloud browser and, at surface and full, the cloud checks. The first call returns the estimate as status confirmation_required; show it to the user and call again with confirm: true to start. An audit the balance cannot cover is refused with the cost and the balance. Pass offline: true for a local-only audit with no cloud call.",
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
          .describe(
            "Run locally with no cloud call: not billed, no cloud checks, no cloud rendering"
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Approve the credit spend of a signed-in audit. Without it, an estimate over [cloud] confirm_threshold comes back as confirmation_required instead of starting"
          ),
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
    async ({ url, level, coverage, maxPages, offline, confirm, headers }) => {
      if (level !== undefined && coverage !== undefined && level !== coverage) {
        return errorResult(
          `level ${level} and coverage ${coverage} name different levels. Pass one (coverage is the old name for level).`
        );
      }
      const auditLevel =
        parseAuditLevel(level ?? coverage ?? DEFAULT_AUDIT_LEVEL) ??
        DEFAULT_AUDIT_LEVEL;
      return runWebsiteAudit({
        url,
        level: auditLevel,
        maxPages,
        offline,
        confirm,
        headers,
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
