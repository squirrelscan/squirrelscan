// Report "publish-prep" for both paths — the CLI publish controller re-exports
// computeLockedRules from here (the duck-typed report shape below is satisfied
// structurally by the CLI's vendored AuditReport), and runCloudAudit calls it
// directly, so cloud and CLI reports stamp identical `homepage`/`lockedRules`.

import { NOT_CHECKED_SKIP_REASONS, type LockedRule, type PartialAudit } from "@squirrelscan/core-contracts";
import {
  isNotApplicableCloudSkip,
  isRenderDisabledCloudSkip,
  loadAllRules,
  UNWIRED_CLOUD_SERVICES,
  type Rule,
} from "@squirrelscan/rules";
import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

interface HomepageMeta {
  title: string | null;
  description: string | null;
}

interface HomepagePage {
  url: string;
  meta?: HomepageMeta;
  og?: HomepageMeta;
}

/** Home page <title>/<meta description> from the audited root page. */
export function deriveHomepageSummary(report: {
  baseUrl: string;
  pages?: HomepagePage[];
}): HomepageMeta | undefined {
  const pages = report.pages ?? [];
  if (pages.length === 0) return undefined;
  let home = pages[0];
  try {
    // Require the root candidate to share the audited origin — a multi-domain
    // crawl can include another site's "/" page (mirrors the CLI picker).
    const baseOrigin = new URL(report.baseUrl).origin;
    home =
      pages.find((p) => {
        try {
          const u = new URL(p.url);
          return u.origin === baseOrigin && (u.pathname === "/" || u.pathname === "");
        } catch {
          return false;
        }
      }) ??
      pages.find((p) => p.url === report.baseUrl) ??
      pages[0];
  } catch {
    // baseUrl unparseable — fall back to the first crawled page.
  }
  const title = home.meta?.title ?? home.og?.title ?? null;
  const description = home.meta?.description ?? home.og?.description ?? null;
  if (!title && !description) return undefined;
  return { title, description };
}

/**
 * True when a `--rule-include`/`--rule-exclude` filter keeps `ruleId` from running (repo#1082):
 * an exclude pattern matches it, or there are include patterns and none match. Same precedence as
 * the engine (disable wins over enable). A rule the user opted out of is not a locked-rule upsell.
 */
export function isRuleFilteredOut(
  ruleId: string,
  partial: Pick<PartialAudit, "include" | "exclude"> | undefined,
): boolean {
  if (!partial) return false;
  const exclude = Array.isArray(partial.exclude) ? partial.exclude : [];
  const include = Array.isArray(partial.include) ? partial.include : [];
  if (exclude.some((p) => matchesRulePattern(ruleId, p))) return true;
  return include.length > 0 && !include.some((p) => matchesRulePattern(ruleId, p));
}

/** `locked` without the rules a `--rule-include`/`--rule-exclude` filter turned off (repo#1082). */
export function withoutFilteredLockedRules<T extends { id: string }>(
  locked: T[] | undefined,
  partial: Pick<PartialAudit, "include" | "exclude"> | undefined,
): T[] | undefined {
  if (!locked || !partial) return locked;
  return locked.filter((r) => !isRuleFilteredOut(r.id, partial));
}

/**
 * Cloud-/Pro-gated rules (meta.cloud) with no non-skipped check this run.
 * The list is an upsell ("run a cloud audit to unlock"), so it must only name
 * rules a paid run would actually produce (#656): unwired services and rules
 * the Stage-1 metadata gate skipped as not-applicable for this site type stay
 * off it — a cloud audit would skip them exactly the same way. So do rules
 * skipped because a setting turned their check off (repo#2729).
 */
export function computeLockedRules(
  report: {
    ruleResults: Record<string, { checks: Array<{ status: string; skipReason?: string }> }>;
    partialAudit?: Pick<PartialAudit, "include" | "exclude">;
  },
  rules: Iterable<Rule> = loadAllRules().values(),
): LockedRule[] {
  const locked: LockedRule[] = [];
  for (const rule of rules) {
    const cloud = rule.meta.cloud;
    if (!cloud) continue;
    if (isRuleFilteredOut(rule.meta.id, report.partialAudit)) continue;
    if (cloud.service && UNWIRED_CLOUD_SERVICES.has(cloud.service)) continue;
    const checks = report.ruleResults[rule.meta.id]?.checks;
    const ran = checks?.some((c) => c.status !== "skipped") ?? false;
    if (ran) continue;
    const notApplicable =
      checks != null &&
      checks.length > 0 &&
      checks.every((c) => isNotApplicableCloudSkip(c.skipReason));
    if (notApplicable) continue;
    // private#3792: a run configured not to render (`render: false`) skips the render
    // rule on purpose; a paid run would skip it the same way, so it is not an upsell.
    const renderDisabled =
      checks != null &&
      checks.length > 0 &&
      checks.every((c) => isRenderDisabledCloudSkip(c.skipReason));
    if (renderDisabled) continue;
    // repo#2729: a check the audit's settings turned off (external link
    // checking) is not something a cloud audit unlocks; the report's "Not
    // checked" note says what does.
    const notChecked =
      checks != null &&
      checks.length > 0 &&
      checks.every((c) => c.skipReason !== undefined && NOT_CHECKED_SKIP_REASONS.has(c.skipReason));
    if (notChecked) continue;
    locked.push({ id: rule.meta.id, name: rule.meta.name });
  }
  return locked;
}
