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

### The same pair again, after the repairs

Every fix above shipped, and the pair was repeated on the same site to see
whether the numbers moved: 150 pages, coverage full, render on, 45 minutes
apart, on a container image carrying all of them. Two runs, both landing on the
same total.

| | run 1 | run 2 |
|---|---|---|
| pages crawled | 150 | 150 |
| pages reused | 36 | 134 |
| `render` debits | 115 rows, 230 credits | 17 rows, 34 credits |
| `render_cached` debits | **1 row**, 35 units, 70 credits | **3 rows**, 133 units, 266 credits |
| settled | 35 of 35 | 133 of 133 |
| ledger total | **350** | **350** |
| health | 72 | 72 |
| pages / errors / warnings reported | 139 / 162 / 1,351 | 139 / 162 / 1,351 |

**Settlement is the headline.** 133 adopted pages settled in three debits, one
per chunk, where the same operation previously charged 12 of 36 individually and
then timed out. The `render_cached` row count is the whole change: one debit
carrying 133 units instead of 133 debits.

**Both runs cost exactly 350 credits**, which is the arithmetic a fully settled
run has to produce: 50 base, then two credits for each of the 150 pages, whether
each page was rendered or served from cache. Run 2 rendered 17 and reused 133,
and 17 + 133 = 150. No page was billed twice, and none escaped billing. The
earlier pair's 302 was a settlement shortfall, and it is gone.

**The two reports are identical** — same page count, same 162 errors, same 1,351
warnings, same health — while run 2 rendered 17 pages instead of 115. That is
the property reuse is actually for, and the one that was never true before:
adopting a stored body produced the same audit as fetching it.

