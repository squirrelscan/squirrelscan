// security/tls-certificate - TLS certificate expiry, hostname, chain and key checks (#712)
//
// One TLS handshake per audited host, plus one for its www/apex variant when
// that name answers on the same port. The handshake itself lives in
// @squirrelscan/utils/tls-certificate; this file decides what the facts mean.

import {
  certificateProblems,
  daysUntil,
  isoDate,
  probeTlsCertificate,
  untrustedRootText,
  type TlsCertificate,
  type TlsProblem,
  type TlsProbe,
  type TlsTarget,
} from "@squirrelscan/utils/tls-certificate";
import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  warn_days: z
    .number()
    .int()
    .min(1)
    .default(30)
    .describe("Warn when the certificate expires within this many days"),
  error_days: z
    .number()
    .int()
    .min(0)
    .default(7)
    .describe("Error when the certificate expires within this many days"),
});

export type TlsCertificateOptions = z.infer<typeof optionsSchema>;

/** Opens one handshake to a host. Injected by tests; the audit uses the real socket. */
export type TlsProbeFn = (target: TlsTarget) => Promise<TlsProbe>;

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
    return checkTlsCertificate(ctx.site?.baseUrl ?? ctx.page.url, options, {
      probe: (target) => probeTlsCertificate(target),
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
  const probe = await deps.probe({ hostname, port });

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

  const variant = wwwVariant(hostname);
  if (variant) {
    const other = await deps.probe({ hostname: variant, port });
    if (other.kind === "certificate") {
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
      message: `Certificate expired on ${expires} (${dayText(-days)} ago)`,
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
  if (days <= options.warn_days) {
    return {
      name,
      status: "warn",
      message: `Certificate expires in ${dayText(days)} (${expires}), within the ${options.warn_days}-day warning threshold`,
      value: expires,
      expected: `valid for more than ${options.warn_days} days`,
      details,
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
      details: { covers: certificate.names },
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
    case "hostname": {
      const covers = certificate.names.length > 0 ? certificate.names.join(", ") : "no names";
      return `the certificate does not cover ${hostname}; it covers ${covers}`;
    }
    case "self-signed":
      return "the certificate is self-signed";
    case "incomplete-chain":
      return "incomplete chain: the server does not send the intermediate certificate needed to reach a trusted root";
    case "untrusted-root":
      return untrustedRootText(problem.code);
  }
}

function notChecked(hostname: string, probe: Exclude<TlsProbe, { kind: "certificate" }>): CheckResult {
  if (probe.kind === "unavailable") {
    return {
      name: "tls-certificate",
      status: "info",
      message: `TLS certificate not checked: this environment has no TLS socket API (${probe.reason})`,
      value: "not-checked",
    };
  }
  return {
    name: "tls-certificate",
    status: "info",
    message: `TLS certificate not checked: no TLS handshake with ${hostname} (${probe.code})`,
    value: "not-checked",
  };
}

/** The www/apex counterpart of a DNS hostname, or undefined for an IP, localhost or a bare label. */
function wwwVariant(hostname: string): string | undefined {
  if (!hostname.includes(".") || /^[\d.:]+$/.test(hostname)) return undefined;
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local")) return undefined;
  return hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`;
}

function dayText(days: number): string {
  if (days < 1) return "less than a day";
  return days === 1 ? "1 day" : `${days} days`;
}
