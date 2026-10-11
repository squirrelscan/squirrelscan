// Rule text joined from the rule catalog at render time (squirrelscan/repo#2656).
//
// A capped published report carries each rule's identity and scoring fields
// but not its description or solution: that text is the same in every report,
// and it lives in one place, the rule catalog (the same source the docs and the
// dashboard read). Whoever renders a report joins the text back here, from the
// catalog it has: the API's generated catalog, or the CLI's loaded rules.
//
// The catalog wins whenever it knows the rule, so every report, old or new,
// shows the current text. A rule the catalog no longer has keeps whatever text
// its report carried, which is what an old report of a retired rule needs.

/** The rule text a catalog entry supplies. */
export interface RuleCatalogText {
  description?: string;
  solution?: string;
}

/** Rule id → its catalog text, or undefined for a rule the catalog does not have. */
export type RuleCatalogLookup = (ruleId: string) => RuleCatalogText | undefined;

/** A lookup over catalog entries (any list of `{ id, description, solution }`). */
export function ruleCatalogLookup(
  entries: Iterable<{ id: string } & RuleCatalogText>,
): RuleCatalogLookup {
  const byId = new Map<string, RuleCatalogText>();
  for (const entry of entries) {
    byId.set(entry.id, { description: entry.description, solution: entry.solution });
  }
  return (ruleId) => byId.get(ruleId);
}

interface MetaWithText {
  id?: string;
  description: string;
  solution?: string;
}

/**
 * `report` with every rule's `description` and `solution` taken from the
 * catalog. Returns the same object when nothing changes, and otherwise a
 * shallow copy (new `ruleResults` entries, the same `checks` arrays), so the
 * input is never mutated.
 */
export function withCatalogRuleText<
  R extends { ruleResults: Record<string, { meta: MetaWithText }> },
>(report: R, lookup: RuleCatalogLookup): R {
  let changed = false;
  const ruleResults: Record<string, { meta: MetaWithText }> = {};
  for (const [ruleId, rule] of Object.entries(report.ruleResults)) {
    const text = lookup(rule.meta.id ?? ruleId);
    const description = text?.description || rule.meta.description;
    const solution = text?.solution ?? rule.meta.solution;
    if (description === rule.meta.description && solution === rule.meta.solution) {
      ruleResults[ruleId] = rule;
      continue;
    }
    changed = true;
    ruleResults[ruleId] = {
      ...rule,
      meta: {
        ...rule.meta,
        description,
        ...(solution !== undefined ? { solution } : {}),
      },
    };
  }
  return changed ? ({ ...report, ruleResults } as R) : report;
}
