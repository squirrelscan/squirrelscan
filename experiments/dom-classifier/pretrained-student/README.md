# Manifest-bound pretrained student

This trainer fine-tunes the cached, pinned `FacebookAI/roberta-base` encoder
(`e2da8e2f811d1448a5b465c236feacd80ffbac7b`) on sanitized Jev-v4 text/DOM
records. It reads no screenshots, geometry, URLs, selectors, human labels, or
Luna records. The sparse student remains the baseline.

The model contract is `dom-taxonomy-v2`. It has independent heads for a
component type distribution and masked multi-label region, purpose, page type,
and content-kind predictions. An omitted axis is unknown: it supplies no
negative target or loss.

Training requires a frozen manifest with hash-bound `trainingFiles` and exact
`trainingRecords` identities. It opens only the explicitly supplied train and
validation JSONL files; test records are neither accepted as inputs nor used
for selection. Each record must be a non-gold Jev result with
`dom-suggestions-v4` provenance and an input hash matching the manifest.

```sh
VENV=$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv/bin/python
CACHE=$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/hf-cache
"$VENV" trainer.py \
  --manifest /private/frozen-train-manifest.json \
  --train-records /private/train.jsonl \
  --validation-records /private/validation.jsonl \
  --cache-dir "$CACHE" --device mps --output /private/pretrained-student-run
```

The fixed configuration is three epochs, sequence length 192, batch size 8,
AdamW at 2e-5, and weight decay 0.01. `local_files_only=True` prevents network
downloads. Outputs are immutable private artifacts (`model.pt`, `metadata.json`)
with owner-only file permissions.

`metadata.json` is the prediction interface: it declares the head vocabularies
and identity contract. A predictor must emit each supplied record identity,
then `componentType.{probabilities,prediction}` and each applicable multi-label
axis as `{probabilities,positiveLabels}`. Predictions retain `recordType`,
`pageId`, `nodeId`, and `captureHash`; they are never inferred from a test
label.

Run the input-gate tests with the same environment:

```sh
"$VENV" test_trainer.py
```
