# SquirrelScan

CLI SEO audit tool for developers. Analyzes websites for technical SEO issues.

## Features

- **Meta Tag Validation** - Title, description, canonical, robots
- **OpenGraph & Twitter Cards** - Social media tag validation
- **Structured Data** - JSON-LD validation and schema type detection
- **Link Checking** - Internal and external broken link detection
- **Image Analysis** - Alt text, dimensions, format detection
- **Content Analysis** - Word count, thin content detection
- **Security Checks** - HTTPS, mixed content, security headers
- **Core Web Vitals Hints** - Preload, preconnect, lazy loading
- **Health Score** - Overall 0-100 site health scoring

## Installation

```bash
bun install
```

## Usage

### Basic Audit

```bash
# Development
bun run dev audit https://example.com

# Or use the standalone binary
./build/squirrelscan audit https://example.com
```

### Commands

| Command                    | Description                        |
| -------------------------- | ---------------------------------- |
| `audit <url>`              | Run SEO audit on a URL             |
| `init`                     | Create squirrel.toml               |
| `config show`              | Show current configuration         |
| `config set <key> <value>` | Set config value                   |
| `report <file>`            | Convert/view existing JSON reports |

### Audit Options

| Option                | Description                      |
| --------------------- | -------------------------------- |
| `-m, --maxPages`      | Max pages to crawl (default: 50) |
| `-f, --format`        | Output: console, json, html      |
| `-o, --output`        | Output file path                 |
| `-e, --checkExternal` | Check external links             |
| `-d, --deep`          | Enable all extended checks       |
| `-v, --verbose`       | Verbose logging                  |
| `--debug`             | Enable debug logging             |
| `-k, --keyword`       | Track keyword presence           |
| `--llm`               | Enable LLM content analysis      |

### Crawler Configuration (squirrel.toml)

```toml
[crawler]
max_pages = 50
delay_ms = 100
timeout_ms = 30000
concurrency = 5
per_host_concurrency = 5
per_host_delay_ms = 50
follow_redirects = true
respect_robots = false
user_agent = ""
include = []
exclude = []
allow_query_params = []
```

### Crawler Behavior Notes

- robots.txt is always fetched (sitemap discovery + the `crawl/robots-txt` rule need it), but `Disallow`/`Crawl-delay` are only enforced when `respect_robots = true` (default `false` — audits are site-owner initiated). Crawl-delay is capped at 2s even then.
- URL normalization strips fragments, normalizes trailing slashes, and drops tracking query params.
- Scope defaults to the base host unless `include` patterns are configured.
- SQLite storage uses WAL mode and a 15s busy timeout. Avoid running multiple `crawl`, `audit`, `analyze`, or `report` commands in parallel against the same workspace/project database.

### Examples

```bash
# Quick audit of 10 pages
squirrelscan audit https://example.com -m 10

# Full audit with HTML report
squirrelscan audit https://example.com -f html -o report.html

# Deep audit with all checks
squirrelscan audit https://example.com -d

# Create config file
squirrelscan init

# View config
squirrelscan config show
```

## Building

```bash
# Build for current platform
bun run build

# Build for all platforms
bun run build:all
```

## Project Structure

```
src/
├── cli.ts              # Main entrypoint
├── cli/
│   └── commands/       # CLI commands (audit, init, config, report)
├── audit/              # Workflow orchestration, scoring, report
├── crawl/              # Robots + sitemap discovery
├── crawler/            # Frontier, scheduler, fetcher, parser pipeline
├── infra/              # Context, errors, retry, queue
├── parse/              # DOM parsing + extractors
├── rules/              # SEO rules organized by domain
│   ├── seo/            # Meta, OG, robots, sitemap, hreflang, url
│   ├── content/        # Content analysis
│   ├── links/          # Link checking, redirects
│   ├── images/         # Image validation
│   ├── schema/         # JSON-LD validation
│   ├── security/       # Security checks
│   └── performance/    # CWV hints
├── self/               # Self-update/install tooling
├── tools/              # Network + LLM helpers
└── utils/              # Shared helpers
```
