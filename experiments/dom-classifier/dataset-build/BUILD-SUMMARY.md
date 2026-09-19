# 2026-09-19 private frozen build summary

The private `dom-role-text-dataset-v1` build contains 187 captured pages from
186 eTLD+1 groups. Splits were frozen before labels: 131 train pages, 28
validation pages, and 28 test pages. Six known old-v2 registrable-domain
overlap groups (eight current captures) were forced into train.

It exports 1,305 weak Jev node records and 131 weak Jev page records for train.
The current source has three effective human node observations; all happen to
fall in held-out partitions, so the training human file has zero rows. Those
three are retained as observed human silver and are excluded from evaluation
claims. There are no human gold evaluation records.

The validation and test queues have 304 and 305 items respectively. They do
not contain teacher answers. No exact serialized node input crossed splits in
this frozen build; the quarantine file is still emitted and empty. The manifest
contains hashes for every emitted data file and records the source snapshot
hash, split policy, serializer versions, provenance policy, and counts.
