# Local DOM-role training and evaluation

This is an offline research baseline for complete extracted DOM candidates. It does
not segment pages and is not wired into SquirrelScan production scoring, groups, or
reports. All input data, models, manifests, and result files remain under
`$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/`; do not add them to
Git.

It measures agreement with model-generated **silver** labels only. Every Luna label
must state `gold: false`; no output claims human accuracy or gold-label quality.

## Final corpus gate

Training is deliberately impossible on the earlier `v1`/pilot packets. Pass every
path explicitly, including a corpus version that exactly equals the final manifest:

```sh
cd experiments/dom-classifier
python3 -m venv $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/.venv
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/.venv/bin/pip install -r requirements.txt

$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/.venv/bin/python train.py \
  --manifest $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/manifest.json \
  --split-groups $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/split-groups.jsonl \
  --corpus-version dom-regions-v2 --annotation-version dom-role-v2 \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/training \
  --freeze-splits-only
```

This first command reads only `manifest.json` and `split-groups.jsonl`; it does not
open candidates, annotation shards, adjudications, or QA outcomes. It deterministically
allocates complete connected groups by group size toward 70/15/15 and writes a
reviewable `training/split-manifest.json`. If a previously frozen manifest must be
corrected, archive it first and pass `--split-correction-reason` (and, when applicable,
`--correction-after-labeling-started`) so the new manifest records both the reason and
the inputs that were deliberately not consulted.

After all three Luna shards are complete and blind-duplicate conflicts have been
adjudicated, aggregate the final annotations. This command writes only private files;
it exits nonzero while any disagreement or context conflict remains unresolved.

```sh
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/.venv/bin/python aggregate_labels.py \
  --input $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/luna-01.jsonl \
  --input $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/luna-02.jsonl \
  --input $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/luna-03.jsonl \
  --adjudications $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/adjudications.jsonl \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/annotations.jsonl \
  --qa-output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/qa-summary.json \
  --conflicts-output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/conflicts.jsonl \
  --corpus-version dom-regions-v2 --annotation-version dom-role-v2 \
  --expected-blind-duplicates 75
```

The conflict file retains the original packet IDs, contexts, and reasons. Every
adjudication needs a taxonomy label, an explicit `adjudicated` or `resolved` status,
a non-empty structured resolution context, a reason, and adjudicator provenance. The
QA summary reports actual pairwise label, context, and joint agreement across all blind
review pairs.

Once that command reports `status: "passed"`, fit with the frozen group allocation:

```sh
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/.venv/bin/python train.py \
  --manifest $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/manifest.json \
  --candidates $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/candidates.jsonl \
  --labels $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/annotations.jsonl \
  --qa $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/labels/qa-summary.json \
  --split-groups $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/split-groups.jsonl \
  --corpus-version dom-regions-v2 --annotation-version dom-role-v2 \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/training
```

Training loads that existing `split-manifest.json`, checks every candidate and connected
group assignment against the supplied group manifest and seed, and rejects a mismatch.
It never rewrites the frozen file, so any correction record remains byte-for-byte intact.

The required corpus contract is:

* `manifest.json` has matching `corpusVersion` and `annotationVersion` (or
  `annotationVersionExpected` before the Luna handoff), and no pilot/v1 version name.
* `candidates.jsonl` contains the final extracted candidate objects. The trainer uses
  only structural `node` fields: tags, ARIA roles, context, DOM counts, and link
  categories. It does not use snippets, identifiers, domains, URLs, labels, prompts,
  source, or annotator metadata as features.
* `split-groups.jsonl` has a row per candidate with `candidateId`, `siteId`,
  `templateFamilyId`, and `splitGroupId`. The group IDs must already be the connected
  components of registrable-domain and detected-page-template links.
* `annotations.jsonl` has exactly one adjudicated final row per candidate, with
  `candidateId`, `label` (or `finalLabel`), `corpusVersion`, `annotationVersion`, `source: "luna"`,
  `gold: false`, `model`/`modelVersion`, `promptVersion`, and `schemaVersion`.
* `qa-summary.json` has the matching corpus and annotation versions, `status: "passed"`,
  `blindDuplicateCount` of at least 75, and `unresolvedConflicts: 0`. Each recorded
  disagreement must explicitly be `adjudicated` or `resolved`. A disagreement is
  never accepted merely because another Luna run produced a label.

The trainer rejects domain/template leakage, exact candidate duplicates across groups,
and a training partition with fewer than two observed classes. It does allow a rare
taxonomy class to be absent from training, validation, or test: `partitionSupport`
records each partition's class counts and classes unseen in training. Calibration then
uses only validation records whose labels were observed in training, while all records
remain in the reported evaluation metrics.

## What is evaluated

The vocabulary is fitted on train candidates only. Model family and parameters are
selected by validation macro-F1; temperature calibration and the confidence threshold
for `unknown` abstention are selected on validation only. The held-out test partition
is untouched until the final report. The trainer evaluates a linear logistic baseline
and a small ExtraTrees ensemble, alongside a direct semantic DOM heuristic that returns
`unknown` whenever it lacks evidence.

`metrics.json` includes support, balanced accuracy, all-10-class macro-F1, observed-class
macro-F1 (including explicit `test.observedTestMacroF1`), per-class precision and
recall, confusion matrices, forced versus abstaining predictions, confidence/entropy,
latency, and model size. `public-summary.json` is safe to inspect or share because it
has only aggregate metrics: no page snippets, domains, URLs, candidate IDs, or prompts.
The model and all other artifacts stay private.

## v2 interpretation limits

This experiment classifies fixed DOM region containers. It does not evaluate paragraph,
link, or arbitrary-element candidates. The corpus has 49 registrable domains, but its
48 template families are a coarse count-based proxy: held-out results are domain-held-out
with heuristic template grouping, not a robust template-holdout claim. The deduplication
fingerprint includes copied context/path information and is therefore not a pure
structural deduplication guarantee.

The v2 sample is an unstratified one-page-per-domain selection; six selected pages had
no eligible candidate. Its labels are Luna silver labels, not human gold labels. The
final duplicate-review QA showed 69.3% pairwise label agreement, so these results measure
agreement with the adjudicated silver corpus only. This remains an offline experiment
with no production integration.

Held-out support is also too small for automatic merging decisions: `unknown` recall
was 1/5, `aside` recall was 0/1, and there were no held-out `form` or `consent_banner`
examples (only one consent-banner training example). Production identity must continue
to require direct DOM evidence.

To score complete candidates after training:

```sh
$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/.venv/bin/python inference.py \
  --model $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/training/model.joblib \
  --input $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/candidates.jsonl \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/training/predictions.jsonl
```
