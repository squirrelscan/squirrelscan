# Diverse synthetic DOM experiment

This is an offline classifier experiment, not a production finding-grouping
dependency. It keeps original captures, synthetic suggestions, human decisions,
and model predictions separate. Product Hunt captures and report data remain in
their existing corpus; this experiment has a separate cloud-site cohort.

The September 19 run selects 500 fresh inner pages from 196 registrable domains.
Its source inventory contains 405 public website targets from cloud runs. Links
are discovered from fetched HTML, not guessed from common route names. URL
family hints balance acquisition; they are never training labels. The sample
does not represent every inventoried site or every language and page type.

## Labels

`../taxonomy.json` is the canonical `dom-taxonomy-v2` vocabulary. Independent
axes describe page regions, component types, purposes, page types, and content
kinds. A footer may have a navigation purpose. An article body is a region;
news article is a page type. Media elements and advertising have distinct
labels, and first-party product promotion is not automatically advertising.

Jev v4 labels one page and six selected DOM elements per capture. The original
probabilities and capture/request identities are retained. Training uses Jev
soft targets only. Independent Luna reviews every held-out page plus three
elements, and a deterministic sample of 50 training pages plus three elements.
Luna receives sanitized text and DOM ancestry without Jev answers. A teacher
disagreement is evidence to review, not an automatic correction or gold label.

## Reproduction

All raw pages, labels, prompts, model weights and credentials belong outside
this public repository. The following utilities operate on supplied private
artifacts:

1. `acquisition/discover.py`: collect observed same-site hyperlinks from the
   sanitized cloud-site seed inventory.
2. `prepare-queue.py`: deterministic bounded, domain-diverse acquisition queue.
3. `../corpus-queue/render-queue.ts`: fresh dated browser captures. This run uses
   the isolated Node 24 runtime and installed Chrome; screenshots support the
   review interface but are never model inputs.
4. `quality.ts`: select 500 immutable capture pairs, rejecting empty, blocked
   or broken pages and retaining source membership in `manifest.jsonl`.
5. `../consensus/freeze_diverse_manifest.py`: freeze domain/exact-content groups
   into train, validation and test before labels are used. Empty landmark text
   does not connect unrelated sites. Shape similarity alone does not establish
   duplicate content or shared source components.
6. `../model-suggestions/generate-jev.ts`: bounded private Jev sidecars, with
   server-side credentials and six candidates per page.
7. `../consensus/materialize_diverse.py`: validate frozen identities, request
   hashes and vocabulary; emit separate hash-bound training and held-out files
   and blind review packets. Pages require at least three meaningful node
   labels; coverage failures are reported rather than silently dropped.
8. `../consensus/luna_batch.py`: real Luna inference, strict all-or-nothing
   response validation, private raw response provenance, resumable accepted
   records. Disjoint shards can run independently and must be joined by exact
   packet identities before evaluation.
9. `../student-training/train_diverse.py` and
   `../pretrained-student/frozen_encoder.py`: fit the sparse student and a
   pretrained RoBERTa encoder with trained classification layers. The latter
   leaves encoder weights unchanged, uses masked mean pooling at 192 tokens,
   and learns logistic heads from train-only soft labels. Full encoder
   fine-tuning code remains in `../pretrained-student/trainer.py`; its local
   three-epoch experiment was stopped before completing an epoch because of
   runtime cost. It is not a completed model or benchmark result.
10. `../student-training/predict_diverse.py` and `frozen_encoder.py --predict`
    write predictions without seeing Luna labels. `compare_diverse.py` compares
    those files against Luna, Jev, the previous student and the existing
    semantic-tag baseline. `../consensus/merge_luna_shards.py` validates complete
    packet membership and restores the frozen split to accepted review records.

Use isolated taskmux tasks for long jobs. Do not alter other crawl processes,
their configuration, or cleanup behavior. The local orchestration helper has
machine-specific paths; invoke the individual CLIs with your own private paths
on another machine. Each CLI exposes its arguments with `--help` where supported.

## Interpretation

Report complete-axis exact match, micro/macro F1, per-label support, and separate
positive-only recall for incomplete axes. Synthetic agreement is not human
accuracy. Evaluate prior-model comparisons both on the complete held-out set
and after excluding sites present in that model's training corpus. Report
unsupported rare classes rather than hiding them in aggregate accuracy.

The frozen-encoder comparator was added after the initial sparse comparison,
in response to local fine-tuning runtime. Its fitting does not read test labels,
but the overall comparison is exploratory, not an untouched confirmatory
model-selection test.

The first parent sanity sample found empty embedded frames and text containing
CSS or structured data. These are recorded input limitations. The fixed model
also truncates long text and uses an English pretrained encoder on multilingual
pages. This trial measures those limitations; it does not establish readiness
for scanner integration or replace the conservative DOM evidence required for
finding identity.
