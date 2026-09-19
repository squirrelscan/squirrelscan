# Rendered page labeler QA

This checklist covers the rendered-page section picker: selecting a DOM-backed
section, reviewing a suggestion, accepting or rejecting it, and adding a
comment. It is intentionally a small manual and integration pass. It does not
measure classifier quality, create human labels, or expand the capture corpus.

## Test boundary and harness

- [ ] Use a fresh, isolated browser context and a temporary test-data directory
      for every run. Do not use the user's normal Chrome profile, saved
      cookies, extensions, downloads, or local annotation store.
- [ ] Use the parent-provided local preview URL. Do not start a service from
      this checklist and do not use a live OpenCode task, task archive, or
      crawler queue as a data source.
- [ ] Use an installed Playwright package and browser. If the environment
      provides a bundled runtime instead, set `LABELER_PLAYWRIGHT_MODULE` and,
      when needed, `LABELER_BROWSER_EXECUTABLE`; a missing local browser is an
      environment failure, not a reason to use a personal browser profile.
- [ ] Keep screenshots, capture manifests, task exports, browser profiles, and
      test annotations outside Git. Never commit a real page capture or a
      human-like label made during QA.
- [ ] Record the preview URL, browser/viewport, commit, test-data directory,
      and pass/fail result in the QA note or issue. Do not record cookies,
      authorization headers, or personal form values.

## Seed pages

Use a few stable public pages to exercise different geometry and semantics.
These are seed examples, not a crawl request; record the exact URL and capture
time because public pages can change.

