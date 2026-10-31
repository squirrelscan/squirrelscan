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
        "Warn when the certificate expires within this many days. Unset (the default): relative to the certificate's lifetime, see expiryWindowFor",
      ),
    error_days: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Error when the certificate expires within this many days. Unset (the default): 7 days, or a tenth of the certificate's lifetime for a short-lived one",
      ),
    key_types: z
      .array(z.enum(["rsa", "ecdsa", "ed25519", "dsa"]))
      .min(1)
      .default(["rsa", "ecdsa", "ed25519"])
      .describe("Public key types the certificate may use; any other type warns (a DSA key warns by default)"),
    rsa_min_bits: z.number().int().min(512).max(16384).default(2048).describe("Smallest RSA modulus, in bits, that does not warn"),
    ecdsa_min_bits: z.number().int().min(112).max(1024).default(256).describe("Smallest elliptic curve, in bits (the curve size: 256 for P-256), that does not warn"),
    dsa_min_bits: z.number().int().min(512).max(16384).default(2048).describe("Smallest DSA modulus, in bits, that does not warn; only meaningful when `dsa` is in key_types"),
    reject_weak_signature: z
      .boolean()
      .default(true)
      .describe("Warn when the leaf certificate is signed with SHA-1, MD5, MD4 or MD2"),
    min_tls_version: z
      .enum(["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"])
      .default("TLSv1.2")
      .describe("Warn when the handshake negotiates a lower protocol version (the probe offers the runtime's best, so this catches a server whose best is lower)"),
    check_counterpart: z
      .boolean()
      .default(true)
      .describe("Also handshake with the www or apex counterpart of the audited host; false skips that handshake"),
  })
  // Otherwise the warning band is empty and every near expiry reads as an error.
  .refine(
    (options) =>
      options.warn_days === undefined ||
      options.error_days === undefined ||
      options.error_days <= options.warn_days,
    {
      message: "error_days must not be more than warn_days",
      path: ["error_days"],
    },
  );

export type TlsCertificateOptions = z.infer<typeof optionsSchema>;

/** The error threshold for a certificate with a normal lifetime (#712). */
export const DEFAULT_ERROR_DAYS = 7;

/**
 * Days before a certificate's end at which an auto-renewing CA has renewed it
 * (#1279): ACME clients renew at about a third of the lifetime left (30 days of
 * a 90-day Let's Encrypt certificate), and the managed certificates on
 * Cloudflare, Google and Vercel do the same. A fixed 30-day warning therefore
 * fired on healthy certificates for a day or so before every routine renewal.
 * The default warning waits until a renewal is this many days overdue, capped at
 * {@link RENEWAL_MARGIN_FRACTION} of the lifetime so a short-lived certificate
 * keeps a window of its own.
 */
export const RENEWAL_MARGIN_DAYS = 14;
export const RENEWAL_MARGIN_FRACTION = 0.15;

/** The warning window used when a certificate's lifetime cannot be read. */
const FALLBACK_WARN_DAYS = 30;

/** A tenth of the lifetime, and at least this many days, bounds a default error threshold. */
const ERROR_LIFETIME_FRACTION = 0.1;
const MIN_ERROR_DAYS = 1;

export interface ExpiryWindow {
  warnDays: number;
  errorDays: number;
  /** Where each threshold came from: the option, or the certificate's lifetime. */
  warnSource: "option" | "lifetime";
  errorSource: "option" | "lifetime";
}

/**
 * The remaining days at or below which the expiry check errors and warns (#1279).
 * Explicit `warn_days` and `error_days` always win. Otherwise both follow the
 * certificate's lifetime `L` (`notAfter - notBefore`, rounded to whole days, so a
 * Let's Encrypt certificate that is 90 days less a second reads 90):
 *
 *  - warn: the last third of `L` less a renewal margin (14 days, at most 15% of
 *    `L`), never below the error threshold: 16 days for a 90-day certificate, 52
 *    for 200, 8 for 47;
 *  - error: {@link DEFAULT_ERROR_DAYS}, or a tenth of `L` (at least a day) for a
 *    certificate under 70 days, so a 6-day certificate does not fail on its third
 *    day and a 47-day one keeps a warning step before the error (4 days).
 *
 * As lifetimes shrink (47 days by 2029) the windows shrink with them instead of
 * flagging every valid certificate.
 */
