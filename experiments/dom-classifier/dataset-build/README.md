# Frozen text/DOM dataset build

This builds a new immutable private dataset after the existing reviewed-label
exporter has copied the active label store. It uses no screenshots, network
calls, live labeler state, or model calls.

The exporter must run first, with an explicit eTLD+1 grouping file if `tldts`
is not resolvable from the experiment package. Then run:

```sh
python3 experiments/dom-classifier/dataset-build/build.py \
  --snapshot /private/reviewed-label-snapshot \
  --output /private/new-frozen-dataset \
  --v2-root /private/v2 \
  --grouping-input /private/eTLD-plus-one-groups.json \
  --experiment-root /path/to/experiments/dom-classifier
```

Splits are frozen from capture eTLD+1 and exact content hashes before annotation
or Jev labels are read. Existing v2 registrable-domain matches are forced to
train, so validation and test are pristine with respect to that known overlap.
This is not a guarantee that independently hosted pages use different inferred
templates.

`node-train-weak.jsonl` is Jev soft supervision and `node-train-human.jsonl`
contains only current human observations, always with `gold: false`. They must
not be concatenated: the manifest records the per-axis human-over-weak join
contract. Missing axes are unknown rather than negative.

Validation and test have review queues with text/DOM input only and deliberately
omit teacher outputs. Their diagnostic files retain Jev outputs but are not
human evaluation gold. No completed gold test set is claimed.
