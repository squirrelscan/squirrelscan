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
