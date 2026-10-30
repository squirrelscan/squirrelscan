# Changelog

Release notes for the `squirrel` CLI, written and managed here (no generation in CI).

How it works:

- The release workflow extracts the section whose heading matches the version being
  released (e.g. `## v0.0.57`) and uses it as the GitHub release body.
- Add a new `## vX.Y.Z` section at the top before cutting a release.
- Beta releases (`vX.Y.Z-beta.N`) need their own `## vX.Y.Z-beta.N` section — the
  extractor matches the exact version, so a beta won't reuse a plain `## vX.Y.Z`.
  A stable `## vX.Y.Z` matches any `## vX.Y.Z-<suffix>` heading (e.g. `-beta.N`,
  `-rc.1`), so a stable cut can reuse a pre-release section when no plain one exists.
- Use `###` (or deeper) for sub-sections within an entry — a `## ` heading marks a new version.
- A `## [Unreleased]` section collects merged changes that have not been cut into
  a release yet; rename it to the version when the release goes out.

## [Unreleased]

## v0.0.143 (2026-10-30)

Two new performance rules, `perf/content-in-js-bundle` and `perf/framework-data-payload`, find page content shipped inside JavaScript. Page weight now measures the srcset candidate a browser downloads and leaves lazy images out, `squirrel auth login` opens a branded page, parallel audits no longer fail with a locked database, and `store_scripts` no longer changes what an audit finds. A start URL the audit cannot run on is refused before any request, `security/tls-certificate` shows as not checked when it cannot run, and the about, contact and privacy rules take a `paths` option.

### Added

