// a11y/table-duplicate-name - Tables have unique accessible names

import { hasAttrCI } from "@squirrelscan/utils";

import {
  type ControlItem,
  createStaticVisibility,
  type StaticVisibility,
  unconfirmedItem,
  unconfirmedRow,
} from "../shared/static-hidden";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Whether `inert` on the table or an ancestor takes it out of the accessibility tree. */
function isInert(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (hasAttrCI(node, "inert")) return true;
  }
  return false;
}

function getTableName(table: Element, doc: Document): string | null {
  // Check aria-label
  const ariaLabel = table.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  // Check aria-labelledby
  const labelledBy = table.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const labels = ids
      .map((id) => doc.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (labels.length > 0) return labels.join(" ");
  }

  // Check caption
  const caption = table.querySelector("caption");
  if (caption?.textContent?.trim()) {
    return caption.textContent.trim();
  }

  return null;
}

export const tableDuplicateNameRule: Rule = {
  meta: {
    id: "a11y/table-duplicate-name",
    name: "Table Duplicate Name",
    description: "Checks that data tables have unique accessible names",
    solution:
      "When a page has multiple data tables, each should have a unique accessible name to help users distinguish between them. Use <caption>, aria-label, or aria-labelledby with unique text for each table.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Get data tables (exclude layout tables)
    const allTables = doc.querySelectorAll(
      "table:not([role='presentation']):not([role='none'])"
    );

    // #1637: a table out of the accessibility tree (a closed <dialog>, a
    // `hidden`, `inert`, aria-hidden or `display:none` ancestor) is not in a
    // screen reader's table list, so it cannot collide with an exposed one.
    // It is counted, not dropped, and a table a style may hide but squirrel
    // cannot settle is kept apart as unconfirmed.
    const visibility = createStaticVisibility({ ariaHidden: true });
    const tables: Element[] = [];
    const unsettled: Array<{ table: Element; seen: StaticVisibility }> = [];
    let hiddenTables = 0;
    for (const table of allTables) {
      const seen: StaticVisibility = isInert(table)
        ? { state: "hidden" }
        : visibility.visibility(table);
      if (seen.state === "hidden") hiddenTables++;
      else if (seen.state === "unknown") unsettled.push({ table, seen });
      else tables.push(table);
    }
    const hiddenDetails = hiddenTables > 0 ? { hiddenTables } : {};

    if (tables.length + unsettled.length <= 1) {
      checks.push({
        name: "table-duplicate-name",
        status: "info",
        message:
          tables.length + unsettled.length === 1
            ? "Only one table found"
            : "No data tables found",
        ...(hiddenTables > 0 ? { details: hiddenDetails } : {}),
      });
      return { checks };
    }

    const tableNames = new Map<string, Element[]>();
    const tablesWithoutNames: Element[] = [];

    for (const table of tables) {
      const name = getTableName(table, doc);

      if (!name) {
        tablesWithoutNames.push(table);
      } else {
        const normalized = name.toLowerCase().trim();
        if (!tableNames.has(normalized)) {
          tableNames.set(normalized, []);
        }
        tableNames.get(normalized)?.push(table);
      }
    }

    // A name an unsettled table shares with another table is a duplicate only
    // if the style that may hide it does not, so it is reported as unconfirmed.
    const unsettledByName = new Map<string, StaticVisibility[]>();
    for (const { table, seen } of unsettled) {
      const name = getTableName(table, doc)?.toLowerCase().trim();
      if (!name) continue;
      if (!unsettledByName.has(name)) unsettledByName.set(name, []);
      unsettledByName.get(name)?.push(seen);
    }

    const duplicateNames: string[] = [];
    for (const [name, tablesWithName] of tableNames) {
      if (tablesWithName.length > 1) {
        duplicateNames.push(`"${name}" (${tablesWithName.length} tables)`);
      }
    }

    if (duplicateNames.length > 0) {
      checks.push({
        name: "table-duplicate-name",
        status: "warn",
        message: `${duplicateNames.length} duplicate table name(s) found`,
        items: duplicateNames.map((id) => ({ id })),
        details: {
          suggestion: "Give each table a unique caption or aria-label",
          ...hiddenDetails,
        },
      });
    }

    const unconfirmedNames: ControlItem[] = [];
    for (const [name, seen] of unsettledByName) {
      const exposed = tableNames.get(name)?.length ?? 0;
      if (exposed > 1 || exposed + seen.length < 2) continue;
      unconfirmedNames.push(
        unconfirmedItem(`"${name}" (${exposed + seen.length} tables)`, seen[0])
      );
    }
    if (unconfirmedNames.length > 0) {
      checks.push(
        unconfirmedRow("table-duplicate-name", "duplicate table name(s)", unconfirmedNames)
      );
    }

    if (tablesWithoutNames.length > 0 && tables.length + unsettled.length > 1) {
      checks.push({
        name: "tables-without-names",
        status: "warn",
        message: `${tablesWithoutNames.length} table(s) without accessible names`,
        details: {
          note: "Add caption or aria-label to distinguish tables",
        },
      });
    }

    if (
      duplicateNames.length === 0 &&
      tablesWithoutNames.length === 0 &&
      unconfirmedNames.length === 0
    ) {
      checks.push({
        name: "table-duplicate-name",
        status: "pass",
        message: "All tables have unique accessible names",
        details: { tablesChecked: tables.length, ...hiddenDetails },
      });
    }

    return { checks };
  },
};
