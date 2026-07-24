// Audit target URL matching helpers

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "http:" ? "80" : "443";
}

/**
 * Parse a target URL/base URL to URL object.
 * Returns null if invalid.
 */
export function parseAuditTarget(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/**
 * Returns true when two URLs refer to the same logical site target for audits.
 * - scheme differences are ignored (http/https)
 * - apex and www are treated as equivalent hosts
 * - explicit non-default ports must match
 */
export function isEquivalentAuditTarget(a: URL, b: URL): boolean {
  const aHost = stripWww(normalizeHost(a.hostname));
  const bHost = stripWww(normalizeHost(b.hostname));
  if (aHost !== bHost) return false;

  const aExplicitPort = a.port;
  const bExplicitPort = b.port;

  // If both have explicit ports, they must match exactly.
  if (aExplicitPort && bExplicitPort) {
    return aExplicitPort === bExplicitPort;
  }

  // If only one side has explicit port, treat default explicit ports as equivalent
  // to an unspecified port on the other side.
  if (aExplicitPort && !bExplicitPort) {
    return aExplicitPort === defaultPortForProtocol(a.protocol);
  }
  if (!aExplicitPort && bExplicitPort) {
    return bExplicitPort === defaultPortForProtocol(b.protocol);
  }

  // Neither side has explicit port.
  return true;
}
