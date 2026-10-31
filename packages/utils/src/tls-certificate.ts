// TLS certificate facts for one host, read from one handshake (#712).
//
// The facts and what they mean live here, so the `security/tls-certificate`
// rule and the crawl's TLS failure message share one definition. The handshake
// itself does NOT: this package has no socket code. A runtime that can open a
// TLS socket injects a `TlsProbeFn` (the CLI does, in apps/cli/src/audit/
// tls-probe.ts, behind the egress guard); everywhere else there is no probe and
// the rule says "not checked".
//
// Runtime limits of the CLI's probe, checked against Bun 1.4:
// - `getPeerCertificate()` returns the leaf only, so the chain cannot be walked.
//   A missing intermediate shows up as the first authorization error,
//   UNABLE_TO_VERIFY_LEAF_SIGNATURE, and that is what it is read from.
// - `minVersion` / `maxVersion` are ignored, so the probe cannot ask a server for an old protocol: it
//   reports the version the server chose when offered the runtime's best, and a server that also
//   speaks TLS 1.0 shows as TLS 1.3. The runtime's client also refuses below TLS 1.2, so a server that
//   only speaks TLS 1.0 or 1.1 ends the handshake (`not checked`) and never reaches a protocol check.
//   Ed25519, Ed448, DSA, RSA-PSS, P-521 and secp256k1 leaves also fail the runtime's handshake, so the
//   key facts for them are read only when a runtime can handshake with them (#1259).

const DAY_MS = 86_400_000;

export interface TlsTarget {
  /** Hostname used for SNI and certificate verification. */
  hostname: string;
  /** Defaults to 443. */
  port?: number;
  /** Most the handshake may take, in ms. The probe's own default applies when unset. */
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
  /** The leaf's public key type, when the runtime could read it. */
  keyType?: TlsKeyType;
  /** Key size in bits: the RSA or DSA modulus, or the size of an elliptic curve. Undefined for Ed25519 or when unread. */
  keyBits?: number;
  /** An elliptic curve's name (`P-256`). */
  curve?: string;
  /** The leaf's signature algorithm as the runtime names it (`sha256WithRSAEncryption`, `ecdsa-with-SHA256`). */
  signatureAlgorithm?: string;
}

/** Public key types the rule can name. */
export type TlsKeyType = "rsa" | "ecdsa" | "ed25519" | "dsa" | "other";

/** What the CLI's probe reads off the leaf beyond `getPeerCertificate()` (key and signature, from the DER). */
export interface TlsCertificateExtras {
  keyType?: string;
  keyBits?: number;
  curve?: string;
  signatureAlgorithm?: string;
}

export type TlsProbe =
  /** No handshake was attempted: no probe in this runtime, or the egress policy cannot vet the host here. */
  | { kind: "unavailable"; reason: string }
  /** No certificate was seen: DNS, refused, reset, timeout, a failed handshake, or an address the egress guard refused. */
  | { kind: "unreachable"; code: string; message: string }
  /** A certificate was served. `trusted` is the runtime's verdict against the trust store. */
  | {
      kind: "certificate";
      certificate: TlsCertificate;
      trusted: boolean;
      /** The runtime's authorization error code, when the chain did not verify. */
      trustError?: string;
      /** The protocol the server chose (`TLSv1.3`), when the runtime reported it. */
      protocol?: string;
    };

/**
 * Opens one TLS handshake to a host and reports what it saw. Never throws:
 * every failure is a `TlsProbe` result. Injected by a runtime that has TLS
 * sockets and an egress guard for them (the CLI); absent elsewhere.
 */
export type TlsProbeFn = (target: TlsTarget) => Promise<TlsProbe>;

/** A problem with a served certificate, in the order the rule and the crawl report them. */
export type TlsProblem =
  | { kind: "expired"; validTo: Date }
  | { kind: "not-yet-valid"; validFrom: Date }
  | { kind: "hostname"; hostname: string; names: string[] }
  | { kind: "self-signed" }
  | { kind: "incomplete-chain" }
  | { kind: "untrusted-root"; code: string };

/** The fields of a Node/Bun `getPeerCertificate()` result that are read. */
export interface RawPeerCertificate {
  subjectaltname?: string;
  issuer?: { O?: string; CN?: string };
  valid_from?: string;
  valid_to?: string;
  modulus?: string;
  bits?: number;
  asn1Curve?: string;
  nistCurve?: string;
}

/** SAN entries kept from one certificate; a shared certificate can carry hundreds, never thousands. */
const MAX_NAMES = 1000;
/** The longest DNS name (RFC 1035). */
const MAX_NAME_LENGTH = 253;
const MAX_ISSUER_LENGTH = 200;

