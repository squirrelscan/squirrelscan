// The TLS handshake behind `security/tls-certificate` and the crawl's TLS
// failure cause (#712). It is the only raw TLS socket an audit opens, so it
// lives here, in the one runtime that injects it: the shared packages hold the
// certificate facts and what they mean (@squirrelscan/utils/tls-certificate)
// and no socket code.
//
// Every handshake passes the egress guard first, as the crawl's own hosts do
// (squirrelscan/repo#3430): the name is resolved once, a link-local or cloud
// metadata answer is refused, and the socket connects to the address that was
// checked, never to the name, with the name as SNI. A rebinding answer cannot
// move it. The audited origin may resolve privately, because the crawl already
// requests it; any other name (the www/apex variant) must resolve to public
// addresses unless the audited site is itself on a private network.
//
// Behind an HTTP proxy from the environment the crawl goes out through the
// proxy, and a direct socket would go around it, so no handshake is made and
// the rule says "not checked".

import { isNonPublicHostname } from "@squirrelscan/utils/non-public-host";
import {
  EgressRefusedError,
  memoizeResolveHost,
  proxiedByEnvironment,
  resolveHostAddresses,
  vetEgressTarget,
  type EgressPolicy,
  type ResolveHost,
} from "@squirrelscan/utils/public-egress";
import {
  authorizationErrorCode,
  readPeerCertificate,
  type RawPeerCertificate,
  type TlsProbe,
  type TlsProbeFn,
} from "@squirrelscan/utils/tls-certificate";
import { isIP } from "node:net";
import { connect, type TLSSocket } from "node:tls";

export const TLS_PROBE_TIMEOUT_MS = 8_000;

export interface TlsProbeOptions {
  /**
   * The audited site. Its own origin (host and port) may resolve to a private
   * address; any other host must resolve public unless this site is itself
   * on a private network.
   */
  siteUrl?: string;
  /**
   * Private answers allowed for every host: the crawl's own hosts, which the
   * crawl has already requested under the same rule (repo#3430). Link-local and
   * metadata answers are refused regardless.
   */
  allowPrivateNetwork?: boolean;
  /** DNS resolution; tests inject one. Memoized per probe either way. */
  resolve?: ResolveHost;
  /** Extra trust anchors (PEM). Tests use it to trust a fixture root; the audit uses the system store. */
  ca?: string;
  /** Default handshake deadline, when the target sets none. */
  timeoutMs?: number;
  /**
   * Contact the audited site's own host only (`--offline`): any other name,
   * the www/apex counterpart included, is `unavailable` and nothing is sent.
   */
  siteHostOnly?: boolean;
}

/** Connect errors after which the next vetted address may be tried: nothing reached a server. */
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ConnectionRefused",
  "FailedToOpenSocket",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
]);

/**
 * The CLI's {@link TlsProbeFn}: one vetted, pinned handshake per call. Never
 * throws; a refused address is `unreachable` with code `EGRESS_REFUSED`, and
 * nothing is sent for it.
 */
export function createTlsProbe(options: TlsProbeOptions = {}): TlsProbeFn {
  const resolve = memoizeResolveHost(options.resolve ?? resolveHostAddresses);
  const site = siteOrigin(options.siteUrl);
  const policy: EgressPolicy = {
    allowPrivateNetwork:
      options.allowPrivateNetwork === true ||
      (site !== undefined && isNonPublicHostname(site.hostname)),
    resolve,
    pin: true,
    ...(site
      ? {
          allowPrivateTarget: (url: URL) =>
            url.hostname.replace(/^\[|\]$/g, "").toLowerCase() ===
              site.hostname && portOf(url) === site.port,
        }
      : {}),
  };

  return async (target) => {
    const hostname = target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (options.siteHostOnly && hostname.toLowerCase() !== site?.hostname) {
      return {
        kind: "unavailable",
        reason: `--offline contacts only the audited host, not ${hostname}`,
      };
    }
    if (proxiedByEnvironment()) {
      return {
        kind: "unavailable",
        reason:
          "an HTTP proxy is set in the environment, and a direct TLS connection would go around it",
      };
    }
    const port = target.port ?? 443;
    const timeoutMs =
      target.timeoutMs ?? options.timeoutMs ?? TLS_PROBE_TIMEOUT_MS;
    // One budget for the lookup and the handshakes: the lookup aborts at the
    // same deadline, and each handshake gets whatever the lookup left.
    const deadline = Date.now() + timeoutMs;

    const lookupDeadline = AbortSignal.timeout(timeoutMs);
    let addresses: string[];
    try {
      addresses = await vetAddresses(hostname, port, policy, lookupDeadline);
    } catch (error) {
      if (error instanceof EgressRefusedError) {
        return {
          kind: "unreachable",
          code: "EGRESS_REFUSED",
          message: `${hostname} was not contacted: ${error.message}`,
        };
      }
      if (lookupDeadline.aborted) {
        return {
          kind: "unreachable",
          code: "ETIMEDOUT",
          message: `${hostname} did not resolve within ${timeoutMs}ms`,
        };
      }
      const code = (error as { code?: unknown } | null)?.code;
      return {
        kind: "unreachable",
        code: typeof code === "string" ? code : "ENOTFOUND",
        message: `${hostname} does not resolve`,
      };
    }

    let result: TlsProbe | undefined;
    for (const address of addresses) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      result = await handshake({
        hostname,
        address,
        port,
        timeoutMs: remainingMs,
        ca: options.ca,
      });
      if (
        result.kind !== "unreachable" ||
        !CONNECT_FAILURE_CODES.has(result.code)
      )
        return result;
    }
    return (
      result ?? {
        kind: "unreachable",
        code: "ETIMEDOUT",
        message: `no TLS handshake with ${hostname} within ${timeoutMs}ms`,
      }
    );
  };
}

