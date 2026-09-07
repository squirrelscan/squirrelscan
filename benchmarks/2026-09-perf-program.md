# 2026-09 performance program

Measurements from the 7 to 8 September 2026 performance pass on the `squirrel`
CLI, the audit engine and the hosted runtime. Everything here was measured, on
the machines and fixtures stated, and each row links the change that produced
it. The CLI runs on Bun 1.4 since v0.0.91.

Machine for the CLI rows unless stated: 16 GB Apple Silicon laptop under heavy
memory pressure (other work running, swap in use), so single wall-clock values
carry noise; the shapes, ratios and controlled pairs are the trustworthy part.
Fixture: the synthetic estate in [`harness/`](./harness/) built around a real
982 KB script-heavy product page (10%), a stripped 159 KB variant (10%), and
20 KB documentation, blog, listing and thin pages (80%), mean 128 KB per page.

## Headline: a 2,500-page audit on one machine

CLI audit, `--coverage full`, cold, fresh content store per stage, interleaved
old/new runs, `heapUsed` sampled after a forced collection at exit. Before is the
resident pipeline (every page held in memory through the rules pass); after is
the streaming pipeline ([#252](https://github.com/squirrelscan/squirrelscan/pull/252)).

| pages | wall before | wall after | heap before | heap after |
|---|---|---|---|---|
| 400 | 47 s | 47 s | 685 MB | 265 MB |
| 1,000 | 194 s | 128 s | 1,662 MB | 565 MB |
| 2,500 | 502 s | 177 s | 3,902 MB | 996 MB |
| 1,000, warm re-audit | 87 s | 72 s | 1,651 MB | 561 MB |

Reports are byte-identical at all three sizes (at 2,500 pages excluding
`perf/ttfb`, which grades the test server's response time and tripped on 14
pages while the resident run was starving it). Wall time improved rather than
paying the parse-per-batch cost, because a multi-gigabyte heap costs more in
collector and compressor work than the extra parse.

## The cold crawl against a filled cache

`ContentStore.put()` called `getStats()`, a `COUNT + SUM` over the whole global
content store, once per stored page. On a 947 MB store that scan was 90.2% of a
cold audit's CPU (339 s of 376 s in a CPU profile), and a store that had grown
past its 900 MB prune threshold paid it twice per page, forever. Fixed with one
covering index ([#246](https://github.com/squirrelscan/squirrelscan/pull/246)).

| measurement | before | after |
|---|---|---|
| `getStats()` on a 947 MB store | 295 ms | 1.3 ms |
| storing 60 pages into a 93 MB store | 32.4 ms/page | 0.38 ms/page |
| 400-page cold crawl, 992 MB store | 333 s (833 ms/page) | see next row |
| 1,000-page cold crawl, 947 MB store | | 26 s (26 ms/page) |
| 1,000-page warm crawl, same store | | 15 s (15 ms/page) |

Controlled triple that located it (400 identical pages, identical rules time):
992 MB store 333 s, empty store 5 s, pages already stored 4 s.

## Retention per page in the engine

Measured on 150 real 959 KB pages with per-page-distinct assets, as string
backing store (`process.memoryUsage().external`) above a retain-nothing control,
batch of 50. Each of these was a string sliced from a page's HTML and kept past
the page's lifetime, which in JavaScriptCore pins the whole page as UTF-16.

| structure | before | after | change |
|---|---|---|---|
| page rule results attached to their page | 4,020 KB/page | 213 KB/page | [#234](https://github.com/squirrelscan/squirrelscan/pull/234) |
| streamed universe without stored parse | 3,900 KB/page | 77 KB/page | [#237](https://github.com/squirrelscan/squirrelscan/pull/237) |
| external-link occurrences (map keys) | 1,870 KB/page | 0 | [#240](https://github.com/squirrelscan/squirrelscan/pull/240) |
| hosted prefetch payload excerpts | 7,800 KB/page | 130 KB/page | [#255](https://github.com/squirrelscan/squirrelscan/pull/255) |
| site-query link scan (`SELECT *` over pages) | +431 MB RSS across the call | +88 MB | [#236](https://github.com/squirrelscan/squirrelscan/pull/236) |

Remaining per-page term after these: about 80 KB of real values the site pass
reads, flat across 50 / 100 / 150 pages.

## Rules-phase scaling, and one asymptotic fix with no measurable win

[#1910](https://github.com/squirrelscan/repo/issues/1910) reported site rules at
n^2.0 (4 s at 400 pages to 687 s at 5,000) and page rules at n^1.6. Re-measured
on a quiet machine, with the content store isolated, each measurement in its own
child process, and the two rules that reach the network excluded
(`security/http-to-https` probes over HTTP with staggered sleeps and was 508 ms
of a 518 ms site phase; the soft-404 confirmation pass re-fetches candidates).
Mixed estate at #1910's template shares, 14.2 KB mean, per page in milliseconds:

| pages | universe | page rules | site query | site rules | v1 load+hydrate | v1 rules | parsePageRecord |
|---|---|---|---|---|---|---|---|
| 400 | 0.33 | 6.95 | 0.06 | 0.17 | 0.20 | 6.44 | 0.67 |
| 1,000 | 0.35 | 6.76 | 0.07 | 0.16 | 0.17 | 6.74 | 0.63 |
| 2,500 | 0.32 | 7.60 | 0.08 | 0.16 | 0.19 | 7.86 | 0.59 |

Slopes across 6.3x: page rules n^1.05, site rules n^0.97, parsePageRecord n^0.93,
universe n^0.99, v1 rules n^1.11. Nothing quadratic. At 102 KB mean over 400 to
1,600 the exponents hold. #1910's own caveat explains its numbers: its 2,500 row
was 589 s wall against 360 s CPU and its 5,000 row 2,236 s against 1,023 s, on a
box doing 150 MB/s of swap at load average 13.

`integrity/template-discontinuity` did contain a genuinely quadratic structure:
on the v1 path it looked each outlier's page up with `pages.find(...)`, so with
outlier share `f` that is `f·n` scans of `n` pages. Replaced with a lazily built
first-wins map ([#254](https://github.com/squirrelscan/squirrelscan/pull/254)).
**The change buys nothing measurable at any size this fixture can reach**, and
this row exists to say so:

| outlier share | pages | before | after |
|---|---|---|---|
| 10% | 2,500 | 159 ms | 154 ms |
| 33% | 1,000 | 74 ms | 71 ms |
| 33% | 2,500 | 215 ms | 225 ms |

Minimum of five runs each. At the largest share the rule can be given — one page
in three, since at one in two the baseline absorbs both groups' markers and
there are no outliers at all — 2,500 pages is about a million string compares
inside a 215 ms rule. An earlier run of this pair reported 501 ms against 201 ms;
that was a loaded machine, not the algorithm, and it is recorded here because a
benchmark record that only keeps the flattering measurement is worth nothing.

Three things had to be controlled before any of the numbers above meant
anything, and each one produced a confident wrong answer first. They are worth
knowing before re-running this or benchmarking any other rule.

**Two rules reach the network and no obvious switch stops them.**
`security/http-to-https` probes sample URLs over HTTP with staggered sleeps; at
400 pages it was 508 ms of a 518 ms site phase, so the whole site phase was one
rule waiting on sockets and the first version of this concluded from it that
site rules were "dominated by a fixed cost". The soft-404 confirmation pass
re-fetches candidates with a per-host sleep, and disabling it needs
`config.integrity.soft404_confirm` — a root-level key of that name is silently
ignored, and it defaults to enabled.

**The rule profiler rounds every invocation to whole milliseconds.** Harmless
for a site rule, which runs once per audit and takes tens of ms. Fatal when
summed over page rules: 198 rules across 2,500 pages is 495,000 rounded samples,
sub-millisecond work sums to zero, and a rule that crosses 1 ms on heavier pages
jumps a whole unit. That artifact produced a published claim that v1's page
rules were n^1.47 against streaming's n^1.01; unrounded timings of the same
invocations put both near n^1.0. Page-rule cost here comes from phase spans,
which are unrounded, and page-rule profiler lines are counted rather than summed.

**A uniform fixture skips the branches that cost anything.** Three versions of
this corpus did. The last one scored its off-theme pages at 0.258 against
`template-discontinuity`'s 0.2 threshold, so the rule reported "all pages share
the site's common template" and the quadratic scan never ran at all. One cause
generalises past this rule: **the Jaccard of two empty sets is 1**, so a
fingerprint term that neither the baseline nor the outlier declares pays full
weight to SIMILARITY. The corpus now also carries pages nothing links to, hubs,
4xx and noindex pages, off-page canonicals and schema on four templates, each
gating a branch a uniform corpus skips.

And a fourth, learned the hard way on the table above: **a loaded machine does
not merely add noise to a cache-hostile scan, it systematically inflates it**, so
minimum-of-N on a busy box is not a defence. Re-run the pair on a quiet machine
before publishing a delta.

## Storage statement compilation in the crawler

`bun:sqlite` has two ways to get a statement and they are not interchangeable:
`db.query(sql)` caches the compiled statement by SQL text, `db.prepare(sql)`
compiles a new one every call. The crawler's storage layer used `prepare` in all
116 places ([#1911](https://github.com/squirrelscan/repo/issues/1911)).
[#247](https://github.com/squirrelscan/squirrelscan/pull/247) converted the
per-link frontier check; a census of a real crawl then showed which of the
remaining 95 still ran per page, and the answer was seven
([#262](https://github.com/squirrelscan/squirrelscan/pull/262)).

Compilations from `prepare` and `query`, 120-page crawl at 40 links/page:

| | before | after |
|---|---|---|
| cold crawl, `incremental: true` (the CLI default) | 633 (5.3/page) | 38 (0.3/page) |
| cold crawl, `incremental: false` | 513 (4.3/page) | 37 (0.3/page) |
| **warm re-crawl of the same site** | **1,482 (12.3/page)** | **48 (0.4/page)** |

The warm row is the one that matters, and it is the one a first census missed
entirely. Five statements run per page on a cold crawl — `upsertPage`,
`upsertFrontier`, `getIncomingLinkCount`, the crawl-stats `UPDATE` and
`getCachedPage` — and two more run per REUSED page on a warm one,
`getLinksByPage` and `getImagesByPage`. A re-audit is the common case and was
paying 12.3 compilations per page.

Compilation cost per statement, against the real schema, minimum of five
interleaved rounds of 5,000. A `query` cache hit is 0.01 us in every row:

| statement | `prepare` |
|---|---|
| `getCachedPage` | 10.17 us |
| `getLinksByPage` | 9.71 us |
| `upsertPage` | 9.30 us |
| `getImagesByPage` | 9.16 us |
| `upsertFrontier` | 4.91 us |
| `getIncomingLinkCount` | 2.43 us |
| `updateCrawl` (stats) | 1.78 us |

47.5 us per page on a warm crawl, 0.5 s across a 10,000-page re-audit.

**This is a count, not a time.** An interleaved A/B of the crawl at 400 pages
gave minima of 1.1 s before and 0.9 s after, but the arithmetic accounts for
about 19 ms of that 200 ms, so the wall-clock pair is noise and is not evidence.
A count is immune to what else the machine is doing, which is why it is the
headline and why the regression test asserts on compilation rather than a clock.
Machine: 16 GB Apple Silicon laptop, load average 4 to 9 with other lanes
running, which disqualifies the timing rows and does not touch the counts.

### The statement cache has a ceiling, and it starves rather than evicts

On Bun 1.3.14 it holds the first **20 texts per Database and never evicts**. A
statement that gets in stays in; one that arrives late never gets in at all and
recompiles on every call, forever and silently. Measured on a fresh database:
25 distinct texts, then three passes over the same 25, gave 15 compilations
rather than 0 — the five that never made it, three times each.
`Database.MAX_QUERY_CACHE_SIZE` raises the limit (30 caches all 25), but the
default is what ships. The crawler now uses 14 texts, so converting another six
would fill it and starve whatever came next.

### Counting compilations is version-dependent

On 1.3.14 `db.query` routes a cache MISS through the public `prepare`, so a hook
on `prepare` sees every compilation from both call styles — though not from
`exec`/`run`, which the schema setup uses. On Bun 1.4.0 `query` compiles through
an internal path that hook cannot see, and a census there would report zero and
look like a pass. Three versions of this measurement were wrong: one missed
query compilations, the next added distinct query texts to the prepare count and
double-counted, and the third derived "served without compiling" as
calls-minus-texts, which assumes every repeat hits and still reported 6,034 free
calls with the cache forced to zero entries. The census now attributes each
compilation to the call that caused it.

### Byte-identity, and three digests that were not

A serialised crawl at 120 and 250 pages produces the same digest before and
after, over every deterministic page column, every frontier verdict and the
crawls row, with the site crawled **twice** so the incremental path is exercised
(the second crawl records 120 `hash_match` reuses).

All three earlier versions of that digest were defeated in review. The first
omitted `parsed_data` and passed with all 120 values nulled. The second omitted
the stored `url` and passed with every one replaced by `CORRUPTED`. Both crawled
once, which leaves the cache empty, so `getCachedPage` never hit and a version
of it returning `null` unconditionally also passed.

Two further things had to be fixed before any digest meant anything, and both
first looked like the change breaking something: the crawl is non-deterministic
at concurrency 8, because discovery order decides each URL's depth and parent,
and `port: 0` puts a different ephemeral port in every stored URL, so identical
code hashed differently three times running.
## Not a performance change: the page cap said nothing

Recorded here because #1028 needs the page count to be expressible from the CLI
at all, and it was not. `squirrel audit --max-pages 10000` crawled 5,000 and
reported `maxPages: 5000`, which is byte-identical to what a 5,000-page site
reports ([#1909](https://github.com/squirrelscan/repo/issues/1909),
[#263](https://github.com/squirrelscan/squirrelscan/pull/263)).

No timings: nothing about this change affects how long anything takes, and there
is no before/after to measure. What it changes is whether the number a
measurement was taken at is knowable afterwards, which is what every other row
in this file depends on.

`MAX_PAGES_CAP` was applied with a bare `Math.min` in three places — the `audit`
command, the `crawl` command and the audit controller — none of which said
anything. The existing notice fires when a crawl REACHES the cap, a different
event: a 10,000-page request against a 4,000-page site was clamped and never
mentioned. Now one helper resolves the request, both commands print the clamp,
and the report carries `meta.maxPages` alongside `meta.requestedMaxPages`, the
latter present only when a clamp happened so its absence is the normal case.

## Hosted runtime, in production

Same 149-page rendered audit of the same site an hour apart, old image against
new (#234, #236, #237), RSS in MB from the run's phase events:

| phase | old image | new image |
|---|---|---|
| page rules growth, post-GC | +869 | +382 |
| site-query step | +350 | -18 |
| resident at end of rules | 1,233 | 795 |
| peak in the rules phase | 1,581 | 1,180 |

Findings unchanged (score 47 both runs).

## Streaming batch budget

`SQUIRREL_STREAM_BATCH_BYTES` (default 48 MB) sets how much raw HTML is parsed
at once. Measured with the OS high-water mark on 150 real 959 KB pages
([#245](https://github.com/squirrelscan/squirrelscan/pull/245)):

| budget | pages per batch | peak RSS |
|---|---|---|
| 6 MB | 6 | 480 MB |
| 12 MB | 12 | 344 MB |
| 24 MB | 25 | 492 MB |
| 48 MB | 51 | 509 MB |
| 96 MB | 102 | 655 MB |

No budget gets under about 357 MB (rule set, runner, SQLite caches, allocator
floor); an 8.5x larger batch gives a 1.9x larger peak; and below about 12 pages
per batch a smaller budget is worse, because the extra read/parse/collect cycles
set the high-water mark.

## Hosted crawl reuse

A second hosted audit of an unchanged 150-page site on the old code: crawl
433 s then 482 s (the re-run was slower), one render-cache hit out of about 140
renders. Cross-run reuse of the previous audit's pages
(squirrelscan/repo#1902) and a source fingerprint that survives Shopify's
cache-entry regeneration ([#242](https://github.com/squirrelscan/squirrelscan/pull/242),
[#244](https://github.com/squirrelscan/squirrelscan/pull/244)) are deployed.

**Measured pair, reuse live, same Shopify site at 150 pages, coverage full,
render on, 51 minutes apart. Nothing was reused, and the re-run cost 8% MORE.**

| | first run | second run |
|---|---|---|
| crawl | 1,197 s | 1,066 s |
| pages fetched | 150 | 150 |
| `[reuse]` tally | 0 reused | 0 reused |
| renders / cache hits | 150 / 2 | 125 / 39 |
| render-side credits | 304 | **328** |
| health score | 47 | 47 |
| issues | 29,412 | 28,844 |

The two crawl times are **not comparable** and no speedup should be read from
them. The first run's seed probe was refused, so it based on the apex and
filled its frontier from links (pending 140 at the first page); the second
based on `www` and seeded from the sitemap (pending 349). Different frontier
construction, not different reuse.

The credits are comparable, and they went the wrong way. Charge attribution on
the second run: 125 `render` debits from the render service, and of 39
`render_cached`, **38 were the crawl cache and 1 was the render service**. The
crawl cache was charging on lookup — for a body the crawler then declined to
reuse — and the render happened anyway, so 37 of 150 urls carried both debits
(squirrelscan/repo#1940, fixed by charging on adoption instead).

**Cause of the zero, which is upstream of all of it:** the origin serves our
egress a different body on every request. Since the deploy, 228 new
`domain_renders` rows for that domain, and every path crawled by both runs has
exactly two distinct content hashes — one per run. One new fingerprint per run
per path is the churn not being absorbed.

The normalizer is not at fault. Three fetches of one of those pages from a
residential vantage returned byte-identical bodies and identical
`normalizeHtmlForFingerprint` hashes. The stored pages also carry no
`Cache-Control`, no `Expires` and no `Last-Modified`, and their ETag is
Shopify's per-request `page_cache:` token, so the freshness path is unreachable
and a conditional GET can never answer 304. Every page falls through to a full
re-fetch, and `[reuse] 0` is the correct answer to the inputs rather than a
plumbing failure.

Reuse should be expected to pay off on origins that send validators or freshness
directives, and to pay nothing on this class until the per-request variation is
characterised. That is what squirrelscan/repo#1899 acceptance criterion 1 was
asking, and it is now answered: the body differs, the normalizer does not.

## Fixed along the way

- Seed-redirect probe sent no user agent; a WAF's 403 was read as "no
  redirect", the crawl pinned to the apex and dropped every `www.` link as
  cross-domain, producing silent one-page audits at full price
  ([#248](https://github.com/squirrelscan/squirrelscan/pull/248),
  [#249](https://github.com/squirrelscan/squirrelscan/pull/249)).
- `bun:sqlite` returns `null` for a missing row; an existence check tested
  against `undefined` and was always true
  ([#247](https://github.com/squirrelscan/squirrelscan/pull/247)).
- Bun 1.4 (v0.0.91): Linux binaries 11 to 14% smaller, ~10 ms faster start,
  byte-identical audit results.

## Reading a crawl's checks once instead of twice

The report path called `getRuleResultsByPage` and then `getRuleResultsByRuleId`.
The two queries differ only in their `ORDER BY`, and each built its own
`CheckResult` per row, so every check was read and materialized twice. At 1,000
pages that is 203,687 rows, 204 per page, for 11.3 MB of stored text.

Measured in isolation on that crawl, alternating the two arms twice, growth
across the call with a forced collection at each end
([#258](https://github.com/squirrelscan/squirrelscan/pull/258)):

| arm | RSS | external | wall |
|---|---|---|---|
| two reads | +341 to +368 MB | +40 MB | 542-890 ms |
| one materialization | +202 to +206 MB | +20 MB | 424-536 ms |

`heapUsed` moved by under 10 MB either way, which is the point worth recording:
the cost of the duplicate is allocator residency and string backing store, not
JS heap objects, so the metric most people reach for cannot see it. Same class
as the `SELECT *` link scan above.

The rows are materialized once and the ORDER is then asked for twice, with the
same `ORDER BY` each original reader used, reading only the row id and the
grouping key. Deriving the order instead — reading once in `id` order and
grouping — measured faster still, and was wrong: it relied on tied `ORDER BY`
rows coming back in `id` order, which held on today's schema but flips under an
index on `(crawl_id, rule_id, page_url)`, changing the emitted issue order.
SQLite leaves tied rows unordered by contract.

End to end the change is real but below the noise floor of an exit measurement.
Reports are byte-identical at 400 and 2,500 pages, and wall time and peak RSS
are unchanged within run-to-run spread.

### What exit `heapUsed` can and cannot resolve

Four 2,500-page runs, two per side of the same change, on the machine described
at the top:

| run | exit heapUsed |
|---|---|
| before, run 1 | 599 MB |
| before, run 2 | 965 MB |
| after, run 1 | 1,144 MB |
| after, run 2 | 998 MB |

The spread within one side is larger than the difference between sides, so this
metric cannot judge a change of this size at 2,500 pages. It stays trustworthy
for the large gaps above (the streaming change was 3,902 MB against 996 MB, a
factor of four), and those figures should be read as the shape rather than to
three digits. For a change worth tens or low hundreds of megabytes, measure the
call in isolation against a retain-nothing control instead.

## The report's per-page fields that nothing read

`reconstructReport` built a full `PageAudit` per page: `meta`, `og`, `twitter`,
`schema`, `links`, `images`, `h1Count`, `h1Text`, `loadTime`, `responseHeaders`,
`security`. No output format emits `report.pages`, and the publish path sends
`pages: []` after taking the urls, the statuses and the home page's title, so
most of that was built and discarded ([#260](https://github.com/squirrelscan/squirrelscan/pull/260)).

Only `meta` and `og` survived the search for a reader: `pickHomepageSummary`
reads them off the home page to seed the website record. A differential test
pins the publish body as byte-identical with and without the dropped fields.

**Measured neutral on this fixture, and the reason is the fixture.** Growth
across `reconstructReport` on the 1,000-page corpus, warmed, two runs per side:

| | heap | RSS | wall |
|---|---|---|---|
| before | +114 MB | +52 to +127 MB | 468-479 ms |
| after | +113 to +117 MB | +82 to +152 MB | 446-607 ms |

The two largest fields dropped are `links` and `images`, and this corpus stores
**zero** of either: they are written by the external-link phase, and the
benchmark runs `--offline` against a site with no outbound links. So the arrays
being dropped were already empty, and the per-page `getLinkAppearancesForPage`
query the change also removes had nothing to return.

What the change removes structurally, and what a site with external links would
therefore save, is one storage query per page plus a whole-crawl `getLinks`
read, and three of the five objects in the per-page detach. That is not recorded
here as a number because it was not measured. A fixture that can show it needs
stored links and images, which means an audit with external-link checking on.

## The publish finalize's carried side

The chunked publish's `/finalize` runs in a 128 MB API isolate. #1873 bounded the
FRESH half: this audit's findings stream out of Postgres a page at a time and fold
into per-rule tallies. The CARRIED half stayed an array — every open finding the
site had outside this run, loaded, indexed by key, walked twice, replayed as a
`CheckResult` and folded into the report — which costs nothing on a full re-audit
(almost everything is re-observed) and everything on a PARTIAL re-audit of a site
with a large open backlog (almost nothing is).

Whole-handler RSS growth through `handlePublishFinalize` against a real local
Postgres, the fixture seeded by a SUBPROCESS so the measuring process never
allocated it, 2,000 fresh findings and 500 crawled pages throughout, 40 page-scope
rules. Harness: `apps/api/tests/routes/finalize-memory-scale.test.ts` in the
private repo, `FINALIZE_MEMORY_CARRIED` arm.

| carried findings | before | after |
|---|---|---|
| 0 | 42.2 MiB | 39 MiB |
| 5,000 | 90.5 MiB | 62 MiB |
| 20,000 | 189.6 MiB | 65 MiB |
| 60,000 | 328.6 MiB | 98 MiB |

Before is linear at about 4.8 KiB per carried finding. After is not: both halves of
a page now arrive together from ONE keyset cursor over the site's open findings,
the merge decides each prior as it goes past, and the page is dropped. Medians of
three to four runs per cell; the spread within a cell is 10 to 15 MiB.

**Peak RSS still climbs from 20,000 to 60,000, and residency does not.** Settled
`heapUsed` after a forced collection at the end of the handler is 20.3 MiB at
20,000 carried findings and 21.0 MiB at 60,000 — flat, which is the claim. Peak RSS
is a high-water mark over the whole handler, so it also records how far the runtime
lets the heap run ahead of the driver's churn while 60,000 rows are read and
rewritten, and that is proportional to the work whatever the design holds. Read the
two numbers together before concluding a streaming path has a leak.

Two of the three cuts were not the ones the shape predicted. The report's carried
sample is capped at 25 checks per rule because 100 cost ~25 MiB of peak and 500
cost ~80 — the retained checks are small, but a larger live set raises the heap the
runtime grows to under this path's churn, so the price is a multiple of their own
size. And the read and write batches were quartered (1,000 to 250 rows, 500 to 200)
for ~15 MiB, because a batch's cost is the graph the driver builds around it, not
the rows.

## Still open

- Site rules are quadratic in page count (4 s at 400 pages, 99 s at 2,500,
  687 s at 5,000): squirrelscan/repo#1910.
- Report reconstruction materializes every check, including the 83.7% that
  pass and never reach the report: squirrelscan/repo#1920. Reading them once
  rather than twice is done (above); dropping the passing rows needs a decision
  about the publish payload first.
- `--max-pages` above 5,000 is silently clamped: squirrelscan/repo#1909.
- The finalize rewrites every carried finding to stamp `provenance`, even when it
  already reads "carried" from an earlier run. A no-op write is most of the write
  traffic on a site that carries the same backlog audit after audit.
