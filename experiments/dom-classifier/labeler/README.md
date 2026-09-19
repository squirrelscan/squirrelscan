# Local human DOM labeler

This is a private, localhost-only review service for rendered public pages. It
stores a full-page PNG and a bounded DOM geometry snapshot for each immutable
capture. The browser is used only to make a fresh capture; the review server
does not serve archived HTML or execute archived page scripts.

Its fixed seed list is only a small smoke-capture mode: SquirrelScan, Taskmux,
Example, and one public MDN reference page. Larger corpus work is supplied to a
separate command-line renderer as a private, validated manifest. The review
HTTP API accepts no URLs or browser profile, so it cannot act as a proxy or
inspect a user's logged-in session.

## Run

Install the scoped experiment dependencies and its Chromium browser before
capturing or running browser checks:

```sh
(cd experiments/dom-classifier && bun install --frozen-lockfile && bunx playwright install chromium)
```

When a bundled runtime is already available, set
`LABELER_PLAYWRIGHT_MODULE` to its Playwright module instead. Capture the
bounded seed set first:

```sh
bun experiments/dom-classifier/labeler/server.ts capture
```

Then start the service through the repository's managed runtime configuration.
It defaults to `127.0.0.1:4317`; `PORT` and `LABELER_DATA_DIR` are supported.
The service never starts a crawl or re-captures pages on its own.

Portable local output defaults to `~/.local/share/squirrel/dom-labeler`. Set
`LABELER_DATA_DIR` to choose another review store:

```text
captures/page_<hash>.png     immutable screenshot
captures/page_<hash>.json    rendered DOM node geometry and bounded text
annotations.jsonl            append-only human decisions
page-annotations.jsonl       append-only human page-level decisions
```

Node IDs are structural IDs inside an immutable capture. A capture ID includes
the sanitized rendered-content hash, screenshot hash, and viewport. An
annotation records that capture hash and remains `source: "human"` and
`gold: false`; review/adjudication is a separate later process.

## API

- `GET /api/pages` returns the page list, node-label taxonomies, and the
  authoritative page-level `pageTypes`, `pageTypeGroups`, and `contentKinds`
  catalogues.
- `GET /api/pages/:id` returns the immutable page, nodes, node annotations,
  and `pageAnnotations`.
- `GET /api/stats` returns current queue totals, page-level labels
  (`pages.currentPageLabels`), positive element labels, and model-review
  actions. `pages.labelled` means a page has any current positive page or
  element label. Reviewed counts use only the latest effective action for each
  current model suggestion; provisional suggestions are never counted as human
  labels.
- `GET /captures/:id.png` returns an allowlisted local screenshot only.
- `POST /api/annotations` appends a validated, idempotent annotation. It needs
  a same-origin `Origin`, `labeler_csrf` cookie, and matching
  `X-Labeler-CSRF` header. Read any API endpoint first to receive the cookie.
- `POST /api/page-annotations` appends a validated, idempotent page-level
  annotation with the same localhost CSRF protection.
- `GET /api/export` downloads node annotation JSONL. Page annotations remain in the separate private `page-annotations.jsonl` stream.
- `GET /api/export/reviews` downloads a private JSON review bundle with the
  stats snapshot and append-only node, page, and model-review histories.

The write body is `{pageId,nodeId,decision,regions?,purposes?,componentType?,
componentSubtype?,observedState?,role?,context?,comment?,boundary,
clientRequestId,captureHash?,supersedes?}`. `captureHash` is optional for the
base contract but lets the UI reject an optimistic write against an older
capture. `clientRequestId` makes retrying a save safe.

Earlier schema-v2 rows separated independent axes:

- `regions`: `site_header`, `footer`, `sidebar`, `main_content`,
  `article_header`, or `unknown`.
- `functions`: `navigation`, `card`, `form`, `consent_banner`, or `unknown`.

Each array may be empty and has no negative implication. Labels are unique and
`unknown` must be the sole label in its own axis. This permits combinations
such as `regions: ["footer"]` plus `functions: ["navigation"]`. These raw
values remain preserved in the append-only history; the current picker does
not write a second legacy-function selector.

The raw legacy `role` and `context` fields remain in every existing annotation.
When old records are read, the service exposes a `labelSchemaVersion: 1`
compatibility projection: legacy `aside` becomes `sidebar`, legacy navigation
becomes a purpose, and explicit legacy `header`, `footer`, or `main` context
adds the corresponding region. It does not rewrite the JSONL or treat that
projection as a new human claim. A visible editor note identifies this
projection before a reviewer saves a newer revision.

