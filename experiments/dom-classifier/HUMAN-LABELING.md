# Human labeling and targeted fresh crawl

Status: bounded implementation proposal  
Proposal date: 2026-09-18  
Owner: DOM-classifier experiment

This plan adds a small human-reviewed slice to the existing offline DOM-region
experiment. It is deliberately a labeling and capture design, not a production
UI, crawler, or model-training change. The first implementation should use the
open-source Community Edition of [Label Studio](https://labelstud.io/) and a
private task export. Do not build a bespoke annotator or start a crawl as part
of this proposal.

## Decision

Use Label Studio for two separate task types, with the WebSeg-Curator picker
available as the browser-side geometry adapter:

1. **Region role review:** a full-page screenshot with one or more candidate
   rectangles, each tied to an immutable `candidateId`, plus per-region choices
   for role, context, and boundary quality.
2. **Component-family pair review:** two candidate regions from different routes,
   shown with their page context, with one choice: `same_variant`,
   `same_family_different_variant`, `different_family`, or `uncertain`.

The first 200 regions are a blind, human-reviewed holdout. They come from a
frozen set of whole registrable domains that are unseen by the training pool.
Model suggestions are hidden for this pass. The holdout is never used for
training, active-learning selection, threshold tuning, prompt tuning, or
adjudication guidance. After the holdout is frozen, the training pool may use
active-learning disagreements and low-confidence examples, with predictions
shown only in a later review pass.

This choice preserves the existing [annotation contract](./ANNOTATION.md):
whole candidate regions, one role label, explicit `unknown`, domain/template
grouped splits, and separate boundary-error accounting. It also tests the
actual rendered geometry while retaining the DOM identity needed to join a
human decision back to the private candidate packet.

## Why Label Studio plus a screenshot bridge

Label Studio's official HTML Classification template renders a whole HTML value
through `HyperText` and applies task-level `Choices`; it does not provide a
clickable DOM-element picker or stable DOM-node identity. It is useful as a
context reference, but it is not sufficient for this task ([HTML Classification
template](https://labelstud.io/templates/html_classification)). The official
Image Classification template provides image plus checkbox choices, and the
object-detection template provides image rectangles and rectangle labels
([Image Classification](https://labelstud.io/templates/image_classification),
[Image bounding boxes](https://labelstud.io/templates/image_bbox)).

The implementation should therefore use an `Image` of the full-page screenshot,
candidate rectangles, and per-region `Choices`. Label Studio documents
`perRegion="true"` for applying choices to a selected image region and preserves
the result ID when a region is carried from a prediction into an annotation
([Choices](https://labelstud.io/tags/choices),
[task format](https://labelstud.io/guide/task_format)). For the blind holdout,
do not load model predictions. Instead, create each task with a neutral
candidate outline baked into a display copy of the screenshot, or use a
candidate-specific task with the outline as a non-labeling display layer. Keep
the original screenshot unchanged in the capture store. This shows the annotator
what to classify without exposing a predicted role.

The [Webis-WebSeg-20 repository](https://github.com/webis-de/cikm20-web-page-segmentation-revisited-evaluation-framework-and-dataset)
is a useful interaction and geometry reference: its README points to the local
annotation template at `src/main/html/hit-template-local.html`, describes drawing
rectangles on screenshots, and provides a later fit-to-DOM-node step. Its
template records rectangle frames and final rectangles, but it is designed for
untyped page segmentation. Reuse its interaction ideas or fitting code only
behind an adapter; do not use Webis segmentations as SquirrelScan role labels or
as automatic gold. No Webis dataset or archive is downloaded by this plan.

The closer browser-picker reuse candidate is
[WebSeg-Curator](https://github.com/JasminSaxer/WebSeg-Curator) (MIT). Its
curation extension already supports selecting a DOM node in the rendered page,
functional classes, overlays with deletion, and bounding-box export. Adapt only
the picker/export boundary: emit SquirrelScan `candidateId`, XPath/structural
locator, rectangle, screenshot ID, and content hash into the private task
manifest, then send the choices and review state through Label Studio. This is
preferable to writing a DOM picker from scratch when a live-browser review is
needed. Do not copy its legacy Mongo/institutional backend, disabled-web-security
startup, automatic header/footer propagation, or prior-label display into this
workflow. Use a normal browser security profile, no pre-existing labels in the
blind pass, and a private frozen MHTML/screenshot or capture manifest as the
source page.

## Existing material to reuse

The new tasks should be built from the existing private v2 packet and capture
manifests, not from a second candidate extractor.

- Reuse the production `linkedom` parsing and feature paths listed in
  [`REUSE.md`](./REUSE.md): `packages/parser/src/dom.ts`, the shared HTML
  parser, `collectTextExcluding`, `getCleanTextContent`, `getMainContent`,
  `isInSiteChrome`, case-insensitive DOM attributes, and page features. These
  are feature and context sources, never human labels.
- Reuse v2 candidate IDs, structural locators, text-safe context, ancestor
  chains, and split groups from [`README.md`](./README.md) and
  [`schema.json`](./schema.json). A capture re-extraction must produce the same
  `candidateId` for the same page content, or be recorded as a new candidate
  version rather than silently overwriting it.
- Reuse the existing Luna/model outputs only as provisional weak hints. Keep
  `source`, model/version, prompt/schema version, and `gold: false`; hide them
  during the blind holdout. Existing training and evaluation rules remain those
  in [`TRAINING.md`](./TRAINING.md).
- Use Web2Text, BoilerNet, Readability, Trafilatura, and jusText only as
  optional weak evidence or comparison oracles, as described in [`REUSE.md`](./REUSE.md).
  Their binary boilerplate/article outputs cannot be relabeled into the ten
  SquirrelScan roles. MarkupLM is a later teacher/embedding experiment, not a
  first-phase dependency.
- If a Webis page or another open dataset is imported later, retain its source,
  license, page ID, and annotation provenance. Use it for screenshot-boundary
  calibration or a supplemental pretraining experiment, never to silently
  expand the role gold set.
- [WebClasSeg-25](https://doi.org/10.5281/zenodo.14881792) is a potentially
  useful supplemental visual/DOM segmentation source. Its dataset record is
  CC BY 4.0; preserve attribution and the exact version if it is used. Its
  segmentation classes still do not map to the ten SquirrelScan role labels,
  so use it for boundary/geometry pretraining or calibration only, never as
  untouched role gold.

For the first model comparison, combine the reviewed SquirrelScan labels with
permitted supplemental geometry/data and fit the existing compact linear or
small-tree baseline. Do not make a roughly 499 MB RoBERTa/MarkupLM teacher a
phase-one dependency. A larger teacher is justified only after the compact
model's domain-held-out errors show that DOM features plus screenshot geometry
are insufficient.

The capture and labeling process runs in a dedicated private output directory
and has no dependency on active OpenCode processes, task IDs, task archives,
working-tree state, or live crawler queues. Existing pages may be read through
their retained private manifests; no archive is modified.

## Task data and persistent identity

One Label Studio task represents one page and contains a bounded candidate list.
For each task, keep the following private fields in `data`:

```json
{
  "taskVersion": "dom-role-human-v1",
  "pageId": "page_<hash>",
  "siteId": "site_<hash>",
  "registrableDomainGroup": "group_<hash>",
  "screenshot": "private://captures/<captureId>/page.png",
  "displayScreenshot": "private://captures/<captureId>/page-outline.png",
  "viewport": {"width": 1440, "height": 900, "deviceScaleFactor": 1},
  "candidates": [
    {
      "candidateId": "dom_<hash>",
      "rect": {"x": 112, "y": 420, "width": 812, "height": 260},
      "xpath": "/html/body/main/section[2]",
      "rectCoordinateSpace": "screenshot-css-px",
      "contextText": "bounded safe context only"
    }
  ],
  "interactionState": {
    "consent": "visible|accepted|settings-open|absent|unknown",
    "form": "untouched|validation-error|success|not-present|unknown"
  },
  "captureId": "capture_<hash>",
  "capturedAt": "2026-09-18T00:00:00Z",
  "contentHash": "sha256:<hex>"
}
```

The exported annotation is joined to the candidate by `taskId + pageId +
candidateId`, never by screenshot coordinates alone. Keep the capture's DOM
snapshot, XPath, candidate rectangle, viewport, content hash, and timestamp in
the private capture manifest. A changed rectangle or XPath is a capture/version
change and must not mutate an earlier annotation. Sanitization follows the
existing packet rules: no secrets, form values, arbitrary scripts/styles, or
unbounded source HTML in Label Studio task data.

The neutral outline is for orientation only. It has no predicted class color,
confidence, or model name. When a task contains several candidate rectangles,
the annotator labels each one independently; no label is inferred from the
neighboring candidates.

## Minimal Label Studio configurations

The exact XML can be created when the private project is provisioned. The
following is the minimum shape, using documented Label Studio tags:

```xml
<View>
  <Image name="page" value="$displayScreenshot" zoom="true"/>
  <Rectangle name="region" toName="page" canRotate="false"/>
  <Choices name="role" toName="page" perRegion="true" required="true">
    <Choice value="site_header"/>
    <Choice value="footer"/>
    <Choice value="navigation"/>
    <Choice value="main_content"/>
    <Choice value="article_header"/>
    <Choice value="card"/>
    <Choice value="aside"/>
    <Choice value="form"/>
    <Choice value="consent_banner"/>
    <Choice value="unknown"/>
  </Choices>
  <Choices name="context" toName="page" perRegion="true" required="true">
    <Choice value="site"/>
    <Choice value="article"/>
    <Choice value="main"/>
    <Choice value="header"/>
    <Choice value="footer"/>
    <Choice value="unknown"/>
  </Choices>
  <Choices name="boundary" toName="page" perRegion="true" required="true">
    <Choice value="correct"/>
    <Choice value="needs_change"/>
    <Choice value="unknown"/>
  </Choices>
  <TextArea name="boundary_note" toName="page" perRegion="true"
            displayMode="region-list"/>
</View>
```

The importer must seed each neutral rectangle with the stable candidate ID and
the known geometry. If the installed Label Studio version cannot display
non-prediction rectangles with preserved IDs, use one task per candidate and a
neutral outlined display screenshot, then write the candidate ID into the
private task metadata. Do not make annotators redraw boxes in the blind pass:
redrawing would mix boundary discovery into role measurement. A later boundary
review can enable editable rectangles.

The context choices are intentionally separate from role. `context` records
where the candidate sits in the page (`site`, `article`, `main`, `header`, or
`footer`), while `role` records what it does. `unknown` is a permitted answer
for both. `boundary=needs_change` must include one note selected from or written
as `too_broad`, `too_narrow`, `should_split`, `should_merge`, or `missing`, plus
an optional short explanation. Boundary quality is scored separately from role
accuracy.

## Pair task: component family versus variant

Create a separate project and task schema for pairs. Do not add pair choices to
the role task. Each task shows two candidate region crops (or two full-page
screenshots with the target rectangle outlined), their route/page context, and
the same safe structural summary. The required decision is one of:

- `same_variant`: same component family and the same meaningful variant across
  routes;
- `same_family_different_variant`: same reusable component family but a
  meaningful presentation/content variant;
- `different_family`: unrelated component families;
- `uncertain`: insufficient evidence.

Pairs are sampled from different routes and, where possible, the same site or
template family. The task must not show or ask about link destinations,
navigation-graph composition, route reachability, or whether two links form a
menu. A `navigation` role decision remains a role-task label; it is never a
component-family pair answer. This separation prevents component similarity
from becoming an accidental navigation-graph annotation.

## Sampling and review order

### 1. Freeze the blind holdout first

Before any model-assisted review or active-learning query:

1. Freeze a manifest of 200 candidate regions from whole registrable domains
   that are not present in the training pool. Keep every selected domain's
   selected pages together in the holdout. Use a deterministic seed and record
   the seed, domain groups, page IDs, candidate IDs, and selection strata.
   The existing v2 domains are already eligible training material once used by
   the experiment; they cannot also be claimed as an untouched holdout. Screen
   every fresh holdout site against the v2 registrable-domain groups before
   freezing the manifest.
2. Stratify for page type, language/script mix, template-family proxy, visual
   density, and hard cases named in [`ANNOTATION.md`](./ANNOTATION.md):
   div-soup chrome, nested cards, article TOCs, consent dialogs, forms inside
   cards, and pages without obvious main content. Do not manufacture class
   balance by forcing a role that the page does not contain.
3. Assign two independent human annotations to all 200 regions. Hide every
   model, Luna, weak-oracle, confidence, and active-learning score. Keep the
   annotator order and task assignment independent.
4. A reviewer checks disagreements and boundary notes. Preserve both raw
   annotations, the review decision, and the reason. A region becomes eligible
   for the holdout's reviewed reference set only after independent labels and
   review; it never enters a training manifest.

The holdout is the first human measurement of cross-domain behavior. Do not
select it from the current model's disagreements, and do not use its results to
choose a model, threshold, prompt, or new crawl target.

### 2. Build the training pool after the holdout is immutable

The remaining existing packets plus the bounded fresh captures form the initial
training pool. Start with random/domain-stratified candidates and clear hard
cases. Then run the compact baseline and query only:

- high-entropy or low-confidence candidates;
- disagreements between the compact model, semantic DOM hints, and weak
  article/boilerplate oracles;
- candidate pairs whose family/variant scores disagree; and
- boundary cases with large geometry disagreement or repeated sibling patterns.

Show predictions only in this second pass, with a visible `model suggestion`
label and a required human accept/change/unknown decision. Never backfill a
human label from a suggestion. Keep the same domain/template split groups when
allocating reviewed training data; do not put an active-learning sample from a
holdout domain into training.

### 3. Review and gold eligibility

Human labels are data with provenance, not automatic gold. Store at least
`raw`, `reviewed`, `adjudicated`, and `goldEligible` states. A reviewer must
resolve clear disagreements and boundary notes. Keep `unknown`, unresolved
boundary changes, mixed-role candidates, and ambiguous pair decisions as
reviewed-but-not-gold records unless a later adjudicator can state a clear rule
and evidence. Consensus alone does not turn an ambiguous case into gold.

Report pairwise role/context/boundary agreement, per-label confusion, unknown
coverage, and disagreement reasons. Keep boundary agreement separate from role
agreement. The 200-region holdout may report a reviewed reference set and an
ambiguous subset; neither is training data.

## Bounded fresh capture proposal

Capture proposal date: **2026-09-18**. The primary capture is exactly **30
sites × 3 public routes = 90 desktop captures**. Choose sites to cover distinct
registrable domains and template families rather than to maximize URL count.
Screen all 30 sites against the existing v2 registrable-domain groups. Reserve
at least 10 entire fresh sites (all three routes) for the blind holdout and keep
the other 20 sites in the training pool. If the reserved sites do not yield 200
candidate regions, reserve additional whole fresh sites before labeling; never
borrow regions from a training site or mix routes from one site across the
holdout and training pool.
For each site, choose:

1. a home or landing page;
2. a representative article, product, documentation, or detail page; and
3. a listing, search, utility, or public interaction page.

If a requested route is unavailable, replace it with the closest same-site page
type and record the substitution. Do not add extra pages to compensate. Capture
an additional **mobile subset of at most 10 sites × 1 route = 10 mobile
captures**, using the same route-selection rule and a fixed mobile viewport.
The 90 desktop captures are the required corpus; the 10 mobile captures are a
bounded robustness slice and do not justify a blanket second crawl.

Each capture record must contain:

- the sanitized DOM snapshot used to derive candidates, plus a SHA-256
  `contentHash` of the canonical capture body;
- the full-page screenshot and, if needed for the annotator, a neutral-outline
  display copy;
- viewport width/height, device scale factor, scroll height, and desktop/mobile
  class;
- candidate `candidateId`, screenshot-space rectangle (`x`, `y`, `width`,
  `height`), DOM XPath/structural locator, and capture-local geometry version;
- UTC capture timestamp, fetch/render status, and source provenance;
- consent state (`visible`, `accepted`, `settings-open`, `absent`, or
  `unknown`); and
- form state (`untouched`, `validation-error`, `success`, `not-present`, or
  `unknown`), with no real credentials or private form values.

For public forms and consent UI, use only controlled, reversible interactions:
no account creation, payment, message submission, or real personal data. Record
the state that was actually captured. A deterministic consent banner may be
captured in its visible state and, where safely available, its settings-open or
accepted state; these are explicit state variants in the manifest, not hidden
labels. A form may be captured untouched and, only with synthetic values and a
non-destructive endpoint, in a validation-error state. If the state cannot be
reproduced safely, record `unknown` and continue.

The capture job has its own manifest, output root, seed, and run ID. It reads
the chosen allowlist and writes private artifacts without consulting or changing
OpenCode processes, task archives, active branches, crawler queues, or live
annotation state. A failed page is recorded as a failed capture and replaced
only within the fixed 30-site/90-desktop budget.

## Reuse and stopping gate

The initial 90 desktop plus at-most-10 mobile captures are enough for a first
human calibration and disagreement analysis when combined with the existing v2
packets. Do not perform a blanket larger crawl. After the first reviewed
training tranche, add at most targeted replacement captures only if a review
shows one of these concrete gaps:

- a taxonomy role has no clear reviewed training examples;
- one of the hard-case buckets has no representative example;
- a required site/template family is absent from the domain-held-out report; or
- active-learning disagreement is concentrated in a capture pattern that the
  30-site sample cannot represent.

Any extension must name the missing role/pattern, select only the affected
site/page types, and be approved as a new bounded manifest (maximum 10 extra
sites/30 desktop captures). If the gate does not identify a gap, stop crawling
and improve adjudication, boundary policy, or the existing candidate extractor
instead. The 200-region blind holdout remains frozen and is never moved into
training.

## Outputs and acceptance checks

The first implementation is complete when the private run can produce:

1. a frozen 200-region blind holdout manifest with whole unseen domains;
2. a 90-desktop plus at-most-10-mobile capture manifest with all required
   provenance and interaction-state fields;
3. Label Studio task JSON and configuration for role/context/boundary review;
4. a separate pair-task export with the four-way family/variant/different/uncertain decision;
5. raw, reviewed, and adjudicated human-label exports with stable candidate IDs;
6. a QA report separating role, context, boundary, and pair agreement; and
7. a training manifest that proves the holdout candidate IDs and domain groups
   are absent from every training, validation, active-learning, and model-tuning
   input.

No human result is called `gold` without the review and eligibility state. No
Webis, Luna, Readability, Web2Text, BoilerNet, Trafilatura, jusText, or
MarkupLM output is called human gold. No production scoring path changes as a
result of this experiment.

## Sources checked

- Label Studio, [HTML Classification template](https://labelstud.io/templates/html_classification): whole-page `HyperText` plus task-level choices; useful context reference, not a DOM picker.
- Label Studio, [Image Classification template](https://labelstud.io/templates/image_classification): image classification with configurable choices.
- Label Studio, [Image bounding-box template](https://labelstud.io/templates/image_bbox), [Rectangle tag](https://labelstud.io/tags/rectangle), and [Choices tag](https://labelstud.io/tags/choices): screenshot regions, per-region choices, and required selections.
- Label Studio, [task format](https://labelstud.io/guide/task_format): result structure and preservation of region IDs when pre-annotations become annotations.
- Webis, [Web Page Segmentation Revisited repository](https://github.com/webis-de/cikm20-web-page-segmentation-revisited-evaluation-framework-and-dataset): MIT code, local browser annotation template, screenshot rectangles, fit-to-DOM step, agreement, and fusion workflow.
- [WebSeg-Curator](https://github.com/JasminSaxer/WebSeg-Curator): MIT browser curation extension with DOM-node selection, functional classes, overlays/deletion, and bounding-box export; its legacy backend, disabled-web-security setup, and auto-propagation are explicitly excluded here.
- [WebClasSeg-25](https://doi.org/10.5281/zenodo.14881792): CC BY 4.0 supplemental segmentation data, to be used only with attribution and only as geometry/context support.
- SquirrelScan experiment notes: [`ANNOTATION.md`](./ANNOTATION.md), [`README.md`](./README.md), [`TRAINING.md`](./TRAINING.md), [`REUSE.md`](./REUSE.md), and [`schema.json`](./schema.json).
