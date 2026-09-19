# Dataset inventory (2026-09-19)

This is an aggregate, public-safe inventory for the text/DOM-only experiment.
Raw captures, URLs, source rows, labels, and content hashes remain under the
private capture store and are not copied here.

## Existing v2 silver corpus

Source: private `dom-classifier-data/2026-09-18/v2/` (`dom-regions-v2`,
`dom-role-v2`). The frozen selection has 55 pages from 55 sites and 55
selected registrable-domain rows, with one page per selected domain. Six
selected pages have no eligible candidate, leaving 49 contributing domains in
the candidate corpus. There are 480 candidate records, 48 split/template
groups, and 375 annotated candidates.
The 375 labels are Luna silver (`gold=false`), not human gold. No Jev/model
call was made for this inventory.

Candidate axes (480 records):

| axis | counts |
| --- | --- |
| DOM tags | `div` 178, `nav` 65, `article` 52, `main` 39, `footer` 36, `header` 36, `ul` 27, `section` 17, `aside` 7, `details` 6, `form` 5, `ol` 4, `dialog` 3, `figure` 3, `table` 2 |
| context | `main` 138, `footer` 115, `site` 82, `article` 73, `header` 72 |
| source capture mode | `source` 55 pages |

Silver label counts (375): `main_content` 95, `navigation` 69, `footer` 65,
`unknown` 40, `site_header` 32, `card` 31, `form` 16,
`article_header` 13, `aside` 9, `consent_banner` 5. All ten taxonomy classes
are represented in the 375-row annotation export, but the independently held
out 55-record test partition has no `form` or `consent_banner` examples.

The prior split is deterministic and label-blind: 258 train, 62 validation,
55 test. It is grouped by the existing 48 split/template groups. The v2
manifest reports 49 contributing registrable domains and six selected pages
with no eligible candidate; use the explicit page/site exclusion set in the
private metadata when constructing a new split.

## Human/provisional status

The current private UI capture set has 187 JSON capture metadata records (all
`training-review`), each with a unique content/capture hash. The corresponding
human annotation log contains only 8 annotation events over 2 pages and 4
nodes; all are `source=human` but all are explicitly `gold=false` (5 labels,
3 accepts; roles: `site_header` 5, `main_content` 2, `aside` 1). Treat these as
provisional review signals, not a held-out human test set. A separate private
Jev suggestion export covers 2,048 provisional page/node targets across all
187 pages (187 captures), using `typesafe/jev-1.13.0` and
`dom-suggestions-v2`. Targets are keyed by `(pageId, nodeId, captureHash)`;
the global `nodeId` value is not a cross-page identity.

## Split and held-out recommendations

For a small balanced human-heldout review queue, choose whole registrable
domains before looking at labels, then freeze the site/template group list.
Use 10–20 unseen domains for review, with at most one page per domain initially;
stratify the *queue target* across the ten roles only after selection, and mark
unavailable roles as coverage gaps rather than duplicating pages. Keep all
pages from a registrable domain and linked template family in one partition.
Do not claim template isolation from the existing 48-family proxy: it is a
coarse structural grouping, not a verified cross-site template identity
oracle.

Overlap with the older 375 silver corpus can be excluded reliably by the
private page/site/candidate group metadata and exact content-hash index. A
cross-corpus overlap check against any corpus whose raw URL/content manifest
was not retained is not recoverable; in that case document the missing
provenance and do not claim the new test is pristine.

## Private machine-readable metadata

The builder should consume the private, hashed-only exclusion/group artifact
at:

`$DOM_CLASSIFIER_DATA_ROOT/2026-09-18/prior-sites.json`

It records the exact six OLD375/current registrable-domain overlaps and
aggregate teacher coverage. Both sets use default `tldts.getDomain`
(`allowPrivateDomains=false`); a builder using private-suffix mode must retain
the listed parent-platform exclusions conservatively. The full hashed v2 page/site/candidate exclusion
group files remain at the private v2 paths listed above. Do not check private
files into the public repository or print source rows while debugging.

## Frozen text/DOM draft coverage

The private draft `dom-role-text-v1/frozen-text-dom-v1/manifest.json` is still
pending human review and is positive-only (`gold=false`). It contains 187 pages
across 186 groups, with 131 train, 28 validation, and 28 test pages. Training
has 1,305 weak node rows and 131 weak page rows from Jev; there are zero human
training rows, zero evaluation gold rows, 304 validation-pending rows, 305
test-pending rows, and only 3 held-out observed human-silver rows. These
pending/diagnostic rows must not be reported as balanced evaluation coverage.

Among the 1,305 weak node positives, region observations are footer 201,
main_content 139, site_header 82, sidebar 43, and article_header 3. There are
no explicit positive region labels for hero, banner, or modal. This may reflect
the older Jev prompt's region taxonomy rather than page absence; those appear
only as component types in tiny counts: hero 1, banner 2, and dialog 11.
Component positives include link 297, button 163, navigation_menu 137,
article 111, form 46, heading 28, image 23, and smaller list/select/input/
dialog/text/media/tabs/banner/radio/hero classes. Purpose positives include
navigation 428, share 101, toggle 83, download 33, account 29, submit 23,
search 23, consent 21, filter 20, and dismiss 4. Since omitted axes mean
unobserved rather than negative, these are coverage counts only; they cannot
support ordinary negative-label training or claims that hero/banner/modal are
absent from the pages.
