# Benchmarks

Measured performance records for the `squirrel` CLI and the audit engine. Every
performance change lands with a row here: what was measured, on what fixture,
how, on which machine, and the pull request that changed it. Release notes and
announcements draw their numbers from these files, never from memory.

| record | scope | headline |
|---|---|---|
| [2026-09 performance program](./2026-09-perf-program.md) | CLI, engine, hosted runtime | 2,500-page audit: 3.9 GB → 996 MB heap, 502 s → 177 s; cold crawl on a filled cache 833 → 26 ms/page |
| [2026-10 Content-Encoding bombs](./2026-10-content-encoding-bombs.md) | crawler, fetchers, root probes | audit of a site of 1 GiB compression bombs: 2.3-2.8 GB → 365 MB peak RSS; every fetch path now costs what an uncompressed body over its cap costs |
| [2026-10 Nested tables and text blocks](./2026-10-a11y-nested-tables.md) | rules (a11y tables, link-in-text-block) | 200 nested tables: `th-has-data-cells` 1,430 → 1 ms; 5,000: `td-headers-attr` 3,624 → 9 ms, `table-headers` 1,003 → 6 ms; 5,000 nested blockquotes: `link-in-text-block` 827 → 3 ms |
| [2026-10 Parse time on deeply nested pages](./2026-10-parse-depth.md) | parser | 20,000 nested links: `parsePage` 12.5 s → 250 ms, the crawler's `extractLinks` 64 s → 44 ms |

## Reproducing

The harness in [`harness/`](./harness/) serves a deterministic synthetic estate,
runs `squirrel audit` against it stage by stage (400 / 1,000 / 2,500 pages),
and records wall time, CPU, per-phase timings from `--trace`, `heapUsed` and
`external` sampled after a forced collection, and the OS high-water mark. See
[`harness/README.md`](./harness/README.md).

Rules that keep numbers honest, learned the hard way while producing these:

- Sample `process.memoryUsage()` after `Bun.gc(true)` at phase boundaries.
  Resident set size understates a Bun heap on a machine that is paging, and an
  interval timer is starved by the rules phase, which is one long synchronous
  block.
- Give each stage its own content store (`SQUIRREL_CONTENT_STORE_PATH`). The
  store at `~/.squirrel/content-store.db` is shared by every project on the
  machine, so a "cold" run against an existing store is neither cold nor
  comparable.
- Salt the fixture per stage, and quote the salt when you pass it: in zsh an
  unquoted `${SALT:+--salt $SALT}` arrives as one argument.
- Compare interleaved runs (old, new, old, new) rather than one block of each,
  and report the minimum over repeats; run-to-run variance on the same budget
  reached 100 MB.
- Subtract a retain-nothing control when measuring retention per page, and use
  per-page-distinct fixtures for anything keyed by URL: 150 copies of one page
  give a URL-keyed collector five keys.
