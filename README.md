![squirrelscan](https://mintcdn.com/squirrelscan/CCMTmLbI4xfnpJbQ/logo/light.svg?fit=max&auto=format&n=CCMTmLbI4xfnpJbQ&q=85&s=1303484a4ea3c154c29dd5f6245e55cd)

# squirrelscan

**CLI Website Audits for Humans, Agents & LLMs**

[squirrelscan](https://squirrelscan.com) is a comprehensive website audit tool for SEO, performance, accessibility, content, and more. Built from the ground up for AI coding agents and developer workflows.

## Features

- **149+ Audit Rules** across 20 categories (SEO, accessibility, performance, security, E-E-A-T)
- **AI-Native Design** with LLM-optimized output formats for Claude Code, Cursor, and other agents
- **Smart Incremental Crawling** with ETag, Last-Modified, and content hashing
- **Multiple Output Formats** including console, JSON, HTML reports, and text for piping to LLMs
- **Single Binary** with zero dependencies
- **Shell Completions** for bash, zsh, fish
- **Self-Updating** with built-in version management

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

**npm (all platforms):**
```bash
npm install -g squirrelscan
```

Or run without installing:
```bash
npx squirrelscan audit example.com
```

**macOS / Linux:**
```bash
curl -fsSL https://squirrelscan.com/install | bash
```

**Windows:**
```powershell
iwr -useb https://squirrelscan.com/install.ps1 | iex
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

| Category | Examples |
|----------|----------|
| **Core SEO** | Meta tags, canonical URLs, h1, robots meta |
| **Accessibility** | ARIA labels, focus indicators, landmarks |
| **Performance** | Core Web Vitals (LCP, CLS, INP) |
| **Security** | HTTPS, CSP, leaked secrets (96 patterns) |
| **E-E-A-T** | Author bylines, expertise signals, trust indicators |
| **Content** | Word count, readability, freshness |
| **Images** | Alt text, modern formats, lazy loading |
| **Links** | Broken links, redirect chains, anchor text |
| **Schema** | JSON-LD structured data validation |
| **Mobile** | Viewport, tap targets, responsive design |

And 10 more categories covering video, analytics, i18n, local SEO, and more. See the [rules reference](https://docs.squirrelscan.com/rules) on the documentation website.

## AI Agent Integration

squirrelscan is designed for autonomous AI workflows:

```bash
# Install the skill for Claude Code, Cursor, etc.
npx skills install squirrelscan/skills
```

Example AI prompts:
- "Use the audit-website skill to audit example.com and fix all high-severity issues"
- "Audit this site, enter plan mode, and create a comprehensive fix strategy"
- "Use audit-website skill to check for regressions after my recent changes"

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
