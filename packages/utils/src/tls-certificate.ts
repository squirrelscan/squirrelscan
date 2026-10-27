// TLS certificate facts for one host, read from one handshake (#712).
//
// This is the engine's only raw socket code. Every other request goes through
// `fetch`, which exposes no peer certificate. It lives in this one module so the
// `security/tls-certificate` rule and the crawl's TLS failure message share one
// definition of what a handshake saw.
//
// Runtime limits, checked against Bun 1.4 (the CLI is a Bun standalone binary):
// - `getPeerCertificate()` returns the leaf only, so the chain cannot be walked.
//   A missing intermediate shows up as the first authorization error,
//   UNABLE_TO_VERIFY_LEAF_SIGNATURE, and that is what we read it from.
// - `minVersion` / `maxVersion` are ignored, so protocol-version checks are out
//   of scope here (phase 2 of #712).
// - Where `node:tls` is missing, or `connect` throws, the probe reports
//   `unavailable`. Callers must say "not checked" for that, never pass or fail.

import { isIP } from "node:net";

export const TLS_PROBE_TIMEOUT_MS = 8_000;

const DAY_MS = 86_400_000;

export interface TlsTarget {
  /** Hostname used for SNI and certificate verification. */
  hostname: string;
  /** Defaults to 443. */
  port?: number;
}

export interface TlsProbeOptions {
  /** Connect to this address instead of resolving `hostname`. Tests use it; the audit does not. */
  address?: string;
  /** Extra trust anchors (PEM). Tests use it to trust a fixture root; the audit uses the system store. */
  ca?: string;
  timeoutMs?: number;
}

export interface TlsCertificate {
  /** DNS names and IP addresses from the subjectAltName extension, lowercased. Empty without a SAN: browsers ignore the CN. */
  names: string[];
  issuer: string;
  validFrom: Date;
  validTo: Date;
  /** RSA modulus length in bits. Undefined for other key types. */
  rsaBits?: number;
}

export type TlsProbe =
  /** This runtime has no TLS socket API, so nothing was checked. */
  | { kind: "unavailable"; reason: string }
  /** No certificate was seen: DNS, refused, reset, timeout or a failed handshake. */
  | { kind: "unreachable"; code: string; message: string }
  /** A certificate was served. `trusted` is the runtime's verdict against the trust store. */
  | {
      kind: "certificate";
      certificate: TlsCertificate;
      trusted: boolean;
      /** The runtime's authorization error code, when the chain did not verify. */
      trustError?: string;
    };

/** A problem with a served certificate, in the order the rule and the crawl report them. */
export type TlsProblem =
  | { kind: "expired"; validTo: Date }
  | { kind: "not-yet-valid"; validFrom: Date }
  | { kind: "hostname"; hostname: string; names: string[] }
  | { kind: "self-signed" }
  | { kind: "incomplete-chain" }
  | { kind: "untrusted-root"; code: string };

interface RawCertificate {
  subjectaltname?: string;
  issuer?: { O?: string; CN?: string };
  valid_from?: string;
  valid_to?: string;
  modulus?: string;
  bits?: number;
}

/**
 * Test-only route: send a handshake for `hostname` to a local fixture server
 * instead of resolving it. `null` makes the name not resolve. Lets an audit run
 * against a public-looking name with no DNS and no live host. Never set in
 * production code; `routeTlsHostForTests` returns the function that removes it.
 */
export interface TlsTestRoute {
  address: string;
  port: number;
  ca?: string;
}

const testRoutes = new Map<string, TlsTestRoute | null>();

export function routeTlsHostForTests(hostname: string, route: TlsTestRoute | null): () => void {
  const key = hostname.toLowerCase();
  testRoutes.set(key, route);
  return () => {
    testRoutes.delete(key);
  };
}

/**
 * Open one TLS connection to `target`, read the leaf certificate and close it.
 * Never throws: every failure is a `TlsProbe` result.
 */
export async function probeTlsCertificate(
  target: TlsTarget,
  options: TlsProbeOptions = {},
): Promise<TlsProbe> {
  const { hostname } = target;
  const routed = testRoutes.get(hostname.toLowerCase());
  if (routed === null) {
    return { kind: "unreachable", code: "ENOTFOUND", message: `${hostname} does not resolve` };
  }

  let tls: typeof import("node:tls");
  try {
    tls = await import("node:tls");
  } catch (error) {
    return { kind: "unavailable", reason: errorText(error) };
  }
  if (typeof tls.connect !== "function") {
    return { kind: "unavailable", reason: "node:tls has no connect()" };
  }

  const timeoutMs = options.timeoutMs ?? TLS_PROBE_TIMEOUT_MS;
  const port = routed?.port ?? target.port ?? 443;
  const address = routed?.address ?? options.address ?? hostname;
  const ca = routed?.ca ?? options.ca;

  return new Promise<TlsProbe>((resolve) => {
    let socket: import("node:tls").TLSSocket | undefined;
    let settled = false;
    const finish = (result: TlsProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          kind: "unreachable",
          code: "ETIMEDOUT",
          message: `no TLS handshake with ${hostname} within ${timeoutMs}ms`,
        }),
      timeoutMs,
    );

    let connection: import("node:tls").TLSSocket;
    try {
      connection = tls.connect({
        host: address,
        port,
        // SNI and verification both use the name; an IP literal has no SNI name.
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        // Verification is done here, on the facts, so every served certificate can be read.
        rejectUnauthorized: false,
        ...(ca !== undefined ? { ca } : {}),
        timeout: timeoutMs,
      });
    } catch (error) {
      finish({ kind: "unavailable", reason: errorText(error) });
      return;
    }
    const open = connection;
    socket = open;

    open.once("secureConnect", () => {
      const certificate = readCertificate(open.getPeerCertificate() as unknown as RawCertificate);
      if (!certificate) {
        finish({
          kind: "unreachable",
          code: "NO_CERTIFICATE",
          message: `${hostname} sent no certificate`,
        });
        return;
      }
      const trustError = authorizationErrorCode(open.authorizationError);
      finish({
        kind: "certificate",
        certificate,
        trusted: open.authorized === true,
        ...(trustError !== undefined ? { trustError } : {}),
      });
    });
    open.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        kind: "unreachable",
        code: error.code ?? "error",
        message: error.message,
      });
    });
  });
}

