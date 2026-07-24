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
- A `## [Unreleased]` heading also ends a section (keep-a-changelog style); it's never extracted as a release body.
- If no matching section exists, the release still ships with a minimal body — you can
  refine it any time with `gh release edit "vX.Y.Z" --repo squirrelscan/squirrelscan --notes-file notes.md`.
- Keep it public-facing: user-visible CLI/rules/reliability changes only — no internal refs.

Earlier releases (v0.0.56 and prior) are on the
[GitHub releases page](https://github.com/squirrelscan/squirrelscan/releases).

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
