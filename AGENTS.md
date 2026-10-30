# AGENTS.md

How to work on this repository: written for coding agents (Claude Code, Codex, Cursor, opencode and the rest) and for the people steering them. [CONTRIBUTING.md](CONTRIBUTING.md) is the short version for humans. If the two disagree, CI is right; please fix whichever file is stale.

Does your tool read `CLAUDE.md` instead of `AGENTS.md`? Create a local `CLAUDE.md` with the single line `@AGENTS.md`. `.gitignore` keeps `CLAUDE.md`, `MEMORY.md`, `.claude/`, `.cursor/` and similar agent files out of commits, so personal notes stay on your machine. This file is the one tracked exception.

## What this is

squirrelscan is **the website QA tool for your coding agent**. It audits websites for SEO, performance, security, accessibility and agent experience (AX) issues, and gives your coding agent exact fixes. This repository is the open source (MIT) part: the `squirrel` CLI, the crawler, the audit engine, 300+ audit rules, the report renderers and the docs at [docs.squirrelscan.com](https://docs.squirrelscan.com). The CLI ships as a Bun standalone executable.

Naming: the product is `squirrelscan`, always lowercase, and the binary is `squirrel`. Say "audit rules", not "SEO rules". The term is "agent experience (AX)", never "agent readiness" or "AI readiness".

## Repository layout

| Path | What lives there |
|---|---|
| `apps/cli` | The `squirrel` CLI: citty commands in `src/cli/commands`, the local MCP server in `src/mcp`, self-management (`squirrel self ...`) in `src/self` |
| `packages/audit-engine` | Audit orchestration, scoring and composition. Its `tests/` hold the golden suite |
| `packages/crawler` | Crawler, frontier and crawl storage |
| `packages/fetchers` | Document fetching, redirect chains, decoding limits |
| `packages/parser` | HTML parsing and extractors. `src/dom.ts` is the only linkedom entry point |
| `packages/rules` | The audit rules, one folder per category, plus the loader, filter and runner |
| `packages/report` | Report types, grouping and every output format (text, JSON, LLM, markdown, XML, HTML) |
| `packages/config` | The `squirrel.toml` schema and adapters |
| `packages/core-contracts` | Shared types, audit levels and `REPORT_LIMITS` |
| `packages/utils` | Shared helpers (URLs, safe fetch, non-public hosts) and shared constants |
| `packages/tech-detect`, `waf-detect`, `threat-intel` | Technology fingerprints, WAF and challenge-page detection, opt-in threat intel |
| `packages/synthetic-site` | The deterministic synthetic website the golden tests crawl |
| `packages/api-client`, `cloud-client` | The CLI's HTTP clients for the squirrelscan API |
| `docs/` | The docs site (tangly, MDX), a root workspace member |
| `scripts/` | Release, CI path classifier, test suite split, third-party notices |
| `npm/`, `install.sh`, `install.ps1` | The npm wrapper package and the installers |

Dependencies point one way: `apps/cli` uses `audit-engine`, which uses `rules`, which uses `parser`, `utils` and `core-contracts`. Packages never import from `apps/`, and `rules` never imports `audit-engine`.

## Setup

Use Bun 1.4.4. `packageManager` in `package.json` and `.github/actions/setup-bun` pin it. A different local Bun can fail tests that pass in CI, or the reverse, so check `bun --version` before chasing a failure only you can see.

```bash
bun install --frozen-lockfile
bun run dev -- audit https://example.com --max-pages 10   # the CLI from source
bun run build                                             # writes apps/cli/build/squirrelscan
```

The root install covers `docs/` too.

### Run the CLI without touching your real ~/.squirrel

An audit writes to `~/.squirrel`, and retention (`[storage] keep_audits`) retires older audits stored there. Local settings and `squirrel.toml` are found by walking up from the current directory to the home directory. For a throwaway run, give the process a scratch home and a working directory inside it:

```bash
scratch=$(mktemp -d) && mkdir -p "$scratch/home/work" && cd "$scratch/home/work"
HOME="$scratch/home" bun run /path/to/squirrelscan/apps/cli/src/cli.ts audit https://example.com --max-pages 3 --offline
```

Set `HOME` on the command line: Bun reads the home directory once at startup, so changing `process.env.HOME` later moves nothing. `--offline` skips cloud features, publishing and telemetry. The entry point is `apps/cli/src/cli.ts`.

## Code standards

- TypeScript only, `strict`, ES modules. Type exports and module boundaries precisely; avoid `any`.
- Prefer Bun APIs where they fit (`Bun.file`, `Bun.Glob`, `Bun.spawnSync`).
- File names are kebab-case (`rule-budget.ts`). Tests are `*.test.ts` in the package's `tests/` directory.
- `oxfmt` formats, `oxlint` lints (ultracite presets), `tsgo` from `@typescript/native-preview` typechecks.
- Shared constants go in `packages/utils/src/constants.ts`, CLI-only ones in `apps/cli/src/constants.ts`.
- Comments explain why, not what. Keep diffs scoped: no drive-by refactors and no reformatting of lines you did not change.

## Checks before you push

CI (`.github/workflows/ci.yml`) runs these on every pull request. Run the ones your change touches, from inside the package:

| Area | Format | Lint | Typecheck |
|---|---|---|---|
| `apps/cli`, `packages/synthetic-site` | `bun run format:check` | `bun run lint` | `bun run typecheck` |
| `packages/report` | none | `bun run lint` (runs `build:css:check`) | `bun run typecheck` |
| Other `packages/*` | not in CI, see below | not in CI, see below | `bun run typecheck` |

From the root, `bun run format:check`, `bun run lint` and `bun run typecheck` fan out to every workspace that defines the script. For `docs/`, run `bun run docs:check` from the root (or `make validate` in `docs/`).

- Package `tsconfig.json` files include only `src/`, so `typecheck` never sees `packages/*/tests`. `apps/cli` does include its tests.
- After `bun run format`, confirm with `bun run format:check` and read its exit code. The last line ("Finished in ...") prints even when issues were found above it.
- Other `packages/*` are not formatted or linted by CI, and many existing files there do not match the formatter. Check only the files you changed, from the repository root, with repo-relative paths (both tools reject a path containing `..`):

```bash
./apps/cli/node_modules/.bin/oxfmt --check packages/rules/src/mobile/my-rule.ts
./apps/cli/node_modules/.bin/oxlint -c apps/cli/oxlint.config.mjs packages/rules/src/mobile/my-rule.ts
```

Write mode (no `--check`) is fine for a new file. On an existing file it reflows lines you never touched, which is churn. Do not run `bunx oxfmt` from the root: there is no local binary there, so it fetches the latest release, which formats differently from the pinned one.

## Tests

The runner is `bun:test`. Pass explicit paths, prefixed with `./`:

```bash
bun test ./packages/rules/tests/empty-heading.test.ts ./packages/rules/tests/rule-verdict-scope.test.ts
```

A bare argument is a substring filter: `bun test report` runs every file with "report" anywhere in its path. A bare `bun test` at the root runs every test file in the repo, about 400 of them. To run exactly what a CI step runs:

```bash
bun run scripts/test-suites.ts --list         # report, rules, rest, cli, crawler, audit-engine
bun run scripts/test-suites.ts --run rules
bun run test:engine                           # the audit-engine golden suite
```

`bun run test` covers `apps/cli` only.

Conventions and traps:

- **Rule tests** build a `RuleContext` from `parsePage(html, url)` and call `rule.run(ctx)`. `packages/rules/tests/empty-heading.test.ts` is a compact example.
- **Prove a test bites.** Revert the fix, watch the test fail, restore it. A test that passes either way is worse than none.
- **Fixture hosts** are `example.com` or its subdomains. `localhost`, `.local`, `.internal`, `.test`, `.example`, `.invalid`, `.home`, `.onion`, `.alt` and similar zones are non-public in `packages/utils/src/non-public-host.ts`, so they take different code paths.
- **Engine tests that should run real rules** pass `rules: { enable: ["*"] }`. The filter (`packages/rules/src/filter.ts`) defaults every rule to off, so `rules: {}` runs nothing and a parity test then compares empty with empty.
- **CLI tests that drive a command or open a store** call `isolateSquirrelHome("<name>")` at the top level (`apps/cli/tests/helpers/scratch-squirrel-home.ts`). `apps/cli/tests/squirrel-home-guard.test.ts` fails any test file that skips it, so run that guard too when you add one.
- **`mock.module` is process-wide** and outlives the file. Prefer `spyOn` restored in `afterAll`. If you must mock a module, spread the real one (`{ ...real, fn }`) so files loaded later still link every export. A file that fails only alongside others, or only alone, is usually this.
- **Bun's per-test timeout is 5 seconds.** A test that times out only under load usually has a fixture doing far more work than the assertion needs. Shrink the fixture rather than raising the timeout.
- **`golden-baseline.test.ts` is memory heavy.** For the pinned rule counts, run `./packages/audit-engine/tests/streaming-rules-canonical-golden.test.ts` on its own.
- **linkedom dedupes class tokens**: `class="x x x y"` reads back as `"x y"`. Build long class lists for bound tests from distinct tokens.
- **Local fixture audits**: signed out, the default `quick` level crawls the seed URL and the sitemap only. Serve a `/sitemap.xml` listing every fixture page, and check the page count before reading results. External link checks skip paths that look like actions (`looksLikeAnAction` in `packages/utils/src/link-actions.ts`), so link fixtures need plain-word paths with no ids.

## Adding a rule

1. **Write it** in `packages/rules/src/<category>/<name>.ts`, exporting a `Rule` with `meta` and `run(ctx)`. Copy a neighbour such as `src/mobile/viewport-zoom.ts`. The folder is not always the id prefix: `src/performance/` holds the `perf/*` rules.
   - `meta`: `id` (`<category>/<name>`), `name`, `description`, `solution`, `category`, `scope` (`"page"` or `"site"`), `severity`, `weight` (1 to 10), and an optional zod `optionsSchema`.
   - A page rule declares `verdictScope`. Use `"page"` unless the verdict provably depends only on the shared page template: `"template"` lets the engine copy one verdict to every page in a template cluster. Site rules declare none.
2. **Register it** in the `rules` array of `src/<category>/index.ts`. The loader reads those arrays, not the files.
3. **Record its measurement.** Add a new page rule's id to `varyingRules` in both corpora of `packages/rules/tests/fixtures/template-invariance-measured.json`, keeping each array sorted. Only a rule measured constant on both corpora may sit in `constantRules`.
4. **Test it** in `packages/rules/tests/<name>.test.ts`: pass, fail and skip cases, plus every false-positive shape you can think of.
5. **Document it.**
   - Write `docs/rules/<rule id>.mdx`; the path must equal the id. Copy a sibling page, including its ``| **Rule ID** | `<id>` |`` row.
   - Add the page to `docs/docs.json` and add a row to `docs/rules/<category>/index.mdx`.
   - Bump the category's "(N rules)" in `docs/rules/index.mdx` and in its score group page (`docs/rules/{seo,performance,security,agents}/index.mdx`).
   - Rounded totals ("300+", `PUBLIC_RULE_COUNT_FLOOR`) are rounded down to a multiple of 50 on purpose and change only when the live count crosses the next one. Do update the "currently N enabled rules" comment beside the floor in `packages/utils/src/constants.ts`.
6. **Move the golden pins.** Run `bun test ./packages/audit-engine/tests/streaming-rules-canonical-golden.test.ts`.
   - The finding messages are pinned too: after a change to a rule's message or fix text, run `UPDATE_GOLDEN=1 bun test packages/audit-engine/tests/golden-finding-messages-229.test.ts` and review the diff of the snapshot.
   - `perRuleTally.length` goes up by one per new rule id.
   - `findings.length` goes up by one per fixture page (500) for a page rule that always emits a check, by one for a site rule, and not at all for a rule whose precondition the synthetic site never meets.
   - Extend the running comment above each number with your rule.
   - `healthScore.overall` should not move. If it does, the rule is firing on the synthetic site's real copy, which is probably a false positive.
7. **Run the registry-wide tests**, which a single rule test never exercises:

   ```bash
   bun test ./packages/rules/tests/rule-verdict-scope.test.ts ./packages/rules/tests/template-verdict-inputs.test.ts ./packages/rules/tests/template-verdict-page-independence.test.ts ./packages/rules/tests/meta-string-limits.test.ts ./packages/rules/tests/max-rules-limit.test.ts
   bun test ./packages/rules/tests/docs-rule-pages.test.ts ./packages/rules/tests/docs-category-table.test.ts
   ```

   `meta-string-limits` caps meta strings at the published report's limits. `max-rules-limit` keeps 25 rules of headroom under `REPORT_LIMITS.maxRules` in `packages/core-contracts/src/limits.ts`; if it trips, raise the cap in the same PR.
8. **Add a CHANGELOG bullet** under `## [Unreleased]`, in `### Added`.
9. **Smoke-test an accusatory rule on real pages.** For a rule that accuses a website of something (hidden text, spam, broken markup), fetch about 25 well-known websites, run `rule.run()` over `parsePage(html, url)` and read every non-pass. Unit fixtures only encode the false positives you already thought of. Report the residual honestly instead of tuning it to zero.

A new category is a bigger change (loader namespace, `RuleCategory`, docs hub, the configuration table, scoring group). Open an issue first.

**Changing a rule**: extending a rule must never add a `perRuleTally` key. When a `"template"` rule starts reading a new input, `template-verdict-inputs.test.ts` fails until someone reviews that read against the fan-out key. Re-derive the docs page from the new `run()`.

## Adding or changing a CLI command

- A command lives in `apps/cli/src/cli/commands/<name>.ts` (citty `defineCommand`). Register it in `subCommands` in `apps/cli/src/cli/index.ts` as a lazy `import()`. A static import would load the audit engine and every rule on every invocation.
- Project-scoped commands sit at the top level (`audit`, `init`, `config`, `report`). Commands about the binary itself go under `squirrel self` (`install`, `update`, `completion`, `doctor`, `version` and so on).
- Shell completions are hand-written, because citty does not generate them. Update `apps/cli/src/self/completion.ts` for every new command, flag and format value, then run `bun test ./apps/cli/tests/self/completion.test.ts`. That test slices each bash block up to the next case arm (`BASH_BLOCK_END`, `KEYS_REGION_END`). A command inserted between two arms makes the earlier one fail with a flag it never offered: move the entry, never widen it.
- Document it in `docs/cli/<command>.mdx` and `docs/docs.json`. The Tools table in `docs/cli/mcp.mdx` must list exactly what the MCP server returns (`apps/cli/tests/mcp/docs-sync.test.ts`).
- Changing the header art in `apps/cli/src/cli/brand.ts`? Run `bun run scripts/sync-install-header.ts` to re-render the copies in the installers.
- Before pushing, run `bun run scripts/test-suites.ts --run cli`.

## Reports

`packages/report` renders every output format. The HTML report's stylesheet is generated by Tailwind from the tokens found in `src/output/html.tsx` and `src/output/page/ui/`, and `packages/report/scripts/build-css.ts` writes it to `src/output/page/styles.generated.ts`. Any new utility class, even one that only appears in a comment or string, changes the CSS inlined into every report.

- Reuse classes that already exist, then run `bun run build:css:check` in `packages/report`. It is the package's `lint` script, so CI runs it.
- When the HTML or CSS output really changes, run `bun run build:css` and bump `REPORT_HTML_VERSION` in `packages/report/src/constants.ts`. Rendered HTML is cached under that version, so the bump makes stored reports render again.
- Escape at the renderer, for every format, even when the writer already sanitized the value. Reports stored by older versions reach the same renderer.

## Docs

`docs/` is the user reference, deployed to docs.squirrelscan.com from `main`. Coding agents and the squirrelscan agent skill link to it, so a user-facing change updates the docs in the same PR.

- Validate with `bun run docs:check` from the root (the same as `make validate` in `docs/`). CONTRIBUTING.md lists what each part of it fails on.
- House style is in `.github/DOCS_STYLE.md`: sentence-case headings, no em-dashes, and one term per concept ("coding agent", "website", "audit", "report", "issue").
- On rule pages, derive every claim from the rule's `run()`. `meta.solution` and `meta.description` are prose that drifts from the code. Quote message templates with placeholders (`N`, `<path>`), never invented filled-in examples.
- A rule with `meta.disabled: true` is never loaded, so no config can enable it. Do not document it as opt-in.
- Glossary and hub content between `{/* glossary:...:start */}` or `{/* hub:...:start */}` markers is generated. Edit `docs/scripts/glossary/*.json` and run `bun scripts/glossary.ts --write` in `docs/`.

## Untrusted input

Every byte the crawler fetches is chosen by the website under audit, and some websites are hostile or just enormous. Treat HTML, CSS, headers, robots.txt, sitemaps, JSON-LD and URLs as attacker input in the crawler, the parser, the rules and the report.

**Regexes over site text**

- Bound every quantifier that can run over site text (`[^>]{0,1024}`, `\S{1,256}`), or scan with `indexOf`. A greedy `[^x]+` before a literal is quadratic, and so are two adjacent quantifiers over the same class: `\d*\.?\d+` takes seconds on a long digit run, `\d+(?:\.\d+)?|\.\d+` does not.
- The rule time budget (`runWithinBudget` in `packages/rules/src/rule-budget.ts`) cannot interrupt a regex: the timeout fires only after the match returns. Every regex needs its own bound.
- A ReDoS test repeats the trigger, not the filler: `"[ ".repeat(n)`, not `"[" + "a".repeat(n)`. Scale the input 4x and check the time grows about 4x, since superlinear growth is the signal. Prefer asserting an effect (a capped input still returns) over asserting elapsed time.

**DOM work (linkedom)**

- Parse through `parsePage` or `parseHTML` from `@squirrelscan/parser/dom`, never from `linkedom` directly (type-only imports are fine). `dom.ts` makes attribute lookups ASCII case-insensitive, as in a browser, and `packages/parser/tests/attribute-case.test.ts` fails any other runtime import of linkedom.
- `el.matches()` costs more the longer the selector, on every call, and `closest()` with a descendant selector that matches nothing is quadratic in tree depth. Where code runs page-supplied selectors or walks ancestors, cap selector length and element depth, memoise per element, and add a time deadline next to any call budget.
- `document.body`, `document.head` and `document.title` throw when a document has no root element (an empty body, whitespace, a PDF served as HTML). `document.body ?? fallback` does not help, because the read itself throws. Wrap it in try/catch.
- Every rule on a page shares one `ctx.parsed.document`. Never mutate it (`remove()`, `setAttribute`, `innerHTML =`). For text with exclusions, use `collectTextExcluding` from `@squirrelscan/parser/extractors`.
- Rules that judge words a visitor reads use `getRenderedProseText` (`packages/rules/src/content/text-content.ts`). A plain `textContent` walk reads `<template>` markup and glues `<td>a</td><td>b</td>` into one token.

**Links**

`parsePage` and the engine extract links differently. `extractLinks` in `packages/parser/src/html.ts` (used by `parsePage`, exported as `extractLinksBasic`) skips every `#...` href and keeps invalid ones with an `error`. `extractLinks` in `packages/parser/src/extractors/links.ts` (the package's main export, used by the engine's `parseHtmlForRules`) skips only a bare `#`, keeps `#foo` and drops invalid URLs. Rule tests built on `parsePage` exercise the first; real audits run the second. When pairing DOM anchors with `ctx.parsed.links`, mirror the engine's filters and test `#`, `#foo` and an absolute URL.

**Objects built from site data**

- Accumulate site-controlled keys into `Object.create(null)`, never a plain `{}`. `out["__proto__"] = v` repoints the prototype, and a string value silently disappears. When walking into or merging onto an object you did not create, skip keys with `isUnsafeObjectKey` (`packages/core-contracts/src/untrusted-keys.ts`).
- Build prototype-pollution fixtures with `JSON.parse('{"__proto__": {"polluted": 1}}')`. An object literal `{ __proto__: ... }` sets the prototype instead, so the test passes with or without the fix. Assert on `Object.prototype`, not on the result.

**Strings and URLs**

- Clamp site-derived strings at each boundary: length, and bytes where the limit counts bytes. `packages/core-contracts/src/clamp.ts` has helpers.
- Before printing a URL the website chose, canonicalize it with `new URL(v).href` (http and https only). That IDNA-encodes the host and percent-encodes control and bidi characters. Then escape for the output format. `canonicalizeReportUrl` in `packages/report/src/coverage.ts` is the pattern.
- Build composite keys from site strings with `JSON.stringify([a, b])`, not a delimiter, which can appear inside a site value.
- Write non-ASCII whitespace and format characters as code points or `\u` escapes. A raw literal is invisible in review.

**Outbound requests**

- Fetching a URL taken from page content (a redirect `Location`, robots.txt `Sitemap:`, a `Link` header, a meta refresh) goes through `safeRedirectFetch` or `isHttpOrHttpsUrl` in `packages/utils/src/safe-fetch.ts`, which allow `http:` and `https:` only.
- Do not block private or loopback hosts in shared crawler or engine code, and do not use `isPublicHttpUrl` there. The CLI audits localhost, staging and intranet websites on purpose.

**Long synchronous work** starves every `setTimeout`-based deadline. Loops over pages yield with `await new Promise((r) => setTimeout(r, 0))` on a time budget, as `packages/audit-engine/src/page-rule-executor.ts` does.

Report a suspected vulnerability privately, as [SECURITY.md](SECURITY.md) describes.

## Commits and pull requests

- Branch from `origin/main`, one topic per PR. Open an issue before a large architectural change.
- Commit messages follow `type(scope): message`, and the scope is required. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`. Reference the issue: `fix(rules): skip hidden headings in a11y/empty-heading #123`.
- Sign off every commit with `git commit -s`. The DCO check compares the `Signed-off-by` line with the commit's author or committer identity exactly. Forgot on a whole branch? Run `git rebase --signoff origin/main`, then `git push --force-with-lease`.
- No attribution trailers or footers in commits or PR text: no `Co-Authored-By` for a tool, no "Generated with", no session links.
- A user-visible change gets a bullet under `## [Unreleased]` in `CHANGELOG.md`, in the matching `### Added`, `### Changed`, `### Fixed`, `### Security` or `### Docs` block. Write it for users and end it with the issue reference, `(#123)`. Contributor-only changes (tests, CI, this file) need none.
- On a CHANGELOG rebase conflict, start from main's file and re-add only your bullets, then check that `git diff origin/main -- CHANGELOG.md` shows only your lines. If a release renamed `[Unreleased]` while your branch was open, move your bullet into the new `[Unreleased]`.
- The PR description says what changed and why, lists the commands you ran, and ends with one line on follow-ups: `Docs: <pages updated, or none>. Skill: <change needed in squirrelscan/skills, or none>.`
- Never commit secrets, customer data or hostnames from someone else's audit. Use `example.com`.
- PRs target `main`, and CI runs only for PRs into `main`: a PR stacked on another branch gets no checks. There is no auto-merge. A maintainer merges, and `main` requires the branch to be up to date first.

## CI checks that fail for non-obvious reasons

- **Secret scan** runs `detect-secrets` 1.5.0 over every tracked file against `.secrets.baseline`. The baseline stores line numbers, so editing a file it lists can fail with "The baseline file was updated". Run the scan locally, `git add .secrets.baseline`, and repeat until it exits 0. Do it last, right before you push:

  ```bash
  pip install detect-secrets==1.5.0
  git ls-files -z | xargs -0 detect-secrets-hook --baseline .secrets.baseline
  ```

  A fake credential in a test needs `// pragma: allowlist secret` on its line, and so does an identifier as innocent as `API_KEY_ENV`. Make placeholder ids low-entropy (`01TEST0000000000000000000A`): a random-looking one can trip the entropy check. GitHub push protection is a separate gate that rejects some realistic token shapes at push time. Build those from parts (`${prefix}rest`).
- **CodeQL** judges test files by production rules. A URL literal passed to `.includes()` or `.startsWith()` trips the URL-sanitization check, so use `expect(x).toContain(url)`. A new host-shaped regex (`/cdn\.example\.com/`) needs an anchor or context such as `src\s*=\s*["']`. A single `.replace("&", ...)` counts as incomplete escaping: use `replaceAll`.
- **Dependency audit** runs `bun audit` against the live advisory database, so it can go red with no change on your side. If `git diff origin/main...HEAD -- bun.lock package.json` is empty, say so on the PR and leave it to maintainers.
- **Third-party notices**: bumping a runtime dependency of the CLI changes `THIRD_PARTY_NOTICES.md` and `npm/THIRD_PARTY_NOTICES.md`. Run `bun run notices:generate`, commit both, and confirm with `bun run notices:check`.
- **Test wiring**: `bun run scripts/test-suites.ts --check` fails when a test file falls outside every suite, or two suites claim it.

## Issues and questions

- Bugs and ideas go to [github.com/squirrelscan/squirrelscan/issues](https://github.com/squirrelscan/squirrelscan/issues). Every issue carries a `## Acceptance Criteria` checklist of observable outcomes. Maintainers add one at triage when it is missing.
- Security reports go through a private advisory: see [SECURITY.md](SECURITY.md).
- From the CLI, `squirrel feedback` reaches the maintainers.