function readCertificate(raw: RawCertificate | undefined): TlsCertificate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const validFrom = new Date(raw.valid_from ?? "");
  const validTo = new Date(raw.valid_to ?? "");
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) return undefined;

  const names = (raw.subjectaltname ?? "")
    .split(",")
    .flatMap((entry) => {
      const match = /^\s*(?:DNS|IP Address):(.+?)\s*$/.exec(entry);
      return match ? [match[1]!.toLowerCase()] : [];
    });

  return {
    names,
    issuer: raw.issuer?.O ?? raw.issuer?.CN ?? "unknown issuer",
    validFrom,
    validTo,
    ...(raw.modulus !== undefined && typeof raw.bits === "number" ? { rsaBits: raw.bits } : {}),
  };
}

function authorizationErrorCode(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  const error = value as { code?: unknown; message?: unknown };
  if (typeof error.code === "string") return error.code;
  return typeof error.message === "string" ? error.message : "UNKNOWN";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether `names` (lowercased SAN entries) cover `hostname`. A wildcard covers one label. */
export function certificateCovers(names: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return names.some((name) => {
    if (name === host) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1);
    if (host.length <= suffix.length || !host.endsWith(suffix)) return false;
    return !host.slice(0, -suffix.length).includes(".");
  });
}

/**
 * Every problem the probe found with the served certificate for `hostname`,
 * highest priority first. Empty when the certificate is valid for the name.
 * Dates are judged against `now`; the chain is judged from the runtime verdict.
 */
export function certificateProblems(
  probe: Extract<TlsProbe, { kind: "certificate" }>,
  hostname: string,
  now: Date,
): TlsProblem[] {
  const { certificate } = probe;
  const problems: TlsProblem[] = [];
  if (certificate.validTo.getTime() <= now.getTime()) {
    problems.push({ kind: "expired", validTo: certificate.validTo });
  } else if (certificate.validFrom.getTime() > now.getTime()) {
    problems.push({ kind: "not-yet-valid", validFrom: certificate.validFrom });
  }
  if (!certificateCovers(certificate.names, hostname)) {
    problems.push({ kind: "hostname", hostname, names: certificate.names });
  }
  const trust = trustProblem(probe);
  if (trust) problems.push(trust);
  return problems;
}

function trustProblem(probe: Extract<TlsProbe, { kind: "certificate" }>): TlsProblem | undefined {
  if (probe.trusted) return undefined;
  switch (probe.trustError) {
    // Expiry, and a name the certificate does not cover, are reported by their
    // own checks; the runtime reports them ahead of the chain, so the chain is
    // not judged from them.
    case undefined:
    case "CERT_HAS_EXPIRED":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return undefined;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return { kind: "self-signed" };
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return { kind: "incomplete-chain" };
    default:
      return { kind: "untrusted-root", code: probe.trustError };
  }
}

/**
 * The sentence the crawl puts after "TLS handshake with <host> failed" when a
 * page fetch failed on TLS: the first problem the same handshake found, named
 * in words the failure classifier already reads as TLS. Undefined when the
 * probe found no problem, or could not look.
 */
export function tlsFailureCause(probe: TlsProbe, hostname: string, now: Date): string | undefined {
  if (probe.kind !== "certificate") return undefined;
  const [problem] = certificateProblems(probe, hostname, now);
  if (!problem) return undefined;
  switch (problem.kind) {
    case "expired":
      return `certificate has expired on ${isoDate(problem.validTo)}`;
    case "not-yet-valid":
      return `certificate is not valid until ${isoDate(problem.validFrom)}`;
    case "hostname":
      return `hostname/IP does not match: the certificate does not cover ${hostname}`;
    case "self-signed":
      return "self-signed certificate";
    case "incomplete-chain":
      return "unable to verify the first certificate: the server did not send its intermediate certificate";
    case "untrusted-root":
      return untrustedRootText(problem.code);
  }
}

/**
 * The sentence for a chain that does not verify to a trusted root. Bun reports
 * a missing intermediate as UNABLE_TO_VERIFY_LEAF_SIGNATURE, which is judged an
 * incomplete chain. UNABLE_TO_GET_ISSUER_CERT_LOCALLY is what the same runtime
 * reports for a complete chain under a root it does not trust, and a chain
 * missing its intermediate can surface under that code too. Only the served
 * chain could tell them apart, and this runtime does not expose it, so the
 * sentence names both possibilities.
 */
export function untrustedRootText(code: string): string {
  if (code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") {
    return `the chain does not verify to a trusted root: an intermediate may be missing, or the root is not trusted (${code})`;
  }
  return `the certificate chains to an untrusted root (${code})`;
}

/** Whole days from `now` until `date`, rounded down; negative once it has passed. */
export function daysUntil(date: Date, now: Date): number {
  return Math.floor((date.getTime() - now.getTime()) / DAY_MS);
}

/** The YYYY-MM-DD form of a certificate date, in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
