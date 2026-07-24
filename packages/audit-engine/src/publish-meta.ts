// Report "publish-prep" for both paths — the CLI publish controller re-exports
// computeLockedRules from here (the duck-typed report shape below is satisfied
// structurally by the CLI's vendored AuditReport), and runCloudAudit calls it
// directly, so cloud and CLI reports stamp identical `homepage`/`lockedRules`.

import type { LockedRule } from "@squirrelscan/core-contracts";
import {
  isNotApplicableCloudSkip,
  loadAllRules,
  UNWIRED_CLOUD_SERVICES,
  type Rule,
} from "@squirrelscan/rules";

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
 * Cloud-/Pro-gated rules (meta.cloud) with no non-skipped check this run.
 * The list is an upsell ("run a cloud audit to unlock"), so it must only name
 * rules a paid run would actually produce (#656): unwired services and rules
 * the Stage-1 metadata gate skipped as not-applicable for this site type stay
 * off it — a cloud audit would skip them exactly the same way.
 */
export function computeLockedRules(
  report: {
    ruleResults: Record<string, { checks: Array<{ status: string; skipReason?: string }> }>;
  },
  rules: Iterable<Rule> = loadAllRules().values(),
): LockedRule[] {
  const locked: LockedRule[] = [];
  for (const rule of rules) {
    const cloud = rule.meta.cloud;
    if (!cloud) continue;
    if (cloud.service && UNWIRED_CLOUD_SERVICES.has(cloud.service)) continue;
    const checks = report.ruleResults[rule.meta.id]?.checks;
    const ran = checks?.some((c) => c.status !== "skipped") ?? false;
    if (ran) continue;
    const notApplicable =
      checks != null &&
      checks.length > 0 &&
      checks.every((c) => isNotApplicableCloudSkip(c.skipReason));
    if (notApplicable) continue;
    locked.push({ id: rule.meta.id, name: rule.meta.name });
  }
  return locked;
}