`label` needs one or more region/purpose/component labels. An `accept` must include its
weak hint on the hint's axis, but may retain independently selected labels on
the other axis. If an accept omits both arrays, the service records only the
matching weak-hint projection. A `reject` keeps supplied independent labels and
context but cannot retain the rejected hint or carry a legacy role. `unsure` carries
no labels. A correction can set `supersedes` only to the latest annotation for
the same captured node, so the JSONL preserves the full revision trail. Page
progress counts unique nodes, not revisions.

## Component schema v3

V3 records the observed component shape separately from its layout and purpose.
It does not identify framework/source components, component families, or link
graph membership. The picker supports primitives (`button`, `link`, `input`,
`checkbox`, `radio`, `select`, `toggle`, `heading`, `text`, `icon`, `image`),
widgets/content (`search`, `dropdown`, `tabs`, `accordion`, `pagination`,
`card`, `form`, `list`, `table`, `article`, `media`), sections/layout (`hero`,
`navigation_menu`, `content_section`, `layout_container`), and overlays
(`dialog`, `drawer`, `tooltip`, `notification`, `banner`, `popover`), plus
`unknown`. Regions separately describe placement, including `hero`,
`top_banner`, `bottom_banner`, and `overlay`.
A `navigation_menu` is a composite type; its descendant links remain separate
observed nodes and are never inferred as primitive labels merely from that
container. DOM containment is capture evidence, not a source-component tree.

`componentSubtype` is optional and accepted only for component types and values
published by `GET /api/pages`. The current catalogue includes variants for
`button`, `input`, `card`, `navigation_menu`, `form`, `dialog`, `banner`,
`drawer`, `popover`, and `content_section`; the server catalogue remains
authoritative as it evolves.
`observedState` is optional, has per-type validation, and is only what the
annotator saw: `visible`, `disabled`, `expanded`, `selected`, `open`, `sticky`,
or `unknown`. `purposes` are independent of type: `navigation`, `submit`,
`search`, `filter`, `consent`, `share`, `account`, `dismiss`, `download`,
`toggle`, `promotion`, `announcement`, `authentication`, `subscription`,
`feedback`, `support`, or `unknown`. The current write field is `purposes`; it
is distinct from the v2 `functions` archive field. `card`, `form`, and
`banner` describe the observed component shape, while a purpose such as
`submit` or `consent` describes what it is for. Page region answers where it
appears. None of these axes identifies a framework component or source-code
family.

V1/V2 rows remain byte-for-byte unchanged. They read with
`componentSchemaVersion: 0` and, when unambiguous, a
`componentProjection` or `purposeProjection` marked `legacy-v1-v2`; these are
display aids, not new human v3 labels. In particular, legacy navigation reads
with `purposeProjection: ["navigation"]` while raw `purposes` remains empty.
New component-picker saves have `componentSchemaVersion: 3`.
`GET /api/export` returns the original JSONL lines rather than normalized read
projections.

## Taxonomy revision v2

`dom-taxonomy-v2` is additive: every existing canonical label remains valid
with its prior meaning. The version adds article-body and paid-ad regions,
separate product gallery, buy-box, details, and review regions; author, related,
and comments regions; purposes for paid advertising, purchase, media playback,
reviews, information, editorial, instruction, product information, comparison,
and social proof; and component shapes for ad units, media galleries, purchase
panels, specification lists, rating summaries, review lists, media players,
author cards, and comment threads. It deliberately does **not** duplicate existing
`image`, `media`, `banner`, `promotion`, product page types, or editorial page
types. The full machine-readable vocabulary and definitions are in
[`../taxonomy.json`](../taxonomy.json).

Axes remain independent: a `media_gallery` component can sit in a
`product_gallery` region without implying `media_playback`; a first-party
`banner` can have `promotion` without becoming an `advertisement`; and a
`purchase_panel` may have `purchase` only when it actually supports a purchase.
An omitted or empty axis is unobserved, never a negative label. Only
`["unknown"]` records an explicit unknown for one multi-label axis. Legacy
records and sidecars are never silently mapped to new v2 labels.

## Page schema v1

Page labels are a separate review stream: they never add, modify, or infer DOM
component labels. `POST /api/page-annotations` accepts
`{pageId,decision,pageTypes?,contentKinds?,comment?,clientRequestId,captureHash?,supersedes?}`.
The response is `{annotation}`, and a page detail includes its complete
append-only `pageAnnotations` trail.

`pageTypes` describes the page's role (for example `homepage`, `blog_post`,
`docs_article`, `product_detail`, `pricing`, `contact`, `news_article`, or
`case_study`). The API publishes a grouped catalogue for entry/company,
commercial, documentation/releases, publishing/media, community/events,
account/transaction, and utility/policy uses. `contentKinds` is an independent
optional axis: `article`, `product`, `person`, `event`, `review`, `offer`,
`job`, `software`, `service`, `organization`, `reference`, `media`, `other`,
or `unknown`. This permits hybrids such as a product detail page whose content
is software, without making a cross-product taxonomy.