export function expiryWindowFor(
  certificate: TlsCertificate,
  options: TlsCertificateOptions,
): ExpiryWindow {
  const lifetimeDays = Math.round(
    (certificate.validTo.getTime() - certificate.validFrom.getTime()) / DAY_MS,
  );
  const known = Number.isFinite(lifetimeDays) && lifetimeDays > 0;

  const derivedError = known
    ? Math.max(MIN_ERROR_DAYS, Math.min(DEFAULT_ERROR_DAYS, Math.floor(lifetimeDays * ERROR_LIFETIME_FRACTION)))
    : DEFAULT_ERROR_DAYS;
  const errorDays = options.error_days ?? derivedError;

  if (options.warn_days !== undefined) {
    return {
      warnDays: options.warn_days,
      errorDays: Math.min(errorDays, options.warn_days),
      warnSource: "option",
      errorSource: options.error_days === undefined ? "lifetime" : "option",
    };
  }
  const margin = known
    ? Math.min(RENEWAL_MARGIN_DAYS, lifetimeDays * RENEWAL_MARGIN_FRACTION)
    : RENEWAL_MARGIN_DAYS;
  const derivedWarn = known ? Math.floor(lifetimeDays / 3 - margin) : FALLBACK_WARN_DAYS;
  return {
    warnDays: Math.max(errorDays, derivedWarn),
    errorDays,
    warnSource: "lifetime",
    errorSource: options.error_days === undefined ? "lifetime" : "option",
  };
}

const DAY_MS = 86_400_000;


export type { TlsProbeFn };

export interface TlsCertificateDeps {
  probe: TlsProbeFn;
  now: Date;
}


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
  const variant = options.check_counterpart ? wwwVariant(hostname) : undefined;
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
  const key = keyCheck(probe.certificate, options);
  if (key) checks.push(key);
  const signature = signatureCheck(probe.certificate, options);
  if (signature) checks.push(signature);
  const protocol = protocolCheck(probe.protocol, options);
  if (protocol) checks.push(protocol);

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

const KEY_TYPE_NAMES = { rsa: "RSA", ecdsa: "ECDSA", ed25519: "Ed25519", dsa: "DSA", other: "an unrecognised" } as const;

/** The key as a person names it: `RSA 1024 bits`, `ECDSA P-256`, `Ed25519`, `DSA 1024 bits`. */
export function describeKey(certificate: TlsCertificate): string | undefined {
  const type = certificate.keyType ?? (certificate.rsaBits !== undefined ? "rsa" : undefined);
  if (!type) return undefined;
  switch (type) {
    case "rsa":
      return `RSA ${certificate.keyBits ?? certificate.rsaBits} bits`;
    case "dsa":
      return certificate.keyBits !== undefined ? `DSA ${certificate.keyBits} bits` : "DSA";
    case "ecdsa":
      return `ECDSA ${certificate.curve ?? (certificate.keyBits !== undefined ? `${certificate.keyBits} bits` : "")}`.trim();
    case "ed25519":
      return "Ed25519";
    default:
      return "an unrecognised key type";
  }
}

