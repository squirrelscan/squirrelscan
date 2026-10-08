// What a rule may conclude about a root resource the site REFUSED.
//
// A bot wall that answers 403 for /robots.txt, a sitemap, /llms.txt or the
// Markdown probe has told us nothing about whether the resource exists. The
// crawler records each refusal (`SiteData.refusedFetches`); a rule that would
// otherwise assert an absence reports it as not checked instead, with the
// refusal named, as an info check that never counts as a failure.

import { describeRefusedFetch } from "@squirrelscan/core-contracts";

import type { RefusedFetch, RefusedResource } from "@squirrelscan/core-contracts";

import type { CheckResult, SiteData } from "./types";

/** The `value` of a check that was refused, for machine readers. */
export const REFUSED = "refused";

/** The refusals recorded for `resource`, in crawl order. */
export function refusedFor(
  site: Pick<SiteData, "refusedFetches"> | undefined,
  resource: RefusedResource,
): RefusedFetch[] {
  return (site?.refusedFetches ?? []).filter((refusal) => refusal.resource === resource);
}

/** `HTTP 403 (Cloudflare)`, or the distinct statuses when the refusals differ. */
export function refusalReason(refusals: readonly RefusedFetch[]): string {
  const first = refusals[0];
  if (!first) return "refused";
  const statuses = [...new Set(refusals.map((refusal) => refusal.status))];
  const providers = [...new Set(refusals.flatMap((refusal) => refusal.provider ?? []))];
  const by = providers.length > 0 ? ` (${providers.join(", ")})` : "";
  return `HTTP ${statuses.join("/")}${by}`;
}

/** An info check saying `subject` was not checked because the site refused the request. */
export function refusedCheck(
  name: string,
  subject: string,
  refusals: readonly RefusedFetch[],
): CheckResult {
  return {
    name,
    status: "info",
    message: `${subject} not checked: the site refused the request (${refusalReason(refusals)})`,
    value: REFUSED,
    details: { refused: refusals.map(describeRefusedFetch) },
  };
}
