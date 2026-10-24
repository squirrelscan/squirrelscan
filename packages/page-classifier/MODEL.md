# The bundled model

The weights are `treetop-pagetype-v1`, MIT licensed like the rest of this repository. They are the file `assets/classifier-v2.json`.

`assets/classifier-v2.json` holds three gradient-boosted tree heads that read the same per-node feature vector: a region head (10 classes: header, footer, navigation, sidebar, main content, content block, article chrome, form, search, dialog), a page type head (12 classes) and a section purpose head (17 classes, `none` included). It is weights, class names and per-class confidence thresholds. It holds no vocabulary and no page text: words and attributes are hashed into 512 buckets before scoring, and `tests/artifact-contents.test.ts` fails if any other string appears.

## What it reads

Each candidate node (at most 400 per page) is described by numbers and hashed tokens, never by geometry or a rendered page.

| Category | Examples |
| --- | --- |
| Structure | depth, position among siblings, subtree size, text share, distance to the enclosing section |
| Links and media | counts and shares of links (internal, external, social, contact), headings, lists, images, forms, inputs, tables |
| Text cues | yes or no flags for copyright, price, date, byline, consent, pagination and breadcrumb wording |
| Markup hints | tag, role, parent tag, about 65 curated class and id words for the node and its parent, hashed class and id tokens; landmark tags and roles (masked in part during training so the model also learns from structure) |
| Text and attributes (section head) | the first few words of the node's own text and subtree, anchor `rel` values, anchor hosts |
| Page | URL shape, document shape, landmark counts, page-level cue counts, and an optional block of cross-page link counts when the caller has the site's link graph |

Nothing derived from JSON-LD, microdata or `og:type` is a feature.

## How answers are chosen

Every class has its own threshold, picked on held-out pages so that precision holds. A class that could not hold the bar abstains (its threshold is above 1) and never answers. A region or page type answer below its threshold falls back to what the page's markup says. The region head is asked only about nodes whose own markup says nothing; the section head scores every candidate node, a declared landmark included.

## Section purpose precision

Measured on pages from domains the model had never seen, with every fire at or above the class's threshold, judged by a language model against the node's markup and text. "Pooled" joins three samples; "fresh" is the newest one alone. The interval is the lower bound of a 95% Wilson interval.

| Class | Threshold | Pooled precision | Fresh precision |
| --- | --- | --- | --- |
| account_login | 0.77 | .96 (.91) | .98 (.91) |
| author_byline | 0.90 | .90 (.87) | .93 (.85) |
| breadcrumbs | 0.85 | .94 (.91) | .94 (.88) |
| business_info | 0.89 | .94 (.91) | 1.00 (.96) |
| newsletter_signup | 0.73 | .88 (.83) | .83 (.73) |
| pagination | 0.80 | .96 (.93) | .96 (.88) |
| related_content | 0.78 | .92 (.88) | .93 (.86) |
| social_share | 0.85 | .94 (.90) | .87 (.76) |

The other classes abstain (`ad`, `comments`, `cookie_consent`, `locale_switcher`, `product_offer`, `promo_banner`, `reviews`, `video_embed`), and `none` is never reported. The `comments` class is one of them: comment threads come from a markup rule, never from the model.

## Known limitations

- On a single article, the previous and next post links can read as pagination, and so can slider dots.
- A "follow us" row of profile icons can read as social sharing links. `share` in a class name is reliable; a bare `social` is not.
- The head sometimes names a wrapper around the real section, not the section itself.
- Recall is low for the rarer classes, roughly 0.2 to 0.5. No answer does not mean the section is absent.
- Its text cues cover English and four other European languages. Unusual markup, outside the conventions of common themes and frameworks, gets fewer answers.
