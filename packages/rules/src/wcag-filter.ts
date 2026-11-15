// `--wcag-level` / `[rules] wcag_level` (repo#3093): only run the accessibility rules mapped to a WCAG
// success criterion at or below the level. Expressed as exact-id disable patterns so it rides the same
// enable/disable resolution as `--rule-exclude`; non-a11y rules are never touched.

import { meetsWcagTarget, type WcagLevel } from "@squirrelscan/core-contracts/wcag";

import type { RuleMeta } from "./types";

/**
 * Ids of the a11y rules the level leaves out: those with no criterion at or below `target` (an AAA-only
 * rule under `AA`), and those mapped to no criterion at all (`wcagNone`).
 */
export function wcagLevelDisablePatterns(
  metas: Iterable<Pick<RuleMeta, "id" | "category" | "wcag">>,
  target: WcagLevel,
): string[] {
  const out: string[] = [];
  for (const meta of metas) {
    if (meta.category !== "a11y") continue;
    if (!meta.wcag || meta.wcag.length === 0 || !meetsWcagTarget(meta.wcag, target))
      out.push(meta.id);
  }
  return out.sort();
}
