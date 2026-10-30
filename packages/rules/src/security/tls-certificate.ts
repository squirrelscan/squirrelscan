// security/tls-certificate - TLS certificate expiry, hostname, chain and key checks (#712)
//
// One TLS handshake per audited host, plus one for its www/apex variant when
// that name answers on the same port. The rule opens no socket itself: the
// handshake is `ctx.tlsProbe`, injected by a runtime that has TLS sockets and
// vets every address before it connects (the CLI). Without one the rule says
// "not checked". The facts and their meaning are @squirrelscan/utils/tls-certificate.

import {
  certificateProblems,
  daysUntil,
  isoDate,
  untrustedRootText,
  type TlsCertificate,
  type TlsProbeFn,
  type TlsProblem,
  type TlsProbe,
} from "@squirrelscan/utils/tls-certificate";
import { getDomain } from "tldts";
import { z } from "zod";

import { TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z
  .object({
    warn_days: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Warn when the certificate expires within this many days. Unset (the default): relative to the certificate's lifetime, see warnDaysFor",
      ),
    error_days: z
      .number()
      .int()
      .min(0)
      .default(7)
      .describe("Error when the certificate expires within this many days"),
  })
  // Otherwise the warning band is empty and every near expiry reads as an error.
  .refine((options) => options.warn_days === undefined || options.error_days <= options.warn_days, {
    message: "error_days must not be more than warn_days",
    path: ["error_days"],
  });

export type TlsCertificateOptions = z.infer<typeof optionsSchema>;

/**
 * Days before a certificate's end at which an auto-renewing CA has renewed it
 * (#1279): ACME clients renew at about a third of the lifetime left (30 days of
 * a 90-day Let's Encrypt certificate), and the managed certificates on
 * Cloudflare, Google and Vercel do the same. A fixed 30-day warning therefore
 * fired on healthy certificates for a day or so before every routine renewal.
 * The default warning waits until a renewal is this many days overdue.
 */
export const RENEWAL_MARGIN_DAYS = 14;

/** The warning window used when a certificate's lifetime cannot be read. */
const FALLBACK_WARN_DAYS = 30;

/**
 * The remaining days at or below which the expiry check warns. An explicit
 * `warn_days` always wins. Otherwise it is the last third of the certificate's
 * lifetime (`notAfter - notBefore`) less {@link RENEWAL_MARGIN_DAYS}, never
 * below `error_days`: 16 days for a 90-day certificate, 52 for a 200-day one.
 * As lifetimes shrink (47 days by 2029) the window shrinks with them instead of
 * flagging every valid certificate.
 */
export function warnDaysFor(certificate: TlsCertificate, options: TlsCertificateOptions): number {
  if (options.warn_days !== undefined) return options.warn_days;
  const lifetimeDays = (certificate.validTo.getTime() - certificate.validFrom.getTime()) / DAY_MS;
  if (!Number.isFinite(lifetimeDays) || lifetimeDays <= 0) {
    return Math.max(options.error_days, FALLBACK_WARN_DAYS);
  }
  return Math.max(options.error_days, Math.floor(lifetimeDays / 3 - RENEWAL_MARGIN_DAYS));
}

const DAY_MS = 86_400_000;


export type { TlsProbeFn };

export interface TlsCertificateDeps {
  probe: TlsProbeFn;
  now: Date;
}

const RSA_MIN_BITS = 2048;

export const tlsCertificateRule: Rule = {
  meta: {
    id: "security/tls-certificate",
    name: "TLS Certificate",
    description:
      "Checks the TLS certificate for expiry, hostname coverage, a complete chain and key strength",
    solution:
      "A certificate that has expired, does not cover the hostname, is self-signed, is missing its intermediate or uses a short RSA key makes browsers show a full-page warning. Renew the certificate before it expires (automate renewal and alert on failure), issue it for every hostname the site answers on, including www, and serve the full chain with the leaf certificate. Use an RSA key of at least 2048 bits or an ECDSA key. Never deploy a staging or self-signed certificate to production.",
    category: "security",
    scope: "site",
    severity: "error",
    weight: 6,
    // A dev server or private-network host is not the delivery edge (pub#629).
    skipOnPrivateTarget: true,
    optionsSchema,
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const options = optionsSchema.parse(ctx.options);
    const probe: TlsProbeFn =
      ctx.tlsProbe ??
      (async () => ({
        kind: "unavailable",
        reason: "this environment does not open TLS connections for the audit",
      }));
    return checkTlsCertificate(ctx.site?.baseUrl ?? ctx.page.url, options, {
      probe,
      now: new Date(),
    });
  },
};

