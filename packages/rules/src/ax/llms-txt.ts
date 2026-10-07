// ax/llms-txt - detect /llms.txt (+ /llms-full.txt) and validate basic format

import type { WellKnownPath, WellKnownProbe } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { refusedCheck, refusedFor } from "../refused";

import { includesPath, notCheckedCheck } from "./discovery-probe-state";

// Alt paths some sites use instead of the root — probed by the crawler's
// fixed well-known list (core-contracts WELL_KNOWN_PATHS).
const LLMS_TXT_ALT_PATHS: readonly WellKnownPath[] = ["/.well-known/llms.txt", "/docs/llms.txt"];

// The #1 false positive: an SPA serving the same index.html for every path,
// including /llms.txt — a 200 that is actually a fallback page, not real content.
function looksLikeHtmlFallback(content: string): boolean {
  const head = content.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function isRealAltHit(p: WellKnownProbe): boolean {
  // markdownLike guards against plain-text junk at the alt path (e.g. a 200
  // "Not found" body) the same way looksHtml guards against SPA fallbacks.
  return p.status === 200 && !p.looksHtml && p.markdownLike === true;
}

export interface LlmsFormat {
  hasH1: boolean;
  linkCount: number;
  invalidLinks: string[];
}

// Minimal llms.txt (llmstxt.org) shape: an H1 title + Markdown links that parse.
export function validateLlmsFormat(content: string, baseUrl: string): LlmsFormat {
  const firstNonEmpty = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  const hasH1 = /^#\s+\S/.test(firstNonEmpty.trim());

  const invalidLinks: string[] = [];
  let linkCount = 0;
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    linkCount++;
    const url = match[1]?.trim() ?? "";
    try {
      // Fallback base keeps root-relative links valid when baseUrl is empty.
      new URL(url, baseUrl || "https://example.com");
    } catch {
      invalidLinks.push(url);
    }
  }
  return { hasH1, linkCount, invalidLinks };
}

export const llmsTxtRule: Rule = {
  meta: {
    id: "ax/llms-txt",
    name: "llms.txt",
    description:
      "Detects /llms.txt (and /llms-full.txt) at the domain root and checks its basic Markdown format — an emerging standard giving AI agents a curated, machine-readable map of your site",
    solution:
      "llms.txt (llmstxt.org) is a Markdown file at your domain root that points AI agents and answer engines at your most useful, clean content. Add a /llms.txt with an H1 title, a short summary, and sections of Markdown links to key pages; optionally add /llms-full.txt with that content inlined. This is a recommendation only — it never affects your score.",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 1,
    discoveryProbes: ["llms-txt", ...LLMS_TXT_ALT_PATHS],
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const llms = ctx.site?.llmsTxt;
    const altHit = ctx.site?.wellKnown?.probes.find(
      (p) => includesPath(LLMS_TXT_ALT_PATHS, p.path) && isRealAltHit(p),
    );
    const altHitCheck = (hit: WellKnownProbe): CheckResult => ({
      name: "llms-txt-present",
      status: "info",
      message: `No /llms.txt at the root, but found one at ${hit.path}`,
      value: "present",
      details: { path: hit.path, bodySize: hit.bodySize },
    });

    if (!llms) {
      // The root got no answer, but a real file at an alternate location that
      // did answer is still a finding (#409).
      if (altHit) {
        checks.push({
          ...altHitCheck(altHit),
          message: `Found llms.txt at ${altHit.path} (/llms.txt at the root was not checked)`,
        });
      } else {
        // A refused request is not a missing file.
        const refused = refusedFor(ctx.site, "llms.txt");
        checks.push(
          refused.length > 0
            ? refusedCheck("llms-txt", "/llms.txt", refused)
            : notCheckedCheck("llms-txt", "/llms.txt", undefined, "no-result"),
        );
      }
      return { checks };
    }

    if (llms.llmsTxt.exists && looksLikeHtmlFallback(llms.llmsTxt.content ?? "")) {
      // Serving a fake llms.txt is actively misleading (agents will trust an
      // SPA index page as curated content), so this earns more than a quiet info.
      checks.push({
        name: "llms-txt-present",
        status: "fail",
        message: "/llms.txt returned 200 but the body is an HTML page (SPA fallback) — not a real llms.txt",
        value: "spa-fallback",
      });
      return { checks };
    }

    if (!llms.llmsTxt.exists) {
      if (altHit) {
        checks.push(altHitCheck(altHit));
        return { checks };
      }
      // warn-status in an info-severity rule surfaces as a Recommendation in
      // the report issues list; advisory scoring keeps it score-neutral.
      checks.push({
        name: "llms-txt-present",
        status: "warn",
        message:
          "No /llms.txt found — consider adding one so AI agents can discover your key content",
        value: "absent",
      });
      return { checks };
    }

    checks.push({
      name: "llms-txt-present",
      status: "info",
      message: `/llms.txt found (${llms.llmsTxt.sizeBytes} bytes)${
        llms.llmsFullTxt.exists ? "; /llms-full.txt also present" : ""
      }`,
      value: "present",
      details: { llmsFullTxt: llms.llmsFullTxt.exists },
    });

    const fmt = validateLlmsFormat(llms.llmsTxt.content ?? "", ctx.site?.baseUrl ?? "");
    const issues: string[] = [];
    if (!fmt.hasH1) issues.push("missing H1 title (should start with `# Name`)");
    if (fmt.linkCount === 0) issues.push("no Markdown links found");
    if (fmt.invalidLinks.length > 0)
      issues.push(`${fmt.invalidLinks.length} malformed link URL(s)`);

    // Format problems on a file the site chose to publish surface as a
    // Recommendation (warn-status); a clean file stays a quiet info note.
    checks.push({
      name: "llms-txt-format",
      status: issues.length === 0 ? "info" : "warn",
      message:
        issues.length === 0
          ? `Valid llms.txt format (${fmt.linkCount} links)`
          : `llms.txt format notes: ${issues.join("; ")}`,
      value: issues.length === 0 ? "valid" : "has-notes",
      items: fmt.invalidLinks.map((u) => ({ id: u, label: `Malformed link: ${u}` })),
      details: { hasH1: fmt.hasH1, linkCount: fmt.linkCount, invalidLinks: fmt.invalidLinks },
    });

    return { checks };
  },
};
