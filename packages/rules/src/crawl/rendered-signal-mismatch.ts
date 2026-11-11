// crawl/rendered-signal-mismatch - JavaScript changes the canonical, noindex, title or H1 after load.
//
// Crawlers and agents that do not run JavaScript read the raw HTML. A script that rewrites the
// canonical, adds or removes a robots noindex, or replaces the title or H1 makes them read a
// different page from the one a browser shows. `ax/content-without-js` compares body content; this
// compares the head signals, from the same cloud render, so it adds no charge beyond the page's audit.

import type { RenderResultItem } from "@squirrelscan/core-contracts";
import { extractH1, extractMeta, parseDocument } from "@squirrelscan/parser";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

const CANONICAL = "canonical-mismatch";
const NOINDEX = "noindex-mismatch";
const TITLE = "title-modified";
const H1 = "h1-modified";

/** Longest raw or rendered text a finding carries (a title or H1 is short; a runaway one is cut). */
const MAX_SHOWN = 200;

function shown(text: string | null): string | null {
  if (text === null) return null;
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text;
}

/**
 * A canonical URL as a comparable key: resolved against the page, with the host's case and a
 * default port already gone (the URL parser), no fragment, and no trailing slash on a non-root
 * path. Null when it is empty or unparseable: such a value is compared as its trimmed text.
 */
export function canonicalKey(href: string | null, pageUrl: string): string | null {
  const raw = href?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, pageUrl);
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/** Whether a robots meta value asks not to index (`noindex`, or `none`, which includes it). */
export function robotsSaysNoindex(robots: string | null): boolean {
  if (!robots) return false;
  return robots
    .toLowerCase()
    .split(",")
    .map((token) => token.trim())
    .some((token) => token === "noindex" || token === "none");
}

/** Text compared after whitespace and case are normalised. */
function normalizedText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const out = text.replace(/\s+/g, " ").trim().toLowerCase();
  return out === "" ? null : out;
}

/**
 * One skipped check for the whole rule, not one per signal: a CLI audit without the cloud skips
 * every page, and four rows a page would carry four times the rows for the same reason.
 */
const SKIPPED = "rendered-signal-mismatch";

function skipped(reason: string, message: string): CheckResult[] {
  return [{ name: SKIPPED, status: "skipped", message, skipReason: reason }];
}

