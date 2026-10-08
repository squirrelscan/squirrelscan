# Endpoint discovery pass

A shared, passive pass that gives a site rule a candidate API surface to look at. Use it for rules such as GraphQL introspection, exposed actuator endpoints and open API docs, so each rule does not re-extract URLs from the same pages and scripts.

The pass sends no request. It reads content the crawl already fetched.

## Read it in a rule

Site rules read `ctx.endpointSurface` (`EndpointSurface`, from `@squirrelscan/rules`).

```ts
run(ctx) {
  const eligible = (ctx.endpointSurface?.candidates ?? []).filter((c) => c.probeEligible);
  // ...
}
```

`undefined` means the engine did not run the pass. Read it as "no candidates known", never as "the website has no endpoints".

## Shape

```ts
interface EndpointCandidate {
  url: string; // absolute, fragment removed
  method?: string; // upper case, when the call site or form states one
  source: "static-js" | "static-html" | "convention" | "render";
  discoveredVia: string; // fetch, axios.get, xhr.open, $.ajax, string-literal,
  //                        form-action, link-href, script-src, convention:<tech id>
  sameOrigin: boolean;
  probeEligible: boolean; // true only when sameOrigin
}
interface EndpointSurface {
  candidates: EndpointCandidate[]; // deduped, capped, stable order
  total: number; // distinct candidates before the cap
  truncated: boolean; // the final cap or the script scan budget dropped candidates
  scriptsSkipped: number; // same-origin scripts the scan budget did not read
}
```

## Rules the pass follows

- **Same origin is the probe boundary, and it is strict.** Scheme, host and port must all match the audited base URL, so `www.example.com` against `example.com` counts as cross-origin. That fails closed: a rule never probes a host the audit did not start from. A cross-origin endpoint (a vendor API, a Supabase project host) is recorded so a rule can report it. It has `probeEligible: false`. A rule must not send a request to it.
- **Deduped** on method plus URL. A method-less record (a bare string literal, a link) is dropped when the same URL has a record with a method.
- **Capped** at `MAX_ENDPOINT_CANDIDATES` (200), of which at most `MAX_CROSS_ORIGIN_CANDIDATES` (50) are cross-origin. The order is stable: convention paths, then served JS, then page HTML, each sorted by URL. The result does not depend on crawl order: the collector retains the smallest keys under a stable order (method-carrying refs first, then URL, then method), at most `MAX_RETAINED_REFS` (2000) in total and `MAX_RETAINED_CROSS_ORIGIN_REFS` (300) of those cross-origin to the page that referenced them, so any permutation of the pages, or any split between fresh and cached pages, keeps the same refs. When a crawl has more distinct refs than the caps, the ones past them in that stable order are dropped, and `truncated` does not report that: it covers only the final cap and the script scan budget.
- **No shared probe budget exists yet.** The list is capped and shaped so a future budget can consume it. Do not build probe limits into a rule on the assumption that this list is small enough.

## Sources

1. **Static, from served JS and page HTML.** `fetch(...)`, `axios.*`, `XMLHttpRequest.open`, `$.ajax`, `$.get`, `$.post`, `$.getJSON`, and string literals that look like an API route: `/api/...`, `/graphql`, `/rest/v1/...` (Supabase), `/_next/data/...`, `/api/trpc/...`, `/wp-json/...`, `/actuator`, and URLs on `api.`, `graphql.`, `gql.` or `gateway.` hosts. Form `action` attributes and `link href` / `script src` URLs on an API host or route count too. Only same-origin scripts are scanned: a root-relative literal in a vendor bundle names the vendor's API.
2. **Convention paths per detected stack.** `CONVENTION_PATHS` in `endpoint-surface.ts` maps a technology id from `@squirrelscan/tech-detect` to a short list (for example `nextjs` gets `/api/health` and `/api/graphql`). Detection always runs on the entry page (the page whose URL is the audit's start URL, wherever it arrives), and on up to three other pages while no stack has been found, as a fallback. The v1 path collects the entry page first by URL, not by map order. A website with no recognised stack gets none.
3. **Render-time XHR and fetch URLs: not fed today.** The browser render result carries the final html, status, headers and timings, not the requests the page issued. `buildEndpointSurface` accepts `renderedRequests` and tags them `source: "render"`, so wiring them in is one argument once the render phase returns them.

## Script scan budget

The fold runs in the site pass, so the script scan is bounded. At most `MAX_SCRIPTS_SCANNED` (100) same-origin scripts and `MAX_SCRIPT_SCAN_CHARS` (4 MiB) of script text are read per run, and no single script is read past 512 KiB. Scripts are read in URL order, so the choice does not depend on fetch order. Scripts past either limit are not read: `scriptsSkipped` counts them and `truncated` is `true`. A script cut short by the byte budget or the 512 KiB cap still counts as scanned and does not set `truncated`. Eight real 512 KiB bundles take about 20 ms to scan.

## Where it runs

- `packages/rules/src/endpoint-surface.ts` holds the extractors and `buildEndpointSurface`. They are pure and Worker-clean.
- `packages/audit-engine/src/endpoint-discovery.ts` holds the page collector. It runs while each page DOM is live, like the `collected-signals` collector, and its per-page record is stored in the rule cache and replayed. A cached page from before this collector existed has no record, so it is re-run once.
- `runStreamingRules` registers the collector in the page loop. `runRulesOnStorage` (v1) feeds the same collector from the parsed pages it holds. Both hand the folded surface to `runner.runSiteRules`.

## Confidence and safety

A candidate with `discoveredVia: "string-literal"` is a quoted string that looks like an API route. It can be an i18n string or a documentation link, so treat it as lower confidence than a call site (`fetch`, `axios.*`, `xhr.open`, `$.ajax`) or a form action. A convention candidate is a guess from the detected stack. Convention paths such as `/api/health`, `/metrics` and `/graphql` are guesses from the stack, not verified routes. A call-site candidate can name any same-origin path that is not a static asset, including a state-changing one such as `/logout` or `/admin/delete`. A rule that probes a candidate must check `probeEligible` first, and must send only idempotent, read-only requests (GET, HEAD, OPTIONS, or a read-only POST such as a GraphQL introspection query). Use `method` and `discoveredVia` to decide. Relative URLs without a leading slash (`fetch("api/users")`) are skipped on purpose, because their base depends on the page path.

## Constraints

- Every regex is linear or bounded polynomial (options-object bodies allow one nested brace level inside a 300-repeat cap), and every input is length-capped before it is scanned (512 KiB per script, 1 MiB of inline script per page). The page content is attacker-controlled, so keep it that way when you add a pattern.
- The collector retains at most `MAX_RETAINED_REFS` (2000) distinct refs across the crawl, so memory stays flat on a large crawl. Cross-origin refs have their own smaller cap so they cannot crowd out same-origin ones, and admission is by a stable key order, not by arrival.
- The pass makes no network request. `endpoint-discovery.test.ts` stubs `fetch` to throw while it runs the collector, technology detection and the fold, which is the whole pass.
- Technology ids are unioned across all page records, so the convention paths do not depend on which page the collector saw first.
