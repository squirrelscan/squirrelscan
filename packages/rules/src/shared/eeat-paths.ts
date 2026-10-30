// Site-specific page paths for the E-E-A-T presence rules (#1261).
//
// eeat/about-page, eeat/contact-page and eeat/privacy-policy find their page by a
// built-in list of slugs. A site whose page lives at a path no slug convention
// covers names it here, in `[rule_options."eeat/about-page"] paths = [...]`, and
// the rule then treats a crawled page at that path as the page. The patterns use
// the same matcher as `excludePatterns` (`matchesExcludePattern`): a substring of
// the path, an exact segment between slashes, or `regex:`.

import { z } from "zod";

import { excludePatternError, getPathname, matchesExcludePattern } from "@squirrelscan/utils";

/** The `paths` option, identical on the three rules. */
export const eeatPathsSchema = z
  .array(z.string().min(1).max(512))
  .max(50)
  // A `regex:` pattern that does not compile would never match and warn on every call.
  .superRefine((paths, ctx) => {
    paths.forEach((pattern, index) => {
      const error = excludePatternError(pattern);
      if (error) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `not a valid regular expression: ${error}`,
        });
      }
    });
  })
  .default([])
  .describe(
    "Site-specific paths of the page, matched like excludePatterns (substring, /exact-segment/ or regex:), checked in addition to the built-in slugs",
  );

/**
 * Whether `url` is at one of the configured `paths`. No paths matches nothing. The
 * pattern is matched against the URL's PATH only, never its host, query or fragment:
 * `/pages/manufaktur` does not match `?next=/pages/manufaktur`, and `manufaktur` does
 * not match every page on a host called manufaktur.de.
 */
export function matchesConfiguredPaths(url: string, paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return matchesExcludePattern(getPathname(url) || url, [...paths]);
}