Reuse jumping from 36 to 134 is the render-mode gate working rather than the
cache warming. The store also held raw bodies written by unrelated render-off
audits of the same site, and those were refused to both of these runs and
re-fetched, exactly as intended. A rendering audit that adopts a raw body
analyses unrendered markup while reporting otherwise, and is billed *less* for
it, so every signal points the wrong way (squirrelscan/repo#1984).

**One thing did not come clean.** Both runs logged the same line:

```
[reuse] upload failed 1 of 6 chunks (133 of 150 pages stored)
```

Same count, same 17 pages, both times. Against the previous state of `0 of 91`
that is most of the distance, but it is a repeatable single-chunk failure rather
than a transient, and there is no `gave up` clause, so neither the
consecutive-failure breaker nor the wall-clock budget was involved. Those 17
pages are never stored, so every later audit re-renders them: in run 2 the pages
billed as `render` were exactly that set. Their sizes are unremarkable, around
105 KB against a 94 KB crawl average, so the obvious explanation does not hold
up (squirrelscan/repo#2000).

Note the denominator here means what it says. At 150 pages the upload finishes
inside its minute, so `150` is the crawl. In the 2,000-page run recorded further
down it is not: there the budget expired and the figure describes only what was
attempted.

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
([#259](https://github.com/squirrelscan/squirrelscan/pull/259)).
Measured on two audits of a 60-page site, keeping one:

| measurement | before | after |
|---|---|---|
| `project.db` | 11.5 MB | 5.7 MB |
| page rows for the retired crawl | 60 | 0 |
| next audit's pages fetched | | 0 of 60, all unchanged |

That last row is the one that matters: the reclaim keeps the newest page record
per url, so an incremental re-audit still serves every page from its conditional
GET rather than refetching the site.

A trap worth recording: `VACUUM` alone made the file BIGGER, 189 MB to 239 MB.
In WAL mode the rewrite lands in the write-ahead log, so the main file shrinks
while the `-wal` beside it grows by more than was saved. `PRAGMA
wal_checkpoint(TRUNCATE)` after the vacuum, and measuring after the connection
actually closes, is what makes the saving real.

### Automatic retention: keeping the last three

Retention is now on by default at three audits per project
(`[storage] keep_audits`), which is what turns the growth above into a ceiling.
Five audits of a 40-page fixture site into one project, both arms measured after
`PRAGMA wal_checkpoint(TRUNCATE)` so the `-wal` is not hiding either result:

| after 5 audits | `keep_audits = false` | `keep_audits = 3` |
|---|---|---|
| `project.db` family | 14.71 MB | 11.85 MB |
| free inside the file | 0 | 2.82 MB (23.9%) |
| `pages` rows | 200 | 120 |
| `rule_results` rows | 40,445 | 24,267 |
| audits listed | 5 | 5 (2 marked `retired`) |
| pages fetched by audit 5 | 0 of 40 | 0 of 40 |

The last row is the one worth checking, and it is checked on the audits that ran
AFTER data was retired: retirement never takes the newest page record per url,
so a re-audit still answers every page from its conditional GET. The first audit
fetched 40 of 40 and every audit after it fetched 0.

A sixth audit of the same site left the file at 11.86 MB — the same as the fifth,
which is what a ceiling looks like. Three audits renderable, three listed as
retired, 120 page rows throughout.

The freed space stays inside the file on purpose. At a window of three, an audit
retires one audit's worth of rows every time, and that is about a quarter of the
file — so a share-based VACUUM threshold would rewrite the whole database after
every single audit, forever. Left alone those pages are reused by the next
audit's inserts and the file plateaus. The pass only rebuilds the file when more
than one audit goes at once (retention switched on over a backlog, or the window
lowered) AND the free space is over 200 MB or a quarter of the file.

What the pass costs, on a synthetic project of four audits, load average ~3:

| pages per audit | nothing to retire | one audit retired |
|---|---|---|
| 1,000 | 0.35 ms | 59 ms |
| 2,500 | 0.41 ms | 281 ms |

The common case is the first column: until a project has run more audits than
the window keeps, the whole pass is one query over `crawls`, which holds one row
per audit.

### The index the retention pass needed, and the scan it was hiding

`pages` is keyed `(crawl_id, normalized_url)`, so nothing could serve a lookup by
`normalized_url` ALONE — and the predicate that decides which page rows a
retirement may delete is exactly that, correlated, once per candidate row:

```text
SEARCH p USING INDEX idx_pages_crawl (crawl_id=?)
CORRELATED SCALAR SUBQUERY 1
SCAN newer                                   <- the whole pages table, per row
```

Quadratic in the size of the table, and #259 shipped it that way because a prune
is something a user asks for once. Automatic retention runs it after every
audit, which is criterion 5 of squirrelscan/repo#1912 — the pass must not
reintroduce a per-audit full scan. Retiring one crawl of four, ~8 KB of html per
row:

| `pages` rows | `SCAN newer` | `idx_pages_url_recency` |
|---|---|---|
| 4,000 | 80 ms | 9.5 ms |
| 10,000 | 493 ms | 29 ms |
| 40,000 | 11,779 ms | 61 ms |

Migration 26 adds `idx_pages_url_recency (normalized_url, fetched_at)`. The same
index covers `getCachedPage`, which runs the same lookup once per url on every
incremental re-audit and was also scanning the table.

Two more plan defects came out of reviewing that, both invisible in the row
counts and both the same shape:

- The recency half of the predicate was `a > b OR (a = b AND c > d)`, which can
  seek to the url and must then walk every version of it. Written as the row
  value `(newer.fetched_at, newer.rowid) > (p.fetched_at, p.rowid)` — the same
  rows, ties included, asserted against the old spelling rather than argued —
  the plan becomes `normalized_url=? AND fetched_at>?`, a range seek.
- The sweep that collects page rows of already-retired crawls reads `SCAN p`,
  every row in `pages`, when it is written as a join in either direction. As
  `crawl_id IN (SELECT id FROM crawls WHERE retired_at IS NOT NULL)` it seeks
  `idx_pages_crawl` per retired crawl instead. A partial index on
  `crawls(retired_at)` keeps the inner list off a table that only grows.

The gates for all three are `EXPLAIN QUERY PLAN` assertions, because the index
existing proves nothing if the planner does not choose it, and a timing on a
loaded box proves nothing at all.

`pages` is the hottest write table in a crawl, so the index has to pay for
itself there too. 2,000 page inserts of 8 KB of html each, one statement per
page as the crawler writes them, median of three alternating runs:

| | without | with `idx_pages_url_recency` |
|---|---|---|
| insert 2,000 pages | 329.4 ms | 325.6 ms |
| file after checkpoint | 17,752,064 B | 17,911,808 B |

The time difference is noise in the wrong direction, and the file is 0.9%
larger. Set against a read it takes from a full table scan to a seek on every
incremental re-audit, that is not a trade-off.

What the migrations cost the people who already have data: a real 100 MB
`project.db` recorded at version 24, holding one crawl of 1,000 pages and
203,687 rule results, opened at version 27 in **69 ms**. That includes adding
both columns and building all three indexes over its page rows, once, on first
open. Every row survived and its page cache still read back.

The sweep is the one that took three attempts, and the lesson is that "bounded"
has to name a variable. Driven by a join it was bounded by the size of `pages`.
Driven by a list of every retired crawl id it was bounded by the number of
audits the project had ever retired, which only grows. Driven by the urls the
current crawl just wrote it is bounded by the audit, and that is also exactly
the set that can have changed, since a page row only becomes superseded by an
audit crawling its url again.

Retention also needed to know what an audit SAID, not just that it finished.
`crawls.status` reads `analyzed` for a run whose report came out `blocked`, so
counting crawl rows meant three good audits, two days of a site being down and
one recovery run would keep the two blocked runs and delete all three audits
from before the outage. Migration 27 records the report's own status on the
crawl, which also carries a `building` sentinel between the analyzed transition
and the report being reconstructed: without it a second audit of the same
project can retire a crawl whose own process is still reading it, and turn a run
that was going to succeed into "Audit data was reclaimed".

Adding an index can silently reorder ties, which is how a byte-identical output
stops being byte-identical
([#258's lesson](https://github.com/squirrelscan/squirrelscan/pull/258)). Both
readers here specify their tie-break — `ORDER BY fetched_at DESC, rowid DESC` in
one, `newer.rowid > p.rowid` in the other — so the result is the same under
either plan, and there is a test that asserts it with the index present. The
gate is the query PLAN rather than a timing, because a timing on a loaded box
proves nothing and an index that exists but is not chosen proves less.

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

85 are constant on both. Only 26 were declared safe to fan out
([#269](https://github.com/squirrelscan/squirrelscan/pull/269)), and #279 later
demoted one of those to page scope, leaving 25: the rest are
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

## Running a rule once per template: 13% of the page-rule pass, not 96%

The clustering measurement above says 96.5% of gymshark's page-rule time is spent
on pages that are not the first of their chrome cluster. That is the ceiling if
every rule could be run once per template. 25 of 198 page rules are declared safe
to fan out, and this is what those 25 are worth
([#279](https://github.com/squirrelscan/squirrelscan/pull/279)).

The measurement is of the streamed page-rule pass alone (`streamPageRules`), which
is sync CPU over stored HTML and reaches no network. Each arm runs in its own
child process, the arms are interleaved, and both the median and the minimum of
the repeats are reported. **CPU time, minimum of the repeats, is the number to
read.** Wall time on a shared box is mostly a measurement of what else is running
on it: an earlier pair of seven repeats swung 66 to 101 s on the same arm, and
with three repeats the median is one sample, so a single bad sample moved the same
comparison from 9.3% to 5.4%. Load average 2.2 to 3.8 throughout the runs below.

| corpus | pages | clusters | cpu off | cpu on | delta (min) | delta (median) |
|---|---|---|---|---|---|---|
| gymshark.com (real) | 247 | 13 | 233.6 ms/page | 203.5 ms/page | **12.9%** | 10.8% |
| drscholls-shaped synthetic | 150 | 1 | 114.4 ms/page | 94.2 ms/page | **17.6%** | 16.8% |

The synthetic corpus is the ceiling case for these 25 rules and not a site: all
150 pages are one template, so 149 of 150 inherit every declared verdict. It buys
17.6%, against the real storefront's 12.9%. **The saving is a property of the
declared set, not of how redundant the corpus is**, and anyone reading 96.5% as
the expected win will be disappointed by design. Reaching further means declaring
more rules, which is a soundness decision rather than a code change.

Rule invocations on gymshark fall from 48,906 to 43,056: each of the 25 declared
rules goes from 247 calls to 13. Where the time was, from a profiled run (summed
`durationUs`, never `durationMs` — the latter rounds to whole milliseconds and a
page rule's thousands of sub-millisecond samples sum to nonsense):

| rule | ms over 247 pages | ms over 13 |
|---|---|---|
| `perf/js-libraries` | 1795.3 | 74.4 |
| `analytics/consent-mode` | 1447.1 | 56.2 |
| `analytics/gtm-present` | 1015.8 | 38.8 |
| `a11y/focus-visible` | 338.6 | 13.1 |
| `core/favicon` | 277.7 | 11.5 |
| `security/third-party-cookies` | 240.9 | 9.8 |
| `local/geo-meta` | 234.5 | 9.3 |
| `perf/legacy-js` | 228.0 | 9.3 |
| the other 17 | 735.3 | 33.2 |
| **total** | **6313.2** | **255.6** |

The 6,058 ms those rule bodies give up accounts for 93% of the 6,531 ms of CPU
that same profiled run moved, so the attribution and the delta agree. Three of
those rules are most of it, and all three scan the page's whole HTML.

### One rule was demoted rather than fanned

`core/charset` came out of #269 declared "template" and is constant in every
cluster of every corpus in every gate. It is page-scoped anyway, because its
verdict can come from the `Content-Type` RESPONSE HEADER, which the cluster key
constrains in no way: two pages of one template, one served
`text/html; charset=utf-8` and the other bare `text/html`, give `pass` and `fail`.
Every page of all three corpora declares its charset in a `<meta>` tag, so the
header branch is never reached and no measurement over them could see it.

That is the general shape of the residual risk, tracked as
[#275](https://github.com/squirrelscan/squirrelscan/issues/275): the cluster key
is chrome, so a constructed pair can share it and still differ in a declared
rule's inputs. Two things are not left to the declaration — the fan-out groups by
page ORIGIN as well as by template (`security/sri` compares it), and a rule
reading a response header is disqualified outright.

### Byte-identity

The claim is that the output is indistinguishable from running every rule on every
page, and it is checked three ways rather than asserted:

- `template-fanout-equivalence-golden.test.ts` compares the fanned pass against a
  resident loop that runs everything on everything, over an authored corpus with
  three real multi-page clusters and two singletons, on the complete per-page check
  lists, the per-rule results and the folded tallies.
- `apps/cli/scripts/template-fanout-bench.ts --verify` does the same comparison
  against a real crawl, because a CI fixture only ever proves something about the
  pages it contains. Byte-identical on gymshark.com, openelectricity.org.au and the
  150-page synthetic.
- `packages/rules/tests/template-verdict-page-independence.test.ts` runs each
  declaring rule on the same HTML under two urls that share only scheme and host.
  Copying a verdict onto another page is only sound if it carries nothing about the
  page it ran on, and the fan-out deliberately does not rewrite urls inside a copied
  check: the normalisation that would have to be inverted is not injective.

Equal output is also exactly what a feature that does nothing produces, so the
gates count calls as well as compare values: a rule declaring
`verdictScope: "template"` must run once per CLUSTER and an undeclared one once per
PAGE, and the pass reports the invocations it removed.

## Caching a page's rule results: the re-audit that was not faster

The re-audit measurement above ends on a flat statement: a second audit of an
unchanged 2,500-page estate fetched nothing and was not faster, because parse,
page rules, the page-time collectors and report reconstruction re-run in full on
every page whether or not that page changed. This is what caching that work
instead of the bytes is worth
([squirrelscan/repo#1990](https://github.com/squirrelscan/repo/issues/1990)).

A page replays its stored rule results when every input those rules read is
unchanged: the page's exact HTML bytes, its status, headers, redirect chain and
response timings, the build that produced the results, and the enabled rules with
their resolved options. A replayed page is never parsed and its rules never run.
Site-scope rules always run.

Both arms are the SAME build. `SQUIRREL_RULE_CACHE=0` is the only difference,
which is the point: an A/B across two builds is an A/B across two of everything.
2,500 pages of the mixed synthetic estate, one pinned origin across each pair, a
fresh content store per pair, load average 2.4 to 4.1 except where noted.

| stage | wall | rules phase | report phase | crawl | project.db |
|---|---|---|---|---|---|
| cache off, cold | 178 s | 116 s | 22 s | 39 s | 258 MB |
| cache off, warm | 143 s | 110 s | 18 s | 13 s | 514 MB |
| cache on, cold | 177 s | 124 s | 19 s | 33 s | 291 MB |
| **cache on, warm** | **44 s** | **12 s** | 18 s | 13 s | 581 MB |

**The warm rules phase falls from 110 s to 12 s, and the warm run from 143 s to
44 s.** All 2,500 pages replayed, which the report says and nothing else in it
does — the findings are identical by construction.

Read the rules-phase column rather than the wall, and compare WITHIN a pair. The
cache-off rules phase came in at 131 s on a loaded evening and 110 s on a quiet
one, which is most of the spread this table would otherwise be asked to explain;
12 s against 110 s in the same pair is not inside it.

**Byte-identity holds at scale.** The cache-on cold and warm reports are
identical, all 3,039,997 bytes of them, once `meta.timestamp` and the replay
disclosure itself are removed. That is 2,500 pages replayed against 2,500 pages
evaluated, on the full default rule surface.

Two things the warm row makes visible that were hidden behind the rules phase:

- **Report reconstruction is now the largest phase of a re-audit** — 18 s of a
  44 s run, against 12 s of rules. squirrelscan/repo#1920 was already open on it;
  it is now the thing to work.
- **A warm crawl still costs 13 s** with nothing to fetch, which is frontier and
  bookkeeping work rather than bytes.

### The cache and template fan-out do not compose, and the cache wins

Fan-out (above) and this cache are two ways of not running a rule, and enabling
the cache turns fan-out OFF for that run. The reason is not performance:

A fanned verdict belongs to the page's CLUSTER, so no per-page key can capture
what it depends on. Cache two pages of one cluster, then change the FIRST one —
the cluster's representative. It is fresh and records its new verdict; the second
page replays the verdict it inherited from the representative's PREVIOUS run, and
every fully-replayed audit after that repeats the stale value. A fresh audit gives
it the new one. Nothing about the second page changed, so nothing about its key
can notice. Making them compose means caching the cluster's verdict against its
representative's identity, which is a whole-crawl property the streamed loop
resolves as it goes — a design rather than a patch, and a follow-up.

What that costs, in the cold row above: **the rules phase goes from 116 s to
124 s, 6.9%**, which is fan-out's share of the fannable rules plus the cache's own
writes. Cold wall time is unchanged (178 s against 177). Every audit after the
first takes the 89%.

It also changes the report. The cache-on cold report is 3,039,997 bytes against
3,043,863 with fan-out on: turning fan-out off is the more accurate of the two,
because every rule then really runs on every page rather than inheriting a
cluster-mate's verdict. That difference is #275's open question about the
chrome-only cluster key, now visible rather than argued.

### What it costs a cold run, and what that took to establish

At gzip's default level 6, four interleaved cold stages put the cache-on rules
phase 9.4% above cache-off at the minimum of two repeats (127 s to 139 s) — one
payload per page serialized and compressed on the run that gets nothing back for
it. Dropping to level 1 moved the compression cost under the noise floor, and it
is the right trade because these rows are retired with their crawl: the extra
bytes live no longer than the audit does, while the cold run's cost is paid by
every first-time user. What remains in the 6.9% above is mostly fan-out's absence.

Storage: `project.db` grows about 12.8% (258 to 291 MiB cold, 514 to 581 warm).
The rows are retired with their crawl, so the automatic retention window bounds
them rather than letting a permanent second copy accumulate. Verified against the
window that landed the same evening: five audits of a 40-page project leave two
crawls retired and cache rows under exactly the three that remain (120 rows for
3 x 40 pages), while every audit after the first still replays all 40. That is
what the carry-forward is for — an entry is copied into each new crawl, so
retiring the crawl that produced it never makes the next audit cold.

The table above was measured just before that window landed; retention adds tens
of milliseconds to an audit, against a 44-second warm run.

### What two adversarial review rounds found that the gates did not

Sixteen findings across three `codex` passes, all fixed. The third pass returned
nothing above P2. The four worth recording:

**Fan-out composition, twice.** The first round found that a replayed page
abstaining from fan-out changes which page is elected representative. The fix —
letting a replayed page record, keyed on its stored `template_fp` — closed that
direction and the second round showed the other one: when the REPRESENTATIVE is
what changed, its cluster-mates' cached verdicts are stale and no per-page key can
see it. That is what made the two features mutually exclusive. Both rounds
reproduced their case; the first is now a regression test, mutation-checked.

**`pages.content_hash` cannot be the key, and looks like it can.** It is a
whitespace-NORMALIZED hash, so the incremental crawler can call a reformatted page
unchanged. Two pages that differ only in whitespace share it and parse to
different word counts, inline-script lengths and `<pre>` text. Keying on it would
have replayed one page's verdicts onto another's markup, and every gate would have
stayed green, because no fixture contains that pair. The cache keys on a new
exact-bytes hash, which the content store had already computed.

**A cache changes what the clock and the calendar mean.**
`content/stale-copyright` reads `new Date().getUTCFullYear()` at execution, so a
pass cached on 31 December would replay on 1 January; the current UTC year is now
part of the run context, and replay stops for the rest of any run that crosses the
boundary while it is going. `content/date-agreement` resolves a bare schema date
through `Date.parse`, which reads it in LOCAL time, so the same page yields a
different year under `UTC` and under `Australia/Sydney`; the runtime time zone is
in the key too. Neither was reachable by reasoning about the page.

**Hashing the run context whole made the cache do nothing, silently.** The first
implementation hashed the `SiteData` fields page rules read as whole objects. One
of their fields is `cacheReason`: "cache-hit reason if reused from a prior crawl;
null on a real fetch". Null on every cold run and set on every warm one, so the
run context differed between exactly the two runs that are supposed to match,
every page missed, and the feature reported success while saving nothing. The key
now covers only the entry fields rules actually read, and a test proxies those
entries to fail if a rule reads one outside the list. **A cache that stops hitting
is indistinguishable from a cache that is working unless something counts the
hits** — which is why the replayed-page count is in the report and asserted in the
gates rather than inferred from a wall-clock delta.

### Attributing the rules phase at all

`phases.ts` printed `rules n/a` for every run on the streamed pipeline: it read
the two v1 spans, which #252 stopped emitting. The CLI has computed the whole
per-phase breakdown since #857 but only at debug level, so it now also writes one
machine-readable line to the trace log — the flag whose entire job is timing
attribution. Every rules-phase number in this section comes from it.

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
