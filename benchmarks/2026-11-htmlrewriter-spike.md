# 2026-11 HTMLRewriter vs linkedom for parse-time extraction (spike)

squirrelscan/repo#599 (spun out of #263). Question: can Bun's native `HTMLRewriter` (lol-html, streaming) replace linkedom as the source of rule inputs, and would a serializable `ParsedPage` re-open page-rule parallelism (#263) and remove the crawl-to-audit double parse (#267)?

**Decision: no-go on replacing linkedom as the rule input.** Keep it. A native pass is about 4x faster on the extractor subset it can express, but 183 of 336 rule files read the DOM directly, several extractors need ancestor context or a full tree, and lol-html is a tokenizer with no HTML tree builder, so malformed markup extracts differently. The serialization blocker is smaller than the issue assumed. No follow-up issues are filed, because the decision is not go.

## How

`bun benchmarks/harness/htmlrewriter-spike.ts --runs=15`. Generated pages (heading, paragraph, 5 links, an image and a `<noscript>` image per section, plus head metadata and JSON-LD) at 13 KB, 60 KB, 292 KB and 1,456 KB. Min of 15 runs after a warm-up, same process.

- linkedom path: `parseHTML` plus `extractMeta`, `extractOG`, `extractTwitter`, `extractH1`, `extractHeadings`, `extractLinks`, `extractImages`, `extractSchema` from `packages/parser/src/html.ts`.
- HTMLRewriter path: the prototype in the harness, one streaming pass producing the same fields as plain JSON (title, description, canonical, robots, OG, Twitter, headings and H1, links with text and `rel`, images outside `<noscript>`, JSON-LD types).
- Parity: the harness diffs both outputs per page (title, description, canonical, robots, OG, Twitter, H1 texts, headings with level and text, resolved link URLs, resolved image sources, JSON-LD types). All rows match on the generated well-formed pages.

Machine: x86_64 Linux sandbox, 48 cores, Bun 1.4.4. Single thread, so absolute numbers are indicative; the ratios are the result.

## Benchmark

| page | linkedom `parseHTML` only | linkedom parse + extract | HTMLRewriter extract | speedup (full) | speedup vs parse alone | + `structuredClone` of the output |
|---|---:|---:|---:|---:|---:|---:|
| 13 KB | 0.58 ms | 1.13 ms | 0.23 ms | 5.0x | 2.6x | 0.24 ms |
| 60 KB | 1.46 ms | 3.59 ms | 0.90 ms | 4.0x | 1.6x | 1.11 ms |
| 292 KB | 5.22 ms | 18.08 ms | 4.55 ms | 4.0x | 1.1x | 5.48 ms |
| 1,456 KB | 27.37 ms | 92.52 ms | 22.54 ms | 4.1x | 1.2x | 29.00 ms |

Reading it: the native pass is about 4x faster than linkedom parse plus the eight extractors. Against the bare linkedom parse it is only 1.1x to 2.6x, because the streaming pass has to do the extraction work itself. The 4x applies only to the fields the prototype covers; `parsePage` also runs the schema collection, visible author and date markup, content analysis, link-section placement, contact links, hreflang, soft-404 markers and the optional page classifier, none of which are in either column. And a rule that needs the DOM forces the linkedom parse to run anyway, so the saving is zero for any page on which one of those 183 rules runs (most pages run many of them).

## Inventory: who reads the DOM

Counted over `packages/rules/src` (rule-definition files, tests excluded). A file counts as DOM-reading when it touches `ctx.parsed.document` or any `querySelector`/`parseHTML` call.

| | files |
|---|---:|
| rule-definition files | 336 |
| read the DOM directly | 183 (54%) |
| do not read the DOM | 153 (46%) |
| of those 153, read pre-extracted `ctx.parsed` fields (meta, links, images, headings, schemas) | 24 |
| of those 153, read only page, headers, site-level or collected data | 129 |

DOM-reading files by category: a11y 61, performance 23, content 19, images 12, security 10, schema 10, mobile 7, integrity 6, social 5, links 5, crawl 4, core 4, video 3, legal 3, ax 3, other 7.