/**
 * The addresses the guard allows for `hostname`, in the order to try them. An
 * IP literal the guard allows is its own address. Throws EgressRefusedError
 * for a refused target and the resolver's error for a name that does not
 * resolve.
 */
async function vetAddresses(
  hostname: string,
  port: number,
  policy: EgressPolicy,
  signal: AbortSignal
): Promise<string[]> {
  const literal = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const target = `https://${literal}:${port}/`;
  // The URL parser decides what is vetted, so the connect uses what it parsed,
  // and a target it reads as something else (`a@b`, `x/y`, `0x7f.1`, another
  // port) is refused rather than handed to the resolver in its raw spelling.
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new EgressRefusedError("unparseable host");
  }
  if (
    parsed.hostname !== literal.toLowerCase() ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    portOf(parsed) !== String(port)
  ) {
    throw new EgressRefusedError("host is not in canonical form");
  }
  const vetted = await vetEgressTarget(target, policy, signal);
  if (vetted === null) return [parsed.hostname.replace(/^\[|\]$/g, "")];
  return vetted.urls.map((url) =>
    new URL(url).hostname.replace(/^\[|\]$/g, "")
  );
}

function handshake(args: {
  hostname: string;
  address: string;
  port: number;
  timeoutMs: number;
  ca?: string;
}): Promise<TlsProbe> {
  const { hostname, address, port, timeoutMs, ca } = args;
  return new Promise<TlsProbe>((resolve) => {
    let socket: TLSSocket | undefined;
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
      timeoutMs
    );

    let open: TLSSocket;
    try {
      open = connect({
        // The vetted address, never the name: the guard's answer is the one used.
        host: address,
        port,
        // SNI and verification both use the name; an IP literal has no SNI name.
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        // Verification is done on the facts, so every served certificate can be read.
        rejectUnauthorized: false,
        ...(ca !== undefined ? { ca } : {}),
        timeout: timeoutMs,
      });
    } catch (error) {
      finish({ kind: "unavailable", reason: errorText(error) });
      return;
    }
    socket = open;
    open.once("secureConnect", () => {
      let certificate: ReturnType<typeof readPeerCertificate>;
      try {
        certificate = readPeerCertificate(
          open.getPeerCertificate() as unknown as RawPeerCertificate
        );
      } catch (error) {
        finish({
          kind: "unreachable",
          code: "BAD_CERTIFICATE",
          message: errorText(error),
        });
        return;
      }
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
    // `on`, not `once`: a second error, or one after destroy, must not go unhandled.
    open.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        kind: "unreachable",
        code: error.code ?? "error",
        message: error.message,
      });
    });
  });
}

function siteOrigin(
  siteUrl: string | undefined
): { hostname: string; port: string } | undefined {
  if (!siteUrl) return undefined;
  try {
    const url = new URL(siteUrl);
    return {
      // No brackets and no root dot, as the probe's own targets are spelled.
      hostname: url.hostname
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase(),
      port: portOf(url),
    };
  } catch {
    return undefined;
  }
}

/** The URL's port with the scheme default filled in, so `:443` and none compare equal. */
function portOf(url: URL): string {
  return url.port || (url.protocol === "http:" ? "80" : "443");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
