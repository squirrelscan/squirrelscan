# Frozen text/DOM probe results

Run date: 2026-09-19

This is an offline comparison on the existing frozen v2 split (258 train, 62
validation, 55 test). The test partition was previously used by the structural
baseline, so it is a reused frozen holdout rather than a pristine final test
set. Labels are provisional Luna silver labels; human accuracy is unknown.

| Model | Test forced accuracy | Test all-10 macro-F1 | Test observed-class macro-F1 |
| --- | ---: | ---: | ---: |
| Historical structural baseline | 0.763636 | 0.520238 | 0.650298 |
| Frozen RoBERTa text/DOM probe | 0.472727 | 0.203840 | 0.254800 |

The probe used `FacebookAI/roberta-base` at
`e2da8e2f811d1448a5b465c236feacd80ffbac7b`, with a frozen encoder and a
trained single-role linear head. It used no screenshots, rendered geometry, or
visual features. The run took 30.531 seconds on MPS, excluding the one-time
pretrained checkpoint download. It serialized bounded node text and ancestor
tags only; candidate IDs, URLs, domains, labels, and annotation provenance
were not model inputs.

The result is evidence that this particular bounded frozen text/DOM probe does
not beat the historical structural baseline on this reused silver holdout. It
does not reject text encoders generally, establish human performance, or make a
production-model decision.

Private artifacts, including the reload-checked head checkpoint, aggregate
metrics, and candidate-level predictions, are at:

`$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/text-probe-v1-20260919`

Reproduce after installing the local experiment requirements:

```sh
cd experiments/dom-classifier/text-training
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv/bin/python train.py \
  --v2-root $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2 \
  --cache-dir $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/hf-cache \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/text-probe-v1-repro
```