/** Warns when the key type is not allowed or its size is below the minimum for its type; nothing when it is fine. */
function keyCheck(certificate: TlsCertificate, options: TlsCertificateOptions): CheckResult | undefined {
  const type = certificate.keyType ?? (certificate.rsaBits !== undefined ? "rsa" : undefined);
  const named = describeKey(certificate);
  if (!type || !named) return undefined;
  const allowed = options.key_types;
  if (type === "other" || !allowed.includes(type)) {
    return {
      name: "tls-certificate-key",
      status: "warn",
      message: `The certificate uses ${named} key, which is not in the allowed key types (${allowed.join(", ")})`,
      value: named,
      expected: `a key of type ${allowed.join(", ")}`,
      details: { keyType: type, allowedKeyTypes: allowed },
    };
  }
  const bits = certificate.keyBits ?? certificate.rsaBits;
  const minimum =
    type === "rsa" ? options.rsa_min_bits : type === "ecdsa" ? options.ecdsa_min_bits : type === "dsa" ? options.dsa_min_bits : undefined;
  if (minimum !== undefined && bits !== undefined && bits < minimum) {
    return {
      name: "tls-certificate-key",
      status: "warn",
      message: `${named} key is below the ${minimum}-bit minimum for ${KEY_TYPE_NAMES[type]}`,
      value: named,
      expected: `${minimum} bits or more${type === "rsa" ? ", or an ECDSA key" : ""}`,
      details: { keyType: type, keyBits: bits, minimumBits: minimum },
    };
  }
  return undefined;
}

const WEAK_SIGNATURE = /(^|[^a-z0-9])(sha1|sha-1|md5|md4|md2)([^0-9]|$)/i;

/** Warns when the leaf is signed with a broken hash. The leaf only: the probe cannot read the rest of the chain. */
function signatureCheck(certificate: TlsCertificate, options: TlsCertificateOptions): CheckResult | undefined {
  const algorithm = certificate.signatureAlgorithm;
  if (!options.reject_weak_signature || !algorithm || !WEAK_SIGNATURE.test(algorithm)) return undefined;
  return {
    name: "tls-certificate-signature",
    status: "warn",
    message: `The certificate is signed with a weak algorithm (${algorithm})`,
    value: algorithm,
    expected: "a SHA-256 or stronger signature",
  };
}

const PROTOCOL_ORDER = ["SSLv3", "TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];

/** Warns when the server chose a protocol below `min_tls_version`. */
function protocolCheck(protocol: string | undefined, options: TlsCertificateOptions): CheckResult | undefined {
  if (!protocol) return undefined;
  const got = PROTOCOL_ORDER.indexOf(protocol);
  const wanted = PROTOCOL_ORDER.indexOf(options.min_tls_version);
  if (got === -1 || got >= wanted) return undefined;
  return {
    name: "tls-certificate-protocol",
    status: "warn",
    message: `The server negotiated ${protocol}, below the ${options.min_tls_version} minimum`,
    value: protocol,
    expected: `${options.min_tls_version} or newer`,
  };
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

  const expiryWindow = expiryWindowFor(certificate, options);
  if (certificate.validTo.getTime() <= now.getTime()) {
    return {
      name,
      status: "fail",
      // Whole days since expiry, rounded down like the days remaining: two hours
      // ago is "less than a day ago", not "1 day ago".
      message: `Certificate expired on ${expires} (${dayText(daysUntil(now, certificate.validTo))} ago)`,
      value: expires,
      expected: `valid for more than ${expiryWindow.errorDays} days`,
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
  const windowDetails = {
    ...details,
    warnDays: expiryWindow.warnDays,
    errorDays: expiryWindow.errorDays,
    warnDaysSource: expiryWindow.warnSource,
    errorDaysSource: expiryWindow.errorSource,
  };
  if (days <= expiryWindow.errorDays) {
    return {
      name,
      status: "fail",
      message: `Certificate expires in ${dayText(days)} (${expires}), within the ${expiryWindow.errorDays}-day error threshold`,
      value: expires,
      expected: `valid for more than ${expiryWindow.errorDays} days`,
      details: windowDetails,
    };
  }
  if (days <= expiryWindow.warnDays) {
    return {
      name,
      status: "warn",
      message: `Certificate expires in ${dayText(days)} (${expires}), within the ${expiryWindow.warnDays}-day warning threshold`,
      value: expires,
      expected: `valid for more than ${expiryWindow.warnDays} days`,
      details: windowDetails,
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
