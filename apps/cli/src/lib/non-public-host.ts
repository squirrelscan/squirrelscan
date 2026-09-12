/**
 * Local and private-network hosts versus the squirrelscan cloud (#1841).
 *
 * The CLI audits `http://localhost:3000`, RFC1918 staging boxes and internal
 * hosts on purpose: the crawl runs on the user's own machine, on their own
 * network. No HOSTED service can reach any of those, so every cloud surface
 * that fetches the address ITSELF fails on them forever: the render service,
 * the screenshot capture, a scheduled cloud audit. A hosted website row for
 * such a host is a recurring weekly failure with no way to ever succeed, which
 * is the bug this preflight exists to stop the CLI from creating.
 *
 * THE CONTRACT IS "HAND NOTHING TO A HOSTED RUNNER", so this classifier has to
 * stand on its own rather than lean on the cloud refusing later. It deliberately
 * mirrors the API's `classifyHostedEgressHost` name rules — the loopback names,
 * the cloud metadata names, the internal-only zones, and the dotless-host rule —
 * so the two sides agree on the cases a private-IP check alone cannot see:
 * `box.local`, `metadata.google.internal`, `intranet`, `localhost.`.
 *
 * INDEPENDENT OF `parseUserUrl`, also deliberately. That helper answers "is this
 * a valid audit target", and it rejects single-label and trailing-dot names —
 * so classifying through it returned "reachable" for exactly the hosts that are
 * least reachable, and the CLI registered a run with the API before the audit
 * controller rejected the URL. This only ever needs the HOST.
 *
 * MUST stay out of the shared fetch paths. See the comment block in
 * `packages/utils/src/safe-fetch.ts`: host-blocking a crawl is a functional
 * regression, not hardening. Only cloud handoffs consult this.
 */
import { isPrivateOrReservedHost } from "@squirrelscan/utils/url";

/** Loopback by name. RFC 6761 for `localhost`; the rest are conventional. */
const LOOPBACK_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
]);

/** Cloud instance-metadata services named directly rather than by address. */
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
  "nova-agent",
]);

/**
 * Zones that can only denote something inside a private network, matched at the
 * apex AND as a suffix. `local` is mDNS, `internal` / `intranet` / `lan` /
 * `home.arpa` are private-use zones, `localhost` is loopback by RFC 6761, `svc`
 * is a Kubernetes service name, `consul` / `nomad` are service-discovery zones.
 * None are publicly registrable, so refusing them cannot cost a real cloud run.
 */
const INTERNAL_NAME_ZONES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home.arpa",
  "corp",
  "private",
  "svc",
  "consul",
  "nomad",
];

/**
 * Lowercase and strip EVERY trailing root dot. Stripping only one would leave
 * `localhost..` classified as a public name while the IPv4 path already refuses
 * `127.0.0.1..`, an asymmetry with no reason to exist.
 */
function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

/**
 * Is this bare host an IP literal rather than a name?
 *
 * Two shapes are exhaustive HERE because the input has already been through the
 * WHATWG URL parser: every accepted IPv4 spelling (decimal, octal, hex, short
 * form) is canonicalized to dotted-quad, and every IPv6 form keeps its colons.
 * A DNS name can contain neither shape — the port lives in `host`, not
 * `hostname` — so this needs no resolver and no `node:net`.
 */
function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** True when no hosted runner could reach this bare hostname. */
function isNonPublicHostname(rawHost: string): boolean {
  const host = normalizeHostname(rawHost);
  if (host.length === 0) return true;

  // AN IP LITERAL IS DECIDED BY THE IP RULES ALONE, and returns here. Falling
  // through to the NAME rules below would hand every IPv6 address to the
  // dotless-host rule — `2606:4700::1111` contains no dot — and refuse to
  // publish a real IPv6-only customer site. The ranges cover loopback, RFC1918,
  // link-local incl. the metadata address, CGNAT, 0.0.0.0/8, and the IPv6
  // equivalents including the IPv4-embedding forms. The decimal, octal and hex
  // IPv4 spellings arrive here already canonicalized by the URL parser.
  if (isIpLiteral(host)) return isPrivateOrReservedHost(host);

  if (LOOPBACK_NAMES.has(host)) return true;
  if (METADATA_HOSTNAMES.has(host)) return true;
  // Both the apex (`home.arpa`) and anything under it (`router.home.arpa`).
  if (
    INTERNAL_NAME_ZONES.some(
      (zone) => host === zone || host.endsWith(`.${zone}`)
    )
  ) {
    return true;
  }
  // A dotless host resolves through the machine's own search domain in practice
  // (`db`, `intranet`, `nas`). A public TLD apex CAN carry an A record, so this
  // is a deliberate trade: no cloud audit target is a bare TLD.
  return !host.includes(".");
}

/**
 * The `host:port` of a URL no hosted runner can reach, or null when the cloud
 * can reach it.
 *
 * Takes the user's RAW input, including a bare `localhost:3000`. A schemeless
 * value gets `http://` purely so the URL parser will yield a host; the scheme
 * plays no part in the verdict and is never written back.
 *
 * Null for input that is not a usable http(s) URL: the normal URL validation
 * reports that far better than a cloud-reachability warning would, and this
 * must never be the thing that rejects a typo.
 */
export function nonPublicHostLabel(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;
  // An explicit non-http(s) scheme is someone else's error to report.
  if (trimmed.includes("://") && !/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // URL.hostname keeps an IPv6 literal bracketed; the checks want it bare.
  const bare = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!isNonPublicHostname(bare)) return null;
  // `host` (not `hostname`) so the port the user typed is in the message, and
  // as they typed it: this names the thing they pointed at, it is not an id.
  return parsed.host;
}

/**
 * Why cloud rendering is off for this run. Two lines: the reason, then what
 * still happens, so the user is not left wondering whether the audit ran.
 *
 * Rendering is the one cloud service that fetches the page URL itself, and it
 * debits on SUBMIT, so without this preflight a `--render` run against
 * localhost pays for a render the crawler-worker then refuses.
 */
export function cloudRenderSkippedLines(host: string): [string, string] {
  return [
    `No cloud runner can reach a local or private-network address (${host}).`,
    "Cloud rendering is off for this run; the audit still runs locally.",
  ];
}

/**
 * The single line a local/private-host run prints instead of a publish. Covers
 * both halves of the skip (no run registered, no report published) because to
 * the user they are one fact: this stayed on your machine.
 */
export const LOCAL_HOST_NOT_PUBLISHED_LINE =
  "Local/private host: report kept local, not published to the cloud.";

/**
 * What the CLI prints when the SERVER is the one that classified the host
 * (`websiteRegistration.skipped` with reason `non_public_host`).
 *
 * Kept even though the two classifiers now agree on every case we know of: the
 * API's is authoritative and may tighten first, and a client that answered a
 * server refusal with silence would leave the user hunting for a missing site.
 */
export const SERVER_NON_PUBLIC_HOST_LINE =
  "Local/private host: the cloud did not add this site to your dashboard.";
