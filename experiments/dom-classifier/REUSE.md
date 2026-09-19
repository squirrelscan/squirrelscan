# DOM classifier reuse research

Date: 2026-09-18

The strongest low-risk path is to reuse SquirrelScan's existing parsed DOM and
feature code, then train a small block-level multiclass model on top. The
existing code already parses each page once, preserves a live `linkedom` DOM,
walks text without cloning or mutating it, and exposes useful page/chrome
signals. A compact tabular classifier (logistic regression or a small boosted
tree model) over these features plus local DOM context is a better first model
than downloading a large HTML transformer. Add sequence smoothing only after a
held-out-domain baseline proves it is needed.

## Reusable code already in this worktree

All paths below are relative to the public worktree root.

| Location | Reusable API or behavior | How it helps the corpus/model |
| --- | --- | --- |
| `packages/parser/src/dom.ts` | Canonical `parseHTML` export and HTML attribute-case fix | Parse the source once through the same production path. Avoid a second parser whose paths/classes disagree with audit behavior. |
| `packages/parser/src/html.ts` | `parsePage`, shared extractor orchestration, one-document reuse | Provides the production `ParsedPage` and the exact DOM used by rules. The classifier can consume this while the DOM is resident. |
| `packages/parser/src/extractors/dom-text.ts` | `collectTextExcluding(root, isExcluded, separator, isBoundary)` and `tagExcluder` | Safe iterative text/block walking, with explicit boundaries and no deep clone. Use this for candidate text blocks and stable text features. |
| `packages/parser/src/extractors/content.ts` | `getCleanTextContent`, `extractContent`, `getMainContent` | Existing clean-text, word count, text/HTML ratio, hash, and main-content heuristic make useful weak signals and baselines. They are not role gold labels. |
| `packages/parser/src/extractors/chrome.ts` | `isInSiteChrome(element)` | Exact semantic ancestor test for `nav`, `header`, `footer`, and `aside`; useful as a high-precision hint. Its own comment says it intentionally misses div-soup chrome. |
| `packages/parser/src/page-type.ts` | `PageType` and `detectPageType(url, schemas)` | Page-level schema/URL hints (`article`, `product`, `category`, etc.) can be context features. They do not label individual blocks. |
| `packages/audit-engine/src/page-features.ts` | `extractPageFeatures(page, parsed)` | Bounded page feature shape already includes `wordCount`, `pageType`, `schemaTypes`, canonical/indexability and template fingerprint. Reuse the same context fields rather than inventing a parallel store. |
| `packages/utils/src/dom.ts` | `getAttrCI`, `hasAttrCI`, attribute scanning helpers | Correctly handles authored `class`/ARIA/data attribute case variants when extracting features. |
| `packages/utils/src/html-text.ts` | `stripHtmlForText` | Linear, non-DOM text fallback for damaged/oversized inputs; useful for diagnostics, not a replacement for DOM block labels. |

The public package is MIT licensed (`packages/parser/package.json` and the
worktree `LICENSE`), and `linkedom` is already a pinned parser dependency. Do
not copy the private root, crawls, environment files, or raw campaign data into
the corpus experiment.

There is also a precedent in the MIT-licensed langmanus project
(`src/crawler/readability_extractor.py`): it calls
`readabilipy.simple_json_from_html_string(html, use_readability=True)` and keeps
the returned `title`/`content`. That project is MIT, but this code is an
article extractor, not a role classifier; use it only as an optional teacher or
comparison oracle, not as labels for all blocks.

The bounded search of Pagecog, PagecogOld, ML, AI, and Webtrees found no second
role-classification pipeline. Pagecog's relevant code is site content/layout
UI; PagecogOld is WordPress theme/template material; and the only directly
useful AI result was the LangManus Readability wrapper above. Do not turn those
templates or UI components into corpus labels.

## What the upstream projects actually provide

