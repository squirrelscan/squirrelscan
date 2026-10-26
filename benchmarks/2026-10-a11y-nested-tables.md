# 2026-10 Nested tables and text blocks

squirrelscan/repo#3355. Four a11y rules scanned a subtree once per matched element, so nested markup multiplied the work.

- `a11y/th-has-data-cells`, `a11y/td-headers-attr` and `a11y/table-headers` read each table's rows and cells with `table.querySelectorAll`. That query also returns the rows and cells of every table nested inside, so each outer table worked through everything below it. `th-has-data-cells` queried each of those rows again for its cells, and searched each row's grid from column 0 for every cell it placed.
- `a11y/link-in-text-block` took the links of each text block, so a link in nested blocks was visited once per enclosing block.

All four now do one walk of the page. A row and a cell belong to their nearest table, and a link is counted once. That also changes what `th-has-data-cells` and `td-headers-attr` report on nested tables: each table is judged on its own cells, as the HTML table model defines (see the rule docs). `table-headers` reports as before. The parity test compares the rewrites with the previous implementations on seeded random pages: 600 without nested tables for the three table rules, 600 of nested tables for `table-headers`, and 600 of nested text blocks for `link-in-text-block` with each link counted once (`packages/rules/tests/a11y-nested-tables-3355.test.ts`).

## How

Command: `bun benchmarks/harness/a11y-nested-tables.ts 200 1000 5000 20000`. The previous implementations ran with `--before`.

The shapes:
- **Tables:** each page nests N levels of `<table><tr><th id>h</th><td headers>` inside the previous cell.
- **Text blocks:** each page nests N `<blockquote>` elements, with an undecorated link at each level.

The timing is the rule's `run` only, the minimum of 3, and does not include parsing.

Machine: Apple Silicon laptop (macOS, arm64), Bun 1.4.0. Runs were at low priority (`nice 19`) under the shared heavy-command lock, with a load average of 4 to 6 from other work on the machine. The before and after runs were taken minutes apart at that load.

## Results

| rule | nesting | before | after |
|---|---:|---:|---:|
| `a11y/th-has-data-cells` | 200 | 1,430 ms | 1 ms |
| `a11y/th-has-data-cells` | 1,000 | not run (minutes) | 5 ms |
| `a11y/th-has-data-cells` | 20,000 | not run | 63 ms |
| `a11y/td-headers-attr` | 1,000 | 161 ms | 3 ms |
| `a11y/td-headers-attr` | 5,000 | 3,624 ms | 9 ms |
| `a11y/td-headers-attr` | 20,000 | not run | 64 ms |
| `a11y/table-headers` | 1,000 | 50 ms | 2 ms |
| `a11y/table-headers` | 5,000 | 1,003 ms | 6 ms |
| `a11y/table-headers` | 20,000 | not run | 38 ms |
| `a11y/link-in-text-block` | 1,000 | 33 ms | 1 ms |
| `a11y/link-in-text-block` | 5,000 | 827 ms | 3 ms |
| `a11y/link-in-text-block` | 20,000 | not run | 38 ms |

The parse itself grows faster than the rules now do (12.5 s for 20,000 nested blockquotes). That cost is the parser's, tracked in squirrelscan/repo#3356.
