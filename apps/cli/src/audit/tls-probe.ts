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
// proxy, and a direct socket would go around it (#1259). So the handshake goes
// through a CONNECT tunnel: the proxy only relays bytes, the client still does
// TLS with the name as SNI and verifies the certificate itself. The target goes
// through the same egress guard as a direct handshake first: the name is
// resolved once here, a link-local, metadata or (for any host but the audited
// one) private answer is refused before any byte is sent, and the CONNECT names
// the vetted ADDRESS, never the name, so the proxy's own DNS cannot send the
// tunnel elsewhere and a rebinding answer cannot move it. The proxy's reply is
// only a status: it never supplies a target. No direct socket is opened to the
// host while a proxy applies, and `NO_PROXY` is honoured (those hosts take the
// direct, equally vetted path). A name that cannot be resolved locally is "not
// checked", even where a proxy could resolve it: the guard needs the answer. A proxy that refuses or fails the CONNECT, a
// proxy this probe cannot speak to (an `https:` or `socks` proxy URL) and a
// proxy that never answers make the rule say "not checked" with that reason,
// never a pass and never a crash.

import { wwwVariant } from "@squirrelscan/rules/security/tls-certificate";
import { isNonPublicHostname } from "@squirrelscan/utils/non-public-host";
import {
  EgressRefusedError,
  memoizeResolveHost,
  refusedWithoutLookup,
  resolveHostAddresses,
  vetEgressTarget,
  type EgressPolicy,
  type ResolveHost,
} from "@squirrelscan/utils/public-egress";
import {
  authorizationErrorCode,
  readPeerCertificate,
  type RawPeerCertificate,
  type TlsCertificateExtras,
  type TlsProbe,
  type TlsProbeFn,
} from "@squirrelscan/utils/tls-certificate";
import { X509Certificate } from "node:crypto";
import { connect as connectTcp, isIP, type Socket } from "node:net";
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
  /**
   * Behind an environment proxy, let the PROXY resolve the audited host and its www/apex counterpart:
   * the CONNECT names the host, not an address this machine vetted (#1317). For a setup where the proxy
   * owns DNS and allows by name. Off by default, and the trade-off is explicit: where those names
   * resolve is the proxy's decision, not squirrel's. Hosts found in page content, and every host
   * the egress guard refuses without a lookup, never take this path.
   */
  proxyResolvesNames?: boolean;
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

  const probeOnce: TlsProbeFn = async (target) => {
    const hostname = target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (options.siteHostOnly && hostname.toLowerCase() !== site?.hostname) {
      return {
        kind: "unavailable",
        reason: `--offline contacts only the audited host, not ${hostname}`,
      };
    }
    const port = target.port ?? 443;
    const timeoutMs =
      target.timeoutMs ?? options.timeoutMs ?? TLS_PROBE_TIMEOUT_MS;
    const proxy = proxyForTarget(hostname, port);
    if (proxy.kind === "unsupported") {
      return {
        kind: "unavailable",
        reason: `${proxy.reason}, and a direct TLS connection would go around the proxy`,
      };
    }
    // One budget for the lookup and the handshakes: the lookup aborts at the
    // same deadline, and each handshake gets whatever the lookup left.
    const deadline = Date.now() + timeoutMs;

    // The opt-in mode (#1317): the audited host and its www/apex counterpart only, never a name
    // that came from page content. What the URL itself says is vetted first (an IP literal, a
    // metadata name, a non-public name outside the audited network never take this path), and
    // no name is resolved here: the proxy decides where it goes.
    if (
      proxy.kind === "proxy" &&
      options.proxyResolvesNames === true &&
      isAuditedHostOrCounterpart(hostname, port, site) &&
      isIP(hostname) === 0 &&
      !refusedWithoutLookup(`https://${hostname}:${port}/`, policy)
    ) {
      return tunnelHandshake({
        hostname,
        address: hostname,
        port,
        proxy: proxy.url,
        timeoutMs: Math.max(1, deadline - Date.now()),
        ca: options.ca,
      });
    }

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

    // Behind a proxy the SAME vetted address is what the proxy is asked to
    // reach (#1259): the egress guard has already refused link-local, metadata
    // and (for any host but the audited one) private answers, and the CONNECT
    // names that address, not the name, so neither the proxy's own DNS nor a
    // rebinding answer can move it. The name stays the SNI and verification name.
    if (proxy.kind === "proxy") {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || addresses[0] === undefined) {
        return {
          kind: "unreachable",
          code: "ETIMEDOUT",
          message: `no TLS handshake with ${hostname} within ${timeoutMs}ms`,
        };
      }
      return tunnelHandshake({
        hostname,
        address: addresses[0],
        port,
        proxy: proxy.url,
        timeoutMs: remainingMs,
        ca: options.ca,
      });
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

  // A probe never throws (callers `Promise.all` it and read it in failure paths): whatever
  // escapes the steps above, a malformed proxy URL included, is an unreachable answer.
  return async (target) => {
    try {
      return await probeOnce(target);
    } catch (error) {
      return { kind: "unreachable", code: "error", message: errorText(error) };
    }
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
      open = connectForFacts({
        // The vetted address, never the name: the guard's answer is the one used.
        host: address,
        port,
        hostname,
        ca,
        timeout: timeoutMs,
      });
    } catch (error) {
      finish({ kind: "unavailable", reason: errorText(error) });
      return;
    }
    socket = open;
    readServedCertificate(open, hostname, finish);
  });
}

