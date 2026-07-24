// a11y/table-duplicate-name - Tables have unique accessible names

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

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
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Get data tables (exclude layout tables)
    const tables = doc.querySelectorAll(
      "table:not([role='presentation']):not([role='none'])"
    );

    if (tables.length <= 1) {
      checks.push({
        name: "table-duplicate-name",
        status: "info",
        message:
          tables.length === 1 ? "Only one table found" : "No data tables found",
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
        },
      });
    }

    if (tablesWithoutNames.length > 0 && tables.length > 1) {
      checks.push({
        name: "tables-without-names",
        status: "warn",
        message: `${tablesWithoutNames.length} table(s) without accessible names`,
        details: {
          note: "Add caption or aria-label to distinguish tables",
        },
      });
    }

    if (duplicateNames.length === 0 && tablesWithoutNames.length === 0) {
      checks.push({
        name: "table-duplicate-name",
        status: "pass",
        message: "All tables have unique accessible names",
        details: { tablesChecked: tables.length },
      });
    }

    return { checks };
  },
};
