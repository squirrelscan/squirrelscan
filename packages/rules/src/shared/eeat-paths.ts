// Site-specific page paths for the E-E-A-T presence rules (#1261).
//
// eeat/about-page, eeat/contact-page and eeat/privacy-policy find their page by a
// built-in list of slugs. A site whose page lives at a path no slug convention
// covers names it here, in `[rule_options."eeat/about-page"] paths = [...]`, and
// the rule then treats a crawled page at that path as the page. The patterns use
// the same matcher as `excludePatterns` (`matchesExcludePattern`): a substring of
// the path, an exact segment between slashes, or `regex:`.

import { z } from "zod";

import { matchesExcludePattern } from "@squirrelscan/utils";

/** The `paths` option, identical on the three rules. */
export const eeatPathsSchema = z
  .array(z.string().min(1).max(512))
  .max(50)
  .default([])
  .describe(
    "Site-specific paths of the page, matched like excludePatterns (substring, /exact-segment/ or regex:), checked in addition to the built-in slugs",
  );

/** Whether `url` is at one of the configured `paths`. No paths matches nothing. */
export function matchesConfiguredPaths(url: string, paths: readonly string[]): boolean {
  return paths.length > 0 && matchesExcludePattern(url, [...paths]);
}
