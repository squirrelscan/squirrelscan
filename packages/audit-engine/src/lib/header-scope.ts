// Which hosts get the audit's custom request headers on an asset request (#732).
// The headers usually carry credentials (Web Bot Auth, Cloudflare Access, API
// keys), and a subdomain is not always run by the audited site's owner: hosted
// user content, a SaaS CNAME, a dangling CNAME someone else claimed. So only
// the audited origin gets them, plus the hosts the user names.

export type HeaderScope = (url: string) => boolean;

function hostOf(value: string): string {
  const raw = value.trim().toLowerCase();
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

/**
 * `baseUrl` is the start URL after its redirects. Its scheme, host and port
 * match; another port or scheme on the same host does not. `extraHosts` match
 * by host alone, as the user named them.
 */
export function createHeaderScope(
  baseUrl: string,
  extraHosts: readonly string[] = [],
): HeaderScope {
  let origin = "";
  try {
    origin = baseUrl ? new URL(baseUrl).origin : "";
  } catch {
    // An unparseable base URL has no origin: nothing but named hosts matches.
  }
  const named = new Set(extraHosts.map(hostOf).filter((h) => h !== ""));
  return (url) => {
    try {
      const parsed = new URL(url);
      return (
        (origin !== "" && parsed.origin === origin) ||
        named.has(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""))
      );
    } catch {
      return false;
    }
  };
}

/** The custom headers for `url`: all of them in scope, none out of it. `undefined` scope = no limit. */
export function customHeadersFor(
  url: string,
  headers: Record<string, string> | undefined,
  scope: HeaderScope | undefined,
): Record<string, string> | undefined {
  if (!headers || !scope || scope(url)) return headers;
  return undefined;
}

/** True when `headers` were set but withheld from `url` by the scope. */
export function headersWithheldFrom(
  url: string,
  headers: Record<string, string> | undefined,
  scope: HeaderScope | undefined,
): boolean {
  return !!headers && Object.keys(headers).length > 0 && !!scope && !scope(url);
}
