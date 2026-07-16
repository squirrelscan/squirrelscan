![squirrelscan](https://mintcdn.com/squirrelscan/CCMTmLbI4xfnpJbQ/logo/light.svg?fit=max&auto=format&n=CCMTmLbI4xfnpJbQ&q=85&s=1303484a4ea3c154c29dd5f6245e55cd)

# squirrelscan

**The website QA tool for your coding agent**

squirrelscan audits your website for SEO, performance, security, accessibility and agent experience issues, and gives your coding agent exact fixes. Run it from the CLI, inside your coding agent, in the cloud, or over MCP. Local audits are always free.

## Features

- **260+ Rules, 21 Categories** - Comprehensive coverage across SEO, accessibility, performance, and security
- **AI-Native Design** - LLM-optimised output for Claude Code, Cursor, and any AI assistant
- **Smart Incremental Crawling** - ETag, Last-Modified, content hashing. Resume from checkpoints.
- **Developer-First CLI** - Single binary, zero dependencies, shell completions, self-update
- **E-E-A-T Auditing** - Dedicated rules for Experience, Expertise, Authority, Trust
- **Crawl History & Changes** - Track site evolution, compare crawls, spot regressions
- **Multiple Output Formats** - Console, JSON, HTML, Markdown, Text, LLM, XML

## Three Ways to Use

### 1. CLI for Humans

Run audits directly in your terminal:

```bash
squirrel audit example.com
```

### 2. AI Coding Agent Skill

Install the skill for autonomous workflows:

```bash
npx skills install squirrelscan/skills
```

Use the slash command:

```
/audit-website
```

Or prompt your AI agent more specifically:

```
Use the audit-website skill to audit this site and fix all issues but only crawl 10 pages
```

More information [in the skills repository](https://github.com/squirrelscan/skills) and our [Getting started with AI Agents](https://docs.squirrelscan.com/agents) documentation.

### 3. Pipe to AI agent

Pipe clean output to any AI assistant:

```bash
squirrel audit example.com --format llm | claude
```


## Installation

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

## Quick Start

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

## Resources

- **Website:** [squirrelscan.com](https://squirrelscan.com)
- **Documentation:** [docs.squirrelscan.com](https://docs.squirrelscan.com)
- **AI Agent Skills:** [github.com/squirrelscan/skills](https://github.com/squirrelscan/skills)

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

## AI Agent Integration

squirrelscan is designed for autonomous AI workflows:

```bash
# Install the skill for Claude Code, Cursor, etc.
npx skills install squirrelscan/skills
```

Example AI prompts:
- "Audit example.com and fix all critical issues"
- "Check for SEO regressions after my recent changes"
- "Generate a comprehensive audit report and enter plan mode to fix issues"
- "Audit only the /blog section and focus on E-E-A-T signals"
- "Run a security-focused audit and check for leaked secrets"

See [AI Agent Integration docs](https://docs.squirrelscan.com/agents) for advanced workflows.

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
- [AI Agent Skills](https://github.com/squirrelscan/skills)
- [Share Feedback](https://squirrelscan.com/feedback)
- [Bugs, Issues & Feature Requests](https://github.com/squirrelscan/squirrelscan/issues)
- [Twitter/X](https://x.com/squirrelscan_)