Both axes allow several values for hybrids. Values are unique and `unknown` is
exclusive within its own axis. A `label` decision needs at least one page type
or content kind; an `unsure` decision carries neither. Thus an explicit
unknown is a `label` with `pageTypes: ["unknown"]` or
`contentKinds: ["unknown"]`, while `unsure` records no classification. A
correction may supersede only the latest page annotation for that capture, and
the same `clientRequestId` may safely retry exactly the same request. Page
labels keep the immutable capture hash as provenance. URL-derived hints are not
stored as human labels or prefilled as confirmed labels.

Historical replay captures may add non-label provenance metadata:
`sourceKind`, `originalCrawledAt`, `sourceUrl`, opaque `corpusRef`,
`contentOriginDate`, and `assetMode`. `capturedAt` remains the time the
rendered screenshot was made. These fields describe capture origin for the UI;
they do not affect page or node labels.

## Provisional Jev suggestions and keyboard review

When the current capture has a Jev sidecar suggestion for an unreviewed node or
page, the labeler starts in fast model-review mode. For element review, the
card names the proposed **Page region**, **Element type**, and any **Purpose**,
and asks the concrete question those values imply. An axis Jev did not map is
shown as **Not suggested**; the labeler never infers it from the DOM tag. The
exact captured target receives a strong outline and is panned into view. Page
review shows page classification only and does not highlight an element. The
card then offers **OK** and **Not OK**. OK saves the
suggestion's exact mapped labels as a human acceptance and advances. Not OK
saves a standalone model rejection and advances; it does not require a
replacement label. A comment is optional in the advanced editor. Model scores
are never presented as verified accuracy.

An existing human annotation or saved review is preserved and cannot be
overwritten by the fast controls. Open the advanced editor to revise an earlier
human label, add a manual label, or make a correction. Changing a region,
purpose, component type, subtype, or observed state records a model `correct`
review; “Reset to model labels” intentionally replaces a changed draft with the
model labels.

Use the dedicated model-review card for one prepared target at a time: swipe
right to approve or left to reject. The gesture only triggers after a deliberate
horizontal drag; vertical scrolling, short drags, and gestures that start on a
control never save a review. **Skip** (or `J`) defers the current target for
this browser session without writing a label or rejection, then moves to the
next available target or page. In Page mode, Skip moves to the next captured
page. `Enter` outside form fields marks the displayed model label OK and
continues; `X` marks it Not OK and continues. **Undo last review** (or
`Cmd/Ctrl` + `Z` outside a text field) reverses your most recent successful
model acceptance, correction, page label, or rejection with an append-only
undo record, then returns to the exact target. Finish or discard a current
manual draft before undoing so that draft is preserved. `K` moves back through the current
capture's model targets, including saved labels so they can be corrected. In
Page mode, `K` moves to the previous captured page. `[` and `]` move between
captured pages; `P` and `C` select the parent or first child; `Esc` clears the
current element; and `?` opens the on-screen shortcut reference. `Cmd/Ctrl`
`Enter` saves the current advanced draft from any field, including a comment;
add `Shift` to save and continue. These shortcuts do not intercept ordinary
typing or native button/link activation. Unsaved human edits still use the
inline keep-or-discard prompt before a page, mode, or selection change.

Run the focused checks with:

```sh
bun test experiments/dom-classifier/labeler/server.test.ts
```

## Private corpus rendering

A separate command-line-only queue may render up to 200 pre-reviewed public
HTTPS manifest URLs. It is never available through the labeler API. Each JSONL
row is exactly `{url,originalCrawledAt?,corpusRef?}`. Query strings, credentials,
private hosts, authentication paths, and attachment URLs are rejected before a
browser starts.

The queue stages immutable PNG/manifest pairs first. Every candidate is an
anonymous **fresh** browser render (`sourceKind: "fresh_capture"`,
`assetMode: "live"`) at `capturedAt`; an `originalCrawledAt` or opaque
`corpusRef` records where a URL was discovered, not a claim that archived HTML
or screenshot data was imported. A true replay, when one is supported, must be
marked separately with its historical provenance and must never be presented as
a fresh render.

Before import, run the read-only quality review over the stage. It checks that
the PNG and manifest dimensions agree with `min(ceil(documentHeight), 12000)`,
that retained DOM rectangles fit the PNG, and that obvious challenge or
obscured captures are held out. The importer requires a matching private
`--review` file and copies only records marked `eligible`; it leaves every
held-out pair staged. The queue uses isolated contexts, four concurrent
distinct hosts, a 60-second capture deadline, 20 lazy-load steps, and a
12,000px image cap.
