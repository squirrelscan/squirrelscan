# Docs style

House style for `README.md` and everything under `docs/`. Borrowed selectively from ASD-STE100 Simplified Technical English: we take its terminology discipline and sentence limits, not its approved-word dictionary, because our docs are marketing surface as well as reference and the brand voice is deliberately informal.

## Project dictionary

One term per concept. The right-hand column is not "worse phrasing", it is wrong: pick the left.

| Concept | Use | Not |
|---|---|---|
| The user's own agent, the one reading our output and editing their code | **coding agent** | AI agent, AI coding assistant, coding assistant, AI assistant |
| Third-party crawlers that fetch the site (GPTBot, Claude-User, PerplexityBot) | **AI crawler**, or name it | AI agent, bot |
| Authenticating to the cloud | **log in**, logged in, logged out | sign in, signed in, sign-in |
| The property being audited | **website** | site, except in fixed names (`sitemap`, Site Integrity) |
| One execution of the tool | **audit** (noun and verb) | scan, run (as a noun) |
| The artifact an audit produces | **report** | results, output (when you mean the report) |
| A single thing an audit found | **issue** | problem, finding, defect |
| The paid hosted surface | **cloud** | hosted, except "hosted MCP server" |

`squirrel` is the CLI binary. `squirrelscan` is the product, always lowercase, never SquirrelScan.

## Headings

Sentence case. "Rule categories", not "Rule Categories". Proper names keep their capitals: "Core SEO", "Agent Experience", "Claude Code".

Prefer a noun phrase or an imperative to a gerund: "Use with coding agents" beats "Using with coding agents".

## Sentences

- Descriptive sentences: 25 words or fewer.
- Procedural sentences: 20 words or fewer.
- One instruction per sentence.
- Active voice. Imperative for anything the reader performs.
- Paragraphs: 6 sentences or fewer.

The rule-category tables are the standing exception: those cells are deliberately dense enumerations, and splitting them into sentences would break the table.

## Warnings

A caution goes **before** the command it qualifies, never after. A reader who copy-pastes has already run the command by the time they reach a trailing warning.

```mdx
<Warning>A filtered audit produces a partial report.</Warning>

```bash
squirrel audit https://example.com --rule-include ax,performance
```
```

## Punctuation

No em-dashes anywhere in public copy. Use a colon, a comma, or a full stop. This predates this document and still holds.

Prefer "and" to "&" outside proper names.

## What we deliberately do not adopt from STE

- The ~900-word approved dictionary. Our domain vocabulary (crawl, render, canonical, hreflang, viewport) would all need registering as technical names, for no gain.
- The ban on humor and figurative language. The mascot stays.
- The ban on `-ing` forms outside technical names, except in headings, where we apply it because it reads better.
