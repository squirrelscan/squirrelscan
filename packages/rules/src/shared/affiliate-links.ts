// Affiliate link detection for eeat/affiliate-disclosure.

const AFFILIATE_PATTERNS = [
  /amazon\.[a-z]+\/.*tag=/i,
  /shareasale\.com/i,
  /go\.redirectingat\.com/i,
  /awin1\.com/i,
  /commission-junction/i,
  /\?ref=/i,
  /\?affiliate=/i,
];

/** Whether any link points at an affiliate network or carries an affiliate parameter. */
export function hasAffiliateLink(
  links: ReadonlyArray<{ url: string }>
): boolean {
  return links.some((l) => AFFILIATE_PATTERNS.some((p) => p.test(l.url)));
}
