/**
 * Which hosts count as the audited site's own (squirrelscan/squirrelscan#819):
 * the audited host, its `www` or apex twin, every host named in
 * `[project] domains` (and their twins), and the subdomains of all of them.
 *
 * `squirrel audit --offline` holds every request to these hosts, so a redirect
 * a page or an asset answers with, a sitemap a robots.txt names, or a probe's
 * hop never reaches another site. One definition for the crawl, the sitemap
 * walk, the asset checks and the end-of-crawl probes, so they cannot disagree
 * about what "the site's own" is.
 */

import { getHostname } from "./url";

export interface OwnSiteOptions {
  /** The audited address; its host (and `www` twin) is the site. */
  baseUrl: string;
  /** `[project] domains`: more hosts the user named as the site's own. */
  domains?: readonly string[];
}

/** Lowercase, no brackets (IPv6), no trailing dot. */
function normalizeHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d+(\.\d+){3}$/.test(host);
}

/** The `www` or apex twin of a host, or "" for an IP literal or a single label. */
function twinOf(host: string): string {
  if (isIpLiteral(host) || !host.includes(".")) return "";
  return host.startsWith("www.") ? host.slice(4) : `www.${host}`;
}

/**
 * `[project] domains` entries are hosts, but a URL, a host with a port or a
 * wildcard (`*.example.com`, `.example.com`) pasted there still means that
 * host: read through the URL parser, so an IDN becomes its punycode name.
 */
function domainHost(entry: string): string {
  const trimmed = entry.trim().replace(/^\*?\./, "");
  if (!trimmed) return "";
  try {
    return normalizeHost(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).hostname);
  } catch {
    return "";
  }
}

/**
 * A predicate on a URL's hostname (lowercased, IPv6 without brackets: the
 * shape `EgressPolicy.allowHost` is given). A matcher for an address with no
 * host matches nothing.
 */
export function ownSiteHostMatcher(options: OwnSiteOptions): (hostname: string) => boolean {
  const roots = new Set<string>();
  const add = (host: string) => {
    if (!host) return;
    roots.add(host);
    const twin = twinOf(host);
    if (twin) roots.add(twin);
  };
  add(normalizeHost(getHostname(options.baseUrl)));
  for (const entry of options.domains ?? []) add(domainHost(entry));
  return (hostname) => {
    const host = normalizeHost(hostname);
    if (!host) return false;
    for (const root of roots) {
      if (host === root) return true;
      // Subdomains belong to a name, never to an address.
      if (!isIpLiteral(root) && host.endsWith(`.${root}`)) return true;
    }
    return false;
  };
}

/** The same predicate on a whole URL; an unparseable URL is not the site's. */
export function ownSiteUrlMatcher(options: OwnSiteOptions): (url: string) => boolean {
  const ownHost = ownSiteHostMatcher(options);
  return (url) => ownHost(getHostname(url));
}
