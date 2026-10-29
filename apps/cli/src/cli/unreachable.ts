// An unreachable start URL (squirrelscan/squirrelscan#1269): DNS failure,
// connect timeout, connection reset or refused, a TLS error. The run ends with
// a report that says so, in the format asked for, instead of nothing on stdout
// and a line on stderr, so a batch caller can tell "the site is down" from "the
// CLI crashed" without scraping text.

import {
  classifyAuditFailureReasonText,
  type AuditFailureReasonCode,
} from "@squirrelscan/core-contracts/failure-reason";
import { redactUrl } from "@squirrelscan/core-contracts/seed-redirect";
import { writeFileSync } from "node:fs";

export interface UnreachableOutcome {
  status: "unreachable";
  /** The start URL, without credentials, query or fragment. */
  url: string;
  /** What kind of failure: `dns`, `tls`, `connection`, `timeout`, or `unknown`. */
  statusReasonCode: AuditFailureReasonCode;
  /** The underlying error text from the reachability probe. */
  statusReason: string;
  message: string;
}

/** The outcome for a start URL the reachability probe could not reach. */
export function unreachableOutcome(
  url: string,
  reason: string
): UnreachableOutcome {
  const safeUrl = redactUrl(url);
  return {
    status: "unreachable",
    url: safeUrl,
    statusReasonCode: classifyAuditFailureReasonText(
      `Cannot reach ${safeUrl}: ${reason}`
    ),
    statusReason: reason,
    message: `Cannot reach ${safeUrl}: ${reason}. No audit ran and there is no score.`,
  };
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderUnreachableOutcome(
  outcome: UnreachableOutcome,
  format: string | undefined
): string {
  if (format === "json") return JSON.stringify(outcome, null, 2);
  if (format === "xml" || format === "llm") {
    return [
      `<audit status="unreachable" reason-code="${outcome.statusReasonCode}">`,
      `  <url>${escapeXml(outcome.url)}</url>`,
      `  <reason>${escapeXml(outcome.statusReason)}</reason>`,
      `  <note>${escapeXml(outcome.message)}</note>`,
      "</audit>",
    ].join("\n");
  }
  return [
    `Not audited: ${outcome.url} is unreachable`,
    `Reason: ${outcome.statusReason} (${outcome.statusReasonCode})`,
    "No audit ran and there is no score.",
  ].join("\n");
}

/**
 * Write the outcome to `--output`, or stdout. Console output (no format) is
 * left to the caller's own message, which the person already sees.
 */
export function emitUnreachableOutcome(
  outcome: UnreachableOutcome,
  options: { format?: string; output?: string }
): void {
  const isConsole = !options.format || options.format === "console";
  if (isConsole && !options.output) return;
  const text = renderUnreachableOutcome(outcome, options.format);
  if (options.output) writeFileSync(options.output, `${text}\n`);
  else console.log(text);
}