/**
 * The rule's verdict for `siteUrl`. Exported so the tests can drive it with a
 * probe that points at local fixture servers.
 */
export async function checkTlsCertificate(
  siteUrl: string,
  options: TlsCertificateOptions,
  deps: TlsCertificateDeps,
): Promise<RuleResult> {
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    return { checks: [] };
  }
  if (url.protocol !== "https:") {
    return {
      checks: [
        {
          name: "tls-certificate",
          status: "skipped",
          message: "Not applicable: site not served over HTTPS (security/https covers it)",
          skipReason: "not-https",
        },
      ],
    };
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port ? Number(url.port) : 443;
  const variant = wwwVariant(hostname);
  // Both handshakes at once, so the worst case is one probe deadline, not two.
  const [probe, other] = await Promise.all([
    deps.probe({ hostname, port }),
    variant ? deps.probe({ hostname: variant, port }) : undefined,
  ]);

  if (probe.kind !== "certificate") {
    return { checks: [notChecked(hostname, probe)] };
  }

  const checks: CheckResult[] = [expiryCheck(probe.certificate, options, deps.now)];
  for (const problem of certificateProblems(probe, hostname, deps.now)) {
    if (problem.kind === "expired" || problem.kind === "not-yet-valid") continue;
    checks.push(problemCheck(problem, hostname, probe.certificate));
  }
  if (probe.certificate.rsaBits !== undefined && probe.certificate.rsaBits < RSA_MIN_BITS) {
    checks.push({
      name: "tls-certificate-key",
      status: "warn",
      message: `RSA key is ${probe.certificate.rsaBits} bits; use at least ${RSA_MIN_BITS}`,
      value: `${probe.certificate.rsaBits} bits`,
      expected: `${RSA_MIN_BITS} bits or more, or an ECDSA key`,
    });
  }

  // A counterpart that does not resolve, does not answer, or was not contacted
  // (refused by the egress check, or --offline) reports nothing on purpose:
  // plenty of sites have no www name, and that is not a certificate problem.
  if (variant && other) {
    if (other.kind === "certificate") {
      // The first problem is enough for a warning about the counterpart; the
      // audited host's own checks carry the detail.
      const [problem] = certificateProblems(other, variant, deps.now);
      if (problem) {
        checks.push({
          name: "tls-certificate-www",
          status: "warn",
          message: `${variant} answers on ${port}, but its certificate is not valid for that name: ${describeProblem(problem, variant, other.certificate)}`,
          value: variant,
          expected: `a certificate that covers ${variant}`,
        });
      }
    }
  }

  return { checks };
}

function expiryCheck(
  certificate: TlsCertificate,
  options: TlsCertificateOptions,
  now: Date,
): CheckResult {
  const expires = isoDate(certificate.validTo);
  const days = daysUntil(certificate.validTo, now);
  const details = {
    issuer: certificate.issuer,
    expires: certificate.validTo.toISOString(),
    daysRemaining: days,
  };
  const name = "tls-certificate-expiry";

  if (certificate.validTo.getTime() <= now.getTime()) {
    return {
      name,
      status: "fail",
      // Whole days since expiry, rounded down like the days remaining: two hours
      // ago is "less than a day ago", not "1 day ago".
      message: `Certificate expired on ${expires} (${dayText(daysUntil(now, certificate.validTo))} ago)`,
      value: expires,
      expected: `valid for more than ${options.error_days} days`,
      details,
    };
  }
  if (certificate.validFrom.getTime() > now.getTime()) {
    return {
      name,
      status: "fail",
      message: `Certificate is not valid until ${isoDate(certificate.validFrom)}`,
      value: isoDate(certificate.validFrom),
      expected: "a certificate already in its validity period",
      details,
    };
  }
  if (days <= options.error_days) {
    return {
      name,
      status: "fail",
      message: `Certificate expires in ${dayText(days)} (${expires}), within the ${options.error_days}-day error threshold`,
      value: expires,
      expected: `valid for more than ${options.error_days} days`,
      details,
    };
  }
  const warnDays = warnDaysFor(certificate, options);
  if (days <= warnDays) {
    return {
      name,
      status: "warn",
      message: `Certificate expires in ${dayText(days)} (${expires}), within the ${warnDays}-day warning threshold`,
      value: expires,
      expected: `valid for more than ${warnDays} days`,
      details: { ...details, warnDays, warnDaysSource: options.warn_days === undefined ? "lifetime" : "option" },
    };
  }
  return {
    name,
    status: "pass",
    message: `Certificate valid until ${expires}, ${dayText(days)} remaining, issued by ${certificate.issuer}`,
    value: expires,
    details,
  };
}

