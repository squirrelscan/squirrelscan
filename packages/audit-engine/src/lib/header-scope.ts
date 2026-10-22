// Which hosts get the audit's custom request headers on an asset request (#732).
// The headers usually carry credentials (Web Bot Auth, Cloudflare Access, API
// keys), and a subdomain is not always run by the audited site's owner: hosted
// user content, a SaaS CNAME, a dangling CNAME someone else claimed. So only
// the audited origin gets them, plus the hosts the user names.

import { createHeaderScope, type HeaderScope } from "@squirrelscan/utils/headers";

export { createHeaderScope, type HeaderScope };

/**
 * Custom headers and the scope that decides who gets them, as one option: the
 * scope is required whenever headers are set, so a caller cannot send them
 * everywhere by leaving it out (#959).
 */
export type ScopedHeaderOptions =
  | { customHeaders?: undefined; headerScope?: HeaderScope }
  | { customHeaders: Record<string, string>; headerScope: HeaderScope };

/**
 * The custom headers for `url`: all of them in scope, none out of it. With no
 * scope, none: a missing scope never widens who gets the headers.
 */
export function customHeadersFor(
  url: string,
  headers: Record<string, string> | undefined,
  scope: HeaderScope | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return scope?.(url) ? headers : undefined;
}

/** True when `headers` were set but withheld from `url` by the scope (or by having none). */
export function headersWithheldFrom(
  url: string,
  headers: Record<string, string> | undefined,
  scope: HeaderScope | undefined,
): boolean {
  return !!headers && Object.keys(headers).length > 0 && !scope?.(url);
}