function certificateText(value: string, maxLength: number): string {
  // oxlint-disable-next-line no-control-regex -- stripping them is the point
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, maxLength);
}

/** A TLS `authorizationError` (an Error, a code string, or nothing) as a code. */
export function authorizationErrorCode(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  const error = value as { code?: unknown; message?: unknown };
  if (typeof error.code === "string") return error.code;
  return typeof error.message === "string" ? error.message : "UNKNOWN";
}

/** A `getPeerCertificate()` result as a `TlsCertificate`, or undefined when it holds no usable dates. */
export function readPeerCertificate(
  raw: RawPeerCertificate | undefined,
  extras?: TlsCertificateExtras,
): TlsCertificate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const validFrom = new Date(raw.valid_from ?? "");
  const validTo = new Date(raw.valid_to ?? "");
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) return undefined;

  // The server chooses every string here, and they reach messages and reports:
  // control characters go, and lengths and the name count are bounded.
  const names = (raw.subjectaltname ?? "")
    .split(",")
    .flatMap((entry) => {
      // trim() and a plain prefix match: no backtracking on a long run of whitespace.
      const match = /^(?:DNS|IP Address):(.+)$/.exec(entry.trim());
      return match ? [certificateText(match[1]!, MAX_NAME_LENGTH).toLowerCase()] : [];
    })
    .filter((name) => name !== "")
    .slice(0, MAX_NAMES);

  return {
    names,
    issuer: certificateText(raw.issuer?.O ?? raw.issuer?.CN ?? "", MAX_ISSUER_LENGTH) || "unknown issuer",
    validFrom,
    validTo,
    ...(raw.modulus !== undefined && typeof raw.bits === "number" ? { rsaBits: raw.bits } : {}),
    ...keyFacts(raw, extras),
  };
}

const KEY_TYPES = new Set<string>(["rsa", "ecdsa", "ed25519", "dsa", "other"]);

/** The runtime's key type names (`rsa`, `ec`, `ed25519`, `dsa`) as ours. */
function keyTypeOf(name: string): TlsKeyType {
  const type = name.toLowerCase();
  if (type === "ec" || type === "ecdsa") return "ecdsa";
  return KEY_TYPES.has(type) ? (type as TlsKeyType) : "other";
}

/** Key type, size, curve and signature algorithm, bounded and stripped of control characters (the server picks them). */
function keyFacts(raw: RawPeerCertificate, extras: TlsCertificateExtras | undefined): Partial<TlsCertificate> {
  const out: Partial<TlsCertificate> = {};
  if (extras?.keyType) out.keyType = keyTypeOf(certificateText(extras.keyType, 20));
  else if (raw.modulus !== undefined) out.keyType = "rsa";
  else if (raw.nistCurve !== undefined || raw.asn1Curve !== undefined) out.keyType = "ecdsa";
  const bits = extras?.keyBits ?? (typeof raw.bits === "number" ? raw.bits : undefined);
  if (typeof bits === "number" && Number.isFinite(bits) && bits > 0 && out.keyType !== "ed25519") {
    out.keyBits = Math.floor(bits);
  }
  const curve = extras?.curve ?? raw.nistCurve ?? raw.asn1Curve;
  if (out.keyType === "ecdsa" && curve) out.curve = certificateText(curve, 40);
  if (extras?.signatureAlgorithm) out.signatureAlgorithm = certificateText(extras.signatureAlgorithm, 60);
  return out;
}

/**
 * Whether `names` (lowercased SAN entries) cover `hostname`. A wildcard covers
 * one label. An IPv6 address matches in any spelling: the runtime prints an IP
 * SAN expanded (`2001:DB8:0:0:0:0:0:1`) and a URL holds it compressed.
 */
export function certificateCovers(names: readonly string[], hostname: string): boolean {
  const host = canonicalName(hostname);
  return names.some((entry) => {
    const name = canonicalName(entry);
    if (name === host) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1);
    if (host.length <= suffix.length || !host.endsWith(suffix)) return false;
    return !host.slice(0, -suffix.length).includes(".");
  });
}

/**
 * A name or address in one spelling: lowercased, no root dot, no brackets, and
 * an IPv6 address in the WHATWG URL parser's compressed form.
 */
function canonicalName(value: string): string {
  const name = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!name.includes(":")) return name;
  try {
    return new URL(`http://[${name}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return name;
  }
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
  const cause = problemCause(problem, hostname);
  // A short RSA key is named beside the first problem: it is often why a chain does not verify (#1259).
  const bits = probe.certificate.rsaBits;
  return bits !== undefined && bits < 2048 ? `${cause}; the certificate's key is RSA ${bits} bits, below 2048` : cause;
}

function problemCause(problem: TlsProblem, hostname: string): string {
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
