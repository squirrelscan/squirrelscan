# DOM classification corpus tooling

`build_corpus.py` creates a private annotation corpus from retained crawler bodies. It
never emits source HTML, raw URLs, arbitrary attributes, scripts, styles, comments, or
form values. It redacts sensitive-looking text before writing bounded snippets. Packet
records have a closed, recursively checked field shape; every serialized packet string,
including `contextText` and nested semantic-chain values, is checked for sensitive
patterns before output is accepted.

Run it only with a private output directory:

```sh
python3 experiments/dom-classifier/build_corpus.py \
  --projects-root $SQUIRREL_STORE/projects \
  --content-store $SQUIRREL_STORE/content-store.db \
  --output $DOM_CLASSIFIER_DATA_ROOT/2026-09-18
```

The pipeline opens both SQLite sources using `mode=ro`; it verifies each decompressed
body's SHA-256 against its `content_hash`. `fetcher_id=fetch` only classifies the stored
fetcher metadata as `source`; it is not independent proof of a network source or a
replay of an earlier report snapshot. Other values remain `unknown`.

`extract-dom.ts` parses every selected body through the production `packages/parser/src/dom.ts`
entry point. It uses production `collectTextExcluding`, `getCleanTextContent`,
`getMainContent`, `isInSiteChrome`, case-insensitive attribute helpers, and the crawler's
installed `tldts` dependency. These parser/content/chrome values are retained as private
weak features only; annotation packets intentionally omit them.

The candidate extractor is custom corpus tooling built from those production primitives.
The frozen v2 records are annotated as whole extracted page regions, rather than as a
general inventory of every text unit. This does not claim that the production parser
itself supplies the candidates or an exhaustive text segmentation API.

The candidate pool is deduplicated first by body hash and then by a fingerprint over
structural metadata, sanitized `contextText`, the structural locator, and curated
class/id tokens. That fingerprint deliberately excludes candidate text and text length,
but it is not text-free or purely structural. It uses `tldts` to group selection by
registrable domain (eTLD+1), including `www`, `docs`, and `app` variants. Packets
contain node shape and safe, bounded text but no automatic role prediction. Luna
annotations are private, provisional (`gold=false`), and must follow `ANNOTATION.md`.

The emitted private `split-groups.jsonl` is the later training contract: a candidate's
domain and quantized text-free template-family proxy are connected into one
`splitGroupId`. Training must keep every group in one split. Domain isolation is a real
constraint; the template proxy is weak rather than a robust cross-domain template
holdout (v2 has 49 contributing sites and 48 template families). The corpus version is
`dom-regions-v2` and the expected annotation version is `dom-role-v2`.

Selection is deterministic and limits the corpus to one selected page per registrable
domain, but it is not stratified by page type, language, role, or template. The frozen
v2 run requested and selected 55 pages; 49 contributed candidates and six were empty
after candidate extraction/deduplication. Do not infer corpus balance from that sample.

Validate an existing private packet directory without modifying it:

```sh
python3 experiments/dom-classifier/build_corpus.py \
  --validate-packets $DOM_CLASSIFIER_DATA_ROOT/2026-09-18/v2/packets
```

The command prints aggregate failure counts only and exits nonzero on an unknown field,
invalid nested shape, or sensitive-looking string.

Public changes must include synthetic tests only. Real corpus output and labels must stay
outside Git.
