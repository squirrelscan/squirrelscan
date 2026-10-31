// An unreachable start URL (squirrelscan/squirrelscan#1269): DNS failure,
// connect timeout, connection reset or refused, a TLS error. The run ends with
// a report that says so, in the format asked for, instead of nothing on stdout
// and a line on stderr, so a batch caller can tell "the site is down" from "the
// CLI crashed" without scraping text.

import {
  classifyAuditFailureReasonText,
  type AuditFailureReasonCode,
} from "@squirrelscan/core-contracts/failure-reason";
import {
  redactUrl,
  redactUrlsInText,
} from "@squirrelscan/core-contracts/seed-redirect";
import { tlsCertificateRule } from "@squirrelscan/rules/security/tls-certificate";
import { writeFileSync } from "node:fs";

/**
 * What an unreachable start URL says about the rule that could have judged it (#1259): a TLS failure on
 * the start URL is `security/tls-certificate` failing with the cause, in the shape a report lists issues.
 */
export interface UnreachableIssue {
  ruleId: string;
  name: string;
  description: string;
  solution: string;
  category: string;
  group: string;
  severity: string;
  checks: Array<{
    name: string;
    status: "fail";
    message: string;
    affectedPages: string[];
    affectedPagesCount: number;
    affectedPagesHasMore: boolean;
    legacyValue: string;
  }>;
}

export interface UnreachableOutcome {
  status: "unreachable";
  /** The start URL, without credentials, query or fragment. */
  url: string;
  /** What kind of failure: `dns`, `tls`, `connection`, `timeout`, or `unknown`. */
  statusReasonCode: AuditFailureReasonCode;
  /** The underlying error text from the reachability probe. */
  statusReason: string;
  message: string;
  /** For a TLS failure: the certificate rule's failure with its cause. Absent for every other cause. */
  issues?: UnreachableIssue[];
}

/** `reason` without trailing spaces and sentence punctuation, so a message can end it with its own full stop. */
function trimTrailingPunctuation(reason: string): string {
  let end = reason.length;
  while (end > 0 && " \t\r\n.?!:;,".includes(reason[end - 1]!)) end--;
  return reason.slice(0, end);
}

/**
 * The runtime's raw TLS error in words an owner can act on. The cause probe's own sentences ("certificate has
 * expired on 2026-01-01", "hostname/IP does not match: ...") pass through; the fetch's error codes are translated.
 */
/** A reason that names a certificate problem: the probe's sentences and the runtime's own error names for one. */
const CERTIFICATE_PROBLEM =
  /certificate has expired|not valid until|does not cover|hostname\/ip does not match|self.signed|unable to verify the first certificate|issuer certificate|untrusted root|trusted root|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED/i;

export function recognisedCertificateProblem(reason: string): boolean {
  return CERTIFICATE_PROBLEM.test(reason);
}

function tlsCauseText(reason: string): string {
  const text = trimTrailingPunctuation(reason);
  if (/ERR_TLS_CERT_ALTNAME_INVALID/i.test(text))
    return "the certificate does not cover the hostname";
  if (
    /unable to get (local )?issuer certificate|unable to verify the first certificate/i.test(
      text
    )
  ) {
    return "the certificate chain does not verify to a trusted root (an intermediate may be missing, or the root is not trusted)";
  }
  // Drop the runtime's trailing "For more information, pass `verbose: true` ..." and any echoed URL.
  return text.replace(/\s*fetching ".*$/i, "");
}

/** `security/tls-certificate` failing on the start URL, with the cause the TLS probe found. */
function tlsStartUrlIssue(url: string, reason: string): UnreachableIssue {
  const meta = tlsCertificateRule.meta;
  const cause = tlsCauseText(reason);
  return {
    ruleId: meta.id,
    name: meta.name,
    description: meta.description,
    solution: meta.solution ?? "",
    category: "Security",
    group: meta.category,
    severity: meta.severity,
    checks: [
      {
        name: "tls-certificate",
        status: "fail",
        message: `The start URL's TLS certificate cannot be trusted: ${cause}`,
        affectedPages: [url],
        affectedPagesCount: 1,
        affectedPagesHasMore: false,
        legacyValue: cause,
      },
    ],
  };
}

/** The outcome for a start URL the reachability probe could not reach. */
export function unreachableOutcome(
  url: string,
  rawReason: string,
  options: { tlsFinding?: boolean } = {}
): UnreachableOutcome {
  const safeUrl = redactUrl(url);
  // The probe's error text can echo the start URL (userinfo, a query token): redact it here too.
  const reason = redactUrlsInText(rawReason);
  const statusReasonCode = classifyAuditFailureReasonText(
    `Cannot reach ${safeUrl}: ${reason}`
  );
  return {
    status: "unreachable",
    url: safeUrl,
    statusReasonCode,
    statusReason: reason,
    message: `Cannot reach ${safeUrl}: ${trimTrailingPunctuation(reason)}. No audit ran and there is no score.`,
    // A finding only for a certificate problem the cause names, and only when the rule is selected:
    // a plain-HTTP port or a protocol the runtime refuses is a TLS failure, not a certificate one.
    ...(statusReasonCode === "tls" &&
    options.tlsFinding !== false &&
    recognisedCertificateProblem(reason)
      ? { issues: [tlsStartUrlIssue(safeUrl, reason)] }
      : {}),
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
      ...(outcome.issues ?? []).flatMap((issue) =>
        issue.checks.map(
          (check) =>
            `  <finding rule="${escapeXml(issue.ruleId)}" status="${check.status}">${escapeXml(check.message)}</finding>`
        )
      ),
      "</audit>",
    ].join("\n");
  }
  return [
    `Not audited: ${outcome.url} is unreachable`,
    `Reason: ${outcome.statusReason} (${outcome.statusReasonCode})`,
    ...(outcome.issues ?? []).flatMap((issue) =>
      issue.checks.map(
        (check) => `${issue.ruleId}: ${check.status}: ${check.message}`
      )
    ),
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
