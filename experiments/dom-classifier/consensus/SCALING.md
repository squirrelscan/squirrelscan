# Corpus scaling inventory

This is a read-only inventory of the retained Product Hunt capture packet and
the frozen text/DOM split. It contains aggregate counts only; no URLs, domains,
page text, or personal data are reproduced.

Reproduce the aggregate counts with `inventory_scaling.py --captures <private
capture-dir> --splits <private split-assignments.jsonl>`. The command emits only
counts; its useful-node filter excludes empty text and decorative/SVG-like tags
(`rect`, `circle`, `g`, `font`, `svg`, `path`, `canvas`, `style`, `script`).

## Current evidence

The private capture packet has 187 pages and 78,896 retained DOM nodes. The
frozen split is 131 train, 28 validation, and 28 test pages. Node counts are
54,283 train, 14,063 validation, and 10,550 test. The current Jev export has
2,048 unique page/node targets; it is a teacher signal, not human approval.

The train partition alone has 42,863 non-empty nodes, about 42,715 after
removing decorative/SVG-like tags, 32,670 distinct `(tag,text)` signatures,
and 18,145 `div`/`section` nodes (14,673 after that useful-node filter).
After the useful-node filter, 50/100/200-node page caps yield 6,451/12,366/
22,384 train candidates respectively (raw-node upper bounds are 6,462/12,585/
22,988). The cap counts are pool upper bounds, not human-approved examples.
The 56 held-out pages contain 24,613 nodes, of which 19,555 are non-empty and
18,134 pass the same useful-node filter. These figures make clear that the
45k-scale all-corpus proxy is mostly train-pool capacity; it must not be combined with
held-out nodes for training.

There are no duplicate page content hashes or capture hashes in the 187-page
packet. Node-level repetition is substantial: 62,418 nodes have non-empty text;
45,676 distinct `(tag,text)` signatures remain, and 54,077 distinct structural
signatures remain after including tag, role, depth, and bounded text. These are
rough signature proxies, not template or semantic deduplication. The broad
packet contains 23,449 `div` nodes, 15,248 `span` nodes, 6,685 anchors, 5,712
paragraphs, 3,993 list items, 2,075 images, 1,623 buttons, and 1,108 sections.
There are 24,557 `div` or `section` nodes and 833 nodes with an explicit ARIA
role. Empty text occurs in 16,478 nodes (20.9%), so raw node count materially
overstates useful text/DOM examples.

The 186 private site/group IDs have at most two pages each. The largest group
contributes 3,396 retained nodes; the 95th percentile group contributes about
947 nodes. Splitting by site/group is therefore feasible, but sampling every
node would overrepresent a few large pages and repeated layout structures.

## What 50k means

The existing packet has enough raw nodes to form a 50k candidate pool, but not
50k independent semantic examples. A useful pool should deduplicate or cap
near-identical text/structure, remove empty and purely decorative SVG-like
nodes, cap nodes per page and site, and retain DOM context for review. The
45,246 useful non-empty `(tag,text)` signatures are a practical upper bound for
near-duplicate-filtered candidates before stronger semantic deduplication;
50k should therefore be treated as a pool target that requires more captures,
not as a guaranteed annotation target from this packet alone.

Do not inflate coverage by counting every axis on one example as a separate
example. A single reviewed candidate may carry a component type, region,
purpose, and state, but it remains one candidate and one human decision.

## Staged expansion

Use learning curves and site-held-out evaluation to decide whether expansion is
worth the cost:

| stage | candidate pool | suggested site cap | human approval budget | use |
| --- | ---: | ---: | ---: | --- |
| pilot | 5,000 | up to 50 per site, requiring at least 100 sites | 500–750 candidates | validate extraction, taxonomy coverage, and adjudication cost |
| medium | 20,000 | up to 100 per site, requiring at least 200 sites | 2,000–3,000 candidates | fit the compact model and measure domain-held-out learning curves |
| large | 50,000 | 250 per site | 5,000–7,500 candidates | only if the medium curve still improves and human review capacity exists |

Model-generated labels may cover the remaining pool as provisional teacher
targets, but they must stay separate from human-approved data and retain model,
prompt, input hash, and axis-completeness provenance. Human approval should be
sampled across sites and axes, with a blind validation/test queue held out from
teacher prompting, threshold selection, and active-learning selection.

For every stage, split by registrable site/group before sampling. Keep all
pages from a site in one partition, cap per-site and per-page contributions,
and report counts for unique sites, pages, candidates, and reviewed axes
separately. The current 131-site train split yields 6,451 useful candidates
under a 50-node-per-page cap and 12,366 under a 100-node cap; these are
measured pool upper bounds, not approved examples. A 5k pilot is
capacity-feasible; a 20k pool requires additional sites/pages or a higher
per-site policy; 50k needs
new captures or a deliberately broader candidate policy and should be justified
by the learning curve rather than a preset quota.

In the current frozen train partition, each of the 131 groups contributes one
page; this supports a site-heldout pilot but does not provide repeated
within-site template coverage. At 100 or 200 candidates per page, the train
pool remains below 23k, so reaching a 50k candidate pool needs additional
pages/sites or a broader candidate policy.
