# 2026-10 Parse time on deeply nested pages

squirrelscan/repo#3356. `parsePage` was quadratic in nesting depth. Profiling each step on a 20,000-deep page showed the cost was not the HTML parse: the link extraction asked every anchor for its sitewide-chrome flag by walking its ancestors to the root, so one page of nested links walked the tree once per link. The crawler's own link extractor (`extractors/links.ts`) made the same walk twice per link, once for the chrome flag and once for the link's position (header, nav, content, ...).

Both walks are now memoized per document: each anchor walks up only until it meets an element an earlier anchor already answered for. Every anchor gets the answer it got before; a parity test compares both extractors with the single walks on 600 seeded random pages of landmarks, roles, classes and ids (`packages/parser/tests/parse-depth-3356.test.ts`).

## How

`bun benchmarks/harness/parse-depth.ts 1000 5000 20000`. Each page nests N levels of the container, with a link at each level. `parsePage` is the whole parse the crawler runs on every page; `extractLinks` is the crawler's link extractor on the parsed document. Minimum of 3 runs (1 run for the 20,000-level before numbers). The before numbers ran the `origin/main` versions of the three changed files in the same checkout, right after the after numbers.

Machine: Apple Silicon laptop (macOS, arm64), Bun 1.4.0, run at low priority (`nice 19`) under the shared heavy-command lock, at a load average around 12 from other work on the machine.

## Results

| page | nesting | `parsePage` before | after | `extractLinks` before | after |
|---|---:|---:|---:|---:|---:|
| `role="text"` spans | 1,000 | 72 ms | 10 ms | 165 ms | 1 ms |
| `role="text"` spans | 5,000 | 754 ms | 39 ms | 2,378 ms | 5 ms |
| `role="text"` spans | 20,000 | 12,491 ms | 250 ms | 64,404 ms | 44 ms |
| `aria-hidden` divs | 20,000 | 13,391 ms | 305 ms | 111,977 ms | 108 ms |
| blockquotes | 20,000 | 30,016 ms | 747 ms | 65,146 ms | 96 ms |