export const renderedSignalMismatchRule: Rule = {
  meta: {
    id: "crawl/rendered-signal-mismatch",
    name: "Rendered Signal Mismatch",
    description:
      "Flags a canonical, robots noindex, title or first H1 that JavaScript changes after the page loads, so crawlers that read the raw HTML see a different page",
    solution:
      "Crawlers and agents that do not run JavaScript read your raw HTML, and some index from it. If a script rewrites the canonical URL or adds or removes a robots noindex after load, the raw page and the rendered page tell them different things, and a wrong canonical or a stray noindex can drop the page from the index. Put the canonical and the robots meta in the server's HTML and make the client leave them alone. Keep the title and first H1 in the server HTML too, so what a crawler reads is what a visitor sees.",
    category: "crawl",
    scope: "page",
    // Reads the page's own raw and rendered head: nothing template-wide.
    verdictScope: "page",
    severity: "error",
    weight: 6,
    // On a soft-404 the raw and the rendered page are both the error shell (#1174).
    skipOnSoft404: true,
    // `audit_page` (#2290): the render runs inside the audit and is billed as the page's own audit
    // charge, never as a render on top of it. The same spec as ax/content-without-js.
    cloud: { service: "render", unit: "page", creditFeature: "audit_page" },
  },

  run(ctx: RuleContext): RuleResult {
    // On a browser-rendered crawl `ctx.parsed` IS the rendered DOM, so the comparison is
    // self-identical and would always pass, masking a real mismatch. Skip cleanly.
    if (ctx.page.rendered) {
      return {
        checks: skipped(
          "The crawl browser-rendered this page, so its raw and rendered HTML are identical: run a raw (non-rendered) audit to compare them",
          "Raw-vs-rendered signal comparison skipped",
        ),
      };
    }

    const envelope = readCloudResult<RenderResultItem>(ctx.cloudResults, "render", ctx.page.url);
    if (!envelope || envelope.status === "skipped") {
      return {
        checks: skipped(
          humanizeCloudSkip(envelope?.skipReason ?? "not-prefetched"),
          "Raw-vs-rendered signal comparison skipped",
        ),
      };
    }
    const renderedHtml = envelope.data?.html;
    if (!renderedHtml) {
      return {
        checks: skipped(
          humanizeCloudSkip("render-failed"),
          "No rendered HTML returned for this page",
        ),
      };
    }

    // The same extractors the crawl used for the raw side, so the two compare like for like.
    const renderedDoc = parseDocument(renderedHtml);
    const renderedMeta = extractMeta(renderedDoc);
    const renderedH1 = extractH1(renderedDoc).texts[0] ?? null;
    const raw = ctx.parsed;
    const rawH1 = raw.h1.texts[0] ?? null;
    const url = ctx.page.url;
    const checks: CheckResult[] = [];

    // Canonical: differs, or exists on only one side.
    const rawCanonical = canonicalKey(raw.meta.canonical, url);
    const renderedCanonical = canonicalKey(renderedMeta.canonical, url);
    const canonicalDetails = {
      raw: shown(raw.meta.canonical?.trim() || null),
      rendered: shown(renderedMeta.canonical?.trim() || null),
    };
    if (rawCanonical !== renderedCanonical) {
      const message =
        rawCanonical === null
          ? `JavaScript adds a canonical (${canonicalDetails.rendered}); the raw HTML has none`
          : renderedCanonical === null
            ? `JavaScript removes the canonical (${canonicalDetails.raw}); the raw HTML has one`
            : `The canonical is ${canonicalDetails.raw} in the raw HTML and ${canonicalDetails.rendered} after JavaScript runs`;
      checks.push({
        name: CANONICAL,
        status: "fail",
        message,
        pageUrl: url,
        details: canonicalDetails,
      });
    } else {
      checks.push({
        name: CANONICAL,
        status: "pass",
        message: "The canonical is the same before and after JavaScript runs",
        details: canonicalDetails,
      });
    }

    // Noindex: present on only one side.
    const rawNoindex = robotsSaysNoindex(raw.meta.robots);
    const renderedNoindex = robotsSaysNoindex(renderedMeta.robots);
    const noindexDetails = {
      raw: rawNoindex,
      rendered: renderedNoindex,
      rawRobots: shown(raw.meta.robots),
      renderedRobots: shown(renderedMeta.robots),
    };
    if (rawNoindex !== renderedNoindex) {
      checks.push({
        name: NOINDEX,
        status: "fail",
        message: rawNoindex
          ? "noindex is in the raw HTML and JavaScript removes it: crawlers that read the raw HTML will not index this page"
          : "JavaScript adds noindex: a crawler that reads the raw HTML sees an indexable page, one that renders it does not",
        pageUrl: url,
        details: { ...noindexDetails, carriedBy: rawNoindex ? "raw" : "rendered" },
      });
    } else {
      checks.push({
        name: NOINDEX,
        status: "pass",
        message: "The robots noindex is the same before and after JavaScript runs",
        details: noindexDetails,
      });
    }

    // Title: differs after whitespace and case are normalised.
    const rawTitle = normalizedText(raw.meta.title);
    const renderedTitle = normalizedText(renderedMeta.title);
    const titleDetails = {
      raw: shown(raw.meta.title?.replace(/\s+/g, " ").trim() || null),
      rendered: shown(renderedMeta.title?.replace(/\s+/g, " ").trim() || null),
    };
    if (rawTitle !== renderedTitle) {
      checks.push({
        name: TITLE,
        status: "warn",
        message: `The title is "${titleDetails.raw ?? ""}" in the raw HTML and "${titleDetails.rendered ?? ""}" after JavaScript runs`,
        pageUrl: url,
        details: titleDetails,
      });
    } else {
      checks.push({
        name: TITLE,
        status: "pass",
        message: "The title is the same before and after JavaScript runs",
        details: titleDetails,
      });
    }

    // First H1: differs, or exists on only one side.
    const rawH1Text = normalizedText(rawH1);
    const renderedH1Text = normalizedText(renderedH1);
    const h1Details = {
      raw: shown(rawH1?.replace(/\s+/g, " ").trim() || null),
      rendered: shown(renderedH1?.replace(/\s+/g, " ").trim() || null),
    };
    if (rawH1Text !== renderedH1Text) {
      checks.push({
        name: H1,
        status: "warn",
        message:
          rawH1Text === null
            ? `JavaScript adds the first H1 ("${h1Details.rendered}"); the raw HTML has none`
            : renderedH1Text === null
              ? `JavaScript removes the first H1 ("${h1Details.raw}")`
              : `The first H1 is "${h1Details.raw}" in the raw HTML and "${h1Details.rendered}" after JavaScript runs`,
        pageUrl: url,
        details: h1Details,
      });
    } else {
      checks.push({
        name: H1,
        status: "pass",
        message: "The first H1 is the same before and after JavaScript runs",
        details: h1Details,
      });
    }

    return { checks };
  },
};
