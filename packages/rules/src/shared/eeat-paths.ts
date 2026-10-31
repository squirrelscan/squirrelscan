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
  /** `found`: a real page answered. `missing`: the path did not answer with a page, see `reason`. `blocked`: robots.txt disallows it, so it was not requested. */
  outcome: "found" | "missing" | "blocked";
  status: number;
  /** Why it is not a page, for the finding (`404`, `redirected to /`, `not an HTML page`, ...). */
  reason: string;
  /** Words of the page's text, null when it was not HTML or could not be measured. */
  wordCount: number | null;
}

/** An answer with fewer words than this is an empty app shell or a stub, not a page. */
export const MIN_PROBED_PAGE_WORDS = 10;

/**
 * The answers the crawl's `configured-pages` probe holds for the rule's configured `paths`. A 2xx counts as the
 * page only when it is a page of the audited site: it did not redirect to another host or to the home page,
 * it is HTML and it has readable text (a JSON answer, or a single page app that answers 200 for every path with
 * an empty shell, is not an About page). A path the probe never attempted, or could not get an answer for (a
 * network error, the budget spent), is left out: it is evidence of nothing, so the rule reports as it did before
 * the probe existed.
 */
export function probedConfiguredPages(
  site: { wellKnown?: WellKnownProbeData | null } | undefined,
  paths: readonly string[],
): ProbedConfiguredPage[] {
  const out: ProbedConfiguredPage[] = [];
  for (const probe of site?.wellKnown?.probes ?? []) {
    if (!probe.configuredPage || !matchesConfiguredPaths(probe.path, paths)) continue;
    const base = { path: probe.path, url: probe.url, status: probe.status, wordCount: probe.wordCount ?? null };
    if (probe.blockedByRobots) {
      out.push({ ...base, outcome: "blocked", status: 0, reason: "disallowed by robots.txt, not requested" });
    } else if (probe.status >= 200 && probe.status < 300) {
      out.push(judgeAnswer(probe, base));
    } else if (probe.status >= 300) {
      out.push({ ...base, outcome: "missing", reason: String(probe.status) });
    }
  }
  return out;
}

function judgeAnswer(
  probe: WellKnownProbeData["probes"][number],
  base: Omit<ProbedConfiguredPage, "outcome" | "reason">,
): ProbedConfiguredPage {
  const missing = (reason: string): ProbedConfiguredPage => ({ ...base, outcome: "missing", reason });
  if (probe.finalUrl) {
    try {
      const asked = new URL(probe.url);
      const landed = new URL(probe.finalUrl);
      if (landed.origin !== asked.origin) return missing(`redirected to another site (${landed.host})`);
      if (landed.pathname === "/" || landed.pathname === "") return missing("redirected to /");
    } catch {
      // An unparseable final URL is judged on the answer alone.
    }
  }
  if (!probe.looksHtml && !/html/i.test(probe.contentType ?? "")) return missing("not an HTML page");
  if (base.wordCount === null) return { ...base, outcome: "found", reason: "" };
  if (base.wordCount < MIN_PROBED_PAGE_WORDS) return missing("no readable page content");
  return { ...base, outcome: "found", reason: "" };
}

const NOTE_PATHS = 5;
const NOTE_PATH_CHARS = 80;

/** The part of a missing-page finding that says what was probed: `(probed /agentur: 404)`. Bounded: at most 5 paths, each cut at 80 characters. */
export function probedNote(probes: readonly ProbedConfiguredPage[]): string {
  const cut = (text: string): string => (text.length > NOTE_PATH_CHARS ? `${text.slice(0, NOTE_PATH_CHARS)}...` : text);
  const parts = probes.slice(0, NOTE_PATHS).map((p) => cut(`${p.path}: ${p.reason}`));
  if (probes.length > NOTE_PATHS) parts.push(`and ${probes.length - NOTE_PATHS} more`);
  return `(probed ${parts.join(", ")})`;
}
