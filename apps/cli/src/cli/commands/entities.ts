// `squirrel entities` (#2092) — query the entity map of a stored audit.
//
// Shaped like `squirrel report`: same flag names, same project-scoped store
// access, same `--input` escape hatch. The map itself is built by every audit
// (#2091); this command only reads, filters and re-renders it.
//
// Exit code is 0 on every path, deliberately. The rules fail an audit; a map is
// a description of what a site declares, and "this site declares nothing" is an
// answer, not an error. Only a usage mistake or an unreadable store exits 1.

import type { EntityMap } from "@squirrelscan/audit-engine/entity-map";

import {
  renderEntityMapHtml,
  renderEntityMapMarkdown,
  toJsonLd,
} from "@squirrelscan/audit-engine/entity-map";
import { diffEntityMaps } from "@squirrelscan/audit-engine/entity-map";
import {
  ENTITY_TABLE_LIMIT,
  conflictedEntities,
  danglingEdges,
  danglingTargetId,
  entitiesWithoutId,
  entityLabel,
  entityPageTotal,
  entitySummaryLine,
  primaryEntities,
  renderEntitiesCsv,
  renderEntitiesDot,
  renderEntitiesGraphml,
  renderEntitiesMermaid,
  renderEntityDiffMarkdown,
  stableIdPercent,
} from "@squirrelscan/report";
import { defineCommand } from "citty";
import { writeFileSync } from "node:fs";

import {
  listEntityMaps,
  loadEntityMap,
  loadEntityMapFile,
} from "@/controllers/entities";
import { ErrorCodes } from "@/controllers/types";
import {
  ENTITY_PROBLEMS,
  filterEntityMap,
  findEntity,
  hasEntityFilters,
  isEntityProblem,
  splitListFlag,
  type EntityFilters,
  type EntityProblem,
} from "@/entities/filters";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { safeExit } from "@/self/updater";

import { fmt } from "../format";

/** Every `-f` value this command accepts. */
export const ENTITY_FORMATS = [
  "json",
  "jsonld",
  "html",
  "markdown",
  "csv",
  "dot",
  "graphml",
  "mermaid",
] as const;

export type EntityFormat = (typeof ENTITY_FORMATS)[number];

export function isEntityFormat(value: string): value is EntityFormat {
  return (ENTITY_FORMATS as readonly string[]).includes(value);
}

/** `--diff` renders as prose or as a change set a CI job can parse. */
const DIFF_FORMATS = ["markdown", "json"] as const;

/**
 * Render one map in the requested format.
 *
 * Every format receives the FILTERED map, so `--type Organization -f graphml`
 * hands Gephi the filtered graph rather than the whole one.
 */