* [Web2Text](https://github.com/dalab/web2text) is MIT. Its Scala extractor
  converts HTML into a CDOM, emits leaf text blocks plus unary/pairwise DOM
  features (tag, ancestors, duplicate counts, block breaks, tree distance),
  and its HMM/CNN labels are binary boilerplate versus main content. It is a
  useful feature design reference and an independent binary baseline. Its
  documented setup requires Scala/SBT, Python, TensorFlow 1.15 and old
  checkpoints, so port the feature ideas rather than making it a runtime
  dependency or fetching its data/checkpoints.
* [BoilerNet](https://github.com/mrjleo/boilernet) is MIT. It represents a page
  as ordered text blocks with words and ancestral HTML tags and predicts the
  binary content/boilerplate sequence. The repository requires an old
  TensorFlow 2.1 stack and external CleanEval/GoogleTrends data. This is a
  relevant sequence-model reference, but its output cannot distinguish a
  footer from a consent banner, card, form, or aside.
* [Mozilla Readability](https://github.com/mozilla/readability) is Apache-2.0.
  `new Readability(document).parse()` returns one article-like result
  (`title`, cleaned `content`, `textContent`, byline, excerpt, metadata), and
  `isProbablyReaderable` is a useful gate. It mutates the DOM unless given a
  clone. It is article extraction, not per-node role supervision, and its
  `article` result must not be treated as a complete page taxonomy.
* [Trafilatura](https://github.com/adbar/trafilatura) is Apache-2.0 from v1.8.0
  onward (older versions were GPLv3+). `extract`, `bare_extraction`, and
  `extract_with_metadata` use a rule-based cascade with readability/jusText
  fallbacks and return text/metadata or structured document output. It accepts
  LXML trees, not `linkedom`, and does not emit the requested role labels. It
  is a good external quality oracle only if the Python boundary is worth the
  cost; pin an Apache release if used.
* [jusText](https://github.com/miso-belica/justext) is BSD-2-Clause. Its API
  returns paragraphs with `is_boilerplate`, based on sentence length, link
  density and stopwords. This is a lightweight binary paragraph oracle and is
  useful for recall/precision checks, but it has no `site_header`, `card`,
  `form`, `consent_banner`, or other role classes.
* [MarkupLM in Transformers](https://huggingface.co/docs/transformers/model_doc/markuplm)
  is Apache-2.0 code; Microsoft publishes `microsoft/markuplm-base` (about
  280 MB in the model card). Its processor extracts nodes and XPaths and can
  accept custom `node_labels` for token-classification fine-tuning. The
  pretrained examples target WebSRC question answering and SWDE information
  extraction, not DOM chrome roles. The base encoder has 12 layers/768 hidden
  units and is not a small ready-to-run role classifier. Treat it as an
  optional teacher/embedding experiment after the compact baseline, not the
  first local dependency.

BoilerNet and Web2Text both support the useful intuition that DOM order and
ancestor context matter. Neither supplies a compatible supervised taxonomy.
No maintained checkpoint was found that is already trained for this project's
ten labels.

## Recommended architecture

1. Build candidate blocks from text-bearing leaf-ish elements while retaining
   DOM order, stable path, parent/ancestor tags, sibling index/count, text and
   link counts, class/id/ARIA tokens, semantic tags, repeated-template counts,
   and the page features above. Keep candidate boundaries deterministic and
   serializable.
2. Persist Luna's output as `source=luna`, `gold=false`, with confidence and
   prompt/version metadata. Treat semantic tags, Readability/Trafilatura/
   jusText outputs, and existing SquirrelScan heuristics as weak hints only.
3. Train a small ten-way classifier over blocks (`site_header`, `footer`,
   `navigation`, `main_content`, `article_header`, `card`, `aside`, `form`,
   `consent_banner`, plus `unknown` as the abstention class). A linear model or
   small gradient-boosted model is cheap, explainable, and can be exported
   without a 280 MB transformer. Add a short-order transition model only if
   block adjacency improves held-out-domain metrics.
4. Split by registrable domain and template fingerprint, never random blocks
   from the same page. Report macro-F1, per-role precision/recall, unknown
   coverage, and domain/template held-out results. Keep a dual-human subset for
   calibration; Luna agreement is not human agreement.

## Explicit non-reuse boundaries

`getMainContent`, Readability, Trafilatura, jusText, Web2Text and BoilerNet
answer “which text is article/main content?” or “which paragraph is
boilerplate?”. They cannot be relabeled as reliable multi-class role gold:
`main_content` is not equivalent to “not footer”, and an extractor may drop
cards, forms, consent overlays, sidebars, article headers, or navigation rather
than identify them. `detectPageType` is page-level, and `isInSiteChrome` is a
strict semantic hint. Only the annotation protocol below can establish the
project's role labels.

## Sources checked

* SquirrelScan public parser and feature files listed above; public worktree
  `LICENSE` and package manifests.
* Web2Text README/API and MIT license; BoilerNet README/API and MIT license.
* Mozilla Readability API and Apache-2.0 license; Trafilatura usage/API and
  Apache-2.0 licensing note; jusText README/API and BSD-2-Clause license.
* Transformers MarkupLM documentation, Microsoft model card and Apache-2.0
  source header.
