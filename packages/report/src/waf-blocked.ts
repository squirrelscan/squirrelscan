// How every renderer words pages a WAF or bot manager blocked (#1253). One
// place, so the console, text, markdown, llm, json and html outputs name the
// same provider, signal and remedies the same way. Plain strings: the caller
// escapes for its own format.
//
// The stored report is untrusted input (a cloud report may have been written
// by an older or different build), so every field is sanitised here: control
// characters stripped, the URL canonicalised, lengths capped.

import {
  WAF_BLOCK_NETWORK_REMEDY,
  WAF_BLOCK_REMEDIES,
  wafBlockHeadline,
  wafBlockedPagesNotice,
  type AuditReport,
  type WafBlockedPage,
  type WafBlockedSummary,
  type WafSuspectPage,
  type WafSuspectSummary,
} from "@squirrelscan/core-contracts";
import { stripControlChars } from "@squirrelscan/core-contracts/control-chars";

const MAX_FIELD = 80;
/** Pages a renderer lists before saying "and N more". */
const MAX_LISTED = 10;

function clean(value: string | null | undefined, fallback: string): string {
  const text = stripControlChars(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length === 0 ? fallback : text.slice(0, MAX_FIELD);
}

/** `new URL(v).href` for http(s), or a fixed placeholder: the URL is the site's choice. */
function printableUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
  return "(unprintable URL)";
}

/** A blocked page with every field made safe to print. */
export function safeBlockedPage(page: WafBlockedPage): WafBlockedPage {
  const providerId = page.providerId ? clean(page.providerId, "") : "";
  return {
    url: printableUrl(page.url),
    status: Number.isInteger(page.status) ? page.status : 0,
    provider: page.provider ? clean(page.provider, "") || null : null,
    providerId: providerId || null,
    signal: clean(page.signal, "challenge page"),
    code: /^blocked_by_[a-z0-9_]{1,40}$/.test(page.code) ? page.code : "blocked_by_waf",
  };
}

/** The sanitised summary, or null when no page was blocked. */
export function safeWafBlocked(report: Pick<AuditReport, "wafBlocked">): WafBlockedSummary | null {
  const blocked = report.wafBlocked;
  if (!blocked || blocked.total <= 0 || Number.isNaN(blocked.total)) return null;
  return {
    total: Math.floor(blocked.total),
    seed: blocked.seed ? safeBlockedPage(blocked.seed) : undefined,
    pages: (blocked.pages ?? []).slice(0, 50).map(safeBlockedPage),
    providers: (blocked.providers ?? [])
      .slice(0, 10)
      .map((p) => clean(p, ""))
      .filter(Boolean),
  };
}

/** A suspect page with every field made safe to print (#1258). */
function safeSuspectPage(page: WafSuspectPage): WafSuspectPage {
  const providerId = page.providerId ? clean(page.providerId, "") : "";
  return {
    url: printableUrl(page.url),
    status: Number.isInteger(page.status) ? page.status : 0,
    provider: page.provider ? clean(page.provider, "") || null : null,
    providerId: providerId || null,
    signal: clean(page.signal, "refusal page"),
  };
}

/** The sanitised suspect summary, or null when no page looked like a refusal (#1258). */
export function safeWafSuspect(report: Pick<AuditReport, "wafSuspect">): WafSuspectSummary | null {
  const suspect = report.wafSuspect;
  if (!suspect || suspect.total <= 0 || Number.isNaN(suspect.total)) return null;
  return {
    total: Math.floor(suspect.total),
    pages: (suspect.pages ?? []).slice(0, 50).map(safeSuspectPage),
    providers: (suspect.providers ?? [])
      .slice(0, 10)
      .map((p) => clean(p, ""))
      .filter(Boolean),
  };
}

/**
 * The warning lines for pages that look like a provider's refusal but were audited (#1258):
 * a count line, then up to ten pages. Empty when none was seen, and for a failed or
 * blocked run (whose notice says more).
 */
export function wafSuspectLines(
  report: Pick<AuditReport, "wafSuspect" | "status">,
): string[] {
  const suspect = safeWafSuspect(report);
  if (!suspect || report.status === "failed" || report.status === "blocked") return [];
  const by = suspect.providers.length > 0 ? ` from ${suspect.providers.join(", ")}` : "";
  const lines = [
    `${suspect.total} page${suspect.total === 1 ? "" : "s"} look${suspect.total === 1 ? "s" : ""} like a refusal${by} but carr${suspect.total === 1 ? "ies" : "y"} no block marker. ${suspect.total === 1 ? "It was" : "They were"} audited, so ${suspect.total === 1 ? "its findings" : "their findings"} may describe the provider's page, not the site's.`,
  ];
  for (const page of suspect.pages.slice(0, MAX_LISTED)) {
    const who = page.provider ? `${page.provider}, ` : "";
    lines.push(`${page.url}: ${who}HTTP ${page.status} (${page.signal})`);
  }
  const more = suspect.total - Math.min(suspect.pages.length, MAX_LISTED);
  if (more > 0) lines.push(`and ${more} more`);
  return lines;
}

export interface WafBlockedSeedCopy {
  /** `blocked_by_<provider>`. */
  code: string;
  headline: string;
  /** What we saw, one line. */
  saw: string;
  /** What to do, in order. */
  remedies: string[];
}

/** The copy for a run that failed because its seed page was blocked, or null. */
export function wafBlockedSeedCopy(
  report: Pick<AuditReport, "status" | "wafBlocked">,
): WafBlockedSeedCopy | null {
  if (report.status !== "blocked") return null;
  const seed = safeWafBlocked(report)?.seed;
  if (!seed) return null;
  return {
    code: seed.code,
    headline: wafBlockHeadline(seed),
    saw: `Saw: ${seed.signal}, HTTP ${seed.status}.`,
    remedies: [...WAF_BLOCK_REMEDIES, WAF_BLOCK_NETWORK_REMEDY],
  };
}

/** The remedies without the run-it-from-elsewhere line, for the HTML notice that prints its own. */
export function wafBlockedSteps(): string[] {
  return [...WAF_BLOCK_REMEDIES];
}

/**
 * The coverage lines for blocked pages that did NOT stop the audit: a count
 * line, then up to ten pages. Empty when the seed itself was blocked (the
 * failure notice says everything) or when nothing was blocked.
 */
export function wafBlockedPagesLines(
  report: Pick<AuditReport, "wafBlocked" | "totalPages" | "status">,
): string[] {
  const blocked = safeWafBlocked(report);
  if (!blocked || blocked.seed || report.status === "failed" || report.status === "blocked")
    return [];
  const lines = [wafBlockedPagesNotice(blocked, Math.max(0, report.totalPages))];
  for (const page of blocked.pages.slice(0, MAX_LISTED)) {
    const by = page.provider ? `${page.provider}, ` : "";
    lines.push(`${page.url}: ${by}HTTP ${page.status} (${page.signal})`);
  }
  const more = blocked.total - Math.min(blocked.pages.length, MAX_LISTED);
  if (more > 0) lines.push(`and ${more} more`);
  return lines;
}
