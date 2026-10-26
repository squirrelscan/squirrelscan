# 2026-10 Nested tables and text blocks

squirrelscan/repo#3355. Four a11y rules scanned a subtree once per matched element, so nested markup multiplied the work.

- `a11y/th-has-data-cells`, `a11y/td-headers-attr` and `a11y/table-headers` read each table's rows and cells with `table.querySelectorAll`. That query also returns the rows and cells of every table nested inside, so each outer table worked through everything below it. `th-has-data-cells` then scanned that whole grid again for each header.
- `a11y/link-in-text-block` took the links of each text block, so a link in nested blocks was visited once per enclosing block.

All four now do one walk of the page. A row and a cell belong to their nearest table, and a link is counted once. That also changes what the table rules report on nested tables: each table is judged on its own cells, as the HTML table model defines (see the rule docs). The parity test compares the rewrites with the previous implementations on 600 seeded random pages without nested tables, and on 600 pages of nested text blocks, with each link counted once (`packages/rules/tests/a11y-nested-tables-3355.test.ts`).

## How

Command: `bun benchmarks/harness/a11y-nested-tables.ts 200 1000 5000 20000`. The previous implementations ran with `--before`.

The shapes:
- **Tables:** each page nests N levels of `<table><tr><th id>h</th><td headers>` inside the previous cell.
- **Text blocks:** each page nests N `<blockquote>` elements, with an undecorated link at each level.

The timing is the rule's `run` only, the minimum of 3, and does not include parsing.

Machine: Apple Silicon laptop (macOS, arm64), Bun 1.4.0. Runs were at low priority (`nice 19`) under the shared heavy-command lock, with a load average around 13 from other work on the machine.

## Results

| rule | nesting | before | after |
|---|---:|---:|---:|
| `a11y/th-has-data-cells` | 200 | 1,723 ms | 2 ms |
| `a11y/th-has-data-cells` | 1,000 | not run (minutes) | 13 ms |
| `a11y/th-has-data-cells` | 20,000 | not run | 168 ms |
| `a11y/td-headers-attr` | 1,000 | 219 ms | 15 ms |
| `a11y/td-headers-attr` | 5,000 | 3,755 ms | 48 ms |
| `a11y/table-headers` | 1,000 | 50 ms | 8 ms |
| `a11y/table-headers` | 5,000 | 1,159 ms | 18 ms |
| `a11y/link-in-text-block` | 1,000 | 34 ms | 4 ms |
| `a11y/link-in-text-block` | 5,000 | 734 ms | 22 ms |
| `a11y/link-in-text-block` | 20,000 | not run | 34 ms |

The parse itself grows faster than the rules now do (18 s for 20,000 nested blockquotes). That cost is the parser's, tracked in squirrelscan/repo#3356.
