# Sparse text/DOM student

This offline baseline trains separate linear heads from the `dom-role-text-v1`
Product Hunt corpus. It uses word and character TF-IDF from the supplied node or
page serializer. Node serializers include safe DOM structure; it does not use
screenshots, geometry, URLs, or external page data.

Jev distributions are weak soft targets. For every observed binary label, the
trainer fits a probability-weighted positive and negative row, which implements
binary cross-entropy for that target. Missing axes are omitted rather than made
negative. The component head is one-vs-rest soft supervision and normalizes no
teacher probabilities at inference time.

The command deliberately reads only the train files plus the manifest. Adding
`--validation` reads the provisional Jev validation file after fitting and writes
diagnostic same-teacher agreement. It has no test argument and never accesses
held-out test files. Independent Luna labels can be scored by joining node rows on
`(pageId, nodeId, captureHash)` and page rows on `(pageId, captureHash)`.

`--jev-v3` accepts the train-only v3 packet. Every v3 row must match the original
serializer snapshot by page ID, node ID where applicable, and snapshot hash; its
observed axes replace the corresponding v2 target for that one row. It never adds
a second copy of a target row.

`evaluate_luna.py` rejects provisional or unvalidated labels. It scores only axes
explicitly marked complete, checks the full `(pageId, nodeId, captureHash)` node
key, and reports a tag-only DOM baseline beside the student. Incomplete axes may
contain positive-only claims; they are excluded from exact-set scoring and only
their observed-positive recall is reported.

Evaluation requires the frozen artifact's `metadata.json`; its stored artifact
SHA-256 must match the model file before a result is written.
The validated consensus manifest must also list the exact approved file in
`labelFiles` as `{ "path": "...", "sha256": "sha256:..." }`; an old or
modified label file is rejected even when the manifest says `validated`.

```sh
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/.venv/bin/python student.py \
  --dataset $DOM_CLASSIFIER_DATA_ROOT/2026-09-19/dom-role-text-dataset-v1 \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-19/student-sparse-v1 \
  --validation
```

Artifacts stay private. `metadata.json` records the input manifest hash and marks
validation agreement as a same-teacher diagnostic, not accuracy. The generated
`public-summary.json` contains only aggregate diagnostic figures and its limits.
`metadata.json` also freezes the exact configuration, UTC run time, and artifact hash
before any independent-test evaluation.
