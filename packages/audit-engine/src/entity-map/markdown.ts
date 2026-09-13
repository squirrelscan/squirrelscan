// Standalone markdown document for an entity map (#2061/#2091).
//
// The body is the same section the markdown report embeds, so the two can never
// disagree about what the map said; this file only supplies the document
// heading and the provenance line around it.

// Subpath, not the package root: the root re-exports the JSX report renderer
// and this package does not compile with `--jsx`.
import { entityMarkdownSection } from "@squirrelscan/report/entities";
import type { EntityMap } from "@squirrelscan/core-contracts/entity-map";

/**
 * Render an entity map as a standalone markdown document.
 *
 * Deterministic for a given map: the section reads the map's own sorted arrays,
 * and the only varying input is `generatedAt`.
 */
export function renderEntityMapMarkdown(map: EntityMap): string {
  const lines: string[] = [
    "# Entity map",
    "",
    `**Site:** ${map.site}  `,
    `**Generated:** ${map.generatedAt}  `,
    `**Format:** ${map.format} v${map.version}`,
    "",
    ...entityMarkdownSection(map, "##"),
  ];
  return `${lines.join("\n")}\n`;
}