| Page | What it should exercise | Useful candidates |
| --- | --- | --- |
| [Python home](https://www.python.org/) | Repeated site chrome and a long footer | `site_header`, `navigation`, repeated news/download cards, `footer` |
| [MDN home](https://developer.mozilla.org/en-US/) | Dense navigation and repeated content units | `site_header`, `navigation`, cards, `aside`, `footer` |
| [MDN HTML introduction](https://developer.mozilla.org/en-US/docs/Web/HTML) | Article structure and nested secondary content | `article_header`, `main_content`, table-of-contents `navigation`, `aside` |
| [web.dev](https://web.dev/) | Editorial cards and responsive geometry | `site_header`, article/list cards, `footer`, possible consent UI |
| [GOV.UK home](https://www.gov.uk/) | Semantic landmarks with service-link cards | `site_header`, `navigation`, main service links, `footer` |

If one page is blocked, unstable, or materially redesigned, record it as
unavailable and continue with the remaining pages. Do not compensate by
adding extra pages or by labeling a page from a logged-in or personalized
session.

## Taxonomy and suggestion contract

The picker must preserve two separate facts for every candidate:

1. **Identity:** immutable `candidateId` joined to the capture/page revision,
   DOM locator, and screenshot-space rectangle.
2. **Role decision:** a human decision about the candidate's role, including
   `unknown` when the rendered evidence is insufficient.

A model or heuristic suggestion is provisional evidence. It is never a human
label, never `gold`, and never allowed to replace the candidate identity.

- [ ] Every visible candidate has a stable candidate identity in the task data;
      selection, scrolling, or re-rendering does not create a second identity.
- [ ] The suggestion UI names the suggested **role** and its provisional state;
      it does not present a role suggestion as the candidate's identity.
- [ ] A suggestion may use only the existing ten role values:
      `site_header`, `footer`, `navigation`, `main_content`,
      `article_header`, `card`, `aside`, `form`, `consent_banner`, and
      `unknown`.
- [ ] `unknown` remains a real role decision and an abstention. Rejecting a
      suggestion must not silently convert it to `unknown`, and accepting a
      suggestion must not force an uncertain candidate into a non-unknown role
      without an explicit human choice.
- [ ] Role and context remain distinct. `context` describes where a region is
      (`site`, `article`, `main`, `header`, `footer`, `unknown`); it does not
      become the role, and a context suggestion cannot overwrite the role.
- [ ] A candidate that is a repeated unit inside an `aside` can be labeled
      `card`, while the surrounding rail can be labeled `aside`. The picker
      must allow selecting parent and child candidates independently.
- [ ] The UI provides an explicit way to leave a decision uncertain or
      unresolved. The absence of an accept/reject click must not be serialized
      as an accepted human label.
- [ ] Acceptance records that the human accepted the current suggestion and
      its suggestion/version identity. Rejection records that the human
      rejected the current suggestion without deleting or mutating the
      candidate.
- [ ] Accept/reject actions do not write `gold`, `adjudicated`, or equivalent
      human-reference status. Those states require the review workflow described
      by `HUMAN-LABELING.md`.

## Geometry, scrolling, and hit testing

- [ ] The picker can select a candidate near the top, middle, and bottom of a
      long page. Full-page screenshot coordinates and viewport coordinates do
      not drift after scrolling.
- [ ] Scroll to a candidate, select it, scroll away, and return. The outline,
      selected state, candidate ID, and comment target remain the same.
- [ ] Test a candidate whose rectangle is partly outside the viewport. The
      picker scrolls or otherwise makes the target discoverable without
      selecting a neighboring region.
- [ ] Test a full-width header, a narrow footer column, a dense card grid, and
      a sidebar/aside. The hit target matches the rendered rectangle at desktop
      width.
- [ ] Test a nested parent and child candidate. Clicking the child's visible
      content selects the intended child; a parent overlay must not swallow all
      child hits. If the UI offers a parent/child disambiguation, the chosen
      identity is visible before saving.
- [ ] Test overlapping or touching rectangles. A click on the shared edge does
      not silently label both regions, and keyboard focus provides an accessible
      way to choose the intended candidate.
- [ ] Resize once between desktop and a bounded mobile viewport. The UI either
      recomputes/loads the matching capture revision or clearly refuses the
      stale geometry; it must not silently attach a desktop rectangle to a
      mobile capture.
- [ ] Zooming the page or the screenshot does not change the stored rectangle
      coordinate space. The saved record states its coordinate space and capture
      revision.
- [ ] Keyboard navigation can focus every candidate control and action. Focus
      is visible, does not jump to the page behind the picker, and Enter/Space
      produces the same selection as a pointer click.
- [ ] A candidate can be deselected or changed before save. There is no
      accidental save caused by hover, scroll, pointer-up, or an overlay click.

## Suggestion decisions

- [ ] With a suggestion visible, choose **accept** and verify the UI shows a
      saved human decision for the same candidate and suggestion revision.
- [ ] With a suggestion visible, choose **reject** and verify the suggestion
      becomes rejected while the candidate remains selectable and its capture
      identity, rectangle, and locator are unchanged.
- [ ] Reject a suggestion, choose an explicit alternate role, and save. The
      final decision is the alternate human role; it is not represented as an
      accepted model suggestion.
- [ ] Leave a suggestion unresolved or choose `unknown`, reload, and verify the
      uncertainty remains explicit. It must not be rewritten as rejection,
      acceptance, or an arbitrary fallback role.
- [ ] Change the selected candidate while a suggestion panel is open. The
      panel, accept/reject action, and comment editor follow the new candidate;
      no decision is written to the previously selected candidate.
- [ ] Present two suggestions for the same candidate with different
      suggestion/version IDs. Accepting one records exactly that version and
      does not overwrite the other suggestion's history.
- [ ] A missing, malformed, or expired suggestion fails closed with a readable
      error. The candidate remains available for an explicit human decision;
      the UI does not invent a role.

## Comments

- [ ] Add a short comment to a selected candidate and save. The comment is
      visibly attached to the candidate ID and capture/page revision.
- [ ] Reload the page or reopen the same task. The comment and its author/time
      metadata (if shown) remain present and are not duplicated.
- [ ] Edit or replace a comment only through the supported action. Saving an
      unrelated candidate does not alter the first comment.
- [ ] Submit an empty or whitespace-only comment. The UI rejects it or treats
      it as an intentional removal according to the documented contract; it
      must not create a blank review record.
- [ ] Use punctuation, Unicode, and a bounded long comment. Text remains
      readable and safely bounded; it must not be interpreted as markup or
      executable content.
- [ ] If comments are revision-scoped, make a new capture revision and verify
      the old comment remains attached to the old revision rather than silently
      moving to the new geometry.

## Persistence, revisioning, and failure recovery

- [ ] Save an unchanged decision twice (double click and retry). The result is
      idempotent: one logical decision for the same task/page/candidate/revision,
      with no duplicate comments or revisions.
- [ ] Refresh after a successful save. The saved state is reconstructed from
      the server/store, not only from in-memory UI state.
- [ ] Force or simulate a failed save. The UI reports the failure, keeps the
      unsaved decision/comment available for retry, and does not display a
      false success.
- [ ] Retry after a transient failure. The retry either succeeds once or
      returns a clear conflict; it does not append duplicate revisions.
- [ ] Test a stale revision or changed content hash. The write is rejected or
      routed to a new revision with a visible explanation; an older annotation
      is never silently overwritten.
- [ ] Verify the persisted join key includes task/page/candidate identity and
      the capture revision. Screenshot coordinates alone must never identify a
      saved decision.
- [ ] Verify an accepted/rejected suggestion retains suggestion source,
      model/version (when supplied), and `gold: false`/provisional provenance.
- [ ] Verify a human decision does not change the private capture manifest,
      original screenshot, DOM snapshot, or candidate locator.
- [ ] Verify a failed or canceled request leaves no partial human label, no
      accidental `gold` state, and no orphaned comment that cannot be inspected.

## Privacy and artifact checks

- [ ] Run with a fresh browser context and confirm no pre-existing labels,
      local-storage annotations, or account data are shown.
- [ ] Check screenshots and rendered task data for secrets, authorization
      headers, form values, personal data, and unbounded source HTML. Do not
      paste those values into a bug report.
- [ ] Confirm test captures, browser profiles, task JSON, network logs, and
      screenshots live in the ignored/private test-data directory and are absent
      from `git status --short`.
- [ ] Confirm ordinary public-page context is preserved: headers, footers,
      cards, sidebars, forms, and consent UI remain visible enough to make a
      role decision. Redaction must not remove the evidence needed for the
      label.
- [ ] Confirm screenshots used for review are either the original private
      capture or an explicitly marked neutral-outline display copy. No model
      class, confidence, or prior label is embedded in a blind-review image.

## Exit criteria and bug report

The rendered picker passes this QA slice only when every applicable checkbox
above is satisfied on at least one seed page and at least one long/nested page,
with no open blocker in geometry, identity, persistence, or privacy. A page
that does not expose a particular role is recorded as “not present”; do not
force a label to fill a taxonomy bucket.

For each failure, report:

- preview URL (without credentials), browser/viewport, and page/candidate ID;
- exact steps and whether the candidate was parent/child/overlapping;
- expected versus observed identity, role, suggestion, comment, and revision;
- whether the failure survives reload and a save retry; and
- a screenshot with private data removed plus the relevant request/error
  summary, never the full browser profile or task store.

QA findings are evidence about the picker workflow. They do not become human
gold labels, training examples, or a reason to start a larger crawl.
