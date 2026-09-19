# Error analysis: 75-page test split, September 19, 2026

Follow-up to [RESULTS-2026-09-19.md](RESULTS-2026-09-19.md), on the component
axis first. The short version: the component label is mostly decided by the HTML
tag, the learned models do not beat a tag rule, and the largest single error
class is not a model error at all. It is two annotators applying opposite
conventions to `<footer>` and `<main>`.

## What these numbers are, and are not

- Every score is **agreement with independent Luna synthetic labels, not
  measured human accuracy**. Jev and Luna are both models. Their agreement rate
  is a synthetic-label-noise ceiling, not a human one.
- **The test split was already inspected** when the sparse and frozen-encoder
  results were read. Everything below is exploratory, not a clean confirmatory
  test. The hybrid rule in particular was chosen after reading these same
  labels; it is a hypothesis to re-test on a fresh split.
- Two record sets are reported. `test224` is all 224 complete component records
  on the 75 test pages. `fair212` drops the 4 pages present in the previous
  model's training data, and is the set the published headline table used.
- **`class` and `id` tokens are not preserved in the frozen capture schema**, so
  no class-token feature could be measured. Child counts are counts of captured
  child nodes, not of every DOM child.

Aggregates: `terra-analysis/error-analysis.json` in the private data root.

## Jev versus Luna: the label-noise ceiling

Exact-set agreement between the two independent synthetic annotators, on the
records where both marked the axis complete.

| Axis | Agreement | Complete records |
|---|---:|---:|
| componentType | 57.6% | 224 |
| regions | 64.2% | 162 |
| purposes | 12.1% | 149 |
| pageTypes | 1.3% | 75 |
| contentKinds | 4.1% | 73 |

No model can be scored above these ceilings against these labels. The
purposes, page-type and content-kind axes are not measuring model quality yet:
at 1.3% agreement on page type, the two annotators are answering different
questions, and the published page-type F1 numbers cannot distinguish a good
model from a bad one.

## Component accuracy, and the segment that explains it

| Model | test224 | fair212 |
|---|---:|---:|
| Jev teacher | 57.6% | 57.6% |
| **HTML-tag baseline** | **56.3%** | **56.1%** |
| New sparse model | 51.8% | 51.9% |
| Frozen RoBERTa + heads | 46.9% | 45.8% |
| Previous sparse model | 45.5% | 45.3% |

Splitting by whether the node's tag is semantic (the tags the baseline maps:
`nav`, `button`, `a`, `img`, `form`, `table`, `main`, `header`, `footer`,
`article`, `aside`, `section`, `h1`-`h6`, `ul`, `ol`, `p`, `span`, `li`,
`input`, `select`, `textarea`, `picture`, `video`, `label`) changes the reading
completely (fair212):

| Model | Semantic tags (n=174) | Non-semantic tags (n=38) |
|---|---:|---:|
| HTML-tag baseline | **64.4%** | 18.4% |
| Jev teacher | 62.1% | **36.8%** |
| New sparse model | 58.1% | 23.7% |
| Frozen RoBERTa + heads | 47.7% | 36.8% |
| Previous sparse model | 51.7% | 15.8% |

Two things follow. Where the tag already answers, **the fixed tag rule beats
every learned model, including the teacher that supervised them**. Where it does
not (`div` 24, `figure` 7, `iframe` 7), nothing works: the best result is 36.8%,
and the sparse model reaches 23.7%. The models are not adding component
knowledge on top of the tag; they are approximating the tag and losing accuracy
doing it.

## The hybrid: tag rule when the tag is semantic, model otherwise

| Combination | test224 | fair212 |
|---|---:|---:|
| tag rule + Jev teacher | 59.4% | 59.4% |
| tag rule + frozen RoBERTa | 59.4% | 59.4% |
| **tag rule + new sparse** | **57.1%** | **57.1%** |
| tag rule + previous sparse | 55.8% | 55.7% |
| *(plain tag rule, for reference)* | *56.3%* | *56.1%* |
| *(oracle: perfect per-node router)* | *75.9%* | *75.0%* |

**The hybrid's margin over the plain tag rule is not a detectable difference.**
The two are identical on semantic tags by construction, so the entire margin is
the 38 non-semantic records: 16 discordant pairs, 9 won by routing to the sparse
model and 7 lost, a net of **+2 records out of 212**. Reporting that as "the
hybrid reaches 57.1%" would overstate a two-record swing.