/**
 * The one place a TLS socket is opened. Verification is not enforced here, by
 * design: the audit reads the certificate the server presents, trusted or not,
 * and judges it on the facts (`authorized`, `authorizationError`, the names and
 * dates), so an expired, self-signed or mismatched certificate is REPORTED
 * instead of aborting the handshake. No request, header or credential is sent
 * over this connection. `hostname` is the SNI name (an IP literal has none).
 */
function connectForFacts(options: {
  hostname: string;
  ca?: string;
  host?: string;
  port?: number;
  socket?: Socket;
  timeout?: number;
}): TLSSocket {
  const { hostname, ca, ...target } = options;
  return connect({
    ...target,
    ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
    rejectUnauthorized: false,
    ...(ca !== undefined ? { ca } : {}),
  });
}

/**
 * The leaf's key and signature, read from its DER: `getPeerCertificate()` gives a bit size but no key
 * type or signature algorithm. Undefined fields when the runtime cannot parse the certificate (the facts
 * the peer certificate itself holds still apply).
 */
function certificateExtras(
  raw: Uint8Array | undefined
): TlsCertificateExtras | undefined {
  if (!raw) return undefined;
  try {
    const x509 = new X509Certificate(raw);
    const key = x509.publicKey;
    const details = key.asymmetricKeyDetails;
    return {
      keyType: key.asymmetricKeyType,
      ...(typeof details?.modulusLength === "number"
        ? { keyBits: details.modulusLength }
        : {}),
      signatureAlgorithm: (x509 as unknown as { signatureAlgorithm?: string })
        .signatureAlgorithm,
    };
  } catch {
    return undefined;
  }
}

/**
 * Wait for the handshake on `open` and finish with the certificate the server
 * sent, trusted or not: verification is done on the facts, so every served
 * certificate is read. Shared by the direct and the tunnelled handshake.
 */
