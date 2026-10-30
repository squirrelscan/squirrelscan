# @squirrelscan/page-classifier

Names the parts of a parsed page: the region of each DOM node, the page type, and the purpose of each section. One featurizer feeds up to three gradient-boosted heads held in one artifact. A deterministic markup path answers whenever the model cannot.

## Use

```ts
import { classifyDocument, elementPlacer, tryLoadModel } from "@squirrelscan/page-classifier";

const { model } = tryLoadModel(JSON.parse(artifactJson)); // null on any problem, never throws

const elements: unknown[] = [];
const result = classifyDocument(document, url, { model, elementsOut: elements });
const place = elementPlacer(result, elements);
place(anchor); // { region: {...} | null, section: {...} | null }
```

`classifyPage(html, url, opts)` parses for you. `classifyDocument` takes a document you already hold.

A result:

```ts
{
  pageType: { label, confidence, source: "model" | "rules" },
  nodes: [{ nodeRef: { nodeId, tag, elementId }, label, confidence, source, section? }],
  degraded: string,           // "" when nothing fell back
  platform: string | null,    // the platform bucket the thresholds were chosen for
  commentSections: [...],     // the page's comment threads, outermost, in document order
}
```

Options (all optional): `model`, `budgetMs` (per page, default 500), `scoringBatch`, `siteFeatures`, `html`, `platform`, `elementsOut`, `timingsOut`.

## Three heads

- **region**: site_header, footer, navigation, sidebar, main_content, content_block, article_chrome, form, search, dialog. Nodes the strict thresholds leave unknown can come back `site_chrome` when the four furniture classes together are sure.
- **page type**: homepage, product_detail, product_listing, article, blog_post, about, contact, docs, legal, pricing, listing_index, other. `homepage` is a URL rule: a page whose path is `/`, or the single-segment root document `/index.html`, gets it from the rules at confidence 1, unless its own structured data names another type. The head also has a `homepage` class, but it is never emitted for any other path. There the answer is the head's best other class when that class clears its own threshold (its probability as the head gave it, not renormalised), else the rules answer, whose `confidence` is that best other class's probability.
- **section purpose**: faq_block, reviews, breadcrumbs, business_info, product_offer, author_byline, video_embed, ad, cookie_consent, newsletter_signup, social_share, related_content, comments, promo_banner, pagination, table_of_contents, account_login, locale_switcher. `section` is present on a node only when the class clears its threshold.

## Precedence: markup wins, the model fills the silence

A node with its own landmark tag or ARIA role is answered by the rules at confidence 1, and the model is not asked about it. The model answers nodes whose markup says nothing. Comment threads are read from markup by a deterministic rule on every page, with or without a model, and win over the section head.

`source` is provenance, not quality: display it, never branch on it. `confidence` is the model's probability for `model` and 1 (or 0 for `unknown`) for `rules`, except a page type the model did not stand behind: that is the rules answer carrying the model's probability for its best admissible class. `unknown` is a real answer meaning no evidence.

## Thresholds

Every head carries one threshold per class, chosen for precision on held-out pages. A class that cannot hold the bar gets a threshold above 1 and abstains. A below-threshold region or section answer comes back `label: "unknown"`, `source: "model"`, with `rawLabel` and `rawConfidence` for debugging only: never show them. A below-threshold page type is the rules answer.

A head may also carry per-platform overrides (`platformClassThresholds`), applied from the platform the page's HTML fingerprints as.

## When the rules path runs

`degraded` names the reason.

| condition | `degraded` |
|---|---|
| no artifact passed | `no model artifact` |
| artifact unparseable, wrong format, or a future `artifactVersion` | the parse error |
| artifact built for another featurizer version | `artifact built for featurizer X, this build is Y` |
| token-bucket count or node-feature width disagrees with this build | which one |
| per-page time budget spent | `time budget Nms exceeded` |

The first four are page-wide. The budget is checked every 32 nodes and hands the rest of the page to the rules. One node under its threshold does not degrade the page.

## Versioning

The artifact records `featurizerVersion`, `nodeFeatureCount`, `pageFeatureCount` and `tokenBuckets`, and `classifyDocument` refuses a mismatched artifact. `FEATURIZER_VERSION` must change whenever the feature list, vocabulary, hash or candidate rule changes.

Since v2.3.0 the featurizer emits two node token streams in the same hash buckets: the class and id stream (`tokens`) and an own-text, attribute and anchor-host stream (`textTokens`). A head declares which it reads with `tokenStreams` (`["classid"]` when absent, `["classid", "text"]` for the section head), so a head never silently receives input it was not trained on. A page-type head cannot declare `text`.

## The bundled artifact

The weights are `treetop-pagetype-v1`, MIT licensed like the rest of this repository. They are the file `assets/classifier-v2.json`.

See [MODEL.md](./MODEL.md) for what the heads are, what they read, the precision per class and the known limitations.

`assets/classifier-v2.json` is weights and thresholds. It holds no vocabulary: tokens are hashed into buckets before scoring, so the only strings in it are the format name, the featurizer version and class names. `assets/classifier-v2.manifest.json` records its sha256, size and featurizer version. `tests/artifact-contents.test.ts` fails if any other string appears.

## Cost

Featurize plus predict is tens of milliseconds per page at p95 on a quiet machine, close to linear in candidate nodes (capped at 400 per page).
