# leaked-secrets corpus

A unit-test and benchmark harness for `security/leaked-secrets`
(`packages/rules/src/security/leaked-secrets.ts`).

## Layout

| File | What it is |
|---|---|
| `generators.ts` | One seeded generator per `FAST_PATTERNS` / `CONTEXT_PATTERNS` entry. Values are assembled at runtime from parts; no line is a token-shaped literal and nothing is a real credential. |
| `contexts.ts` | Twelve embedding contexts (inline config object, `window.__ENV`, `__NEXT_DATA__`, `__NUXT__`, HTML comment, `<meta content>`, `data-*`, JSON-LD, external bundle, `fetch()` Bearer header, `.env` dump in `<pre>`, sourcemap comment). Each declares the rule-level location it reports at. |
| `negatives.ts` | Hand-written look-alikes that must not fire, or must fire only as `public`. |
| `cases.ts` | Every generator in every accepting context, plus the negatives and interaction probes. Each case states the exact `(pattern, check, location)` set the rule must report. |
| `expected.json` | Snapshot of the raw `scanPageForSecrets` + external-script output per case (type, confidence, publicByDesign, location, masked value). Any detector change diffs here. |
| `../leaked-secrets.test.ts` | The suite. |
| `../../../scripts/bench-leaked-secrets.ts` | The benchmark. |

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

### Remaining (13 distinct)

1. Clerk `sk_live_[a-zA-Z0-9]{40,}` can never fire: Stripe Live runs first and the overlap dedup drops it.
2. `Authorization: Bearer <value>` around a value containing `.` (a JWT) reports a second medium "Bearer Token" for the prefix. For a Supabase anon JWT that is a false warning on a public key.
3. `Authorization: Bearer <value>` with a value under 20 chars is reported by neither tier.
4. PayPal's class omits uppercase B–Y, so a real mixed-case client id never fires.
5. Neon `neon_[\w-]{32,}` matches a `neon_`-prefixed hyphenated URL slug (a left boundary does not help: `/` precedes it).
6. PostHog `phc_` project keys are not recognised at all.
7. The "Supabase Anon Key" pattern is the generic HS256 JWT header: any session JWT with a 100+ char payload reports as Supabase anon, and a `service_role` JWT reports as public.
8. Stripe `pk_test_` has no pattern; under `apiKey:` the generic assignment warns on a public test key.
9. Railway API tokens are plain UUIDs; the `railway_…` pattern matches a shape Railway does not issue.
10. Scoping question: Shopify Storefront API access tokens and web-pixel `Api-Key` values are public storefront identifiers but report as medium generic assignments.
11. No size cap: a 5 MB external script is scanned in full (cost, not a wrong result).

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

The A/B pair was measured back to back on the same 66.67 MB corpus (200
pages, 53 external scripts, 400 bodies), same seed, on a loaded machine: both
rows are slower in absolute terms than the first baseline, and the pair is the
comparison that holds (13% faster best-of-7, 19% faster mean). Findings went
up because Twitter bearer tokens and the values the old identifier heuristic
dropped now report; time went down because the context tier reads a
40-character region per keyword instead of a 1,128-character window.