function problemCheck(
  problem: TlsProblem,
  hostname: string,
  certificate: TlsCertificate,
): CheckResult {
  const message = describeProblem(problem, hostname, certificate);
  if (problem.kind === "hostname") {
    return {
      name: "tls-certificate-hostname",
      status: "fail",
      message,
      value: hostname,
      expected: `a certificate that covers ${hostname}`,
      details: { covers: certificate.names.slice(0, DETAIL_NAMES) },
    };
  }
  return {
    name: "tls-certificate-chain",
    status: "fail",
    message,
    value: problem.kind,
    expected: "a certificate that chains to a trusted root through the served intermediates",
  };
}

/** One sentence naming the problem, shared by the audited host and the www variant. */
function describeProblem(
  problem: TlsProblem,
  hostname: string,
  certificate: TlsCertificate,
): string {
  switch (problem.kind) {
    case "expired":
      return `certificate expired on ${isoDate(problem.validTo)}`;
    case "not-yet-valid":
      return `certificate is not valid until ${isoDate(problem.validFrom)}`;
    case "hostname":
      return `the certificate does not cover ${hostname}; it covers ${coveredNames(certificate.names)}`;
    case "self-signed":
      return "the certificate is self-signed";
    case "incomplete-chain":
      return "incomplete chain: the server does not send the intermediate certificate needed to reach a trusted root";
    case "untrusted-root":
      return untrustedRootText(problem.code);
  }
}

function notChecked(hostname: string, probe: Exclude<TlsProbe, { kind: "certificate" }>): CheckResult {
  // Skipped, not info (#1259): a skipped check carrying a not-checked reason is
  // what every report lists under "Not checked", and the JSON `notChecked` too.
  // The value stays `not-checked` for readers of the check itself.
  const skipped = (message: string): CheckResult => ({
    name: "tls-certificate",
    status: "skipped",
    message,
    value: "not-checked",
    skipReason: TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON,
  });
  if (probe.kind === "unavailable") {
    return skipped(`TLS certificate not checked: ${probe.reason}`);
  }
  if (probe.code === "EGRESS_REFUSED" || probe.code.startsWith("PROXY_")) {
    // The probe wrote the reason: a refused address, or a proxy that refused or failed the tunnel (#1259).
    return skipped(`TLS certificate not checked: ${probe.message}`);
  }
  // `(${code})` would read as a count to the message merge (#2244).
  return skipped(
    `TLS certificate not checked: no TLS handshake with ${hostname}, error ${probe.code}`,
  );
}

/**
 * The www/apex counterpart of a hostname, from its registrable domain only:
 * `www.example.com` for `example.com` and the reverse. Undefined for any other
 * subdomain (`blog.example.com` has no counterpart here, and `www.blog.example.com`
 * is not derived), for an IP, and for a name with no registrable domain
 * (`localhost`, a bare public suffix). Private suffixes count as registrable
 * (`acme.pages.dev`), so another tenant's name is never derived.
 */
export function wwwVariant(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return undefined;
  const registrable = getDomain(host, { allowPrivateDomains: true });
  if (!registrable) return undefined;
  if (host === registrable) return `www.${registrable}`;
  if (host === `www.${registrable}`) return registrable;
  return undefined;
}

/** SAN names listed in a message; the rest are counted. A shared certificate can carry hundreds. */
const MESSAGE_NAMES = 10;
/** SAN names kept in a check's details. */
const DETAIL_NAMES = 50;

function coveredNames(names: readonly string[]): string {
  if (names.length === 0) return "no names";
  const shown = names.slice(0, MESSAGE_NAMES).join(", ");
  return names.length > MESSAGE_NAMES ? `${shown} and ${names.length - MESSAGE_NAMES} more` : shown;
}

function dayText(days: number): string {
  if (days < 1) return "less than a day";
  return days === 1 ? "1 day" : `${days} days`;
}
