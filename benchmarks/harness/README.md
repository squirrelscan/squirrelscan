# Benchmark harness

Scripts used to produce [`../2026-09-perf-program.md`](../2026-09-perf-program.md).
They are measurement tools, not part of the product, and they assume a checkout
of this repository with the workspace installed (`bun install` at the root).

| file | role |
|---|---|
| `site.ts` | Serves a deterministic mixed-shape estate (product / collection / docs / blog / listing / thin, mean ~128 KB per page) with a sitemap index, robots.txt and full link reachability. Takes a base page HTML file as its first argument; the record used a real 982 KB Shopify product page, which is not committed. Any large, script-heavy page works. A per-stage `--salt` makes a run genuinely cold. |
| `run-stage.sh` | Runs one `squirrel audit` stage (`--coverage full --max-pages N --http --offline --trace`) under `/usr/bin/time -l` with `mem-probe.ts` preloaded, a process-tree RSS sampler, and a kill guard (`BENCH_KILL_MB`, `BENCH_KILL_SEC`). `BENCH_CONTENT_STORE` gives the stage its own content store. |
| `stages.sh` | Cold then warm stage per page count, each cold stage on a fresh store. |
| `mem-probe.ts` | Preload: `process.memoryUsage()` after `Bun.gc(true)` at exit and at phase boundaries. |
| `rss-sampler.ts` | Process-tree RSS sampler with the guard. |
| `phases.ts` | Extracts per-phase timings from the CLI `--trace` output. |
| `analyze.ts` | Turns a stage directory into the summary table rows. |

Paths in `run-stage.sh` assume the harness runs from a monorepo checkout where
this repository is the `repo-public` submodule; adjust `HERE`/the CLI path for a
standalone clone. The scripts are zsh.
