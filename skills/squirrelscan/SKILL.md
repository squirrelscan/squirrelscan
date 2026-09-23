---
name: squirrelscan
description: "squirrelscan audits websites for SEO, performance, security, accessibility, content, and structured data issues (260+ rules) and scores site health, via the squirrel CLI. Use when the user wants to check, audit, or improve a website's SEO, ranking, speed, or health, and for anything squirrelscan itself, installing or updating the CLI, login and API keys, running audits, publishing and sharing reports, cloud credits, MCP server setup, configuration, or troubleshooting. Also covers the entity map: the site-wide graph of the entities a site declares in its JSON-LD, and fixing structured data identity problems such as an organization declared separately on every page."
license: See LICENSE file in repository root
compatibility: Requires squirrel CLI installed and accessible in PATH (or guides the user to install it)
metadata:
  author: squirrelscan
  version: "1.4.1"
allowed-tools: Bash(squirrel:*) Read
---

# squirrelscan CLI

squirrelscan is a website audit tool built for AI agents. It answers "what's wrong with this website and how do I fix it": it crawls a site like a search engine, analyzes every page against 260+ rules in 21 categories (SEO, performance, security, accessibility, content, structured data, agent experience, and more), and returns a health score plus concrete, fixable issues. Use it whenever a user wants their site checked, ranked better, faster, or healthier, before/after a deploy, or in CI.

It ships as a single CLI binary, `squirrel`, for macOS, Windows, and Linux. This skill covers operating it: installing, authenticating, running audits, publishing reports, cloud features, and MCP integration. For the full fix-the-website workflow (audit, map issues to code, fix, re-audit), use the companion `audit-website` skill.

## Links