The oracle row is the ceiling if a perfect router chose between the tag rule and
the sparse model per node. It is not achievable and is listed only to bound how
much a router could ever be worth.

### A cheaper win than a model: fix the tag mapping

An oracle tag rule, whose label per tag is fitted on these same test rows,
reaches **71.7%** (fair212). That is the ceiling for *any* predictor that sees
only the tag, and it is far above every learned model. The current mapping
leaves most of it on the table because several entries point at the wrong label:

| Tag | Records | Baseline maps to | Baseline correct | Luna's modal label | Modal share |
|---|---:|---|---:|---|---:|
| `header` | 37 | `banner` | **0%** | `navigation_menu` | 73% |
| `div` | 24 | `unknown` | 0% | `navigation_menu` | 17% |
| `main` | 29 | `layout_container` | 38% | `layout_container` | 38% |
| `figure` | 7 | `unknown` | 14% | `card` | 43% |
| `aside` | 3 | `content_section` | 0% | `navigation_menu` | 67% |
| `footer` | 33 | `layout_container` | 85% | `layout_container` | 85% |
| `nav` | 21 | `navigation_menu` | 100% | `navigation_menu` | 100% |
| `img` | 21 | `image` | 100% | `image` | 100% |
| `article` | 16 | `article` | 88% | `article` | 88% |
| `a` / `form` / `p` | 9 / 4 / 3 | `link` / `form` / `text` | 100% | same | 100% |

`header` alone is 37 records scored at zero. Whether the right answer is
`navigation_menu` is a definition question, not a measurement one, which is the
point of [LABEL-DEFINITIONS.md](../LABEL-DEFINITIONS.md). But no model iteration
is worth running while a single mapping entry is costing more than every
modelling difference in the results table combined.

`div` is the honest counter-example: its modal label wins only 17% of the time,
so the tag genuinely does not determine it. That is where a model has something
to contribute, and it is exactly where every model scores worst.

## layout_container versus content_section

The published note says forty test component disagreements are this pair. The
count depends on which predictor and record set is meant; all readings are in
the JSON. Against Luna, both sides of the pair: Jev 34, new sparse 41, frozen
RoBERTa 41, previous sparse 39, tag baseline 9 (`test224`).

Counting the two annotators against each other:

| | Luna |
|---|---:|
| Luna says `layout_container` | 46 |
| Luna says `content_section` | 14 |
| Jev says `layout_container` | 17 |
| Jev says `content_section` | 58 |
| Both agree `layout_container` | 4 |
| Both agree `content_section` | 11 |
| Disagree within the pair | 34 |

**Agreement inside the pair is 30.6%, and 33 of the 34 disagreements run one
way: Jev `content_section`, Luna `layout_container`.** The two annotators have
close to inverted priors on this boundary.

### It is two tags, not a missing feature

Every row where either annotator used one of the pair, by tag:

| Tag | Rows | Within-pair disagreements | Jev's view | Luna's view |
|---|---:|---:|---|---|
| `footer` | 33 | **24** | `content_section` 29 | `layout_container` 28 |
| `main` | 29 | **9** | `content_section` 26 | `layout_container` 11, `content_section` 9 |
| `div` | 13 | 1 | `layout_container` 10 | scattered across 7 labels |
| `header` | 10 | 0 | `navigation_menu` 6 | `layout_container` 5 |
| `aside` | 1 | 0 | `layout_container` 1 | `list` 1 |

**33 of the 34 disagreements are on `<footer>` and `<main>` alone.** Jev calls a
`<footer>` a content section 29 times out of 33; Luna calls it a layout
container 28 times out of 33. This is a flat convention clash, not a hard case.

The requested feature separation cannot be computed usefully: the agreed
subsets are n=4 (`layout_container`) and n=11 (`content_section`). For
completeness, the best single-feature threshold fitted on those 15 rows is word
count (86.7% versus a 73.3% majority-class baseline, +13.3 points), then text
length, DOM depth, captured child count and rect area at zero or negative lift.
At n=15, with the threshold chosen on the same rows it is scored on, none of
that is distinguishable from noise.

The one-sided profiles show why no feature would help anyway. Comparing Luna's
`layout_container` (n=46) with Luna's `content_section` (n=14): median word
count 36 versus 38, median captured child count 2.0 versus 2.5, median DOM depth
2.5 versus 3.5, heading-child share 0% versus 21%. The distributions overlap
almost entirely. **A definition will fix this; a richer feature vector will
not.**

## Input quality

