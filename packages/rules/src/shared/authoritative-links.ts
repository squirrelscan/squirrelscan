// The authoritative external domains eeat/citations counts links to.

import { getHostname } from "@squirrelscan/utils";

const AUTHORITATIVE_DOMAINS = [
  "gov",
  "edu",
  "who.int",
  "cdc.gov",
  "nih.gov",
  "fda.gov",
  "mayo.clinic",
  "webmd",
  "healthline",
  "wikipedia.org",
  "reuters.com",
  "bbc.com",
  "nytimes.com",
  "wsj.com",
];

/** Links in `links` that leave the site for an authoritative domain, duplicates counted. */
export function countAuthoritativeLinks(
  links: ReadonlyArray<{ url: string; isInternal: boolean }>
): number {
  let count = 0;
  for (const link of links) {
    if (link.isInternal) continue;
    const hostname = getHostname(link.url).toLowerCase();
    if (!hostname) continue;
    if (
      AUTHORITATIVE_DOMAINS.some(
        (d) => hostname.includes(d) || hostname.endsWith(`.${d}`)
      )
    )
      count++;
  }
  return count;
}
