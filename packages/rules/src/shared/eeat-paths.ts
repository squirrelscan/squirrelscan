// Site-specific page paths for the E-E-A-T presence rules (#1261).
//
// eeat/about-page, eeat/contact-page and eeat/privacy-policy find their page by a
// built-in list of slugs. A site whose page lives at a path no slug convention
// covers names it here, in `[rule_options."eeat/about-page"] paths = [...]`, and
// the rule then treats a crawled page at that path as the page. The patterns use
// the same matcher as `excludePatterns` (`matchesExcludePattern`): a substring of
// the path, an exact segment between slashes, or `regex:`.

import { z } from "zod";

import type { WellKnownProbeData } from "@squirrelscan/core-contracts";

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

/** What the `configured-pages` probe found at one configured path the crawl did not reach (#1428). */
export interface ProbedConfiguredPage {
  path: string;
  url: string;
  /** `found`: answered 2xx. `missing`: answered, not 2xx. `blocked`: robots.txt disallows it, so it was not requested. */
  outcome: "found" | "missing" | "blocked";
  status: number;
  /** Words of the page's text, null when it was not HTML or could not be measured. */
  wordCount: number | null;
}

/**
 * The answers the crawl's `configured-pages` probe holds for the rule's configured `paths`. A path the probe
 * never attempted, or could not get an answer for (a network error, the budget spent), is left out: it is
 * evidence of nothing, so the rule reports as it did before the probe existed.
 */
export function probedConfiguredPages(
  site: { wellKnown?: WellKnownProbeData | null } | undefined,
  paths: readonly string[],
): ProbedConfiguredPage[] {
  const out: ProbedConfiguredPage[] = [];
  for (const probe of site?.wellKnown?.probes ?? []) {
    if (!probe.configuredPage || !matchesConfiguredPaths(probe.path, paths)) continue;
    if (probe.blockedByRobots) {
      out.push({ path: probe.path, url: probe.url, outcome: "blocked", status: 0, wordCount: null });
    } else if (probe.status >= 200 && probe.status < 300) {
      out.push({ path: probe.path, url: probe.url, outcome: "found", status: probe.status, wordCount: probe.wordCount ?? null });
    } else if (probe.status >= 300) {
      out.push({ path: probe.path, url: probe.url, outcome: "missing", status: probe.status, wordCount: null });
    }
  }
  return out;
}

/** The part of a missing-page finding that says what was probed: `(probed /agentur: 404)`. */
export function probedNote(probes: readonly ProbedConfiguredPage[]): string {
  const parts = probes.map((p) =>
    p.outcome === "blocked" ? `${p.path}: disallowed by robots.txt, not requested` : `${p.path}: ${p.status}`,
  );
  return `(probed ${parts.join(", ")})`;
}