What the 183 do with it (call sites across them): `getAttribute` 459 in 131 files, `querySelector(All)` 188 in 111 files, `textContent` 126 in 65 files, `children`/`childNodes`/sibling walks 74 in 19 files, `parentElement`/`parentNode` 42 in 16 files, `closest` 16 in 13 files, `getElementById` 17 in 17 files, `innerHTML`/`outerHTML` 10 in 6 files.

Only 24 rules read the pre-extracted fields, so even a perfect native extractor feeds under 8% of the rules. The migration cost is the 183.

## Feasibility: the extractors

Prototyped as handlers: meta (title, description, canonical, robots), Open Graph, Twitter, headings and H1 with text, links with text and `rel`, images outside `<noscript>` (a depth counter), JSON-LD types.

Not expressible, or only with a hand-built tree, and why:

| extractor | reason |
|---|---|
| link section and chrome flag (`extractors/link-section.ts`, `chrome.ts`) | needs each anchor's ancestor chain (landmarks, roles, classes, ids) and a sitewide-chrome test; the #3356 memoized ancestor walk has no streaming equivalent |
| `extractContent` | clones `<body>`, strips script and style, then counts words and hashes the text; needs the subtree as a unit |
| `extractVisibleMeta` (bylines, entry-meta `<time>`) | arbitrary CSS selectors with ancestor and sibling relations |
| `isHiddenFromMarkup`, `querySelectorAllOutsideNoscript` in general | ancestor state; the prototype gets away with one depth counter for `<noscript>` only |
| page classifier (Treetop) | reads the parsed document |
| soft-404 and error-shell markers | mixed: root attributes are easy, the text heuristics read the body |
| all 183 DOM-reading rules | arbitrary selectors, `closest`, parent and sibling walks |

Two lol-html behaviours the port would have to absorb:

1. **No entity decoding.** `getAttribute` and text chunks are raw: `&amp;` arrives as `&amp;`. The first parity run differed on exactly that (a meta description). The prototype decodes the five common entities; a port needs the full table.
2. **No tree builder.** lol-html tokenizes; it does not apply the HTML spec's implied end tags or misnesting recovery. On `<a href="/a">one<a href="/b">two</a>` linkedom (htmlparser2) yields two links `one` and `two`; the prototype yields `/b` with `two` and `/a` with `onetwo`. An unclosed `<h2>` followed by a `<p>` and an `<h3>` extracts the same texts but in a different order. Real pages are malformed often enough (the repo has fixtures and tests for nested anchors, oversized classes and deep nesting) that a second parser with different recovery would change audit results page by page.

## Serializable `ParsedPage`

The issue assumed the live `Document` is what blocks sending parsed pages to workers. In this tree it is already excluded from storage: `document` is "never stored" (`packages/parser/src/html.ts`), the crawl cache stores the extracted fields as JSON, and the audit engine detaches retained values from their page (`packages/audit-engine/src/detach.ts`). The extracted fields are already structured-cloneable; the cost of the structured clone above (about the same as the extraction itself) says moving them is cheap.

What is not serializable is the 183 DOM rules, which need a document in whichever worker runs them. So the #263 trade does not change: a worker either receives the HTML and re-parses (the net loss measured there), or receives extracted fields and can run only the roughly 150 rules that do not read the DOM, while the 183 still run where the DOM is. That split is possible today without a new parser, and is a scheduling question for #263, not a parser one. The crawl-to-audit double parse (#267) is a cache question (`ParsedPageCache`), likewise independent of the parser.

## Decision and what would change it

No-go on a native or serializable `ParsedPage` replacing linkedom:

- the best case is about 4x on a subset, a fraction of `parsePage`, with zero saving on any page where a DOM rule runs;
- 183 of 336 rule files would need a rewrite or a compatibility shim over a streaming parser;
- different recovery on malformed markup changes audit results.

Revisit if: a profile shows `parseHTML` itself (not the extractors or rules) dominating the cloud rules phase, in which case the cheaper lever is replacing linkedom's tree builder, not adding a second parser; or the rules phase is split into DOM and non-DOM halves for #263, where a native extractor could feed the non-DOM half.
