// core/robots-meta - Checks the robots meta tag and X-Robots-Tag header for noindex/nofollow

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/** Directives that take a `name: value` form, so a colon after them is not a user-agent prefix. */
const VALUE_DIRECTIVES = new Set([
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "unavailable_after",
]);

/** One run of X-Robots-Tag directives, for every crawler (agent null) or one named one. */
export interface XRobotsTagGroup {
  agent: string | null;
  directives: string;
}

/**
 * Split an X-Robots-Tag value into per-crawler groups (pub#457). A comma-separated
 * entry may start with a user-agent prefix (`googlebot: noindex`), which then
 * applies to the entries after it until the next prefix, matching Google's
 * `X-Robots-Tag: otherbot: noindex, nofollow`. A `max-snippet: 20` style entry is
 * a directive, not a prefix.
 *
 * Repeated headers reach rules joined with ", " (`Headers.get`), so an unscoped
 * header sent AFTER a scoped one reads as part of the scoped group. The boundary is
 * gone by then; this errs toward the narrower reading.
 */
export function parseXRobotsTag(value: string): XRobotsTagGroup[] {
  const groups: XRobotsTagGroup[] = [];
  let current: XRobotsTagGroup | null = null;
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    // A user-agent product token (letters, digits, `_`, `.`, `-`), capped so a
    // site-controlled header cannot put arbitrary text into the report message.
    // It must contain a letter (`360Spider` does), which keeps the comma-split
    // tail of an unavailable_after date (`...15:00:00,5-08:00`) from reading as
    // a crawler name.
    const prefix = /^([A-Za-z0-9][\w.-]{0,63})\s*:\s*(.*)$/.exec(entry);
    if (prefix && /[A-Za-z]/.test(prefix[1]) && !VALUE_DIRECTIVES.has(prefix[1].toLowerCase())) {
      current = { agent: prefix[1].toLowerCase(), directives: prefix[2] };
      groups.push(current);
      continue;
    }
    if (current) {
      current.directives += `, ${entry}`;
    } else {
      current = { agent: null, directives: entry };
      groups.push(current);
    }
  }
  return groups;
}

/** Where each of noindex/nofollow was found, as report labels. */
interface RobotsSources {
  noindex: string[];
  nofollow: string[];
}

const META_LABEL = "robots meta tag";
const HEADER_LABEL = "X-Robots-Tag header";
/** Crawlers named in one message before the rest are counted. */
const MAX_NAMED_AGENTS = 5;

/**
 * Collect the sources declaring noindex and nofollow. Matching is a substring
 * test on the lowercased directives, the same test `isPageIndexable` and
 * crawl/indexability use. A header group for every crawler is labelled
 * "X-Robots-Tag header"; scoped groups add "for <agent>" and are folded away when
 * an unscoped group already declares the same directive.
 */
function collectSources(meta: string | null, header: string | null): RobotsSources {
  const sources: RobotsSources = { noindex: [], nofollow: [] };
  const metaLower = meta?.toLowerCase() ?? "";
  for (const directive of ["noindex", "nofollow"] as const) {
    if (metaLower.includes(directive)) sources[directive].push(META_LABEL);
  }
  if (!header) return sources;

  const groups = parseXRobotsTag(header);
  for (const directive of ["noindex", "nofollow"] as const) {
    const matching = groups.filter((g) => g.directives.toLowerCase().includes(directive));
    if (matching.some((g) => g.agent === null)) {
      sources[directive].push(HEADER_LABEL);
      continue;
    }
    const agents = [...new Set(matching.map((g) => g.agent as string))];
    if (agents.length === 0) continue;
    const named = agents.slice(0, MAX_NAMED_AGENTS).join(", ");
    const more = agents.length - MAX_NAMED_AGENTS;
    sources[directive].push(`${HEADER_LABEL} for ${named}${more > 0 ? ` and ${more} more` : ""}`);
  }
  return sources;
}

/** "noindex and nofollow via robots meta tag", or one clause per directive when sources differ. */
function describeSources(sources: RobotsSources): string {
  const via = (labels: string[]) => `via ${labels.join(" and ")}`;
  const { noindex, nofollow } = sources;
  if (noindex.length > 0 && nofollow.length > 0) {
    return noindex.join("\u0000") === nofollow.join("\u0000")
      ? `noindex and nofollow ${via(noindex)}`
      : `noindex ${via(noindex)}, nofollow ${via(nofollow)}`;
  }
  return noindex.length > 0 ? `noindex ${via(noindex)}` : `nofollow ${via(nofollow)}`;
}

/** The meta value alone when there is no header, so existing reports read the same. */
function reportedValue(meta: string | null, header: string | null): string {
  if (!header) return meta ?? "";
  const headerPart = `X-Robots-Tag: ${header}`;
  return meta ? `robots meta: ${meta}; ${headerPart}` : headerPart;
}

export const robotsMetaRule: Rule = {
  meta: {
    id: "core/robots-meta",
    name: "Robots Meta",
    description: "Checks the robots meta tag and X-Robots-Tag header for indexing directives",
    solution:
      'The robots meta tag and the X-Robots-Tag response header control how search engines index and follow links on a page. Common directives include noindex, nofollow, noarchive, and nosnippet. If your page has noindex, it won\'t appear in search results. Review whether this is intentional; the report names the source, and a header set by a CDN, proxy or server config does not appear in the page source. For pages that should be indexed, remove the noindex directive or change it to "index, follow". Be careful with nofollow as it prevents link equity from flowing to linked pages.',
    category: "core",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const { robots } = ctx.parsed.meta;
    const xRobotsTag = ctx.page.headers?.["x-robots-tag"]?.trim() || null;
    const checks: CheckResult[] = [];

    if (!robots && !xRobotsTag) {
      // No robots meta tag is fine - defaults to index, follow
      checks.push({
        name: "robots-meta",
        status: "pass",
        message: "No robots meta tag (defaults to index, follow)",
        value: null,
      });
      return { checks };
    }

    const sources = collectSources(robots, xRobotsTag);
    const value = reportedValue(robots, xRobotsTag);

    if (sources.noindex.length > 0) {
      checks.push({
        name: "robots-meta",
        status: "warn",
        message: `Page is set to ${describeSources(sources)}`,
        value,
      });
    } else if (sources.nofollow.length > 0) {
      checks.push({
        name: "robots-meta",
        status: "info",
        message: `Page is set to ${describeSources(sources)} (links won't pass equity)`,
        value,
      });
    } else {
      checks.push({
        name: "robots-meta",
        status: "pass",
        message: robots
          ? xRobotsTag
            ? "Robots meta tag and X-Robots-Tag header allow indexing"
            : "Robots meta tag allows indexing"
          : "X-Robots-Tag header allows indexing",
        value,
      });
    }

    return { checks };
  },
};
