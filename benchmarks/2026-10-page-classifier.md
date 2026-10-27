# 2026-10 Page classifier

What the bundled page classifier costs, and what it adds to link findings
(squirrelscan/repo#2307). It reads each page's DOM once, after the crawl
parses it, and names the part of the page a link sits in where the markup
says nothing. The model ships inside the executable.

Machine: 16 GB Apple M2, macOS 15, other work running (load average 4 to 7,
swap nearly full), so absolute milliseconds are inflated. Compare the paired
rows. Bun 1.3.14. Artifact: the v2.3.0 featurizer's, 8.8 MB, with the region,
page type and section heads (pagination bar .80, social_share .85).
Method: [`apps/cli/scripts/bench-classifier.ts`](../apps/cli/scripts/bench-classifier.ts).
Each page is parsed three times per variant, alternating, and the minimum is
kept. The model is loaded before timing starts and reported on its own.

## Per page

`parsePage` with and without the classifier hook, milliseconds per page.

| pages | HTML size | without, p50 / p95 | with, p50 / p95 | overhead p50 / p95 / max |
|---|---|---|---|---|
| 100 synthetic (`packages/synthetic-site`) | p50 58 KB, max 78 KB | 2.1 / 3.9 | 5.0 / 9.7 | 2.8 / 6.8 / 13.8 |
| 117 real pages from squirrelscan's own public sites | p50 106 KB, max 415 KB | 7.7 / 25.2 | 22.8 / 81.2 | 14.2 / 55.9 / 63.6 |

Model load is 12 to 14 ms, once, on the first classified page (19 to 31 ms in `squirrel self doctor`). No page hit the
500 ms per-page budget.

## Whole audit

`squirrel audit` of a 100-page synthetic site served locally (`--offline`,
`--max-pages 100`), six rounds, off and on interleaved, wall time:

| classifier | min | median |
|---|---|---|
| off (`--no-classifier`) | 4.25 s | 4.69 s |
| on | 4.72 s | 4.89 s |

A 0.2 to 0.5 s difference on 100 pages (an earlier run on a quieter machine read
0.14 to 0.20 s), in line with the per-page overhead above. Real sites are fetch-bound, so the classifier is a small share of an
audit. A single round on a busier machine read +1 s; interleave and repeat.

## Binary and startup

| | before | after |
|---|---|---|
| `bun build --compile --splitting --minify` | 72.6 MB | 81.5 MB |
| `squirrel --version`, median of 11 cold runs | 34 ms | 36 ms |

The artifact is embedded as a file and read on the first classified page, so
commands that never audit do not parse it.

## What it adds

On sites with good markup, little. Of 14,477 links on 60 pages of squirrelscan's
own sites, 78 sat outside every landmark, and for those the model said "site
furniture" (which a finding cannot quote) or nothing. Its one section answer on
those pages was pagination, for 34 links inside navigation or content markup.
The model is for pages without landmarks.

To see that, `--stripped` rewrites `nav`, `header`, `footer`, `aside`, `main`
and `article` to `div` and drops the roles, then asks the model alone where each
link sits, against what the original markup said (117 pages, 26,866 links).
It answers 10.7% of them, by design: every class has a threshold chosen for
precision. What it answers agrees with the markup, and it names a section the
markup could not: 64 pagination links that the markup called navigation.

| original markup | model, footer | model, content | model, pagination | model, navigation | model, no answer |
|---|---|---|---|---|---|
| footer | 1,087 | 0 | 0 | 0 | 998 |
| content | 9 | 1,182 | 0 | 0 | 797 |
| header | 0 | 0 | 0 | 462 | 628 |
| navigation | 37 | 1 | 64 | 0 | 10,718 |
| sidebar | 0 | 0 | 0 | 31 | 10,698 |

## What it changes in findings

A model section purpose refines a `nav` or `aside` landmark; the header, the
footer and comment threads stay with the markup. On the 117 real pages (26,371
links) the classifier changed the section of 64 links, all from navigation to
pagination, on 32 pages. It changed no other link. On the 100 synthetic pages it
changed none.

Re-run the three modes (`--dir`, no flag, `--stripped`) whenever the artifact is
swapped. The default mode prints these counts.
