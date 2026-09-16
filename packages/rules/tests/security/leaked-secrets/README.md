# leaked-secrets corpus

A unit-test and benchmark harness for `security/leaked-secrets`
(`packages/rules/src/security/leaked-secrets.ts`).

## Layout

| File | What it is |
|---|---|
| `generators.ts` | One seeded generator per `FAST_PATTERNS` / `CONTEXT_PATTERNS` entry. Values are assembled at runtime from parts; no line is a token-shaped literal and nothing is a real credential. |
| `contexts.ts` | Eighteen embedding contexts (inline config object, `window.__ENV`, `__NEXT_DATA__`, `__NUXT__`, HTML comment, `<meta content>`, `data-*`, JSON-LD, external bundle, `fetch()` Bearer header, `.env` dump in `<pre>`, sourcemap comment, and the six encoded forms of #360: entity-encoded attribute, `\u`/`\x`-escaped script string, base64 blob in a data attribute, base64 blob in a global, URL-encoded JSON in a data attribute, URL-encoded JSON in inline settings). Each declares the rule-level location it reports at, including the ` (base64)` suffix. |
| `negatives.ts` | Hand-written look-alikes that must not fire, or must fire only as `public`. |
| `cases.ts` | Every generator in every accepting context, plus the negatives and interaction probes. Each case states the exact `(pattern, check, location)` set the rule must report. `check` can also be `info` (the `leaked-secrets-info` check: expired and session tokens). |
| `expected.json` | Snapshot of the raw `scanPageForSecrets` + external-script output per case (type, confidence, publicByDesign, location, masked value, and the decoded `extra` fields of #361). Any detector change diffs here. |
| `../leaked-secrets.test.ts` | The suite. |
| `../secrets-decode.test.ts` | Unit tests for the content decoders (`src/security/secrets/decode.ts`): entities, JS escapes, the base64 run finder against a brute-force definition, exclusions, depth, and the 200 KB data URI cost budget. |
| `../secrets-confidence.test.ts` | Unit tests for the token decoders (`src/security/secrets/confidence.ts`): GitHub checksum against an independent CRC32 and a published expired token, AWS account id against an independent base32 decode, JWT tiers, Algolia restrictions, and a `fetch`-throws guard over the whole scan. |
| `../../../scripts/bench-leaked-secrets.ts` | The benchmark. |

Generators for GitHub tokens and AWS key ids produce values that pass the
detector's own structural checks (a valid checksum, a base32 suffix that
decodes to a 12-digit account id): a random body would now be dropped or
downgraded, and the corpus wants every positive to be a positive. The checks
themselves are proven independently in `secrets-confidence.test.ts`.

## Run

Always with an explicit path. Never a bare `bun test` or a directory.

```sh
cd repo-public/packages/rules
bun test tests/security/leaked-secrets.test.ts
```

Update the snapshot after an intentional detector change, then review the diff:

```sh
UPDATE_SECRETS_SNAPSHOT=1 bun test tests/security/leaked-secrets.test.ts
git diff tests/security/leaked-secrets/expected.json
```

## Known gaps

Cases carrying `knownGap` assert what the detector does TODAY, so the suite is
green, and each registers a `test.todo` naming the fix. Bun hides todo names,
so the suite also prints the deduplicated list at the top of its output.
Fixing a gap means flipping its expectation in `cases.ts`, `negatives.ts` or
`real-world.ts`.

### Closed by pub#357 / pub#363

Left-boundary guard on every prefix pattern (Telegram in a UUID pair, Resend
in `_Care_Dry…`, `fooghp_`/`xsk_live_`/`abcAKIA`); a 40-character bounded
look-behind for the context tier instead of a ±500 window (ordinary-word
keywords beside hashes and nonces); minified member keys (`e.k=`) and
keyword-in-attribute names (`data-heroku-dyno`) are no longer credential
contexts; the false-positive list is anchored to the value's head and tail
(Twitter bearer tokens fire, a token containing `xxx` is kept); PayPal runs
after Azure and needs a value position (no more `azione-…` slugs); DigitalOcean
Spaces runs after New Relic; Sanity needs the `sanity` keyword; generic
assignments skip values with whitespace or under a length-scaled entropy
floor (i18n sentences); a quoted value under a credential key with a digit in
it is a literal, so camelCase, snake_case and `on…` openings no longer drop
real tokens; word-bounded context values (Cohere no longer claims the head of
a Together key). The keyword prefilter is declared per pattern and asserted
by the meta-test.

### Closed by pub#360 / pub#361

The JWT payload is decoded: `role: service_role` from Supabase is high,
`anon` is public, an expired `exp` or a first-party session token lands in
the `leaked-secrets-info` check, any other issuer is medium at most and
never labelled Supabase (gap 7 below is closed). Entity-, escape-, percent-
and base64-encoded content is decoded before the scan (`decode.ts`).

### Remaining (8 distinct)

1. Clerk `sk_live_[a-zA-Z0-9]{40,}` can never fire: Stripe Live runs first and the overlap dedup drops it.
2. `Authorization: Bearer <value>` with a value under 20 chars is reported by neither tier.
3. PayPal's class omits uppercase B–Y, so a real mixed-case client id never fires.
4. Neon `neon_[\w-]{32,}` matches a `neon_`-prefixed hyphenated URL slug (a left boundary does not help: `/` precedes it).
5. ~~The "Supabase Anon Key" pattern is the generic HS256 JWT header: any session JWT with a 100+ char payload reports as Supabase anon, and a `service_role` JWT reports as public.~~ Closed by pub#361 (see above): the pattern is the general `JSON Web Token` now, any algorithm, named from the decoded claims.
6. Stripe `pk_test_` has no pattern; under `apiKey:` the generic assignment warns on a public test key.
7. Railway API tokens are plain UUIDs; the `railway_…` pattern matches a shape Railway does not issue.
8. No size cap: a 5 MB external script is scanned in full (cost, not a wrong result).
9. A call argument is not a value position: `rg4js('apiKey', '…')`, `mixpanel.init("…")` and `posthog.init("…")` report only when the argument's own shape is a pattern (PostHog's `phc_` is; Raygun's and Mixpanel's are not).

