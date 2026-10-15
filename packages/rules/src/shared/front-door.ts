// The site's front door, which the inbound-link rules never flag: the homepage
// (`baseUrl`, or the path `/`), and the page the crawl started on, the URL the
// audit was given and where its redirects landed (pub#788, pub#796). A root
// that redirects to `/en/` or to a sign-in page lands the crawl on a page the
// redirect, not a link, leads to.

import { getPathname, normalizeUrl } from "@squirrelscan/utils";

/** A test for the front door, keyed the way the inbound-link counts are. */
export function frontDoorTest(
  baseUrl: string,
  entryUrls: readonly string[] = []
): (url: string) => boolean {
  const normalizedBase = normalizeUrl(baseUrl);
  const entryPages = new Set(entryUrls.map((entry) => normalizeUrl(entry)));
  return (url) => {
    const normalizedUrl = normalizeUrl(url);
    return (
      normalizedUrl === normalizedBase ||
      getPathname(url) === "/" ||
      entryPages.has(normalizedUrl)
    );
  };
}