function renderMap(map: EntityMap, format: EntityFormat): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(map, null, 2)}\n`;
    case "jsonld":
      return `${JSON.stringify(toJsonLd(map), null, 2)}\n`;
    case "html":
      return renderEntityMapHtml(map);
    case "markdown":
      return renderEntityMapMarkdown(map);
    case "csv":
      return renderEntitiesCsv(map);
    case "dot":
      return renderEntitiesDot(map);
    case "graphml":
      return renderEntitiesGraphml(map);
    case "mermaid":
      return renderEntitiesMermaid(map);
  }
}

/** The default summary view: what a reader sees with no flags at all. */
function printSummary(map: EntityMap, crawlLabel: string): void {
  console.log("");
  console.log(fmt.bold("ENTITY MAP"));
  console.log(fmt.dim(`${map.site} · ${crawlLabel}`));
  console.log("");

  if (map.summary.nodeCount === 0) {
    console.log("This site declares no JSON-LD entities on any crawled page.");
    console.log(
      fmt.dim(
        "Search engines have nothing to reconcile it into. See https://docs.squirrelscan.com"
      )
    );
    return;
  }

  console.log(entitySummaryLine(map));
  console.log("");

  for (const node of primaryEntities(map).slice(0, 10)) {
    const id = node.id ? fmt.dim(` ${node.id}`) : fmt.yellow(" no @id");
    console.log(
      `${fmt.bold(entityLabel(node))} ${fmt.dim(`(${node.types.join(", ")})`)} ` +
        fmt.dim(`${node.occurrences}x on ${entityPageTotal(node)} page(s)`) +
        id
    );
  }

  const problems: string[] = [];
  if (map.summary.nodesWithoutIdCount > 0) {
    problems.push(
      `${map.summary.nodesWithoutIdCount} declared on several pages with no @id`
    );
  }
  if (map.summary.conflictCount > 0) {
    problems.push(
      `${map.summary.conflictCount} disagreeing with themselves across pages`
    );
  }
  if (map.summary.danglingCount > 0) {
    problems.push(
      `${map.summary.danglingCount} references to entities nothing declares`
    );
  }
  if (problems.length > 0) {
    console.log("");
    for (const problem of problems) console.log(fmt.yellow(`• ${problem}`));
    console.log(
      fmt.dim(
        "squirrel entities --problem no-id|conflict|dangling for the detail"
      )
    );
  }
}

/**
 * One entity in full: the `squirrel entities <@id|key|name>` view.
 *
 * Returns the text rather than printing it, so `-o` can write the same bytes to
 * a file. A view that quietly ignored the output path the user named would be
 * worse than one that refused it.
 */
function renderEntity(map: EntityMap, query: string): string {
  const out: string[] = [];
  const line = (text = "") => out.push(text);

  const node = findEntity(map, query);
  if (!node) {
    line(`No entity matching "${query}".`);
    line(
      fmt.dim(
        "squirrel entities --list, or squirrel entities to see what is there."
      )
    );
    return `${out.join("\n")}\n`;
  }

  line();
  line(fmt.bold(entityLabel(node)));
  line(fmt.dim(node.types.join(", ")));
  line();
  line(
    `${"@id".padEnd(14)}${node.id ?? fmt.yellow("none — synthetic identity")}`
  );
  line(`${"key".padEnd(14)}${fmt.dim(node.key)}`);
  line(
    `${"occurrences".padEnd(14)}${node.occurrences} on ${entityPageTotal(node)} page(s)`
  );
  if (node.pageLocal) {
    line(`${"scope".padEnd(14)}${fmt.dim("page-local (describes one page)")}`);
  }

  const properties = Object.entries(node.properties);
  if (properties.length > 0) {
    line();
    for (const [name, value] of properties) {
      line(
        `${name.padEnd(14)}${Array.isArray(value) ? value.join(", ") : String(value)}`
      );
    }
  }

  if (node.conflicts.length > 0) {
    line();
    line(fmt.yellow("CONFLICTS"));
    for (const conflict of node.conflicts) {
      line(`  ${conflict.property}`);
      for (const value of conflict.values) {
        const pages = value.pages.length + value.morePages;
        line(`    ${value.value} ${fmt.dim(`on ${pages} page(s)`)}`);
      }
    }
  }

  const outgoing = map.edges.filter((edge) => edge.source === node.key);
  if (outgoing.length > 0) {
    line();
    line(fmt.bold("REFERENCES"));
    for (const edge of outgoing.slice(0, 20)) {
      const target = danglingTargetId(edge);
      const mark = edge.dangling ? fmt.red(" (nothing declares this)") : "";
      line(`  ${edge.predicate} → ${target}${mark}`);
    }
  }

  line();
  line(fmt.bold("DECLARED ON"));
  for (const page of node.pages.slice(0, 20)) line(`  ${page}`);
  const hidden =
    node.pages.length + node.morePages - Math.min(node.pages.length, 20);
  if (hidden > 0) line(fmt.dim(`  +${hidden} more`));
  return `${out.join("\n")}\n`;
}

/** The `--list` table, as text, so `-o` works here too. */
function renderList(
  rows: Array<{
    crawlId: string;
    baseUrl: string;
    startedAt: number;
    pages: number;
    entities: number;
    stableIdShare: number;
    conflicts: number;
    retiredAt?: number;
  }>
): string {
  if (rows.length === 0) {
    return `No stored audit carries an entity map.\nRun "squirrel audit <url>" to create one.\n`;
  }

  const out: string[] = [
    "Entity maps:",
    "=".repeat(94),
    "ID".padEnd(11) +
      "Date".padEnd(22) +
      "Pages".padEnd(8) +
      "Entities".padEnd(10) +
      "Stable @id".padEnd(12) +
      "Conflicts".padEnd(11) +
      "Site",
    "-".repeat(94),
  ];
  for (const row of rows) {
    const share = `${Math.round(row.stableIdShare * 100)}%`;
    // A reclaimed audit still lists: keeping the row is the point of #1912, and
    // a silent gap reads as data loss.
    const site =
      row.retiredAt !== undefined
        ? `${row.baseUrl} ${fmt.dim("(reclaimed)")}`
        : row.baseUrl;
    out.push(
      row.crawlId.slice(0, 8).padEnd(11) +
        new Date(row.startedAt).toLocaleString().padEnd(22) +
        String(row.pages).padEnd(8) +
        String(row.entities).padEnd(10) +
        share.padEnd(12) +
        String(row.conflicts).padEnd(11) +
        site
    );
  }
  return `${out.join("\n")}\n`;
}

/**
 * Terminal colour sequences, for stripping on the way to a file.
 *
 * `fmt` decides on colour from whether stdout is a TTY, which is the right
 * question for stdout and the wrong one for `-o`: running in a terminal would
 * otherwise write escape bytes into the file.
 *
 * Built rather than written as a literal. Matching ESC is the whole point
 * here, but a control character inside a regex literal is almost always a
 * mistake, so the linter rejects one however it is spelled.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Write to `-o`, or to stdout. */
function emit(content: string, outputPath: string | undefined): void {
  if (outputPath) {
    writeFileSync(outputPath, content.replace(ANSI, ""));
    console.error(`Wrote ${outputPath}`);
    return;
  }
  process.stdout.write(content);
}

export const entities = defineCommand({
  meta: {
    name: "entities",
    description: "Query the entity map of a stored audit",
  },
  args: {
    query: {
      type: "positional",
      description:
        "Entity @id, key or name (defaults to a summary of the latest audit)",
      required: false,
    },
    list: {
      type: "boolean",
      alias: "l",
      description: "List stored audits and their entity counts",
    },
    crawl: {
      type: "string",
      description:
        "Crawl ID (or 8-char prefix) to read (defaults to the latest with a map)",
    },
    type: {
      type: "string",
      description:
        "Only entities of these @types (repeatable or comma-separated)",
    },
    page: {
      type: "string",
      description:
        "Only entities declared on pages matching this URL or prefix (repeatable)",
    },
    problem: {
      type: "string",
      description: `Only entities with these problems: ${ENTITY_PROBLEMS.join(", ")} (repeatable)`,
    },
    format: {
      type: "string",
      alias: "f",
      description: `Output format: ${ENTITY_FORMATS.join(", ")} (default: a console summary, or markdown when piped)`,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Write to a file instead of stdout",
    },
    input: {
      type: "string",
      alias: "i",
      description:
        "Read an exported entity map JSON instead of the store (repeatable for --diff)",
    },
    diff: {
      type: "boolean",
      description: "Compare two audits: the previous and latest by default",
    },
  },
  async run({ args }) {
    warnIfSessionUnreadable();

    // A path may contain a comma, so `--input` is repeat-only. Every other
    // list flag takes values that cannot, and stays comma-splittable.
    const rawInput = args.input as string | string[] | undefined;
    const givenInputs = Array.isArray(rawInput)
      ? rawInput
      : rawInput === undefined
        ? []
        : [rawInput];
    const inputs = givenInputs.filter((value) => value.length > 0);
    if (givenInputs.length > 0 && inputs.length === 0) {
      // `--input ""` asked for a file. Falling through to the store would
      // answer a question the user did not ask, from data they did not name.
      console.error("--input needs a file path, got an empty value");
      return safeExit(1);
    }
    const filters: EntityFilters = {};
    const types = splitListFlag(args.type as string | string[] | undefined);
    const pages = splitListFlag(args.page as string | string[] | undefined);
    const problemValues = splitListFlag(
      args.problem as string | string[] | undefined
    );
    if (types.length > 0) filters.types = types;
    if (pages.length > 0) filters.pages = pages;

    const unknownProblems = problemValues.filter(
      (value) => !isEntityProblem(value)
    );
    if (unknownProblems.length > 0) {
      console.error(
        `--problem: unknown value ${unknownProblems.join(", ")} (expected ${ENTITY_PROBLEMS.join(", ")})`
      );
      return safeExit(1);
    }
    if (problemValues.length > 0)
      filters.problems = problemValues as EntityProblem[];

    // ── --list ───────────────────────────────────────────────────────
    if (args.list) {
      const result = await listEntityMaps(20);
      if (!result.ok) {
        console.error(result.error.message);
        return safeExit(1);
      }
      emit(renderList(result.data), args.output);
      return;
    }

    // ── --diff ───────────────────────────────────────────────────────
    if (args.diff) {
      const diffFormat = args.format ?? "markdown";
      if (!(DIFF_FORMATS as readonly string[]).includes(diffFormat)) {
        console.error(
          `--diff supports ${DIFF_FORMATS.join(" or ")}, got --format ${diffFormat}`
        );
        return safeExit(1);
      }

      if (filters.problems?.length) {
        // Filtering each side independently breaks exactly the transitions a
        // diff exists to show: an entity that gained an `@id` stops matching
        // `no-id` on the newer side, so the older one is reported as removed.
        console.error(
          "--problem cannot be combined with --diff: a problem is what CHANGES between two audits, so filtering both sides by it reports fixes as removals. Use --type or --page instead."
        );
        return safeExit(1);
      }

      let older: EntityMap;
      let newer: EntityMap;

      if (inputs.length === 2) {
        const a = loadEntityMapFile(inputs[0]!);
        const b = loadEntityMapFile(inputs[1]!);
        if (!a.ok) {
          console.error(a.error.message);
          return safeExit(1);
        }
        if (!b.ok) {
          console.error(b.error.message);
          return safeExit(1);
        }
        older = a.data;
        newer = b.data;
      } else if (inputs.length !== 0) {
        // One is ambiguous and three or more is a mistake; both used to fall
        // through to a store comparison that ignored the files entirely.
        console.error(
          `--diff with --input needs exactly two files, got ${inputs.length}: --input old.json --input new.json`
        );
        return safeExit(1);
      } else {
        // Two crawl ids, or the previous and latest OF ONE SITE. The store
        // holds every project, so "the two newest audits" are routinely two
        // different sites, and diffing those reports one site's entire graph as
        // added and the other's as removed.
        const ids = splitListFlag(args.crawl as string | string[] | undefined);

        let olderId: string | undefined;
        let newerId: string | undefined;
        if (ids.length >= 2) {
          // Two named audits are the user's choice, including across sites.
          // Nothing is listed in this case: a listing reads the entity rows of
          // every crawl in every project, which is real work to skip.
          olderId = ids[0];
          newerId = ids[1];
        } else {
          const listed = await listEntityMaps(50);
          if (!listed.ok) {
            console.error(listed.error.message);
            return safeExit(1);
          }
          // Newest first, already, from `listEntityMaps`.
          const withMaps = listed.data.filter((row) => row.entities > 0);
          // One id names the NEWER side; the older one is whatever preceded it
          // on the same site.
          const anchorIndex = ids[0]
            ? withMaps.findIndex(
                (row) =>
                  row.crawlId === ids[0] || row.crawlId.startsWith(ids[0]!)
              )
            : 0;
          const anchor = anchorIndex >= 0 ? withMaps[anchorIndex] : undefined;

          // Re-listed scoped to the anchor's site rather than searched inside
          // the 50 rows above: that window is global and ordered by time, so a
          // busy site can bury a quiet site's previous audit past the end, and
          // "only one audit has a map" would be a lie about the history.
          let previous: (typeof withMaps)[number] | undefined;
          if (anchor) {
            const sameSite = await listEntityMaps(200, {
              baseUrl: anchor.baseUrl,
            });
            if (!sameSite.ok) {
              console.error(sameSite.error.message);
              return safeExit(1);
            }
            previous = sameSite.data
              .filter(
                (row) => row.entities > 0 && row.startedAt < anchor.startedAt
              )
              .find(() => true);
          }
          newerId = anchor?.crawlId;
          olderId = previous?.crawlId;
          if (!olderId || !newerId) {
            console.log(
              anchor
                ? `Need two audits of ${anchor.baseUrl} to compare; only one has an entity map so far.`
                : ids[0]
                  ? `No audit with an entity map matches "${ids[0]}".`
                  : "Need two audits to compare; none has an entity map yet."
            );
            console.log(
              fmt.dim('Run "squirrel audit <url>" again, then re-run this.')
            );
            return;
          }
        }
        const a = await loadEntityMap(olderId);
        const b = await loadEntityMap(newerId);
        if (!a.ok) {
          console.error(a.error.message);
          return safeExit(1);
        }
        if (!b.ok) {
          console.error(b.error.message);
          return safeExit(1);
        }
        // Chronological regardless of the order they were named, so
        // `--diff <new> <old>` still reads as a forward change set.
        const [first, second] =
          a.data.crawl.startedAt <= b.data.crawl.startedAt
            ? [a.data, b.data]
            : [b.data, a.data];
        older = first.map;
        newer = second.map;
      }

      const diff = diffEntityMaps(
        filterEntityMap(older, filters),
        filterEntityMap(newer, filters)
      );
      emit(
        diffFormat === "json"
          ? `${JSON.stringify(diff, null, 2)}\n`
          : renderEntityDiffMarkdown(diff),
        args.output
      );
      return;
    }

    // ── one map ──────────────────────────────────────────────────────
    let map: EntityMap;
    let crawlLabel: string;

    if (inputs.length > 0) {
      if (inputs.length > 1) {
        console.error("--input takes one file unless you also pass --diff");
        return safeExit(1);
      }
      const loaded = loadEntityMapFile(inputs[0]!);
      if (!loaded.ok) {
        console.error(loaded.error.message);
        return safeExit(1);
      }
      map = loaded.data;
      crawlLabel = inputs[0]!;
    } else {
      const loaded = await loadEntityMap(args.crawl);
      if (!loaded.ok) {
        // Nothing stored is an ANSWER: exit 0 and say what to run next. A store
        // that could not be read is a FAILURE, and a script that treats the two
        // alike would take a broken database for an empty one.
        if (loaded.error.code === ErrorCodes.CRAWL_NOT_FOUND) {
          console.log(loaded.error.message);
          return;
        }
        console.error(loaded.error.message);
        return safeExit(1);
      }
      map = loaded.data.map;
      crawlLabel = `${loaded.data.crawl.id.slice(0, 8)} · ${new Date(loaded.data.crawl.startedAt).toLocaleString()}`;
      for (const warning of loaded.data.warnings ?? []) {
        // An answer drawn from part of the data says so.
        console.error(
          `Warning: a project store could not be read (${warning})`
        );
      }
      if (loaded.data.skipped) {
        // Never substitute older data silently. The store cannot tell a site
        // that declares nothing from an audit that stored no map, so say which
        // audit was passed over and let the reader judge.
        const { crawlId, startedAt } = loaded.data.skipped;
        console.error(
          `Note: audit ${crawlId.slice(0, 8)} (${new Date(startedAt).toLocaleString()}) is newer but stored no entity map, so this is the previous one. Re-run "squirrel audit" if that is unexpected.`
        );
      }
    }

    const filtered = filterEntityMap(map, filters);

    // Single-entity lookup ignores --format: it is a human question. It does
    // honour -o, because silently writing nothing to the file the user named is
    // the worst of the available behaviours.
    if (args.query) {
      emit(renderEntity(filtered, args.query), args.output);
      return;
    }

    if (args.format) {
      if (!isEntityFormat(args.format)) {
        console.error(
          `--format: unknown value "${args.format}" (expected ${ENTITY_FORMATS.join(", ")})`
        );
        return safeExit(1);
      }
      emit(renderMap(filtered, args.format), args.output);
      return;
    }

    // No --format: a console summary for a person, markdown for a pipe. An
    // agent running `squirrel entities | …` gets something parseable without
    // having to know the flag.
    if (args.output || !process.stdout.isTTY) {
      emit(renderEntityMapMarkdown(filtered), args.output);
      return;
    }

    printSummary(filtered, crawlLabel);
    if (hasEntityFilters(filters)) {
      console.log("");
      console.log(
        fmt.dim(
          `Filtered: ${filtered.summary.nodeCount} of ${map.summary.nodeCount} entities match.`
        )
      );
    }
  },
});
