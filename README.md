![squirrelscan](docs/logo/light.svg)

# squirrelscan

**The website QA tool for your coding agent**

squirrelscan is an Open Source cli tool that audits websites for SEO, performance, security, accessibility, agent experience and other issues, and gives your coding agent exact fixes. Run it from the CLI, inside your coding agent, in the cloud, or over MCP.

Combine your coding agent with a deterministic and extensible audit tool.

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://squirrelscan.com/add/cursor)
[![Add to Claude Code](https://img.shields.io/badge/Add_to-Claude_Code-d97757?style=for-the-badge)](https://squirrelscan.com/add/claude)
[![Add to Codex](https://img.shields.io/badge/Add_to-Codex-000000?style=for-the-badge)](https://squirrelscan.com/add/codex)
[![Add to opencode](https://img.shields.io/badge/Add_to-opencode-383838?style=for-the-badge)](https://squirrelscan.com/add/opencode)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-1f6feb?style=for-the-badge)](https://registry.modelcontextprotocol.io)

[![CI](https://img.shields.io/github/actions/workflow/status/squirrelscan/squirrelscan/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/squirrelscan/squirrelscan/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/squirrelscan/squirrelscan/codeql.yml?branch=main&style=for-the-badge&label=CodeQL)](https://github.com/squirrelscan/squirrelscan/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/squirrelscan?style=for-the-badge&label=npm)](https://www.npmjs.com/package/squirrelscan)
[![License: MIT](https://img.shields.io/badge/License-MIT-52a852?style=for-the-badge)](LICENSE)

## Features

- **279 Rules, 21 Categories** - Comprehensive coverage across SEO, accessibility, performance, and security
- **Fast crawler** - Highly optimized memory efficient crawler
- **Agent Experience** - Audit agent experience to assist agents in using your site
- **Security Audit** - Detect phishing kits, leaked credentials, and more
- **Smart Incremental Crawling** - ETag, Last-Modified, content hashing. Resume from checkpoints.
- **Developer-First CLI** - Single binary, zero dependencies, shell completions, self-update
- **Crawl History & Changes** - Track site evolution, compare crawls, spot regressions
- **Multiple Output Formats** - Console, JSON, HTML, Markdown, Text, LLM, XML
- **MCP Connection** - Connect your agent to local or cloud MCP to run audits, fixes, etc.

## Rule categories

Ordered by how much a failure usually costs you, not by how many rules each one has.

| Category | Rules | What it covers |
|----------|-------|----------------|
| Crawlability | 20 | Whether search engines and agents can reach and index you at all: robots.txt, sitemap validity and coverage, indexability conflicts, redirect and canonical chains, soft 404s |
| Core SEO | 14 | The per-page fundamentals: title, meta description, H1, canonical, charset, doctype, robots meta, Open Graph and Twitter cards, plus canonical form drift across the site |
| Agent Experience | 17 | How ready you are for AI agents to read, discover and act on the site: whether GPTBot and Claude-User get the same content a browser does, AGENTS.md, llms.txt, Markdown responses, API and MCP discovery, licensing and noai signals, pay-per-crawl, response token weight |
| Site Integrity | 9 | Signs the site has been compromised: injected doorway pages, phishing kit signatures, obfuscated scripts, brand impersonation, cloaking, known-malicious URLs |
| Security | 16 | Transport and header hygiene: HTTPS and HSTS, CSP, cookie flags, mixed content, subresource integrity, leaked secrets, unprotected and downgraded forms |
| Links | 15 | Internal and external link health: broken and dead links, redirect chains, anchor-text quality, orphan and dead-end pages, pages linked only from sitewide chrome, HTTPS downgrades |
| Content | 18 | Text quality and honesty: duplicate titles and descriptions, title-template consistency, readability, word count, freshness, heading hierarchy, keyword stuffing, hidden text, encoding damage |
| Performance | 30 | Core Web Vitals and delivery: LCP, CLS and INP hints, TTFB, compression, caching, render-blocking resources, DOM size, font delivery, legacy and unminified JS/CSS |
| Images | 15 | Alt text, modern formats, responsive `srcset`, intrinsic dimensions and aspect-ratio mismatches, lazy loading above versus below the fold, file weight |
| Structured Data | 12 | JSON-LD validity and rich-result eligibility for Article, Product, FAQ, Review, Breadcrumb, Organization, LocalBusiness, Video and site search, plus rating markup that is not about the page it sits on |
| Accessibility | 61 | WCAG coverage: ARIA roles and names, form labels and autocomplete tokens, colour contrast, heading order, landmarks, tables and lists, focus visibility, touch targets, captions |
| Mobile | 6 | Viewport configuration, tap-target size, legible font sizes, horizontal scroll, blocked zoom, intrusive interstitials |
| Social Media | 5 | Open Graph and Twitter Card completeness, image dimensions, canonical URL match, social profile links, site-chrome assets that disagree across pages |
| URL Structure | 9 | Length, casing, hyphenation, stop words, query parameters, special characters, trailing-slash consistency, site-wide convention consistency |
| E-E-A-T | 15 | Experience, expertise, authority and trust signals: author bylines and credentials, about and contact pages, citations, editorial policy, disclaimers, YMYL detection |
| Legal Compliance | 4 | Privacy policy, terms of service, real cookie-consent machinery, subprocessor disclosure |
| Internationalization | 2 | hreflang correctness and the document language declaration |
| Local SEO | 3 | NAP (name, address, phone) consistency across every crawled page, geo metadata, service-area businesses |
| Video | 3 | VideoObject markup, captions and accessibility, thumbnails |
| Analytics | 2 | Google Tag Manager presence and consent-mode wiring |
| Blocking | 3 | Content, links and trackers that ad blockers and privacy filters strip for a large share of your visitors |

**Total: 279 rules across 21 categories**

See the [rules reference](https://docs.squirrelscan.com/rules) for full details.

## CLI

### Installation

**macOS / Linux:**
```bash
curl -fsSL https://install.squirrelscan.com | bash
```

**Windows:**
```powershell
iwr -useb https://install.squirrelscan.com/install.ps1 | iex
```

**npm (all platforms):**
```bash
npm install -g squirrelscan
```

**npx (run without installing):**
```bash
npx squirrelscan audit example.com
```

### Quick start

```bash
# Audit a website
squirrel audit example.com

# Generate HTML report
squirrel audit example.com -f html -o report.html

# Pipe to Claude for AI analysis
squirrel audit example.com --format llm | claude

# Quick audit for fast initial probe (other options surface, full)
squirrel audit example.com -C quick

# run only agent experience and performance rules
squirrel audit example.com --rule-include ax,performance

# login for cloud audits and cloud rendering
squirrel auth login
```

## Reports

Category scores for SEO, performance, security and Agent Experience (AX). Publish reports to the web to share with team members or coding agents (fix instructions are embedded)

![squirrelscan report](https://squirrelscan.com/images/html-report-screenshot.webp)

[see an example report](https://reports.squirrelscan.com/01KWKSVT79R6SZDQE7K6WWZCFY)

## Add to your coding agent

squirrelscan ships as an **MCP server** (hosted at `mcp.squirrelscan.com`), **skills** (autonomous audit + fix workflows), and a **plugin** for Claude Code and Cursor. Cursor installs in one click from the badge above; the rest are a single copy-paste.

### Cursor

Click the **Add to Cursor** badge above, or add it manually to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "squirrelscan": { "url": "https://mcp.squirrelscan.com/mcp" }
  }
}
```

Skills: `npx skills add squirrelscan/squirrelscan`

### Claude Code

Install the plugin (bundles skills + the MCP server):

```
/plugin marketplace add squirrelscan/squirrelscan
/plugin install squirrelscan@squirrelscan
```

Or add just the MCP server:

```bash
claude mcp add --transport http squirrelscan https://mcp.squirrelscan.com/mcp
```

### OpenAI Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.squirrelscan]
url = "https://mcp.squirrelscan.com/mcp"
```

Codex reads Agent Skills from `~/.agents/skills`, so skills work too: `npx skills add squirrelscan/squirrelscan`

### opencode

Add the server to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "squirrelscan": {
      "type": "remote",
      "url": "https://mcp.squirrelscan.com/mcp",
      "enabled": true
    }
  }
}
```

### Any MCP client

squirrelscan is in the [MCP Registry](https://registry.modelcontextprotocol.io) as `com.squirrelscan/squirrelscan`. Point any client at the remote server:

```
https://mcp.squirrelscan.com/mcp
```

Authentication is per-user OAuth (or pass a squirrelscan API key as a Bearer token). Skills follow the [Agent Skills standard](https://agentskills.io): `npx skills add squirrelscan/squirrelscan` lands them in `.agents/skills/`.


## Skills

Two skills drive agent workflows:

- **`squirrelscan`** - operating the CLI: install, login, keys, credits, running audits, publishing reports, MCP setup, config, troubleshooting.
- **`audit-website`** - the full fix loop: audit, map issues to source files, fix in batches, re-audit until the site scores well.

```bash
npx skills add squirrelscan/squirrelscan
```

Then, in your agent:

```
Use the audit-website skill to audit this site and fix all issues but only crawl 10 pages
```

## Output formats

| Format | Flag | Use Case |
|--------|------|----------|
| Console | (default) | Human-readable terminal output |
| JSON | `-f json` | CI/CD, programmatic processing |
| HTML | `-f html` | Visual reports for sharing |
| Markdown | `-f markdown` | Documentation, GitHub |
| Text | `-f text` | Clean output for piping to LLMs |
| LLM | `-f llm` | LLM optimized output |
| XML | `-f xml` | XML output |

## Source and development

The complete local CLI, crawler, audit engine, rules, report generators, CLI-facing cloud clients, and documentation site are open source in this repository. The hosted API, website, dashboard, and cloud worker implementations are separate private services.

Prerequisites: [Bun 1.3.14](https://bun.sh/) and Git.

```bash
git clone https://github.com/squirrelscan/squirrelscan.git
cd squirrelscan
bun install --frozen-lockfile
bun run dev -- audit https://example.com --max-pages 10
```

Run the same checks used in pull requests:

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run docs:check
bun run docs:build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Contributions require a Developer Certificate of Origin sign-off (`git commit -s`).

## Telemetry

Telemetry is enabled by default and is deliberately minimal: event name, CLI version, a random install ID, and bounded error categories. It does not send credentials, URLs, report contents, or raw error messages, and telemetry requests are never authenticated.

Disable it permanently with:

```bash
squirrel self settings set telemetry false
```

Or disable all telemetry and install registration for any invocation by defining `NO_TELEMETRY`. Any defined value works, including an empty value, `0`, or `false`:

```bash
NO_TELEMETRY=1 squirrel audit https://example.com
```

## Links

- [Website](https://squirrelscan.com)
- [Documentation](https://docs.squirrelscan.com)
- [Coding agent integration](https://docs.squirrelscan.com/agents)
- [Share feedback](https://squirrelscan.com/feedback)
- [Bugs, issues and feature requests](https://github.com/squirrelscan/squirrelscan/issues)
- [Twitter/X](https://x.com/squirrelscan_)

## License

The CLI and the repository contents are licensed under the [MIT License](LICENSE). squirrelscan names and logos are covered by [TRADEMARKS.md](TRADEMARKS.md).
