# Jev model suggestions

This directory contains a deliberately small TypeSafe/​Jev adapter for offline
model suggestions. It constructs one typed request from a rendered capture and
keeps the returned judgments separate from human annotations. It does not write
labels, modify captures, or claim that a suggestion is DOM ground truth.

The adapter uses `jev-1.13.0` and prompt revision `dom-suggestions-v3`. Jev is
text-only, so the request includes page metadata and bounded node state but no
screenshot bytes. The node state is limited to fields already present in the
capture: id, parent id, tag, ARIA role, bounded text, rectangle, and depth. CSS,
classes, arbitrary attributes, selectors, weak suggestions, comments, and human
annotations are intentionally omitted. URLs are HTTPS-only with credentials,
query strings, and fragments removed; text redacts email addresses and common
credential patterns.

Page type and content kind are independent Noul questions, allowing multiple
page types or kinds to receive positive probabilities. Each candidate receives
independent Noul questions for every region and purpose, plus one Choice over
the existing component type vocabulary. The adapter preserves the complete raw
response, including Noul probabilities, Choice distributions, Choice
confidence, model id, and token usage. It does not convert probabilities into
human labels or thresholds.

Revision `v3` explicitly defines the additive region labels (`hero`,
`top_banner`, `bottom_banner`, and `overlay`), purpose labels (`promotion`,
`announcement`, `authentication`, `subscription`, `feedback`, and `support`),
and component shapes including `dialog`, `drawer`, `banner`, `popover`, and
`content_section`. Earlier v2 sidecars remain valid historical suggestions;
they intentionally do not contain these newer axes and are not rewritten.
Component subtypes remain human-only in this contract; adding model subtype
judgments would require a new sidecar axis and another versioned prompt.

`selectCandidates` is deterministic and bounded (ten by default). It ranks
semantic landmarks and interactive nodes using only the captured tag, role,
text length, geometry, and depth. This is a request-size control, not a claim
that omitted nodes are negative examples.

## Private generator

`generate-jev.ts` is a reproducible, append-only private runner. It reads one
capture JSON or a directory of capture JSON files, refuses input and output
paths outside the configured `DOM_CLASSIFIER_DATA_ROOT`, and skips a capture
when its sanitized-state hash and prompt revision already exist in the output
JSONL. It
sends one request per page and emits the backend sidecar shape:
one page row with `nodeId: null`, followed by one row per selected node. The
request token usage is recorded on the page row only, so it is not counted once
per emitted node row.

The default bound is three pages; `--limit` must be between 1 and 200. A page
is skipped only when the output contains the complete page row and every
selected node row for the same sanitized snapshot, model, and prompt revision.
Transient service failures get one short retry and then are reported in the
bounded summary while later pages continue.

```sh
export DOM_CLASSIFIER_DATA_ROOT=/path/to/dom-classifier-data
bun --env-file="$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/labeler-runtime/typesafe.env" \
  experiments/dom-classifier/model-suggestions/generate-jev.ts \
  --input "$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/human-ui-v1/captures" \
  --output "$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/model-suggestions/jev.jsonl" \
  --limit 3 --max-candidates 10
```

The environment file is operator-managed and must remain mode `0600`; the key
is read only by the HTTP transport and is never accepted as a command-line
argument. Sidecars are provisional evidence. Human review can bind to their
`id`, `pageId`, `nodeId`, `captureHash`, and `snapshotHash` once the importer
contract is enabled.

Tests use a mock transport and never require a credential. For a live, private
pilot, load `TYPESAFE_API_KEY` from the operator-managed environment file and
write the resulting evaluations only under the private experiment directory.
Never print or commit that key, raw responses, or private captures.
