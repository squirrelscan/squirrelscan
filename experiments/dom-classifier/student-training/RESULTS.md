# Sparse student v1 results

The frozen full Jev-v3 overlay achieved 7/10 complete component-type matches on
the approved independent Luna test smoke set, compared with 6/10 for the base
student and 10/10 for the semantic HTML-tag baseline. Validation was 17/17 for
both students and 17/17 for the baseline. This is a small silver smoke set, not
human ground truth or a general-accuracy estimate. It does not demonstrate that
the learned student improves on direct semantic DOM evidence.

The semantic baseline is a fixed, general tag mapping over the serializer's tag
token: for example, paragraphs map to `text`, articles to `article`, asides and
sections to `content_section`, and main to `layout_container`. It also maps
links, buttons, headings, form controls, media, lists, navigation, headers, and
footers to their corresponding component types. It is an updated post-hoc
comparator only; neither frozen student was retrained or changed.

The test split was declared after both artifacts and the fixed configuration were
frozen. The base artifact SHA-256 is
`a242f578eaa88f5fc0baedb2cf51ca689ca805b305007ca814b81c80940bd17a`; the
full-v3 overlay SHA-256 is
`4840cdec4dc3bcf80c6e21767be5925449e0d4e678f27f2442b07af40fe00251`. The
evaluation verifies model, label-file, and manifest hashes before it writes a
result. No test result changed either artifact.

The one changed student outcome was an `aside` nested eight DOM levels deep with
a 143-character bounded text field. The base predicted `layout_container`; the
full-v3 overlay predicted the independently reviewed `content_section`. The
overlay's remaining component misses were two paragraph nodes (24 and 95
characters, reviewed as `text` but predicted as `link`) and a root `main` node
(reviewed as `layout_container` but predicted as `content_section`). These are
bounded DOM/text-shape descriptions, not source content or site identifiers.

No multilabel axis was judged complete. Both students recalled 6 of 9 reviewed
purpose claims and 6 of 7 reviewed region claims on validation; the frozen test
recall was 3 of 4 purposes and 5 of 7 regions. Those are positive-only claims:
they do not measure precision, negatives, or exact-set accuracy. Purpose
semantics and rare classes remain particularly uncertain.

The model uses word and character TF-IDF over the supplied text/DOM serializers
only. Its fixed heads cover 33 component types, 10 regions, 17 purposes, 68 page
types, and 14 content kinds. Same-source Jev validation is only a distillation
diagnostic: component top-1 agreement was 81.2% for the base and 80.4% for the
overlay, with rounded mean absolute probability errors of 0.070 regions, 0.090
purposes, 0.073 page types, and 0.123 content kinds.

On the local development machine, a fresh full-v3 fit took 15.14 seconds. Its
private joblib artifact is 79,708,631 bytes, and a warmed 304-row validation
pass took 1.42 seconds (about 214 rows per second). These are one-machine
observations for a small corpus, not a benchmark. Private artifacts and result
JSON live under `$DOM_CLASSIFIER_DATA_ROOT/2026-09-19/`.