### Contamination by stylesheet, structured-data and script text

| Input kind | Any | CSS | JSON | Script |
|---|---:|---:|---:|---:|
| Node inputs (n=225) | 6.2% | 3.6% | 2.2% | 0.4% |
| Page inputs (n=75) | 9.3% | 8.0% | 1.3% | 0% |
| All (n=300) | 7.0% | 4.7% | 2.0% | 0.3% |

This is consistent with the parent's blind sanity check, which found two
contaminated inputs in twenty. The page-level inputs are the worse of the two:
a page serialization spans the whole document, so it picks up whatever a CMS or
consent vendor wrote near the top of it.

**Node text is capped at 280 characters** (250 of the 600 node records across
all splits sit exactly at the cap), so residue near the cut often arrives with
its closing brace removed. That is why a naive "drop balanced `{...}` blocks"
scrubber leaves a third of it behind. The cleaner added to `extract-dom.ts`
handles the unterminated tail explicitly: on these same inputs it clears 14 of
14 contaminated rows and changes 0 of 286 clean rows. It also distinguishes CSS
from JSON, because quoted-key objects appear as legitimate visible content on
documentation pages and must not be stripped.

### Empty elements

**38 of 225 node inputs (16.9%) reach the model as the literal token
`[empty]`**: tag and ancestor chain, and nothing else.

| Tag | Empty records |
|---|---:|
| `img` | 21 |
| `iframe` | 7 |
| `button` | 6 |
| `figure` | 3 |
| `video` | 1 |

Every one of the 29 records whose tag legitimately carries no text (`img`,
`iframe`, `video`) is empty. No `alt`, `title`, `aria-label`, `role`, `src`
or child structure survives serialization, so a product photo, a logo, a video
embed and a tracking pixel are all the same input. Luna still assigned labels to
these (`image` 23, `unknown` 7, `button` 6, `media` 1, `video_player` 1), which
means 7 of 38 were explicit abstentions and the rest were decided on the tag
alone. `extract-dom.ts` now emits those attributes, a compact child-tag summary,
and a non-identifying category for `src` (`same-site`, a known embed provider
such as `youtube`, or `other-third-party`) so a video embed and a first-party
photo stop looking identical without any hostname leaving the extractor.

## Per-class support

Only **21 of 43 component labels appear at all** in the 224 test records. 22
have zero support and 16 more have fewer than ten examples:

| Support | Labels |
|---|---|
| 0 | `ad_unit`, `audio_player`, `author_card`, `checkbox`, `comment_thread`, `dialog`, `drawer`, `heading`, `icon`, `input`, `media_gallery`, `pagination`, `popover`, `purchase_panel`, `radio`, `rating_summary`, `select`, `specification_list`, `table`, `tabs`, `toggle`, `tooltip` |
| 1 | `dropdown`, `media`, `hero`, `notification`, `review_list`, `video_player` |
| 2-3 | `search`, `banner`, `accordion` |
| 5-9 | `list`, `text`, `form`, `button`, `card`, `unknown`, `link` |

The other axes are no better. Regions: 13 of 19 labels have support; 6 are zero
(`advertisement`, `author_bio`, `comments`, `product_reviews`, `top_banner`,
`unknown`) and 9 have fewer than ten. Purposes: 20 of 27 have support, 7 zero,
16 under ten.

The taxonomy additions that motivated the diverse corpus, the commerce,
review and media component types, have **no test support at all**. The reported
macro F1 is dominated by labels with one or two examples, and a per-label F1
computed on a single example carries no information. Rare-class claims need
deliberate sampling for those classes, not a larger random crawl.

## What this implies for the next iteration

1. **Settle the definitions before training anything.** The single largest error
   class is a convention clash on two tags. See
   [LABEL-DEFINITIONS.md](../LABEL-DEFINITIONS.md).
2. **Fix the tag mapping, then re-measure.** `header` is 37 records at zero
   accuracy. A corrected tag rule has a 71.7% ceiling on this split, above
   everything measured.
3. **Do not report the hybrid as an improvement.** It is +2 records out of 212.
4. **Treat purposes, page type and content kind as unmeasured.** At 1.3% to
   12.1% annotator agreement, those columns cannot rank models.
5. **Sample rare classes deliberately.** 22 of 43 component labels have zero
   test support, including every commerce and review type the v2 taxonomy added.
6. **Re-run this analysis on a fresh split.** The hybrid, the thresholds and the
   corrected mapping were all chosen after reading this test set.
