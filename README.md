![squirrelscan](https://mintcdn.com/squirrelscan/CCMTmLbI4xfnpJbQ/logo/light.svg?fit=max&auto=format&n=CCMTmLbI4xfnpJbQ&q=85&s=1303484a4ea3c154c29dd5f6245e55cd)

# squirrelscan

**Website audit tool built for your coding agent**

Free CLI for SEO, performance & security audits. Built for Claude Code, Cursor, and AI workflows. 150+ rules, LLM-optimized reports, single binary install.

## Features

- **150+ Rules, 20 Categories** - Comprehensive coverage across SEO, accessibility, performance, and security
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
curl -fsSL https://squirrelscan.com/install | bash
```

**Windows:**
```powershell
iwr -useb https://squirrelscan.com/install.ps1 | iex
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
| Crawlability | 16 | Robots.txt, sitemaps, indexability |
| E-E-A-T | 15 | Authority, trust, expertise signals |
| Links | 14 | Broken links, redirects, anchor text |
| Security | 14 | HTTPS, CSP, leaked secrets (96 patterns) |
| Content | 13 | Readability, freshness, word count |
| Accessibility | 13 | ARIA, contrast, landmarks, focus |
| Core SEO | 12 | Meta tags, canonical, robots |
| Images | 12 | Alt text, formats, lazy loading |
| Performance | 12 | Core Web Vitals, render blocking |
| Structured Data | 11 | JSON-LD, schema validation |
| URL Structure | 9 | Length, format, parameters |
| Mobile | 7 | Viewport, tap targets, responsive |
| Social Media | 5 | Open Graph, Twitter Cards |
| Local SEO | 4 | NAP, geo tags, service areas |
| Legal | 4 | Privacy policy, cookie consent |
| Video | 4 | Schema, captions, thumbnails |
| Analytics | 3 | GTM, consent mode |
| Internationalization | 3 | Hreflang, lang attribute |
| Adblock Detection | 3 | Blocked elements, tracking |

**Total: 153 rules across 20 categories**

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
