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
Fixing a gap means flipping its expectation in `cases.ts` or `negatives.ts`.

The list as of this commit (20 distinct), the six the harness was briefed with first:

1. Clerk `sk_live_[a-zA-Z0-9]{40,}` can never fire: Stripe Live runs first and the overlap dedup drops it.
2. PayPal `[Aa][Zz][Aa-zZ0-9-_]{60,}` omits uppercase B–Y, so a real mixed-case client id never fires.
3. Sanity `sk[a-zA-Z0-9]{30,}` fires on any `sk`-prefixed identifier or CSS class of 32+ chars.
4. Inline scripts are scanned twice (inside the serialized HTML, then on their own); the rule's dedup hides it, the cost is paid.
5. PostHog `phc_` project keys are not recognised at all.
6. No size cap: a 5 MB external script is scanned in full.

Found while building the corpus:

7. Twitter bearer tokens open with 19 `A`s and the false-positive filter `/a{16,}/i` drops every one of them.
8. `FALSE_POSITIVE_PATTERNS` are unanchored substring tests: a random key containing `xxx`, `fake`, `sample` or `dummy` anywhere is dropped, prefix and all.
9. Sanity `sk…{30,}` also fires inside base64 image data URIs (an `sk` followed by 30 alphanumerics is routine in a few KB of base64).
10. `Authorization: Bearer <value>` around a value containing `.` (JWTs, Discord bot tokens) reports a second medium "Bearer Token" for the prefix. For a Supabase anon JWT that is a false warning on a public key.
11. `Authorization: Bearer <value>` with a value under 20 chars is reported by neither tier (LinkedIn's 16-char secret).
12. PayPal runs before Azure Storage Key and claims a substring of a lowercase-heavy AccountKey, downgrading a high finding to public info.
13. DigitalOcean Spaces `DO[A-Z0-9]{20,}` runs before New Relic and claims the tail of any NRAL key containing `DO`, downgrading high to medium.
14. With two brand keywords in one window the first CONTEXT pattern (Cohere, 40 alnum) claims a prefix of a longer Together key.
15. `looksLikeCodeIdentifier` drops keyed values that open lowercase-then-uppercase (`abK…`, roughly 30% of random alphanumeric keys).
16. It also drops values starting with `on`/`is`/`get`/… regardless of what follows.
17. It also drops values carrying an `_` next to a lowercase letter; real Cloudflare tokens do.
18. The "Supabase Anon Key" pattern is the generic HS256 JWT header: any first-party session JWT with a 100+ char payload is reported as a Supabase anon key, and a Supabase `service_role` JWT (full database access) is reported as the public-by-design anon key because the `role` claim is never decoded.
19. Stripe `pk_test_` has no pattern; under `apiKey:` the generic assignment warns on a public test key.
20. Railway API tokens are plain UUIDs; the `railway_…` pattern matches a shape Railway does not issue.

Documented ordering rule, not a gap: the generic FAST assignments run before the CONTEXT tier, so a value under `auth0ClientSecret` or `twilioAuthToken` reports as "Generic Secret/Token Assignment", not under the brand (probe `generic-assignment-outranks-a-keyed-brand-pattern`).

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

| corpus | bodies | best | mean | ms/MB | findings | peak RSS |
|---|---|---|---|---|---|---|
| 66.67 MB (200 pages, 51 external scripts) | 400 | 946 ms | 991 ms | 14.2 | 145 | 383 MB |