function readServedCertificate(
  open: TLSSocket,
  hostname: string,
  finish: (result: TlsProbe) => void
): void {
  open.once("secureConnect", () => {
    let certificate: ReturnType<typeof readPeerCertificate>;
    try {
      const peer =
        open.getPeerCertificate() as unknown as RawPeerCertificate & {
          raw?: Uint8Array;
        };
      certificate = readPeerCertificate(peer, certificateExtras(peer.raw));
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
    const protocol = open.getProtocol();
    finish({
      kind: "certificate",
      certificate,
      trusted: open.authorized === true,
      ...(trustError !== undefined ? { trustError } : {}),
      ...(typeof protocol === "string" &&
      /^TLSv1(\.[0-3])?$|^SSLv3$/.test(protocol)
        ? { protocol }
        : {}),
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
}

// ── Behind an HTTP proxy (#1259) ─────────────────────────────────────────────

type ProxyDecision =
  | { kind: "direct" }
  | { kind: "proxy"; url: URL }
  | { kind: "unsupported"; reason: string };

/** The proxy variables a TLS target consults, in the order the runtime's fetch reads them. */
const PROXY_ENV_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const;

/**
 * Whether the handshake to `hostname:port` goes through an environment proxy,
 * straight out (no proxy set, or `NO_PROXY` names the host), or cannot be made
 * because the proxy is not one this probe speaks to. A tunnel needs an
 * `http:` proxy URL; `https:` and `socks` proxies are reported, not guessed at.
 */
export function proxyForTarget(hostname: string, port: number): ProxyDecision {
  const raw = PROXY_ENV_NAMES.map((name) =>
    (process.env[name] ?? "").trim()
  ).find((value) => value !== "");
  if (raw === undefined) return { kind: "direct" };
  if (noProxyMatches(hostname, port)) return { kind: "direct" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return {
      kind: "unsupported",
      reason:
        "an HTTP proxy is set in the environment but its URL is not valid",
    };
  }
  if (url.protocol !== "http:") {
    return {
      kind: "unsupported",
      reason: `a ${url.protocol.replace(/:$/, "")} proxy is set in the environment and this check only tunnels through an http proxy`,
    };
  }
  return { kind: "proxy", url };
}

/**
 * `NO_PROXY` / `no_proxy` (the first that is not empty): a comma list of `*`, a host, a
 * `.suffix` or `*.suffix` (all subdomains), each with an optional `:port`. CIDR ranges
 * (`10.0.0.0/8`) are not supported: an address in a range is not matched by it. A host entry also covers its
 * subdomains, as curl and the runtime read it.
 */
function noProxyMatches(hostname: string, port: number): boolean {
  const list =
    [process.env.NO_PROXY, process.env.no_proxy]
      .map((value) => (value ?? "").trim())
      .find((value) => value !== "") ?? "";
  if (list === "") return false;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const rawEntry of list.split(",")) {
    let entry = rawEntry.trim().toLowerCase();
    if (entry === "") continue;
    if (entry === "*") return true;
    let entryPort: number | undefined;
    const portMatch = /^(.*):(\d{1,5})$/.exec(entry);
    if (
      portMatch?.[1] !== undefined &&
      portMatch[2] !== undefined &&
      isIP(entry) === 0
    ) {
      entry = portMatch[1];
      entryPort = Number(portMatch[2]);
    }
    if (entryPort !== undefined && entryPort !== port) continue;
    entry = entry.replace(/^\*?\./, "").replace(/^\[|\]$/g, "");
    if (entry === "") continue;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** Longest CONNECT reply head read before the proxy is called broken. */
const MAX_CONNECT_REPLY_BYTES = 8_192;

/**
 * TLS handshake with `hostname:port` through a CONNECT tunnel on `proxy`. The
 * one deadline covers the proxy connection, the CONNECT and the handshake. Never
 * throws: every failure is an `unreachable` result with a `PROXY_*` code naming
 * the step, so the rule reports "not checked" with that reason.
 */
function tunnelHandshake(args: {
  hostname: string;
  /** The vetted address CONNECT names; `hostname` is only SNI and the wording of results. */
  address: string;
  port: number;
  proxy: URL;
  timeoutMs: number;
  ca?: string;
}): Promise<TlsProbe> {
  const { hostname, address, port, proxy, timeoutMs, ca } = args;
  const proxyName = `${proxy.hostname}:${proxy.port || "80"}`;
  return new Promise<TlsProbe>((resolve) => {
    let raw: Socket | undefined;
    let secure: TLSSocket | undefined;
    let settled = false;
    const finish = (result: TlsProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure?.destroy();
      raw?.destroy();
      resolve(result);
    };
    const fail = (code: string, message: string) =>
      finish({ kind: "unreachable", code, message });
    const timer = setTimeout(
      () =>
        fail(
          "PROXY_TIMEOUT",
          `no TLS handshake with ${hostname} through the proxy ${proxyName} within ${timeoutMs}ms`
        ),
      timeoutMs
    );

    const authority =
      isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
    let credentials = "";
    if (proxy.username !== "") {
      try {
        credentials = `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`;
      } catch {
        // A malformed percent escape in the proxy URL: the rule says so, it does not throw.
        fail(
          "PROXY_BAD_URL",
          "the proxy URL in the environment has credentials that cannot be decoded"
        );
        return;
      }
    }
    const socket = connectTcp({
      host: proxy.hostname.replace(/^\[|\]$/g, ""),
      port: Number(proxy.port || 80),
    });
    raw = socket;
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (secure) return; // the TLS layer reports its own errors
      fail(
        "PROXY_UNREACHABLE",
        `the proxy ${proxyName} could not be reached: ${error.code ?? error.message}`
      );
    });
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credentials}Proxy-Connection: keep-alive\r\n\r\n`
      );
    });

    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_CONNECT_REPLY_BYTES) {
          fail(
            "PROXY_BAD_REPLY",
            `the proxy ${proxyName} sent an unreadable answer to CONNECT`
          );
        }
        return;
      }
      socket.off("data", onData);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (!status) {
        fail(
          "PROXY_BAD_REPLY",
          `the proxy ${proxyName} sent an unreadable answer to CONNECT`
        );
        return;
      }
      const code = Number(status[1]);
      if (code < 200 || code > 299) {
        fail(
          `PROXY_CONNECT_${code}`,
          `the proxy ${proxyName} refused CONNECT to ${authority} with status ${code}`
        );
        return;
      }
      // Bytes after the reply head would belong to the tunnel; a proxy sends none before TLS.
      if (head.length > end + 4) {
        fail(
          "PROXY_BAD_REPLY",
          `the proxy ${proxyName} sent data before the TLS handshake`
        );
        return;
      }
      let opened: TLSSocket;
      try {
        // `host` is the identity the certificate is judged against: without it the
        // runtime reads it off the tunnel socket, which is the PROXY's address.
        opened = connectForFacts({ socket, hostname, host: hostname, ca });
      } catch (error) {
        fail("PROXY_TLS_ERROR", errorText(error));
        return;
      }
      secure = opened;
      readServedCertificate(opened, hostname, finish);
    };
    socket.on("data", onData);
  });
}

/**
 * The audited host or the rule's own www/apex counterpart of it (`wwwVariant`: from the registrable domain
 * only, so `blog.example.com` has none), on the audited site's own port: the only target the proxy may
 * resolve (#1317). Any other name or port is vetted and pinned here as usual.
 */
function isAuditedHostOrCounterpart(
  hostname: string,
  port: number,
  site: { hostname: string; port: string } | undefined
): boolean {
  if (site === undefined || String(port) !== site.port) return false;
  const host = hostname.toLowerCase();
  return host === site.hostname || host === wwwVariant(site.hostname);
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
