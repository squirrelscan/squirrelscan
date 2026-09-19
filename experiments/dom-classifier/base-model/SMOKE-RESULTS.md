# Smoke results — 2026-09-19

All weights, caches, and result JSONL files were kept in the private experiment store. This file contains only aggregate results and immutable public model references.

| Runner | Pinned revision | Input | Result |
| --- | --- | --- | --- |
| `weborganizer_inference.py` | `WebOrganizer/FormatClassifier-NoURL@74d5efb924e1843e84b28b59c26f6ceaa873dc16` | 3 existing private capture JSON files, title plus reconstructed visible leaf text | Completed. All three top classes were `Product Page`, producing weak `product_detail` suggestions. One cached single-capture run took 1.319 s. |
| `webclasseg_component_inference.py` | `gerbejon/roberta-html-nodes-fc-classifier-v2@8b5710fb9a2c9ad479aebfc338c47f581882131a` | 3 existing private capture nodes with tag-only selector approximation | Completed. All three top classes were `multiple`; no region or purpose hint was emitted. One cached single-node run took 0.621 s. These three samples produced no useful component hints; broader quality remains unmeasured. |
| `webclasseg_external_contract_smoke.py` | same checkpoint; `FacebookAI/roberta-base@e2da8e2f811d1448a5b465c236feacd80ffbac7b` tokenizer | 3 public WebClasSeg test rows using their exact `path_class` field | Completed: 0/3 label matches (all three expected `advertisement`, predicted `footer`). This tiny same-class sample is an input-contract smoke, not an accuracy measurement. |

The WebOrganizer weights are 549,556,200 bytes and the WebClasSeg weights are 498,631,280 bytes. Both are below the 2 GB download ceiling. WebOrganizer requires pinned custom code; the WebClasSeg checkpoint carries no tokenizer, so the runner explicitly records the pinned RoBERTa tokenizer.

Timing used CPU and begins after the cached model has loaded and entered evaluation mode; it includes singleton inference and output serialization. It excludes cold weight download and model/tokenizer loading, and is not an averaged performance benchmark.

Neither checkpoint's Hub metadata/model card declared a weight license when checked. The WebClasSeg diagnostic is therefore not a production candidate. No model was trained and no Jev, Luna, or human annotations were read by these runners.

The already-completed external smoke used the live public dataset rows endpoint and its JSONL does not contain raw text; its result is therefore not deterministic enough to reproduce byte-for-byte. The script now records a UTC fetch time, explicit `revisionStatus: unpinned live rows endpoint`, and SHA-256 of every exact `path_class` input. Pin a dataset revision and preserve a private fetched-row sidecar before relying on any later external comparison.

The next trainable baseline is a fresh MIT-card `FacebookAI/roberta-base` plus a new head over a serializer that is built and frozen from runtime DOM fields. It is a provisional engineering choice with clear tokenizer/license evidence, not a demonstrated quality winner. Train and evaluate it only with reviewed human labels and held-out registrable-domain/template groups.
