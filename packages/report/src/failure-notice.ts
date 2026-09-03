// Shared, framework-agnostic copy for a failed/blocked audit (#792, #935).
// Single source of truth for both the static report's `FailureNotice`
// (output/html.tsx) and the dashboard's report-detail notice: a blocked run
// reads the same everywhere — the SITE refused our crawler, not a
// squirrelscan outage. Plain strings only (no JSX) so it renders in any
// consumer; pure so it can be unit-tested without rendering a page.

import type { AuditStatus } from "@squirrelscan/core-contracts";

export interface AuditFailureNotice {
  /** Which failure shape — drives the destructive-vs-muted framing. */
  tone: "blocked" | "failed";
  heading: string;
  /** Lead paragraph(s) before any steps. */
  body: string[];
  /** Intro line above the steps list (blocked only). */
  stepsIntro?: string;
  /** Actionable steps (blocked only). */
  steps: string[];
  /** Line introducing the local-run fallback command. */
  cliIntro: string;
  /** The command to run the audit locally, e.g. `squirrel audit example.com`. */
  cliCommand: string;
}

/**
 * Build the failure notice for a report status, or `null` for a normal
 * (completed/partial) audit that needs no notice. `target` is the site the
 * local-run hint should reference (a bare domain or URL).
 */
export function getAuditFailureNotice(
  status: AuditStatus | null | undefined,
  target: string,
  /**
   * Set when the crawl was throttled (#1829). A rate-limited block and a
   * bot-wall block look identical in `status`, but their remedies are
   * opposites — allowlisting a crawler does nothing about a throttle, and
   * slowing down does nothing about a WAF — so the notice has to say which.
   */
  rateLimited?: { pages: number; hosts: string[] },
): AuditFailureNotice | null {
  if (status !== "blocked" && status !== "failed") return null;

  const cliCommand = `squirrel audit ${target}`;

  if (status === "blocked" && rateLimited && rateLimited.pages > 0) {
    const hosts = rateLimited.hosts.length > 0 ? rateLimited.hosts.join(", ") : "the host";
    return {
      tone: "blocked",
      heading: "Your site rate limited the audit",
      body: [
        `${hosts} answered our crawler with rate limiting (429 or 430) before we could read any pages, so there was nothing to audit. This is throttling, not bot protection: allowlisting our crawler will not change it.`,
      ],
      stepsIntro: "To get a full audit, try one of these:",
      steps: [
        "Crawl the site more slowly: set `per_host_concurrency = 1` and `per_host_delay_ms = 500` under `[crawler]` in squirrel.toml.",
        "Raise `max_backoff_ms` so the crawl waits longer for the host to recover.",
        "Run the audit when the site is under less load.",
      ],
      cliIntro: "Or run it locally with those settings:",
      cliCommand,
    };
  }

  if (status === "blocked") {
    return {
      tone: "blocked",
      heading: "Your site blocked the audit",
      body: [
        "Your site refused our crawler before we could read any pages. Bot protection, a firewall rule, an auth wall, or rate limiting returned a 403 or 429, so there was nothing to audit. This is a block on your side, not a squirrelscan outage.",
      ],
      stepsIntro: "To get a full audit, try one of these:",
      steps: [
        "Allowlist the squirrelscan crawler in your WAF or bot protection.",
        "Turn off bot fight mode (or the blocking rule) for the audit.",
      ],
      cliIntro: "Or run the audit from a trusted network:",
      cliCommand,
    };
  }

  return {
    tone: "failed",
    heading: "We couldn't audit your site",
    body: [
      "We couldn't fetch any pages from your site, so there was nothing to audit. The site may have been down, unreachable, or timing out when we tried.",
      "Check that the site is reachable and try again.",
    ],
    steps: [],
    cliIntro: "Or run it locally:",
    cliCommand,
  };
}