- Website: [squirrelscan.com](https://squirrelscan.com)
- Docs: [docs.squirrelscan.com](https://docs.squirrelscan.com)
- Rule reference: `https://docs.squirrelscan.com/rules/{rule_category}/{rule_id}`
- Dashboard (cloud account, audit history, credits): [app.squirrelscan.com](https://app.squirrelscan.com)

## Install

Download and install instructions: [squirrelscan.com/download](https://squirrelscan.com/download)

The binary installs to `~/.local/bin/squirrel`. Verify with:

```bash
squirrel --version
```

Keep it current:

```bash
squirrel self update
```

If `squirrel` is not found, ensure `~/.local/bin` is in PATH, or reinstall from the download page.

## Command overview

| Command | Purpose |
|---------|---------|
| `squirrel audit <url>` | Crawl + analyze + report in one step |
| `squirrel crawl <url>` | Crawl only (no analysis) |
| `squirrel analyze` | Run audit rules on a stored crawl |
| `squirrel report [id]` | Query, render, diff, and publish stored reports |
| `squirrel entities` | Query the site's structured-data entity graph; filter, export, diff |
| `squirrel init` | Create `squirrel.toml` project config |
| `squirrel config` | Show or edit configuration |
| `squirrel auth` | login / logout / status / whoami |
| `squirrel keys` | Mint, list, revoke org API keys |
| `squirrel credits` | Cloud credit balance + feature pricing |
| `squirrel mcp` | Run the local MCP server (stdio) |
| `squirrel skills` | Install or update agent skills |
| `squirrel self` | install / update / doctor / disk / completion / version / settings / uninstall |
| `squirrel feedback` | Send feedback to the squirrelscan team |

Every command supports `--help`.

## Quickstart

```bash
squirrel init -n my-project        # optional: project config in cwd
squirrel audit https://example.com --format llm
```

- Local audits are free and run entirely on your machine. No account needed.
- Use `--format llm` when an agent is reading the output: it is a compact, token-optimized format built for LLMs.
- Audits are cached in a local project database; `squirrel report` re-renders without re-crawling.

### Coverage modes

| Mode | Default pages | Behavior |
|------|---------------|----------|
| `quick` (default) | 25 | Seed + sitemaps only, fast health check |
| `surface` | 100 | One sample per URL pattern (`/blog/{slug}` crawled once) |
| `full` | 500 | Crawl everything up to the limit |

```bash
squirrel audit https://example.com -C full -m 500 --format llm
```

## Authentication and accounts

Local audits never require an account. Sign in to unlock cloud features (publishing, browser rendering, scheduled crawls, credits):

```bash
squirrel auth login      # browser-based login
squirrel auth status     # source, scopes, active org
squirrel auth whoami
squirrel auth logout
```

Headless / CI environments use an org API key instead:

```bash
squirrel keys create     # requires a login session; prints an sq_... key
```

Set it as `SQUIRRELSCAN_API_KEY` in the environment. Treat keys as secrets; never commit them.

## Reports

Render the latest (or a specific) stored audit:

```bash
squirrel report --list                 # recent audits
squirrel report <audit-id> --format llm
squirrel report example.com --format markdown -o report.md
```

Formats: `console`, `text`, `json`, `html`, `markdown`, `xml`, `llm`. Filter with `--severity error` or `--category core,links`.

### Publishing

Signed-in audits publish a shareable report to reports.squirrelscan.com by default (visibility: unlisted). Control it:

```bash
squirrel report <audit-id> --publish --visibility unlisted   # public | unlisted | private
squirrel audit https://example.com --no-publish              # skip publishing for a run
squirrel audit https://example.com --offline                 # fully offline: no cloud, no publish, no telemetry
```

### Regression diffs

```bash
squirrel report --diff <baseline-audit-id> --format llm
squirrel report --regression-since example.com --format llm
```

Diff mode supports `console`, `text`, `json`, `llm`, and `markdown`.

## Structured data: the entity map

Every audit collapses the site's JSON-LD into one graph of the entities it declares, rather than a list of the blocks it emits. A report's Entities section carries it: an interactive graph in `html`, a table in `markdown` and `text`, the whole document under `entities` in `json`, and an `<entities>` block in `llm` and `xml`.

This catches what a per-page validator cannot. Sixty valid `Organization` blocks with no `@id` are sixty organizations to a search engine, and nothing accumulates: not the reviews, not the profile links, not the authority.

```bash
squirrel entities                              # summary of the latest audit
squirrel entities --list                       # stored audits and their entity counts
squirrel entities "https://example.com/#org"   # one entity, by @id, key or name
squirrel entities --problem no-id              # the entities worth fixing
squirrel entities --problem split-identity     # one thing declared twice
squirrel entities -f jsonld -o graph.json      # export
squirrel entities --diff                       # what changed since the previous audit
```

Filters: `--type`, `--page`, `--problem` (repeatable or comma-separated), `--crawl <id>`, `--input <file>`. Formats: `json`, `jsonld`, `html`, `markdown`, `csv`, `dot`, `graphml`, `mermaid`. `--diff` takes `markdown` or `json`.

Problems: `no-id`, `conflict`, `dangling`, `single-page`, `split-identity`.

**When a `schema/entity-*` finding appears, read `references/entity-map-fixes.md`.** It has the shape that works and the exact change for Yoast, Rank Math, WordLift, Next.js, Astro and tangly.

### Proving a fix landed

`squirrel entities --diff` after re-auditing. An entity that gains an `@id` **changes key**, because the key is the `@id` when there is one, so a naive comparison reports it as one removal plus one addition and the fix reads as damage. The `gainedId` section is what says it landed.

Two things to check before calling it done:

- **`coverage`** on each `gainedId` row: `proven` means the newer audit visited every page that declared the broken version *and* found the replacement on all of them. `partial` means one of those could not be established, so re-audit the same scope as the first run.
- **`notCrawled`** should be empty. An entity listed there was not removed; its pages simply were not visited again.

A missing `gainedId` row is not proof of failure: the match needs the type and name unchanged, so changing the `@id` and the name in one edit shows up as a removal plus an addition instead.

Docs: https://docs.squirrelscan.com/entity-map

## Cloud features and credits

Cloud features are pay-as-you-go with credits (nothing charged up front). Check balance and pricing:

```bash
squirrel credits
```

- `--render` / `--render-mode auto|all|off`: cloud browser rendering for client-rendered pages (uses credits, requires login).
- `--yes` skips spend confirmations up to the configured per-audit credit cap.
- `--fail-on "score<90"` (repeatable) makes CI runs exit non-zero when a threshold trips.
- The dashboard at [app.squirrelscan.com](https://app.squirrelscan.com) shows audit history, issues, and credit usage.

## MCP server

Two ways to connect agents over MCP:

- **Local (stdio)**: `squirrel mcp` runs against the local CLI. Register it in your agent's MCP config with command `squirrel` and args `["mcp"]`.
- **Hosted (streamable-http)**: `https://mcp.squirrelscan.com/mcp`. Sign in via OAuth from the MCP client, or send an `Authorization: Bearer sq_...` API key header.

### Entity tools

Five tools expose the entity map over MCP, on both servers with the same names and inputs. On the local server they read the project store, so they need no account and spend no credits.

| Tool | Answers |
|---|---|
| `list_entities` | What does this site declare? Filter by `type`, `page`, `problem`, `q`; page with `limit`/`offset`. |
| `get_entity` | Why was this one flagged? Properties, declaring pages, conflicting values, references in and out. |
| `get_entity_graph` | The graph as `json`, `jsonld`, `mermaid`, `dot`, `graphml` or `markdown`. |
| `compare_entities` | What changed between two audits, and did a fix land? |
| `get_entity_findings` | The `schema/entity-*` verdicts for an audit, with the fix text. |

The loop these are built for, and the reason to prefer them over re-deriving anything by hand:

1. `list_entities` with `problem: "no-id"` finds entities declared on several pages with nothing tying them together.
2. Fix them (see `references/entity-map-fixes.md`).
3. Re-audit: `run_audit`, or `squirrel audit`.
4. `compare_entities` and check `gainedId` for the keys you fixed, each with `coverage: "proven"`.

Read the fields that say what you are not being told, rather than inferring from an empty result:

- **`truncation`**: whether a list was capped. A capped list and a complete one look identical otherwise.
- **`warnings`**: whether a newer audit was passed over for storing no entities, or a project store could not be read. This is how you avoid describing yesterday's healthy graph as today's.
- **`analyzed`** on `get_entity_findings`: false means the rules never ran, so empty findings are an absence of evidence, not a clean result.
- **`generatedIds`** on a `jsonld` graph: the `@id`s the export invented for entities the site left anonymous. They are not on the site.

Docs: https://docs.squirrelscan.com/developers/mcp

### Agent feedback

Call the `send_feedback` tool any time something in a session surprises you. It takes `category`, `message`, and optional `run_id`/`website_id`. Pick the category that fits:

- `bug_report`: a defect in squirrelscan itself, such as a wrong or missing rule result, a crash, or a broken tool. Include the site, rule id, and what you expected.
- `feature_request`: something squirrelscan should do but doesn't.
- `what_worked`: something worked well and you want the team to know.
- `confusing`: a response or behavior was unclear.
- `missing_data`: a report or tool response lacked something you needed.
- `tool_ergonomics`: awkward tool shape, arguments, or naming.
- `other`: anything else.

Feedback lands directly in the team's review queue with your org attached. It works with any authenticated credentials, including read-only API keys, and is available on the hosted MCP surface now (not yet on `squirrel mcp` local stdio). Use it instead of `squirrel feedback` when you're an agent reporting mid-session; humans can use `squirrel feedback` or [squirrelscan.com/support](https://squirrelscan.com/support).

## Configuration

Project config lives in `squirrel.toml` (created by `squirrel init`). User settings live at `~/.squirrel/settings.json`.

```bash
squirrel config show
squirrel config set <key> <value>
squirrel config path
squirrel config validate
```

Useful sections: `[crawler]` (delays, headers, incremental re-crawl), `[cloud]` (render mode, max credits per audit).

### Custom request headers

Attach headers to every crawl request with the repeatable `-H "Name: Value"` flag or a `headers` map under `[crawler]`. The main use case is Web Bot Auth (Shopify / Cloudflare), so platforms that block unknown crawlers can authorize squirrelscan. Header values are secrets: squirrelscan redacts them in output, and you should source them from a secret store rather than committing them. Full recipe: https://docs.squirrelscan.com/guides/web-bot-auth

## Maintenance

```bash
squirrel self doctor       # health checks
squirrel self update       # update the binary
squirrel self completion   # shell completions
squirrel skills update     # update installed agent skills
squirrel self disk         # per-project and total ~/.squirrel disk use
```

### Reclaiming disk space

Every audit keeps its full history in the project database, so re-auditing the same site grows `~/.squirrel` by roughly one audit each run (a 1,000-page site is about 95 MB per audit). `squirrel self disk` shows where the space is. `--prune` retires the audits beyond the newest `--keep` and rebuilds the database so the space returns to the filesystem:

```bash
squirrel self disk --prune --keep 3 --dry-run   # list what would go, delete nothing
squirrel self disk --prune --keep 3             # prints the plan, asks, then retires
squirrel self disk --prune --keep 3 --project my-project --yes
```

- `--keep <n>` is required: a retired audit's report can no longer be rendered, and `report --list`, `--diff` and `--regression-since` reach into that history, so the window is the user's call. Ask before choosing it for them.
- Retiring keeps everything the next audit reads (newest page record per URL, sub-resources, links, images), so an incremental re-crawl still gets its `ETag`s and does not refetch the site.
- Audits never prune on their own. Requires squirrel 0.0.92 or later; on older versions run `squirrel self update` first.

## Troubleshooting

- **`squirrel: command not found`**: install from [squirrelscan.com/download](https://squirrelscan.com/download) and ensure `~/.local/bin` is in PATH.
- **Session expired / 401**: run `squirrel auth login` again, or check `SQUIRRELSCAN_API_KEY`.
- **Slow or stuck crawl**: add `--verbose` to see progress; large sites can take minutes.
- **Invalid URL**: include the protocol: `https://example.com`, not `example.com`.
- **Anything else**: run `squirrel self doctor`, then report it: agents via the `send_feedback` MCP tool (`bug_report` category), humans via `squirrel feedback` or [squirrelscan.com/support](https://squirrelscan.com/support).
