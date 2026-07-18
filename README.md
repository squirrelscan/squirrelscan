![squirrelscan](https://mintcdn.com/squirrelscan/CCMTmLbI4xfnpJbQ/logo/light.svg?fit=max&auto=format&n=CCMTmLbI4xfnpJbQ&q=85&s=1303484a4ea3c154c29dd5f6245e55cd)

# squirrelscan

**The website QA tool for your coding agent**

squirrelscan audits your website for SEO, performance, security, accessibility and agent experience issues, and gives your coding agent exact fixes. Run it from the CLI, inside your coding agent, in the cloud, or over MCP. Local audits are always free.

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=squirrelscan&config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLnNxdWlycmVsc2Nhbi5jb20vbWNwIn0=)
[![Add to Claude Code](https://img.shields.io/badge/Add%20to-Claude%20Code-d97757)](https://docs.squirrelscan.com/agents)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-000000)](https://registry.modelcontextprotocol.io)

## Add to your coding agent

squirrelscan ships as **skills** (autonomous audit + fix workflows), an **MCP server** (hosted at `mcp.squirrelscan.com`), and a **plugin** for Claude Code and Cursor. Pick your agent:

### Cursor

One click: the **Add to Cursor** badge above, or add the MCP server manually to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "squirrelscan": { "type": "http", "url": "https://mcp.squirrelscan.com/mcp" }
  }
}
```

Skills install with `npx skills add squirrelscan/squirrelscan`.

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

### Any MCP client

squirrelscan is in the [MCP Registry](https://registry.modelcontextprotocol.io) as `com.squirrelscan/squirrelscan`. Point any client at the remote server:

```
https://mcp.squirrelscan.com/mcp
```

Authentication is per-user OAuth (or pass a squirrelscan API key as a Bearer token).

### OpenAI Codex / other agents

Skills follow the [Agent Skills standard](https://agentskills.io). Install with `npx skills add squirrelscan/squirrelscan` (lands in `.agents/skills/`), or clone this repo and symlink the `skills/*` directories.

## Features

- **260+ Rules, 21 Categories** - Comprehensive coverage across SEO, accessibility, performance, and security
- **AI-Native Design** - LLM-optimised output for Claude Code, Cursor, and any AI assistant
- **Smart Incremental Crawling** - ETag, Last-Modified, content hashing. Resume from checkpoints.
- **Developer-First CLI** - Single binary, zero dependencies, shell completions, self-update
- **E-E-A-T Auditing** - Dedicated rules for Experience, Expertise, Authority, Trust
- **Crawl History & Changes** - Track site evolution, compare crawls, spot regressions
- **Multiple Output Formats** - Console, JSON, HTML, Markdown, Text, LLM, XML

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

### Quick Start

```bash
# Audit a website
squirrel audit https://example.com

# Generate HTML report
squirrel audit https://example.com -f html -o report.html

# Pipe to Claude for AI analysis
squirrel audit https://example.com --format llm | claude

# Limit pages for faster results
squirrel audit https://example.com -m 10
```

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

## Rule Categories

| Category | Rules | Focus |
|----------|-------|-------|
| Accessibility | 59 | ARIA, button/input names, landmarks, lists, tables, focus |
| Performance | 29 | Core Web Vitals, compression, caching, JS optimization |
| Crawlability | 17 | Robots.txt, sitemaps, indexability |
| Agent Experience | 17 | How ready a site is for AI agents to read, discover, operate |
| Security | 16 | HTTPS, CSP, cookies, leaked secrets |
| Images | 15 | Alt text, formats, lazy loading, optimization |
| E-E-A-T | 15 | Authority, trust, expertise signals |
| Links | 14 | Broken links, redirects, anchor text |
| Core SEO | 13 | Meta tags, canonical, doctype, charset |
| Content | 12 | Readability, freshness, word count |
| Structured Data | 10 | JSON-LD, schema validation |
| Site Integrity | 9 | Injected pages, phishing kits, malware, SEO spam |
| URL Structure | 8 | Length, format, parameters |
| Mobile | 6 | Viewport, tap targets, responsive |
| Social Media | 4 | Open Graph, Twitter Cards |
| Legal Compliance | 4 | Privacy policy, cookie consent |
| Video | 3 | Schema, captions, thumbnails |
| Local SEO | 3 | NAP, geo tags, service areas |
| Blocking | 3 | Content, links, trackers that ad/privacy blockers block |
| Internationalization | 2 | Hreflang, lang attribute |
| Analytics | 2 | GTM, consent mode |

**Total: 261 rules across 21 categories**

See the [rules reference](https://docs.squirrelscan.com/rules) for full details.

## Output Formats

| Format | Flag | Use Case |
|--------|------|----------|
| Console | (default) | Human-readable terminal output |
| JSON | `-f json` | CI/CD, programmatic processing |
| HTML | `-f html` | Visual reports for sharing |
| Markdown | `-f markdown` | Documentation, GitHub |
| Text | `-f text` | Clean output for piping to LLMs |
| LLM | `-f llm` | LLM optimized output |

## Development Status

squirrelscan is in **active beta**. Expect rapid iteration and breaking changes. Feedback and issue reports welcome!

## Links

- [Website](https://squirrelscan.com)
- [Documentation](https://docs.squirrelscan.com)
- [AI Agent Integration](https://docs.squirrelscan.com/agents)
- [Share Feedback](https://squirrelscan.com/feedback)
- [Bugs, Issues & Feature Requests](https://github.com/squirrelscan/squirrelscan/issues)
- [Twitter/X](https://x.com/squirrelscan_)

## License

The skills, plugin manifests, MCP configuration, and install scripts in this repository are MIT licensed (see [LICENSE](LICENSE)). The squirrelscan CLI binary itself is distributed as a standalone executable and is not open source.
