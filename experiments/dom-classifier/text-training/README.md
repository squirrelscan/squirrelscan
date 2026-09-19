# Text/DOM training probe

This is an offline, text-and-DOM-only experiment. It has no screenshot or
rendered-geometry input and is not connected to production classification.

The initial trained artifact is a **frozen**
`FacebookAI/roberta-base@e2da8e2f811d1448a5b465c236feacd80ffbac7b` encoder plus
a trained linear head. It is a probe, not a full encoder fine-tune. The encoder
is loaded by pinned ID/revision on reload; the private artifact stores only the
small heads and their label vocabularies.

The initial v2 run is deliberately a separate `legacyRole` head over the
375-row Luna silver single-role corpus. Its result measures agreement with
adjudicated **silver** labels, never human accuracy. It uses the existing frozen
258/62/55 split. That test split was evaluated by an earlier structural model,
so it is a reused frozen holdout, not a pristine final holdout. Parameters are
predetermined; validation chooses the saved epoch and test is read once.

Run with private inputs and outputs only:

```sh
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv/bin/pip install -r requirements.txt
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv/bin/python train.py \
  --v2-root $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2 \
  --cache-dir $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/hf-cache \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/text-probe-v1
```

The model can hold independent categorical or multi-label modern axes (for
example region, purpose, component type, and page type). Each head has a
masked loss: an absent label is ignored, never treated as a negative. The
actual trained baseline currently exercises only the legacy categorical head;
positive-only modern suggestions are not supervised evaluation and are not fed
to it.