- **New rule `perf/content-in-js-bundle` finds page content compiled into a JavaScript chunk.** A site that imports its MDX or Markdown bodies eagerly (or imports CMS JSON at build time) ships every page's text to every visitor as script, on top of the server-rendered HTML. squirrel keeps up to five distinctive sentences of each page's main content, then searches the site's same-origin chunks of 50 KB or more for them, through JavaScript string escapes, HTML entities and JSX quoting. A chunk holding one page's own content is information (a hard-coded route component looks the same: 4 of 36 real documentation sites), and one that also holds at least two other pages' content is a warning (its own sitewide check). Browser-rendered pages are not judged, and chunks the audit could not fetch are reported as not checked rather than clean. Each finding gives the chunk URL, its raw and gzip size, how many pages' content it holds and an estimated prose share. Navigation, footer and template text, inline hydration state and chunks under 50 KB are ignored, and the search is bounded (10 largest chunks, 2,000 pages, one linear pass per chunk, 2.5 seconds). See [the rule page](https://docs.squirrelscan.com/rules/perf/content-in-js-bundle). (#1200)
- **New info rule `perf/framework-data-payload` flags a mostly-text page that carries 100 KB or more of inline framework state.** `__NEXT_DATA__`, the Next.js app router's `self.__next_f` flight chunks, `window.__NUXT__` and `__NUXT_DATA__`, Remix, Qwik, SvelteKit and Astro island props are measured per page. It reports only when the payload is at least 20 times the page's visible text and the page has at most 5 form controls and embeds and 50 buttons, so interactive apps and data-heavy pages are left alone. The thresholds come from a run over 40 public pages and are options (`min_bytes`, `min_text_ratio`, `max_interactive`, `max_buttons`). See [the rule page](https://docs.squirrelscan.com/rules/perf/framework-data-payload). (#1143)
- **Technology detection knows Bolt and the WordPress plugin and managed host landscape.** `bolt-new` (Bolt, by StackBlitz) matches apps served from `*.bolt.host` and, on custom domains, the "Made in Bolt" badge link; it never matches Bolt's checkout product. Twenty-one WordPress fingerprints add caching plugins (WP Rocket, LiteSpeed Cache, W3 Total Cache, WP Super Cache, WP Fastest Cache, Autoptimize, Perfmatters), SEO plugins (Yoast SEO, Rank Math, All in One SEO, SEOPress), image plugins (ShortPixel, Imagify, EWWW Image Optimizer, Smush) and managed hosts (WP Engine, Kinsta, Pressable, WordPress VIP, SiteGround, Cloudways). A plugin is detected from its asset URL, its own HTML comment or its schema block, never from its name in text, and a host from its response header. Three new technology categories group them: Caching & Performance, SEO Plugins and Image Optimization. (#1278, #1033)

### Fixed

- **An unreachable start URL's error text no longer echoes credentials.** The reason and message in the `status: "unreachable"` report, the console line and the run record drop userinfo, query tokens and fragments from any URL the probe's error mentions.
- **`store_scripts` no longer changes what an audit finds.** With `[storage] store_scripts = true` (or `--store-scripts`) the audit fetched up to 200 scripts and gave all of them to the script rules, so `perf/js-file-size` failed on 36.5% of the same sites against 29.8% with it off, and scores moved. The rules now evaluate the same scripts they do with the option off (the first 10 to 50, in page order); the extra scripts are fetched and stored only. `meta.scriptsEvaluated` in the JSON report (and `<scripts-evaluated>` in the LLM output) says how many first-party scripts the script rules evaluated, so two runs can be compared. See [`store_scripts`](https://docs.squirrelscan.com/configuration/storage#store_scripts). (#1280)
- **`store_scripts` follow-ups.** The warning for scripts that were not stored now lists each reason with its count and the setting that applies (too large, total cap, memory cap, time budget) instead of blaming the size settings for all of them. `squirrel audit --no-store-scripts` turns `[storage] store_scripts = true` off for one run. `content-store.db` and project databases are created owner-only (`0600`), and existing ones are tightened when opened. The storage docs now state that the time and memory bounds are soft (about 20 seconds, up to 10 bodies in flight, roughly 3x memory for non-Latin1 bundles), that the preload pass has its own counters, and that the empty script tables exist when the option is off. (#1268)
- **Parallel `squirrel audit` runs no longer fail with `SQLite database is busy (locked)`.** Ten audits at once on one machine lost a few to a lock error and wrote no report. The lock timeout is now set before any other statement on every connection to the content store, the link cache and project databases, switching a new database to WAL waits for its lock, and write transactions take the write lock up front instead of failing when they upgrade. A lock that is still held after the timeout names the database file and the wait. See [Running several audits at once](https://docs.squirrelscan.com/configuration/storage#running-several-audits-at-once). (#1226)
- **The page `squirrel auth login` opens in your browser is squirrelscan branded.** It had been a plain white card with a green heading. It now has the squirrel mark and wordmark, the brand palette and type, a signed-in state with your email, the agent setup prompt and copy button restyled to match, and light and dark themes that work at phone width. The expired, already-used and waiting pages use the same layout. The page is self-contained (inline mark and styles, nothing fetched, a Content-Security-Policy that allows only its own copy script), and only the escaped email is interpolated. (#1286)
- **`security/tls-certificate` now shows up as "Not checked" and no longer disappears behind an HTTP proxy.** When no handshake was made the rule returned an info check the report dropped, so it was missing from `issues`, `passedRules` and `notChecked` in `-f json`. It is now a skipped check with a reason, listed under "Not checked" in every format. With `HTTPS_PROXY` or `HTTP_PROXY` set, the handshake goes through a CONNECT tunnel with SNI and verification intact (a host in `NO_PROXY` is probed directly), and a proxy that refuses or fails the tunnel, or one this check cannot tunnel through, gives a "Not checked" line with that reason instead of a pass. (#1259)
- **`security/tls-certificate` warns relative to the certificate's lifetime, not a fixed 30 days.** Automated CAs renew a 90-day certificate at about 30 days left, so the fixed 30-day warning fired on healthy, auto-renewing certificates before every routine renewal (about 73% of expiry findings in a 38k-site sample sat at 25 to 30 days left). The default warning now waits until a renewal is 14 days overdue: the last third of the certificate's lifetime less 14 days, 16 days for a 90-day certificate. 28 days left passes, 10 warns, 5 fails. Short-lived certificates get proportionate windows (a tenth of the lifetime for the error threshold when under 70 days, so a 6-day certificate does not fail on its third day and a 47-day one keeps a warning step). `warn_days` and `error_days` are unset by default and, when set, replace the derived value with a fixed number of days as before. (#1279)
- **`eeat/about-page`, `eeat/contact-page` and `eeat/privacy-policy` take a `paths` option.** `[rule_options."eeat/about-page"] paths = ["/pages/manufaktur"]` makes a crawled page at that path satisfy the rule when no slug convention fits and the page carries no `AboutPage` schema. Patterns use the same forms as `excludePatterns` (substring, `/exact-segment/`, `regex:`), are checked before the built-in slugs, and a configured path that pages link to but the crawl did not fetch is reported as linked but not crawled. `squirrel config validate` flags a `paths` value that is not an array of strings. `eeat/about-page` also recognises the German slugs `/wer-wir-sind` and `/unsere-geschichte`; `/team`, `/agentur` and `/agency` stay out of the built-in list because those pages are often not an About page. (#1261)
- **A start URL the audit cannot run on is refused before any request.** `squirrel audit` and the MCP `audit_website` tool accept only `http://` and `https://` URLs with a host. Anything else (another scheme such as `ftp://` or `file://`, a scheme without slashes such as `mailto:a@b.com` or `javascript:x@y.com`, no host, junk) is refused first: `squirrel audit` exits 1 before any cloud request, no run is registered or charged, and the MCP tool answers `invalid_url` without echoing the URL. A bare `host:port` such as `localhost:3000` still works. Credentials (`user:password@`) and the fragment in a start URL are dropped before anything is crawled, logged, registered or sent to the cloud, with a note on stderr; use `--header` for an authenticated crawl. A URL over 2048 characters is audited but not registered as a dashboard run. The check is shared, so `squirrel crawl` and the cloud runtime also stop sending Basic auth taken from URL credentials.
- **A start URL the audit cannot run on no longer registers a cloud run.** `squirrel audit` and the MCP `audit_website` tool now check the start URL first: only `http://` and `https://` URLs with a host are accepted. Anything else (another scheme, no host, junk) is refused before any cloud request, with nothing registered or charged, and the MCP tool answers `invalid_url` without echoing the URL. Credentials in a start URL are no longer sent in the run registration.
- **`perf/total-byte-weight` leaves lazy images below the initial viewport out of the page weight.** Every `loading="lazy"` image was added to the page total, so a page that loads 1.3 MB was reported at 5.4 MB. Lazy images past the first three content images are now reported separately as `lazyImages` in the details; eager images and lazy images in the initial viewport still count. (#1252)
- **`images/image-file-size` and `perf/total-byte-weight` measure the srcset candidate a browser downloads.** An `<img>` with `srcset` and `sizes` was measured by its `src` fallback, so a 960w fallback was reported although visitors get the 400w file. The audit now selects the candidate at a reference 1280 px viewport and 2x density (largest when none covers it) and measures it; the fallback is still fetched for `images/responsive-size` but is no longer reported or counted as page weight. (#1251)
- **`images/offscreen-lazy` counts the above-the-fold budget in content images.** A header of small icons used up the three-image budget and pushed the first real content image into the below-the-fold set, so top-of-page images were told to add `loading="lazy"`. Images declared with both `width` and `height` at icon or logo size (under 20,000 square pixels) no longer fill the budget or count as below the fold until it is full; undeclared images count as content as before. (#1250)

## v0.0.142 (2026-10-30)

`squirrel audit` follows a start URL that redirects, with your consent, and an unreachable start URL now writes a report and exits 5. Pages with no markup no longer fail every DOM rule, a relative sitemap loc no longer breaks the URL rules, labelled menu sections and label elements are counted correctly, and leaked-secret findings carry the matched value's length and offset.

### Added

- Leaked-secret items now include the matched value's character length and zero-based source offset in `meta`; inline-script items also identify the script's position in the page. Values remain masked in reports. See [Leaked API key in client-side code](https://docs.squirrelscan.com/rules/security/leaked-secrets). (#1230)
- **`squirrel audit` audits where a start URL redirects, not the redirector.** `squirrel audit bit.ly/abc` used to score bit.ly. The start URL's redirect chain is now resolved before anything is crawled, estimated or named, one request per hop through the same egress guard as the crawl, capped at 5 hops. A redirect within one site (`http` to `https`, apex to `www`, a path) is followed silently. A redirect to another registrable domain needs your consent: a terminal asks (`bit.ly/abc redirects to https://example.com/pricing. Audit example.com instead? [Y/n]`), and anything else needs `--follow-redirect` or `[crawler] follow_redirect = true`. Without it the run does not crawl or score the redirector: it exits `4` with a `redirected` report that names the destination, the chain and the command to run again, in every output format. `-y` does not imply the consent, because it approves credit spend and the redirect may land on a site that is not yours. A chain that detours through another domain and back counts as another site. Reports and prompts name each hop by scheme, host and path only, and the destination is audited at its origin and path: its query, fragment and userinfo are dropped, so a destination that needs them has to be audited by typing it directly. The hops are requested before the credit check and registration. A loop, a chain past 5 hops, or a hop into a private, link-local or metadata address also exits `4` and is never followed. A followed redirect is recorded in the report (`meta.originalUrl` and `meta.redirectChain` in JSON, a scan note in the text, markdown, LLM, XML and HTML reports), the project and the credit estimate are the destination's, and the MCP `audit_website` tool answers `confirmation_required` with the destination until called with `followRedirect: true`. See [Start URLs that redirect](https://docs.squirrelscan.com/cli/audit#start-urls-that-redirect). (#1281)

### Fixed

- **A relative sitemap `<loc>` no longer breaks every URL rule.** A sitemap that lists `<loc>/pricing</loc>`, as some sites do, put the path itself into the crawl as the page's URL, and `url/length`, `url/parameters`, `url/slug-keywords`, `url/trailing-slash`, `crawl/pagination` and `schema/website-search` failed `Invalid URL` on every page. Pages are now stored under their absolute URL, a relative `<loc>` is resolved against the sitemap's own URL, and `crawl/sitemap-valid` reports the entries that are not absolute URLs, as the sitemap protocol requires. (#1274)
- **`a11y/form-field-multiple-labels` counts label elements, not references.** A `<label for="a">` that also wraps the control `id="a"` was counted twice and reported as "2 labels", which fires on every Shopify Dawn variant picker. Labels are now collected as a set the way a browser's `input.labels` does: one wrapping-and-`for` label is one label, a wrapping label whose `for` names another control does not label this one, and a wrapping label labels only its first labelable control. Two real labels on one control still warn with an accurate count. (#1249)
- **`a11y/image-redundant-alt` no longer flags a readable alt that spells the filename.** `alt="Google Partner Logo"` on `google-partner-logo.svg` was reported only because both read the same once spaces and hyphens were removed. The filename test now needs the alt to look like a raw filename or slug (a single token, or the decoded filename spelled exactly), so `alt="arrow-downwards"` on `arrow-downwards.svg` still warns and the prefix, surrounding-text and figcaption checks are unchanged. (#1273)
- **A page with no markup no longer fails every DOM rule.** An empty, whitespace-only, comment-only, plain-text or JSON-as-`text/html` response left the parser with a document that has no root, and `document.head` / `document.body` threw, so each rule touching them reported a bogus `Rule error` fail and lowered the score. Such a page now parses like a browser reads it: an empty `<html><head></head><body></body></html>`, with any text in the body. (#1270)
- **A quote, backslash or bracket in an `id` or `for` no longer breaks the label rules.** `a11y/form-labels`, `form-field-multiple-labels`, `select-name`, `aria-input-field-name`, `aria-toggle-field-name`, `aria-meter-name`, `aria-progressbar-name`, `aria-command-name`, `aria-required-parent`, `aria-required-children` and `security/form-captcha` built CSS selectors from page values and threw `Attribute selector didn't terminate`. They now compare attribute values as plain strings, and a guard test fails if a rule interpolates a value into an attribute selector again. (#1276)
- **`meta.auditLevel.settings` says what an `--offline` run did.** It reported the level's cloud defaults (`cloudChecks`, `render: "all"`, `externalLinks`) on every offline report, although nothing was rendered or checked in the cloud. An offline run now records those three as off, with `offline: true` beside them, and `level` and `basedOn` still name the level you asked for. The LLM, markdown, text and HTML outputs say the audit ran offline too. (#1275)
- **An unreachable start URL writes a report and exits `5`.** DNS failure, connect timeout, connection reset or refused and TLS errors used to exit `1` with a line on stderr and no file. With `-f json` (or `xml`, `llm`) the run now writes `{ "status": "unreachable", "statusReasonCode", "statusReason", ... }` to `--output` or stdout, so a batch job can tell a down site from a crash. **Breaking for scripts:** a `blocked` report now always exits `3`, with or without an identified WAF vendor; a bare 403 or 429 used to exit `1`, so a CI step that treats only `1` as failure needs to accept `3` too. See [Unreachable start URLs](https://docs.squirrelscan.com/cli/audit#unreachable-start-urls). (#1269)

## v0.0.141 (2026-10-29)

`squirrel audit --ephemeral` uses cloud features for one run and leaves nothing behind: the site is not added to the dashboard, scheduled or published unless you pass `--publish`. `--store-scripts` keeps the first-party scripts an audit fetched in the content store. Keyword-stuffing checks use the measured copy's own script, leaked-secret checks no longer flag credential key-name constants, and CI now rejects edits to tagged CHANGELOG sections.

### Added

- **`squirrel audit --ephemeral` uses the cloud for one run and leaves nothing behind.** The site is not added to your dashboard, no recurring audits are turned on for it and the report is not published unless you add `--publish`, which publishes an unlisted report attached to no dashboard site. Credits are charged exactly as for the same audit without it, and the run shows in your credit history as an ephemeral CLI run with its domain. `[cloud] ephemeral = true` makes it the default for a project and `--no-ephemeral` overrides that for one run. `--ephemeral --offline` is accepted with a note that offline already saves nothing, the summary says the run was ephemeral, and the MCP `audit_website` tool takes an `ephemeral` argument. If the server does not confirm the run as ephemeral (an older server), the CLI warns that the site may have been added and scheduled and publishes nothing. The default is unchanged: a normal signed-in audit still adds the site and schedules it. See [Ephemeral runs](https://docs.squirrelscan.com/cli/audit#ephemeral-runs). (squirrelscan/repo#3649)
- **`[storage] store_scripts = true` (or `squirrel audit --store-scripts`) keeps the first-party scripts an audit fetched in the content store.** For corpus and research runs that analyse a crawl again later (new secret rules, new technology fingerprints, labelling) without fetching the site again. Each audit indexes its scripts by URL, with the content hash, size, final URL and the pages that load them; identical bundles are stored once; a script over `store_scripts_max_bytes` (default 2 MB) is recorded as skipped with its size, and an audit stores at most `store_scripts_total_bytes` of distinct bytes (default a quarter of `content_store_max_bytes`). The audit's own checks fetch only 10 to 50 of a site's scripts, so with this on it fetches up to `store_scripts_max_scripts` (default 200, at most 500, extra requests only while it is on, bounded to 256 MB of script text and 120 seconds) and warns with how many it left. Off by default: nothing changes unless you set it. Bodies are evicted by the content store's size cap like stored HTML, so raise `content_store_max_bytes` for a corpus. See [Storage configuration](https://docs.squirrelscan.com/configuration/storage#store_scripts). (#1255)

### Fixed

- CI now rejects edits to tagged CHANGELOG sections and directs new bullets to Unreleased (#1234).
- **Leaked-secret checks no longer flag credential key-name constants as values.** A bundle constant such as `DROPBOX_ACCESS_TOKEN: "dropbox-access-token"` is recognised as a storage or configuration identifier, while random credential-shaped assignments still report. (#1228)
- **Keyword-stuffing checks use the measured copy's script instead of trusting `lang`.** English, German, Spanish, French, Portuguese, Italian and Dutch copy is checked with its function-word list. Copy written mainly in another script is not judged against English words, while an unsupported `lang` alone cannot turn the check off. English price-note terms (`incl`, `VAT`) are ignored only on English pages, so they remain detectable elsewhere. (#1232)

## v0.0.140 (2026-10-29)

Technology detection now works offline and reads the first-party script bundles of single page apps, so Lovable, Base44, Replit, v0, Supabase, Clerk and Firebase apps are recognised, and its fingerprint patterns are bounded. `squirrel audit` fails with exit code 3 when a WAF or bot manager serves a challenge or block page, and lists the blocked pages. The installers put `squirrel` on your PATH, and the in-page About and Contact check, the offline seed redirect and the keyword-stuffing check are fixed.

### Added

- Technology detection reports Vercel BotID (Kasada's client served from a Vercel site) as its own technology instead of Kasada, reports F5 BIG-IP from its `BIGipServer` cookie or `Server: BigIP` header, and lists a WAF provider once instead of as both a fingerprint and a `waf-` twin. BotID and the other providers are technologies only: a normal 200 page behind them is never treated as blocked. (#1253)
- **`squirrel audit` fails when a WAF or bot manager serves the audited page a challenge or block page.** Cloudflare, Akamai, DataDome, Kasada, HUMAN, Imperva, Sucuri, AWS WAF, F5, Vercel, Wordfence and Radware are recognised from provider-specific headers and page markers, on the statuses they use (`200`, `202`, `403`, `405`, `429`, `503`). The audit is `blocked` with no score, exits with code `3`, and says the provider, the marker that matched, the status and what to do; the JSON report carries `wafBlocked.seed` with a `blocked_by_<provider>` code. A blocked page that is not the audited one is left out of every rule and the score, counted, and listed in the console, text, markdown, `llm`, `json` and HTML reports. A page that only mentions a vendor, loads its script, or shows a CAPTCHA widget is still audited, and a site with real content behind a WAF still gets the "uses protection" warning. See [blocked by a WAF or bot manager](https://docs.squirrelscan.com/guides/failed-audits#blocked-by-waf). (#1253)
- **The installers put `squirrel` on your PATH.** `install.sh` keeps its directory choice (`SQUIRREL_BIN_DIR`, then the first of `~/.local/bin`, `~/bin`, `/usr/local/bin`, `/opt/homebrew/bin` already on PATH and writable), else uses `~/.local/bin` and appends one marked line to the file your shell reads (`~/.zshrc`, `~/.bash_profile` on macOS bash, `~/.bashrc` on Linux bash, `~/.config/fish/conf.d/squirrel.fish`, `~/.profile`), once, never rewriting existing content. When your current shell cannot find `squirrel` yet, the closing message says so first and gives a command that works right now. `install.ps1` adds the bin directory to the user `Path` and the session. `SQUIRREL_NO_MODIFY_PATH=1` opts out; CI never edits a profile (and appends to `GITHUB_PATH` when set). The install registration reports the outcome as `path_setup`, and `squirrel self install` no longer prints its own "not in your PATH" block after an installer handled PATH. See the [quickstart](docs/quickstart.mdx).
- Technology detection recognises Lovable, Base44, Replit and v0 apps, and the Supabase, Clerk and Firebase client SDKs. Each reads only what a stored page holds: generator and author meta tags, platform script URLs, app hosts such as `*.base44.app` or `*.replit.app`, inline client config, and storage image URLs. A page that only mentions a product, links to one of its assets or shows its code in a sample does not match, and a Base44 app is not also reported as Supabase for the shared storage it loads images from. The existing Firebase Hosting signature is unchanged. See [Technology detection](https://docs.squirrelscan.com/cloud/technologies). (#1242)
- **Technology detection reads the script bundles of single page apps.** A Vite, Lovable, Bolt or Next.js app ships a near-empty HTML shell and keeps its libraries in `/assets/*.js` or `/_next/static/chunks/*`, so stacks such as Supabase, Firebase and Clerk were missed where they are most common. Detection now reads up to 64 KB of each first-party bundle (512 KB per page, 1 MB per audit): the first 16 KB of every script, then the text around vendor markers and the end of the file, where a bundled app's own code sits, then more of the start. It uses the bytes the crawl already fetched for the secret rules: no extra request. A bundle matches only on real code (a Supabase project URL passed with a key, a Firebase `authDomain` or `storageBucket`, a Clerk `publishableKey`), not on a comment, a string or a placeholder. Signed-out and `--offline` audits run the same detection locally, and the cloud call sends the same bundle bytes, so both report the same stack for the same crawl. A scan stops at a 5 second budget per page. `[tech_detect] bundle_bytes` changes the per-bundle cap (`0` turns bundle matching off). See [Technology detection](https://docs.squirrelscan.com/cloud/technologies#script-bundles). (#1254)

### Fixed

- A challenge a provider served with a `429` (Kasada's is one) is no longer retried and reported as rate limiting, and a challenge served as `200`, `202` or `405` is no longer stored and audited as the site. (#1253)
- **Keyword-stuffing checks measure substantial main copy instead of site chrome.** The largest main landmark is used when it has at least 100 words; otherwise the body is measured without site-wide header, navigation, footer and sidebar boilerplate, while article-local landmarks stay in the copy. Unicode words such as `gemäß` stay whole, unsegmented Han, Kana and Hangul runs are not scored, and repeated German and English price-note terms are ignored. (#1182)
- `perf/lcp-hints` no longer flags the eager images below a preloaded hero. A page has one LCP element, so one preloaded likely-LCP image satisfies the check; with no image preload it warns once, `Likely-LCP image loaded without preload`, naming the first candidate instead of counting each eager image. See [perf/lcp-hints](https://docs.squirrelscan.com/rules/perf/lcp-hints) (#1221).
- `core/charset` no longer warns about a charset meta past the first 1,024 bytes when the `Content-Type` header already names the same UTF-8 charset. The header decides the decoding, so the position is a conformance note: it is now info and does not affect the score, and its message says so. A page with no header charset still warns, a header that conflicts with the meta still gives the conflict warning, and a non-UTF-8 page still gets the non-UTF-8 warning. See [core/charset](https://docs.squirrelscan.com/rules/core/charset) (#1220).
- Technology detection no longer stalls on a page that repeats an unclosed tag. The RequireJS signature took about 70 s on a 1 MB page of `<script ` repeats, and 14 other signatures (Bulma, Foundation, Semantic UI, Materialize, Animate.css, Plausible, Fathom, Facebook Pixel, RudderStack, Dynatrace, Didomi, Ensighten, Yotpo, UserWay) took up to several seconds on the same kind of input. Their patterns now have bounded windows, and a test runs every signature against input built from its own leading text. (#1244)
- `squirrel audit --offline` now treats a non-localhost start URL that redirects off-site as reachable, so the crawl can record the redirect instead of stopping at the preflight probe with `refused: host outside the allowed set`. This also covers link-shortener and sibling-host redirects. (#1224)
- `eeat/about-page` and `eeat/contact-page` now recognise an in-page About or Contact section in a real audit. The v0.0.139 change (#1208) only worked where a page's DOM was still available, which the streaming engine, the one the CLI and the cloud run, does not provide to site rules, so a one-page site still read "No About page found". The section is now collected from each page while its DOM is live. An engine-level test runs the one-page fixture through the streaming engine (#1236).

## v0.0.139 (2026-10-28)

A TLS certificate rule, one-page site detection, in-page About and Contact recognition, report hosts that can serve published reports from their own domain, and free audits that render 2 pages at once.

### Added

- New rule `security/tls-certificate` reads the TLS certificate of the audited site's host and its www or apex counterpart, one handshake each, and reports its expiry (a warning inside 30 days, an error inside 7, set by `warn_days` and `error_days` under `[rule_options."security/tls-certificate"]`), whether it covers the hostname, whether it has a complete chain to a trusted root, whether it is self-signed, and whether an RSA key is under 2048 bits. The counterpart exists only for a registrable domain and its `www.` name, on the same port; other subdomains have none. Every handshake is checked like the crawl's own hosts: the name is resolved once, a link-local or cloud metadata answer is never contacted, the counterpart of a public site must resolve to a public address, and the connection goes to the address that was checked. With `--offline` only the audited host is contacted. A host the rule cannot read is reported as not checked with the reason, never as a pass, including behind an HTTP proxy from the environment, and local or private-network hosts are skipped. When a page fetch fails on a TLS error, the failure now names the cause one handshake found, such as an expiry date or a missing intermediate, waiting at most 3 seconds per host. See [TLS certificate](https://docs.squirrelscan.com/rules/security/tls-certificate). squirrelscan/squirrelscan#712
- **`crawl/single-page-site`.** When the whole site is one page with sections, the audit now says what that means for search: one URL to rank or cite, one title and one description, and `#sections` that cannot be indexed on their own. It fires only on a complete crawl that fetched exactly one HTML page, has at most one in-scope sitemap URL, no link to another path on the site, and three or more links to ids on the page, and lists up to ten section ids. It is informational and never changes the health score or a category score. When it fires, the editor's summary request carries `coverage.singlePageSite` and `coverage.sectionCount`. See [crawl/single-page-site](https://docs.squirrelscan.com/rules/crawl/single-page-site).
- **Report hosts can serve published reports from their own domain.** `renderHtml` takes `reportUrl` (the `og:url`, `og:image`, agent `.md`/`.json` links and a `<link rel="canonical">`) and `techIconBaseUrl` (where technology logos load from), and `reportInlineScripts()` lists the HTML report's inline scripts so a host can pin them with a hash-based Content-Security-Policy. Reports from the CLI are unchanged (squirrelscan/repo#3182).

### Changed

- **Free audits render 2 pages at once, up from 1.** One page at a time made a scheduled free audit's crawl take about 3 minutes, against about 50 seconds before render width became per plan. Pro (5) and Team (10) are unchanged.

### Fixed

- `eeat/about-page` and `eeat/contact-page` recognise an in-page About or Contact section on a single-page site: an element whose id matches the page slugs (`#about`, `#contact`, localised ones) and a same-page link to it. No more "No About page found" on a one-page site that has both. An About section needs 200 words to pass; a Contact section needs a `mailto:` or `tel:` link or a form. A real `/about` or `/contact` page still takes precedence. See [eeat/about-page](https://docs.squirrelscan.com/rules/eeat/about-page) (#1208).

### Docs

- **The SEO rules page counts 26 structured data rules.** The card still said 25 after `schema/expected-type` was added.

## v0.0.138 (2026-10-28)

The bundled page classifier and the findings built on it: link findings say where on the page a link sits, a defect in a shared component reads as one fix-once line, reports carry a Page structure block, and `schema/expected-type` and a sharper `schema/breadcrumb` use the page type. First-run telemetry and an audit offer at the end of `squirrel setup`, with `DO_NOT_TRACK` honoured. The Markdown report no longer lets crawled text add links or images, and keeps ordinary text readable. A page of thousands of comment-class containers can no longer stall the classifier.

### Added

- `schema/expected-type` flags a page that the bundled page classifier is sure about and that declares none of the structured data its type should carry: `Product` on a product page, `Article` or `BlogPosting` on an article or blog post, `CollectionPage` or `ItemList` on a listing, `ContactPage` or an organization type on a contact page, `AboutPage`, `Person` or an organization type on an about page, and `TechArticle`, `HowTo` or `FAQPage` on documentation. It trusts only the model's answer, at 0.9 confidence or above (`min_confidence` sets it), never a type read from the page's own markup. A page that declares a listing type is not asked for article or product markup. With `--no-classifier` it reports nothing. See [schema/expected-type](https://docs.squirrelscan.com/rules/schema/expected-type).
- **First-run telemetry.** `squirrel setup` reports each step's outcome (`step:outcome`, no free text), `squirrel auth login` reports completion, and the first audit on an install reports success or a failure class once. After login, telemetry carries your login session so the API can attribute events to your user ID; nothing is sent when telemetry is off, and no URL, host, path or email is ever included. The one-time install registration also reports `cpu_translated` and `hw_arm64` (macOS only, from `sysctl`), so real Intel Macs can be told apart from Rosetta shells. Telemetry now also honours `DO_NOT_TRACK=1` (or `true`) and a project-level `"telemetry": false` in `.squirrel/settings.json` (an unreadable project file counts as opted out), and the installers honour `DO_NOT_TRACK` for their failure report. Existing installs see the updated telemetry notice once more. Listed on the [telemetry](docs/cli/self.mdx) docs.
- **First audit right after install.** The installer's closing message now leads with `squirrel audit https://your-site.com` and lists `squirrel setup` second. `squirrel setup` ends by asking for a site URL and offering to run the audit now (yes runs it; enter skips). With no TTY, in CI or an agent, with `--yes` or `--dry-run`, it never asks and prints the command instead.

### Changed

- Noindex pages no longer affect `content/thin-vs-site-norm` on an indexed site: they are left out of each page type's median and cannot be reported as thin outliers. The check details count the pages left out. A staging or preview site whose homepage is noindex still checks every page. See [Thin against your own site](https://docs.squirrelscan.com/rules/content/thin-vs-site-norm) (#1029).
- Where the markup says nothing, a small page classifier bundled with squirrel (about 9 MB, no network call), names the part of the page: the header, footer, navigation, sidebar or page content, and sections such as the pagination, breadcrumbs, a related-content block, the business details, the social sharing links, the account and login links, the author byline and the newsletter signup. The header, the footer and comment threads in the markup always win, comment threads stay markup-only, and a section the classifier names refines a navigation or sidebar landmark. Each page also stores the classifier's page type, and only a page at the root path is ever labelled `homepage`. `squirrel self doctor` shows the artifact and its load time. It can be wrong: on a single article the previous and next post links can read as pagination, a "follow us" row of profile icons can read as social sharing links, and the comments label comes from markup only. Switch it off with `--no-classifier` or `[classifier] enabled = false` and link sections come from markup alone. The weights are `treetop-pagetype-v1`, MIT licensed like the rest of the repository.
- `schema/breadcrumb` fails a page that shows a breadcrumb trail and declares no `BreadcrumbList`: at least one link the page classifier places in the breadcrumbs section, and no schema. A page without that signal gets the same info check as before. The rule's severity is now warning, so its `warn` checks (a `BreadcrumbList` with no items, or positions out of order) count toward the warning totals instead of being advisory. See [schema/breadcrumb](https://docs.squirrelscan.com/rules/schema/breadcrumb).
- Reports now include a Page structure block. It counts the links in each part of the audited pages (header, footer, navigation, sidebar, page content and more), shows what share of internal links is site furniture rather than page content, and counts how many pages the classifier calls product pages, blog posts, contact pages and so on. The console, text, Markdown and LLM reports print it in a new Report detail section at the very end, after the issues, the HTML report shows it as a Page structure section after the site details, and the JSON and XML reports carry it as data. In the console, text, Markdown and LLM reports the not-checked notices and the scan notes that used to sit under the title (rate limiting, scan scope, coverage and the like) moved into that section too, as a list; the HTML report keeps its notices at the top. It is informational and never scored. A report built from an older crawl has no block, so audit again to see it. See [Report detail](https://docs.squirrelscan.com/configuration/output#report-detail).
- `links/no-contextual-inbound` says where the links to a chrome-only page sit. An item reads `https://example.com/pricing, linked only from the footer and the navigation` and carries `meta.sections` counts. Links in a post's own footer that the page treats as content are counted apart (`, and 22 template links inside the page content`), never named as a place the page is linked from. A crawl whose links have no section keeps the plain item. See [links/no-contextual-inbound](https://docs.squirrelscan.com/rules/links/no-contextual-inbound).
- `links/broken-links` says where on the page a broken internal link sits (the footer, the navigation, the comments, the page content), from landmarks and comment-thread markup. Each item also carries `meta.sections` counts. So do the items of `links/anchor-text`, `links/broken-anchors`, `links/broken-external-links`, `links/https-downgrade`, `links/invalid-links`, `links/nofollow-internal`, `links/redirect-chains`, `links/tel-mailto` and `links/weak-internal-links`, each with a docs sentence on its rule page. A crawl whose links carry no section keeps every item as it was.
- A broken link lists each page that carries it once, with how many of that page's links point at it and where on the page they sit: `from: /about (2 links, in the page content)`. A page that linked a broken target twice used to be listed twice. The summary counts links and pages apart (`1 broken internal link(s) (4xx/5xx), found on 3 pages`), and `meta.linkedFrom` now counts pages. The HTML report expands a long list of pages inside the item, and the other formats say how many pages they leave out (`+4 more pages`) instead of pointing at a list above that never held them. The same holds for `links/broken-external-links`, `links/broken-anchors` (same-page links count every repeat) and the `links-to-redirect` check of `links/redirect-chains`. The JSON report carries the per-page detail as `sources` (`page`, `links`, `sections`), and the XML report as a `links` count and `<section>` elements on each source page, where it also writes item metadata such as `sections` as JSON instead of `[object Object]`. See [source pages](https://docs.squirrelscan.com/configuration/output#source-pages). #837
- A finding in a part of the page every page repeats (the site header, footer or navigation, a sidebar, the breadcrumbs, the pagination, or the newsletter signup, social share, business details or account links) names the region instead of listing every page: the same generic link text in the header of a 120-page site reads `In the site header, on 120 of 120 pages`, a stale footer copyright year reads `In the site footer, on 148 of 150 pages`, and a link to a redirecting docs page in the breadcrumbs reads `In the breadcrumbs, on 14 of 14 pages`. A finding is shown this way when it is in the region on at least 80% of the pages that have that region (counted against those pages, not every page) and on at least 2 pages; pages where it is elsewhere are listed under the line, and its label drops the `linked in the footer` phrase the line already says. The Markdown, text, LLM and console reports drop the page list for it, the HTML report keeps every page behind a collapsed list, and the JSON and XML reports keep the bounded list and add `scope` (`region`, `pages`, `regionPages`, `otherPages`). A finding in the page content, in a region on few pages, or in a report without page structure data keeps its page list. `a11y/link-text` now records where each flagged link sits, matched to the page's link placements, and it, the link rules and `content/stale-copyright` (the footer) carry the pages per section as `regions`. Detection, severities and scores are unchanged. See [findings in a shared page region](https://docs.squirrelscan.com/reports#findings-in-a-shared-page-region). #846
- A finding on every page of one page type says so instead of listing the pages. The expected-schema check on a site with a documentation section reads `On all 9 documentation pages`, or `On 9 of 11 documentation pages` when it is most of them, in place of nine rows with the same template behind them. A finding is shown this way when all its pages are one page type, it is on at least 2 pages, and they are at least 80% of the audited pages of that type (counted from the Page types in the report's page structure block, not every page). The Markdown, text, LLM and console reports print the line and no page list, the HTML report keeps the pages behind a collapsed list, and the JSON and XML reports keep the bounded page list and add `scope` with `pageType`, `pages` and `typePages`. A finding on mixed types, on one page, below the share, or in a report with no page structure keeps its page rows. Only `schema/expected-type` is covered today. The Page types line now says "documentation pages" and "listing pages" where it said "docs pages" and "index pages". See [schema/expected-type](https://docs.squirrelscan.com/rules/schema/expected-type). #857
- **The bundled agent skills are squirrelscan 1.21 and audit-website 2.7.** The squirrelscan skill now covers confirming website ownership over MCP, paused recurring audits and the off-site redirect follow-up.

### Fixed

- **The Markdown report keeps ordinary message text readable.** The escaping added for crawled text also wrote `\(`, `\)` and `\!` into plain sentences (`Title is 72 characters \(recommended: 30-60\)`). Brackets, backticks, `<`, `|`, a backslash, an entity-shaped `&` and a leading block marker are still escaped, which is what stops a link, image, tag or heading from forming; parentheses, `!`, a mid-sentence `>` and a bare `&` are left as written.
- **A page of thousands of comment-class containers can no longer stall the classifier.** Each container with a heading under it was checked against every `<h1>` on the page, so 40,000 of them cost 8 seconds of CPU. The check now marks the ancestors of each heading once and costs the nodes it touches.
- **Backslashes no longer make a non-root URL look like the homepage.** The page classifier's root-path rule now uses the platform URL parser, which treats a backslash as a path separator for web URLs and rejects malformed input instead of classifying it as the site root. (#903)
- **The install channel now reaches install registration.** `squirrel self install` skips startup extras, so `SQUIRREL_INSTALL_SOURCE` was gone by the first command that registers the install and every install reported `binary`. `self install` now persists the validated value (`^[a-z0-9-]{1,32}$`, anything else is dropped) and registration sends it. install.sh stamps `install-sh` when no source is set.
- **Installer failure reports name the host when curl cannot connect.** A curl failure under `set -e` (exit 6, 7, 28, 35, 52 or 56) reported only its code, so 82 identical reports could not be told apart. The anonymous report now carries `curl exit N reaching <host>`: the host only, never a path, query or credentials.
- **The editor summary digest of a capped published report counts every issue.** A rule with more than 25 issue classes lost the rest from its occurrence count, so a summary built from the stored report could under-count and re-rank issues against the one built from the full report. The digest now takes the true counts from the report's check tallies.

### Security

- **A crawled page can no longer add links or images to the Markdown report.** `squirrel report --format markdown` and `squirrel audit -f markdown` now escape the text the audited site controls: the pages in a check's page list (the path shown and the link), item labels and the pages an item was found on, check messages and names (which can quote the page, such as an ad URL or a misspelled word), the Entities section's names, ids and values from the site's JSON-LD, the site profile, a partial audit's reason, the audited URL line, and a detected technology's name and version. Before, a page whose path held `](`, `)` or `![` closed the page link early and added a link or a remote image of the site's choosing to the report a reader opens, and a label could open a heading or a list of its own. A stored report's generator version now prints on the scan line only when it looks like a version (squirrelscan/repo#3522).

### Docs

- **The Performance rules page counts 5 Reliability rules.** The card said 2 after the broken-link rules moved into the category.
- **Rule-option examples use the table the CLI reads.** Fourteen rule-reference pages now put per-rule settings under `[rule_options."<id>"]`, not the ignored `[rules."<id>"]`. The docs check rejects the ignored table so copied examples keep changing audit behavior. (#1176)
- **The failed-audits guide covers the dashboard for an off-site redirect.** Audit the destination instead, or move the website there, and undo a move within 20 seconds. See [failed audits](https://docs.squirrelscan.com/guides/failed-audits#offsite-redirect).
- **Scheduled audits are documented as belonging to the organization.** A schedule outlives the member who set it up, and Settings > Schedule names who did. See [scheduled audits](https://docs.squirrelscan.com/cloud/scheduled-audits).

## v0.0.137 (2026-10-28)

`squirrel audit --offline` now sends nothing to another site (redirects, sitemaps, assets and probes stay on the audited site), a failed audit whose start URL redirects elsewhere prints the command for the destination, broken-link rules move to the Reliability category, and the MCP SDK moves to 2.4.0 for its bundled fast-uri fix.

### Added

- **A failed audit whose start URL redirects to another site says what to run next.** The terminal prints `Audit the destination instead: squirrel audit <origin>` under the failure, and the `llm` format offers the same command for the user to confirm instead of retrying the URL that redirects. When the destination is a sign-in host (Cloudflare Access, Okta, `accounts.shopify.com` and the rest of the documented list), it says the site needs authentication and links the guide, with no command. Only the destination's origin is offered, never the redirect's path or query. See [redirected to another site](https://docs.squirrelscan.com/guides/failed-audits#offsite-redirect).

### Changed

- Broken links are reported as a reliability problem, not an SEO one. `links/broken-links`, `links/broken-external-links` and `links/broken-anchors` move from the Links category to Reliability, so they no longer count toward the SEO score. Reliability rolls up into the Performance score, which now carries them. Their badge on the HTML report reads **Reliability**, as do the badges of `reliability/broken-resources` and `reliability/broken-forms`, which used to read Performance. The rule ids keep their `links/` prefix, so configs, `links/*` patterns, `rule_options` and docs links keep working. `reliability/*` does not select the three rules, so list them by id to disable them with it. `squirrel report --category reliability` now includes them, and a report stored before this release keeps them under `links`. See [Reliability](https://docs.squirrelscan.com/rules/reliability).

### Security

- **The MCP SDK moves to 2.4.0, which bundles `fast-uri` 3.1.8.** The SDK ships its own copy of `fast-uri`, so the root override could not reach it and `bun audit` could not see it: 2.3.1 carried 3.1.0, which has the host-confusion advisory (a backslash as the authority delimiter). It is reachable only through JSON Schema `$ref` parsing in the SDK, whose schemas are squirrel's own, and now matches the override. The bundled `ajv` stays at 8.18.0, which has no advisory. The notices list the embedded `fast-uri` version (#656).
- **`squirrel audit --offline` now sends nothing to another site.** The site's own hosts are the audited host, its `www` or apex twin, `[project] domains` and the subdomains of all of them. A page redirect to another host ends there (the page is recorded as the redirect it answered with), a sitemap that robots.txt names on another host is not requested (`crawl/sitemap-exists` and `crawl/sitemap-valid` say it was skipped, not missing), a stylesheet, script, image or font on the site that redirects off it is not followed (`reliability/broken-resources` reports it as not requested), and the soft-404 confirmation, the cloaking probe and the AI agent access probe stay on the site. Assets on the `www` or apex twin or on a `[project] domains` host are checked like the site's own. Before, an offline audit still followed those hops to whatever host the site named. See [Fully offline audit](https://docs.squirrelscan.com/cli/audit#fully-offline-audit) (#819).

### Docs

- **The docs say what the smart-audit coverage counts mean.** "Audited", "known" and "carried" are defined on the [configuration page](https://docs.squirrelscan.com/configuration#smart-audits): known pages are the ones with an active page record, carried findings are keyed by URL and do not expire until the page is re-crawled or removed, so a report can carry findings from a page whose record is missing from the store while known equals audited (#1031).
- **Broken link alerts are documented.** What triggers the email (scheduled audits only, internal 404 and 410 and confirmed external links), what never counts, the switches, plans, the MCP `list_notifications` category and the notification webhook. See [emails](https://docs.squirrelscan.com/dashboard/emails#new-broken-links).
- **Schedules that pause after repeated failures, the `api_deadline` failure code and browser notifications are documented.** See [scheduled audits](https://docs.squirrelscan.com/cloud/scheduled-audits), [failed audits](https://docs.squirrelscan.com/guides/failed-audits) and [notifications](https://docs.squirrelscan.com/dashboard/notifications).

## v0.0.136 (2026-10-27)

The CLI now checks the audited site's own hostnames before it connects, so a name that resolves to a cloud metadata or link-local address is never requested. Set SQUIRREL_NO_HOST_PINNING to turn the check off on a network where connecting by address breaks routing.

### Security

- **The CLI checks the site's own hostnames before it connects.** The audited host, its `www` twin and the domains in `[project] domains` went out by name with no address check, so a site that controls its DNS, or rebinds it mid-audit, could point one of them at a cloud metadata service and the audit would request it and store the answer. The CLI now checks every answer for them and connects to the address it checked, for pages, redirect hops, root files, the start URL's reachability check and redirects, assets and the end-of-crawl probes, in `squirrel analyze` too; a link-local or metadata answer is never requested (a page is recorded as failed with "Not requested", an asset as refused). Two rule probes still go out by name: the `security/http-to-https` `HEAD` request and the GraphQL probes of an active or aggressive probing intensity. Behind an HTTP proxy from the environment, or with `SQUIRREL_NO_HOST_PINNING` set, every request goes out by name as before. See [follow_redirects](https://docs.squirrelscan.com/configuration/crawler#follow_redirects).

### Docs

- **`compare_audits` says when a rule could not be checked.** A rule the newer audit could not run is reported as `not_checked`, not as resolved. See [MCP](https://docs.squirrelscan.com/developers/mcp).
- **The rule-count tables match the 311 rules.** The README and the docs index list Images 16 and Content 25.
- **The AI-agent guide no longer states a tool count** that goes stale.

## v0.0.135 (2026-10-27)

Robots.txt groups are read the way crawlers read them when a Sitemap line sits between User-agent lines, a redirect with a Location that cannot be parsed no longer fails a crawl, the egress guard refuses two more cloud metadata addresses, and a custom user-agent header now reaches the link check and the soft-404 confirmation. Two new info rules: images/hotlinked and content/h1-title-alignment.

### Added

- images: new rule `images/hotlinked` reports, as info, a content image (`<img>`, `<picture>` source, inline `background`) that loads from another site's server, grouped per host. First-party hosts, known image CDNs and site-builder storage, launch and badge directories, tracking pixels and avatar services are not reported, and `allowed_hosts` adds your own. An `og:image` or `twitter:image` on another site is reported too (#932).
- content: new rule `content/h1-title-alignment` reports, as info, a page whose H1 and `<title>` share no meaningful word (stopwords, generic words, stemming and the brand affix are read out; both strings are shown, and `details.confident` marks the stricter cases). It is info only because a minority of such pages (roughly 10 to 20 percent by hand judgement) are real mismatches; the rest are marketing headlines. Homepages and generic marketing pages, identical title and H1, and pages with no or several H1s, noindex pages, titles that are only the brand, glued or non-Latin text and languages without a stopword list are read as info or skipped (English, Spanish, French, German, Portuguese, Italian and Dutch are read) (#929).

### Changed

- **Cloud API: an API key missing a scope gets the typed error envelope.** The `403` is now `{ "error": { "code": "missing_scope", "message": "API key missing required scope: audits:write", "missing_scope": "audits:write" } }` instead of a bare string `error`, so a client can switch on the code. See [Refusals for a role or a scope](https://docs.squirrelscan.com/developers/authentication#refusals-for-a-role-or-a-scope).

### Fixed

- `-H "user-agent: ..."` (or a `User-Agent` in `[crawler] headers`) is now also the agent of the internal link check and the soft-404 confirmation, which send no other custom header. They used to send the crawl's random browser agent beside a crawl that sent yours. The reachability check, the cloaking probe and the AI agent access probe still use their own agents on purpose. See [crawler headers](https://docs.squirrelscan.com/configuration/crawler) (#1152).
- **A role or scope refusal is explained in either shape the cloud sends.** `squirrel audit` (the run is not tracked) and `squirrel report --publish` name a `forbidden_role` refusal in the typed `error: { code, message }` envelope as well as the bare `error: "forbidden_role"`, and an API key missing a scope (`missing_scope`) says which scope a key needs. Before, only the bare shape was recognised.
- **A redirect whose `Location` cannot be parsed no longer fails the whole crawl.** A `Location: http://[` threw inside the page fetch, the error escaped as a crash, and the audit stopped. That page now ends its redirect chain like a redirect with no `Location`, and the crawl goes on. The plain fetcher, which rejected the whole fetch with "Invalid URL", does the same.
- `squirrel audit` with `-f json`, `xml`, `llm`, `markdown`, `text` or `html` sends its progress and log lines ("New crawl: ...", "Found N URLs in sitemap") to stderr, so stdout starts with the report and `squirrel audit <url> -f json | jq` works. The console format is unchanged.
- robots.txt groups are read the way RFC 9309 and Google read them when a `Sitemap`, `Crawl-delay` or unknown line sits between `User-agent` lines: the group continues, so `User-agent: GPTBot`, `Sitemap: ...`, `User-agent: CCBot`, `Disallow: /` blocks both bots. Before, the second `User-agent` started a new group and the first bot was read as unlisted. A file with CR-only line endings is read too, where before it parsed as empty. AI crawler, indexability and crawl-delay checks read these files the way crawlers do, in the CLI and in cloud audits.
- `squirrel audit -f <unknown>` exits 1 with "Unknown format", like `squirrel report -f`, before crawling. Before, it ran the whole audit, printed no report and exited 0.

### Security

- **A robots.txt built to multiply no longer exhausts memory.** Each group's rules are given to every user agent that heads it, so a file of a few thousand stacked `User-agent` lines over a few thousand rules, or over one very long rule, inside the 512 KiB fetch limit, grew to hundreds of millions of entries or gigabytes of rule text and could take down a CLI audit or a cloud audit container. The parser now keeps at most 100,000 directive entries and 2 million characters of rule paths, in file order, still collects the `Sitemap` lines after that, and records that the rest of the file was not read, which the `crawl/robots-txt` syntax check shows. Page checks against robots.txt also work out each rule's pattern once instead of once per page.

- **The egress guard refuses GCP's IPv6 metadata server (`fd20:ce::254`) and the EKS Pod Identity agent (`fd00:ec2::23`)**, as literals and as DNS answers, beside AWS's `fd00:ec2::254`. They sit in the unique local range, so an audit on a private network used to let a redirect reach them. Other unique local addresses stay allowed.

### Docs

- **The crawler page states the trusted-hostname residual.** The audited host, its `www` twin and every subdomain of `[project] domains` are requested by name without an address check, so a site that controls its own DNS can point them at a metadata address. The page says how to audit untrusted sites safely; cloud audits are not affected. See [follow_redirects](https://docs.squirrelscan.com/configuration/crawler#follow_redirects).

## v0.0.134 (2026-10-26)

Robots.txt is read the way crawlers read it, a redirect can no longer steer a crawl at a private address, and nested pages stop being slow.

### Added

- **`[crawler] robots_user_agent` sets the token robots.txt groups are matched against.** It defaults to `SquirrelScan`. See [robots_user_agent](https://docs.squirrelscan.com/configuration/crawler#robots_user_agent) and the behavior change under Changed.
- **`social/og-image-size` checks image formats.** It reads the format of an Open Graph or Twitter card image from `og:image:type` or the file extension, without fetching it. SVG warns because preview clients may not render it, AVIF is recorded as an info check because support is inconsistent, and JPEG, PNG, GIF and WebP pass. `twitter:image` is recognized as `name` or `property`. See [og:image size and format](https://docs.squirrelscan.com/rules/social/og-image-size).
- **`crawl/robots-txt` reports search crawler delays.** A `Crawl-delay` of 10 seconds or more for `*` or Bingbot warns and estimates how many URLs a day Bing can then fetch, and says that Google ignores the directive while Bing and Yandex obey it. Every crawler named in a stacked `User-agent` group is checked. A shorter delay, or one for Googlebot, MSNBot or Yandex, is recorded as an info check. Zero delays and delays for other bots are ignored. See [robots.txt](https://docs.squirrelscan.com/rules/crawl/robots-txt).
- **`i18n/hreflang` checks language and region codes.** A value that is not `x-default` or a valid language and region code warns, such as `en_US` (use a hyphen) or `en-uk` (the region is `GB`). It checks the code format only, not return links.

### Changed

- **A crawl that respects robots.txt now follows a site's `User-agent: SquirrelScan` rules.** The docs already said so. Before, the default browser user agent was matched by its first token, `Mozilla`, so in practice only the `*` rules applied. Requests still send `user_agent`. If you set `user_agent` to your own bot and respect robots.txt, the crawl is now matched as `SquirrelScan` too: set `robots_user_agent` to that bot's token, or to `""` to match on `user_agent` as before.
- **Config validation runs on zod 4.** The same settings are accepted.
- **`install.sh` and `install.ps1` check release metadata first.** The version, asset filename and SHA-256 are validated before any download URL is built, so malformed metadata cannot retarget the download. A checksum matches in either letter case. See [Installation](https://docs.squirrelscan.com/getting-started/installation).

### Fixed

- **A viewer or billing member who runs a signed-in audit is told why it was not tracked.** The organization's role refused it (`forbidden_role`). The run used to be missing from the dashboard with no word, and a publish failed with an error that had no message. The local audit and its results are unchanged. See [Publishing to the dashboard](https://docs.squirrelscan.com/cli/audit#publishing-to-the-dashboard).
- **`a11y/identical-links-same-purpose` respects labelled menu sections.** Identical link text in separately labelled sections is no longer grouped together when the context comes from `aria-label`, `aria-labelledby` or a parent list item's leading link. Repeated text in the same context still warns.
- **robots.txt groups are parsed as RFC 9309 describes.** Consecutive `User-agent` lines share the rules that follow them, a named group with an empty `Disallow:` explicitly allows every path and no longer falls through to `*`, and inline comments are ignored. AI crawler and indexability checks now match how crawlers read those files.
- **A `Crawl-delay` that is negative or too large to be a number is ignored**, such as `-1` or `1e999`, like one that is not a number. A published report no longer carries it as a negative value or as `null`.
- **A crawl that stops at its page cap no longer makes link rules look clean.** `links/orphan-pages`, `links/weak-internal-links` and `links/no-contextual-inbound` skip, because an uncrawled page may hold the inbound links that would clear them. They show as **Not checked** with a hint to raise `--max-pages`, and a finding one of them reported on an earlier audit is not closed by a capped crawl. See [output](https://docs.squirrelscan.com/configuration/output).
- **A cloud audit uploaded in parts is scored like one uploaded whole.** The server used to count every page a rule skipped, and every rule that checked no page, as a pass, so a large audit could score a few points above the same crawl run locally, with categories such as video or local at 100. It now scores from the per-check counts the audit publishes, as [Rules that do not apply](https://docs.squirrelscan.com/reports#rules-that-do-not-apply) describes.
- **A cloud smart audit no longer carries an older run's rule timeout or error onto a page it did not re-audit.** A fresh error from the current run still reports.
- **Deeply nested pages no longer slow an audit down.** Each link's place in the page (header, navigation, footer, content) is worked out once per page, not by walking up the tree for every link: a page with 20,000 nested links went from 12.5 s to parse to 250 ms ([benchmark](https://github.com/squirrelscan/squirrelscan/blob/main/benchmarks/2026-10-parse-depth.md)).
- **Nested tables are judged one table at a time, and fast.** `a11y/th-has-data-cells` and `a11y/td-headers-attr` treat a table inside another table's cell as its own table, so a bad `headers` reference there is reported once, not once per enclosing table. These two and `a11y/table-headers` no longer slow down on deep nesting: 200 nested tables took `th-has-data-cells` 1.4 s and now take 1 ms. `a11y/link-in-text-block` counts a link in nested lists or quotes once, and 5,000 nested quotes went from 827 ms to 3 ms ([benchmark](https://github.com/squirrelscan/squirrelscan/blob/main/benchmarks/2026-10-a11y-nested-tables.md)).
- **A `colspan` or `rowspan` of `Infinity` no longer hangs `a11y/th-has-data-cells`.** It used to run until the audit ran out of memory. It now counts as 1, and a span past the HTML limits counts as the limit.
- **`a11y/aria-text` and `a11y/aria-hidden-focus` are fast on pages that nest many `role="text"` or `aria-hidden` elements.** Each rescanned its whole subtree for every nested element: 1,000 nested `aria-hidden` containers took 56 s and now take 22 ms. The findings are unchanged ([benchmark](https://github.com/squirrelscan/squirrelscan/blob/main/benchmarks/2026-10-a11y-nesting.md)).
- **A custom header that differs only in case from one squirrel sets now replaces it.** `-H "user-agent: ..."` or `accept` in `[crawler] headers` applies to page fetches, robots.txt, sitemaps, llms.txt, the well-known and RSL probes and asset checks. Before, both went out as one combined value such as `squirrel/..., my-agent`. A `-H` flag also wins over a `[crawler] headers` entry with the same name in another casing. The cloaking probe's Googlebot fetch keeps its Googlebot agent when a custom `User-Agent` is set, so agent-based cloaking can show again, and the markdown probe keeps its `text/markdown` `Accept`. See [headers](https://docs.squirrelscan.com/configuration/crawler#headers).
- **A second `audit --resume` or `crawl --resume` no longer writes into a crawl a live process owns.** It starts a new crawl and names the owner's PID and host. A stale lease, or an owner that exited on the same host, can still be resumed.
- **`squirrel report` keeps the original audit's scan scope** when it rebuilds from the project database: the page limit, a clamped requested limit, the runner, and the URLs discovered but not fetched. Audits stored before this render without an inferred scope.
- **`perf/lcp-hints` shows its evidence.** It records the affected page, the likely-LCP candidate URLs and the image preload URLs it compared. The JSON report's grouped check shows one affected page's evidence, and stored rule results keep every page's.
- **The opt-in `gaps/keywords` and `gaps/content` rules run when you ask for them** with `[rules] enable`, `--rule-include gaps` or `[rule_options] enabled = true`, and stay off under the default rule selection.
- **`security/x-frame-options` flags an unrecognised value.** `X-Frame-Options: ALLOWALL` or a typo warns, because browsers ignore it, unless CSP `frame-ancestors` covers the page. A repeat joined in one header such as `DENY, DENY` counts as one value, and `frame-ancestors` is matched as a directive name, not as text anywhere in the policy.
- **`content/keyword-stuffing` skips function words in more languages.** German, Spanish, French, Portuguese, Italian and Dutch pages are matched by `<html lang>`, so natural copy no longer reports those words as overused.
- **The crawler names managed challenge pages served with HTTP 403.** Cloudflare, Akamai and other detected providers report `Blocked by <provider> challenge (403)`. A plain or stalled 403 stays `Request blocked by server`. Only the first 64 KB of the body is sampled.
- **Glossary JSON-LD no longer leaks into `llms-full.txt` or per-page agent Markdown** as raw script text, and it stays in rendered pages.
- **HTML report issue cards show each detected technology once**, in the order each first appears.
### Security

- **A redirect found while crawling the audited site can no longer send the CLI to a cloud metadata or link-local address.** The page crawl, the root files (robots.txt, sitemaps, llms.txt, the well-known and markdown probes) and the internal link check refuse a redirect hop that leaves the site's hosts for an address such as `169.254.169.254`, `fe80::/10` or `metadata.google.internal`, before sending it, as the asset checks already did. A sitemap that robots.txt or a sitemap index names at such an address is not requested either, and `security/http-to-https` checks each redirect it follows the same way. Private networks stay allowed, so `localhost`, LAN and staging audits still crawl their own pages and root files. A redirect of the start URL itself, resolved before the crawl begins, is not covered yet. See [follow_redirects](https://docs.squirrelscan.com/configuration/crawler#follow_redirects).
- **With `[project] domains` set, the crawl and the internal link check stay on the audited URL's port.** A link to another port on an allowed host, such as `http://example.com:6379/`, is no longer crawled or checked as an internal link, where it could reach another service on the audited machine. When the audited URL uses the default port, 80 and 443 both still count as the site. See [Project settings](https://docs.squirrelscan.com/configuration/project#port-handling).

### Docs

- **A new [FAQ](https://docs.squirrelscan.com/faq)** answers the common first questions.
- **Team roles are documented.** The organization role matrix says what an owner, admin, editor, viewer and billing member can do, that the CLI and MCP sign-ins follow it, what the `403` with `forbidden_role` looks like, that API keys are the organization's and outlive a demoted creator, and how invite limits work.
- **White-label reports, credits and reports pages are updated.** White-label reports are in the Team docs, a second free organization from the same account starts with 0 credits, and published reports redact secrets in crawled URLs.
- **`AGENTS.md` for contributors and coding agents** explains how to work on the repo.
- **Glossary pages carry structured data**, and a few rule pages are corrected.

## v0.0.133 (2026-10-24)

White-label reports get a website and a footer, and the docs get a report walkthrough.

### Added

- **White-label reports can show a website link and footer text.** Team and Enterprise organizations that use white-label reports can add a website and a footer line, such as a copyright notice. The report header links the logo or brand name to the website, and the footer shows the text and the website link where the squirrelscan credit was, in HTML, Markdown and text reports, including local reports from a signed-in CLI. Only an `https://` website is linked. A report keeps the branding it was published with ([HTML report](https://docs.squirrelscan.com/reports#white-label-reports)).

### Security

- The `zod` validation library the `squirrel` CLI bundles moves to 4.6.7, which hardens validation against oversized input.
- The docs toolchain is patched for a vulnerable `undici`. It is docs-site only; nothing in the `squirrel` binary loads it.

### Docs

- **Every rule page links to its glossary terms.** Each rule page ends its definition with the glossary entries for the terms it uses.
- **A new guide, [How to read your report](https://docs.squirrelscan.com/guides/read-your-report).** A walk through a real report from the health score down to what was not checked. The README and the reports page now show the same current report.
- Stale claims on rule pages are fixed, and links to Google's crawler and robots.txt documentation point at its current pages.

## v0.0.132 (2026-10-24)

Reports can show what passed, score rings tell the truth about color, and the docs get a glossary.

### Added

- `squirrel audit` and `squirrel report` take `--include-passed`, which lists the rules that passed after the issues, in every format: each rule with at least one passing check and no warning or error, with how many pages it passed on, `site-wide` for a site rule, or `pages not recorded` for a page rule whose passes name no page. On the HTML report it is one closed line under the findings. JSON gets a `passedRules` array (`ruleId`, `name`, `category`, `scope`, `pages`). A report read with `--input` lists none. Without the flag every format renders exactly as before. See [report](https://docs.squirrelscan.com/cli/report#list-what-passed).

### Changed

- **Group score rings read by score, not by group.** On the HTML report the SEO, Performance, Security and Agents rings, numbers and grades are colored red to green by score, like the health score, so a 45 F looks like one. The group's own color stays on its card's top border and label. Every score ring on the page uses a darker tone of the same red, amber and green bands, so the numbers pass WCAG AA contrast on the white cards.

### Fixed

- **Copy-to-agent prompts keep site text fenced.** (Security.) The HTML report's fix prompts now strip hidden characters and the internal note placeholder before they defuse quote fences, so text from the audited site can no longer piece a fence marker back together and step outside its untrusted block.

### Docs

- **A glossary.** [docs.squirrelscan.com/glossary](https://docs.squirrelscan.com/glossary) has an A to Z index and 64 short definitions, from canonical URL to llms.txt, each linked to the rules that check it.
- The team page no longer lists SAML, SCIM or verified-domain auto-join as Enterprise features: squirrelscan does not support them today.
- The CI guide now says `--fail-on` checks each run against your thresholds, not against an earlier audit, and points at `squirrel report --regression-since` for comparing two audits.

## v0.0.131 (2026-10-23)

Reports are honest about how much of your site they saw, and the HTML page lets you dismiss every notice.

### Changed

- **Summaries keep to one score and the report's own counts.** When a report shows its editor's summary (HTML, Markdown, text, XML, JSON, LLM and the console), at most one numeric score survives and `/100` never appears, and a sentence that states a page count the report does not have is left out. Older stored summaries get the same treatment. If nothing survives, the summary falls back to the report's own totals instead of going blank.
- **Every notice line on the HTML report can be dismissed**, not just the coverage notice, each on its own for that report in that browser. This works in a saved offline file too. The "Scan: N pages crawled" line is gone (the header already says what was scanned and at what level), and a published report's "this is a summary" note moves to the footer.
- The cloud editor's summary now hears how much of the site the audit covered (pages scanned, the page limit, a time stop, pages known), so it can say when a report covers only part of the site and suggest a deeper audit.
- **The HTML report's coverage notice is one line.** A report whose crawl hit its page limit, ran out of time or knows more pages than it scanned now shows a single dismissible line at the top: the report may not cover the whole site, how to raise the audit depth (`--level full` or `--max-pages N` in the CLI, or the website settings in the cloud) and a link to [Audit levels](https://docs.squirrelscan.com/guides/audit-levels). It adds a count only when more pages are known, so a capped crawl no longer reads "200 of 200" or "the other 0+ pages". Dismissing it hides it for that report in that browser, and with browser storage blocked it hides for that visit only ([html format](https://docs.squirrelscan.com/reports#html)).

### Fixed

- **A capped audit counts the pages it found but did not reach.** When a crawl stops before it fetches every page it found, the in-scope URLs still queued (sitemap entries and links that passed the scope and robots checks) now count as discovered, so a 200-page audit of a bigger site no longer reads "200 of 200 discovered pages". A local HTML report shows the count as the floor it is ("Scanned 200 of 731+ discovered pages"), the console, text and Markdown scan lines add "531 more discovered but not fetched", JSON carries it in `meta.unfetched` and the LLM and XML formats in `<scan-scope unfetched="...">`, and the editor's summary request sends it as pages found but not fetched ([JSON output](https://docs.squirrelscan.com/configuration/output#json-output-schema)).

## v0.0.130 (2026-10-23)

Local HTML reports get a glow-up: same page as the cloud, still fully offline. Plus a docs-site security patch.

### Security

- DOMPurify moves to 3.4.17 for GHSA-cg2g-xh64-v4q7 (critical), GHSA-mrv2-3pqr-j5jr (high) and GHSA-c6gr-qvv4-5v3f (low). It is a docs-site dependency only; nothing in the `squirrel` binary loads it.
- The dependency audit now ignores two Astro advisories, GHSA-98hj-9722-w3j8 (moderate) and GHSA-mpr7-6m5w-76rw (low). Astro stays capped below 7.2.10 until tangly moves to `@astrojs/mdx` 8, and only the static docs build uses it, with no untrusted input. The reasoning is in `.github/dependency-audit-allowlist.md`.

### Changed

- **The HTML report is redesigned, and local reports get the same page as published ones.** `--format html` now writes the page reports.squirrelscan.com shows: the health and group scores up top, a coverage notice with the command for a larger audit when the crawl stopped short, the most widespread errors and warnings to fix first, every finding banded by severity and filterable by group, the same findings by page, and the site profile, tech stack and entity map. Every finding has a **Copy fix prompt** button that copies a prompt for your coding agent: the rules to fix, their docs, the audit's evidence fenced as untrusted data, and the `squirrel audit` command that verifies the fix. A signed-out local report also shows what a free cloud account adds, and the checks on the site that need it. The file is still self-contained and makes no network request when opened: no favicon and no technology logos. HTML files written by earlier versions keep the old design; run `squirrel report -f html` again (or a fresh audit) to get the new page ([html format](https://docs.squirrelscan.com/reports#html)).

## v0.0.129 (2026-10-23)

The editor's summary gets a ranked Priorities section, and the summary request now knows your stack.

### Added

- **The editor's summary gets a ranked Priorities section.** When the cloud summary includes priorities, every output format (console, HTML, Markdown, text, JSON, XML and LLM) shows them as their own section, up to eight, highest impact first: a title, why it matters for the site, the concrete action and an effort rating (quick win, moderate or significant). JSON carries them in `editorSummary.priorities`. A summary without priorities, such as one from before this release, shows the big-ticket list as before, and the big-ticket list gives way to Priorities when both exist ([editor's summary](https://docs.squirrelscan.com/cloud/editor-summary)).
- **The summary request sends your stack and every failing rule.** The request now carries the technologies the audit detected and the id of every rule that failed or warned (not just the ranked top issues), so actions can say where the fix is made on your platform. Both are optional and left out when empty. No rules or scoring change.

## v0.0.128 (2026-10-22)

The CLI moves to Bun 1.4.4, a crawl with a live owner is never retired, and a check that has nothing to check on a page stops keeping an old finding open.

### Changed

- **The CLI is built with Bun 1.4.4.** A TLS chain that holds any of eight blocked eMudhra intermediate CA public keys is now refused, and the root store moves to NSS 3.131.1. Seven roots are no longer bundled (Entrust Root Certification Authority 2006, ePKI, Atos TrustedRoot 2011, SecureSign Root CA12, emSign Root CA C1, emSign ECC Root CA G3 and emSign ECC Root CA C3), so a site whose chain ends only at one of those can fail TLS. SECOM and Telia TLS roots are added. The binary is about 24 MB larger (73 to 97 MB on macOS arm64).

### Fixed

- a11y: an element a CSS-nesting rule may hide (`b { @media (min-width: 0) { display: none } }`, `.a { & .b { display: none } }`) now reads as unconfirmed instead of shown, so an unnamed control a browser hides is reported as `<check>-unconfirmed`, not as a failure. A nested rule that sets neither `display` nor `visibility` changes nothing. The reader's Chromium table gains 13 nesting rows measured in headless Chromium (#1013, repro from #1014 by @dbdefault).
- A smart audit now closes a finding on a page the check no longer applies to, instead of carrying it forever, where the skip is a property of the page's own headers, URL or markup: no `Link` header (`core/canonical-header`), no file extension (`content/mime-type`), not paginated (`crawl/pagination`), no canonical tag (`crawl/canonical-chain`), no viewport meta (`mobile/viewport-zoom`), no `<picture>` (`images/picture-element`), a documentation page (`content/placeholder-contact`), no form sets `novalidate` (`a11y/input-types`), no copyright year (`content/stale-copyright`), a small 2xx page (`ax/token-weight`) and a page excluded by pattern (`links/dead-end-pages`). Those skip with a shared `not-applicable` reason that the resolution signal and the local and cloud merges read as evaluated and clean. A skip that could be a fetch, parse or rendering artifact (an empty response, no body, no images or form fields on a page a script may fill, no footer) still carries its finding, as does a check that did not run (no timing data, a scan stopped at its work cap). The skipped row's JSON carries `details.foldKey: not-applicable` and no longer the free-text `skipReason`; its `message` keeps the text (#1011).
- a11y: a page past the style reader's limits (more than 5,000 style rules, an over-long `<style>` block or selector, a no-break or other non-ASCII space in a style block, or a rule nested inside another) now reads every element as unconfirmed for what a style might hide, instead of as shown. Before, the rules past the limit were dropped, so an element they hid could read as shown and an unnamed control inside it failed; now the naming checks report `<check>-unconfirmed` there. A page under the limits reads as before (#1015).

### Added

- a11y, links: `link-text` and `anchor-text` now recognise generic link text in Spanish, French, German, Portuguese, Italian, Dutch, Japanese, Chinese, Korean and Russian (`cliquez ici`, `mehr`, `haga clic aquí`, `詳しくはこちら` and similar), chosen by the page's `<html lang>`, with English always checked. A page with no or an unknown `lang` keeps the English list, matching is on the whole text, and the conventional account and legal labels are never reported (#840).
- content: `word-count` skips pages kept out of search (`noindex` meta or `X-Robots-Tag`), like `core/meta-title`, `core/meta-description` and `core/h1`: a login, sign-up or dashboard page is short by design. The page gets one skipped check naming the source, and nothing is skipped on a staging or preview site whose homepage is noindex (#841).
- Retention and `self disk --prune` now read the crawl lease that v0.0.127 started writing (#946). A crawl whose heartbeat is under 5 minutes old, or whose owner process is still alive on this machine (trusted for up to 24 hours of silence, so a suspended laptop is safe and a reused pid cannot hold a crawl forever), is never retired, including when a later audit of the same project finishes first. A killed `crawled` crawl is retired by the next audit and by `--prune` once its heartbeat is 5 minutes old, and a killed `running` crawl, which `--resume` continues, after 24 hours, in both cases without waiting for a later audit; `stopped`, `paused` and `failed` crawls are never retired sooner by a dead lease: `stopped` and `paused` keep their 7 days, `failed` its 30 minutes. A newer finished audit plus the idle time (30 minutes, or 7 days for `stopped` and `paused`) retires any of them as before. An owner on another host or one that cannot be read counts as live until the 5 minutes pass, and the check runs again inside the retiring transaction. Crawls written by older versions have no lease and follow the previous rules, and `--prune --dry-run` shows a held crawl's owner pid and last heartbeat. A `--resume` after a kill takes the lease over at once when the old owner's process is gone.

## v0.0.127 (2026-10-22)

Custom request headers stay with the audited origin unless you name another host, the default rule time budget doubles, and a smart audit keeps findings it did not get to re-check.

### Changed

- Each crawl records which process drives it: `squirrel audit`, `crawl` and `analyze` write their pid, host name and a heartbeat (every 15 seconds, on a second database connection that skips a beat rather than wait on a busy database) on the crawl, and clear the owner when they end. Nothing reads it yet, so retention and `self disk --prune` behave as before; a later release will use it to keep a live crawl and retire a killed one sooner. The database gains three nullable columns (schema 35) that older versions ignore, and an audit of 1,000 pages is no slower (#946).
- a11y: an unnamed control inside an element that `display: none` hides only inside width-only media queries (a theme's mobile menu, `@media (min-width: 990px) { menu-drawer { display: none } }`) is still reported as `<check>-unconfirmed`, but with its own reason, `hidden-only-at-some-widths`, and the widths where it shows ("shown below 990px"), so it reads apart from a style squirrel cannot settle. Queries that together cover every width (`min-width: 990px` with `max-width: 989.98px`, in colon or range syntax, em or rem) leave the element hidden at every width and it is not reported. Any other media feature, `not`, `@container`, `@supports` or a `<style media>` keeps the generic reason. A control inside a rule whose queries can never both match (`(min-width: 990px) and (max-width: 989px)`) is shown, so one an earlier audit reported as unconfirmed can now fail, as it does in a browser (#988).
- The default per-rule time budget is now 2 seconds (was 1 second), so a rule that runs slowly on a busy machine is abandoned less often. A site rule gets 2 seconds per page of the site, still capped at 60 seconds. `[rules] time_budget_ms` still overrides it, and values below 1000 are still refused.
- `legal/cookie-consent` finds its consent signals in one pass over the page's elements instead of 28 selector sweeps, and `social/share-buttons` no longer lowercases a copy of the page. Both give the same answers as before; on a 1 MB script-heavy page `legal/cookie-consent` is about 3 to 6x faster (#270).

### Fixed

- Custom request headers (`-H`, `[crawler] headers`) are now sent only to the audited origin (scheme, host and port) on the crawl's page fetches, the sitemap and license fetches, and the soft-404 and cloaking re-fetches, as they already were for assets. A page on another scheme, port or host, including one `[project] domains` or an include pattern admits, is still crawled and reported but is requested without them, and an `https:` start URL that redirects to `http:` keeps its `https:` scope. Name a host in `[crawler] header_hosts` (or `--header-host`) to send them there; a named host now gets them over `https:` only (before, any scheme matched), so write an entry with an `http://` prefix to keep sending them over plain http. An entry may carry a scheme, port, path or trailing slash, which are ignored; a wildcard, userinfo, empty label or trailing dot is refused. A `www` host of an apex audit now needs to be named too (#959).
- A smart audit no longer marks a finding fixed when its check was skipped on the page in the re-crawl (for example `perf/ttfb` with no timing data, or a scan that stopped at its work cap) while the check ran on other pages. The finding stays open as carried. This now holds in the local audit and in a cloud publish whose resolution signal is over budget, not only when the signal lists the page (#508). A rule that timed out or threw on a page carries its findings there in the local audit too. A check skipped on every page, a rule disabled in config and a cloud audit that streams its findings to the store (which never sees skipped checks) still close the finding. A few rules also skip a page because the check does not apply to it, and those carry for now (#1011).
- links: Cloudflare email-protection links (`/cdn-cgi/l/email-protection#<hex>`) are read as the `mailto:` links they are. `tel-mailto` counts them and checks the decoded address (one that does not decode is never reported as invalid or mismatched), `nofollow-internal` and `https-downgrade` no longer judge them as page links, and the crawler never queues the path from a sitemap, a carried finding or a cached page's links. `/cdn-cgi/image/` URLs are still checked as images (#838).
- a11y: `link-text` no longer reports conventional account and site-utility labels (`Sign in`, `Sign up`, `Log out`, `Register`, `Terms`, `Privacy policy`, `Contact`, `FAQ` and similar, in 11 languages) as generic link text. `click here`, `read more` and the other generic phrases are still reported (#839).
- links: `no-contextual-inbound` no longer reports legal pages (privacy, terms, imprint, `/legal`, in any recognised language and under any path prefix) that are linked only from the footer, which is where they belong (#981).
- A smart audit no longer marks a finding fixed when its rule threw an error on every page of the re-crawl. The rule never finished, so nothing was checked, and the earlier finding now stays open until a run completes the rule, the same as for a rule that times out (#999). A rule that timed out on only some pages still carries only those pages' findings, and a page it finished still resolves (#1000).
- a11y: `frame-title`, `object-alt` and `empty-heading` now read which elements are out of the accessibility tree the same way as `button-name` and the other naming rules. A hidden element is skipped and counted, and one a style may hide (a `no-js` fallback on a page with an external stylesheet included) is reported as `<check>-unconfirmed` instead of a failure. A visible one still fails (#1002).

## v0.0.126 (2026-10-22)

Seven more accessibility checks stop failing on hidden elements, and a smart audit no longer calls a finding fixed when its rule never finished.

### Fixed

- a11y: `aria-meter-name`, `aria-progressbar-name`, `aria-toggle-field-name`, `aria-tooltip-name`, `aria-treeitem-name`, `input-image-alt` and `link-text` now read which elements are out of the accessibility tree the same way as `button-name` and `select-name`. An element hidden by `hidden`, `aria-hidden`, `display: none` or a closed dialog is no longer reported, and one a style may hide (a `no-js` fallback on a page with an external stylesheet included) is reported as `<check>-unconfirmed` instead of a failure. A visible one still fails. Reading hidden elements is also faster on large pages (#993).
- A smart audit no longer marks a finding fixed when its rule timed out on every page of the re-crawl. The rule never finished, so nothing was checked, and the earlier finding now stays open until a run completes the rule.

## v0.0.125 (2026-10-22)

Fixes for false accessibility failures: on themes that hide a no-JavaScript fallback once scripts run, and on hidden `<select>` elements.

### Fixed

- The accessibility checks that skip hidden controls (`a11y/form-labels`, `a11y/aria-input-field-name`, `a11y/select-name`, `a11y/aria-labels`, `a11y/aria-command-name`, `a11y/aria-dialog-name`, `a11y/button-name` and `a11y/aria-hidden-focus`) now report a control they would have decided was shown (an unnamed control, or a focusable one inside `aria-hidden`) as unconfirmed, not as a failure, when it or an ancestor other than `<html>` or `<body>` has a `no-js` class and squirrel could not read all of the page's styles (for example, an external stylesheet or an `@import`). Themes may hide such a fallback once JavaScript runs, with a rule like `.js .no-js { display: none }` in a stylesheet squirrel does not read. Items unconfirmed this way say so: `it or an ancestor carries a no-js class, and a stylesheet squirrel did not read may hide it when JavaScript runs`. A page whose styles were all read, a control with no such class, another class such as `no-js-fallback`, and a `no-js` class on `<html>` itself keep their verdict. See [a11y/form-labels](https://docs.squirrelscan.com/rules/a11y/form-labels).
- `a11y/select-name` now reads which selects are out of the accessibility tree the way the other naming checks do. An unnamed select that the `hidden` attribute, `aria-hidden="true"`, a closed dialog, or a `display: none` squirrel can settle (inline or in a page `<style>` rule) keeps hidden is no longer reported. One a style may hide, a `no-js` fallback on a page with unread styles included, is reported as `select-name-unconfirmed` (a warning) instead of a failure. An unnamed select squirrel reads as shown still fails, and one hidden only by an external stylesheet is still reported. See [a11y/select-name](https://docs.squirrelscan.com/rules/a11y/select-name).

## v0.0.124 (2026-10-21)

A small accessibility fix: a `<style>` rule that may hide elements and uses an operator attribute selector, such as `[id$="-drawer"]`, no longer turns the accessibility failures of unrelated controls into warnings.

### Fixed

- The accessibility checks that skip hidden controls now read attribute selectors with an operator (`[id$="-drawer"]`, `[href^="#modal"]`, `[data-state*="closed" i]`, `[class~="a"]`, `[lang|="en"]`) in a `<style>` rule. A bare operator selector used to lose its attribute test, so a rule like `[id$="-drawer"] { display: none }` that matched nothing still left every unnamed control on the page unconfirmed. It now reaches only elements that have that attribute with a value that could satisfy it, compared without regard to ASCII case, so `a11y/button-name`, `a11y/form-labels` and the other checks can fail the rest again. An element whose attribute could satisfy the operator can still be left unconfirmed, with the visible controls inside it, as `<html lang="en">` against `[lang|="en"] { display: none }` shows. A plain `[id="drawer"]` test inside a selector squirrel cannot settle, such as `.is-open [id="drawer"]`, now compares the value too, so it no longer leaves `<input id="q">` unconfirmed. Reading these rules is also faster on large pages. See [a11y/button-name](https://docs.squirrelscan.com/rules/a11y/button-name).

## v0.0.123 (2026-10-21)

A small accessibility fix: the old vendor-prefixed flexbox fallbacks in inline styles and a page's `<style>` blocks no longer turn accessibility failures into warnings.

### Fixed

- The accessibility checks that skip hidden controls now read vendor-prefixed `display` values (`-webkit-box`, `-webkit-flex`, `-ms-flexbox`, `-moz-box` and the like) as values that show the element. The old flexbox fallback chain (`display: -webkit-box; display: -webkit-flex; display: -ms-flexbox; display: flex`) used to make the whole declaration block unreadable, which could leave the unnamed controls under it unconfirmed, so `a11y/button-name` and the other naming checks can fail those controls again when nothing else hides them. A `-ms-` or `-moz-` value stays unconfirmed unless a later standard `display` overrides it (`!important` respected), because browsers differ on it. A `display: none` that wins after the prefixed values still hides the element where squirrel can settle the rule, and a `display` set from `var()` stays unconfirmed. See [a11y/button-name](https://docs.squirrelscan.com/rules/a11y/button-name).

## v0.0.122 (2026-10-21)

A release about saying what actually happened. A rule that runs out of time is now reported as not checked, with a `Not checked` line in every report, rather than as a failure, and a timed-out security rule trips warning gates instead of error gates (see below). `squirrel audit` without a terminal prints a progress line while it walks the crawled pages, and WordPress's image and lightbox styles no longer soften accessibility failures on controls nothing else hides.

### Added

- `squirrel audit` without a terminal now prints `Walking pages: N/M` to stderr, about every 15 seconds, while it walks the crawled pages before the rules run. That step could go minutes without output on a big site, so a supervisor with a no-output watchdog could not tell it from a hang. The line is written at the end of a batch of pages, other than the last, once the interval has passed since the walk started or the last line. Batch length varies with page size, so a walk that fits in one batch prints no line, and a batch that takes longer than the interval shows nothing until it ends. Set `SQUIRREL_WALK_HEARTBEAT_MS` to a positive number of milliseconds to change the interval. A terminal keeps its spinner, and stdout (`--format json`, pipes) is unchanged. See [audit](https://docs.squirrelscan.com/cli/audit#progress-without-a-terminal).

### Changed

- A rule abandoned for its time budget is now a skipped check, not a failed one. It is reported as `<rule>-error` with `skipReason: "rule-timed-out"` on every page it timed out on, the first included, with `elapsedMs`, the wall-clock time it ran before it was stopped. It adds nothing to the failed counts and no longer lowers the health score, so a site where a rule timed out may score higher than before.
  - Every report format, the CLI's own output included, prints a `Not checked` line for a timed-out rule above info severity, with the rule's name and how many pages it did not check, such as `Not checked: External Link Security. External Link Security timed out on 1 page (exceeded its 1000 ms time budget).`
  - `--fail-on`: a timed-out security rule counts as one warning-severity finding, so `warnings>0` and `severity>=warning` trip on it and the gate summary names the rule. It is counted only for the gate, not in the report's warning count or the score. The timeout itself adds nothing to the error count or the score, a security rule's included, so a CI job that gated on `errors>0` and failed only because a rule timed out now passes. Add a warning gate to keep catching a timed-out security rule, or raise `time_budget_ms`. Other rules that time out are not counted by any gate.
  - A page-time extractor that runs past the budget is handled the same way, when the site rule that reads it runs.
  - See [Rule time budget](https://docs.squirrelscan.com/rules#rule-time-budget).

### Fixed

- The accessibility checks that skip hidden controls no longer leave a control unconfirmed because of a `<style>` rule squirrel cannot fully decide whose declarations can only show an element (`display: inline-block`, `display: flex`, `visibility: visible`). WordPress core's `.wp-block-image>a` and `.wp-lightbox-container button` rules kept a page's links and buttons unconfirmed, so `a11y/button-name` and the other naming checks can fail them again. Such a rule can still leave a control unconfirmed where it could undo something else that hides it, such as the `hidden` attribute, a closed dialog, a popover, a `display: none` or an inherited `visibility: hidden`. `display: contents`, `inherit` and `unset` do not count as only showing. See [a11y/button-name](https://docs.squirrelscan.com/rules/a11y/button-name).
- The `<rule>-timeouts` info check, which counts the pages a timed-out rule did not check (`pagesNotChecked`, and `maxElapsedMs` when it was measured), now reaches the stored results and every report for a page rule too. It was dropped before, so a timed-out page rule left no such row in `project.db` or the report. See [Rule time budget](https://docs.squirrelscan.com/rules#rule-time-budget).

## v0.0.121 (2026-10-21)

A release about where your custom request headers go. Asset requests now send them to the audited origin only, with a new `header_hosts` setting for the site's other hosts that need them, and the soft-404 and cloaking probes no longer carry them across a redirect to another site. Also: `squirrel analyze` applies `keep_audits` retention, Tailwind v4's preflight no longer softens accessibility failures, and the link checks leave two more shapes of sign-out and credential link alone.

Thanks to @deniskern, whose report is behind the `squirrel analyze` retention fix below.

### Security

- Custom request headers (`-H`, `[crawler] headers`) now go only to the audited origin on asset requests such as stylesheets, scripts and images, not to every subdomain of the audited host. The audited origin is the scheme, host and port the audit runs on: the start URL, after a redirect within the site. A subdomain is not always run by the site's owner, and these headers usually carry credentials. To send them to one of the site's hosts that needs them, such as `assets.example.com` behind Cloudflare Access, name it with `[crawler] header_hosts = ["assets.example.com"]` or `--header-host assets.example.com` (repeatable or comma-separated). Assets on other sites never get them, as before. When an audit has custom headers set, a script or stylesheet on a host that was not sent them and answers 401 or 403 is now listed as unverified by `reliability/broken-resources`, naming its host, instead of being reported as broken, and `mobile/web-app-manifest` reports such a manifest or icon as not checked. See [Crawler configuration](https://docs.squirrelscan.com/configuration/crawler#header_hosts).
- The soft-404 confirmation and the cloaking probe follow redirects one hop at a time and drop your custom headers, other than standard browser headers such as `User-Agent` and `Accept`, on a hop to a different origin. They also refuse a hop to a link-local or cloud metadata address. Private networks still work for an audit of a site on your own network.

### Fixed

- The accessibility checks that skip hidden controls no longer make every unnamed control on a page unconfirmed when the page inlines Tailwind v4's preflight (`[hidden]:where(:not([hidden="until-found"]))`). A `:where()`, `:is()` or `:has()` beside a tag, class, id or attribute test now only narrows the rule, so the rule reaches elements that have that part, and `a11y/button-name` and the other naming checks can fail visible unnamed controls again. A `:where()` or `:is()` with nothing beside it can still reach any element. See [a11y/button-name](https://docs.squirrelscan.com/rules/a11y/button-name).
- `content/placeholder-text` no longer flags `NaN` listed beside `Infinity`, as in `Special values: NaN, Infinity` or a list of `NaN`, `Infinity` and `-Infinity` on adjacent lines. That is floating-point vocabulary, not a leaked value. `NaN` shown as a value (a line that is just `NaN`, `Rating: NaN`, `Price: $NaN`) still flags, unless an `Infinity` sits right next to it. See [content/placeholder-text](https://docs.squirrelscan.com/rules/content/placeholder-text).
- `squirrel analyze` now applies `[storage] keep_audits` retention, unless `keep_audits` is off, so a project audited with `squirrel crawl`, `squirrel analyze` and `squirrel report` no longer keeps every audit's results. It retires audits beyond the window, and crawls that killed audits left behind, the way `squirrel audit` does, and prints the same notice on stderr when it retires something. It skips retention for a blocked or failed crawl, for a crawl in another project than the one the directory's `squirrel.toml` names, and, when no project is named, for a crawl picked with `--id`. See [Storage](https://docs.squirrelscan.com/configuration/storage).
- The internal and external link checks no longer request two more shapes of action or credential link. A sign-out with a version number after it (`/LogOut2`, `/SignOut1.aspx`) now counts as a sign-out, while `/oauth2/docs` is still a page, and a credential in a matrix parameter (`/file;sig=…`, `/a.zip;X-Amz-Credential=…`) now counts as a credential. See [External links](https://docs.squirrelscan.com/configuration/external-links).

## v0.0.120 (2026-10-20)

A small release. A page and its locale variants sharing their own share image are no longer reported as a site template fallback, and squirrelscan's cloud now refuses the free link checks that CLIs older than v0.0.114 still ask for.

Thanks to @deniskern, whose report is behind the `social/asset-divergence` fix below.

### Pricing

- A `squirrel` CLI from before v0.0.114, signed in with `squirrel auth login`, no longer gets free cloud link checks. That was due to end on 2026-11-12 and has ended now. The cloud refuses those checks and charges nothing, and the CLI checks the links on your machine instead, as it already does for any link the cloud leaves unanswered. Run `squirrel self update` to send them to the cloud again, at 1 credit per distinct link the cloud verifies. See [Credits and pricing](https://docs.squirrelscan.com/cloud/credits).

### Fixed

- `social/asset-divergence` no longer reports a page's own `og:image` as a divergent fallback only because its hreflang alternates repeat it. Pages linked as hreflang alternates in both directions (directly or through each other, in any language) now cast one vote per image on the default OG image axis. So a collection page and 15 locale variants sharing an image the rest of the site does not use count as one page's image, which the rule leaves out, instead of a 16-page template fallback. A one-way hreflang link merges nothing, the favicon and theme-color axes still count each page, and a pocket of unrelated pages sharing a stale fallback image is still reported. See [social/asset-divergence](https://docs.squirrelscan.com/rules/social/asset-divergence).

## v0.0.119 (2026-10-20)

A release about tidying up after audits that never finished, and about how the accessibility checks read `<style>` blocks. Crawls that killed audits leave behind are now retired instead of piling up in `project.db`, `squirrel self disk --prune` carries on past a project it cannot open, Ctrl-C marks the crawl it interrupts as stopped, and a `:root` block of design tokens no longer turns a page's accessibility failures into warnings.

Thanks to @deniskern, whose report is behind the abandoned-crawl fix below.

### Fixed

- The accessibility checks that skip hidden controls no longer report every unnamed control on a page as unconfirmed because of a `:root` block of design tokens. Since 0.0.118, a custom property whose name or value mentions `display` (such as `--font-display: swap`, or the "Display" typography preset WordPress writes into its global styles) next to a `calc()` or `var()` made the whole page unreadable. So `a11y/button-name`, `a11y/aria-labels`, `a11y/aria-command-name` and the other naming checks, and `a11y/aria-hidden-focus`, warned where they should fail.
  - squirrel now reads a style block one declaration at a time. A declaration other than `display`, `visibility` or `all`, such as a custom property or `transition: all .2s` next to a `var()`, no longer makes a rule unreadable, though an escape, an unclosed string or an animation still can. A `:root` rule now applies to `<html>` only.
  - A control with the `hidden` attribute, in a closed `<dialog>` or in an unopened `popover`, that a `<style>` rule or a plain inline style shows again is now unconfirmed, not a failure, on a page that also loads an external stylesheet, since a rule there such as `[hidden] { display: none !important }` may keep it hidden. An inline `display` with `!important` still counts.
  - Still unconfirmed, possibly across the whole page: controls that a `<style>` rule squirrel cannot settle could reach, when its declarations can only show an element, such as WordPress's `.wp-block-image>a { display: inline-block }` ([#940](https://github.com/squirrelscan/squirrelscan/issues/940)), and controls on a page whose `<style>` inlines a hiding rule that uses `:where()` or `:is()`, such as Tailwind v4's `[hidden]:where(…)` preflight ([#951](https://github.com/squirrelscan/squirrelscan/issues/951)).
  - See [a11y/button-name](https://docs.squirrelscan.com/rules/a11y/button-name).
- Crawls left behind by audits that were killed before they finished (`kill -9`, a watchdog, an out-of-memory kill) are now retired: by `[storage] keep_audits` after an audit, unless `keep_audits` is off, and by `squirrel self disk --prune`. A crawl qualifies once a newer audit has finished and the crawl has fetched nothing for more than 30 minutes (7 days for a `stopped` or `paused` crawl, which `--resume` continues), and is retired at the next such pass. These crawls no longer take a slot of the `keep_audits` window, and a `failed` crawl follows the same rule. A crawl newer than the newest finished audit, or one that fetched a page in the last 30 minutes, may be live or waiting for `analyze`, and is never retired. A crawl that no longer qualifies when the pass re-checks it is skipped on its own instead of stopping the rest. Retiring a crawl drops its results and crawl data, and the crawl stays listed. See [Storage](https://docs.squirrelscan.com/configuration/storage).
- `squirrel self disk --prune` no longer stops at the first project it cannot open. Each project is handled on its own, and one that fails is reported with its reason. After pruning, the run prints how many projects were pruned, had their rebuild skipped and failed, and exits 1 when a project failed. The rebuild is skipped, with a stated reason, when the measured free space is below what it needs. `--dry-run` lists abandoned crawls apart from finished audits, with their status and age, and the unfinished crawls it leaves alone, with their last activity. See [self](https://docs.squirrelscan.com/cli/self).
- Ctrl-C during `squirrel audit` marks the crawl the audit was still fetching as `stopped`, the state `--resume` continues, so it no longer looks like a killed audit's crawl. Marking it is best effort: if another process holds the database locked for more than a second, the crawl stays `running`.

## v0.0.118 (2026-10-20)

A release about reading pages more the way a browser does. The accessibility checks that skip hidden controls now read the page's own `<style>` blocks, so a control a `<style>` rule hides, such as a closed modal, is skipped as a browser skips it, and accessibility scores move with it. A local audit detects technologies from more of its response headers, a charset sent only in the `Content-Type` header counts, a redirected page's canonical is judged at its target, four more schema rules follow `@id` references, a CAPTCHA widget rendered client-side is recognised, and the link checks never request a link whose fragment carries a sign-in token.

Thanks to @WilliamK112, whose pull requests are behind the `content/hidden-text` and npm install fixes below, and who also hardened the plan lookup, tidied the crawler's page events, kept the `squirrel analyze` tests away from a developer's real project databases and made CI check that the compiled CLI carries the rules version it was built from. Thanks also to @deniskern, whose reports are behind the hidden-control, `security/form-captcha` and `security/csp-blocks-own-resources` fixes.

### Pricing

- `squirrel keys create` now says how an audit signed in with the new key is billed: no audit or page charge, links checked on the runner, cloud renders 2 credits each (not printed with `--json`). That billing is not new; the [CI guide](https://docs.squirrelscan.com/guides/ci#what-an-api-key-audit-costs) now spells it out.
- A dead-link check called directly through the API, outside an audit (`POST /v1/services/dead-links` with no run), costs 1 credit for each distinct link it verifies, and nothing for a link it cannot verify or does not answer. Links that differ only in their query string or fragment count as one. It used to be free for any caller until 2026-11-12. That free period now applies only to a `squirrel` CLI from before v0.0.114 signed in with `squirrel auth login`; from 2026-11-12 those calls are refused and the CLI checks its links itself. See [Credits and pricing](https://docs.squirrelscan.com/cloud/credits).
- A completed cloud audit is refunded for the external links it was charged for that its report lists as not checked because the link check ran out of time.

### Changed

- A link whose fragment carries a credential, written as `key=value` pairs such as an OAuth sign-in redirect's `#access_token=…&token_type=bearer`, is now treated like any other token link. The external and internal link checks never request it, and a signed-in audit never sends it to the cloud's link check. The report lists it as not requested, with the fragment left off. On your own site, the crawl can still load the page such a link points to, since a fragment is never sent with a request. A plain anchor (`#pricing`), a hash route (`#/settings`) and ordinary state in the fragment (`#q=shoes`) are checked as before. See [What the internal link check never requests](https://docs.squirrelscan.com/configuration/external-links#what-the-internal-link-check-never-requests).
- The squirrelscan agent skill that ships with the CLI, which `squirrel skills`, `squirrel setup` and `squirrel mcp` hand out, is now version 1.15. Its access-gateway advice now says that cloud browser renders send a website's custom request headers, so a gated site can keep rendering on. A signed-in CLI audit's cloud renders still never carry `-H` headers.
- A published report now carries `linkTargetSets`: for `links/broken-links` and `links/broken-external-links`, hashes of the targets each one reported broken and of those it could not verify or did not request, taken before the report is sampled. Each set holds up to 2,000 hashes and says whether it is complete. A later comparison can then tell a link that broke since the previous audit from one that was already broken, even on a site with more broken links than the report lists. No format renders them, and scores do not change. See [Reports](https://docs.squirrelscan.com/reports).

### Fixed

- The accessibility checks that skip hidden controls (`a11y/aria-hidden-focus`, `a11y/button-name`, `a11y/form-labels`, `a11y/aria-labels`, `a11y/aria-command-name`, `a11y/aria-dialog-name` and `a11y/aria-input-field-name`) now read the page's `<style>` blocks, not only inline styles. A control or dialog that a `<style>` rule hides with `display: none` or `visibility: hidden`, such as a closed modal, is skipped as a browser skips it, instead of being reported.
  - squirrel settles a rule itself only when it sits outside any at-rule, in a `<style>` with no `media` (other than `all` or `screen`) and no `title`, its declarations are plainly written, and each of its selectors is one compound of a tag, an id, classes and plain attribute tests (`.modal`, `div#menu.closed`, `[data-state=closed]`). It applies those as a browser does: `!important` first, then an inline style over a rule, then specificity, then source order.
  - Any other `<style>` rule that sets `display` or `visibility`, whatever the value, can make the unnamed controls it could apply to, and those inside them, unconfirmed: a warning rather than a failure. That covers a selector with a combinator (`.nav .item`) or a pseudo-class (`:hover`), a rule inside `@media`, `@supports` or `@layer`, and a rule whose declarations squirrel cannot read. A rule using `:is()`, `:where()` or `:has()` can reach any element, so it can make any unnamed control on the page unconfirmed. Hiding that comes from a `<style>` block on a page that also loads an external stylesheet, which may undo it, is unconfirmed too.
  - On a page whose styles squirrel reads in full (for example, no external stylesheet or `@import`), a control inside a container whose inline style sets `visibility: hidden` now counts as hidden instead of unconfirmed.
  - Some controls that were skipped or unconfirmed are now checked, because a `<style>` rule shows them again, as a browser does: a `display` value on an element with the `hidden` attribute, a closed `<dialog>` or a `popover`, an `!important` rule that beats an inline `display: none`, or `visibility: visible` on a control inside a hidden container. A control hidden only by its inline style is unconfirmed where an undecided `!important` rule, or an animation that sets `visibility`, may show it.
  - Accessibility scores change in both directions. Unconfirmed rows now read `may be hidden by a style (unconfirmed)` instead of `may be hidden by an inline style (unconfirmed)`, and their items say `a style on it or an ancestor sets display or visibility in a way squirrel cannot settle`.
  - Known limits, tracked in [#938](https://github.com/squirrelscan/squirrelscan/issues/938): a `:root` block of custom properties whose names or values mention `display`, such as WordPress global styles with a "Display" typography preset, can make every unnamed control on the page unconfirmed. A `<style>` rule that shows a control is applied even when an external stylesheet may hide it again.
  - See [a11y/aria-hidden-focus](https://docs.squirrelscan.com/rules/a11y/aria-hidden-focus).
- An audit no longer keeps an earlier audit's accessibility failure open, as a carried finding, on a page where the same check now reports the control as unconfirmed. This affected the seven hidden-control checks above once they began reading `<style>` blocks: the page showed both the stale failure and the new unconfirmed warning. An unconfirmed row now counts as the check having run on that page, so the earlier failure is closed unless the page still fails that check, and an earlier unconfirmed warning is closed once the check passes there. A page a rule did not check at all keeps its earlier findings. The fix text of those seven rules now describes how `<style>` blocks are read.
- Technology detection in a local audit sees more of the response headers a signature reads. The crawler kept only a fixed set of headers, so a header-only signature such as `X-CDN: Imperva`, `X-Sucuri-ID` or `X-Varnish` never matched. The crawler now stores those headers with each page, each kept value cut to 512 characters, and the CLI passes them to the local scan. A signed-in audit also sends them to the cloud detection, together with `X-Powered-By`, `X-Generator`, `X-AspNet-Version` and the names of the cookies a page sets (up to 50). A header a signature only checks for presence, such as a request id or a bot protection token, is kept as a marker, not its value, and cookie values are never sent. A page an earlier version stored, and the crawl cache reuses, is read with only the headers it kept until it is fetched again. See [Technology Detection](https://docs.squirrelscan.com/cloud/technologies).
- `core/charset` now sees the charset of the `Content-Type` response header in a real audit. The crawler kept only the media type, so a page declared UTF-8 by its header alone failed with `No charset declaration found`, and a header that disagreed with the page's meta about UTF-8 was never reported. It now warns, for example `Conflicting charset declarations: header iso-8859-1, page utf-8`. A page an earlier version stored and the crawl cache reuses is read as before until it is fetched again. See [core/charset](https://docs.squirrelscan.com/rules/core/charset).
- `core/canonical` and `crawl/pagination` judge a URL that answers with an HTTP redirect by the URL it ended on, as `i18n/hreflang` already does. `/en/old-slug` redirecting to `/en/new-slug`, whose canonical is `https://example.com/en/new-slug`, no longer reads "Canonical points to different URL", and a paginated URL that redirects is tested, and its relative canonical resolved, at its target. See [core/canonical](https://docs.squirrelscan.com/rules/core/canonical).
- `schema/breadcrumb`, `schema/local-business`, `schema/website-search` and `schema/rating-scope` follow JSON-LD node references (`{"@id": …}`) to the node they name on the same page, as `schema/faq`, `schema/product` and `schema/review` already do. A breadcrumb whose items are references no longer reports items missing their position and name, a business whose address is a reference no longer reads as an incomplete address, a referenced `SearchAction` is found, and a referenced rating is read for the entity that carries it. A reference to a node the page does not have is judged as written. See [schema/breadcrumb](https://docs.squirrelscan.com/rules/schema/breadcrumb).
- `security/form-captcha` recognises a CAPTCHA widget rendered client-side. `@nuxtjs/turnstile` and React reCAPTCHA components mount the widget after hydration, so the static HTML holds only the site key, for example Nuxt's `turnstile:{siteKey:"…"}` runtime config. A Turnstile, reCAPTCHA, hCaptcha or Friendly Captcha site key, under the provider's name and in that provider's key format, in an inline or JSON data script now protects the page's single public form, like a provider script does, unless another form on the page has a CAPTCHA of its own. A script that only mentions a provider, or switches it off, still does not. See [security/form-captcha](https://docs.squirrelscan.com/rules/security/form-captcha).
- `security/csp-blocks-own-resources` no longer warns about, or fails on, a host that only the page's same-site scripts or preloaded chunks name as a script to load. SDKs ship fallback URLs that load only behind a feature flag, so the page may never request them. That includes a known vendor's host (analytics, ads, payments, CAPTCHA, forms or booking) that only a chunk names, which used to fail the check. Such hosts are now listed in an informational `csp-chunk-only-hosts` note. A host the page's HTML loads, or that a vendor it uses needs, is reported as before. See [security/csp-blocks-own-resources](https://docs.squirrelscan.com/rules/security/csp-blocks-own-resources).
- `content/hidden-text` reads CSS comments the way a browser does. A comment before a property or its colon (`.promo { /* hide */ display: none }`) used to stay in the property name, so the declaration was never recognised, in `<style>` rules and inline `style` attributes alike. A `<style>` rule with a comment before or inside its selector, such as a `/* Section */` comment between rules, was not applied either, here or in `mobile/input-zoom`. Text and links hidden either way now count, as other hidden text does. See [content/hidden-text](https://docs.squirrelscan.com/rules/content/hidden-text).
- WAF detection stops treating text as quoted at the end of the block an unclosed `<code>`, `<kbd>` or `<samp>` sits in. Since 0.0.117, an unclosed `<code>` could hide a block page's wording, such as an Imperva incident line, for the rest of the page, so the block page went unrecognised. A block nested inside a code block, as Expressive Code and Starlight write each line, still reads as quoted.
- The console, llm and XML reports say how many items a check left out, as the HTML, markdown and text reports do. The console's `... +N more` after the first 5 items now counts the items the audit left out too, and a check that lists none reads `1,500 items not listed`. The llm format no longer drops the count for a rule whose checks list no items (`Items (0/1500): none listed`), and the XML gives it as a `not-listed` attribute on the check's `<items>` element. Scores do not change. See [Reports](https://docs.squirrelscan.com/reports).
- A signed-in audit checks on your machine a link the cloud link checker refused to request because its name resolves to a private address, when the checker says so, instead of listing it as status unverifiable. An audit of a site on a private network gets the link's real status, and a public site's audit still never requests it and lists it as refused. The cloud's refusal is never itself reported as a broken link. See [External links](https://docs.squirrelscan.com/configuration/external-links).
- The npm package's postinstall download follows at most three redirects, refuses a download or redirect URL that is not HTTPS, and resolves a relative `Location` against the URL that sent it.

### Docs

- The [CI guide](https://docs.squirrelscan.com/guides/ci#what-an-api-key-audit-costs) says what an API-key audit costs, and [Credits and pricing](https://docs.squirrelscan.com/cloud/credits) gives the price of a dead-link check outside an audit.
- The README and the docs home count 8 Mobile rules.

## v0.0.117 (2026-10-17)

A release about reading pages the way browsers and search engines do. The new `mobile/input-zoom` rule finds the form fields that make iOS Safari zoom in, so squirrelscan now ships 309 rules. A strict CSP built on a nonce or `'strict-dynamic'` is no longer called weak, the rules that ask whether robots.txt blocks a page read it the way Google does, a sitemap with a mismatched tag or a raw `&` gets caught, and the FAQ, product and review checks follow JSON-LD `@id` references to the nodes they name. A site missing compression or caching headers is scored for each once instead of twice, `squirrel analyze` stops stacking a second copy of every result, and a signed-in audit no longer pays for a link the cloud could not verify.

Thanks to @deniskern, whose reports are behind the `schema/faq`, `crawl/pagination` and `i18n/hreflang` fixes below.

### Added

- New rule `mobile/input-zoom`: on an iPhone, focusing a text field, select or textarea under 16px makes Safari zoom the page in. The rule reads field sizes from inline styles and `<style>` blocks and lists up to 20 small fields, each with its size and where it came from, such as `14px (inline style)`. A field nothing on the page sizes, on a page with no external stylesheet, gets iOS's own `11px (iOS default)`. A field it cannot read plainly (its size may come from an external stylesheet, a media query, conflicting rules or a relative unit) is counted as not read rather than guessed at, so on many sites built with a CSS framework most fields are not read yet. A page that sets `maximum-scale=1` or `user-scalable=no` in its viewport tag to stop the zoom still gets the warning, with a note that the workaround blocks zoom for everyone. See [mobile/input-zoom](https://docs.squirrelscan.com/rules/mobile/input-zoom).
- `perf/total-byte-weight` also reports two site figures, for information only: the site total (every scored page's HTML plus each measured external resource once, however many pages share it) and the average page weight. They are at the end of the message (`Not scored: site total 80KB across 19 pages, shared files counted once; average page 4KB`) and in the details as `siteTotalKb` and `pageAverageKb`. They never change the pass, warn or fail result, which is still the heaviest page's, and an audit whose page weights are only estimated reports neither. See [perf/total-byte-weight](https://docs.squirrelscan.com/rules/perf/total-byte-weight#site-total-and-average-page-weight).
- `crawl/sitemap-valid` warns about the `<lastmod>` values of sitemap URLs that are outside the W3C Datetime format the sitemap protocol requires, such as `2024/09/10`, `2024-9` or `Tue, 10 Sep 2024 12:00:00 GMT` (`sitemap-lastmod-format`), with a sample of URLs and values. A datetime with no zone (`2024-09-10T12:00:00`) is named as missing its zone (`sitemap-lastmod-zone`). A search engine may ignore a lastmod it cannot read. See [crawl/sitemap-valid](https://docs.squirrelscan.com/rules/crawl/sitemap-valid).
- `[rules] time_budget_ms` in `squirrel.toml` sets the rule time budget for `squirrel audit`: how long one rule may spend on one page (its synchronous work) before it is abandoned for that page and the audit moves on (default 1000 ms). It is a backstop against a page built to make a pattern match slowly. Raise it if rules time out on ordinary pages on a slow or busy machine, such as a shared CI runner. `0` turns the budget off. A value below 1000 is refused for now, with `time_budget_ms must be 0 (off) or at least 1000`. Cloud audits keep the default. See [Rule time budget](https://docs.squirrelscan.com/rules#rule-time-budget).

### Pricing

- A signed-in audit, cloud or CLI, is no longer charged for an external link squirrelscan's cloud link checker could not verify: one behind a bot wall, a throttled one, one the run's limit on deeper checks for its site left unverified, or a 404 waiting for its confirming check. The report lists those as unverified, as before. A link the checker did not answer in time is not charged either. Only links that work, redirect or are broken cost a credit (at most 1 per page): each batch of links is charged before it is checked, then settled down to the links the checker verified. The settling is done by squirrelscan's cloud, so it applies to every CLI version that pays for cloud link checks. A link to another of your own domains is external and is charged the same way. See [Credits and pricing](https://docs.squirrelscan.com/cloud/credits).
- The CLI's pricing text says the same: 1 credit per external link the cloud verifies, not per link it checks. That covers `squirrel credits`, the low-balance and credit wall lines, the one-time link pricing notice, the audit estimate and the billing note of the MCP `audit_website` tool.
- `squirrel credits` no longer lists `issue_enrich` (3 per issue). AI issue enrichment is switched off in squirrelscan's cloud, so nothing is sold or charged under it today. The keyword and content gap add-ons are listed as before.

### Changed

- `links/broken-external-links` says why a link could not be verified. A link that answered 404 once and waits for its confirming check reads `(unverified: awaiting confirmation)` on the unverifiable row: it is likely broken, not blocked. Other items keep `(unverified)` or `(unverified: {vendor})`. Each item also carries `meta.unverifiedReason` when the checker knew why: `blocked` for a wall or challenge, `unreachable` for a timeout or failed connection, or `awaiting-confirmation`. An unverifiable link squirrel checks from your machine gets `blocked`, or `unreachable` when its check timed out. The cloud link checker sends all three. The reason is stored with the audit, so `squirrel report` and `squirrel analyze` keep it. See [broken external links](https://docs.squirrelscan.com/rules/links/broken-external-links).
- `squirrel audit` and `squirrel report` say how many items a check left out in their HTML, markdown and text output, not only how many they list. A check that lists 20 of its 26 items now reads `20 items, 6 more not listed` in HTML and `20 item(s), 6 more not listed` in markdown, and the text format prints `... and 6 more items not listed` after the list. A check that lists no items but left some out says so, such as `1,500 items not listed`, where it used to say nothing. The count comes from the check's `details.additional`, which the JSON and LLM formats already reported. A check with nothing left out reads as before.
- A report published from the CLI carries the exact number of pages a rule fails or warns on when its issues reach different pages, in a new top-level `rulePageCounts` field of the JSON. Each issue lists a sample of its pages beside its own true count, but the pages two issues of one rule leave out cannot be told apart, so a rule with one issue on 46 pages and another on 4 different pages could only be counted as at least 46. The count is taken before the report is sampled, over this run's checks (findings carried over from an earlier audit are left out, as in the check tallies), and it is listed only for the rules that need it. See [Output formats via URL](https://docs.squirrelscan.com/reports#output-formats-via-url).

### Fixed

- `squirrel analyze` now replaces a crawl's stored rule results. It used to add a second copy of every check beside the ones the audit, or an earlier `analyze`, had stored, and `squirrel report` then showed the earlier run's items, so a rule change looked like it did nothing.
- `crawl/sitemap-valid` no longer passes a sitemap with a mismatched closing tag (`</lox>` for `</loc>`), an element left open or a raw `&` in a `<loc>` or other element text. It now fails its `sitemap-syntax` check with an error that names the problem and where it is, such as `XML is not well formed: char '&' is not expected. (line 6, column 49)`. The URLs squirrel can still read are kept. Whitespace before the XML declaration is tolerated, and a sitemap that declares its own entities in a DOCTYPE is not checked. See [crawl/sitemap-valid](https://docs.squirrelscan.com/rules/crawl/sitemap-valid).
- `crawl/robots-meta-conflict` reports a page that robots.txt blocks and that carries noindex only in an `X-Robots-Tag` header, and lists the pages on its finding. It decides "blocked by robots.txt" the way Google does: the longest matching `Allow` or `Disallow` wins, an `Allow` wins a tie, and `*` and `$` in a rule are honoured. Before, `Disallow: /dir/` plus `Allow: /dir/ok` counted `/dir/ok` as blocked, and `Disallow: /*.php` matched nothing. The same decision serves `crawl/indexability-conflicts`, `crawl/all-noindex-pages`, `crawl/schema-noindex-conflict` and the GraphQL probe's robots.txt check. The crawler's own robots.txt handling, used when `respect_robots` is on, is unchanged. See [crawl/robots-meta-conflict](https://docs.squirrelscan.com/rules/crawl/robots-meta-conflict).
- `security/csp` no longer reports a strict CSP as weak. In a `script-src` (or `default-src`) that also lists a nonce or a hash, or `'strict-dynamic'`, `'unsafe-inline'` no longer warns `csp-unsafe-scripts`, and next to `'strict-dynamic'` a wildcard host such as `*` no longer warns `csp-wildcard`: browsers ignore those sources (CSP Level 3). So a strict policy of the shape Google recommends, `script-src 'nonce-…' 'strict-dynamic' https: 'unsafe-inline'`, gets no warning. `'unsafe-eval'` still warns. See [security/csp](https://docs.squirrelscan.com/rules/security/csp).
- `security/sri` no longer reports the scripts and stylesheets Shopify injects into every store from `cdn.shopify.com/shopifycloud/` and `cdn.shopify.com/storefront/`, which Shopify updates in place so no store can pin a hash. Theme and app assets elsewhere on `cdn.shopify.com` are still checked. A new `exempt_hosts` option exempts other hosts whose files change at the same URL, by exact hostname: `[rule_options."security/sri"] exempt_hosts = ["static.klaviyo.com"]`. See [security/sri](https://docs.squirrelscan.com/rules/security/sri#options).
- A site with no compression or no caching headers is no longer scored twice for the same server setting. `perf/compression` and `perf/cache-headers` score it page by page, and the `bad-caching-compression` and `bad-caching-freshness` checks of `perf/bad-caching` now report the site's share at info status, which does not move the score. A site missing both now scores a little higher than before: a clean five-page test site served with neither went up 2 points in our smoke test. `bad-caching-validators` is unchanged. See [perf/bad-caching](https://docs.squirrelscan.com/rules/perf/bad-caching).
- A page that quotes a WAF's signature is no longer attributed to that WAF or read as its challenge page. A tutorial printing `<script src="https://js.datadome.co/tags.js">` in a code block, a support page showing `Incapsula incident ID: 1234-5678` in one, or a troubleshooting page that mentions `/cdn-cgi/challenge-platform/` could name the provider in the report's technologies, or be set aside as a challenge page and left out of page-level scoring. Script and markup signatures now count only inside a tag (not a link) or an inline script, and block-page wording only outside `<code>`, `<kbd>` and `<samp>` elements, comments and scripts. Real block and challenge pages are recognised as before. See [Bot protection or WAF challenge](https://docs.squirrelscan.com/guides/failed-audits#waf-challenge).
- `content/placeholder-text` now reads the page's `<title>` too. A title where `undefined`, `null` or `NaN` fills a whole segment between spaced separators (`undefined | Acme`) warns, and one holding `[object Object]` fails, in a new `placeholder-title` check. A page about the word, whose first `<h1>` or one of its `<code>` elements is exactly that word, such as MDN's `undefined - JavaScript | MDN`, is not reported. See [content/placeholder-text](https://docs.squirrelscan.com/rules/content/placeholder-text).
- `content/mojibake` reads the same rendered prose as `content/placeholder-text`. A sequence that appears only inside a `<template>` or a code-editor or syntax-highlighter container (CodeMirror, Monaco, highlight.js, Shiki, Prism) is no longer reported, and adjacent blocks such as table cells no longer fuse into a false sequence. See [content/mojibake](https://docs.squirrelscan.com/rules/content/mojibake).
- `perf/dom-size` counts elements and depth from `<body>`, as its widest-element check already did and as Lighthouse's DOM size audit does. `<head>` metadata such as hreflang alternates and preload hints no longer adds to a page's count or depth, so a small page with a large head reports the body's numbers. The total is the elements inside `<body>`, and `<body>` is depth 1, so a page's depth usually reads one level less than before. Thresholds are unchanged. See [perf/dom-size](https://docs.squirrelscan.com/rules/perf/dom-size).
- `i18n/hreflang` no longer reports "No self-referencing hreflang found" on a URL that answers with an HTTP redirect to a page that references itself. The crawl reads the redirect target's tags, so the self reference is now compared with the URL the redirect ended on. A redirected page's other hreflang findings, such as a missing `x-default`, are about the target's tags and stay. See [i18n/hreflang](https://docs.squirrelscan.com/rules/i18n/hreflang).
- `crawl/pagination` no longer warns that `/blog?page=1` canonicalizes to `/blog`. Page 1 of a list is the same content as the unpaginated URL, so that canonical is correct. Page 2 and later still warn when their canonical points at a URL with no page marker. See [crawl/pagination](https://docs.squirrelscan.com/rules/crawl/pagination).
- `schema/faq` no longer reports every question of a Yoast-style FAQ as missing its name and answer. When `mainEntity` lists node references (`{"@id": "…#q1"}`) to `Question` nodes elsewhere in the page's JSON-LD, the rule now reads the nodes they name, and a `null` entry counts as an invalid question instead of breaking the check. `schema/product` does the same for its first offer, and `schema/review` for `review` entries and `aggregateRating`, judging a review both referenced and present as its own node once. A reference to a node the page does not have is still reported. See [schema/faq](https://docs.squirrelscan.com/rules/schema/faq).
- The sitemap `lastmod` checks (`crawl/sitemap-lastmod-drift`, `crawl/sitemap-lastmod-churn`) and the cloaking probe read dates outside the W3C format more carefully. A time range such as `Sep 10 2024 12:00-14:00` used to be read as 12:00 at offset -14:00, and a value with a time range like that is now not read. An overnight range such as `22:00-02:00` cannot be told from a time and its offset, and still reads as one. A local time that daylight saving skips, such as `2024/03/10 02:30`, now reads as written on every machine. It used to come out an hour off on a machine in a zone that skips it.
- The XML report `squirrel audit` writes now states the scan scope, as the other formats do. Inside `<site>`, `<scan-scope origin="cli" crawled="42" max-pages="100" capped="false"/>` says where the audit ran, how many pages it crawled, the page limit in force and whether that limit stopped the crawl. `requested-max-pages` is added when the requested limit was lowered. A report from before scan scope existed renders as before. See [Reports](https://docs.squirrelscan.com/reports).
- An entity map published from the CLI that has more edges than the publish cap (1,500) now keeps the edges between its best-ranked entities. It used to keep the first 1,500 in alphabetical order, which left late-alphabet entities unconnected. A dangling reference ranks with the entity that makes it, so a problem entity's dangling edges are kept with it.

### Docs

- The README and the docs home page carry one feature list, in the same order, each item linked to its page. The rules configuration page lists all 22 rule categories, the content rules page drops the retired content quality score, and the dashboard audit settings page no longer says only owners and admins can change them.
- The cloud firewall, crawler and crawl settings pages say that cloud browser renders send a website's custom request headers, pinned to the rendered page's own origin, so a gated site no longer needs rendering turned off. A signed-in CLI audit's cloud renders still never carry `-H` headers.
- The XML examples in the docs match what the renderer writes.
- The docs check now fails on dead internal links, dead `#anchors`, missing anchors that other pages link to, and rule Options rows with an `unknown` type or `undefined` default, and the dead anchors it found are fixed.

## v0.0.116 (2026-10-16)

A release about link results and local sites. Cloudflare email-protection links no longer count as broken links, a public page's leftover link to a local-only name is flagged again, a `.test` or `.local` site typed without a scheme is audited over http, and the external link check shows its progress as it runs.

### Changed

- The external link check now reports its progress while it runs, so the CLI's "Checking external links" progress counts up as links are answered, where before it showed no count until the check ended. The check can also be given a time budget, which squirrelscan's cloud audits use. Links still unanswered when the budget runs out, or when one request takes too long, are reported as **Not checked** with reason `external-links-out-of-time`, never as broken, and the audit completes. See [links/broken-external-links](https://docs.squirrelscan.com/rules/links/broken-external-links#which-audits-check-external-links).
- The notice a CLI audit prints when some external links could not be verified from your machine now says what gets them checked by squirrelscan's cloud link checker: a signed-in Surface or Full audit, at 1 credit per link it checks (at most 1 per page). Signing in alone is not enough, since a Quick audit checks links from your machine either way. A signed-in Quick audit now gets the notice too, naming `--level surface`. The `--external-links` help no longer suggests that some level skips external links. See [Link checking](https://docs.squirrelscan.com/guides/link-checking#checking-links-from-the-cli-without-signing-in).

### Fixed

- `links/broken-links` no longer reports Cloudflare email-protection links as broken. With Cloudflare's Email Address Obfuscation on, every `mailto:` link and every email address in a page's text becomes a link to `/cdn-cgi/l/email-protection`, which answers an error when requested, so a site with an address in its footer had one broken link per address, sourced from every page. These links are email addresses, not pages: the crawl, the internal link check and the external link check never request them, and they are read as the `mailto:` links they stand for. The `broken-links` row's `details.emailProtectionLinks` says how many were left out. Other `/cdn-cgi/` links, such as image resizing URLs, are still checked. See [links/broken-links](https://docs.squirrelscan.com/rules/links/broken-links).
- A public page's link to a local-only name, such as a leftover `http://myapp.test/` from a CMS preview, stands out again. Since 0.0.114 the external link check does not request a `.test`, `.example` or `.invalid` name, or one under `.localdomain` or `.home`, and lists it as info where it used to count as a broken link. `content/dev-leakage` now warns about them as a new `local-name` kind: names under `.test`, `.example`, `.invalid`, `.local`, `.lan`, `.internal`, `.localdomain`, `.home` and the other local-only zones, and single-label hosts such as `intranet`. `.onion` and `.alt` names are not included. An audit of a local site such as `myapp.test` skips the rule, so its links to other local names are not reported. `reliability/broken-forms` likewise reports a form that posts to one of these names as `non-production-form-action`, without sending it, unless the audited site is itself local. See [content/dev-leakage](https://docs.squirrelscan.com/rules/content/dev-leakage).
- `squirrel audit myapp.test`, typed without a scheme, now audits `http://myapp.test/` instead of `https://myapp.test/`. Laravel Valet and Herd serve `.test` sites over plain http unless the site is secured, so the audit used to fail to connect. Every host the CLI treats as local or private now defaults to `http://` the way `localhost` and private addresses already did: `box.local`, `nas.lan`, `db.internal` and the other local-only names. A public host still defaults to `https://`, and a scheme you type is kept. See [Local audits](https://docs.squirrelscan.com/guides/local-audits-cli#local-and-private-hosts-stay-local).
- `a11y/aria-dialog-name`, `a11y/aria-command-name`, `a11y/aria-input-field-name`, `a11y/aria-labels` and `a11y/form-labels` no longer report controls that are out of the accessibility tree, as `a11y/button-name` already does. That covers a control with the `hidden` attribute or `aria-hidden="true"`, an inline `display: none` on it or an ancestor, an inline `visibility: hidden` on it, or a control inside a closed `<dialog>` or an unopened `popover`. A closed modal marked `aria-hidden="true"` no longer counts as an unnamed dialog. A control an inline style may hide in a form squirrel does not read exactly is reported as unconfirmed, a warning, not a failure. A closed native `<dialog>` is still checked, since pages open it with script. Hiding by `<style>` blocks and stylesheets is not read yet, so a control hidden only by a class rule is still reported. See [a11y/aria-dialog-name](https://docs.squirrelscan.com/rules/a11y/aria-dialog-name).

## v0.0.115 (2026-10-15)

Quick audits in the CLI now check the links that leave your site, as Surface and Full already do. At Quick they are checked from your machine and the link checks cost no credits. `squirrel audit --offline` stops checking anything on another site, and the inbound-link rules stop flagging the page a crawl starts on. Cloud audit defaults are unchanged in this release.

### Changed

- **Quick audits in the CLI check external links too.** Every audit level now checks the links that leave your site, Quick included.
  - A Quick audit checks them from your machine, signed in or not, and the link checks cost no credits.
  - A Quick audit now also requests the pages your site links to on other sites, signed out included, so it can take a little longer.
  - Skip them with `--no-external-links` or `[external_links] enabled = false`. `--offline` still skips them.
  - Cloud audits keep their current link check settings for now. Any change to the cloud defaults will be announced separately.
  - See [Link checking defaults](https://docs.squirrelscan.com/rules/links#link-checking-defaults).
- `links/broken-external-links` no longer calls every link it could not verify "blocked by WAF". Many are not a firewall: a timeout, a CDN error page or a 404 waiting for its confirming check lands in the same list. The row now reads `{count} external link(s) could not be verified - status unverifiable`, and each item reads `(unverified)`, with a vendor added when the checker named one. The check name, `waf-blocked-external-links`, is unchanged. See [broken external links](https://docs.squirrelscan.com/rules/links/broken-external-links).

### Fixed

- `squirrel audit --offline` no longer status-checks anything on another site: the third-party scripts, stylesheets and fonts the pages load, and sitemap URLs on another site, are left alone. `reliability/broken-resources` reports the third-party resources as not measured on an offline run, and `crawl/sitemap-4xx` says how many sitemap URLs on another site it skipped. Requests to the audited site can still end up on another host when the site sends them there: a page or asset redirect, or a sitemap that robots.txt lists on another host. See [audit](https://docs.squirrelscan.com/cli/audit).
- `links/orphan-pages`, `links/weak-internal-links` and `links/no-contextual-inbound` no longer report the page the crawl started on. When a site's root redirects to a deeper page (`/en/`, or a sign-in page), the redirect leads there, and often no link does, or only the logo in every header does, so the site's front door read as a page with too few incoming links. `integrity/orphan-page` already exempted it. See [links/orphan-pages](https://docs.squirrelscan.com/rules/links/orphan-pages).

## v0.0.114 (2026-10-15)

A pricing correction, and a release about trusting your link results. Version 0.0.113 said a signed-in audit's link checks were free. For the links the cloud checks, that was wrong, and this release puts it right: a signed-in audit now pays for its cloud link checks the same way a cloud audit does. Links squirrel checks on your machine stay free, and so do internal links. Beyond pricing, a link that meets a sign-in or bot wall is listed as unverifiable instead of broken, broken internal links say exactly what each audit covered, an audit of a site on your own network keeps what it finds there on your machine, and `squirrel analyze` fetches what its rules read the same guarded way `squirrel audit` does.

### Pricing

- A signed-in audit pays for its cloud link checks: 1 credit for each distinct external link the cloud's link checker answers, an unverifiable answer included, at most 1 per page of the audit's page limit, and only at the levels that send external links to the cloud (surface and full, or a custom level with cloud checks and external links on). Version 0.0.113 said these checks were free; they are not.
  - Still free: a link the cloud can't answer in time, which squirrel checks on your machine; internal links; and every link in a signed-out audit. A quick audit with `--external-links` checks its links on your machine and pays nothing for them.
  - Each page of the audit's page limit now reserves its link check, so the same `max_credits_per_audit` covers fewer pages, and starting a signed-in surface or full audit needs 1 more credit than before. The pre-audit estimate and the page cap fitted to your balance include the link checks. `squirrel credits` and the low-balance messages state the price, and the first signed-in audit that checks external links after you update prints a one-time notice. Skip the checks with `--no-external-links`.
  - An audit that can't register a run, such as one signed in with an organization API key, checks its links on your machine and pays nothing for them.
  - Older versions keep free cloud link checks until 2026-11-12. From then, they check their links on your machine until you run `squirrel self update`.
  - See [Credits and pricing](https://docs.squirrelscan.com/cloud/credits).

### Security

- An audit of a site on a private network (`localhost`, a private address, a `.local` name) no longer reads or writes the external link cache that every audit on your machine shares. A later audit of a public site could otherwise be answered from that cache about a public name that resolves to a private address. Results cached by earlier versions are not reused, so each link is checked again once after you update.
- No audit sends the cloud's link checker a link whose URL names a private or local host (a private IP address, `localhost`, a `.local` or single-label name). squirrel checks those itself. When the cloud declines a link because it, or a redirect it leads to, is on a private address, that is never reported as a broken link.
- `squirrel analyze` fetches the assets its rules read the way `squirrel audit` does. Its own copy of that step followed a script's redirects without checking where they led, so a script that redirected to a cloud metadata address led it to request that address. Every asset and link check, and every redirect those follow, is now held to the audit's rules. `analyze` also checks the internal links the crawl did not fetch, uses the crawl's own scope and page limit rather than the `squirrel.toml` in your current directory, and sends none of that file's custom request headers. It now also fetches fonts, preloaded scripts and web app manifests, status-checks third-party scripts, stylesheets and fonts while `reliability/broken-resources` is on, and no longer caches scripts between runs. See [analyze](https://docs.squirrelscan.com/cli/analyze).

### Changed

- A link checked from your own machine that meets a wall is listed as unverifiable, not broken. That covers a sign-in or bot wall (401, 403, 405, 406, or LinkedIn's 999), a challenge page served as a 503, and a site that never answers in time. Most of these used to be counted as broken, so a signed-out audit's broken link list was mostly links that work in a browser. They are now listed under `waf-blocked-external-links` in `links/broken-external-links`, and `links/dead-links` no longer counts them. A real 404 or 410, a plain 503, a domain that does not exist and a refused connection are still broken, and so are a storage bucket's 403 for a missing file, an HTTP sign-in prompt and a 405 that allows no GET. Walls and timeouts are no longer cached, so the next audit asks again, and one an earlier version cached as broken is checked again. A signed-out audit with unverifiable links says so and suggests `squirrel auth login`, since the cloud's link checker can usually get a real answer. See [links/broken-external-links](https://docs.squirrelscan.com/rules/links/broken-external-links).
- `links/broken-links` says what it covered on every row, the failing one included: how many internal link targets the pages link, how many the internal link check got an answer for, how many nothing fetched, and why (past the `internal_links.max_targets` limit, skipped by design, not trusted, or no answer). Comparing two audits can then tell a link that was fixed from one the later audit did not check. `squirrel report --diff` leaves these counts out of each broken link, so a change in coverage alone no longer marks every broken link as changed. A link that only a rate-limited page carries is no longer requested, or counted as skipped or past the limit. See [links/broken-links](https://docs.squirrelscan.com/rules/links/broken-links).
- Names under the reserved `.test`, `.example` and `.invalid` zones, and under `.localdomain`, `.home`, `.onion` and `.alt`, count as local hosts, like `.local`. An audit of a Laravel Valet or Herd site such as `myapp.test` is treated as an audit of your own machine: no publish, no cloud render, the delivery rules (such as HTTPS and caching) skipped, and its links to other local names checked from your machine. On a public site's audit, a link to one of these names is not requested and is listed as `refused-external-links` instead of broken. See [Local audits](https://docs.squirrelscan.com/guides/local-audits-cli#local-and-private-hosts-stay-local).

### Fixed

- `links/broken-links` keeps the crawl's answer for a linked page the crawl fetched but does not grade as a page. A PDF that loaded no longer counts as an unchecked target, so a site that links its own PDFs can read as fully checked, and one that answered 404 is still broken. A linked page that answered the crawl with rate limiting is listed in `rate-limited-links`, and one that answered with a bot-wall challenge in `refused-links`. See [links/broken-links](https://docs.squirrelscan.com/rules/links/broken-links).
- `integrity/orphan-page` no longer reports the page the crawl started on as a hidden page. A site whose root redirects to a deeper page, such as `/en/` or a sign-in page, had that landing page read as hidden, and as a likely injected page when it also carried a page-level signal. The opt-in cloaking probe no longer picks it either. See [integrity/orphan-page](https://docs.squirrelscan.com/rules/integrity/orphan-page).
- `crawl/sitemap-valid` reads a sitemap whose root uses a prefix bound to the sitemap namespace, such as the `ns0:urlset` that Python's ElementTree writes by default. It used to report an unknown sitemap format and read none of its URLs. A prefixed sitemap index reads too. See [crawl/sitemap-valid](https://docs.squirrelscan.com/rules/crawl/sitemap-valid).
- The sitemap date checks read every date as the period it names, the same way on every machine. A date with no time is the whole day, a datetime with no zone is read in UTC, and a date that is not a real date is left out instead of guessed at. `crawl/sitemap-lastmod-drift` no longer warns that a `lastmod` of `2024-09-10` is 253 days ahead of a page dated `2024`, `crawl/sitemap-lastmod-churn` counts the day a `lastmod` was written in its own zone and says when most of a sitemap's lastmods can't be read, and the cloaking probe stops treating pages dated only with this year as old two weeks into the year. See [crawl/sitemap-lastmod-drift](https://docs.squirrelscan.com/rules/crawl/sitemap-lastmod-drift).

## v0.0.113 (2026-10-15)

A safety and accuracy release. The external link check no longer requests links that are actions or carry a credential, such as one-click unsubscribe links, magic sign-in links and signed downloads, and every request it sends, redirect hops included, goes only to a public address (or a private one when the audited site is private), never to a link-local or cloud metadata address. `squirrel audit`'s asset checks can no longer be pointed at a cloud metadata service, the GraphQL probes no longer let a compressed answer inflate past their read limit, and an audit now closes each connection once it has read what it needs, so an endless body no longer keeps downloading. Sitemap dates, bot-protection names and a dozen rules report more accurately too.

### Security

- The external link check no longer requests third-party links that look like actions or carry a token. Examples are a newsletter's one-click unsubscribe link, a magic sign-in link or a signed download URL, where the URL itself is the credential and a request can use it up.
  - It uses the internal link check's rules (action words, token-shaped values, keys such as `token` or `sig`) and skips links whose text is plainly an action ("Log out", "Unsubscribe").
  - A signed-in audit does not send these links to the cloud's dead-link check either.
  - `links/broken-external-links` lists them in a new info check, `not-requested-external-links`, with tokens masked. They are never reported as working or broken, and they do not count against `max_links`.
  - When squirrel checks a link itself it now follows redirects by hand, so a short link that redirects into one stops at the redirect.
  - Every request and redirect hop goes only to a public address (private ones too for an audit of a private site), never to a link-local or cloud metadata address, and connects to the address it checked.
  - See [What the external link check never requests](https://docs.squirrelscan.com/configuration/external-links#what-the-external-link-check-never-requests).
- The internal and external link checks also skip three kinds of link they used to request.
  - A server-script extension (such as `.aspx`, `.php`, `.jsp` or `.do`) no longer counts as a word, so `/MyAccountLogOut.aspx` reads as the four-word sign-out it is. Any other action word is read the same way (`/delete-your-account.php`, like `/delete-your-account`).
  - Log out, log off and sign out now count in a path segment of five words (`/my-account-log-out-now`). A longer slug that only mentions signing out (`/blog/how-to-log-out-of-every-device`) is still checked.
  - A link with a credential in its query string is never requested: a key such as `api_key`, `x-api-key`, `pwd`, `session_id`, `accesstoken`, `authorization`, `jwt`, `x-amz-credential` or `x-goog-credential`, in any case, with `-`, `_` and `.` ignored, or in brackets (`config[api_key]`, `pwd[0]`).
  - A not-requested link listed in `links/broken-external-links` now has a path segment holding an email address masked, where `/unsubscribe/user@example.com/…` used to show the address. An asset name such as `logo@2x.png` is kept.
- External links refused for their address are now listed in `links/broken-external-links` as `refused-external-links` instead of silently left out, and never counted as working or broken. That covers a link-local or cloud metadata address on any audit, and a private or loopback one on a public site's audit.
  - A link refused on its URL alone is not counted as checked: it takes no slot under `max_links`, is not answered from the link cache (where an audit of a private site may have stored a verdict for the same URL), and is not sent to the cloud's dead-link check.
  - A re-audit no longer reports an old verdict for an external link this audit did not check.
- `squirrel audit`'s asset checks can no longer be pointed at a cloud metadata service.
  - A stylesheet, script, image, font, PDF or sitemap URL on the audited site is refused at the hop, before anything is sent, when it redirects to a link-local address (`169.254.0.0/16`, `fe80::/10`) or a metadata hostname, or sits on a subdomain outside the hosts the crawl itself requests whose name points at one.
  - The hosts the crawl itself requests are requested as before, so an audit of `localhost`, a LAN address or a `.local` name still loads its own assets.
  - A sitemap URL on another host is checked without your [custom request headers](https://docs.squirrelscan.com/configuration/crawler#headers). They used to go to whatever host a sitemap listed, Web Bot Auth signatures and `Authorization` included.
- The GraphQL probes behind `security/graphql-introspection` and `security/graphql-get-mutations` no longer let a site answer with a compression bomb.
  - Their requests went out with the runtime's own decompression on, and Bun inflates a gzip or brotli body in full as it arrives, before the probe's read limit applied. A probed endpoint could cost an audit gigabytes of memory.
  - They now fetch with that decompression off, like every other request an audit sends, and decompress the answer no further than the probe's limit (1 MB for introspection, 64 KB for the mutation probe).
  - Each probe also closes its connection once its answer is read, where an endless answer used to keep downloading until the 10-second timeout.
  - Findings are unchanged. See [security/graphql-introspection](https://docs.squirrelscan.com/rules/security/graphql-introspection).
- `integrity/brand-impersonation` and `integrity/fake-auth-overlay` no longer lose a signal to how a page's markup is spaced.
  - An off-brand "Sign in with Google" link right after `<h1>Welcome</h1>` used to read as `welcomesign in with google`, so the sign-in cue was missed and a correlated overlay dropped from fail to info.
  - The cues are now also read from element-separated text, with invisible characters removed and whitespace collapsed, so a newline, `&nbsp;`, a `<br>` or a zero-width space inside a link's label of up to 300 characters no longer hides it either. A longer label is read as before, lowercased only.
  - For `integrity/brand-impersonation`, a link whose own label says sign in or log in now counts as a credential affordance, like a password field.
  - See [integrity/brand-impersonation](https://docs.squirrelscan.com/rules/integrity/brand-impersonation).

### Changed

- A signed-in audit's link checks are free, a firewall-blocked link included: [Credits and pricing](https://docs.squirrelscan.com/cloud/credits#pricing) no longer lists a 2-credit charge for one. At the surface and full levels, a signed-in audit's external links go to the cloud's dead-link check, and any link it leaves unanswered is checked on your machine.
- A signed-in audit no longer waits out a busy dead-link service batch by batch. squirrel sends the service up to 200 external links at a time, and any link left out of a reply is checked locally. When a reply answers none of its links, squirrel now stops asking and checks the rest locally straight away. Before, it sent every remaining batch and waited on each, about 100 seconds on a site with 1,000 external links. See [links/dead-links](https://docs.squirrelscan.com/rules/links/dead-links).

### Fixed

- An audit no longer goes on downloading a response it is done with.
  - Bun keeps receiving the rest of a body it has stopped reading until the request is aborted, and most of squirrel's requests only cleared their timeout. A site answering with an endless body kept the connection open, and kept sending, after squirrel had moved on, in most cases until the audit ended.
  - That covered the reads with a size limit (robots.txt, sitemaps, `llms.txt` and the other root files, scripts, the external link check's look at a 403 page, the soft-404 and cloaking re-fetches, plain-HTTP page fetches in an audit that uses cloud rendering) and the status checks that drop a body unread (external link checks, asset checks, link target checks, the `reliability/broken-forms` probes, the reachability check of a localhost site).
  - squirrel now closes each connection as soon as it is done with it. What an audit reads is unchanged.
- A sitemap with a bare-year `<lastmod>2024</lastmod>`, which the W3C Datetime format allows, is now read. `crawl/sitemap-valid` used to report the whole file as an error starting `Parse error: entry.lastmod?.trim is not a function`, and none of its URLs were read.
  - Sitemap values are now kept as the text the file wrote, and a bad entry costs only itself, except that a raw `<` reads as an unclosed tag and can hide the entries after it.
  - An entry whose `<loc>` holds markup, a raw `<`, or appears twice is skipped and counted (`N <url> entries skipped: <loc> is not a single text value`), and the text around markup is never read as the URL.
  - A `<lastmod>`, `<changefreq>` or `<priority>` like that is dropped and its URL kept (`N <lastmod> values ignored: not a single text value`).
  - See [crawl/sitemap-valid](https://docs.squirrelscan.com/rules/crawl/sitemap-valid).
- `crawl/sitemap-lastmod-drift` and `crawl/sitemap-lastmod-churn` read a `lastmod` of just a year or a month (`2024`, `2024-09`, both valid W3C Datetime values) as that whole year or month, not its first day.
  - A year-stamped sitemap used to look months behind every page dated later that year (`lastmod 2024 vs dateModified 2024-09-10 (253 day(s))`), and churn reported a day the sitemap never wrote.
  - Drift is now measured from the nearer end of the period, and churn leaves such values out of its sample.
  - Churn's "too small to judge" message counts them: a sitemap with only a few lastmods, all years or months, used to read `Only 0 sitemap URL(s) carry a lastmod`.
  - See [crawl/sitemap-lastmod-drift](https://docs.squirrelscan.com/rules/crawl/sitemap-lastmod-drift).
- `links/broken-links` names the real reason in its Not checked line.
  - When the internal link check answered some targets and skipped others as actions, token links, out of the crawl scope or disallowed by robots.txt, the line said it `status-checked only the N most-linked targets` and told you to raise `internal_links.max_targets`, even with nothing over the limit.
  - The line now names the cause that applies, gives a count for each when there are several (past the limit, skipped, not trusted, no answer), and suggests raising `internal_links.max_targets` only when the limit left targets out. The check's `details.notFetched` carries the counts.
  - See [links/broken-links](https://docs.squirrelscan.com/rules/links/broken-links).
- With cloud link checking (signed in), a link the checker could not verify is listed with the firewall-blocked links as `status unverifiable`, never as broken. That covers a timeout or failed connection from the checker's network, a firewall refusal, and a 404 waiting for its confirming second check. Before, a timeout was counted as a broken link and a refused link was left out of the report. See [links/broken-external-links](https://docs.squirrelscan.com/rules/links/broken-external-links).
- Bot protection is named more accurately.
  - The vendor's own cookie names now count (Cloudflare's `__cf_bm`, DataDome's `datadome`, HUMAN's `_px3`, Kasada's `KP_UIDz`, Akamai Bot Manager's `_abck`, Imperva's `incap_ses_*`, AWS WAF's `aws-waf-token`), names only, never values.
  - A vendor behind a CDN is named over the CDN, so a DataDome block served through Cloudflare reads as DataDome.
  - A site on CloudFront, API Gateway or Lambda is no longer reported as behind AWS WAF from those services' own headers: only AWS WAF's action header, cookie or challenge script, or CloudFront's "Request blocked" error page, count.
- `eeat/privacy-policy`, `eeat/about-page` and `eeat/contact-page` no longer tell you to create a page your pages already link to.
  - When the crawl did not fetch the policy, because its path is excluded (`/policies/**` on a Shopify storefront) or the page limit came first, `eeat/privacy-policy` now reports `Privacy Policy linked but not crawled` as info. It warns `Privacy Policy link returns N` when the internal link probe saw that link answer a 4xx or 5xx other than 401, 403 or a rate limit, and it still warns `No Privacy Policy page found` when nothing links to a policy.
  - The About and Contact rules report `About page linked but not crawled` and `Contact page linked but not crawled` (or `About page link returns N`, `Contact page link returns N`), recognising the link by its path only.
  - All three count only links to the same host, so a footer link to another site's `/about`, or to reCAPTCHA's `policies.google.com/privacy`, never stands in for a missing page.
  - No extra requests are made. See [eeat/privacy-policy](https://docs.squirrelscan.com/rules/eeat/privacy-policy).
- `perf/critical-request-chains` and `perf/font-delivery` count only the CSS `@import`s a browser fetches. An `@import` inside a comment (`/* @import url(a.css); */`), a string or a `url()` no longer counts as a network request, and neither does one after another rule or inside `@media`, which a browser ignores.
- `content/placeholder-media` no longer reports a 1x1 inline `src` as a blank pixel when the image sits in a `<picture>` whose `<source srcset>` names a real image: the browser shows the source, so the `src` is a stub.
- `local/nap-consistency` no longer reads a button label as part of a phone number's format. A `tel:` link showing `+49 (0)6061 630 980 0` with `Jetzt anrufen` on German pages and `Call now` on English ones was reported as one number written two ways. Only the number's own characters (digits, `+`, parentheses, `.`, `/`, `-` and spaces) are compared now, and a genuinely different rendering such as `060616309800` still warns. See [local/nap-consistency](https://docs.squirrelscan.com/rules/local/nap-consistency).
- `schema/rating-scope` no longer warns that a rating is not visible when the page prints it in elements with no whitespace between them. `<h3>Customer rating</h3><p>5/5</p>` used to read as `Customer rating5/5`, where no rating phrase matched. The rule now also searches the page text with a space at every element boundary, so glued and spaced markup get the same verdict. See [schema/rating-scope](https://docs.squirrelscan.com/rules/schema/rating-scope).

## v0.0.112 (2026-10-13)

Seven new rules, and a new category to hold two of them. squirrelscan now ships 308 rules across 22 categories. The new **Reliability** category catches the things that look fine until a visitor needs them: a deleted script bundle behind a page that still answers 200, or a form that quietly loses every submission. Also new: broken in-page anchors, `security.txt` and version-leaking headers, the web app manifest, and a misspelling check with its own MIT-licensed word list. The new checks that request other hosts go through a new egress guard, so a page cannot point squirrel at your own network.

### Added

- New **Reliability** category, in the Performance score group, with its first rule, `reliability/broken-resources`. A page can answer 200 while the script or stylesheet it depends on returns 404 or 500, usually because a deploy deleted the hashed bundle that cached HTML still references.
  - A first-party script or stylesheet that answers 4xx or 5xx is an error. First-party means the same registrable domain as the site, so `cdn.example.com` counts for `www.example.com`.
  - A third-party file, a font or a network failure is a warning.
  - A 429, 430, 503 with `Retry-After` or a WAF challenge is recorded as unverified, never as broken.
  - One finding per URL lists every page that references it.
  - A fetch the time budget skipped or a cap dropped is noted as a partial check, and the pass says how many resources it checked.
  - Third-party files get a status-only check each: `HEAD` first, a `GET` only when the `HEAD` fails or answers 400 or above, and no body read. That is at most 50 per kind per audit, and only while the rule is enabled. These requests carry none of your custom request headers and go through the egress guard (see Security below).
  - See [reliability/broken-resources](https://docs.squirrelscan.com/rules/reliability/broken-resources).
- New rule `reliability/broken-forms`: a form can look perfect and still lose every submission.
  - A field with no `name` is never sent (warning).
  - A first-party action the crawl found 404 or 410 is an error.
  - An action on a staging, preview or localhost host, or a `mailto:` action, warns. On a localhost or private-network audit those hosts are the site's own and are not reported; on a preview deployment only localhost and private-IP actions are.
  - An action the crawl did not fetch is probed only at the `active` or `aggressive` probe level, at most once per endpoint (25 per audit, 10 per site, the site's own first). The probe sends `HEAD`, and a `GET` only when the `HEAD` is refused (405 or 501) or fails, never `POST`. It carries no cookies or custom headers and follows no redirects. A third-party action is probed only when the audit checks external links and only on public addresses; a same-site action only on the site's own hosts.
  - A 404 to that probe warns that the endpoint may accept `POST` only.
  - See [reliability/broken-forms](https://docs.squirrelscan.com/rules/reliability/broken-forms).
- New rule `links/broken-anchors`: a link to `#pricing`, or to `/docs/setup#install` on another crawled page, whose target id is gone still loads, and the reader lands at the top of the page instead of the section.
  - The rule warns once per broken target and fragment, lists every page that links to it, and labels a broken skip link.
  - It matches the way the browser does: percent-decoded, case-sensitive, `id` or `<a name>`.
  - It leaves out `#`, `#top`, purely numeric fragments such as `#0`, hash routes and text fragments.
  - A link into an unrendered client-side page is recorded as unconfirmed rather than broken.
  - See [links/broken-anchors](https://docs.squirrelscan.com/rules/links/broken-anchors).
- Two new security rules.
  - `security/security-txt` checks for an RFC 9116 `security.txt` at `/.well-known/security.txt`, and the legacy `/security.txt`. It warns when the file is missing (404 or 410), when the path answers with the site's HTML catch-all page, when `Contact` or `Expires` is missing, and when `Expires` is not an RFC 3339 date-time, has passed, or appears twice. A 401, 403, 429 or 5xx is recorded as not checked, never as missing.
  - `security/version-disclosure` warns when `Server`, `X-Powered-By`, `X-AspNet-Version`, `X-AspNetMvc-Version` or `X-Generator` names a software version (`Apache/2.4.41`, `PHP/7.4.3`), one finding per value listing every page it was seen on. A product name alone (`Server: nginx`) is fine. On pages stored by an earlier version only `Server` is checked; re-run with `--refresh` for the rest.
  - See [security/security-txt](https://docs.squirrelscan.com/rules/security/security-txt) and [security/version-disclosure](https://docs.squirrelscan.com/rules/security/version-disclosure).
- New rule `mobile/web-app-manifest`: the manifest a page links (`<link rel="manifest">`) sets the home-screen icon, name and splash colours, and nothing shows on a desktop browser when it rots.
  - The rule fetches each same-site manifest once, however many pages link it, and its same-origin icons.
  - A manifest that answers 4xx or 5xx, or is not valid JSON, is an error.
  - These are warnings: a wrong content type; a missing `name` (and `short_name`), `start_url` or `display`; a missing 192px or 512px PNG icon; a broken icon, or one whose real size differs from its declared `sizes`; a hex `theme_color` that differs from the pages' hex `theme-color`.
  - Redirects off the site, rate limits and WAF challenges are recorded as not checked.
  - See [mobile/web-app-manifest](https://docs.squirrelscan.com/rules/mobile/web-app-manifest).
- New rule `content/common-misspellings`: every word on English pages (`<html lang="en">`) is looked up in a bundled list of known misspellings (`recieve` for `receive`), and doubled function words such as "the the" are flagged.
  - A misspelling in a title, meta description or heading is a warning. One in body copy, and a doubled word, is info-level advice, which reports do not list yet.
  - Each finding names the correction, the page count and example pages with context.
  - Code, URLs, emails, ALL CAPS, other languages, British or American variants, and names (a word the page capitalises mid-sentence) are left alone. `ignore_words` takes your brand spellings.
  - The list of about 520 misspellings was written for squirrelscan and is MIT licensed.
  - See [content/common-misspellings](https://docs.squirrelscan.com/rules/content/common-misspellings).

### Security

- The new checks that send requests beyond the crawl go through an egress guard: the third-party status checks of `reliability/broken-resources`, the form action probes of `reliability/broken-forms`, and the manifest and icon fetches of `mobile/web-app-manifest`, which are held to the site's host and its subdomains on every redirect hop.
  - The guard checks the address before every hop, so a public URL that redirects to a private one is refused before the private hop is sent.
  - On a public site only public addresses are allowed, except the audited origin itself, which the crawl already requests. A private, loopback, link-local, CGNAT or reserved address, a name that is not public by itself (`localhost`, `*.internal`, a dotless host), and a name that resolves to such an address are all refused.
  - A site addressed by a private IP or a local name (`localhost:3000`, `192.168.1.10`, `nas.local`) may reach private hosts, never link-local or cloud metadata addresses.
  - Each guarded request connects to the address that was vetted, so DNS rebinding cannot swap it between the check and the request.
  - The third-party status checks and the form probes carry no cookies and none of your custom request headers or Web Bot Auth headers. Manifest and icon fetches stay on the site's host and its subdomains and carry your custom request headers, like the other same-site asset checks.
- Known limit: your custom request headers still go to subdomains of the audited host, not only the audited host itself (auditing `example.com` sends them to `cdn.example.com` too). Limiting them to the audited origin is planned.

### Docs

- The docs and README count 22 categories, and their per-category rule counts add up to 308. The dashboard crawl settings and the MCP pages describe the internal link checks setting and the `internal_links` and `external_links` switches.

## v0.0.111 (2026-10-13)

Broken links have nowhere left to hide. Every audit, Quick included, now status-checks the internal link targets its crawl did not fetch, so a linked 404 shows up even when it is not in your sitemap or sits past the page budget. External links stay opt-in at Quick, and there are new flags for both.

Behaviour changes:

- **squirrel sends requests it did not send before.** After the crawl, every audit sends a status-only `HEAD` to each internal link target the crawl did not fetch: up to 200 per audit, the links on the most pages first. Before those, it sends one `HEAD` to the audited URL, to see whether the server answers `HEAD` properly. These requests send no cookies, credentials or custom request headers, and never go to a link that looks like an action (log out, unsubscribe, delete, add to cart) or carries a token. Switch them off with `--no-internal-links` or `[internal_links] enabled = false`.
- **Expect new `links/broken-links` findings**, and Links scores that move with them: Quick audits now find linked 404s their sitemap does not list, and Surface and Full audits find broken pages past their page budget.
- **"Not checked" is narrower.** In 0.0.110 a Quick audit reported every internal link target it did not fetch as Not checked. Now that only covers the targets the status check did not answer: over the limit, outside the crawl scope or robots.txt, an action or token link, no answer, or a site whose `HEAD` answers cannot be trusted.
- **External links:** which levels check them by default does not change. Surface and Full do, and Quick does not unless you pass `--external-links`. An audit that checks them now requests at most its page budget or 200 distinct external links, whichever is more.

### Changed

- Internal link checks run at every audit level, Quick included. Each internal link target the crawl did not fetch gets a status-only `HEAD` request, or a one-byte `GET` when the server answers `HEAD` with 405 or 501.
  - The check covers up to 200 targets per audit, the links on the most pages first, inside the crawl scope and, when the crawl respects it, robots.txt. Change the limit with `[internal_links] max_targets`.
  - It is free: no page is added, rendered or charged.
  - A target that answers with 401 or 403 is recorded as unverifiable in an info-level `refused-links` check, never as broken. Reports do not list info checks yet.
  - See [Link checking defaults](https://docs.squirrelscan.com/rules/links#link-checking-defaults).
- The internal link check is built not to change anything on the site.
  - It never requests a link that looks like an action (log out, unsubscribe, delete, confirm, add to cart) or carries a token. It re-checks every redirect hop against the same rules, and it sends no cookies, credentials or custom request headers.
  - On a site that answers `HEAD` with an error on the audited URL, the targets' errors are not trusted, so they are never reported as broken.
  - These rules are a careful default, not a guarantee. A site that changes state on `GET` requests to links that read like pages should switch the check off with `--no-internal-links`.
  - See [What the internal link check never requests](https://docs.squirrelscan.com/configuration/external-links#what-the-internal-link-check-never-requests).
- An audit that checks external links now requests at most its page budget or 200 distinct external links, whichever is more, the links on the most pages first. The rest are listed as **Not checked** (reason `external-links-over-cap`). Only sites that link out to more than that see a difference. Change the limit with `[external_links] max_links`.

### Added

- `--external-links` checks external links for one run at any level, Quick included, and `--no-external-links` skips them. `--no-internal-links` switches the internal link check off.
  - `--external-links` cannot be combined with `--offline` or `--no-external-links`, and it overrides `[external_links] enabled = false`.
  - At Quick it makes the audit custom, `custom (quick + external_links on)`.
  - All three are in the shell completions.
- The local MCP server's `audit_website` tool takes `externalLinks` and `internalLinks` switches. `offline: true` with `externalLinks: true` is refused, as on the command line.

## v0.0.110 (2026-10-12)

A small release with two fixes worth having. A site that answers with compression bombs no longer eats gigabytes of your memory while squirrel crawls and checks it: squirrel now decodes compressed responses itself, as it reads them, and stops at each read's size limit. And a Quick audit stops telling you your links are fine when it never checked them: those checks now say **Not checked**, with what to run instead.

Behaviour changes:

- `links/broken-external-links` and `links/broken-links` report **Not checked** instead of a pass when they did not run. A Not checked result is left out of the score, and the JSON report gains a `notChecked` list when there is one. A Quick audit's Links score can drop a few points where the empty passes used to pad it.
- squirrel now decodes compressed pages and the other responses listed below itself (sitemaps already had their own reader). A response sent as `x-gzip` or an upper-case `GZIP` is now decoded, where it used to be read as raw bytes. A gzip body made of several members is read to the end of its first member, as browsers read it, where the previous release read every member. A page body that does not decode is still recorded as a decode failure, and the message now gives the decoder's reason.

### Fixed

- A compressed page, root file or checked resource that inflates to gigabytes no longer exhausts memory. The runtime could inflate a `Content-Encoding` body in full before squirrel read it, even when squirrel read it under its size limit, cancelled it unread or discarded it with a redirect. In our test, an audit of a four-page site whose page, redirect, robots.txt and llms.txt were each a 1 GiB bomb (sent as about 1 MB of compressed data) peaked at 1.8 to 2.8 GB of memory on the previous releases.
  - These requests now turn the runtime's decoding off, and squirrel decodes the body as it reads it, stopping at that read's limit: pages and redirects, robots.txt, llms.txt, the well-known and agent files, RSL licences, Markdown versions of pages, the reachability check, scripts, external links, and the soft-404 and cloaking re-checks. An asset's size is counted as its body streams by, without holding it. Sitemaps already turned the runtime's decoding off and capped what they read.
  - The same audit, run with this release's build, now peaks at about 275 MB, against about 150 MB for the same site without the bombs, and reports the same findings. The bomb page is cut at 10 MB, as before, which is where an uncompressed page over the limit is cut too.
  - These requests send the same `Accept-Encoding` as before, squirrel's decoder handles `gzip`, `deflate`, `br` and `zstd`, and bytes a server appends after a complete compressed body are still ignored. The decoding changes are listed under Behaviour changes above.
  - The CLI's script check now stops reading one byte past its size limit instead of downloading the whole script first, and an external link's 403 page is read up to 1 MB for bot-wall detection.
  - Per-request figures are in `benchmarks/2026-10-content-encoding-bombs.md`. See [Compressed responses](https://docs.squirrelscan.com/configuration/crawler#compressed-responses).
- A Quick audit no longer says your links are fine when it never checked them. Quick, `--offline` and `[external_links] enabled = false` do not request external links. Quick also does not follow internal links, unless the sitemaps give it nothing to crawl. Yet `links/broken-external-links` passed with "No external links found to check", and `links/broken-links` passed with "No broken internal links detected" when it had seen only the pages the crawl fetched.
  - `links/broken-external-links` now reports **Not checked** when external links were not checked. `links/broken-links` reports Not checked when the audit did not follow links and left internal link targets unfetched. Each comes with the reason and what to run instead.
  - The result appears in the console, text, Markdown and HTML reports, as `<not-checked>` in the LLM and XML reports, and as `notChecked` in the JSON report.
  - Not checked results are not scored. A broken target a Quick crawl does fetch, such as a 404 listed in the sitemap, is still reported. A Quick audit that fetched every internal link target and found none broken still passes `links/broken-links`.
  - See [Which audits can find a broken link](https://docs.squirrelscan.com/rules/links/broken-links#which-audits-can-find-a-broken-link).

## v0.0.109 (2026-10-12)

Published reports went on a diet. Whatever the size of the crawl, the report `squirrel` publishes is now a summary capped at 1 MiB: issues carry a sample of their pages and items plus the true counts, the score still comes from every check the audit ran, and the full detail stays on your machine. Heads up if a script or CI job runs it: `squirrel config validate` now checks `[rule_options]` and exits 1 on mistakes it used to wave through. Also in this release: `squirrel mcp` hands your agent the squirrelscan skills directly, Cloudflare pages with JavaScript Detections are no longer mistaken for bot challenges, gzip sitemaps get read, and a pile of rule fixes.

Thanks to @deniskern, whose reports are behind the gzip sitemap, `core/meta-title`, `core/charset`, `links/tel-mailto`, `a11y/aria-hidden-focus` and `a11y/button-name` fixes below.

### Added

- `squirrel mcp` serves the squirrelscan agent skills (`squirrelscan` 1.13 and `audit-website` 2.5) over MCP through the Skills extension (`io.modelcontextprotocol/skills`): `skills/list`, `skills/get` and every skill file through `resources/read`, each listed with its sha256 digest and size. A client that supports the extension gets the skills that match the server it connected to, with no separate install. See [Skills](https://docs.squirrelscan.com/cli/mcp#skills).

### Changed

- Behaviour change: `squirrel config validate` now checks `[rule_options]` and exits 1 when it finds a problem. It reports a table whose rule ID matches no rule, an option the rule does not declare, a value of the wrong type and an `enabled` that is not `true` or `false`, one `Invalid config:` line each, naming the table and the option. It used to print `Config valid` and exit 0 for all of these, so a `squirrel config validate && ...` step can now fail on a config that used to pass. `squirrel audit` runs the same check before it crawls: a wrong-typed option on a rule the audit runs stops it with `Error: [rule_options."core/meta-title"] min_length: ...` instead of failing after the crawl with a bare validation error, and the problems that change nothing are printed as warnings. The `config` subcommands now read and write the file `--config-file` names, the file an audit uses, where they always used the nearest `squirrel.toml`; `config set` still never creates a missing file. See [rule options](https://docs.squirrelscan.com/configuration/rule-options#what-happens-to-a-mistake).
- A published report is now a summary capped at 1 MiB, however many pages the audit crawled. Each issue lists a sample of its affected pages and items (usually 10 pages and 5 items) with the true counts, and the score still comes from every check the audit ran, not just the sampled ones. On the largest reports the samples shrink, and lower-priority issues can be cut down to their counts or left out. The report says it is a summary and where the full list is: the full per-page detail stays in the local project, and `squirrel report --format json` exports it. Large audits used to publish bodies of several MB. `squirrel audit` prints a warning when a report needs more than the usual sampling to fit, and a report that cannot fit at all is refused with `PAYLOAD_TOO_LARGE` before it is sent. `squirrel report --input <file> --publish` now refuses a file that has page checks but no crawled page list (the `--format json` export, or a published report) with `PUBLISH_PREPARE_FAILED`, where it used to publish a score built from its failures alone: publish the audit from its project with `squirrel report <audit-id> --publish`. See [What a published report holds](https://docs.squirrelscan.com/cli/report#what-a-published-report-holds).
- `squirrel channel` now runs on the same MCP SDK (v2) as `squirrel mcp`, and the CLI no longer ships the v1 SDK or the HTTP server packages it pulled in. The channel still connects with the 2025-era `initialize` handshake, which Claude Code needs to register it as a channel, and the docs now say so.
- `core/charset` reports a UTF-8 page whose charset meta is not first in `<head>` as placement advice at info status instead of the warning it shared with real encoding problems. Info checks do not count toward the score and are not listed in the report yet. On a page fetched without browser rendering, a charset `<meta>` that does not end within the first 1,024 bytes of the HTML is now a warning. The rule also warns when the `Content-Type` header and the page disagree about UTF-8, and reads a quoted header value such as `charset="utf-8"` without its quotes, but audits do not pass the header's charset to rules yet, so those two take effect once they do. See [core/charset](https://docs.squirrelscan.com/rules/core/charset).

### Fixed

- Gzip-compressed sitemap files, such as a `sitemap.xml.gz` child served as `application/gzip` without `Content-Encoding`, are now decompressed and parsed. `crawl/sitemap-valid` used to report each one as `Unknown sitemap format` and the crawl got none of its URLs. Sitemap requests now ask for gzip (`Accept-Encoding: gzip`, unless custom headers set another value) and squirrel decodes the response itself, because the runtime's own decoding inflated a whole response before it could be stopped: in our test, a 1 MB gzip bomb sent as `Content-Encoding: gzip` cost about 1.4 GB of memory. Reading and decompressing now stop at the sitemap protocol's 50 MB uncompressed limit, so a gzip bomb, or a response that keeps sending past 50 MB, is reported as `Sitemap exceeds the 50 MB uncompressed size limit`, and the same bomb now costs under 70 MB. The limit applies to every sitemap body, so an uncompressed sitemap over 50 MB, which search engines also reject, is now reported the same way instead of parsed. A body that does not decompress is reported as `Corrupt gzip body: <reason>` (`Corrupt br body` or `Corrupt deflate body` for those codings), and a coding squirrel does not decode as `Unsupported Content-Encoding: <coding>`.
- On a server that answers every path with a 200 page, the common sitemap locations squirrel guesses (`/sitemap.xml`, `/sitemap_index.xml` and six more) are no longer reported as eight invalid sitemaps. A guessed location that answers with an HTML page, or with a body that is not XML, now means no sitemap is there, so `crawl/sitemap-exists` reports `No XML sitemap found` where it used to pass on those pages. A sitemap that robots.txt or a sitemap index names and that answers with a page is still a `crawl/sitemap-valid` failure, now labelled `Not a sitemap: the URL returned an HTML page`.
- An ordinary page on a Cloudflare site with JavaScript Detections (which Bot Fight Mode turns on) is no longer classified as a bot-challenge page and set aside from scoring, and `ax/agent-blocking` no longer reports GPTBot and Claude-User as blocked on such a homepage. Cloudflare's JavaScript Detections script loads from `/cdn-cgi/challenge-platform/`, which was read as a challenge whenever it fell in the first 10 KB of the page, as it does on a small one. A challenge is now recognised by the challenge's own script (`/cdn-cgi/challenge-platform/h/…/orchestrate/`), `_cf_chl_opt` or `__cf_chl_`, and challenge wording such as "Just a moment" counts only on a `401`, `403`, `429` or `503`, or, for `ax/agent-blocking`, in the page `<title>`. A Cloudflare challenge page is still detected and named; a `200` page whose only sign is challenge wording is now scored as a page. Scores on affected sites change, because their pages are now scored.
- A page that mentions Imperva, or any other bot-protection provider, is no longer attributed to it. Body signatures are now the provider's own markup, script hosts and reference formats, not its name: Imperva's `Incapsula incident ID` line and `/_Incapsula_Resource`, DataDome's tag and captcha hosts, PerimeterX's `_pxAppId`, script host and captcha, Kasada's `window.KPSDK` and script path, Sucuri's block-page title and heading, Akamai's reference id and error host, and Cloudflare's ray id with its value. The `ips.js`, `cd.js` and `dd.js` attribution patterns, which matched any script whose name ends that way (`tips.js`, `abcd.js`, `add.js`), are gone or anchored to Kasada's own script path. A block page that carries one of these signatures, or the provider's headers, is still detected with its provider. One that carried only the provider's name no longer is, so a headerless `403` like that is reported as an ordinary refusal.
- A site behind Imperva that answers with `x-cdn: Imperva` is now recognised as Imperva bot protection, the same as `x-cdn: Incapsula`, so a blocked crawl names the right provider even when the response carries no `x-iinfo` header.
- `a11y/aria-hidden-focus` and `a11y/button-name` no longer report controls the markup shows are hidden. Both rules now share one check. It reads the `hidden` attribute, a closed `<dialog>` or unopened popover, and an inline `style` that plainly sets `display: none` or `visibility: hidden`. `a11y/button-name` also skips buttons under `aria-hidden="true"`. An inline style that sets `display` or `visibility` in a form the check cannot read exactly (a comment, `var()`, an unlisted keyword and the like) is reported as an unconfirmed warning (`aria-hidden-focus-unconfirmed`, `button-name-unconfirmed`), not a failure. `<style>` blocks and stylesheets are not read, so a control hidden only by a class or selector rule is still reported. Off-screen and transparent controls are still checked.
- `core/meta-title` measures the title as a browser shows it: runs of spaces, tabs and line breaks count as one space and the ends are trimmed. Themes that indent `<title>` across several lines (Shopware, Shopify) were reported `Title too long` because of their indentation. The finding's value and item now show the collapsed title, and a title holding only whitespace is reported missing, like an empty one.
- `links/tel-mailto` no longer reports a mismatch for a link such as `<a href="tel:+4960616309800">+49 (0)6061 630 980 0</a>`. The `(0)` is the optional trunk prefix, which is dropped after the country code, so the link dials the number shown. That display form is now formatting advice in a new `tel-trunk-prefix` check at info status, which does not count toward the score and is not listed in the report yet. The reading applies only to the link text and only to calling codes whose trunk prefix is 0 (+31, +32, +33, +41, +43, +44, +49, +61, +64 and +353); a display number that really differs from the href goes through the mismatch check as before. See [links/tel-mailto](https://docs.squirrelscan.com/rules/links/tel-mailto).
- `perf/total-byte-weight` no longer counts a page's inline CSS and JavaScript twice. The HTML size already includes them, and the rule added them again, so a page with a 1.8 MB inline stylesheet read as about 3,600 KB. The breakdown's HTML total holds the inline code, and its CSS and JavaScript totals now hold external files only. See [perf/total-byte-weight](https://docs.squirrelscan.com/rules/perf/total-byte-weight).
- `content/hidden-text` reads `<style>` sheets and inline styles the way a browser tokenizes them. A `{`, `}` or `;` inside an unquoted `url(...)`, inside a `(` or `[` block, or after a backslash no longer ends a rule or a declaration, so a sheet such as `.a{background:url(}.b{display:none}.c{)}`, which a browser reads as one rule, is no longer reported as hiding `.b`. See [content/hidden-text](https://docs.squirrelscan.com/rules/content/hidden-text).
- Template fan-out no longer shares a verdict between pages that differ in the `<html>` language or aria-hidden, the `<body>` aria-hidden, or a favicon link. Those are inputs three template rules read.
- `squirrel audit` no longer seems to hang after printing the report url on a machine with many local projects. Marking the report as published opened every project database under `~/.squirrel/projects` until it found the audit (5.5 s for 2,000 projects, and far longer on a large store); it now opens only the audited project's database. `squirrel report --publish` marks the database the report was loaded from.
- A release download that stalls no longer hangs `squirrel self update` or the background updater. The download used to be bounded only until the server sent its headers, so a body that stopped arriving left the detached updater waiting forever, holding the update lock until the lock went stale after 30 minutes. A download now fails when no data arrives for 60 seconds or it has not finished after 20 minutes, the lock is released, and a later run tries again. The new bounds apply to updates made from this version on: the update to this version still runs on the previous release's downloader.
- Docs: custom request headers are on every plan, Free included, where several pages said Pro only, and the pages that still called local audits free in general now say a local audit costs nothing only when it runs signed out or with `--offline`. The [firewall page](https://docs.squirrelscan.com/cloud/firewall) now covers letting an audit through Cloudflare Access, Vercel deployment protection and HTTP basic auth, the [failed audits guide](https://docs.squirrelscan.com/guides/failed-audits) walks through each failure cause, and the hosted MCP page lists every tool, `get_website_settings` and `update_website_settings` included. The docs, README and npm package now give one rule count: 300+.

## v0.0.108 (2026-10-10)

Audits now come in three sizes, called levels: quick, surface and full. A level is one name for a whole set of settings (pages, crawl strategy, cloud checks, rendering, external link checks and probing), defined once and shared by the CLI, the local MCP server and the dashboard, so a surface audit means the same thing wherever you start it. A signed-in cloud audit costs credits at every level, quick included: 50 for the audit plus 2 per audited page. Signed out or with `--offline`, the audit runs on your machine and costs nothing. The [Audit levels](https://docs.squirrelscan.com/guides/audit-levels) guide has what each level reads, checks and costs. Also in this release: the local MCP `audit_website` tool now bills a signed-in audit the way `squirrel audit` does, a dev server on `localhost` stops getting marked down for having no HTTPS, `squirrel self uninstall` is safe for package managers to call, and a pile of rule fixes.

### Added

- Audit levels: `--level quick|surface|full`. A level is a named set of audit settings (pages, crawl strategy, cloud checks, rendering, external link checks and probing), defined once and read by `squirrel audit`, `squirrel crawl`, the local MCP tools, the config and the shell completions. Quick reads up to 25 pages from the URL and its sitemaps (it follows links only when the sitemaps give it nothing to crawl), surface up to 100 pages with one page per URL pattern first, and full every page it can reach, up to 500. Without `--level` or `[crawler] coverage`, `squirrel audit` runs surface when you are signed in and quick when you are signed out or your session has expired, and `squirrel crawl` runs quick. `--coverage`/`-C` and `[crawler] coverage` keep working as the older names and `fast` still means quick. An unknown level, a repeated `--level` or `-C`, or two flags naming different levels stop with an error before the crawl starts. Picking a level fills in every setting; the flags and config values you already use (`--max-pages`, `--render-mode`, `--http`, `--probe`, `[external_links] enabled = false` and the rest) change single settings, and an audit whose settings differ from its level becomes custom. The run banner says which: `Level     surface · max 100 pages`, or `Level     custom (surface + max_pages 200)`. See [Audit levels](https://docs.squirrelscan.com/guides/audit-levels).
- Reports say which level they ran at. The JSON report has `meta.auditLevel` (`level`, `basedOn`, `changes`, `settings`), the LLM report an `<audit-level>` element, and the text, Markdown and HTML reports an `Audit level:` line. A JSON report loaded back with `squirrel report` keeps it. No existing field changes.
- The local MCP `audit_website` tool takes `level` (`coverage` still works) and defaults to surface. It applies the project config's page limit, rendering, external link and probing settings the way `squirrel audit` does, including `[crawler] max_pages`.
- After the crawl, the audit lists the pages whose response could not be decoded, with each URL and its declared content-encoding: the first five, then a count of the rest.

### Changed

- The local MCP `audit_website` tool bills a signed-in audit the way `squirrel audit` does, at every level: it registers the run (50 credits) and settles it on its audited pages (2 each), renders pages in the cloud browser as the level says (quick only the pages that need JavaScript, surface and full every page), and runs the cloud checks at surface and full. Before, it could run the cloud checks without registering an audit. A tool call cannot prompt, so when the estimate is above `[cloud] confirm_threshold` (50 by default, as in the CLI) the call returns it as `confirmation_required`, and the agent calls again with `confirm: true`. The page budget is fitted to the balance and to `[cloud] max_credits_per_audit`; an audit that cannot pay for even one page is refused with the cost and the balance, and so is one the server will not register. An audit that errors asks the server to mark its run failed, and stopping the server with Ctrl-C or a termination signal asks it to mark the run cancelled, so both settle like a failed or cancelled `squirrel audit`. Signed out, with `offline: true`, against a local or private host, and in `quick_check`, the tools still run on your machine with no cloud call.
- A level's settings are now the defaults. Quick no longer checks external links and probes passively, while surface and full check external links and probe actively, signed in or not. Before, external links were checked at every level and probing followed sign-in instead of the level. A signed-out audit with no flags runs quick, so it now skips external link checks. Explicit flags and config values win as before. `max_pages = 100`, which `squirrel init` writes into every config, still reads as unset, and so does `[external_links] enabled = true`, which it also writes, so a generated config no longer turns external link checks on at quick. Set `--level surface` or `full` to get them back.
- Hints and locked-check messages point at `--level` instead of `-C`, and the quick-level message no longer says "coverage".
- `security/leaked-secrets` reports a server-only secret found in a browser-served script (database connection strings, service-role and `sk_live_` keys, AWS secret keys and similar) in a new `leaked-secrets-critical` check, "shipped to every visitor". Publishable keys, DigitalOcean Spaces key ids, tutorial values (AWS's documented example keys, placeholder or `localhost` database URLs) and hits only in page HTML are unchanged.
- `perf/bad-caching` explains a missing ETag behind Cloudflare. Cloudflare drops the `ETag` from HTML it rewrites (Email Address Obfuscation, Automatic HTTPS Rewrites, Replace insecure JavaScript libraries, and JavaScript Detections, which Bot Fight Mode turns on), sometimes only for requests that ask for a page, so a plain `curl -I` can show a header browsers never get. When the validators check warns and at least half of the pages missing a validator came through Cloudflare, the finding now says the CDN may be the cause and lists the fixes: `no-transform` in the HTML `Cache-Control`, turning those features off, or also sending `Last-Modified`. The validators check now warns instead of failing, because a page with no lifetime and no validator already counts against the freshness check. A weak `ETag` (`W/"..."`) still counts as a validator for every content encoding. The [rule page](https://docs.squirrelscan.com/rules/perf/bad-caching) shows how to check which side removes it.
- `crawl/pdf-size` describes its 60MB failure threshold as squirrel's default, not as Google's limit. Google documents 64MB for PDFs; the rule's messages, description and option text now say so.
- `security/sri`, `content/meta-in-body` and `schema/rating-scope` use one message wording whatever the count, and `schema/rating-scope` no longer puts the rated entity's name in its check message, so one defect keeps one finding identity across pages.
- `squirrel self uninstall` only deletes what a squirrelscan install created, and is ready for package managers to call. It removes the `squirrel` link (in the default bin directory and the one recorded by `self install --bin-dir`) and `~/.squirrel/releases`, and keeps settings, credentials and audit data unless you pass `--purge`, which now also removes the cache directory. Each link is checked against the managed install before anything is removed: a link pointing anywhere else, an unrelated file at the link path, or a symlinked `~/.squirrel` is reported and left alone, and a symlink inside the releases is never followed. It will not delete a managed install when run from some other `squirrel` binary. It asks before deleting, and without a terminal it refuses unless you pass `--yes` (the new name for `--force`, which still works). With nothing left to remove, it exits 0. See [self uninstall](https://docs.squirrelscan.com/cli/self#uninstall).
- The install docs cover Homebrew: `brew install --cask squirrelscan/tap/squirrel` installs a launcher that runs the regular installer on first use, after which `squirrel self update` owns updates. `brew uninstall --cask squirrel` runs `squirrel self uninstall --yes`, and `--zap` also removes `~/.squirrel`. See the [quickstart](https://docs.squirrelscan.com/quickstart#homebrew).

### Fixed

- A clean site audited on `localhost` or a private-network host no longer scores a C or D for being a dev server. The transport and delivery rules (`security/https`, `security/hsts`, `security/http-to-https`, `perf/http2`, `perf/compression`, `perf/asset-compression`, `perf/cache-headers`, `perf/bad-caching`) are skipped there and left out of the score, so the same cause (no HTTPS, no compression, no caching policy) is no longer charged by several rules at once. The report says so in one line under the score, and the JSON report as `notApplicable`. The host is classified from the audit URL by the same check the cloud handoff already used, now shared in `@squirrelscan/utils`; public hosts score exactly as before. See [Transport and delivery rules do not apply](https://docs.squirrelscan.com/guides/local-audits-cli#transport-and-delivery-rules-do-not-apply).
- The docs said local audits were free. The agent setup pages, the cloud overview, the setup guides and every rule page now say it plainly: signed-out local audits need no account and cost nothing, and signed-in audits spend credits.
- `squirrel crawl -C fast` crawled with no page limit at all: the crawl cast the flag to a level without checking it, the page lookup for `fast` came back empty and the cap became `NaN`. The crawl now reads its level through the same parser as `audit`, so `fast` is quick (25 pages) and an unknown level stops before the crawl starts. A non-numeric `--max-pages` is refused too, instead of the same unbounded crawl.
- The local MCP `quick_check` tool described itself as a single-page check. It reads the URL and its sitemaps, 25 pages by default, and now says so. It also follows the project's `[crawler] max_pages` and `[security] probe` settings.
- The console report footer counts warnings the same way as its "Total:" line. Before, the footer counted advisory warnings from severity-"info" rules and the score line did not, so one report could show two warning totals.
- `squirrel audit -f json -o <file>` prints the "JSON report saved to" line on stderr instead of stdout.
- A malformed `squirrel.toml` prints the "TOML syntax error:" line with the parser detail again. The check compared the error name, which the parser never sets, so the labelled message never showed.
- `content/heading-hierarchy` does not count an empty heading the markup hides (`hidden`, inline `display:none` or `visibility:hidden`, or a hidden or `aria-hidden` ancestor). The parser marks those headings, so a cached parse counts the same as a fresh one.
- A signed-in audit of a localhost, private-network or other non-public host no longer sends the archive-indexing lookup to the cloud, where it could only come back empty.
- Template fan-out, which lets the pages of one template share a rule's verdict, now groups pages only when the markup those rules read matches too: the same scripts and stylesheets (and whether each carries `integrity`), the same `<meta>` tags with the same viewport, geo and refresh values, and the same number of `<main>` landmarks. Before, a page missing its viewport meta, carrying a second `<main>` or loading a different per-route bundle could inherit a sibling's result. Fan-out runs when the rule cache is off: in cloud audits, and in CLI audits with `SQUIRREL_RULE_CACHE=0`. On a recorded 4000-page gymshark.com crawl, 3931 of 3983 pages still group with their template (3946 before).
- Results replayed from an earlier run ignore an `items` field that is not a list, so a damaged stored row can no longer crash a smart audit or a publish while it merges results.
- `crawl/all-noindex-pages` validates its `warnOnPatterns` and `errorOnPatterns` options. A value that is not a list of strings now fails option validation, instead of reaching the matcher and breaking the rule.
- `perf/source-maps` ignores `<script>` and `<style>` inside `<noscript>`. A browser with scripting enabled never runs that markup, so a source map referenced there is no longer reported.
- `content/article-toc` finds a table of contents ItemList nested in a JSON-LD `@graph` wrapper, as Yoast, Rank Math and Slim SEO emit. Before, the rule reported a missing TOC schema on those sites.

## v0.0.107 (2026-10-09)

squirrelscan can now probe, politely: a new probing intensity setting decides how much an audit may send, and the first two probing rules (GraphQL introspection and GraphQL mutations over GET) use it. There is also a rule for auth tokens kept in web storage, a rule for a CSP that blocks the page's own resources, quieter secret scanning, and the entity page filter now behaves the same in the CLI, the MCP tools and the hosted API.

### Added

- `security/token-storage` flags JWTs and session or access tokens written to `localStorage` or `sessionStorage`. Anything in web storage can be read by any script on the page, so one XSS bug turns a stored token into an account takeover, where an `httpOnly` cookie would not. It is passive: it reads the inline scripts and the external scripts the crawl already fetched and sends no extra request. A key is split into words, and whole words decide, so `access_token`, `jwt` and `idToken` flag while `theme`, `dismissed` and `csrf` do not; a value shaped like a JWT flags under any key. The report names the script and the key and never prints the value.
- Two GraphQL probing rules, the first rules that use probing intensity. They run only when probing is `active` or `aggressive`, probe only the audited origin, and on a `passive` run send nothing. Both probe the GraphQL endpoints the audit found in your pages and scripts, plus `/graphql` and `/api/graphql`, at most five per rule, and never a path that names a state-changing action such as `logout` or `delete`. Below `aggressive` they skip paths `robots.txt` disallows. `security/graphql-introspection` sends one `GET` with the read-only query `{__schema{types{name}}}` and warns when an endpoint returns its schema, naming the endpoint and the type count; on an `aggressive` run it may follow up with one `POST` of the same query when the `GET` answer is GraphQL without a schema. `security/graphql-get-mutations` sends one `GET` with the no-op mutation `mutation{__typename}`, which cannot write, and fails when the server executes it, because a mutation reachable by `GET` can be fired cross-site with your visitors' cookies (CSRF). Disabled introspection, errors, a `405` and HTML or catch-all answers are not flagged. See [Security configuration](https://docs.squirrelscan.com/configuration/security#rules-that-probe). That makes 301 rules, 20 of them in Security.
- `security/csp-blocks-own-resources` flags a Content-Security-Policy that blocks what the page itself loads. It matches each page's own policy (the header and any `<meta http-equiv>` policy) against the page's scripts, preloaded modules, stylesheets, frames and images using real source matching, so `*.example.com` allows `cdn.example.com` but not `example.com`. It also looks inside the same-site chunks a page loads for third-party script URLs, and checks the hosts a detected vendor needs at runtime (Google Analytics 4 and Google Ads endpoints, Google Tag Manager, PostHog, Stripe, Cloudflare Turnstile, reCAPTCHA), which the HTML never names. A blocked analytics, ads, payments, captcha, form or booking host fails and any other host warns, naming the directive and the host to add. A page with no enforced policy passes, because a missing CSP stays with `security/csp`. See the [rule page](https://docs.squirrelscan.com/rules/security/csp-blocks-own-resources). That makes 298 rules, 17 of them in Security.
- Probing intensity, a third audit setting next to coverage and render mode. `--probe` (`-P`) takes `passive`, `active` or `aggressive`, with `--passive` and `--aggressive` as shortcuts and `--pentest` for `--coverage full --probe aggressive`. `--probe-budget` caps the wall-clock time of all probing together (default `30s` active, `2m` aggressive). `[security] probe` and `budget` set both in config. A logged-in audit defaults to `active` and a logged-out one to `passive`; `aggressive` is never a default. `--disable-discovery-probes` keeps probing passive. No probing rules ship yet, so no audit sends anything new: this adds the setting and the shared budget future rules will use. See [Security configuration](https://docs.squirrelscan.com/configuration/security).

### Changed

- Publishing from a large cloud audit no longer slows down as a site's page history grows. The merge indexes the prior pages once instead of copying them several times, builds the full page list only when something reads it, and writes back only the pages the run changed. At 25,000 pages this removes tens of milliseconds of cold-start work per publish.
- The `send_feedback` tool description in the local MCP server is neutral about when to use it, and a test now fails when the MCP docs drift from the tools the server lists.
- `squirrel entities` and the MCP `list_entities` tool now apply the same page filter rule as the hosted API, and a filtered result keeps `summary` site-wide. `--page` with an absolute `http(s)` URL is a prefix of the page URL, a value starting with `/` is a prefix of the path and query (so `--page /blog` no longer matches `https://example.com/tag/blog`), and anything else is a substring. Use `--page blog` for the old substring behavior. A filtered `squirrel entities -f json` and `list_entities` used to return a `summary` recomputed over the matching entities. They now return the site-wide `summary` and a new `filtered: { nodes, edges }` block with what the filters kept, so scripts that read `summary.nodeCount` after a filter should read `filtered.nodes` instead. `--diff` still compares recomputed summaries.
- The audit also fetches the same-site script chunks a page preloads with `<link rel="modulepreload">` or `<link rel="preload" as="script">`, so `security/csp-blocks-own-resources` can read the third-party script URLs inside them. They are kept apart from the scripts every other rule reads, so no other rule's result changes, and they are fetched only when a crawled page enforces a CSP, capped at 20 extra fetches per audit. The rule cache format changed, so the first audit of each site after the upgrade runs every rule fresh, once.

### Fixed

- `security/leaked-secrets` raises fewer false alarms. A label that ends in a credential word, such as a translated `Password:` heading in compiled JSX, is no longer read as a key whose value is the markup after it, template expressions and placeholder connection strings are not credentials, and a key that runs past a provider's format is reported as a secret of unknown provider instead of being named as that provider's. Public vendor identifiers in a script's query string (Mida, Klaviyo and reCAPTCHA site keys) are skipped. A Statsig `secret-` key is reported as a server secret and a `client-` key as the public SDK key it is.
- A site that sends response headers and then stalls its body can no longer hang the CLI. The shared request helper used by the reachability check, the robots.txt fetch and the update check disarmed its timeout as soon as the headers arrived, so the body read had no time limit. The timeout now covers the body too, and a stalled body fails like any other timeout.
- The audit engine can keep the cloud results it has already paid for when its caller stops the cloud analysis step at a deadline, instead of discarding all of them. A caller turns this on with the new `deadlineMs` option on the container prefetch (or by passing its own accumulator and calling `abandon()`). Results that came back are used by the rules, rules still waiting report `skipped` with reason `service-unavailable`, and no new cloud call starts after the deadline. The spend lists each call known to be charged, once: every call that came back, plus a render batch the cloud accepted but had not finished. A call still running at the deadline is not listed and may yet be charged, so the estimated balance after the run is marked approximate (`balanceAfterApproximate`). Nothing in the CLI sets a deadline, so CLI audits are unchanged, and a prefetch that finishes in time returns exactly what it did before. See [credits](https://docs.squirrelscan.com/cloud/credits#when-credits-run-out).

## v0.0.106 (2026-10-08)

`squirrel mcp` speaks the new MCP 2026-07-28 protocol, `squirrel channel` gives your Claude Code session a heads-up the moment a cloud audit lands, every rule now runs against the clock to keep booby-trapped pages from stalling an audit, and two new content rules catch the `info@example.com` and `placehold.co` your theme shipped with. Plus a big pile of false positives, swept out of the nest.

### Added

- `squirrel mcp` supports MCP protocol revision 2026-07-28 and the 2025-era protocol from one process. It moved to version 2 of the MCP SDK and picks the protocol from the client's first message: a 2026-07-28 client connects with no `initialize` handshake and reads the server's capabilities from `server/discover`, and an older client keeps the `initialize` handshake. There is nothing to configure. Tool names, descriptions and input schemas are the same in both, and the schemas are now published as JSON Schema 2020-12 rather than draft-07. The [MCP docs](https://docs.squirrelscan.com/cli/mcp#supported-protocol-versions) have the details.
- `squirrel channel` pushes cloud audit events into a running Claude Code session. Add it to your MCP config as `squirrel channel`, and when a cloud audit finishes, fails or finds new issues (`audit_complete`, `audit_failed`, `issues_detected`), your agent gets a one-line event with the ids it needs to pull the report and start on the fixes, without being asked. It polls your organization's notification feed every 30 seconds (`--interval`, from 5 to 86400), `--categories` picks the events, and it backs off on 429 and 5xx responses. Event text is built from validated ids, hostnames, counts and fixed strings, never from notification titles or text on your site, so a crawled page can't talk to your agent through it. It needs a login session (`squirrel auth login`), because API keys can't read the feed; without one it sends a single `login_required` event and keeps running. It remembers where it stopped, per organization, and catches up once on the next start (until the cloud feed supports cursors, that catch-up reads back only the latest 50 notifications). Channels are a research preview in Claude Code, so for now you start Claude Code with the development flag. The [channel guide](https://docs.squirrelscan.com/developers/channel) has the setup.
- Every rule's synchronous work runs under a time budget: one second per page for a page rule, and one second per page of the site for a site rule, capped at 60 seconds. A rule that waits on the network is timed up to its first wait, and its requests keep their own timeouts. A rule that runs past its budget is stopped and the audit carries on with the next rule. The report records it once per audit, as a failed `<rule>-error` check (`Rule error: exceeded its 1000 ms time budget and was abandoned`, naming the larger budget for a site rule) against the first page it happened on (or the whole site, for a site rule), and a page rule also gets an info `<rule>-timeouts` check with the number of pages it did not check. Ordinary pages come nowhere near it: measured over 500 pages, the slowest page rule's 99th percentile was about 6 ms. A page where a rule timed out is never stored in the rule cache, so the next audit runs it again. The [rules reference](https://docs.squirrelscan.com/rules#rule-time-budget) has the details.
- `content/placeholder-contact` flags contact details a template shipped with and nobody replaced: email addresses at `example.com`, `test.com` or `yourdomain.com`, the fictional `555-01xx` and UK `07700 900xxx` phone ranges, `123 Main St`, and handles such as `@yourhandle`. It reads the visible text and every link's `href`, so a `mailto:info@example.com` behind an "Email us" link counts. It fails on a contact or checkout page, skips other pages under documentation paths such as `/docs` and `/api`, warns everywhere else, and never judges a code sample. See the [rule page](https://docs.squirrelscan.com/rules/content/placeholder-contact).
- `content/placeholder-media` flags images that were never finished: a placeholder service source (`via.placeholder.com`, `placehold.co`, `dummyimage.com` and friends, or `placeholder` as a word in the image's filename), a blank 1x1 inline image used as content, and camera-default alt text such as `DSC_0001` or `IMG_1234`. A placeholder source or a blank stand-in fails and a camera-default alt warns. A lazy-loaded image is judged on its real `data-src`, not its stub. See the [rule page](https://docs.squirrelscan.com/rules/content/placeholder-media). That makes 297 rules, 23 of them in Content.
- The JSON report lists checks a rule skipped because it hit its scan limit, in a new top-level `skippedChecks` list with the rule, the check, the reason and the pages (with the full count when a long list is clipped), and `summary.skipped` adds up those skipped page checks. Before, the JSON dropped them, so a page that `content/hidden-text` or `content/dev-leakage` could not finish scanning read as clean. A report with no such skips has the same keys as before. The [output docs](https://docs.squirrelscan.com/configuration/output) now describe the JSON shape the CLI really writes.

### Changed

- `perf/total-byte-weight` scores each page on its own weight, as its 1600 KB and 5000 KB thresholds intend, instead of adding up the whole crawl. A page's weight is its HTML, its inline CSS and JS, and the stylesheets, scripts, images and fonts it loads, and a file several pages share counts toward each of them. The HTML and fonts (from a preload link or an inline `@font-face`) are counted for the first time. The message names the heaviest page and how many pages are over each threshold, and it says how many resources it could not size instead of quietly counting them as zero bytes. A site with one heavy page can now warn or fail where it didn't, and a large site of light pages no longer does. Same-site fonts are sized like images, normally with one `HEAD` request per distinct font, inside the existing resource check limit. See the [rule page](https://docs.squirrelscan.com/rules/perf/total-byte-weight).
- The rule cache is keyed on the rule code as well as the CLI version, so running from a source checkout no longer replays findings from before a rule change. The cache format changed, so the first audit of each site after the upgrade runs every rule fresh, once.
- `crawler.include` patterns narrow the crawl within its scope instead of replacing it. A path-only pattern such as `/blog/*` no longer admits `/blog/` URLs on other hosts (they could arrive through a sitemap), while an absolute-URL pattern still reaches the host it names. An explicit `[project] domains` list is a hard allowlist: an absolute include for a host it does not list is refused, with one warning naming both. A config that relied on a path-only include to reach another host needs an absolute pattern, or that host in `[project] domains`. The [crawler docs](https://docs.squirrelscan.com/configuration/crawler) have the details.
- Published reports from a large audit count every page the crawl fetched as audited. Before, a page left out of the published sample, or one no page check looked at, was missing from the audited count and from the page charge. On the next publish of such an audit, pages that were left out of the sample and passed every check count toward the score, so its score can rise once, toward what a complete cloud audit gives it.
- A rate-limited crawl says how much it never reached. The partial status reads like `437 pages rate limited by host; 1355 more discovered but not fetched`, and the text, markdown, llm and JSON reports carry the count of URLs it found but never fetched.
- Reports can say a cloud crawl stopped because it ran out of time rather than at its page limit: the scan scope line adds `stopped early on time`, the partial-scan note says the site may have more pages than the score covers (without suggesting a higher page limit, which wouldn't help), and the JSON report carries `stopReason: "time"` next to `maxPages`, the llm output `stop-reason="time"`.
- The render limit warning says how many pages your plan renders at once, per audit: 1 on Free, 5 on Pro and 10 on Team.
- The credit wall links to the plan comparison on the pricing page next to the upgrade link, and an account already on a paid plan is pointed at a top-up instead of being pitched the plan it already pays for.
- Installer error reports include the version being installed and, on Linux, whether the system uses glibc or musl, so a failed install can be matched to its release.
- The local project store (`~/.squirrel/projects/<domain>/project.db`) upgrades itself to schema version 33 the first time this version opens it, to store each page's `hreflang` alternates. It only adds a column, so v0.0.105 can still open the upgraded store.

### Fixed

Thanks to @deniskern, whose reports are behind the `hreflang`, noindex, `dom-size`, autocomplete, empty heading, `meta-in-body`, video caption and LCP fixes below, and the new `skippedChecks` list.

- `core/title-unique`, `content/duplicate-title` and `content/duplicate-description` no longer report region variants of one page, such as `/en-gb/shirt` and `/en-us/shirt`, as duplicates when each lists the other as an `hreflang` alternate in the same language and neither canonicalises elsewhere. A `de` and `en` pair with one title is still reported. A page reused from the crawl cache picks this up once it is fetched again, or with `--refresh`.
- `crawl/indexability-conflicts` no longer reports robots.txt `Allow` plus `noindex` as a conflict, since that is the supported way to deindex a page. Its remaining info check, a page robots.txt blocks without a `noindex`, now lists the pages.
- `crawl/sitemap-coverage` no longer lists a noindex page as missing from the sitemap, and `content/title-pattern-outlier` leaves noindex pages out of its template vote, when the site itself is indexable.
- The `dom-max-children` check of `perf/dom-size` counts `<body>` only, so a `<head>` full of `hreflang` alternates or preload hints no longer trips its 60-children limit.
- `a11y/autocomplete-tokens` no longer asks for an `autocomplete` token on a country select that is the only personal-data field in its form, such as a locale or market switcher. An explicit token is still checked.
- `a11y/empty-heading` skips headings hidden in the markup (`hidden`, inline `display:none` or `visibility:hidden`, or an `aria-hidden` or hidden ancestor), and each item shows the heading's tag and its position on the page, so two empty `<h2>`s can be told apart.
- `content/meta-in-body` skips schema.org microdata `<meta itemprop>` tags, which HTML allows in `<body>`.
- `a11y/video-captions` and `video/video-accessible` skip decorative video, one that is `aria-hidden` or muted with no controls and autoplays or loops, and both rules now agree on what counts as decorative.
- `perf/lcp-hints` uses the same LCP candidate finder as `perf/lcp-fetchpriority`, so header and nav images, small logos, icons and tracking pixels no longer count as likely LCP images, and a preload matches its image across relative and absolute URLs, query strings and `srcset`.
- `content/date-agreement` reads dates in French, German, Spanish, Italian, Portuguese and Dutch, year-month-day dates with Japanese, Chinese and Korean markers, and numeric dates, reading an ambiguous `08/01/2026` both ways. It stays quiet about a date it can't read instead of warning that the page shows none, and a year in a slug like `/reviews/2024-honda-civic-review` no longer counts as a publication date.
- `security/new-tab` no longer warns on `target="_blank"` without `noopener`, because browsers imply it, and `noreferrer` implies it too. It warns only on an explicit `rel="opener"`, reads `rel` as a list of tokens rather than a substring, and a missing `noreferrer` is an info-level privacy note.
- `security/mixed-content` reports only `http://` URLs in markup that loads a resource, so canonical and alternate `<link>`s, which are never fetched, no longer count. Loopback URLs such as `localhost` and `127.0.0.1` are not mixed content and get their own `local-development-url` warning, and each finding names its tag and whether a browser would likely block it or upgrade it, and says it comes from the markup rather than an observed load.
- `links/no-contextual-inbound` skips when the crawl stopped at its page limit, because a page it never reached could hold the link. `legal/subprocessor-disclosure` warns only when the crawl shows a commercial offer (a pricing, plans, enterprise or trust page, or a sales or demo link), so a pre-launch waitlist page is skipped. `content/keyword-stuffing` no longer counts the site's own brand name, taken from its domain.
- An audit of a site that refuses the crawler (401, 403, 429 or a bot challenge) no longer reports its robots.txt, sitemap, `llms.txt` or Markdown response as missing. `crawl/robots-txt`, `crawl/sitemap-exists`, `ax/llms-txt` and `ax/markdown-response` say "not checked" and name who refused, a failed or blocked audit scores no categories, and the text, markdown, llm and JSON reports list the refused requests and, when the response names it, the bot protection behind them.
- A response whose body doesn't match its declared `content-encoding` is recorded as a failed page, with an error naming the URL and the encoding, and the audit is marked partial with a count such as `2 pages could not be decoded (bad content-encoding)`. Before, the page vanished and the audit claimed to be complete.
- A meta refresh inside `<noscript>` no longer moves the audit to the no-JavaScript page. A browser with scripting on never follows it.
- A cached page reused by an incremental crawl follows the same link discovery settings as a freshly fetched one. With link discovery turned off, one reused homepage used to put the whole site back in the queue.
- A JSON-LD node with its own `@type` and a `@graph` keeps its own type, so a `WebPage` wrapping an `Organization` is checked as both. A page reused from the crawl cache picks this up once it is fetched again, or with `--refresh`.
- Soft-404 detection picks up framework error pages served with a 200, such as a Next.js `__next_error__` shell, as candidates in every audit. The engine the CLI uses read that marker from the page's DOM after it had already released it, so it missed them.
- The entity map published with a report sets aside about a fifth of its node budget (more on a small map, so each kind of problem still gets one) for nodes that show the entity problems the rules report (conflicting properties, dangling references, a missing or malformed `@id`, a split identity and the rest), taking turns so no one kind crowds out the rest. A finding's evidence is no longer sampled out of the map just because the entity is rarely linked. The map in the HTML report is chosen the same way.
- Merged report messages no longer turn HTTP statuses into ranges: redirect chains ending in a 404 and a 500 stay separate rows instead of merging into a `(404 to 500)` status that doesn't exist. Redirect messages now write the status as `(HTTP 404)`.
- A signed-in audit whose publish gets a 5xx after the report was already saved now returns the report URL instead of failing. The CLI checks whether the run gained a newly linked report, and does not post the report again after a 5xx.

### Security

- Six regular expression scans that a crafted page could make backtrack for seconds now run in linear time and match exactly what they matched before: four in `security/leaked-secrets` (JSON Web Tokens, Google OAuth client ids, the `<script>` tag scan and the key-name look-back), the CSS custom property scan behind the template fingerprint, and the title separator in `content/title-pattern-outlier`. The time budget above is the backstop for anything we haven't found yet.

## v0.0.105 — 2026-10-07

`images/responsive-size` measures thumbnails in pixels, `schema/json-ld-valid` follows schema.org and Google more closely and now checks the fields of each breadcrumb and FAQ question, and `squirrel entities` shows the page each dangling reference comes from.

### Changed

- `images/responsive-size` compares a thumbnail's real pixel size with the size its `width` and `height` attributes give it, allowing for 2x screens, the way Lighthouse's responsive images audit does. It still looks only at images 100x100 or smaller by those attributes (the default `max_thumbnail_dimension`), with no `srcset` and outside `<picture>`. A large image shown small is now reported even when its file is light, such as a 1200x1200 JPEG of 20 KB shown at 64x64, once the pixels a 2x screen never draws come to 4 KiB or more of the file, so this rule can report more than before. With the pixel size known, an image no more than twice the size it is shown at is not reported, animated or not, so an animated WebP shown at its own size no longer is. When the pixel size can't be read, such as a JPEG whose dimensions sit past the bytes read, the rule falls back to the file size check from v0.0.104, which still skips SVG, ICO, GIF and animated images. The [rule page](https://docs.squirrelscan.com/rules/images/responsive-size) has the details.
- To read that pixel size, the image check now requests the first 32 KiB of each image on the host you audit and its subdomains, normally with one ranged `GET` in place of the `HEAD` it sent before. At the default 500-image limit that is about 16 MB of image data, less when files are small or reused from the cache. A server that rejects the range, or answers without a length, can cost extra requests. Raster images an earlier version measured are requested again on the next audit so their size can be read, even when their cache headers would have let the audit reuse them.
- `schema/json-ld-valid` now checks the fields of each entry in a `BreadcrumbList` and a `FAQPage`. Those per-entry checks never ran before, so the rule can report findings it did not: a crumb with no `position`, no `item` (the last crumb may leave it out, as Google allows) or no `name` on the crumb or its `item`, and a question with no `name` or `acceptedAnswer`.
- `a11y/label-content-name-mismatch` and the `tabindex-very-high` check of `a11y/tabindex` list up to ten elements, and now count the elements past those ten toward the score as well, up to 20 per check and page, the same cap every failing check has. A page with more than ten of them can score lower. Warning checks that cut their item lists short now also record how many items they left out, as `details.additional` in the JSON report: `tabindex-positive`, and checks in `a11y/identical-links-same-purpose`, `a11y/link-in-text-block`, `perf/animated-content`, `perf/source-maps` and `schema/rating-scope`. Warnings count once per check and page, so their scores don't change.
- The local project store (`~/.squirrel/projects/<domain>/project.db`) upgrades itself to schema version 32 the first time this version opens it. Version 31 stores the pages behind each entity map reference and version 32 stores each image's pixel size and whether it is animated. Both only add columns, so v0.0.104 can still open the upgraded store.

### Fixed

- `schema/json-ld-valid` no longer flags valid markup: a single recipe ingredient, recipe instructions given as text or as a single step, a single FAQ question or breadcrumb not wrapped in a list, a breadcrumb named on its `item` node, a Product offer that is an `AggregateOffer` (it needs `lowPrice` and `priceCurrency`, not `price` and `availability`), an Article with no publisher or a publisher with no logo, and fields given on a top-level node that has an `@id` but no `@type`, which a reference to that `@id` now finds. A page reused from the crawl cache picks up that last fix once it is fetched again, or with `--refresh`.
- `squirrel entities` and the entity tools in `squirrel mcp` show the page each dangling reference comes from. The "Example page" column was always empty, because the store kept no pages for a reference. The edges and `site` they read back now match the audit report's entity map, and `site` is the URL you audited rather than the site's origin (older audits that never recorded that URL still show the origin). New audits store the pages, and `squirrel analyze` fills them in for an audit stored by an earlier version.
- A finding in your dashboard for an element you fixed, or for one a rule update renamed, now resolves when a published audit checks that page again and lists every item of that check, even while the page still fails the check for another element. Before, it stayed open for as long as the page failed the check at all. A check that lists only some of its items, or could not finish its scan, keeps the rest open, because the audit can't tell they were fixed.
- `content/hidden-text` and `content/dev-leakage` skip a page that hits their scan limits when the part they read was clean, instead of passing it. The pass told your dashboard the page was clean, so a finding from an earlier audit that sat past the limit was marked fixed while it was still there. It now stays open.
- The configuration docs use the rule ids and option names the rules read. Entries such as `[rule_options."performance/ttfb"]`, `exclude_patterns` and `min_external_links` matched no rule or option, and an audit ignores an unknown rule id or option without a warning (`squirrel config validate` doesn't catch it either), so copying them changed nothing. `content/keyword-stuffing`'s `density_threshold` is a percentage (`3`, not `0.03`), and the URL patterns these rule options take are a substring, a `/segment/` or a `regex:`, never a `*` glob. The [rule options reference](https://docs.squirrelscan.com/configuration/rule-options) is corrected and points to the Options table on each rule's page, and the `squirrel init` page shows the config file the command really writes.

### Security

- The MCP SDK is updated to 1.32 for a published advisory in its OAuth client (GHSA-6qxp-vccf-f47h). `squirrel mcp` runs only the SDK's stdio server and the OAuth client is not part of the squirrel binary, so the CLI was not exposed.

## v0.0.104 — 2026-10-06

Pages kept out of search stop counting against title, description and heading checks, and four fixes from community bug reports cut false positives in structured data, image and accessibility checks.

### Changed

- Pages kept out of search are no longer graded on how they would look in search results. On a page whose robots meta tag or `X-Robots-Tag` header says `noindex`, `core/meta-title`, `core/meta-description` and `core/h1` record a skipped check instead of a finding, and `core/title-unique`, `content/duplicate-title`, `content/duplicate-description` and `links/orphan-pages` leave the page out. Scores can rise for sites with noindex pages such as thank-you pages, internal search or account pages, because those findings no longer count. Accessibility, security, performance and broken-link rules still check every page. When the homepage itself is noindex, as on a staging site or a Vercel, Netlify or Cloudflare Pages preview deployment, nothing is skipped, so a pre-launch audit still checks titles, descriptions and headings everywhere. The [rules reference](https://docs.squirrelscan.com/rules#pages-kept-out-of-search) has the details. Thanks to @deniskern for the report (#457).

### Fixed

- `schema/json-ld-valid` accepts an `ImageObject` (or an `{"@id"}` reference) for `image` and `logo`, and resolves `@id` references across the page's JSON-LD, so `@unhead/schema-org` (Nuxt) pages validate clean. Validation errors are no longer repeated under "Invalid JSON-LD syntax", and a page reused from the crawl cache is validated again instead of replaying the previous release's results. Thanks to @deniskern for the report (#463).
- `images/responsive-size` reports a small image only when its measured file is heavier than its displayed size needs, instead of flagging every thumbnail without `srcset`. Thanks to @deniskern for the report (#464).
- `a11y/color-contrast` reports only contrast it measured: an inline text and background color pair under 4.5:1. Guesses from class names and stylesheets, such as `text-gray-300`, are no longer findings. Thanks to @deniskern for the report (#465).
- `a11y/aria-dialog-name` identifies an unnamed dialog with no id by its classes and start tag (`dialog.newsletter-popup`) instead of a bare `dialog`. Thanks to @deniskern for the report (#462).
- Entity map findings link to the entity map guide at its new home, https://docs.squirrelscan.com/guides/entity-map/fixing.

### Security

- Dependencies are updated for published security advisories, including `smol-toml`, which reads `squirrel.toml`.

## v0.0.103 — 2026-10-05

Two rule fixes from community bug reports: fewer false accessibility warnings on honeypot and hidden fields, and noindex set by a response header now shows up in the report.

### Fixed

- `a11y/aria-hidden-focus` no longer reports elements a keyboard user cannot reach. Inside an `aria-hidden` region, an element with `tabindex="-1"`, a disabled form control, a hidden input, and anything under an `inert` or `hidden` element now count as not focusable, matching axe-core. Honeypot spam fields from form builders were the usual false positive, on every page that had the form. A link or button you can still Tab to inside `aria-hidden` is reported as before. Thanks to @deniskern for the report (#456).
- `core/robots-meta` now reports `noindex` and `nofollow` sent in the `X-Robots-Tag` response header, including the crawler-scoped form (`X-Robots-Tag: googlebot: noindex`). Before, a page kept out of search only by the header appeared nowhere in the report. Each message now names its source, so a directive set by a CDN or server config is easy to tell from one in the page source; existing robots meta tag messages end with "via robots meta tag". Thanks to @deniskern for the report (#457).

## v0.0.102 — 2026-10-03

The spend line after a signed-in audit now counts the same pages your report shows as audited.

### Fixed

- The cloud credits line after a signed-in audit counts the pages the report shows as audited: its coverage line ("Coverage: audited 12 of 12 known pages"), or its page count when there is no coverage line. Before, it used the crawl count, which also includes error pages such as a `404` kept for its broken-link finding, so the line could show more pages than the report did. A cloud render paid for a page that turned out to be an error is refunded when the audit completes, and pages a smart audit carries forward from an earlier audit are not charged again. The server settles the charge for every CLI version, so this changes what the CLI prints, not what you pay. The [credits page](https://docs.squirrelscan.com/cloud/credits) explains the count.

## v0.0.101 — 2026-10-02

The CLI's credit estimates and spend line now match how signed-in audits are billed, and a balance that can't cover the page limit lowers the limit instead of running out part-way.

### Changed

- Signed-in audits are estimated and billed at 50 credits plus 2 per audited page, however the page was fetched: plain HTTP, a cloud browser render, the render cache, a `304 Not Modified`, or a plain fetch after a render failed. Each page is charged once per audit, and rendering does not change the price, so choose `--http` or rendering for accuracy, not to save credits. A 19-page audit costs 88 credits.
- A cloud audit pays 1 credit per distinct external link it checks, and the same link on twenty pages is one check. Link checks the CLI runs for `squirrel audit`, and all internal links, stay free.
- A balance that can't cover the page limit now lowers the limit, with a notice saying how many pages it covers, instead of running out part-way. `[cloud] max_credits_per_audit` works the same way: its default of 1,000 covers 475 pages. Below 52 credits (the base plus one page) the audit runs local-only.
- `squirrel credits`, the out-of-credits messages and the consent prompt state the same price, and the cloud spend line after an audit matches what your balance was charged, for example `Cloud credits used: 88 (audit-base 50, 19 audited pages 38)`. Earlier versions are billed the same way, but their estimate and spend line can show less than was charged.
- The [failed audits guide](https://docs.squirrelscan.com/guides/failed-audits#troubleshooting) has a section for each cause a cloud audit can fail with, saying what it means, how to check it and what to do.

## v0.0.100 — 2026-10-02

Large audits use about half the memory and keep every page they crawl, an audit that cannot write its local store says so before it starts, and a round of rule fixes stops flagging module scripts, `<noscript>` fallbacks and CSP host wildcards that were never a problem.

### Changed

- Large audits use about half the memory. The rules phase no longer holds every page's findings until the report, and the report no longer reads every page body back out of the local store. A 4,000-page audit of 1.5 MB pages peaked at about 3 GB, down from about 5.8 GB, and the report step is several times faster. Findings and scores are unchanged.
- The local content store's 1 GB cap is configurable: `[storage] content_store_max_bytes` in `squirrel.toml` takes a byte count or a size such as `"4GB"`, and `SQUIRREL_CONTENT_STORE_MAX_BYTES` sets it for one run. The default is still 1 GB. `squirrel self doctor` shows the store's size, the cap and the last eviction, and warns when the store is over the cap.

### Fixed

- An audit never evicts its own pages from the local content store. Once a crawl outgrew the cap, the store pruned the audit's earliest pages before the rules read them back, and those pages quietly dropped out of the audit. An audit now keeps every page it stored until it finishes, even past the cap, and the next one prunes the store back down. When pages were evicted earlier, a re-audit requests them again in full and says how many, and `squirrel report` and a resumed audit say how many are missing.
- An audit whose local store it cannot write now stops before it starts, with one line naming the file, why (owned by root after a `sudo` run, blocked by a coding agent's sandbox, read-only, a directory, damaged, disk full) and the command that fixes it. Before, it failed partway with `attempt to write a readonly database`, or fetched every page, saved none and ended with a bare "No pages were crawled". Nothing is charged when the check fails (#403).
- A signed-in audit that fails within its first second, or whose terminal is closed, now shows as failed or cancelled in your dashboard. Before, it could be flipped back to running and an hour later marked "stopped reporting progress". Closing the terminal now cancels the run, the same as Ctrl-C.
- Pages that embed fonts as base64 in a `<style>` block no longer stall the audit. `a11y/color-contrast` read that CSS in quadratic time, so a chat widget's 428KB of `@font-face` data held one page for over a minute; the same page now takes milliseconds, with the same findings. `links/tel-mailto` had the same flaw on a mailto link wrapped around a long unbroken run of text.
- `perf/inp-hints`, `perf/render-blocking` and `perf/critical-request-chains` no longer count `<script type="module">` as render-blocking. Module scripts are deferred by default, `nomodule` scripts never run in a modern browser, and scripts with a non-JavaScript type (consent-gated `text/plain`, Partytown) never block either. The three rules now agree on which scripts block. Thanks to @deniskern for the report (#424).
- Rules no longer report content inside `<noscript>` as if it loads or renders. Tracking pixels, GTM iframes, and fallback images and stylesheets placed there for visitors without JavaScript stopped showing up as missing alt text, untitled frames, missing SRI and the like, on roughly 30 rules. Thanks to @deniskern for the report (#434).
- `a11y/aria-required-children` accepts the implicit roles of native elements, so `<input type="radio">` inside `role="radiogroup"` counts as a radio, and the same goes for options, list items, rows and cells. Thanks to @deniskern for the report (#435).
- `security/csp` no longer calls a host wildcard like `https://*.example.com` a bare `*`; a bare `*` host still warns (#427).
- `perf/source-maps` reports a source map from a shared bundle once, listing every page that loads it, with a separate finding per section bundle, instead of one finding per page.
- `crawl/sitemap-domain` and the `sitemap-orphans` checks list a 50-URL sample with the exact count. A 100,000-URL sitemap used to make a 12 MB JSON report on its own; it is now about 50 KB, and the orphan count no longer stops at 10,000.

## v0.0.99 — 2026-09-30

`squirrel setup` gets you from install to your first audit in about a minute, the CLI installs and updates the agent skills itself, `--no-publish` really does skip the publish, and `--disable-discovery-probes` turns off the pre-crawl requests that got some audits banned by server firewalls.

### Added

- `squirrel setup`: one guided first run. It signs you in (optional, local audits never need an account), installs the agent skills for Claude Code, Codex, Cursor and more (default yes), and turns on auto-update, then hands you the command for your first audit. Run it again any time: each step says when it is already done. `--yes` takes every default, `--dry-run` shows what it would do. The installers now end with one next step, `squirrel setup`.
- Running `squirrel` on its own shows a quick start and every command grouped by what it is for (audits, agents, cloud, settings), in place of a flat list that ended in `ERROR No command specified`. `squirrel --help`, group help such as `squirrel self`, and each command's `--help` use the same layout, with examples.
- The CLI, `install.sh` and `install.ps1` share one header: the pixel squirrel from squirrelscan.com, in the site's colours. It uses truecolor or 256 colours depending on what the terminal supports, a plain silhouette with `NO_COLOR` or piped output, and text alone without UTF-8.
- `squirrel feedback` works without a terminal, so an agent or a script can send it. Pass the text with `-m`/`--message`, as plain words, or piped on stdin and it sends without a single prompt. `--json` prints one result object and, on any failure, exits 1 with an error code and the web form's URL. `--run-id` and `--website-id` say which audit or site it is about, and `--email` sets the reply address, which otherwise falls back to the one you last gave, then your signed-in account's. At a terminal with no text it asks, as before.
- `send_feedback` on `squirrel mcp`: the local server gets the feedback tool the hosted one already had, sent through the same path as `squirrel feedback`.
- `squirrel audit --disable-discovery-probes`, or `[crawler] disable_discovery_probes = true` in `squirrel.toml`, turns off the requests an audit sends before its first page for the files agents look for: `llms.txt`, `/.well-known/*`, `/openapi.json`, `/swagger.json`, `AGENTS.md`, and the homepage fetched as GPTBot and Claude-User. Some firewalls ban a client for asking for `/swagger.json`. A common fail2ban "sensitive files" jail does exactly that, every request after it gets connection refused, and the audit fails right after it starts. robots.txt, sitemap discovery and the page you asked for still run. The flag wins over the config for one run, so `--disable-discovery-probes=false` sends the probes when the config turns them off. The [crawler docs](https://docs.squirrelscan.com/configuration/crawler#discovery-probes) list every request, and how to let the audit through your firewall instead.

### Changed

- Input piped to `squirrel feedback` is now the feedback itself, not answers to its prompts. A pipe left open and silent for 5 seconds counts as finished, so the command can't hang waiting on it.
- `squirrel skills` installs and updates the agent skills itself: no Node, no `npx`, no other tool. It reads the published `manifest.json` in [squirrelscan/skills](https://github.com/squirrelscan/skills), downloads only the files that changed, checks every one against its sha256, and only then writes the skills to `~/.claude/skills/` (`$CLAUDE_CONFIG_DIR/skills/` when set) and `~/.agents/skills/` (Codex, Cursor, Gemini CLI and other Agent Skills tools) as real copies, so it works the same on macOS, Linux and Windows. A failed or mismatched download writes nothing and leaves the previous install as it was.
- The commands: `squirrel skills` (the same as `squirrel skills status`: what is installed where against the latest version), `install [skill...] [--agent claude|agents|all] [--project] [--dry-run]`, `update [skill...] [--check] [--force] [--dry-run] [--json]` and `uninstall [skill...] [--agent ...] [--project]`, which removes only what squirrel wrote. `update --check` exits 1 when an update is available, and 2 when the check itself fails, for scripts and agents. `--project` means the repo you run it in (the nearest folder with a `.git`), and each repo's copies are updated from inside that repo.
- A skill file you edited is never overwritten silently. squirrel records the hash of every file it writes; `update` keeps an edited file and says so, and `--force` replaces it after backing your copy up to `~/.squirrel/skills/backups/`. Your own files in a skill folder stay put.
- Skills installed earlier with `npx skills` are taken over: squirrel updates them in place, replaces the symlinks `npx skills` made with copies, and removes them from its lock file after copying it to `.skill-lock.json.bak`, so the two tools stop updating the same folders. A skill folder that links elsewhere, such as your own checkout, or that holds another author's skill of the same name, is left alone.
- Auto-update keeps the installed skills current. On the first run after the CLI updates itself, a background job updates the skills you already have (never one you don't, and never inside a repo): no prompts, edits kept, once per version, a 60 second limit, and no network at all when none are installed. It follows `auto_update`, is off in CI and with `SQUIRREL_NO_UPDATE`, and `squirrel self settings set skills_auto_update false` turns off just the skills. It runs after the update has landed, so it can never fail or delay it.
- The agent skills and agent plugins have one home: [squirrelscan/skills](https://github.com/squirrelscan/skills). This repo no longer carries copies: its `skills/` directory and the Claude Code, Cursor and Agent Plugins manifests are gone. The Claude Code plugin (`/plugin marketplace add squirrelscan/skills`), the Cursor plugin and the Agent Plugins package each bundle both skills with the hosted MCP server there. None carries a version, so Claude Code versions its plugin by commit and every change to the skills reaches plugin users without a CLI release.
- If you added the `squirrelscan/squirrelscan` Claude Code marketplace, it keeps working: its plugin entry now points at squirrelscan/skills, so `/plugin marketplace update squirrelscan` then `/plugin update squirrelscan@squirrelscan` moves you over. The Cursor plugin can't redirect that way; install it from squirrelscan/skills.
- The discovery probes follow your rule selection. A probe goes out only when a rule that reads it is going to run, so `--rule-exclude ax` sends none of them and `--rule-exclude ax/api-discovery` leaves out the OpenAPI, Swagger and OAuth paths.
- The discovery probes queue behind `per_host_concurrency` and `per_host_delay_ms` like every page does. They used to go out 20 at a time, whatever those were set to, so a polite crawl was polite everywhere except in its first second. They are plain requests, so they keep those settings when cloud rendering loads pages one at a time.
- An agent experience check whose probe was not sent, or whose probe for a file like `/llms.txt` or `/.well-known/mcp.json` got no answer (a refused connection from a firewall that just banned the audit, or a timeout), says "not checked" (value `not-checked`) instead of reporting the file missing, and is not scored.

### Fixed

- `squirrel skills install` works again. In v0.0.98 it stopped with "No valid skills found" once the skills moved to their own repository; it now installs them from [squirrelscan/skills](https://github.com/squirrelscan/skills) directly.
- A mistyped command now says what you probably meant (`squirrel audti` suggests `squirrel audit`, `squirrel skills instal` suggests `squirrel skills install`) and exits 1 without a stack trace. A missing argument shows the command's usage and an example, and a command group run on its own (`squirrel self`) shows its help and exits 0.
- `squirrel -c <path> <command>` works: the config path given before the command was read as the command name ("Unknown command").
- `squirrel skills update` updates the skills. It used to pass a repository to `npx skills update`, which reads its arguments as skill names, so it matched nothing installed and changed nothing.
- `squirrel audit --no-publish` skips the publish. The flag never reached the command, so a signed-in run published anyway, or ended in "Could not auto-publish" when the connection failed. `--no-publish` together with `--publish` (or `-p`) now stops with an error before the audit starts, whatever the order. Before, the pair was accepted and `--no-publish` ignored.

## v0.0.98 — 2026-09-23

A crawl no longer slows down as your local page cache grows, and the entity map that travels with a report now carries a representative sample of a large site instead of an alphabetical slice of it.

### Fixed

- A crawl's speed no longer tracks the size of your lifetime page cache. Storing a page ended in a count over the whole content store, an aggregate no index can answer without walking every row, so a long crawl got slower as it went and the same audit took longer against a large cache than against an empty one. The store now answers from a running total, and pruning drains to its target in batches instead of stopping short and pruning again on the very next page. A 400-page audit against a roughly 1 GB store now matches the same audit against an empty one, 17.4s against 17.5s; before it was 28.2s against 17.8s on a cold store.
- The entity map published with a report keeps a sample of the site rather than its alphabetical head. Entities declared on several pages come first, then one-off entities stratified by type so a catalogue of thousands of products cannot crowd out the organisation, website and brand entities the map exists to show, and the per-page entities a graph hides by default are held to a small share. Every type present in the map keeps at least one entry.
- The copies of the entity map that travel are bounded and say what they dropped. The published copy and the copy inlined into an HTML report each have their own node, edge, string and total-size limits, and both now carry the number of entities, references and pages left out. A clipped map is no longer indistinguishable from a small site. The summary still describes the whole site, not the sample, so the totals you read are the real ones. Your local copy on disk is unchanged and stays complete.

## v0.0.97 — 2026-09-19

The macOS binaries carry a signature macOS accepts again, the installer stops blaming memory for a binary the system killed, and a `Sitemap:` line in robots.txt written without a scheme is read as the host it names.

### Fixed

- The macOS binaries are signed again. `bun build --compile` writes its bundle into the executable but leaves the linker's ad-hoc signature describing the file as it was before, so `codesign --verify --strict` failed on every darwin asset we have published, and a Mac that enforces signatures killed the binary on sight. That is what the installs failing on Apple Silicon with exit 137 were hitting. Both darwin binaries are now re-signed after the build and before anything hashes them, and a macOS step verifies the signature and the recorded hashes before a release can publish.
- The installer no longer tells a Mac user that a killed binary is out of memory. On macOS it names the two causes that are actually possible, a rejected code signature or security software, gives the command that tells them apart, and puts the macOS version in the report it sends.
- A `Sitemap:` line in robots.txt that leaves out the scheme is read as the host it names instead of as a path on the audited site. `Sitemap: example.com/sitemap.xml` is now fetched at `https://example.com/sitemap.xml`, where it used to be fetched at `https://example.com/example.com/sitemap.xml` and 404. A declared sitemap whose path is not one of the common locations is reached again, so its URLs count towards sitemap coverage, orphan pages and missing pages, and a sitemap declared on another host (a CDN) is fetched there, still without the audit's own request headers. The report no longer lists a robots.txt sitemap failure that only our own resolution created, stores the resolved URL in every field that carries one, and reports the missing scheme as a robots.txt problem rather than repairing it silently.

## v0.0.96 — 2026-09-17

Every audit now builds a map of the entities your site declares, a new command and five MCP tools read it, thirteen rules check it, and the leaked-secrets scanner went from a thousand false alarms on real sites to a few hundred correct public keys.

### Added

- **Entity map on every audit.** Structured data across the whole crawl is resolved into one graph (organisations, people, products, articles, and the pages that declare them), stored with the audit and embedded in every report format. Report-only: no score changes.
- `squirrel entities` queries that map: a summary of what your site declares, a lookup by `@id`, key or name, and `--list` over stored audits. `--type`, `--page` and `--problem` narrow the result in every output format, not just on screen.
- Export the graph as `csv`, `dot`, `graphml` or `mermaid`, alongside the existing `json`, `jsonld`, `html` and `markdown`.
- `squirrel entities --diff` compares two audits of a site and reports entities added and removed, `@id` changes, and new and resolved conflicts and dangling references. An entity is only called removed when every page that declared it was crawled again; anything else is reported as not crawled, so a smaller crawl never reads as a site that deleted its structured data.
- Five entity tools on `squirrel mcp`: `list_entities`, `get_entity`, `get_entity_graph`, `compare_entities` (with `occurrence_threshold`) and `get_entity_findings`. They read the local project store: no auth, no credits, no round trip.
- Thirteen `schema/entity-*` rules over the map: missing organisation and website entities, split identities, conflicting declarations, dangling references, orphans, publisher mismatches, type drift, `@id` format, missing `sameAs`, authors, and one local business per page. Each has a rule doc page.
- After a local audit, a signed-in user whose reports have never reached the cloud gets a one-line nudge to publish (with an explicit unlisted visibility). It shows once; the first publish switches it off for good.
- When an audit is refused for lack of credits, the CLI shows the cost, your balance, the reset date and an upgrade link scoped to the organisation that hit the wall, on the preflight warning and on `squirrel credits`. The wall also prints the balance again (it never did: the number was read from the wrong place in the response).
- After a published audit of a site on a recurring schedule, the CLI prints one line naming the cadence and the link that turns it off. When the site wanted a schedule but the plan's scheduled-site slots are spent, the line says so instead, with the plan's limit and an upgrade link. `squirrel report --publish` keeps a bare URL on stdout and prints the line on stderr. The line renders what the cloud sends, never a guess of its own.
- Leaked-secrets decodes what it scans: HTML character references, `\u` and `\x` escapes in scripts, and base64 runs that decode to text (data URIs and SRI hashes are never decoded). AWS access key ids, GitHub tokens, JWTs (Supabase `service_role` is high, `anon` is public, an expired token is a new `leaked-secrets-expired` info check), Algolia secured keys, Stripe, Slack and Sentry tokens are decoded offline so the finding carries what the token is, and a GitHub token with a bad checksum is dropped.

### Changed

- Leaked-secrets precision. Prefix patterns respect a left boundary, brand keywords must sit within 40 characters before the value, minified member keys no longer count as assignments, and public-by-design keys (PostHog, Shopify Storefront, Mixpanel, Raygun, and generic API keys under twelve public brands) report as public instead of leaks. On a private corpus of 383 real pages: 1,235 findings before, 352 after, none high. Scans are also faster.
- Leaked-secrets checked against a 197-site launch corpus. Twelve false-positive classes fixed, each paired with the real shape it must still catch: a run of `A` in a base64 payload is not a Twitter bearer token, a decoder table is not a Telegram token, a font CDN path is not a DigitalOcean key, a credential word in a ternary branch is not a key, a connection string with no password has nothing to leak, and Amplitude and Supabase publishable keys report as public while `sb_secret_` keys are now caught. On the 56 sites that fired at the previous release: 172 findings before, 0 after, with no true positive lost.
- The Discord bot token pattern no longer goes quadratic on long base64 runs (1.6 s to 2.5 ms on a 200 KB data URI page).

### Fixed

- Reports print the page limit you asked for alongside the one the run used, so a run clamped from 10,000 to 4,320 pages no longer tells you to raise a limit that was already higher.
- Merged check messages carry their counts instead of a bare `N`. When pages disagree on a count the message shows the range (`3 to 6 image(s) missing alt`); pages that disagree on any other number (a date, a size, a code) keep their own message instead of being merged. Digits inside words are left alone, so `H1` no longer reads `HN`.
- `perf/bad-caching` no longer fails a page that revalidates correctly. A document served with `max-age=0` or `no-cache` plus an ETag or Last-Modified declares a caching policy and passes; `no-store`, and a validator with no `Cache-Control` and no `Expires`, still do not. On the launch corpus this check failed 163 of 196 sites, most of them doing the right thing.
- `integrity/template-discontinuity` no longer calls a site's own signed-out or empty-state page "likely injected". A page that loads the site's own stylesheets or scripts is reported for review, never escalated; shared public hosts (font and script CDNs) do not count as the site's own. Escalation is now a warning rather than a failure, so one off-template page cannot zero Site Integrity, and the escalation is withheld when the crawl hit its page limit with fewer than `minBaselinePagesWhenCapped` pages (default 20).

### Docs

- New pages for the entity map (CLI, formats, cloud), cloud crawl scope, include/exclude patterns and authorised crawls; the rule catalogue counts refreshed.
- Scheduled audits: the docs now name every place a schedule is disclosed (report page, completion email, digest, CLI line), the resolved findings the digest lists, and what happens when a run is skipped for credits.
- Scheduled audits: a table of the five schedule states (off, active, capped, unschedulable, paused), what the dashboard shows for a site whose plan slots are spent, and how a freed slot is filled.
- Adding a website in the dashboard now asks for a scan depth (default surface) and a schedule (default weekly, on from creation); the docs page for adding a website describes both and what happens when the plan's scheduled-site slots are spent.
- The hosted MCP server's reference page lists its five entity tools, and the published API spec documents the entity export endpoint's eight formats and its new `exclude_type` parameter.
- The cloud entity map docs describe the dashboard's history view: metric series across audits and the change list between two audits, with the eight change kinds it can show and the one gap it cannot yet.

## v0.0.95

Two fixes for scores that moved when nothing on the site had, one for local audits
that reached out to the cloud, and an installer that works where GitHub does not.

### Changed

- Audits of `localhost`, loopback, and private-network addresses no longer hand anything to a hosted runner: no publish, no run registration, no cloud rendering, and no site added to your dashboard. This covers `squirrel report --publish` as well as `squirrel audit`, and internal names such as `box.local` and `metadata.google.internal` as well as private IP ranges. The audit, its report, and the content-based cloud analysis are unchanged, and the CLI prints one line saying the report stayed local. Hosted services cannot reach those addresses, so a dashboard site for one could never be screenshotted, re-rendered, or re-audited.

### Fixed

- Published cloud reports no longer count findings the CLI carried from its local
  store as pages crawled this run. A machine with an old local audit database
  could publish thousands of stale findings, which the cloud stored as first seen
  today and scored as if every one of those pages had just been crawled, swinging
  the health score by tens of points between identical runs. Carried findings keep
  the date the cloud last saw them, and the audited-page count is now the pages the
  crawl actually visited.
- Two page URLs that differ only by their query string are two pages again.
  Findings on `/p?id=1` and `/p?id=2` were stored under one URL, piling every
  page's issues onto a single entry in the report.
- A signed-in audit of a local or private-network address no longer submits its pages to the cloud render service, which charged on submit for renders the hosted browser then refused.
- The installer now downloads from install.squirrelscan.com when GitHub is
  unreachable, so an install no longer dies on networks that cannot reach
  GitHub's release hosts. Both sources are checksum-verified against the release
  manifest. Set `SQUIRREL_FORCE_MIRROR=1` to skip GitHub from the start, and if
  both hosts fail the installer now prints the two URLs it tried.
- A download host that answers with a sign-in or error page instead of the
  release manifest is now treated as a failed source, so the installer moves on
  to the other host rather than stopping on a parse error. This is what a
  captive portal or an intercepting proxy looks like.

## v0.0.94

A one-line follow-up to v0.0.93 for the cloud audits that still ended before
their first page: the quick crawl phase now waits for the entry page's retry.

### Fixed

- A quick cloud audit's crawl phase now holds the entry page's worst case. The
  130 s phase ended before the entry retry added in v0.0.93 could report, so a
  slow origin still failed with "no pages collected". Quick runs get a 210 s
  crawl phase and a 330 s runtime (the post-crawl slice is unchanged); surface
  and full are untouched. squirrelscan/repo#1699 squirrelscan/repo#2026

## v0.0.93

A release for the audits that never started. Two cloud fixes stop a slow or
oddly-shaped origin from ending an audit before its first page (one site had
failed every attempt since August), the CLI starts on a third of the memory so
`install.sh` no longer dies at the last step on capped machines, and a
re-audit of an unchanged site replays its rule results instead of re-running
them. Plus three contributed fixes from the community. We are convinced this is
the fastest way to crawl and audit a site, and it is now also the most patient
one.

### Changed

- **A re-audit of an unchanged site replays its rule results.** A page whose
  inputs its rules read are all unchanged is neither parsed nor rule-checked
  again; its stored results are replayed. On a 2,500-page site the warm rules
  phase falls from 110 s to 12 s and the warm audit from 143 s to 44 s, with
  the report byte-identical to a cold run. Site-scope rules always run. When
  the cache is on, template fan-out (#279) is off for that run, which costs the
  cold rules phase about 7%; set `SQUIRREL_RULE_CACHE=0` to disable the cache.
  Figures are in `benchmarks/2026-09-perf-program.md`. squirrelscan/repo#1990

### Fixed

- Cloud rendering now reserves time for its plain-HTTP fallback inside each
  page's fetch deadline: the render has the deadline minus 12 seconds to
  itself, then the plain fetch starts and races it, and whichever lands first
  serves the page. A render that finishes late but inside the deadline is still
  used, and a crawl stop mid-submit no longer leaves the server's render debit
  unrecorded. The cloud runner's per-page deadline rises from 12 to 30 seconds
  (the CLI's default) so a far-away origin no longer decides the audit; the
  preamble budget, sitemap walk window and entry-page retry that derive from
  it are documented next to the constant. squirrelscan/repo#2026

- A cloud audit of a site whose sitemap points at another domain no longer fails
  with "No pages were crawled from <site>: The operation was aborted." when the
  entry page's first fetch hits its deadline. The entry URL now gets one more
  plain fetch with a doubled deadline before the audit is given up (a `warning`
  event says so), an abort from a document fetcher classifies as a timeout that
  names the fetcher and the deadline instead of `unknown` with the runtime's
  text, and a crawl whose preamble budget runs out records a warning naming the
  budget. squirrelscan/repo#1699

- `squirrel` starts light. Every invocation used to evaluate the whole CLI
  (the audit engine and every rule package included) before parsing a single
  argument, which put `squirrel self install` at about 140 MB resident and got
  it killed (exit 137) at the last step of `install.sh` on memory-capped
  machines. Subcommands and the startup extras now load on demand, and the
  standalone binary is built with `--splitting`, so `self install` and
  `--version` peak at about 43 MB. Commands that need the engine load it when
  they run. #2023
- `install.sh` finishes the install itself when `self install` is killed by a
  signal (the file work needs no memory), then checks that the binary runs. A
  binary that will not run is reported under its own step with the binary and
  link paths, a memory figure, the swap recipe, and the cloud dashboard as the
  no-binary alternative, instead of "retry". #2023
- `squirrel self update` now checks that the binary your PATH resolves is the one
  it just installed, and says so when it isn't. It used to flip the symlink
  recorded at install time and report success on that alone, so a stale
  `install_bin_dir` (or a second `squirrel` earlier on PATH) left you running the
  old version after every "Updated to vX". A recorded bin directory that no longer
  exists is now dropped, and the update falls back to the default one. #293
- `squirrel self doctor` gained an Install location check: the recorded
  `install_bin_dir`, the link and the release version it points at, and the
  `squirrel` your PATH actually resolves, with a warning when they disagree. #293

- The script fetch cache is reachable again. It stored a script under the hash
  of its content but looked it up by the hash of its URL, so every audit
  re-downloaded every script. Both sides now key by URL, a cached script older
  than a day is fetched again, and a refresh replaces the stale row instead of
  keeping the first body forever. Thanks to @WilliamK112 for the fix. #182 #206
  #303

- The CLI's end-of-run report to the cloud is retried on transport errors and
  5xx responses, three attempts with a short backoff, so a completed audit is
  no longer left "running" on the dashboard until the reaper finds it. Thanks
  to @WilliamK112. #178 #208

- `install.ps1` enables TLS 1.2 before its first network call, so Windows
  PowerShell 5.1 with legacy protocol defaults can download the release. Thanks
  to @WilliamK112. #166 #207

## v0.0.92

A release about running again. v0.0.91 made a big audit fit in memory; this
one makes the second audit of the same site cheaper than the first, lets a
local audit crawl 10,000 pages, and cuts the rules pass on script-heavy pages
by 40%. It also adds the disk tooling a project database needs once audits
accumulate, and fixes the CLI minting API keys against the wrong organization
for accounts with more than one.

### By the numbers

Every figure is from the checked-in record in
`benchmarks/2026-09-perf-program.md`. Laptop rows are a cold `squirrel audit
--coverage full`, heap sampled after a forced collection at exit.

| | v0.0.91 | v0.0.92 |
|---|---|---|
| 2,500-page audit, wall time | 502 s | 177 s |
| 2,500-page audit, retained heap | 3,902 MB | 996 MB |
| 1,000-page audit, wall time | 194 s | 128 s |
| 1,000-page audit, retained heap | 1,662 MB | 565 MB |
| Largest local audit | 5,000 pages | 10,000 pages in 12 min, 5.4 GB peak RSS |
| SQL statements compiled on a warm 120-page re-crawl | 1,482 | 48 |
| Rules pass on a 1 MB script-heavy page | 274 ms | 165 ms |
| Page-rule CPU on a templated site (25 template-scoped rules) | | 13% less |
| Report assembly at 1,000 pages, peak memory | | about 150 MB less |
| Hosted publish merge carrying 60,000 prior findings | 330 MB | under 100 MB |
| Hosted re-audit of an unchanged 150-page site | 115 pages rendered | 17 rendered, report byte-identical |
| Project database after six audits of a 40-page site | 14.7 MB | 11.9 MB |

### Added

- **`squirrel self disk` shows where `~/.squirrel` goes, and `--prune` gets it
  back.** Every audit keeps its full history in the project database, so a
  re-audited site grows by roughly one audit per run (about 95 MB per audit of
  a 1,000-page site). `squirrel self disk` lists per-project and total usage.
  `squirrel self disk --prune --keep N` retires the audits beyond the newest N,
  prints the plan, asks, and then rebuilds the database so the space returns
  to the filesystem. `--keep` is required: a retired audit can no longer be
  rendered, and `report --list`, `--diff` and `--regression-since` reach into
  that history, so the window is your call. Retiring keeps everything the next
  audit reads (the newest page record per URL, sub-resources, links, images),
  so an incremental re-crawl still gets its `ETag`s. A retired audit stays
  listed, marked with the date its data was reclaimed, and `report`, `--diff`,
  `--regression-since` and `analyze` refuse it instead of rendering an empty
  report.

- **`squirrel keys` takes `--org`, and `auth whoami` says which org you are.**
  On an account with more than one organization, `keys create` minted against
  the newest one rather than the active one, silently. It now takes
  `--org <slug|id>`, lists the organizations and refuses when there is more
  than one and no `--org`, and `keys list` and `keys revoke` are scoped the
  same way. `auth status` and `auth whoami` print the active organization.

- **The audit says when `--max-pages` was clamped.** Asking for more pages than
  the cap allows used to run at the cap and say nothing. The audit now prints
  the requested and effective limits, and the JSON and LLM reports carry both,
  so a clamped audit is distinguishable from a complete one.

- **Template-aware rules.** Pages of one site share their chrome (header,
  navigation, footer, script stack) far more than their structure: a real
  storefront's 247 pages fall into 13 chrome clusters. Every page now carries
  a template cluster key, and page rules whose verdict depends only on the
  chrome (viewport, doctype, favicon, consent mode, tag manager, font and
  script delivery, subresource integrity, and others) run once per cluster
  with the verdict fanned out to the cluster's other members, with findings
  byte-identical to running them on every page. About 13% less rule CPU on
  that storefront. `SQUIRREL_TEMPLATE_FANOUT=0` turns it off.

- **The crawl says when its base is the wrong host of a pair.** When the seed
  redirects between the apex and `www` and the probe is refused, the crawl
  used to pin itself to the wrong host and drop every link as cross-domain,
  producing a one-page audit. The probe now sends a real user agent, recovers
  the base from the links it sees, and warns when the two disagree.

- **A project keeps its last 3 audits.** Re-auditing wrote a whole new crawl and
  retired nothing, so `project.db` grew by about one audit every time: roughly
  95 MB per audit of a 1,000-page site, forever, with nothing saying so. A
  successful audit now retires the audits older than the newest three, which
  turns that growth into a ceiling. Set the window with `[storage] keep_audits`,
  or turn it off with `0` or `false`. A retired audit stays listed and says when
  its data went; it can no longer be opened, diffed, or used as a
  `--regression-since` baseline, so raise the window if you keep an old audit as
  a reference. A run that ends `failed` or `blocked` neither retires anything
  nor takes a place in the window, and the page cache the next audit reads is
  never part of what goes: a re-audit after retirement still serves every
  unchanged page from its conditional GET. `squirrel self disk --prune` now
  offers to rebuild a project whose audits were already retired, which is what
  returns the freed space to the filesystem.

### Changed

- **The rules pass on script-heavy pages is 40% cheaper.** On a page carrying
  800 KB of inline script the rules phase cost 274 ms per page; it is now 165.
  The secret scan and keyword scans skip any pattern whose mandatory literals
  are provably absent from the page, the skip-link rule stops serializing the
  whole body once per heading, and two script rules stop counting with regular
  expressions that built arrays to read their length. Findings are unchanged.

- **The report reads a crawl's checks once, not twice.** Assembling the report
  loaded every rule result twice; it now loads them once and reuses the rows,
  which is about 150 MB less peak memory at 1,000 pages. The report also stops
  building per-page fields (response headers, image lists, structured data)
  that no output format or renderer ever read.

- **A warm re-crawl compiles seven statements, not thousands.** The storage
  layer prepared its per-page statements on every call; they are cached now,
  which takes a re-crawl of an unchanged site from about twelve compilations
  per page to well under one.

- **Hosted audits stream the carried side of the publish merge.** Finalizing a
  hosted re-audit held every previously open finding in memory at once, about
  5 KB each, so a site carrying 60,000 open findings needed 330 MB inside a
  128 MB worker. Prior findings now stream from a cursor and the report's
  carried side is a bounded per-rule sample with exact counts, which brings
  that case under 100 MB with the same scores.

- **A page fingerprint survives a Shopify cache regeneration.** Shopify rewrites
  request ids and shuffles app-block order between two fetches of the same
  page, which made every page look changed. The fingerprint now ignores those.

- **A local audit crawls up to 10,000 pages.** The hard cap on `--max-pages`
  and `[crawler] max_pages` was 5,000; it is now 10,000, on every plan, local
  audits being free either way. A 10,000-page audit peaks at about 5.4 GB of
  memory and takes about twelve minutes on a laptop, so the cap is a real
  ceiling rather than a formality: past it, split the audit by section with
  `include` patterns. Cloud audits follow their plan instead, and Team's
  ceiling rises to 10,000 with this release.

  Publishing a report from a crawl this size needs an API that accepts it, so
  update the CLI only after the hosted side has: an older server rejects a
  publish carrying more than 2,000 page statuses or 5,000 crawled URLs.

- **A local audit no longer holds the whole site in memory.** The CLI's
  post-crawl phases ran the resident pipeline: one parsed page plus its DOM per
  crawled page, held from the end of the crawl through the entire rules pass,
  and a second full read of every page to assemble the report. Retained heap
  grew about 1.5 MB per crawled page, so a 2,500-page audit ended holding 3.9 GB
  while the operating system's "resident" figure read a reassuring 1.4 GB.
  Every phase after the crawl now walks the pages table in batches sized to the
  site and drops each batch before reading the next, which is what the hosted
  runtime has done since v0.0.91. Reports are unchanged, page for page.

  Batch size follows the site's own average page against a byte budget.
  `SQUIRREL_STREAM_BATCH_BYTES` sets that budget (48 MB of raw HTML by default)
  and `SQUIRREL_STREAM_BATCH_PAGES` pins an exact page count instead. Turning
  the budget below roughly a dozen pages' worth is counterproductive: the same
  crawl becomes several times as many read-parse-collect cycles and peaks
  higher, not lower.

- **A 429 is reported as a rate limit, not a broken link.** The link rules used
  to count a rate-limited response as broken; it now needs the status lead-in
  like every other status.

- **Crawl bookkeeping fixes.** The frontier's page-exists check always answered
  yes; the content-store prune check answers from a covering index instead of
  a full scan on every stored page; the container's cloud-prefetch payloads no
  longer hold their pages alive after use.

## v0.0.91

A release about big sites. A 500-page audit of a store whose pages weigh a
megabyte each used to hold every parsed page in memory at once, run out of
room, and fail three times in a row after the crawl had already finished. The
audit engine now streams: pages are parsed in batches sized to the site, the
rules pass runs over one batch at a time, and the report is assembled from
per-rule tallies instead of from every finding at once. The same pass makes a
finding mean one defect instead of one defect per page, adds three content
rules for things that should never have shipped, and tightens the installer.

### Added

- **Three content rules for leftovers.** `content/placeholder-text` flags lorem
  ipsum, unrendered template tags such as `{{ user.name }}`, `[object Object]`,
  `undefined` in a table cell and `TODO` markers in visible copy.
  `content/unrendered-markup` catches literal markdown, escaped HTML and
  double-encoded entities that reached the page as text, and stays quiet
  inside code blocks and syntax-highlighted samples. `content/dev-leakage`
  finds `localhost`, private IP ranges, `staging.` and `dev.` hosts, preview
  deploys (`vercel.app`, `netlify.app`, `pages.dev`, ngrok) and plain `http://`
  links back to the site's own origin, on a production page.

- **A zero-page audit says why.** When the crawl fetches nothing, the report,
  the CLI output and the failure notice now name the cause: the host did not
  resolve, the certificate was rejected, the connection closed before a
  response, the origin timed out, or it answered with a 4xx or 5xx. Before,
  every one of those read "No pages were crawled".

### Changed

- **The audit engine streams instead of holding the whole site.** Link checks,
  asset fetches, the rules pass and the report are all built from batches of
  parsed pages rather than one array of every page. The batch is sized from a
  byte budget (48 MB of raw HTML by default, `SQUIRREL_STREAM_BATCH_BYTES`)
  divided by the site's own average page size, so a docs site with 20 KB pages
  and a store with 1 MB pages both fit. Peak memory now tracks the batch, not
  the page count. Progress output reports the sub-phases of the pass
  (universe, site fetch, page rules, site rules, assemble) as they happen.

- **A finding is one defect, not one defect per page.** An item-level finding
  such as a cross-origin script without Subresource Integrity now carries its
  own message and locator instead of inheriting the page's count ("26
  resources without SRI" on one page, "24" on the next). The same script
  missing on 400 pages is one finding with 400 affected pages. This also fixes
  the reverse defect, where unrelated items on the same page shared a
  fingerprint because the page count matched.

- **Longer budget for large full audits.** The per-page time allowance for a
  full-coverage audit rose from 4.8 to 7.2 seconds, so a 500-page audit of
  script-heavy pages reaches the one-hour ceiling instead of being cut off
  partway through the rules pass.

- **The installer pins its transport.** Every `curl` in `install.sh` now
  refuses anything but HTTPS (including across redirects), requires TLS 1.2 or
  newer and follows at most three redirects.

- **The CLI is built on Bun 1.4.** The runtime the `squirrel` binary is
  compiled with moved from 1.3.14 to 1.4.0, the release Bun rewrote in Rust.
  The visible effect is size: the Linux binaries that the install script and
  containers pull are 11 to 14 percent smaller (about 90 MB instead of 101 MB
  for glibc, 83 MB instead of 97 MB for musl and Alpine), the Windows binary
  is 8 percent smaller, and the CLI starts about 10 ms faster. Audit results
  are byte-identical across the two runtimes: the same sites produce the same
  scores, the same issue counts and the same reports. Every install target was
  built and run on the new runtime, including the Alpine and musl path.

- **A DNS failure is reported as a DNS failure.** Bun 1.4 is the first runtime
  that distinguishes a host that does not resolve from one that refuses the
  connection, and the CLI now passes that distinction through, so an audit of
  a mistyped domain says the name did not resolve rather than that the server
  was unreachable.

## v0.0.90

A release about sites that do not answer the way you expect. A store that
throttles, an origin that sends headers and then goes quiet, a seed URL that
bounces somewhere else: each of these used to produce a report that was either
wrong or silent about what it did not see. This pass teaches the crawler to
wait when it is told to wait, to give up when nothing is coming, and to say in
the report which of those happened. It also adds a compression check for
assets, closes three gaps in the leaked-secrets scan, and lets the CLI apply an
update it already knows about before it runs.

### Added

- **Rate limiting is handled as rate limiting.** A 429, a Shopify 430, or a 503
  that carries `Retry-After` now pauses every worker aimed at that host, drops
  it to one request in flight, and waits out the backoff (honouring
  `Retry-After` when the server sends one) instead of retrying three times in a
  second while the other workers keep firing. A new `[crawler] max_backoff_ms`
  setting (default five minutes) caps how long one host can hold the crawl.
  Throttled URLs are no longer reported as broken links or 4xx sitemap
  entries: they move to an "unverifiable" bucket, the report carries a
  `rateLimited` count and host list, and a crawl that lost pages this way is
  marked `partial` with a reason that names the host. The progress line says
  which host is throttling and how long it is waiting.

- **Uncompressed text assets are reported.** New `perf/asset-compression` rule
  flags stylesheets, scripts and other compressible text resources over 100 KB
  that were served with no content encoding, biggest first, with the pages that
  load them and the estimated saving. A server that gzips its HTML but not its
  CSS is a common misconfiguration and was invisible before.

- **The CLI applies a pending update before it runs.** When auto-update is on
  and an earlier background check already found a newer version, the next
  command installs it first and re-runs itself on the new binary, so a run
  right after a release no longer reports results from the version before it.
  The wait is capped at two minutes and any failure falls back to running the
  command on the current binary.

- **An agent setup prompt after login.** `squirrel auth login` now ends, in the
  terminal and on the browser success page, with the one-line prompt that
  points a coding agent at the setup docs, with a copy button.

- **Free plan schedules one website.** Scheduled audits are no longer the paid
  line. The free plan can schedule one website weekly or monthly; daily
  schedules and more websites remain on paid plans.

### Fixed

- **A stalled body no longer hangs the crawl.** Every fetch deadline was
  cleared the moment response headers arrived, so an origin that answered 200
  and then trickled or stopped its body could park the crawl forever before it
  had even started. The deadline now stays armed through the body read, in the
  crawler, the engine's script and external-link fetchers, and the CLI's own
  copies of them.

- **The crawl preamble has one budget.** The root probes that run before page
  one (redirect resolution, robots, llms.txt, well-known files and friends)
  share a single wall-clock budget instead of seven sequential timeouts, so a
  slow origin can no longer spend the whole crawl phase before fetching a page.
  A probe that ran out of budget is recorded as unknown, never as a confirmed
  absence. The sitemap walk runs on a progress window instead, so a site with
  many legitimate sitemaps is slow but complete.

- **A refused off-site redirect is disclosed.** When the seed URL redirects
  off its own domain the crawler refuses to follow it and audits the seed. The
  report now says so in every format, and says where the redirect pointed, so
  the scores cannot be read as being about a URL nobody visited.

- **Leaked-secrets finds three more shapes.** A quoted JSON key
  (`{"apiKey":"…"}`), an environment fallback (`process.env.KEY || "…"`), and a
  standard-base64 bearer token were each slipping past the scan. All three are
  detected now.

- **Leaked-secrets no longer reports a spaced-out checksum.** A `sha256` key
  with a run of whitespace before its value was read as an unnamed assignment
  and reported as a key. The look-back now spends its budget on characters
  that carry meaning, and refuses to read a word out of a fragment it cut in
  half, so a checksum stays a checksum and a real credential cut mid-name still
  reports.

- **Leaked-secrets is fast on pages with thousands of matches.** Overlap
  suppression compared every finding against every other, which was quadratic:
  an 875 KB page of 16,000 keys spent two seconds in that one loop. It now
  indexes by window and produces byte-identical results in a fraction of the
  time.

- **Markdown reports keep their metadata out of the warning.** The partial-scan
  hint was emitted as a blockquote in the middle of the metadata lines, and
  CommonMark's lazy continuation pulled the recovery note and the version into
  the quote. It is a plain line now.

### Changed

- **Domain stats are paused.** The domain-level summary (backlinks, referring
  domains, organic keywords and traffic, domain rank) described a site's market
  position rather than anything you could fix in the code, and it sat
  awkwardly next to everything else a report tells you. `cloud.domain_stats`
  now defaults to `false` and the section is no longer rendered or charged
  for. Reports that already captured it keep their section. It may come back.

## v0.0.89

A release about not crying wolf. A rule that reports a problem that is not there
costs more than a rule that stays quiet, because it teaches people to skim past
the whole category, and a handful of checks had a shape that looked like a defect
and was not: a redirect that no server ever sent, a checksum read as a leaked key,
a decorative image read as a missing description. This pass fixes those, tightens
how large sites and large reports are judged, and makes a few failures explain
themselves instead of leaving a bare error.

### Fixed

- **A redirect chain is only reported when a redirect actually happened.** The
  crawler normalizes a URL before it fetches it, so a link written one way and
  fetched another looked like a hop even though no server sent a 3xx. Both the
  redirect-chain and canonical-chain checks now build a chain only from responses
  the crawl actually observed, so a tidy site that simply writes its links in a
  different form than it serves them is no longer told it redirects to itself.

- **Attribute names are matched the way a browser matches them.** HTML attribute
  names are case-insensitive, but the parser was comparing them exactly, so
  markup that spells an attribute in camelCase (`inputMode`, or `ALT` in caps)
  slipped past the rules that read it. That was a quiet source of both missed
  findings and false warnings on framework-rendered pages, and it is fixed
  everywhere at once.

- **An empty alt on a decorative image is correct, not missing.** A spacer or a
  purely decorative image that carries `alt=""` and `aria-hidden` is doing the
  right thing, and the alt-text check no longer counts it as a missing
  description.

- **Checksums are no longer mistaken for leaked secrets.** A SHA-256 hash printed
  on a downloads or releases page is a 64-character hex string, which the
  leaked-secret scan was flagging as a possible key. It is not one, and it is no
  longer reported.

- **Mojibake detection leaves code alone.** The garbled-text check now skips
  `code`, `pre`, `samp` and `kbd`, where byte sequences that look like mojibake
  are usually just the sample being shown on purpose.

- **A large sitemap is held to the right limit.** A sitemap index is allowed
  50,000 child sitemaps, and each of those up to 50,000 URLs, but the check was
  applying the per-file URL limit to the index as a whole, so a healthy sharded
  site with more than 50,000 URLs across its shards was told its index was too
  big. The index and the shards are now each measured against their own limit.

- **Sitemap freshness reads the page's own date.** The lastmod-drift check now
  compares a sitemap entry against the page's own document-level date rather than
  the first date found anywhere in its structured data, so a sitewide
  organization or website node dated years ago no longer makes an up-to-date page
  look stale.

- **A first audit no longer implies a previous one.** Findings on pages the audit
  has not rendered yet are now labelled "unrendered" instead of "carried", which
  used to suggest a prior audit existed when it did not.

- **A large report records what it left out.** When a report reaches the cap on
  how much per-page detail it keeps for a single rule, it now records the true
  affected-page and check totals it clipped, so the coverage on a big crawl is
  never quietly understated.

- **An install killed for memory explains itself.** A `curl | sh` install on a
  small machine can be killed by the out-of-memory killer, which leaves no output
  at all, so the installer reported nothing but a number. It now names the likely
  cause and the ways out: add swap, move to a machine with more memory, or
  download the binary and place it yourself.

- **A malformed cloud response no longer ends the audit.** A success response
  from the hosted editor-summary that was missing its prose used to crash the run
  after the crawl had already finished. The CLI now takes what it can and
  completes the audit.

## v0.0.88

Two rules about the difference between a page that is linked and a page that is
supported. A site's navigation links every page from every other page, which
makes the whole site look evenly connected when most of it is not: a page whose
only inbound links are the ones repeated in the header and footer carries no
signal about what it is for or why it matters. The same template logic cuts the
other way for the site's own assets, where one shared layout should give every
page the same favicon and share image, and a page that disagrees is usually
running an older template nobody remembers owning.

The engine is now at 278 rules across 21 categories.

### Added

- **`links/no-contextual-inbound`** reports pages whose only internal inbound
  links come from sitewide chrome: the nav, header, footer or sidebar. Those
  links help discovery, but they are identical on every page, so they say
  nothing about the page they point at. The fix is a link from the body copy of
  a related article, hub or category page with anchor text that describes the
  destination, which is what passes topical relevance. The minimum count is
  configurable for sites that treat a single contextual link as enough.

- **`social/asset-divergence`** reports pages whose favicon, theme-color or
  fallback share image differs from the rest of the site. These come from one
  layout, so every page should carry the same three, and the ones that do not
  are a section that missed a redesign or a second layout still in service. The
  visible cost is a tab icon that changes as visitors move around and link
  previews that do not match. Per-page share images on articles and products
  are correct and are not reported: the comparison is against the fallback the
  rest of the site shares.

### Changed

- **Custom request headers are available on every plan.** Auditing a staging
  site behind an auth header is how you check work before it ships, and it was
  gated behind Pro. It is not any more.

### Fixed

- **`squirrel credits` linked to a page that did not exist.** The top-up link
  it printed had never resolved to anything. It now lands on the billing page
  for your account, and older versions of the CLI that still print the old
  address are redirected there too.

- **Running out of credits during an audit now says what to do about it.** The
  CLI printed a bare warning with no price and nowhere to go. It now reports
  the balance, what the audit needed, and where to top up or upgrade.

- **Reinstalling over a stale `squirrel` symlink no longer fails.** If
  `~/.local/bin/squirrel` pointed at a release that had been cleaned up, the
  installer refused to replace it. It now does. The install script also no
  longer dies part way through on systems where `sh` is dash, which is the
  default on Debian and Ubuntu.

## v0.0.87

A reliability fix for long audits. An audit is not just its crawl: once the last
page is fetched there is still link checking, rule evaluation, scoring,
rendering and publishing to do, and on a large site that second half can take
longer than the first. The CLI reported its progress only while pages were being
crawled, so for the whole of that second half it went quiet, and a run that was
working normally became indistinguishable from one that had died. Past a point
the server concluded it had died and marked it failed, discarding a completed
crawl and delivering no report.

The bigger the site, the more likely this was, which is the wrong way round.

### Fixed

- **A long audit is no longer given up on while it is still running.** The CLI
  now reports that it is alive for the entire run rather than only during the
  crawl, so the time spent on rules, scoring and rendering no longer counts
  against it. Audits of large sites that previously failed near the end, after
  the crawl had already finished, should now complete and publish. If one of
  yours did this, re-running it on this version is worth a try.

- **Interrupting a crawl now tells you how to resume it.** Crawls have always
  been saved as they go, and an interrupted one can be picked up where it
  stopped with `--resume` instead of started again. Nothing said so, so a
  cancelled crawl of a few hundred pages looked like lost work. Cancelling now
  reports how many pages are saved and prints the exact command to continue.

## v0.0.86

Three rules about the gap between what your markup claims and what your pages
actually show. Structured data is a promise made to a machine that never reads
the page, so nothing in a per-page validity check can tell you the promise is
false: a rating block is well-formed whether or not anyone can see a rating, and
a `lastmod` is a valid date whether or not anything changed that day. These
rules ask the second question.

The engine is now at 275 rules across 21 categories.

### Added

- **`schema/rating-scope`** reports `AggregateRating` markup that is not about
  the page it sits on. `schema/review` validates the shape of a rating block, so
  one sitewide rating emitted by a template passes on every page of a site,
  including the privacy policy. Two checks: whether a rating is visible anywhere
  in the page's own text, and whether the rated entity is the subject of a page
  where a rating could apply at all. A third-party review widget clears the
  first, since its badge is injected client-side and a raw crawl cannot see it.
  The finding names the page type and the rated entity, and frames the risk as a
  structured-data manual action rather than a validation error, because that is
  what it is.

- **`crawl/sitemap-lastmod-drift`** reports sitemap `lastmod` values that
  disagree with the page's own date. Two directions, because they come from
  different mistakes: a `lastmod` older than the page's `dateModified` usually
  means a stale sitemap or an inverted published/updated precedence, and one
  newer by more than a month usually means the field is stamped when the site
  builds. Each finding reports both dates and the gap in days. Pages carrying no
  date of their own are skipped rather than guessed at.

- **`crawl/sitemap-lastmod-churn`** reports `lastmod` values that have collapsed
  onto one or two days across the whole sitemap, which means they are stamped at
  build time and carry no freshness signal at all. Google News sitemaps are
  excluded: they hold about 48 hours of articles by design, so their dates are
  supposed to cluster.

### Fixed

- **Anchor text is judged per destination, not per link.** A card that links to
  the same page twice, once from its image and once from its headline, was
  reported as having empty anchor text for the image link. Only one link in such
  a group needs to describe the destination, and screen readers announce the
  group together, so the checks now evaluate links to a target as a unit.

## v0.0.85

Five new rules that grade a page against the rest of your own site instead of
against a fixed threshold. Every audit rule until now asked the same question of
every site on the internet: is this title too long, is this page too thin. That
works for the rules where one right answer exists, and it is useless for the
much larger class of problem where the only evidence something is wrong is that
one page disagrees with the other nine hundred. A 200 word page is thin on a
documentation site and normal on a news site. A product page missing `Product`
markup only matters because its siblings have it.

These rules learn the norm from your crawl and report the deviants, which means
they need a crawl big enough to have a norm. All five stay silent below 10
crawled pages, and stay silent when no clear majority exists, reporting a
skipped check that says which condition was not met rather than guessing. A site
that is legitimately heterogeneous should see nothing from them, and that is the
intended result, not a failure.

The engine is now at 272 rules across 21 categories.

### Added

- **`content/thin-vs-site-norm`** reports pages far shorter than comparable pages
  on the same site. Pages are grouped by section first, so a terse tag listing is
  not measured against your long-form posts, and the outlier test uses a robust
  spread rather than a mean, so a handful of very long pages cannot drag the
  threshold up and hide the thin ones.

- **`content/title-pattern-outlier`** learns your title template and reports the
  titles that break it. Most sites settle on one shape, `Page | Brand` or
  `Brand: Page`, usually because a template emits it. The pages that do not match
  are usually the ones a human wrote by hand or a migration missed: brand missing
  entirely, brand on the wrong end, a different separator.

- **`schema/coverage-outlier`** reports pages missing the structured-data markup
  their siblings have. If 90% of your product pages carry `Product` and a dozen
  do not, those dozen lose rich results, and nothing in a per-page check can see
  it because each page is individually valid.

- **`url/slug-convention`** reports URLs that break your site's own conventions:
  case, word separator, trailing slash, file extension. Mixed conventions
  usually mean two generations of routing coexisting, which is where duplicate
  content comes from.

- **`core/canonical-form-drift`** reports canonical URLs that disagree in form
  across the site, for example some absolute and some relative, or some with the
  `www` host and some without. Each one is individually valid, so per-page
  validation passes while search engines see an inconsistent story about which
  URL is the real one.

### Fixed

- **A site behind a WAF challenge is no longer reported as unreachable.** Adding
  a domain probed it first and accepted only a normal response. A site sitting
  behind Vercel's Attack Challenge Mode, Cloudflare's, or any similar protection
  answers that probe with a challenge rather than the page, and the domain was
  refused as if the site were down. The probe now treats any HTTP response as
  proof the site is there, because it is.

- **A crawl that lost its handshake no longer disappears.** If the network
  dropped the call that registers a run, the CLI retried and the server treated
  the retry as a second, unrelated run. The original became an orphan: work that
  had been done, could not be found, and showed up later as a failed audit. The
  registration now carries an idempotency key, so a retry resolves to the same
  run, and an orphaned run is adopted when its report is published.

- **Long crawls are no longer killed while they are working.** The job that
  cleans up abandoned runs measured age alone, so a genuinely slow crawl of a
  large site could be marked failed while it was still making progress. It now
  looks at progress before deciding a run is dead, and audits that were reaped
  and then delivered anyway are repaid.

- **Renders you did not get are no longer charged.** A page render that failed
  was still billed, and a run could spend past the estimate it quoted you when
  it started. Failed renders are refunded and spend is capped at the run's own
  quote.

- **Cloud audits run every rule you are paying for.** Audits started from a
  website or from the GitHub integration were dispatched without the flag that
  enables the paid services the rules depend on, so eight rules quietly skipped
  while the audit billed in full. Both paths now dispatch with those services
  enabled and a bounded credit cap.

- **A failed audit refunds the organization that was actually charged.** When a
  run failed after its base charge, the refund was aimed at the organization
  named in the request rather than the one billed. If you had not named one
  explicitly, those two were different and nothing was refunded at all.

- **A missing `robots.txt` is reported as an error, not a warning.** No
  `robots.txt` means no place to declare a sitemap and no control over crawling.
  That is not a nice-to-have.

- **Report issues are ordered by severity across the whole report.** Sorting
  happened inside each category, so a critical issue in the last category sat
  below a warning in the first, and the top of the report was not the worst of
  the findings.

- **Windows installs no longer fail with a permission error.** The installer
  linked the binary with a symlink, which needs Developer Mode or an elevated
  shell on Windows, and failed with `EPERM` otherwise. It now falls back to a
  copy. A failing `squirrel self install` also prints what actually went wrong
  instead of a bare exit code.

## v0.0.84

A crawl-correctness release. squirrelscan was requesting URLs your site never
links and then reporting the redirects it had caused. On any site whose URLs end
in a slash, which is the default on WordPress, Hugo and Jekyll, that invented
findings, and on some hosts it also spent part of the page budget on redirect
pages instead of your content.

### Fixed

- **The crawler no longer asks for a URL your site never linked.** URL
  normalization dropped the trailing slash before the request went out, so a site
  whose every internal link ends in `/` was asked for `/about` when it only
  publishes `/about/`. Two things followed from that, and both are fixed.

  First, the origin answered with a redirect, and `links/redirect-chains` and
  `crawl/canonical-chain` reported it: a redirect that existed only because we
  asked for it. Those findings were wrong rather than merely noisy, and they
  fanned out, because the check for links pointing at redirecting URLs then
  blamed nearly every page that linked the correct form. If your report listed
  pages redirecting to themselves with a slash added, that section should now be
  empty. Genuine redirects are unaffected: a page you really do link at a URL
  that really does redirect is still reported.

  Second, and only on some hosts: a few sites answer the no-slash URL with a
  `200` and a small JavaScript redirect page rather than an HTTP redirect. There
  is no redirect for the crawler to follow, so that page was stored and graded as
  though it were your article, and title, charset and word count were judged
  against a few hundred bytes of redirect script. In one 15 page crawl of a blog
  hosted this way, 12 of the 15 stored pages were redirect pages rather than
  posts. Sites that answer with an ordinary HTTP redirect were never affected
  this way, because the crawler followed it and stored the real page. If your
  site is in the first group, expect finding counts and scores to move in both
  directions: some checks stop failing because they had been grading a redirect
  page, and others start reporting because your content is finally being read.

- **A redirect chain no longer shows a status the hop never returned.** When a
  page is rendered in the cloud, the render service reports the page it landed
  on, never the statuses of the redirects that got it there. Those unseen
  statuses were filled in with the landing page's own status, producing chains
  that read `(200) → (200)`. A first hop that returned 200 did not redirect at
  all. Hops squirrelscan did not observe are now recorded as unknown and shown
  without a status, and no chain can claim a hop redirected while also reporting
  that it returned 200.

- **`squirrel auth status` explains an organization API key instead of blaming
  it.** An `sq_` organization API key works for audits, publishing and credits,
  but the identity lookup behind `squirrel auth status` and `squirrel auth
  whoami` accepts only the login token that `squirrel auth login` issues. That
  rejection was reported as the key being invalid, revoked, expired or from the
  wrong environment, none of which was usually true. It now says what actually
  happened, and tells you to unset `SQUIRRELSCAN_API_KEY` after logging in, since
  an environment key takes precedence over a session for every cloud call.

### Changed

- **A site that links both `/about` and `/about/` now has both crawled.** They
  are different URLs, and only a request can tell you which one redirects, so
  collapsing them into one meant the answer depended on which form the crawler
  happened to see first. Sites that link a single consistent form, which is
  nearly all of them, crawl exactly as before.

## v0.0.83

Three new rules, a rebuilt local-SEO check, and a crawl-correctness fix for seeds
that redirect off your site. The rule set is now 267.

### Added

- **`content/hidden-text` flags text and links hidden from visitors but left
  visible to crawlers.** Google's spam policies treat this as deceptive, and
  pages doing it can lose rankings or drop out of search entirely. The rule
  looks for the techniques that have no innocent explanation: an off-screen
  `text-indent`, a zero font size, same-on-same colour, a zero-size clip. It
  deliberately does not accuse you over `display:none` or `opacity:0` on their
  own, because that is what every accordion, modal, and scroll-reveal library
  writes. Content revealed inside a `@media` block, by a transition on a
  compound selector, or alongside a transform is read as UI rather than
  concealment. It is a warning at weight 6, and escalates to a failure only when
  hidden *links* are involved, which is the stronger spam signal.
- **`a11y/autocomplete-tokens` checks that fields collecting a person's own data
  carry the right autofill token.** Name, email, phone, address, and payment
  fields with the correct WHATWG token fill in one tap, which is the difference
  between a completed checkout and an abandoned one, and WCAG 2.1 success
  criterion 1.3.5 requires it. Section and shipping/billing prefixes are
  understood. A token the browser does not recognise is ignored outright, so a
  typo like `firstname` is worse than nothing, and `autocomplete="off"` on
  personal data does not stop autofill in modern browsers, it only stops the
  accurate kind.
- **`a11y/input-types` checks that fields use the right input type and keyboard
  hint.** `type="email"`, `type="tel"`, `type="url"`, and `type="number"` each
  summon the right mobile keyboard and bring free browser validation with them.
  The rule also flags `type="number"` on digit strings such as postal codes,
  phone numbers, and card numbers, where it strips leading zeros and silently
  discards anything that is not a valid float, and `novalidate` on a form that
  still declares `required` or `pattern` and ships no replacement validation.

### Changed

- **`local/nap-consistency` now compares your business details across the whole
  site.** It used to judge one page at a time. It now collects the name, address,
  and phone from every crawled page and reports when the same value is rendered
  several different ways, which is the drift that actually costs you local
  citations. Phone numbers declared in `tel:` links count alongside JSON-LD, so a
  footer that formats the number differently from your markup is visible. The
  cross-page half only fires once enough pages declare a signal, and the rule
  still skips sites with no local-business signal at all.
- **`security/form-https` now separates a real downgrade from an already-insecure
  page.** Actions are resolved against the page URL, so a relative or
  protocol-relative `action` inherits the page's scheme instead of being guessed
  at, and `formaction` on submit buttons is read too. An HTTPS page posting to
  `http://` now fails: the padlock tells the user they are safe while the
  submission travels in the clear. An HTTP page posting to `http://` stays a
  warning, and a page with nothing to submit reports as info rather than passing
  silently.

### Fixed

- **A seed that redirects off-site no longer re-bases the whole audit.** If the
  URL you passed redirected to another site, that target became the audit's base:
  every root probe (robots.txt, llms.txt, sitemap discovery, the `.well-known`
  and agent-manifest sweep) went to a host you never named, and the target's
  content was stored and reported under your seed's name. A site redirecting to a
  CDN or a parked domain produced a report describing the target while claiming
  to describe the seed. The base is now pinned to the seed. A redirect is adopted
  only when it stays on the same registrable domain and port, so `http` to
  `https` upgrades and apex to `www` bounces still work; one that leaves is
  refused, and the refused target is recorded as the report's `finalUrl` so you
  can still see it. The same rule applies per page: a page whose redirects landed
  off-site is dropped rather than filed under your audit, unless your own scope
  config admits it.
- **Building objects from untrusted keys is hardened.** Keys taken from crawled
  content can no longer reach an object's prototype.
- **The install endpoint always serves the current release.** Release channel
  metadata and the install scripts are now published as part of the release
  itself and verified against the live endpoint before the run is allowed to
  finish, so a new version cannot be announced while the installer still hands
  out the previous one.

## v0.0.82

Follow-ups to the v0.0.81 security release, plus two crawl-correctness fixes.
Pages listed in a sitemap with query strings are now crawled at the right URL,
and a single network blip no longer takes down a whole audit.

### Fixed

- **Sitemap URLs with query strings are crawled correctly.** XML requires `&` to
  be written `&amp;` inside a `<loc>`, and that escape was surviving into the
  URL the crawler enqueued. A sitemap entry for `?a=1&amp;b=2` was fetched
  literally, so those pages 404'd or were audited as the wrong URL, and on a
  site that paginates or filters through query strings that can be most of the
  sitemap. All five predefined XML escapes are now decoded, in a urlset and in
  the child entries of a sitemap index.
- **A single network blip no longer aborts the audit.** The pre-flight
  reachability probe had no retry, so one transient DNS failure, connection
  reset, or timeout ended the run before the crawl started. It now makes up to
  three attempts with a short backoff, inside a 20 second overall budget so a
  genuinely unreachable site still fails quickly. Only transient failures are
  retried: a refused connection or an HTTP error is still reported on the first
  attempt.
- **The bounded-read guard now covers every path.** v0.0.81 bounded untrusted
  response bodies as they stream. On the fallback path taken when a runtime
  hands back no readable stream, the limit was still applied only once the body
  was in memory. That path now refuses an over-declared `content-length` before
  reading anything, and truncates by bytes rather than characters, so a
  multi-byte character cannot split at the boundary.
- **Builtin crypto imports are explicit.** The crawler and the fetchers imported
  `crypto` unqualified. That is an undeclared dependency which can resolve to a
  deprecated npm stub instead of the runtime builtin, depending on what else is
  installed. Both now import `node:crypto`.

## v0.0.81

A security release, plus two new content rules. Audits now treat everything a
site tells them to fetch, and everything a site tells them to print, as
untrusted, and `squirrel self settings` no longer prints your credentials.

Everyone should update. If you audit sites you do not control, or you use
`-H/--header` to pass authenticated headers, update before your next run.

### Added

- **`content/stale-copyright` flags a footer year that has fallen behind.** A
  copyright year stuck in the past is the most common "this site is abandoned"
  signal a visitor sees, and it costs nothing to fix. It is a warning at low
  weight, so one templated footer repeated across every page cannot dominate
  your content score.
- **`content/mojibake` flags encoding corruption in visible text.** Catches
  garbled sequences like `â€™` and `Ã©`, and replacement characters, in the text
  your visitors actually read. These almost always mean a template, export, or
  CMS migration lost the original encoding, and the same corruption is usually
  sitting in fields you cannot see, such as meta descriptions and alt text.

### Fixed

- **Redirects can no longer change protocol.** Every fetch derived from page
  content, including redirect targets, sitemap and RSL references, `Link`
  headers, and client-side meta refresh, is now restricted to `http` and
  `https`. Previously a site could redirect an audit to a non-http URL and have
  the result stored in the report.
- **Custom headers stay on their origin.** Values passed with `-H/--header` are
  now scoped to the origin you sent them to and are dropped when a redirect
  crosses to another origin, on auxiliary probe requests as well as page
  fetches. These values are documented as secrets, so this closes a path where
  a redirect could forward them to a host you did not choose.
- **A hostile response can no longer exhaust an audit's memory.** Every read of
  an untrusted response body is now bounded as it streams and cancelled at the
  limit: robots.txt, sitemaps, `llms.txt`, `.well-known` documents, RSL,
  fetched scripts, and page bodies. The previous guards could not do this. A
  `content-length` header is absent on a chunked response and reports the
  compressed size on an encoded one, and the size limit was otherwise applied
  only once the whole body was already in memory. A small compressed file that
  expands to gigabytes now stops at the limit instead.
- **A site can no longer repaint your terminal.** Page text reaches the console
  report and the `text` and `llm` outputs through many fields, and it could
  carry terminal control sequences: a site could embed an escape that clears
  your screen and prints its own "0 issues found" over the real result. Control
  characters are now stripped where the report is written. The console keeps
  colour codes, which can only change how text looks and never move the cursor
  or clear the screen, so the report itself is unchanged.
- **`squirrel self settings` redacts credentials.** The command printed the
  stored auth token, and any provider keys held in the plaintext fallback used
  when the OS keychain is unavailable. Output is now redacted. If you have
  pasted this output anywhere, rotate the token with `squirrel auth login`.
- **Project names cannot escape their directory.** A `[project] name` in
  `squirrel.toml` is now contained before it is used to build the local
  database path.
- **Repo-local settings are limited to safe keys.** A `settings.json` inside a
  checkout can now only influence the documented writable settings, so cloning
  an untrusted repository cannot redirect where the CLI installs updates.
- **Consistent lowercase branding.** The product is "squirrelscan" everywhere,
  including the text report title and the database lock warning.

## v0.0.80

The CLI is now open source under MIT, with the public repo set up as the canonical
home for the CLI and docs. This release also hardens the public surface and makes
sure the telemetry opt-out is honored everywhere.

### Added

- **MIT licensed CLI.** `squirrelscan` is now open source under MIT.
- **Public repo source of truth.** CLI builds and docs now come from the public
  repository.
- **Telemetry opt-out respected everywhere.** `NO_TELEMETRY` is honored by the
  CLI and install flow.

### Fixed

- **Public-repo hardening.** Release and update paths were tightened to avoid
  command injection, traversal, unsafe URL handling, and Markdown injection
  issues.
- **Parser and sanitizer performance issues.** Several regex-heavy paths were
  rewritten to avoid ReDoS-style slowdowns.
- **Secret and scheme filtering tightened.** Unsafe URLs and non-http(s) inputs
  are now rejected more consistently.

## v0.0.79

Clearer page limits, more armor for audits of slow or messy sites, and a lot of under-the-hood groundwork for auditing much bigger sites. More on that soon.

### Added

- **Audits tell you when they hit your plan's page limit.** If a site has more pages than your plan covers in one cloud audit, the report and your audit listings now say the crawl was capped and at what count, instead of quietly auditing a subset. Coding agents get the same notice through the MCP server, so your agent knows it saw part of the site, not all of it.
- **`squirrel crawl` gets the speed controls.** The `--concurrency` and `--per-host` flags and the localhost fast path that `squirrel audit` gained in v0.0.74 now work on the standalone crawl command too.

### Fixed

- **Very slow or bot-hostile sites can no longer stall a cloud audit.** Analysis of each asset and network probe now runs under its own time budget, and sites that drip-feed bytes to waste crawler time are detected and cut off. An audit of a hostile site finishes with what it could get instead of hanging until the overall timeout.
- **More publish hardening for messy sites.** Absurdly long URLs are skipped during the crawl instead of gumming up the works later, every remaining free-text field is trimmed at publish time, and size limits are now enforced byte-accurately so emoji and other multi-byte characters can't split at a boundary. This closes out the class of failures where one extreme page could sink an otherwise good report.

A reliability release for cloud audits. Heavy sites that used to kill the audit engine outright now complete, the easiest way for a good audit to die at the finish line is gone, failed audits always refund, and audits show you they are alive while they work.

### Fixed

- **Audits of heavy sites complete instead of dying silently.** Sites with very large pages could exhaust the audit engine's memory mid-analysis: the audit went quiet and eventually showed up as timed out, with no report after multiple retries. Audit engines now run with 16x the memory and 8x the CPU, and the exact audits that failed this way now run to completion. If the engine ever does die, the audit is marked failed within moments, with a clear message and an automatic refund, instead of hanging in silence.
- **Audits no longer fail because a page has very long text.** A single oversized headline, or any absurdly long string anywhere on a site, could fail the whole audit at publish time: no report, just a refund and a shrug. Publishing now trims display text to fit instead of rejecting the report, across every field, and the same guard covers long lists (a site with issues on more than a thousand pages could trip it too). Big messy sites are exactly the ones that need auditing, so this one mattered.
- **Blocked-site audits refund automatically.** When a site blocks the crawler outright (bot protection, 403s at the door), the audit failed but kept its base charge, because the failure notice it published counted as a delivered report. Refunds now check what the report actually says. Every failure path, blocked, down, errored, cancelled, or stalled, nets zero credits.
- **Post-crawl steps have hard deadlines.** One audit sat for 52 minutes in a stuck enrichment call after its crawl had already finished. Every post-crawl step now has a deadline: a hung enrichment is dropped, its section is omitted, and the audit finishes with everything else intact. An overall backstop bounds the whole run even if a future step misbehaves.
- **Deleted websites stay deleted.** If a bookkeeping step failed during a delete, the site could keep showing up in your website listings until you deleted it again. The record now retries durably until it lands.

### Added

- **Live heartbeat while an audit works.** The audit feed now shows "still working" progress every 30 seconds through the slow parts, so a long analysis is visibly alive instead of frozen, and a genuinely stuck audit is caught and refunded much sooner.

## v0.0.77

Fixed issues now actually clear themselves. If you fixed something on a page that a later crawl never revisited, the finding used to sit there open forever and drag your score down. Three separate causes, all fixed. Reports also tell you what they scanned, label anything carried over from an earlier crawl, and five false positives are gone.

### Added

- **Reports disclose their scan scope.** Every report now states what it actually looked at: how the run started, how deep it crawled, how many pages it covered, and how to run a full scan when you want the rest. No more guessing whether a clean report means "clean" or "barely looked".
- **Carried-forward findings are labeled everywhere.** A finding on a page that wasn't re-crawled this run is now marked as carried, with per-rule rollups ("4 of 12 pages carried from previous crawls") in the cloud report, the dashboard, and `get_report` over MCP. When a rule is clean on every page checked this run and stays red only because of carried pages, it says so, so you can tell "still broken" from "probably fixed, not re-checked yet".
- **"Was on N pages" expands to the actual URLs.** In both the cloud report and the dashboard you can open the affected-page list, show all of them when it's long, copy the lot as plain text, and see which URLs were checked this run versus carried over.
- **Agent clients get tool hints over MCP.** Tools now advertise whether they only read, whether they change anything, and whether they touch the outside world, so agents can decide what's safe to call without asking first.

### Fixed

- **Fixed issues clear instead of piling up.** Findings on pages that a later crawl never revisited stayed open indefinitely, and the accumulating warnings kept pushing the health score down. Three causes, all fixed: crawls now seed the frontier with pages that have open carried findings (and stop wasting budget on URLs that are known to be gone), reports over 100 affected pages per check can now resolve pages that were clipped from the published sample, and a page confirmed still failing this run gets a fresh "last seen" stamp instead of looking unconfirmed. On a large site with thousands of stale carried warnings, this is the difference between a score that recovers and one that only ever falls.
- **One health score, not two.** The score in your terminal and the score on the published report could disagree on the same run (84 in one place, 56 in the other). The published score is now authoritative everywhere.
- **A burst of cloud audits no longer wedges dispatch.** Stopped audit containers held onto their instance slots, so five audits in quick succession could block new runs for up to an hour. Containers are now torn down properly when a run ends.
- **Privacy policy pages are found where they actually live.** A `/privacy` page titled "Privacy Policy" and linked from the footer was reported missing. It's detected now.
- **No more phantom Angular on Tailwind sites.** Class names like `tracking-tight` and `leading-relaxed` contain `ng-`, which was enough to report Angular on sites that have never seen it. Detection now requires real framework signals.
- **Cookie-consent checks read the page, not the prose.** A page that merely mentions GDPR or cookies (a privacy policy, for instance) was treated as if it had a consent banner. The check now looks for actual consent machinery.
- **Soft 404s confirm before warning.** A page that briefly served an error shell during the crawl could produce a finding you couldn't reproduce a minute later. Findings are now confirmed before they're reported.
- **Honeypot fields stop failing accessibility.** Hidden anti-spam form fields were reported as focusable hidden content with no useful advice. They're now recognized, downgraded, and told exactly what to add (`tabindex="-1"`).
- **Malformed publish dates are caught.** A raw database timestamp in `datePublished` passed validation silently. Structured-data dates are now validated as real ISO 8601.
- **`squirrel self doctor` stops suggesting you delete your settings.** A permission error reading the user settings file was reported as corruption, complete with a destructive "delete this file" hint. Permission problems are now reported as permission problems.
- **The updater speaks up when it keeps failing.** If background auto-updates fail repeatedly, the CLI now tells you plainly to run `squirrel self update` rather than quietly staying out of date. Commands also wait for a pending update to settle before exiting, so an update in flight isn't cut off mid-write.

### Faster

- **Probe responses stream with a hard size cap.** Checks that fetch supporting files no longer read an entire oversized response into memory before deciding they don't need it, which trims both time and memory on sites with large assets.

## v0.0.76

Big audits publish again, and two false positives are gone. Reports now stay under the publish limit no matter how many pages you crawl, you get warned before starting a cloud audit you can't afford, and a failed publish refunds the whole audit. Plus a new check: soft 404s.

### Added

- **New check: soft 404s.** Pages that return HTTP 200 but actually render "page not found" content (framework error shells, not-found titles) now get flagged. Search engines treat these as thin or duplicate content, and they usually mean a route is silently broken. Detection is conservative: it requires multiple strong signals before flagging, so a short page with an unlucky title won't trip it.
- **Content and legal checks skip error pages.** Rules like cookie consent and content quality no longer judge a page that is really a 404 in disguise. That was the source of phantom "missing GDPR consent" warnings on sites whose error pages leaked into the crawl. Skipped pages are shown as skipped, not silently dropped.
- **Know the cost before you spend.** Cloud audits now estimate their credit cost up front (flat base plus per page) and warn you, or ask for confirmation in a terminal, when your balance won't cover it, instead of burning credits on a run that can't finish the way you wanted.

### Fixed

- **Large reports publish again.** Publishing a big audit (hundreds of pages) could fail with "report exceeds 5MB" even though the real limit is 20MB. Two bugs, both fixed: the error message quoted a stale limit, and site-wide findings embedded every crawled URL, so payload size grew with crawl size. Findings are now sampled (up to 100 pages per finding, with a count of how many more there are), which keeps any report, from 10 pages to thousands, comfortably under the limit. The CLI also checks the size before uploading and trims further instead of failing after the crawl.
- **Cloudflare Turnstile is no longer invisible.** Forms protected by Turnstile (and other CAPTCHAs) using the explicit-render or preloaded loader pattern were flagged as unprotected. The check now recognizes preload hints and empty widget mount points, so protected forms pass.
- **Failed publishes refund the audit.** If your report can't be published because of a size limit or a server error, the entire audit's credits are refunded automatically instead of leaving you charged for a report you never got.

## v0.0.75

Credits stop being a mystery: every audit now shows exactly what it cost and why, and your org gets a full transaction log. Also the first release to arrive on Windows through the repaired self-updater: if you're on 0.0.74, this update installs itself.

### Added

- **See exactly what every audit cost.** Cloud audit reports now include a cost breakdown: the flat audit base, each rendered page, cache hits, and any refunds. It appears on the report page in the dashboard, and agents get it too: `get_report` over MCP includes a cost summary, and a new `list_credit_transactions` tool pages through your org's full credit ledger. There's also a new Transactions view in dashboard settings showing every grant, debit, and refund. If your per-audit cost seems to swing, this is where you see why: only pages whose source changed get re-rendered, so audits right after a deploy render (and bill) more pages than audits of a quiet site.
- **`squirrel feedback` learned categories.** An interactive picker (or the `--category` flag) files your note as a bug report, feature request, praise, confusion, missing data, or tool ergonomics, and records which CLI version it came from. The same categories run through the CLI, MCP, dashboard, and website, so feedback lands in one place no matter where you send it.
- **Delete websites for real.** A new `delete_website` MCP tool (with dashboard support) removes a site and immediately frees the slot against your website cap.
- **Dashboard polish.** Tracked issues can be filtered by how they were found (full crawl vs smart audit), and page-limit settings now show the effective cap when a plan ceiling clamps a custom value.

### Fixed

- **`squirrel self doctor` no longer cries corruption over a permission error.** Running doctor from a directory it can't read (locked-down CI images, restricted shells) misreported healthy settings as corrupt and exited non-zero. Permission problems on the working directory are now reported as exactly that, and the rest of the checkup runs normally.
- **MCP sessions no longer drop when tokens refresh concurrently.** Two clients refreshing the same session at the same time could race and knock each other out; a short reuse window now lets both land on the rotated token.

### Faster

- **Repeat cloud audits skip redundant summary work.** Summaries for pages unchanged since the last run are served from a content-keyed cache instead of being recomputed, so re-audits finish sooner.

## v0.0.74

Pick your rules and skim your results: audits gain include/exclude filters and a summary mode, local dev crawls get dramatically faster, and Windows self-updates stop dying mid-download. Plus a batch of sharp-edge fixes across auth warnings, settings handling, and cloud publishing.

### Added

- **Filter which rules run with `--rule-include` / `--rule-exclude`.** `squirrel audit --rule-include ax,performance` runs only those categories; `--rule-exclude images` skips them. Bare names cover a whole category, `category/rule` targets a single rule. The report is marked partial and the health score recomputes from what ran. Typos, contradictory filters, and `--fail-on` gates against excluded categories all error before crawling instead of wasting a run.
- **`--summary` for a quick score check.** Console output trims to the score, category breakdown, and issue counts with no per-issue detail: handy for CI logs and fast re-checks. Works on `squirrel audit` and `squirrel report`.
- **Localhost audits are much faster.** Plain-HTTP loopback targets (your dev server) automatically skip the polite per-host crawl delay, and new `--concurrency` / `--per-host` flags control parallel fetches. Public sites keep the respectful defaults.

### Fixed

- **Windows self-updates no longer die mid-download.** The background updater ran as a detached child that Windows kills the moment the parent command exits (Job Object semantics), so updates silently never landed. The update now runs in-process with a bounded grace period at exit, and downloads are atomic: a killed update just retries next run.
- **A corrupt or unreadable session file now warns loudly in every command.** Cloud-touching commands explain the session could not be loaded and how to check it, instead of silently running anonymous. When an environment token authenticates the run anyway, the warning is suppressed entirely: no more false "running anonymous" on authenticated CI runs.
- **Settings lookup no longer mistakes permission errors for missing files.** An unreadable parent directory now surfaces a clear error instead of silently skipping your local settings.
- **Windows users get pointed at the right installer.** Running install.sh from Git Bash or MSYS now prints the PowerShell one-liner instead of a dead end.
- **Cloud publish reliability:** oversized robots.txt content is clamped instead of rejecting the whole report, and a timing window where a just-published report's run could still be reaped and refunded is closed.

## v0.0.73

Hosted MCP grows up: sessions renew themselves instead of expiring, connecting shows exactly what you're granting, and agents get a direct feedback channel. Plus a friendlier installer and a stack of cloud reliability fixes.

### Added

- **Hosted MCP sessions no longer expire out from under you.** Connecting over OAuth now issues rotating refresh tokens, so a session renews itself silently instead of going stale and demanding a browser re-consent every 30 days. Any replay of an already-used refresh token revokes the whole session family on the spot.
- **The MCP consent screen shows exactly what you're granting.** Approving a client now lists each permission (run audits, view credits, create API keys) with individual toggles, and the required read access is clearly marked. A client that asks for nothing specific no longer receives a full-access grant by default.
- **Agents can send feedback mid-session.** A new `send_feedback` MCP tool takes a category and a message, optionally tied to a run or website, so an agent can report confusing output or missing data the moment it hits it. Works with read-only credentials.
- **The terminal report now leads with the big picture.** `squirrel audit` output opens with the four top-level group scores as a bar breakdown, and categories are ordered most-severe-first, matching the other report formats.
- **A friendlier install.** The install script greets you with the CLI's own banner and finishes with a numbered get-started guide: first audit, agent skills, cloud login, plus shell completion and `squirrel self doctor` hints.
- **Failed installs can now tell us why.** The install scripts report a failure's platform, step, and a sanitized error line (paths scrubbed, nothing personal) so broken installs get fixed fast. Reporting never blocks or slows an install, and setting `NO_TELEMETRY` disables it, same as the CLI.

### Fixed

- **A cloud audit that wedges mid-run is now failed at its own deadline and refunded.** Stuck running audits were previously reaped by a blanket 75-minute backstop; each run is now judged against its own configured budget, fails promptly with an honest message, and refunds automatically whichever path notices first.
- **Quick audits stay quick.** The post-crawl phase (site metadata, technology detection) now respects the audit's overall time budget instead of adding up to four unbounded minutes to a fast crawl.
- **Rendered audits no longer lose cookies.** A header-handling bug made cloud rendering drop every cookie a site set, breaking pages behind cookie-dependent front-ends and blinding the cookie security rules. All Set-Cookie headers now survive the full render path.
- **CLI settings writes are now atomic.** A crash or full disk mid-write can no longer corrupt `settings.json`; settings are written with owner-only permissions, and a permission problem reading credentials is reported loudly instead of being treated as logged out.
- **Crawls cut short now say so.** A crawl interrupted by the time backstop gets a distinct "stopped" status: its collected pages are still analyzable, and `squirrel report` explains the crawl stopped before finishing instead of leaving an ambiguous state.
- **Max pages per audit now follows your plan on every path.** A couple of API paths could start an audit above the plan's page ceiling or estimate below it; dispatch and pricing now clamp consistently, and a stored setting above your plan's ceiling is honored at the ceiling.
- Publishing a report with an extremely long list of findings on a single check no longer fails the audit; oversized lists are trimmed safely with a note, keeping the rest of the report intact.
- Toggling a website's badge on and off in quick succession now always lands on the state you chose, even when the clicks race.
- When an audit fails because the CLI that started it disconnected, the failure message now says exactly that instead of a generic infrastructure error.

## v0.0.72

Repeat audits get dramatically faster and cheaper: unchanged pages now skip cloud rendering entirely, and rendered pages come back as each one finishes instead of waiting on a whole batch.

### Fixed

- **Repeat audits reuse renders the way they were always meant to.** Two bugs kept the unchanged-page check from ever engaging: sites that send no cache validators never recorded a content fingerprint, and sites whose HTML embeds a millisecond timestamp produced a different fingerprint on every fetch. Both are fixed, so a re-run of an unchanged site now skips rendering, and its per-page render charges, outright. In testing, a repeat audit's crawl phase dropped from minutes to about a second.
- **Rendered pages stream back as each one finishes.** Render results were previously held until an entire batch completed, so one slow page delayed every page behind it. Fresh crawls of render-heavy sites are noticeably faster, helped by quicker render queue pickup and more rendering headroom per browser.
- **A page with an extremely long identifier can no longer fail the whole report.** Publishing rejected a report when a check item's identifier (often a very long data: image URL) exceeded an internal length cap, failing the audit. The CLI and the server now shorten these safely while keeping distinct items distinct.
- **Cloud audits interrupted by infrastructure hiccups now retry themselves.** A cloud audit whose container never started or died mid-run previously failed on the spot. It now gets one automatic redispatch before giving up, with guards that stop a superseded container from ever overwriting the retried run's results. A retry that also fails still refunds automatically.
- Brief platform blips, like a dropped database connection or a rate limiter restarting during a deploy, are retried once instead of surfacing as errors in the dashboard, the API, and the MCP server.
- The dashboard no longer crashes for users browsing with Google Translate or similar extensions that rewrite the page.

## v0.0.71

Agent experience goes deep: a much larger set of rules auditing how AI agents read, reach, and act on your site, plus major crawler and cloud reliability fixes.

### Added

- **The Agent Experience category grows from 4 to 17 rules.** New checks cover agent access (whether GPTBot, Claude-User and friends get the same content as a browser, including bot-challenge and pay-per-crawl detection), content signals and licensing (contradictory bot policies across scopes, noai signals, RSL licenses), agent-facing files (AGENTS.md, llms.txt including lookalike SPA shells, MCP server cards, A2A agent cards and other well-known agent endpoints), API discoverability (OpenAPI, OAuth self-onboarding), and response token weight for agents on a budget. The crawler now probes these agent surfaces on every audit.
- New security rules: subresource integrity on external scripts, and cookie security flags checked against real response headers. The catalog now totals 261 rules across 21 categories.
- Report issues are now ordered by severity in every output format, so the most important findings always come first.
- Failures outside your site's control, like an unreachable third-party link, are now reported as warnings with an expected-failure tag instead of counting against the audit as errors.

### Fixed

- **Cloud audits that stalled mid-crawl and timed out now complete normally.** A crawler concurrency slot could leak when a page fetch failed a certain way, eventually deadlocking the crawl until the run hit its time limit. This was the main cause of recent cloud audit timeouts; affected runs were refunded automatically.
- Crawls stop promptly and cleanly at the page cap instead of letting in-flight work run past it.
- Publishing a report with the full rule catalog could be rejected after the catalog grew past an internal limit. The limit is raised and now guarded by tests so it cannot silently recur.
- Auto and hybrid render modes no longer render pages that were already rendered during the crawl, making rendered audits cheaper.
- Reports now say when a cloud check did not run and why, instead of leaving a silent gap in the results.
- Set-Cookie headers now flow through the whole audit pipeline, so cookie security rules evaluate the real headers your site sends.
- Creating a new site through a cloud audit or the MCP server now respects your account's website limit like every other path.

## v0.0.70

A dashboard and reliability release: clearer audit status, honest failure reporting, and safer invites.

### Fixed

- **Your dashboard issue count and Issues page now agree.** A website card could show a large issue count while the Issues page showed none, because the two read from different places and the issue list could lag behind the latest audit. The Issues page now tells you when a sync is pending and gives you a one-click resync from your most recent report.
- **Website thumbnails no longer hang on "Capturing…".** A screenshot that failed to capture would spin forever and read as a broken empty box on every visit. Captures now report their outcome, so a finished thumbnail appears right away and a failed one falls back to a clean placeholder instead of an endless spinner.
- **Blocked audits read honestly in the dashboard.** When a site's bot protection or firewall blocks the crawler, the report now explains that the site blocked the scan and how to let it through, instead of an unexplained grid of zeros or a misleading "Starting" label.
- **Signed-in audits are tracked reliably and respect your site limit.** An audit started while signed in that failed to register no longer runs silently untracked, and creating a brand-new site through an audit now honors your account's website limit like every other path.
- Audits that fail to start now report the failure and refund any credits reserved for them, closing gaps where an early failure could go unrecorded.
- Repeat audits no longer risk matching a page against a stale content fingerprint, keeping cached-page reuse accurate across runs.
- Organization invite requests made with an API key are now authorized against that key's own organization and scope, not the account that created the key.

## v0.0.69

A reliability hotfix: audits that stalled without producing a report now run normally.

### Fixed

- **Audits that hung and collected no pages now work.** After some upgrades, a project's local database could be left without a column the crawler writes on every page, so each page silently failed to save. The audit then crawled until it hit its time limit without ever producing a report, spending render credits along the way. squirrel now repairs the missing column automatically the next time it opens the project, so affected sites audit normally again. If you saw an audit run for many minutes and then fail with "no pages collected", this is the fix.
- Audits now stop quickly when every page fails to save or fetch, instead of grinding all the way to the crawl time limit. A systematic failure now fails fast with a clear message rather than burning time and credits.

## v0.0.68

A reliability release: accurate reports on large crawls, honest failure reporting, and faster repeat audits.

### Added

- New `--fresh-ua` flag on `audit` and `crawl` to re-roll the browser identity the crawler uses for a project.

### Changed

- The crawler now picks its random browser identity once per project and reuses it on every run. Repeat audits hit the render and analysis caches far more often, making re-runs faster and cheaper.
- JSON reports now include `status` and `statusReason`, so a failed or blocked audit no longer reads as a clean pass to scripts and agents consuming JSON output.

### Fixed

- **Large crawls keep every affected page in the report.** On audits of hundreds of pages, a rule that flagged many of them could have its list of affected pages silently cut off past an internal limit, dropping pages from the published report and skewing the score. Those pages now fold into one accurate finding, so big audits report and score every page they should.
- Quick-coverage audits on paid plans no longer blame a cloud outage for checks that quick mode intentionally skips. The report explains it was a quick scan, shows how to run the full set, and renders the Agents score as locked instead of silently missing.
- Sites behind Cloudflare and similar bot protection that answer with a 503 challenge page are now reported as blocked with actionable advice, instead of a generic "site unreachable".
- Audits started with a bare domain (`squirrel audit example.com`) now reliably appear in your dashboard run history. They ran fine before but could be invisible to run tracking.
- Debug logs print real error details instead of `[object Object]`.
- The `crawl` command docs now describe the `--coverage` flag and the real default page budget.

## v0.0.67

Simpler pricing and faster repeat audits.

### Changed

- **New flat pricing: 50 credits per audit plus 2 credits per rendered page.** Everything else that runs inside an audit is now included: AI content analysis, authority signals, technology detection, the editor summary, site metadata, domain stats, ad-block detection, dead-link checking, and report publishing. Keyword and content gap analyses stay optional add-ons at 25 credits each. A 50-page rendered audit costs exactly 150 credits, and the estimate you confirm up front is the price you pay.
- **Publishing is always free.** Publishing a report at any visibility, including flipping an existing report to public later, never costs credits.
- **Failed audits are refunded automatically.** If an audit fails or is cancelled before delivering a report, its charges are returned, including the base.
- **Audits need a balance of at least 50 credits to start.** Below that, the CLI runs the audit locally, tells you why, and skips cloud features instead of charging you partway.

### Fixed

- **The end-of-audit credits line now matches your ledger.** It is built from the amounts the server actually charged, including the audit base, instead of client-side estimates that could overstate spend.
- **Crawler user agents are modern browsers again.** The random user-agent pool no longer includes decade-old browser versions that bot protection loves to challenge, so crawls of protected sites are far less likely to stall or get served challenge pages.
- **Lower memory use on large audits.** The audit engine now releases parsed pages it is not actively using, cutting the working set on 100+ page runs and avoiding severe slowdowns on memory-pressured machines.

### New

- **Per-phase timing breakdown.** Run with `--debug` to see exactly where audit time goes (crawl, cloud analysis, rules, report). The same breakdown is stored with the run, which makes slow-audit reports much easier to diagnose.
- **Repeat audits are much faster.** Unchanged pages reuse cached rendering and AI analysis server-side. In our testing, re-auditing an unchanged 100-page site dropped from about 40 minutes to about 4.

## v0.0.66

A reliability release: honest reports when a site blocks the crawler, cloud audits back at full power, and you now hear about it when an audit fails.

### Fixed

- **Cloud audits ran without rendering and cloud checks.** Audits triggered from the dashboard were silently locked out of browser rendering, technology detection, and the cloud checks. On sites with bot protection this often meant an empty, failed report. Dashboard audits now run with full capabilities.
- **Blocked sites now say so.** When bot protection, a firewall, an auth wall, or rate limiting refuses the crawler, the report is now marked blocked and explains what happened, with concrete next steps: allowlist the crawler, turn off the blocking rule for the audit, or run the CLI from a trusted network. Previously these audits published an empty report that could read like a clean pass. The agent-facing report formats carry the same signal, so your coding agent knows the audit was blocked instead of concluding your site has no issues.
- **Failed audits no longer show "No issues found."** A report with zero crawled pages renders its failure state instead of a success summary.

### New

- **Audit failure notifications.** When an audit fails, you get a dashboard notification with the reason and a link to the affected website. Failures are also tracked on our side so we can spot problems before you report them.

### Changed

- **robots.txt is no longer enforced by default.** Audits are run by site owners, so `Disallow` rules and `Crawl-delay` no longer apply to your own audit. robots.txt is still fetched and parsed for sitemap discovery and the robots audit rule. Opt back in with `respect_robots = true` in your config; when enforced, `Crawl-delay` is capped at 2 seconds so a slow directive can't stretch an audit into minutes of waiting.

## v0.0.65

The Team plan arrives, plus clearer auth guidance from the local MCP server.

### New

- **Team plan.** Invite teammates into an org at $29/seat/month (2-seat minimum, billed monthly), with a shared pool of 3,000 credits per seat. Assign roles (admin, editor, viewer, billing) and manage seats from Settings → Team in the dashboard.

### Improvements

- **Clearer auth errors from the local MCP server.** Calling an authenticated tool without a session now returns an actionable error naming both fixes: set `SQUIRRELSCAN_API_KEY` for headless and CI use, or run `squirrel auth login` for an interactive session.

## v0.0.64

Four new rules, four score groups on every report, a false-positive cleanup across the rule set, and a hosted MCP server.

### New

- **Four new performance and image rules (249 total).** LCP images without `fetchpriority="high"`, slow web font delivery (`font-display`, preload), hidden carousel slides eagerly loading images, and rendered vs intrinsic image aspect-ratio mismatches.
- **Four score groups.** Every report now rolls categories up into SEO, Performance, Security, and Agents scores, with a redesigned report UI and shareable OG cards to match.
- **Hosted MCP server.** Point any MCP client at `https://mcp.squirrelscan.com` and your agent gets the full toolset with OAuth, no local install. Rule lookups now include a concrete recommendation and a docs link, and audit status reports live progress and a completion reason.
- **New tutorials.** Step-by-step guides for fixing your site with an AI agent, running local audits with the CLI, and going deeper with cloud audits, at [docs.squirrelscan.com/guides](https://docs.squirrelscan.com/guides).

### Fixes

- **Fewer false positives across the rule set.** Service-area businesses without a street address pass LocalBusiness checks, phone matching understands country codes and trunk zeros in `tel:` links, FormShield counts as form protection, license banners no longer flag minified JS, keyword-stuffing ignores stopwords and repeated CTA buttons, sitemap coverage respects the crawl page cap, and hidden carousel slides are no longer told to lazy-load above the fold.
- **Fairer scores.** Category scores weigh how many items each finding affects, so one big issue no longer counts the same as one tiny one.

### Improvements

- **Free cloud audits got the full treatment.** Logged-in free accounts now run the same scan pipeline as Pro, differing only in included credits.

## v0.0.61

Reliability and hardening release — bug fixes across Site Profile, cloud rules, and custom headers, plus a faster, cheaper cloud-audit default.

### Fixes

- **Site Profile capture fixed.** Domain metadata (registrar, domain age, nameservers) captures reliably again — a rule-matching regression that could leave the Site Profile section blank on some audits is resolved.
- **More reliable registrar/age lookups for `.au` and other ccTLD sites.** Domain-fact lookups that were timing out from the cloud now retry with a proper user-agent and log the reason on failure, so Site Profile data shows up more consistently.
- **Custom request headers are validated.** Header values containing control characters (CR, LF, or NUL) are now rejected, closing a header-injection vector on the `-H` / `[crawler] headers` feature added in v0.0.60.
- **Site-metadata cloud rule fixed on Google models.** A schema-compatibility error (HTTP 400) that could make the site-metadata rule fail is resolved.
- **Honest smart re-audit status.** A smart re-audit whose first run crawls zero pages no longer reports itself as "completed" — it surfaces the real state instead.

### Improvements

- **Faster, cheaper cloud audits.** Cloud audits now default to Gemini Flash 3.1, trimming latency and cost on the cloud-backed rules with no change to results.

## v0.0.58

### Fixes

- **Signed-in Pro audits now run the full rule set by default.** A bare `squirrel audit <url>` on a Pro account now defaults to `surface` coverage, so the cloud-backed rules (AI, E-E-A-T, blocking) and the editor's summary run automatically — no need to pass `--coverage surface`. Free and anonymous runs keep the fast `quick` default (no cloud calls). Pass `--coverage` (or set `[crawler] coverage` in `squirrel.toml`) to override either way.
- A Pro audit that can't reach the cloud (transient network blip) no longer silently drops to the smaller `quick` crawl — it keeps the full crawl depth while skipping the unavailable cloud steps.

## v0.0.57

### New Audit Rules — Agent Experience (AX)

Three new rules in the Agent Experience category, focused on how well your site serves AI agents and crawlers (242 rules total):

- **ax/llms-txt** — detects `/llms.txt` (and `/llms-full.txt`) at the domain root and checks its basic Markdown format. An emerging standard that gives AI agents a curated, machine-readable map of your site.
- **ax/markdown-response** — checks whether your site serves `text/markdown` via content negotiation (or exposes a `.md` variant of the homepage). Agents increasingly prefer clean Markdown over rendered HTML.
- **ax/content-without-js** — flags significant main content that only appears in the JS-rendered DOM and is invisible to agents that read raw HTML.

Browse the full rule set → https://docs.squirrelscan.com/rules

### Improvements

- **MCP server** — API-key authentication with scope-gated tools for the local stdio server.
- **Faster cloud rendering** — render submissions are batched and poll loops coalesced for quicker audits.
- **Faster large-site crawls** — URL dispatch and row cleanup are batched to cut overhead on big sites.
- **More accurate domain detection** — refreshed the bundled Public Suffix List snapshot.

### Fixes

- Cloud audits that stall past their deadline are now finalized automatically instead of hanging.
- More efficient handling of error and empty pages during analysis.
