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
| 1,000, warm re-audit ([retracted](#ten-thousand-pages)) | 87 s | 72 s | 1,651 MB | 561 MB |

**Retracted 2026-09-08:** the warm row was not a warm re-audit. `run-stage.sh`
gave every stage a fresh origin port, so that run crawled a different host and
reused nothing. The cold rows are unaffected. See "Ten thousand pages" below.

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
| 1,000-page warm crawl, same store ([retracted](#ten-thousand-pages)) | | 15 s (15 ms/page) |

**Retracted 2026-09-08:** same defect — that "warm" crawl ran against a
different origin port, so it re-fetched every page and the 15 ms/page is a cold
number against an already-populated store, not a re-crawl. The rows above it
stand.

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

This warm row is **not** covered by the 2026-09-08 retractions above: it was
measured outside `run-stage.sh`, and counting statements that only run per
REUSED page is itself proof the origin matched.

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
[#264](https://github.com/squirrelscan/squirrelscan/pull/264)).

No timings: there is no intended crawl-performance change here and no
before/after to measure. What it changes is whether the number a
measurement was taken at is knowable afterwards, which is what every other row
in this file depends on.

`MAX_PAGES_CAP` was applied with a bare `Math.min` in five places — the `audit`
and `crawl` commands, the audit controller, and twice in the crawl controller —
none of which said anything. The existing notice fires when a crawl REACHES the cap, a different
event: a 10,000-page request against a 4,000-page site was clamped and never
mentioned. Now one helper resolves the request, both commands print the clamp, and the
report carries `meta.maxPages` alongside `meta.requestedMaxPages`, the latter
present only when a clamp happened so its absence is the normal case. The LLM
render carries the same pair, which is the whole response for an MCP caller.

Worth recording because it nearly went the other way: a first version of the
helper passed non-finite requests through untouched, reasoning that the commands
reject bad input themselves. `[crawler] max_pages = inf` passes the config
schema and never reaches that check, so `Infinity` went straight to the crawler
and the hard cap stopped being hard. A safety bound does not get exceptions for
inputs that look invalid; `effective` is `Math.min` for every input, as it was.

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

### The control: an origin that does send freshness directives

The drscholls pair could not tell a broken feature from an unsuitable origin, so
the same measurement was repeated against a site chosen for the opposite
property: our own marketing site, which serves `cache-control: public,
max-age=60, s-maxage=600, stale-while-revalidate=86400` on every page. It has 64
urls in its sitemap and the crawl reaches the 150-page cap through link
discovery. Same settings as the pair above, 22 minutes apart, on the code that
charges adoption rather than lookup (squirrelscan/repo#1941,
squirrelscan/repo#1942).

| | first run | second run |
|---|---|---|
| crawl | 742 s | 520 s |
| pages fetched | 150 | 114 |
| pages reused | 0 | 36 |
| `[reuse]` tally | 0 reused | `max-age=6 stale-while-revalidate=30` |
| `render` debits | 150 | 114 |
| `render_cached` debits | 0 | 12 |
| credits | 350 | 302 |
| health score | 69 | 69 |
| pages reported | 131 | 131 |
| errors / warnings | 154 / 1,198 | 154 / 1,210 |

Unlike the drscholls pair these two are comparable: both based on the apex, both
took `/terms` first, and their first frontier reading was 111 pending against
106.

**Reuse works, and the double charge is gone.** 114 renders plus 36 adopted
pages is exactly the 150 pages crawled, and no url carries both a `render` and a
`render_cached` debit — the overlap between the two debit sets is zero, against
37 urls double-charged in the run above.

**The 302 is not a saving, it is a shortfall.** `render_cached` is priced at 2
credits, the same as `render`, on purpose: caching never discounts the customer
price, the saving is our render cost. A fully settled second run therefore costs
what the first run cost, to the credit — 50 + 114x2 + 36x2 = 350. It billed 302
because settlement stopped after 12 of the 36 adopted pages. So the number to
hold this feature to is "the re-run does not cost MORE, and no page is billed
twice", never "the re-run is cheaper".

Two silent truncations sit behind that, one on each side of the cache:

- **Settlement runs out of time.** `/v1/services/crawl-cache/adopted` does a
  full R2 read of the stored page and a credit write per url, sequentially. The
  ledger rows land 2.5 s apart, so a 25-url batch needs about a minute against
  a 30 s client bound. 12 charges landed and the run recorded `[reuse] adoption
  report failed after 36 adopted pages`. The idempotency key is stable, so the
  12 stayed put and nothing was billed twice. At the per-url cost this run
  showed, a batch of more than about a dozen urls cannot finish inside the
  bound; whether that cost is typical is not something one pair can say. Sizing
  the batch alone only moves the cliff either way — the per-url work has to stop
  reading the whole page body to decide a charge (squirrelscan/repo#1969).
- **The upload drops chunks without saying so.** The second run found 36 usable
  pages in a cache the first run had been handed 150 for, and the pages it did
  find it reused. The uploader returns nothing and never inspects its response,
  and the shared post helper folds a non-ok, a throw and a 10 s abort alike into
  `null`, so a lost chunk emits no event anywhere. The bucket agrees: of 18 urls
  the second run re-fetched, 17 are missing from `crawl-reuse/` after two
  150-page runs that each ran the upload pass, while both sampled adopted pages
  are present. That points at what reaches the bucket rather than at the reuse
  decision, and it is the first thing to rule out before reading the 36 of 150
  as a freshness ceiling (squirrelscan/repo#1970).

The crawl times are cloud-side and a single pair cannot separate 742 s to 520 s
from container variance, but the mechanism is at least present here: 36 fewer
fetch-and-render round trips.

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
## Disk: a project keeps every audit it has ever run

Re-auditing writes a new crawl and retires nothing, so `project.db` grows by
about one audit each time: 95 MB after one audit of a 1,000-page site, 189 MB
after two, 215 MB after three. Where it goes, for two audits of that site:

| object | size | share |
|---|---|---|
| `rule_results` | 79.8 MB | 42.1% |
| `pages` | 53.3 MB | 28.2% |
| `idx_rule_results_page` | 31.9 MB | 16.9% |
| `idx_rule_results_crawl` | 20.0 MB | 10.6% |
| everything else | ~4 MB | ~2% |

`squirrel self disk` reports this
([#256](https://github.com/squirrelscan/squirrelscan/pull/256)) and
`--prune --keep N` reclaims it
([#259](https://github.com/squirrelscan/squirrelscan/pull/259), still a draft).
Measured on two audits of a 60-page site, keeping one:

| measurement | before | after |
|---|---|---|
| `project.db` | 11.5 MB | 5.7 MB |
| page rows for the retired crawl | 60 | 0 |
| next audit's pages fetched | | 0 of 60, all unchanged |

That last row is the one that matters: the reclaim keeps the newest page record
per url, so an incremental re-audit still serves every page from its conditional
GET rather than refetching the site. Retention is not automatic; how many audits
to keep is squirrelscan/repo#1912.

A trap worth recording: `VACUUM` alone made the file BIGGER, 189 MB to 239 MB.
In WAL mode the rewrite lands in the write-ahead log, so the main file shrinks
while the `-wal` beside it grows by more than was saved. `PRAGMA
wal_checkpoint(TRUNCATE)` after the vacuum, and measuring after the connection
actually closes, is what makes the saving real.

## Template clustering: 94.7% redundant on a real storefront, 6.5% if you measure it the obvious way

Two real crawls and two synthetic ones, clustered two ways: by the chrome
fingerprint the audit already builds per page (external asset hosts, `<body>`
class tokens, CSS custom-property names, stylesheet hrefs, nav/footer presence),
and by an exact DOM skeleton with all text and attribute values stripped.
"Redundant" is every page after the first of its cluster, the ceiling on what
doing the work once per template could avoid.

| corpus | pages | chrome clusters | chrome redundant | skeleton clusters | skeleton redundant |
|---|---|---|---|---|---|
| gymshark.com (real) | 247 | 13 | 94.7% | 231 | 6.5% |
| openelectricity.org.au (real) | 100 | 12 | 88.0% | 42 | 58.0% |
| drscholls-shaped synthetic | 150 | 1 | 99.3% | 1 | 99.3% |
| 6-template synthetic | 1,000 | 3 | 99.7% | 7 | 99.3% |

The two definitions disagree completely on real sites and agree completely on
synthetic ones. Real product pages share their chrome and differ in their body:
a different number of variants, reviews, related items. 224 of gymshark's 231
skeletons are singletons. The bench corpora are generated from a handful of
templates, so both definitions collapse to the same near-total redundancy there.

**Anyone sizing this from the synthetic corpora would design exact-structure
dedupe and ship something that saves 6.5% on a real storefront.** That is why
whole-page template dedupe is not on the roadmap: html is already deduplicated by
content hash in the global content store, so identical pages cost nothing twice
today.

The lever is compute, not storage. By chrome cluster, 96.5% of gymshark's
page-rule time is spent on pages that are not the first of their cluster (64.6%
on openelectricity). Running all 198 page rules on every page and comparing
members of each multi-page cluster, the rules whose verdict is identical for
every member:

| corpus | rules constant in every multi-page cluster |
|---|---|
| gymshark.com | 89 of 198 |
| openelectricity.org.au | 142 of 198 |

85 are constant on both. Only 26 are declared safe to fan out
([#269](https://github.com/squirrelscan/squirrelscan/pull/269)): the rest are
constant on those two crawls and page-scoped anyway, because the cluster key
constrains no response header, the page url is per-page by construction, and a
rule scanning the whole document can see body content. `perf/compression` is the
sharpest case: it is constant on both corpora only because every page of both is
`content-encoding: br`, and its failure message interpolates the page's byte
count.

Storing the cluster key costs 0.04 to 0.08 ms/page
([#267](https://github.com/squirrelscan/squirrelscan/pull/267)), against a 1.0 to
5.6 ms/page fingerprint walk the audit was already paying. Reproduce both tables
with `apps/cli/scripts/template-cluster-census.ts` and
`apps/cli/scripts/template-rule-invariance.ts` against a finished `project.db`;
they need no network and do not write to the crawl they read.

## The rules phase on a script-heavy page

A 500-page cloud audit of drscholls.com failed its 2400 s run budget after the
memory ceiling had been raised, because the rules phase cost about 2 s per page
on the container. Every page there is ~1 MB with ~800 KB of inline script, and
that shape is not what the mixed estate above measures — it dilutes it to a
tenth. `harness/script-heavy-site.ts` serves N byte-unique copies of one real
saved page instead ([squirrelscan/repo#1864](https://github.com/squirrelscan/repo/issues/1864)).

Fixture: a real 1.13 MB product page, 59 inline scripts, 791 KB of inline
JavaScript, 40 internal links woven into each copy, 150 pages. Command
`squirrel audit --coverage full --max-pages 150 --http --offline --refresh
--trace` with `SQUIRREL_RULE_PROFILE=1`, a fresh project and a per-run title
salt so the global content store cannot serve one arm's pages to the other.
Three interleaved rounds per arm, medians, load average 3.2 to 5.0 throughout.

| | before | after |
|---|---|---|
| **whole rules phase** | **274.1 ms/page** | **164.5 ms/page** |
| `security/leaked-secrets` | 64.5 | 29.3 |
| `a11y/skip-link` | 38.5 | 2.4 |
| `perf/js-libraries` | 31.2 | 7.2 |
| `perf/unminified-js` | 15.6 | 4.1 |
| `legal/cookie-consent` | 8.2 | 8.0 |
| `social/share-buttons` | 6.4 | 6.4 |
| audit wall time | 56 s | 42 s |

The four changed rules go from 149.9 to 43.0 ms/page. The last two rows are the
control: nothing else in the phase moves, and the run-to-run spread is 265.5 to
281.6 ms/page before and 164.4 to 173.9 after, so the 110 ms is not noise.

Findings are byte-identical over the same 150 pages, `perf/ttfb` excepted — it
grades the test server's response time and disagrees with itself between any two
runs on a loaded box.

Three of the four were ordinary waste. `a11y/skip-link` built `body.innerHTML`
inside its loop over headings, serialising the whole megabyte once per heading,
and then searched all of it for a heading that only counts inside the first 2000
characters. `perf/unminified-js` counted with `String.match` and a `/g` pattern
five times per script, building an array of every match to read its length.
`shared/comment-scan` compared single-character STRINGS on its per-character
path; comparing code points is about thirteen times faster (10.3 ms against
0.8 ms over one 390 KB bundle).

The fourth is the interesting one. `security/leaked-secrets` runs 70 patterns and
`perf/js-libraries` about 130 over the same text, and a pass over 1 MB costs the
same whether it finds anything or not — so the cost is the pass COUNT. One pass
that records which 4-grams the text contains lets a pattern be skipped when a
literal every match of it must contain is provably absent. Per page, over the
58 bodies of text (the serialised document and 57 inline scripts, 1.9 MB in all):

| | ms |
|---|---|
| build the 4-gram index over every body | 5.4 |
| all 70 secret patterns, no prefilter | 42.4 |
| only the patterns that survive the index | 14.6 |
| `toLowerCase` every body (now built only on demand) | 3.8 |

48% of secret-pattern invocations are skipped and 99% of the context-keyword
scans. The residual is mostly irreducible: **18 of the 70 patterns prove no
literal at all** — `[0-9]{8,10}:[a-zA-Z0-9_-]{35}` has nothing to prove — and
those 18 are the top of the remaining cost, led by the Telegram bot token at
2.0 ms per page.

Soundness bugs kept turning up in the prefilter before it shipped, all of them
silent false negatives, which in this rule means a deleted security finding.
Reading the diff found these three:

- The rolling hash was masked with the TABLE's width rather than the window's,
  so a table wider than 20 bits kept the low bit of the character BEFORE the
  4-character window. Present needles were denied whenever their predecessor was
  odd — 8 of 16 on a 40 KB text. The table only reaches that width past about
  32 KB, which every fixture in the suite sat below.
- An element that can repeat was expanded as though it occurred at most once,
  gluing a run together across it: `abcdz{0,3}efgh` proved `abcdefgh` or
  `abcdzefgh` and denied `abcdzzefgh`, which it matches.
- The index folds ASCII case, which over-approximates the text but not
  `text.toLowerCase()`, where the context keywords are looked up. Exactly two
  characters in Unicode lowercase into ASCII the text does not itself have:
  U+0130 and U+212A KELVIN SIGN. `postmar<U+212A>_server_token` lowercases to
  `postmark_server_token`, and the index rightly said `postmark` was absent.

Three more were escapes read as shorter than they are, each leaving its own tail
behind as literal text no match contains: `\12` (a backreference to group 12,
read as `\1` then `2`), `\k<x>`, and `\u{41}`, which is a code point only under
the `u` flag and otherwise the letter `u` repeated 41 times.

An adversarial review pass found five more of the same kind, all counterexamples
rather than reproductions from the shipped tables. `.` was in the character class
the group shortcut accepts as literal, so `/(abcd.efgh)/` proved a wildcard as
itself. An atom that proves nothing was dropping its quantifier, so
`/abcd\d{1000}efgh/` handed `1000` to the scanner as four literal characters.
`[]` is an EMPTY class in JavaScript, not a literal bracket, so reading past its
`]` in `/abcd[]|efgh/` hid the `|` and left one branch where there are two. The
`\p{` and `\u{` reads searched forward for a `}` that in legacy mode belongs to
a character class. And under the `u` flag the `i` flag folds beyond ASCII, so
`/secret/iu` matches `ſecret`, which does not contain `secret` — Unicode-mode
patterns are now declined whole.

A second review pass found two more of the same family, both legacy escapes
whose length is not knowable from the source: `\c` is a control escape only
before an ASCII letter and otherwise the two characters `\` and `c`, and
`\k<name>` is a named backreference only when the pattern declares a named
group. Guessing either length walked the scan into a character class.

The pattern in every one is the same: **the extractor read the regex as something
the engine does not**, and the specific move that caused half of them was
searching forward for a delimiter — `}`, `>`, `]` — which lands inside whatever
structure happens to contain one. The defence that works is a counterexample
corpus of (pattern, subject-it-really-matches) pairs, because that comparison
does not depend on anyone's reading being right.

The generative soundness test that was supposed to catch several of them could
not run at all: its own string generator looped forever on `\d`, `\w` and `\s`,
so three of its hand-written expectations described an implementation that no
longer existed. Its random number generator also multiplied past 2^53 and lost
its low bits, so 60 of 60 Redis samples took the same alternative and no Generic
Secret Assignment sample ever chose `password` — a generator that walks one
branch cannot notice an extractor that proves one branch. **A skipped, hanging or
degenerate test is read as evidence.** Every regression test here was
mutation-checked by restoring the bug it claims to catch, and two of them did not
bite until the fixture varied the character immediately before the literal — `"`
is even and `'` is odd, and a corpus that quotes everything the same way is blind
to the whole class.
## Ten thousand pages

Nobody had run the estate at 10,000 pages, in the CLI or the cloud. Two things
turned out to be true at once: the engine handles it, and the product will not
let anyone ask for it.

### The ceilings come first

`--max-pages 10000` crawls 5,000. `MAX_PAGES_CAP = 5_000` is applied as
`Math.min(requestedMaxPages, MAX_PAGES_CAP)`, and `[crawler] max_pages` goes
through the same clamp, so no configuration raises it. The cap announces itself
on stderr when it binds:

```
⚠ Reached the max pages cap (5000). This is the hard limit; split the audit by section (e.g. [crawler] include) to scan more.
```

The hosted crawl stops earlier still, at **at most** 2,000 pages — no plan can
exceed it, and the lower plan caps below still bind their own tiers. Three
clamps apply in series: the plan ladder (free 500, Pro 2,000, Team 5,000,
Enterprise 5,000), then a flag holding Team at Pro's 2,000 until chunked publish
lands, then `Math.min(raw, REPORT_LIMITS.maxPages)` with `REPORT_LIMITS.maxPages
= 2000`, which binds Enterprise too. Production clamps rather than rejects:

```json
{"type":"page_limit_clamped","requested":10000,"applied":2000,
 "plan_id":"starter","plan_cap":2000}
```

The 10,000-page rows below were produced with the CLI's cap raised locally,
because at the time no shipped configuration could ask for them.

**These ceilings have since moved.** On the evidence in this section,
[#278](https://github.com/squirrelscan/squirrelscan/pull/278) raised
`MAX_PAGES_CAP` and `REPORT_LIMITS.maxPages` to 10,000, removed the
`TEAM_MAX_PAGES_UNLOCKED` flag, and lifted Team and Enterprise to a
10,000-page-per-audit ceiling; free stays at 500 and Pro at 2,000. So the clamp
behaviour described above is what these measurements were taken against, not
what ships now. Note the ordering constraint that change carries: an older
server rejects a publish carrying more than 2,000 page statuses, so the hosted
side has to accept a crawl that size before a CLI is updated to produce one.

### Cold, from 1,000 to 10,000 pages

Coverage full, `--http --offline`, a fresh content store per pair, one origin
pinned across each pair, heap sampled after a forced collection at exit. All
eight stages exited 0 with no guard kill. Byte figures are MiB throughout.

These rows were produced on the CLI at gitlink `1a3f405`, which predates the
script-heavy rules work in the section above
([#271](https://github.com/squirrelscan/squirrelscan/pull/271)). That change
cuts the rules phase on ~1 MB pages from 274 to 165 ms, and those pages are a
tenth of this estate, so reproducing these totals on current `main` should come
out faster.

| pages | wall | CPU | crawl phase | parse | peak RSS | heapUsed, collected | project.db |
|---|---|---|---|---|---|---|---|
| 1,000 | 68 s | 74 s | 10.9 s | 5.3 s | 1,813 MiB | 631 MiB | 106 MiB |
| 2,500 | 174 s | 182 s | 26.2 s | 15.2 s | 2,179 MiB | 938 MiB | 257 MiB |
| 5,000 | 359 s | 363 s | 49.5 s | 33.0 s | 3,641 MiB | 1,182 MiB | 509 MiB |
| 10,000 | 746 s | 773 s | 98.7 s | 88.4 s | 5,447 MiB | 2,264 MiB | 1,011 MiB |

"Crawl phase" is `completed_at - started_at` on the `crawls` row, which is the
fetching proper. It is deliberately not the span of the origin's request log:
that log keeps running through the post-crawl resource checks and is 14/33/63/126 s
for these same four stages, about 30% longer, and using it would overstate what
fetching costs.

Per page, the crawl phase is 10.9, 10.5, 9.9 and 9.9 ms and wall is 68, 70, 72
and 75 ms, so the whole-run cost per page rises about 10% across a tenfold range
in size. Parse is the one column that clearly does not keep pace: 5.3, 6.1, 6.6
and 8.8 ms per page, a 67% rise, and it goes up 2.68x between the 5,000 and
10,000-page stages against 2x the pages.

On squirrelscan/repo#1910, which recorded 687 s of site rules alone at 5,000
pages: the entire 5,000-page audit here took 359 s. These were not run under
equivalent conditions and this does not disprove that phase measurement, but the
two cannot both describe the same code on the same workload, so #1910 needs
re-measuring before more work goes into it. Settling how much of the remaining
time is site rules needs per-phase rules timing, which the streaming pipeline
does not currently emit.

**Memory.** Across a tenfold increase in pages, settled heap rises 3.6x
(631 → 2,264 MiB) and peak RSS 3.0x (1,813 → 5,447 MiB). Those are endpoint
ratios, not a complexity claim — a fixed overhead plus a linear per-page cost
produces exactly this pattern, and heap does nearly double over the last
doubling of pages. What can be said is that neither measure grows in step with
page count, which is the behaviour the streaming pipeline was built for.

The gap between peak RSS and settled heap is large and unexplained here:
5,447 against 2,264 MiB at 10,000 pages. `RSS - live` is not a residency figure
— it also holds native allocations, SQLite's caches, resident JIT and allocator
overhead — and on a machine under memory pressure it is not stable either, so no
attribution is offered.

**Wall time on this machine is worth much less than the other columns.** The same
5,000-page cold workload measured 359, 448 and 575 s across three runs today,
a 60% spread, and CPU time moved with it (363, 460 and 582 s). Those runs
differed in what else the machine was doing, though that association is not a
controlled result. Treat any wall-clock difference under roughly 60% on this box
as unresolved.

### Re-auditing an unchanged site: how much is there to save

Each pair's second stage re-audited the same unchanged origin, on the same
pinned port, against the same content store.

| pages | cold wall | warm wall | observed change | cold crawl | warm crawl | fetching removed | as % of cold wall |
|---|---|---|---|---|---|---|---|
| 1,000 | 68 s | 61 s | -11% | 10.9 s | 2.8 s | 8.1 s | 12% |
| 2,500 | 174 s | 146 s | -16% | 26.2 s | 6.5 s | 19.7 s | 11% |
| 5,000 | 359 s | 295 s | -18% | 49.5 s | 12.8 s | 36.7 s | 10% |
| 10,000 | 746 s | 900 s | +21% | 98.7 s | 29.5 s | 69.2 s | 9% |

**Every warm stage fetched zero pages.** The crawls' stored stats record
`pagesFetched: 0`, `pagesUnchanged: N` and
`cacheHitsByReason: {"stale-while-revalidate": N}` for the whole estate at all
four sizes, and each warm report is identical to its cold counterpart once
`meta.timestamp` is removed. Reuse works completely.

**The structural result is the useful one: fetching is 9-12% of a cold run
here, so that is all a re-audit can give back.** Note that a warm crawl is not
free even with nothing to fetch — it still costs 2.8 to 29.5 s of frontier and
bookkeeping work — so the removable part is the difference, not the whole crawl
phase.

The observed wall changes do not settle anything on their own. Three stages came
in 11-18% faster and one 21% slower, and the same machine reproduces a cold
5,000-page run only to within 60%, which is wider than every one of those
numbers. The two middle stages also came in *faster* than fetching alone can
account for. So this table is quoted for its structure, not as a measured
speedup, and the 10,000-page warm stage ran while the load average was about 5
against about 2 elsewhere, which is an association rather than an explanation.

What is not in doubt is where the rest of the time goes: rules, report
reconstruction and parse re-run in full on every page whether or not that page
changed, and that is roughly 90% of the run. Against a remote origin the fetch
is worth more than it is here and this measurement puts no bound on that, but
the other 90% is paid again either way. Caching that work rather than the bytes
is squirrelscan/repo#1990.

Reuse does not change what the run retains. Warm settled heap is 640, 934, 1,191
and 2,415 MiB against 631, 938, 1,182 and 2,264 cold, agreeing within 1% at the
1,000, 2,500 and 5,000-page sizes and within 7% at 10,000.

The requests a warm stage still makes are robots, the sitemap index and its
children, the sitemap-status pass that HEADs sitemap URLs the crawl never
visited, and an assortment of discovery probes for paths that do not exist —
`/llms.txt`, `/AGENTS.md`, well-known endpoints, API descriptions and similar.
The sitemap-status pass is the bulk of it: 500 requests wherever the page cap
left sitemap URLs unvisited, one at 10,000 pages where it did not.

`project.db` doubled on all four re-audits with no reclaim — 106 to 213 MiB, 257
to 515, 509 to 1,017, and 1,011 to 2,025 (squirrelscan/repo#1912).

`squirrel audit -f json` carries no cache statistics at all, so nothing in its
output distinguishes a fully-cached replay from a real audit
(squirrelscan/repo#1981); the text and markdown reports do render it.

### Hosted, with rendering off

Two audits of **squirrelscan.com** (our own marketing site, 144 pages actually
crawled — not the synthetic estate, which could not be published anywhere the
crawler could reach at the time) through the hosted MCP with `render: false`,
`coverage: "full"` and `max_pages: 10000` clamped to 2,000, twenty minutes
apart.

| run | wall | peak container RSS | credits | pages reused |
|---|---|---|---|---|
| 1 | 4 m 16 s | 640 MB | 50 | 38 (304=1, max-age=4, SWR=33) |
| 2 | 2 m 53 s | 692 MB | 50 | 66 (304=1, max-age=5, SWR=60) |

With rendering off, each of these audits cost a flat 50 credits: one
`audit_base` debit, with every other line in the ledger at 0 and no per-page
fee. That is the price of a default audit with no opt-in add-ons; the separately
charged keyword-gap and content-gap features are not part of it. Reuse changes
it by nothing, because `render_cached` prices a render that was skipped and
there is no render to skip.

Run 2 was the first to carry the crawl-cache upload's new failure reporting
(squirrelscan/repo#1973, deployed between the two runs) and it reported
`upload failed 3 of 3 chunks (0 of 91 pages stored)`. The reuse both runs did
get came from objects written before the uploader broke
(squirrelscan/repo#1980). Settlement reported `settled 0 of 66 adopted pages`
(squirrelscan/repo#1969).

### The hosted path at its own 2,000-page ceiling

The 2,000-page ceiling had never been measured. The two runs above only reached
144 pages, and ranking every completed hosted audit that carries memory
telemetry by peak container RSS put 500- and 150-page runs at the top, the
largest being a 500-page script-heavy audit at 4,112 MiB. Two 2,000-page runs
did complete in July, before the runtime emitted `rssBytes`, so nothing is known
about what they cost.

So the estate was published through a Cloudflare tunnel and audited at the
ceiling: run `01M1ZQNVM2663WRX29H2W4PWRW`, `coverage: "full"`, `render: false`,
`max_pages: 10000` clamped to 2,000, crawl reuse disabled by the kill switch
that was armed at the time.

| phase | duration | peak container RSS |
|---|---|---|
| crawl, 2,000 pages | 4 m 51 s | 366-694 MB |
| tech_detect | 5.3 s | 371 MB |
| cloud_prefetch, abandoned at its budget | 10 m 00 s | 366 MB |
| rules | 9 m 23 s | 1,493 MB |
| report | 5.5 s | 1,404 MB |
| publish + finalize | 5 m 29 s | |
| the six above | 29 m 54 s | |
| **run total** | **30 m 16 s** | **1,493 MiB** |

The 22 s the phases do not account for is dispatch and the gaps between stages.

The audit completed successfully: health 73, 25,580 issues, 50 credits, no
failed stage other than the abandoned prefetch below. The crawl pulled 2,000
pages through the tunnel in under five minutes with no fetch errors and no rate
limiting.

**Peak container memory was 1,493 MiB at the ceiling**, under the 4 GiB free
container class let alone the 8 and 12 GiB paid ones, and 36% of what the
500-page all-heavy drscholls audit needed.

**The findings went through the chunked publish path, not a single POST.** The
`publish_sessions` row records 40,148 expected findings and 40,148 received,
closed `done` after 329 s. The 20 MB single-body gate that
`REPORT_LIMITS.maxPages = 2000` is documented as guarding was never in the path,
because chunked publish (squirrelscan/repo#1023) streams findings into
`page_findings` and finalizes from a tiny body. Forty thousand findings
finalized without the memory failure that the same shape produced before
squirrelscan/repo#1873 and
[#266](https://github.com/squirrelscan/squirrelscan/pull/266).

What this establishes is bounded: **one mixed-shape estate, at exactly 2,000
pages, with rendering off, stayed far inside the memory limit and never touched
the payload gate.** It says nothing about heavier estates, larger crawls, or the
single-POST path that a CLI publish still uses. It is enough to say the two
rationales for the 2,000 ceiling were not observed to bind at the ceiling, and
not enough to say what happens above it. What the run does surface is a different
limit: `cloud_prefetch` spent its entire 600 s budget and was abandoned, so a
third of the wall clock bought no enrichment (squirrelscan/repo#1995). The
second audit of the same estate, in the next section, shows that cost is paid
once per site rather than on every run — but it is paid on the audit that forms
someone's first impression of a large site, and it discards work already charged
for.

### The same hosted audit, twice

The estate was audited again 72 minutes later, identically configured. The pair
is not an A/B on anything but memory, for reasons below, but the spread between
two runs of the same workload is itself the most useful thing in it.

| | first run | second run |
|---|---|---|
| crawl, 2,000 pages | 4 m 08 s | 5 m 31 s |
| `cloud_prefetch` | 10 m 00 s, abandoned at budget | 15.5 s |
| rules | 562.8 s | 181.3 s |
| publish, findings | 329.4 s, 40,148 | 73.6 s, 44,858 |
| peak container RSS | 1,493 MiB | 1,481 MiB |
| credits | 50 | 50 |
| wall | 30 m 16 s | 11 m 42 s |

**Peak memory reproduces to within 1%. Nothing else does.** Rules moved 3x and
publish 4.5x between two runs of the same 2,000 pages. Whatever is being
measured in those two phases, a single observation of it is not worth much — and
the publish leg, which moved most, is the one with no instrumentation at all
(squirrelscan/repo#1997).

**The prefetch difference is a cold-start effect.** The first run exhausted its
600 s budget and was abandoned; the second completed in 15.5 s and charged no
`ai_parse` or `authority_signals` at all, because the results were already
computed upstream. So the cost recorded above is what a site pays the first time
it is audited, not every time (squirrelscan/repo#1995).

That also makes the two runs incomparable on findings: the first ran without
cloud enrichment because its prefetch was abandoned, so it reported 25,580
issues and health 73 against the second's 27,075 and 71.

**Crawl reuse was off for the first run** — the kill switch was armed at the time
— so the reuse store started empty and the second run reused nothing. What the
second run did do is fill the store, and that is the first look at the upload
path since it was repaired:

```
[reuse] upload failed 1 of 22 chunks (230 of 247 pages stored), gave up after 60s
```

Twenty-one of 22 chunks landed, against a previous state where all three of
three failed and nothing was stored.

The denominator is the more interesting number, and it is not an eligibility
figure. `gave up after 60s` is the uploader's `time-budget` arm, and its own
doc comment says that when it fires the counts describe what was **attempted**,
not the crawl. So 247 is how many pages the uploader got through in
`CRAWL_CACHE_UPLOAD_BUDGET_MS` of 60 s; the other ~1,753 pages were never
attempted. **230 of 2,000 pages became reusable, about 12%**, and since the
budget is a fixed minute, that fraction falls as the crawl grows — at the
10,000-page ceiling the same minute would cover proportionally less again.

For scale, the upload managed about 4 pages per second against a crawl that
fetched 2,000 pages in four minutes, so preserving a page is roughly an order of
magnitude slower than fetching it. That gap seems worth understanding before the
budget is simply raised (squirrelscan/repo#1999).

### Three harness defects found while doing this

**Every warm row produced by `stages.sh` and `run-stage.sh` was a second cold
crawl.** The harness started a fresh origin per stage with no fixed port, so the
OS assigned a new one each time and the warm stage crawled
`http://localhost:<new port>/p/N`. The content store and the incremental path
are URL-keyed, so nothing was stored under those URLs: the warm stage re-fetched
all N pages and reported no cache hits at all. This does not touch measurements
taken outside those two scripts — the statement-compilation census above ran a
genuine warm re-crawl and counted per-reused-page statements, which could only
happen on a matching origin. `BENCH_PORT` now pins the origin across a pair, is
rejected unless it is an integer in range, and is checked against the port the
server actually bound; the request log records `If-None-Match` so a revalidating
stage is visibly different from one re-fetching blind.

**The estate served no validators.** It sent `Cache-Control: public,
max-age=600` with no `ETag` and no `Last-Modified`. That freshness window alone
does permit reuse, so this was not what suppressed it — the port was — but it
left the estate unable to answer a conditional request, so nothing past the
freshness window could ever revalidate rather than re-download. It now sends
`max-age=60` with a long `stale-while-revalidate`, a content `ETag`, and a
`Last-Modified` derived from the fixture salt, which keeps the date stable when
the server restarts between stages and moves it when the fixture content
actually changes.

**The exit heap sample did not collect first**, despite the harness README
saying it did, which is what produced 2,461 MB and 1,275 MB for the same
workload. A separate 10,000-page run sampled that way reported 4,425 MiB where
the collected figure from an equivalent run is 2,264 — different runs, not a
paired before/after, but the same order of discrepancy. It
forces a collection now, and every collected-heap figure in the 1,000-to-10,000
page tables was taken after the fix (the older tables in this document are
unaffected and unchanged). Note that the forced collection costs wall time on a multi-GB
heap and `/usr/bin/time` measures until exit, so a stage's wall time now
includes it.

The phase table's `rules` and `site` columns read trace spans the resident
pipeline used to emit. The streaming pipeline (#252) emits neither, so both had
been printing `0s`, which reads as "the rules phase was free" when it is most of
the wall time. They print `n/a` now.

## Still open

- Site rules were measured as quadratic in page count (4 s at 400 pages, 99 s
  at 2,500, 687 s at 5,000): squirrelscan/repo#1910. The
  1,000-to-10,000-page pass above contradicts the 5,000-page figure — the whole
  5,000-page audit finished in 359 s, less than that row attributes to site
  rules alone — so the issue needs re-measuring before it is worked.
- Report reconstruction materializes every check, including the 83.7% that
  pass and never reach the report: squirrelscan/repo#1920. Reading them once
  rather than twice is done (above); dropping the passing rows needs a decision
  about the publish payload first.
- The page ceilings moved on the evidence above: #278 took `MAX_PAGES_CAP` and
  `REPORT_LIMITS.maxPages` to 10,000 and Team/Enterprise to a 10,000-page
  audit. What is still open is the hosted side actually being exercised there —
  everything measured above stops at 2,000 — and the prefetch budget, which
  already failed at 2,000 (squirrelscan/repo#1995) and is a flat wall-clock cap
  against work that scales with the crawl.
- `legal/cookie-consent` (8.2 ms/page) and `social/share-buttons` (6.4) are now
  the top of the script-heavy rules phase and were left alone. The first is
  seven full-document `querySelectorAll` passes with substring attribute
  selectors, which is a linkedom cost rather than a regex one. The second
  lowercases the whole page for four `/i` patterns that do not need it — and
  removing that is NOT a no-op, because `String.toLowerCase` and the `i` flag
  disagree: `"K".toLowerCase()` is `"k"` while `/k/i` does not match
  `K`, and the same for `İ` and `i`. It needs a decision, not a patch.
- The finalize rewrites every carried finding to stamp `provenance`, even when it
  already reads "carried" from an earlier run. A no-op write is most of the write
  traffic on a site that carries the same backlog audit after audit.
