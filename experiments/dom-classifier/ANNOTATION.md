# DOM role annotation guide

This guide defines the corpus labels for extracted DOM regions. It is deliberately
separate from article extraction: a page can contain valid `main_content`,
`card`, `form`, and `aside` blocks at the same time.

## Unit of annotation

Annotate whole candidate regions in document order. A candidate is an extracted
page part, such as a header, navigation area, article, card/list container,
form, aside, or semantic ARIA region. The v2 annotation unit is not presented
as a general inventory of every paragraph, link, heading, list item, or other
smallest text unit. Do not ask annotators to split a supplied region at a
nested DOM boundary. If a region combines roles, choose the dominant role and
record `mixed` in the note; boundary quality is reviewed separately.

Each record retains, where available: page/site IDs, template-family proxy,
structural locator, candidate text, document order, parent/ancestor tags,
sibling position/count, class/id/ARIA tokens, link/text counts, weak-hint
sources, annotator, label, confidence, and notes. Store text snippets only as
needed for the experiment and keep source provenance; never copy secrets or
private environment data.

## Labels

Use exactly one primary label per candidate. `unknown` is a valid abstention,
not a failure.

| Label | Use for | Do not use for |
| --- | --- | --- |
| `site_header` | Site-wide masthead, logo/brand, utility bar, account/language controls, or a global header repeated across pages | A post's title/byline region; a local section heading |
| `footer` | Site-wide footer, legal/copyright/contact links, footer navigation and repeated closing boilerplate | An article's final paragraph or a local card footer |
| `navigation` | Menus, breadcrumbs, pagination, table of contents, tab bars, or other controls whose main purpose is moving between content | A card merely containing a link; prose with incidental links |
| `main_content` | The substantive page body: article prose, product details, explanatory sections, tables, code, or primary media captions | Title/byline metadata, related-content cards, global chrome |
| `article_header` | Article/product title, dek, byline, publication date, category/tag line, share metadata, and the primary lead/header region | Body paragraphs after the header; a global site header |
| `card` | Repeated teaser/product/result/recommendation units with their own link/title/summary, including grid/list items | A one-off article body section or a whole navigation bar |
| `aside` | Sidebars, related/promoted content rails, ads, callouts, and secondary content outside the primary flow | A card that is itself the repeated unit; a consent overlay |
| `form` | Search, login, checkout, signup/newsletter, contact, filter, or other input/submit controls and their labels/help text | A consent banner whose primary purpose is privacy choice |
| `consent_banner` | Cookie/privacy/consent overlays, preference dialogs, and their accept/reject/settings controls | Ordinary signup forms or a generic modal without consent semantics |
| `unknown` | Empty/decorative wrappers, scripts/media with no role evidence, ambiguous or mixed blocks, and pages/components outside the taxonomy | A forced guess based only on a class name or tag |

When a block is both semantically a `card` and inside an `aside`, prefer
`card` for the repeated unit and reserve `aside` for the surrounding secondary
region. When an article lead image or metadata is clearly part of the title
region, use `article_header`; when it carries the page's substantive
information, use `main_content`.

## Annotation procedure

1. Read enough surrounding blocks and, when available, inspect another page
   using the same template. Determine whether the candidate is site-wide,
   repeated, primary-flow, or secondary.
2. Check the rendered context if available, but do not infer a role from visual
   position alone. Use semantics, text purpose, neighboring blocks, repetition,
   and DOM ancestry together.
3. Assign one label and a confidence (`high`, `medium`, or `low`). Use
   `unknown` when evidence is genuinely ambiguous or the block is outside the
   taxonomy. Never force a role to improve class balance.
4. Record weak evidence separately: semantic tag, ARIA role, class/id token,
   link density, repeated-template signal, URL/schema/page-type hint, or an
   extractor output. These are features or review aids, not gold labels.
5. Mark Luna-generated records as `source=luna`, `gold=false`, with model,
   prompt/schema version, and confidence. A Luna label remains provisional until
   reviewed; agreement among Luna runs is not human gold. An independently
   model-reviewed record must still retain `gold=false` and identify the
   reviewing model/prompt. The current corpus has no human-reviewed gold yet.

## Quality and splits

When human review is available, create a dual-human subset spanning every role,
page type, language mix, and template family. Have the annotators label
independently, adjudicate disagreements, and report per-label
agreement/confusion rather than only an overall score. Until then, use an
independently model-reviewed subset only for QA and calibration, never as human
gold. Include hard cases: div-soup headers/footers, nested cards, article
TOCs, cookie dialogs, forms inside cards, and pages with no obvious main
content.

Split train/dev/test by registrable domain and the available template-family
proxy. Domain isolation is real: the selection and split groups keep a
registrable domain together. The current quantized tag/context template proxy is
weak (the v2 corpus has 49 contributing sites and 48 template families), so it
does not establish a robust cross-domain template holdout. Report macro-F1,
per-label precision/recall, confusion matrix, unknown abstention coverage, and
performance separately on held-out domains; describe any template result as
exploratory.

Candidate boundary errors should be tracked separately from label errors. A
model that predicts the right label for a badly merged block is not equivalent
to a model that identifies the right block boundary.
