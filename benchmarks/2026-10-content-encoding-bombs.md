# 2026-10 Content-Encoding bombs

Peak memory of the crawl's fetch paths when a response is a compression bomb:
1 GiB of spaces sent as about 1 MB of gzip or about 200 KB of brotli
(squirrelscan/repo#2717). Bun's fetch inflated a `Content-Encoding` body in full
as soon as it arrived, whether the caller read it under a byte cap, cancelled it
unread or discarded it with a redirect, so no cap in the crawl bounded one. The
fix fetches with the runtime's decoding off (`decompress: false`) and decodes
the body with node:zlib while reading it, no further than the read's cap.

Machine: 16 GB Apple Silicon laptop, macOS 15, other work running.
Method: [`harness/encoding-bomb.ts`](./harness/encoding-bomb.ts). The bomb server
runs in its own process, each case runs in a fresh process after a warm-up
request and `Bun.gc(true)`, and the figure is the peak RSS growth sampled every
2 ms during the call. Before is `main` at the parent commit, after is the fix,
each as the minimum and maximum of interleaved repeats (2 before, 3 after). Bun 1.4.0 is what the CLI and the cloud containers run.

| case | cap | before, Bun 1.3.14 | after, Bun 1.3.14 | before, Bun 1.4.0 | after, Bun 1.4.0 |
|---|---|---|---|---|---|
| page, uncompressed 1 GiB body (control) | 10 MiB | 50 MB | 46 to 58 MB | 44 to 46 MB | 42 to 47 MB |
| page, gzip bomb | 10 MiB | 2,484 to 2,807 MB | 39 to 44 MB | 126 to 137 MB | 36 MB |
| page, brotli bomb | 10 MiB | 2,620 to 2,945 MB | 45 to 46 MB | 243 to 270 MB | 36 to 41 MB |
| page behind a 302 whose own body is a brotli bomb | 10 MiB | 1,998 to 2,740 MB | 1.3 to 2.0 MB | 213 to 437 MB | 1.9 to 2.1 MB |
| document fetcher (`@squirrelscan/fetchers`), gzip bomb | 10 MiB | 1,740 to 1,919 MB | 41 to 42 MB | 119 to 157 MB | 35 to 36 MB |
| robots.txt, brotli bomb | 512 KiB | 2,620 to 2,733 MB | 8 to 12 MB | 659 to 667 MB | 11 to 13 MB |
| llms.txt, chunked gzip bomb | 1 MB | 2,675 to 3,175 MB | 14 to 19 MB | 1,073 to 1,120 MB | 10 to 13 MB |
| well-known sweep, 20 paths at once, chunked gzip bombs | 256 KiB each | 3,196 to 3,324 MB | 67 to 77 MB | 1,952 to 2,405 MB | 53 to 62 MB |
| agent access, 3 identities, chunked gzip bombs | 512 KiB each | 3,070 to 3,278 MB | 15 to 21 MB | 1,872 to 1,880 MB | 12 MB |

Reading the table:

- A bomb now costs what an uncompressed body over the same cap costs (the
  control row). The page figure is 3 to 5 times the 10 MiB cap because of
  the reader, not the decoding: holding 10 MiB of bytes and the string decoded from
  them is 21 MB on its own, and the rest is chunks waiting for collection. It
  is unchanged by this fix.
- The small-cap rows are mostly fixed per-request cost (sockets, decoder state,
  the raw body Bun buffers ahead of the reader), which is why 20 concurrent
  well-known probes cost more than 20 x 256 KiB.
- A brotli decoder keeps a window of up to 16 MiB, the format's maximum, for as
  long as it reads. Twenty concurrent 256 KiB reads of a bomb compressed with
  that window measured 357 to 367 MB; inflated, the same twenty bodies are 20
  GiB. That
  cost is per open stream, not per byte inflated.
- Bun 1.4 inflates less eagerly on a single page fetch than 1.3.14 did, but
  the probes, which read several bombs at once, still reached 2.4 GB, and so
  did a whole audit (see [End to end](#end-to-end)). The regression tests
  (`packages/utils/tests/fetch-undecoded.test.ts`,
  `packages/crawler/tests/content-encoding-bombs.test.ts`) assert the bound on
  whatever runtime runs them, CI included.

## End to end

`squirrel audit http://127.0.0.1:<port>/ --offline --http
--max-pages 10` against a four-page site whose `/bomb` page is the gzip bomb,
whose `/moved` redirect carries a brotli bomb in its own body, and whose
robots.txt and llms.txt are bombs, with maximum RSS from `/usr/bin/time -l`:

| CLI | site with bombs | same site without |
|---|---|---|
| released v0.0.108 (Bun 1.4.0) | 2,275 to 2,816 MB | 163 MB |
| this fix, compiled with Bun 1.3.14 | 362 to 365 MB | 221 MB |

Both reports are identical: 4 pages, score 46, `crawl/html-size` failing
`/bomb` at 10.0 MB, `crawl/robots-txt` warning that robots.txt is very large.
