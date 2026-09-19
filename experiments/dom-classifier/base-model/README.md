# Base model: private page-format inference

This runnable baseline evaluates page-level text with `WebOrganizer/FormatClassifier-NoURL` at immutable revision `74d5efb924e1843e84b28b59c26f6ceaa873dc16`. It is a 140M `gte-base-en-v1.5` classifier with 24 web-format classes (documentation, product page, news article, tutorial, and others). The downloaded `model.safetensors` is 549,556,200 bytes. Its Hugging Face model card does **not** declare a weight license; use it only for this local experiment until that is resolved.

## Decision for the first trainable component model

Use a fresh `FacebookAI/roberta-base` (MIT model card; pin `e2da8e2f811d1448a5b465c236feacd80ffbac7b`) sequence-classification head as the first model extended with reviewed SquirrelScan labels. This is an architecture decision, not a claim that it beats MarkupLM or WebClasSeg. It has a working tokenizer and a clear model-card license, while the WebClasSeg FC checkpoint's terms are unresolved and its `path_class` feature is not currently reproduced by capture records.

Before training, implement and freeze a serializer built from runtime-available DOM fields, add heads aligned to the labeler's separate region/function/component-type/purpose/page-type taxonomies, and validate it against a human-reviewed domain/template-held-out split. Jev sidecars stay weak suggestions; only reviewed human labels are train/evaluation targets. The released WebClasSeg checkpoint remains a diagnostic compatibility oracle, never an inherited-label source. Reconsider MarkupLM only after its weight terms and XPath extraction contract are verified.

It is the useful immediately-runnable page-purpose prior. It does not recognize this experiment's DOM regions, functions, component types, observed purpose, or the labeler's broader page-type taxonomy. A small, explicit format-to-page-type map is emitted only for direct cases and is tagged weak. Results must remain human-review suggestions and must never become gold labels or training targets merely because they came from this model or Jev.

For direct component evidence, this directory also has a diagnostic smoke runner for `gerbejon/roberta-html-nodes-fc-classifier-v2` at revision `8b5710fb9a2c9ad479aebfc338c47f581882131a` (498,631,280-byte weights). It has eight WebClasSeg functional classes: advertisement, footer, header, image, maincontent, multiple, nav, and title. Its model card and Hub metadata declare no checkpoint license, so it is not production-approved. It was trained on upstream `path_class` only, with no parent/child target labels as input. SquirrelScan capture records lack that serialization; the smoke runner supplies a tag-only CSS-selector approximation and labels it as such. It writes `footer`, `header`, and `maincontent` as provisional region hints; `nav` is separately a provisional purpose hint, never a region. Its results prove loading/inference only, and are not comparable to the upstream benchmark or suitable as labels, metrics, or a Jev replacement.

`microsoft/markuplm-base` is the recommended DOM fine-tuning candidate after reviewed labels exist: it consumes text plus XPath, but has no compatible region/function/type/purpose output head. Its Hub card/metadata license must be verified before any use; do not infer weight terms from surrounding code or papers. Add separate heads for the labeler taxonomies and train/evaluate only on reviewed human labels with domain-held-out splits. Do not present MarkupLM as a zero-shot role classifier.

The runner reconstructs bounded input from the title plus visible leaf-node snippets. Capture node text is individually truncated, so root/body text alone is usually early chrome. This reconstruction may omit or reorder content and is an experiment limitation. It writes no page text, URL, selectors, screenshots, or DOM nodes into results; it preserves only capture ID, content hash, input hash/length, model metadata, and rankings. Softmax values are uncalibrated rankings, not probabilities of correctness. Output creation is exclusive, protecting existing private results.

## Run

Create an environment and cache outside Git. This keeps both packages and model weights out of the worktree.

```sh
python3 -m venv $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv/bin/pip install -r experiments/dom-classifier/base-model/requirements.txt

$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv/bin/python experiments/dom-classifier/base-model/weborganizer_inference.py \
  --private-root $DOM_CLASSIFIER_DATA_ROOT/2026-09-18 \
  --captures $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/human-ui-v1/captures \
  --cache-dir $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/hf-cache \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model/weborganizer-smoke.jsonl \
  --limit 3
```

The checkpoint requires `trust_remote_code=True`; the revision pin prevents an unreviewed later revision from being fetched, but model code still runs locally. The runner disables the card's optional xformers path for Mac compatibility. No downloads above 2 GB are performed.

Run the diagnostic component smoke separately (it uses the ordinary pinned RoBERTa tokenizer because the component checkpoint contains no tokenizer files):

```sh
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv/bin/python experiments/dom-classifier/base-model/webclasseg_component_inference.py \
  --private-root $DOM_CLASSIFIER_DATA_ROOT/2026-09-18 \
  --captures $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/human-ui-v1/captures \
  --cache-dir $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/hf-cache \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model/webclasseg-component-smoke.jsonl \
  --limit 25
```

Check the checkpoint once with exact public upstream `path_class` rows. This is only a loading/serializer smoke, never an accuracy result:

```sh
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model-venv/bin/python experiments/dom-classifier/base-model/webclasseg_external_contract_smoke.py \
  --private-root $DOM_CLASSIFIER_DATA_ROOT/2026-09-18 \
  --cache-dir $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/hf-cache \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/base-model/webclasseg-external-contract-smoke.jsonl
```

## Sources checked 2026-09-19

- [WebOrganizer model card](https://huggingface.co/WebOrganizer/FormatClassifier-NoURL) for its input format, 24 labels, 140M parameter claim, and custom-code loading instructions.
- [Pinned WebOrganizer config](https://huggingface.co/WebOrganizer/FormatClassifier-NoURL/blob/74d5efb924e1843e84b28b59c26f6ceaa873dc16/config.json) for labels and the fixed revision.
- [Pinned WebClasSeg FC checkpoint config](https://huggingface.co/gerbejon/roberta-html-nodes-fc-classifier-v2/blob/8b5710fb9a2c9ad479aebfc338c47f581882131a/config.json) for its eight classes and fixed revision; [benchmark repository](https://github.com/gerbejon/WebClasSeg25-segmentation-benchmark) for its task serialization.
- [MarkupLM model card](https://huggingface.co/microsoft/markuplm-base) and [Transformers MarkupLM documentation](https://huggingface.co/docs/transformers/model_doc/markuplm) for the later XPath-aware fine-tuning path.
