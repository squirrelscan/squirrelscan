# Reviewed-label training export

This is a read-only exporter for the private DOM labeler store. It writes a new,
immutable snapshot outside the repository and never starts the labeler or changes
its journals.

```sh
bun experiments/dom-classifier/training-export/cli.ts \
  --input /private/dom-labeler \
  --output /private/dom-training-snapshots/reviewed-2026-09-19 \
  --grouping-input /private/dom-labeler-groups.json
```

If `tldts` is installed, groups are the URL eTLD+1. Otherwise `--grouping-input`
is required: a JSON array of `{ "pageId": "page_…", "groupId": "example.com" }`
or `{ "url": "https://…", "groupId": "example.com" }` rows.

`node-examples.jsonl` and `page-examples.jsonl` have separate label axes. Their
labels are positive-only observations: a missing axis is unobserved, never a
negative label. Only current human records with a correct boundary are eligible;
legacy role/component projections are not exported as new labels. `reject`,
`unsure`, bad-boundary, stale, and malformed-effective records go to aggregate
counts in `manifest.json` and identifiers/reasons in `excluded.jsonl`.

Do not feed these rows to ordinary binary cross-entropy by treating absent
classes as zero. A later trainer must collect label-level reviewed-completeness
or explicit negative confirmations, or use a positive-unlabeled method.

`splitGroup` keeps an eTLD+1 or documented group together; this export does not
freeze train/dev/test assignments and does not establish a template holdout.
An unselected class remains unobserved even when another label on that axis is
present.

Every output row retains `source: "human"` and `gold: false`. Jev/model rows are
copied to `audit/` and may appear only as `teacher` provenance for an associated
human review. They never create a supervised example or turn a record into gold.
The `audit/` directory contains raw append-only journals, copied capture manifests,
and SHA-256 entries in `manifest.json` for later review.
