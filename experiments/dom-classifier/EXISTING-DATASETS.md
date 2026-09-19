# Existing datasets for DOM/page-region labels

Research checked 2026-09-18. This is a read-only source review; no dataset was
downloaded. The target task is semantic region/role classification on DOM nodes,
with rendered layout as evidence. Screenshot-only UI detection datasets are useful
as auxiliary visual data, but are not evidence of shared component identity across
sites.

## Recommended shortlist

### 1. WebClasSeg25 (closest match)

- **Primary release:** [Zenodo WebClasSeg25, current v1.2.0 / record 19183572](https://zenodo.org/records/19183572). The SIGIR paper is linked from the record at DOI `10.1145/3726302.3730309`.
- **HF mirrors/derived splits:** [gerbejon/WebClasSeg25-html](https://huggingface.co/datasets/gerbejon/WebClasSeg25-html), [gerbejon/WebClasSeg25-visual-fc](https://huggingface.co/datasets/gerbejon/WebClasSeg25-visual-fc), plus the linked `html-nodes-fc`, `html-nodes-mc`, `visual-mc`, and balanced node subsets from the HF collection.
- **Data available:** 852 unique pages from 500 domains, 2,580 annotated page/annotator records, 20 languages; 12,568 functional-classification (FC) segments and 8,092 maturity-classification (MC) segments. Zenodo has `annotations.json` (9.1 MB in v1.2.0), `mhtml.zip` (1.5 GB), `screenshots.zip` (1.7 GB), split CSV, and a one-page sample. The HF HTML mirror exposes full `html` strings (681 train rows in the viewer) and the visual mirror exposes screenshot/mask pairs (2,580 rows across splits).
- **DOM linkage:** Zenodo annotations carry `hyuIndex`; the marked MHTML assigns the same `hyu` descriptor to each element, e.g. `<title hyu="6">...`. The HF collection documents page-level keys and node-level FC/MC datasets with parent/node/children classifications. This is direct HTML-node supervision, not only image boxes.
- **HF node split details (API-verified):** The `gerbejon/WebClasSeg25-html-nodes-fc-balanced` derivative currently has 640,442 train rows plus 48,481 test rows, 688,923 FC node rows total. The dataset API revision checked was `fa44ca0ebee4b66b94568643b7b4868ca2baaa45`; node records include `hyu`, XPath, `page_id`, `annotator_id`, DOM tag, parent/child label context, and a node target. The author also publishes FC RoBERTa and LongCoder checkpoints; those are useful baselines, but their model licenses should be checked separately from dataset rights. See the [HF dataset API](https://huggingface.co/api/datasets/gerbejon/WebClasSeg25-html-nodes-fc-balanced).
- **FC taxonomy (exact):** `Title`, `Header`, `Navigation`, `Main content`, `Footer`, `Advertisement`, `Image`.
- **Derived node-model taxonomy:** The published `roberta-html-nodes-fc-classifier-v2` config has eight IDs: `advertisement`, `footer`, `header`, `image`, `maincontent`, `multiple`, `nav`, `title`. `multiple` is a derived node-classifier label; it is not one of the seven original WebClasSeg25 FC annotation labels. There is no `none` class in that verified model config. Keep the seven source labels and the eight derived model labels as separate fields/mappings.
- **MC taxonomy (exact):** `0 Information 1.0`; `1 Information 2.0 (social media/app links)`; `2 Interaction (communication methods)`; `3 Transaction 1.0 (indication)`; `4 Transaction 2.0 (interrupted transaction)`; `5 Transaction 3.0 (uninterrupted transaction)`; `6 Integration 1.0 (indication)`; `7 Integration 2.0`.
- **Annotation protocol:** 3–4 annotators per page; annotators selected the largest visible coherent DOM node, avoided overlap, then manually checked DOM/screenshot alignment. Pages are mainly public-service sites: university, hospital, municipality, court, tourism/other, insurance. Current crawl is from 2024; the release is much newer than Webis-20.
- **License/provenance:** Zenodo API metadata for current v1.2.0 explicitly reports `cc-by-4.0` (the rendered Rights field is blank, but the API is authoritative): [record API](https://zenodo.org/api/records/19183572). The [WebSeg-Curator GitHub repository](https://github.com/JasminSaxer/WebSeg-Curator) is separately MIT as annotation-tool code. CC BY 4.0 is the dataset release license; retain attribution and review third-party page/media terms before redistributing captured content. The published classifier checkpoints have separate model-license metadata and should be audited independently.
- **Use for SquirrelScan:** Best external seed for `header`, `nav`, `main`, `footer`, title and visible utility regions. Do not import MC as the same role taxonomy: it describes digital maturity/function of a segment, not reusable component identity. Map FC labels into the project’s ontology only after a small adjudication sample; retain source label and mapping provenance.

### 2. Webis-WebSeg-20 + Webis-Web-Archive-17

- **Primary release:** [Webis-WebSeg-20](https://zenodo.org/records/3884468), [Webis data page](https://webis.de/data/webis-webseg-20.html), and [Webis-Web-Archive-17](https://zenodo.org/records/1002204). The accompanying [evaluation/annotation code](https://github.com/webis-de/cikm20-web-page-segmentation-revisited-evaluation-framework-and-dataset) is MIT.
- **Data available:** WebSeg-20 contains 42,450 crowdsourced segmentations for 8,490 pages (five workers per page, fused ground truth). The release has raw annotation JSON, fitted DOM/node files (378.3 MB), ground truth, screenshots (12 GB), and edge screenshots. The source archive contains 10,000 archived pages with WARC, HTML DOM snapshots, and screenshots; Zenodo lists the downloadable archive and DOM/screenshot parts.
- **Labels/taxonomy:** This is *segmentation*, not semantic role classification. Annotators draw visually and semantically coherent blocks; fitted output maps polygons to DOM nodes/XPaths. There is no canonical `header`, `nav`, `footer`, etc. class vocabulary. Use the fitted DOM segments as unlabeled region boundaries or hard negatives, not as role labels.
- **Protocol/provenance:** Five Mechanical Turk workers per page; Webis code documents the browser annotation interface, local interface, polygon-to-DOM fitting, agreement, and fusion. It is reproducible browser/layout evidence and a large source of region boundaries, but pages are sampled from mid-2017 and can be outdated. The paper notes a filtered subset of 1,969 pages after incorrect XPath metadata was found; validate node linkage before use.
- **License/provenance:** Zenodo API metadata reports `cc-by-4.0` for Webis-WebSeg-20 ([record API](https://zenodo.org/api/records/3884468)); the Webis-Web-Archive-17 source archive reports `cc-by-sa-4.0` ([record API](https://zenodo.org/api/records/1002204)). The evaluation/annotation code is separately MIT. Preserve the applicable attribution/share-alike terms and review third-party archived page/media provenance when redistributing extracted content.
- **Use for SquirrelScan:** Strong supplement for node-boundary/layout training and negative examples (e.g. visually coherent blocks that are not one of the project’s roles). It can help bootstrap an “annotate these candidate regions” queue, but must not be treated as labeled `header/footer/nav` data.

### 3. Random and Popular semantic-block datasets (small, very usable, permissively stated)

- **Primary releases:** [dataset-random](https://github.com/rkrzr/dataset-random) and [dataset-popular](https://github.com/rkrzr/dataset-popular), from Kreuzer, Hage & Feelders’ ICWE 2015 comparison.
- **Data available:** 82 random pages and 70 popular homepages. Repositories include original GET HTML, rewritten offline HTML with static assets, serialized post-load DOM HTML, and manually marked `index.blocks.html`. These are actual HTML/DOM files and can be rendered offline; no screenshot files are advertised.
- **Labels/format:** Each manually marked DOM node has `data-block=1` (top-level) or `data-block=2` (sub-block) and `data-block-type="Header"`-style semantic type. The README does not enumerate every type; inspect `data-block-type` values before mapping. The popular README explicitly says the data has manually marked semantic blocks and describes all four file variants.
- **License:** Both READMEs state “Public Domain, but attribution is encouraged.” This is the clearest stated reuse position in the shortlist, though page content was sourced from third-party sites; keep provenance and check any redistribution policy for bundled assets.
- **Use for SquirrelScan:** Excellent small gold set for testing DOM-node extraction, role mapping, and annotation-tool import/export. Because the pages are old and only 152 total, use for calibration/validation rather than as the main training corpus. The explicit top/sub-level hierarchy is useful for nested-region policy.

### 4. CleanEval / Web2Text (binary content-vs-boilerplate auxiliary set)

- **Primary code/data:** [dalab/web2text](https://github.com/dalab/web2text), which vendors CleanEval under `src/main/resources/cleaneval/`; primary task paper [Web2Text](https://arxiv.org/abs/1801.02607) and [CleanEval LREC paper](https://sigwac.org.uk/cleaneval/lrec08-cleaneval.pdf).
- **Data available:** Web2Text repository contains raw HTML pages (`orig`), cleaned references (`clean`), and per-character aligned output (`aligned`). CleanEval has English dev/test 57/684 pages and Chinese dev/test 60/653 pages per the LREC table. Web2Text derives per-text-block ground truth as binary `1/0` main-content vs boilerplate labels from the clean/reference alignment.
- **Labels:** only `main content` versus `boilerplate` at text-block level. CleanEval instructions remove HTML/JavaScript and boilerplate (headers, copyright notices, link lists, repeated site material), then add minimal `p`, `h`, `l` markup for paragraph/header/list. It does **not** preserve a DOM node-to-role mapping; the LREC authors explicitly note that the simple output lost the original markup link.
- **License/provenance:** Web2Text code repository is MIT; that does not automatically license the embedded CleanEval pages. CleanEval’s official site/release should be checked for its corpus terms. Use as an auxiliary content/boilerplate benchmark, not as role-labelled DOM training.
- **Use for SquirrelScan:** Good negative/positive text evidence: navigation/copyright/link lists are often boilerplate, but do not collapse “boilerplate” into one semantic role. Keep this as a separate binary task or weak signal.

## Useful but not role-label matches

### WebSRC

[WebSRC baseline](https://github.com/X-LANCE/WebSRC-Baseline) documents 400K QA pairs over 6.4K pages with HTML, screenshots, bounding boxes, and metadata. Its `element_id` points to the deepest DOM tag containing an answer, with `answer_start` offsets; it does not label header/nav/footer/component roles. The repository is MIT, but distinguish that code license from page assets. Useful for DOM answer containment and screenshot alignment, not for semantic role labels.

### SWDE

[SWDE mirror](https://github.com/woailaosang/swde) has 124,291 HTML pages, 80 sites, eight verticals, and 32 attribute labels (e.g. product `price`, book `author`, job `company`). Ground truth is DOM text-node attribute extraction, not page-region roles; no screenshot corpus is described. The original CodePlex download is linked, but current availability/licensing is unclear. Use only for generic DOM-node extraction experiments after provenance review.

### WebUI-COCO-876

[HF WebUI-COCO-876](https://huggingface.co/datasets/jileklu/WebUI-COCO-876) is 876 real webpage screenshots with COCO boxes, released on the card as CC BY 4.0. Exact classes include `main`, `navigation`, `image`, `contentinfo`, `region`, `generic-button`, `banner`, `complementary`, `preferences-button`, `popover`, `close-button`, `search`, `cookie-dialog`, `accept-button`, `reject-button`, `form`, and `captcha`. It is screenshot-only (no DOM/HTML linkage), so use as visual pretraining/evaluation or a source of UI hard negatives. It must not be presented as shared component identity or DOM supervision.

### WebSight

[HuggingFaceM4/WebSight](https://huggingface.co/datasets/HuggingFaceM4/WebSight) is synthetic screenshot/HTML code (v0.1: 823K; v0.2: 2M according to the official HF announcement), rendered with Playwright/Tailwind in later versions. It has no human semantic region labels and is synthetic, so it is suitable for screenshot-to-code or rendering robustness only, not for real-site role taxonomy.

## Recommended reuse and human-label plan

1. **Start with a compatibility audit, not bulk ingestion.** Download only one WebClasSeg25 sample page and one Random/Popular page after recording release hash, source URL, license text, and whether the HTML is original, MHTML, or HF-converted. Verify `hyuIndex`/`hyu` joins, node visibility, and screenshot coordinate scale. For Webis, test the 000000 sample and flag XPath/node-fit failures.
2. **Use WebClasSeg25 FC as the initial role seed.** Map `Header -> header`, `Navigation -> nav`, `Main content -> main`, `Footer -> footer`, `Title -> title`, `Advertisement -> ad`, `Image -> image`. Preserve `sourceLabel`, `sourceDataset`, and a `mappingConfidence`; do not map MC labels into roles.
3. **Keep annotation granularity explicit.** Annotate one DOM node as the region owner, with nested descendants as `child`/`inside` relationships. Allow `shared` only when the same visible node legitimately serves multiple roles; do not infer that equal markup or visual similarity means the same reusable site component.
4. **Use Webis and WebUI-COCO as layout/negative supplements.** Convert Webis fitted segments and WebUI boxes into unlabeled or “candidate region / visual-only” records. Sample them for human relabeling, especially where visual boundaries cross DOM ancestors or where a region is coherent but not `header/nav/main/footer`.
5. **Calibrate on Random/Popular and a fresh crawl slice.** Have two labelers independently label 25–50 pages using the project ontology, adjudicate disagreements, and measure node exact match plus ancestor/descendant overlap. Include modern pages, responsive/mobile states, sticky chrome, cookie dialogs, and pages with no obvious landmark. Keep domains/template families isolated between train and evaluation.
6. **Use CleanEval only as a separate auxiliary signal.** A binary `content`/`boilerplate` label can aid extraction quality checks, but must not become the role label `nav`, `footer`, or `header`; the same text can be semantically useful in one context and boilerplate in another.

## Bottom-line shortlist

For immediate experiments, prioritize **WebClasSeg25 FC + HTML node subsets**, then **Random/Popular** for a small explicitly marked DOM gold set, and **Webis-WebSeg-20** for unlabeled/fitted layout boundaries. Add **CleanEval/Web2Text** only as a separate binary content-extraction benchmark. WebUI-COCO-876, WebSRC, SWDE, and WebSight are useful controls or auxiliary sources, but do not satisfy the combined requirement of human role labels tied to HTML DOM and screenshots.
