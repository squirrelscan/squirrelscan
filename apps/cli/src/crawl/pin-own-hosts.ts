import {
  memoizeResolveHost,
  ownHostsPinned,
  proxiedByEnvironment,
  resolveHostAddresses,
  type EgressPolicy,
  type ResolveHost,
} from "@squirrelscan/utils/public-egress";

/**
 * Whether the crawl pins the site's own hosts (squirrelscan/repo#3430): the
 * audited host, its `www` twin and the project domains are resolved once and
 * connected to by address, and one that resolves to a link-local or cloud
 * metadata address is never requested. On by default.
 *
 * `SQUIRREL_NO_HOST_PINNING` turns it off, for a network where connecting by
 * address breaks routing (split-horizon DNS behind a proxy that is not in the
 * environment, for example). Truthy = anything other than unset, empty, "0" or
 * "false" (case-insensitive), as `SQUIRREL_NO_UPDATE` reads.
 */
export function pinOwnHosts(): boolean {
  const v = process.env.SQUIRREL_NO_HOST_PINNING?.trim().toLowerCase();
  return v === undefined || v === "" || v === "0" || v === "false";
}

/**
 * Why the site's own hosts go out by name although pinning is on: an HTTP
 * proxy in the environment resolves them instead (squirrelscan/repo#3430).
 * Null when they are pinned or pinning is off by choice.
 */
export function hostPinningNotice(): string | null {
  if (!pinOwnHosts() || !proxiedByEnvironment()) return null;
  return "HTTP proxy set in the environment: the site's own hosts go out by name through it, without squirrel's address check";
}

/**
 * Where the rule probes that request the site's own hosts connect (#2315):
 * the `security/http-to-https` redirect probe and the GraphQL probes. With the
 * own hosts pinned, a name is resolved once per audit, a link-local or cloud
 * metadata answer is refused before anything is sent, and the request connects
 * to the address that was checked. Private networks stay allowed, as for the
 * crawl. Undefined where the crawl sends those hosts by name too (an
 * environment proxy, `SQUIRREL_NO_HOST_PINNING`): the probes then go out by
 * name, unchanged.
 */
export function ownHostProbeEgress(
  resolve: ResolveHost = resolveHostAddresses
): EgressPolicy | undefined {
  if (!ownHostsPinned({ pinOwnHosts: pinOwnHosts() })) return undefined;
  return {
    allowPrivateNetwork: true,
    resolve: memoizeResolveHost(resolve),
  };
}