Closed in round 3 (from the full 383-file real corpus): Shopify's own boot JSON (`<script id="shopify-features">`, `storefrontAccessToken` anywhere, `accessToken` + 32 hex on a page loading from cdn.shopify.com) lands in the public tier; PostHog `phc_` project keys have a public FAST pattern; a generic API key or access token under a public brand parent or tag (`raygun:{apiKey}`, `<builder-component api-key>`; 12 brands, listed in the detector) reports public under the brand's name, while a password, secret or auth token under the same parent stays a leak; a generic match that is the tail of a URL path is dropped (never a query string); a Bearer yields to a JWT finding only for that exact token, so an unrecognised JWT still reports; the rule's dedup prefers the public classification of a value and drops a generic record whose body is exactly a public value. Three real leak shapes from the corpus are pinned as positives: a Bearer JWT inside a Next.js RSC flight payload, a literal Bearer header in a first-party `fetch()`, and `ENCRYPTED_STORAGE_SECRET_KEY` in an inline env dump beside a Turnstile test key that stays silent.

Closed in round 2: the Bearer duplicate on a JWT value (the Bearer match yields to the JWT pattern); Shopify Storefront access tokens, the web-pixel `Api-Key`, Mixpanel project tokens and Raygun API keys are public-tier context patterns, and a generic assignment yields to one of them when its keyword is within the look-behind AND the value is that pattern's whole shape; a value that equals its own key (`password:"Password"`) or is a URL-encoded label (`%20`, letters ending in `%`) is dropped; a token preceded by the tail of a `%XX` escape (`%22pk_live_…`) passes the left-boundary guard. <!-- pragma: allowlist secret -->

