// The crawl's egress policy (squirrelscan/repo#2830, repo#3336), shared by the
// crawl and by the CLI's reachability check, so both trust the same hosts.

import { isInScope } from "./frontier";
import {
  memoizeResolveHost,
  refusedWithoutLookup,
  resolveHostAddresses,
  type EgressPolicy,
  type ResolveHost,
} from "@squirrelscan/utils/public-egress";
import { getHostname } from "@squirrelscan/utils/url";

export interface CrawlEgressOptions {
  /** The project's `domains`; read on each check, so a crawl that restores its config is seen. */
  readonly allowedDomains?: readonly string[];
  /** The transport resolves once and connects to what it validated (the hosted container). */
  readonly egressPinnedByTransport?: boolean;
  /** DNS for the hops that leave the crawl's hosts. Defaults to one lookup per name. */
  readonly resolve?: ResolveHost;
}

/**
 * The asset phase's own-site policy (#2764) for every request the site can
 * steer: redirect hops, root files and the sitemaps robots.txt or an index
 * names, and the start URL's own redirects. The crawl's hosts (`base` on any
 * port, its apex/www pair, `allowedDomains`) go out by name as before, private
 * networks stay allowed (a LAN or dev-server audit), and a hop anywhere else to
 * a link-local or cloud metadata address is refused, never sent; the rest
 * connect to the address they were vetted on unless the transport pins. None
 * when `base` is itself such an address: the user chose it, and the guard is
 * for where the site sends the crawl.
 */
export function crawlEgressPolicy(
  base: string,
  options: CrawlEgressOptions = {},
): EgressPolicy | undefined {
  const baseHost = getHostname(base).toLowerCase();
  const policy: EgressPolicy = {
    allowPrivateNetwork: true,
    resolve: options.resolve ?? memoizeResolveHost(resolveHostAddresses),
    pin: options.egressPinnedByTransport !== true,
    // The audited host on any port too: its name is the user's, and
    // `allowedDomains` alone (a hard allowlist) may not list it.
    trustTarget: (url) => {
      if (url.hostname.toLowerCase() === baseHost) return true;
      try {
        return isInScope(url.href, {
          baseUrl: base,
          include: [],
          exclude: [],
          allowedDomains: options.allowedDomains ? [...options.allowedDomains] : undefined,
        }).allowed;
      } catch {
        return false;
      }
    },
  };
  return refusedWithoutLookup(base, policy) ? undefined : policy;
}
