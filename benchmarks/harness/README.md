# Benchmark harness

Scripts used to produce [`../2026-09-perf-program.md`](../2026-09-perf-program.md)
and [`../2026-10-content-encoding-bombs.md`](../2026-10-content-encoding-bombs.md).
They are measurement tools, not part of the product, and they assume a checkout
of this repository with the workspace installed (`bun install` at the root).

| file | role |
|---|---|
| `site.ts` | Serves a deterministic mixed-shape estate (product / collection / docs / blog / listing / thin, mean ~128 KB per page) with a sitemap index, robots.txt, full link reachability, and a real cache policy (`max-age` + `stale-while-revalidate`, `ETag`, `Last-Modified`, 304s) so a warm stage has something to reuse. Takes a base page HTML file as its first argument; the record used a real 982 KB Shopify product page, which is not committed. Any large, script-heavy page works. A per-stage `--salt` makes a run genuinely cold. |
| `run-stage.sh` | Runs one `squirrel audit` stage (`--coverage full --max-pages N --http --offline --trace`) under `/usr/bin/time -l` with `mem-probe.ts` preloaded, a process-tree RSS sampler, and a kill guard (`BENCH_KILL_MB`, `BENCH_KILL_SEC`). `BENCH_CONTENT_STORE` gives the stage its own content store, and **`BENCH_PORT` pins the origin's port across the stages of a pair** — without it each stage gets a fresh port, the warm stage crawls a different origin, and it re-fetches everything because the content store is URL-keyed. |
| `stages.sh` | Cold then warm stage per page count, each cold stage on a fresh store. |
| `mem-probe.ts` | Preload: `process.memoryUsage()` on a timer, plus a sample after `Bun.gc(true)` at exit. The timer samples are starved by the rules phase (one long synchronous block), so only the exit sample is trustworthy. On Linux it also records the kernel's peak RSS (`VmHWM`) at exit, the equivalent of `/usr/bin/time -l`. |
| `report-heap.ts` | Rebuilds a stored audit's report with `reconstructReport` in a fresh process and writes a V8 heap snapshot of it, for heaps too large to snapshot inside the audit itself. |
| `heap-summary.ts` | Summarises a `.heapsnapshot`: self size by class, and plain objects by property shape with their solely-owned children, which is what names the holder in a JSC snapshot (its dominator tree comes out flat). |
| `rss-sampler.ts` | Process-tree RSS sampler with the guard. |
| `phases.ts` | Extracts per-phase timings from the CLI `--trace` output. |
| `analyze.ts` | Turns a stage directory into the summary table rows. |
| `script-heavy-page.ts` | Writes a deterministic script-heavy product page to stdout (about 1.15 MB, 59 inline scripts, about 790 KB of inline JavaScript, `--seed N`): the shape of the drscholls.com pages behind squirrelscan/repo#1864, generated so the measurement can be reproduced without the saved page. |
| `script-heavy-site.ts` | Serves N byte-unique copies of one base page (`script-heavy-page.ts`'s output, or any saved page) with a sitemap, so the per-page rule cost measured is the cost of that page. `--salt` makes a run cold against the content store. |
| `rule-profile.ts` | Sums a `SQUIRREL_RULE_PROFILE=1` audit's per-rule lines from its stderr: page rules, page-time collector and site rules per page, then the top rules. |
| `encoding-bomb.ts` | Peak RSS of the page fetchers and root probes against gzip and brotli bombs served from a separate process, for [`../2026-10-content-encoding-bombs.md`](../2026-10-content-encoding-bombs.md). `--root` measures another checkout's packages, which is how the before column was taken. |
| `component-findings-eval.ts` | Before/after evaluation of component-aware findings (repo#2307): runs the real link-text and stale-copyright rules and the real report grouping over the synthetic labelled cases in `packages/rules/tests/fixtures/component-eval/`, with evidence on and stripped, and prints a markdown table (`--json <path>` writes the full result, `--repeats <n>` sets timing repeats). For [`../2026-11-component-findings-eval.md`](../2026-11-component-findings-eval.md). |
| `content-language.ts` | Content-language detector benchmark: `bun benchmarks/harness/content-language.ts <corpus-dir> [--out=report.json] [--table] [--target=0.95] [--detector=<module>]`. Runs franc (the production language list), franc-all and any `--detector` module over a labelled corpus and writes an aggregate-only report: per-detector accuracy, precision, macro F1, per-language F1 with sample counts, accuracy by text length, latency, a confidence histogram and a suggested abstention floor. It never writes page text, URLs, hosts, file names or per-sample labels, so it can run on a private corpus and the result can be published. Corpus layouts: `*.jsonl` lines of `{"lang","text"}` or `{"lang","html"}`, or `<lang>/*.txt` and `<lang>/*.html`. |

Two opt-in CLI diagnostics pair with these. `SQUIRREL_STREAM_PHASE_MEM=1`
prints settled heap at every audit phase and streamed rules sub-phase
boundary, plus on Linux `peakRss=`, the peak since the previous boundary.
`SQUIRREL_HEAP_SNAPSHOT_DIR=<dir>` writes a V8 heap snapshot at each boundary
(`SQUIRREL_HEAP_SNAPSHOT_PHASES=rules,report` narrows it). Both collect, so a
run with either on is not the run whose peak or wall time you report.

Paths in `run-stage.sh` assume the harness runs from a monorepo checkout where
this repository is the `repo-public` submodule; adjust `HERE`/the CLI path for a
standalone clone. The scripts are zsh.