Judgement calls the lead accepted (pub#357 round 2):

- Minified member keys (`t.a=`, `e.k=`, `n["a"]=`) are "none", not "assigned". This blinds the rule to a leak assigned to a one-letter member in a bundle; on 776 real sites that shape was 100% noise (Cloudflare challenge and Shopify pixel bootstraps).
- FAST keywords are the literal every match contains, lowercase. Distinctive ones are the provider prefixes (`ghp_`, `sk_live_`, `akia`, `hooks.slack.com`, `.ingest.sentry.io/`, the PEM armour lines). Weak ones exist because the pattern has nothing better: Telegram `:`, Discord `.`, Twilio SID `ac`, DO Spaces `do`, PayPal `az`, Mailchimp `-us`, Mailgun `key-`, OpenAI `t3blbkfj`/`sk-`. Anything under four characters proves nothing to the 4-gram index, so those patterns always run, exactly as before; the declared keyword there is documentation plus the meta-test's near-miss anchor.
- The 40-character keyword gap counts raw characters, whitespace included. A pretty-printed manifest aligning `"together_token"` more than 40 characters from its value is a documented limit. Inside one HTML tag the whole tag is the look-behind: a naming attribute (`name`, `id`, `property`, `itemprop`, `data-*`) counts in either attribute order.

Documented choices, not gaps: unquoted identifiers under a credential key stay
silent (`apiKey: getSegmentKey`); `password: "changeme"` reports (a weak <!-- pragma: allowlist secret -->
credential as often as a placeholder); the generic FAST assignments outrank
the context tier, so a value under `auth0ClientSecret` reports as "Generic
Secret Assignment".

## Benchmark

```sh
cd repo-public/packages/rules
bun run bench:secrets -- --out /tmp/secrets-bench.json
# options: --iterations 3 --pages 200 --seed 1
```

The corpus is 200 pages: half an even sample of the test cases, half filler
pages carrying 50–500 KB of minified-JS-like inline script (with the
`segment`, `cloudflare` and `twilio` keywords every ~2 KB so the keyword
window path runs), an external bundle of the same shape on every fourth
page, and three 2–5 MB vendor bundles, one with a real finding at its end.
Pages are parsed and serialized once up front; only `scanContent` is timed,
best of N after one unmeasured warm-up pass.

### Baseline

Apple M2, 16 GB, macOS 24.6.0, Bun 1.3.14, commit `10ef2e7`, 2026-09-16, seed 1, 3 iterations:

| commit | iterations | best | mean | ms/MB | findings | peak RSS |
|---|---|---|---|---|---|---|
| `10ef2e7` (before pub#357), first baseline run | 3 | 946 ms | 991 ms | 14.2 | 145 | 383 MB |
| `cd9f746` (origin/main, stashed detector), A/B run | 7 | 1247 ms | 1773 ms | 18.7 | 144 | 243 MB |
| pub#357 + pub#363, same A/B run | 7 | 1081 ms | 1434 ms | 16.2 | 148 | 248 MB |
| round 2 (+ #365 Discord bound, public tiers, tag-scoped look-behind) | 7 | 947 ms | 1049 ms | 14.2 | 146 | 486 MB |
| round 3 (Shopify boot JSON, phc_, brand parents, URL-path drop, pinned leaks) | 7 | 948 ms | 1042 ms | 14.2 | 133 | 303 MB |

The A/B pair was measured back to back on the same 66.67 MB corpus (200
pages, 53 external scripts, 400 bodies), same seed, on a loaded machine: both
rows are slower in absolute terms than the first baseline, and the pair is the
comparison that holds (13% faster best-of-7, 19% faster mean). Findings went
up because Twitter bearer tokens and the values the old identifier heuristic
dropped now report; time went down because the context tier reads a
40-character region per keyword instead of a 1,128-character window.

### Decoders (pub#360 / pub#361)

Same machine, Bun 1.3.14, seed 1, 5 iterations, back to back on the
pre-#357 detector (`cd9f746` vs the decoders on top of it; the corpus grew
with the new cases, so the finding counts are not comparable):

| build | best | ms/MB | findings |
|---|---|---|---|
| before, `cd9f746` | 931 ms | 13.97 | 148 |
| after (entity, escape and percent decode as content enters, base64 blob pass, token decoders) | 990 ms | 14.85 | 137 |

Rebased onto pub#357 / pub#363 round 2 (`f445a7d`), same machine and
settings, back to back:

| build | best | ms/MB | findings |
|---|---|---|---|
| `f445a7d` (precision lane) | 931 ms | 13.96 | 146 |
| decoders on top of it | 975 ms | 14.62 | 139 |

+4.7% ms/MB: the fixed cost of the three in-place decoders (three `indexOf`
gates per body), the base64 sampler and the general JWT pattern.

On the private real-site corpus (383 pages and scripts, 126 MB), paired runs
back to back on the same machine state: precision `f445a7d` 6240 ms summed
per-file vs decoders 6739 ms (+8%); precision `cb46651` vs decoders +10.6%
on a busier box. Per-file timing on that corpus is only meaningful as a
pair: at load 20+ the precision head alone measured 12x its quiet number.
Most of the decoders' share was the base64 pass trying to decode URL paths
(the alphabet includes `/`; a Shopify product page carries 300 such runs),
which `looksLikeBase64Text` now rejects before anything is allocated. A 3 MB
page of inline base64 fonts, 2000 entities and 200 percent escapes is pinned
in `secrets-decode.test.ts` to cost the decoders less than the rest of its
own scan.

+6.3% ms/MB. The base64 pass samples every 32nd character rather than
scanning them all (`findBase64Runs` in `decode.ts`); a character loop or a
global `{64,}` regex both cost more than the whole budget on this corpus.
