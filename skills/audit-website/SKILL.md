---
name: audit-website
description: Audit a website with the squirrelscan CLI and fix the findings in code. Runs SEO, performance, security, technical, content, accessibility, and 15 other rule categories (260+ rules), returns an LLM-optimized report, then drives an iterative fix loop, mapping issues to source files, applying fixes, and re-auditing until the site scores well. Use to discover and assess website or webapp issues and drive them to fixed.
license: See LICENSE file in repository root
compatibility: Requires squirrel CLI installed and accessible in PATH
metadata:
  author: squirrelscan
  version: "2.0"
allowed-tools: Bash(squirrel:*) Read Edit Grep Glob
---

# Audit a Website and Fix It

Run a squirrelscan audit against a website, read the LLM report, map each issue to the code or content that causes it, fix in batches, and re-audit until the score target is met.

Requires the `squirrel` CLI ([squirrelscan.com/download](https://squirrelscan.com/download); verify with `squirrel --version`). For CLI setup, login, publishing, MCP, and general CLI usage, use the companion `squirrelscan` skill.

## Rule docs

Look up any rule at `https://docs.squirrelscan.com/rules/{rule_category}/{rule_id}`, for example:

https://docs.squirrelscan.com/rules/links/external-links

## Running the audit

```bash
squirrel audit https://example.com --format llm
```

- ALWAYS use `--format llm`: it is compact, exhaustive, and made for agents.
- If the user doesn't provide a URL, ask which site to audit.
- PREFER auditing the live site: only there do you see true rendering, performance, and redirect behavior. If both a local dev server and a live site exist, suggest the live one; apply the fixes to the local code either way.
- Audits are cached locally. Re-render later without recrawling: `squirrel report <audit-id> --format llm`.

### Scan progression

1. **First pass, quick coverage** (the default): a fast, shallow scan to learn the site's structure, technology, and biggest problems without impacting the site.
2. **Second pass, deeper coverage**: `-C surface` (one page per URL pattern) for template-level coverage, or `-C full` for a comprehensive crawl before sign-off.

| Mode | Default pages | Use |
|------|---------------|-----|
| `quick` | 25 | First look, CI checks |
| `surface` | 100 | Template-level coverage (one sample per pattern like `/blog/{slug}`) |
| `full` | 500 | Final verification, deep analysis |

Useful flags: `--refresh` (ignore cache, full re-fetch), `--resume` (continue an interrupted crawl), `-m <n>` (page cap), `--verbose` (progress detail).

If the site blocks unknown crawlers (Shopify / Cloudflare), pass Web Bot Auth headers with repeated `-H "Name: Value"` flags. Header values are secrets and are redacted in output. See https://docs.squirrelscan.com/guides/web-bot-auth

## The fix loop

1. **Present the report**: score, grade, top issues by severity.
2. **Propose fixes**: list the issues you can fix and confirm with the user before changing anything.
3. **Map issues to source**: find the template, component, or content file behind each finding.
4. **Fix in batches**: apply the approved fixes; use subagents to parallelize independent files.
5. **Re-audit** (use `--refresh` after deploys or content changes) and show before/after scores.
6. **Repeat** until the target is met or only judgment calls remain (for example "should this link be removed?"). Flag those for user review instead of guessing.

After each batch, verify the project still builds and existing checks pass.

### Score targets

| Starting score | Target | Expected work |
|----------------|--------|---------------|
| < 50 (F) | 75+ (C) | Major fixes |
| 50-70 (D) | 85+ (B) | Moderate fixes |
| 70-85 (C) | 90+ (A) | Polish |
| > 85 (B+) | 95+ | Fine-tuning |

A site is only considered COMPLETE and FIXED when it scores 95+ (Grade A) with `--coverage full`.

### Issue categories and fix approach

| Category | Fix approach | Parallelizable |
|----------|--------------|----------------|
| Meta tags / titles / descriptions | Edit page components or metadata config | No |
| Structured data | Add JSON-LD to page templates | No |
| Missing H1 / heading hierarchy | Edit page components + content files | Yes (content) |
| Image alt text | Edit content files | Yes |
| Short meta descriptions | Extend frontmatter descriptions | Yes |
| HTTP to HTTPS links | Find and replace in content | Yes |
| Broken links | Manual review, flag for user | No |

Rules carry a level (error, warning, notice) and a rank (1-10): fix errors first, then high-rank warnings. Code changes and content changes are equally important; treat them the same.

### Parallelizing with subagents

- Ask the user first: always confirm which fixes to apply before spawning subagents.
- Group 3-5 files per subagent for the same fix type; only parallelize independent files (no shared components or config).
- Spawn the subagents in a single message so they run concurrently.

## Verifying regressions

Compare against a baseline to prove improvement or catch regressions:

```bash
squirrel report --diff <baseline-audit-id> --format llm
squirrel report --regression-since example.com --format llm
```

## Completion

Done means: all errors fixed; warnings fixed or documented as needing human review; a re-audit confirms the improvement; and the user has seen the before/after score comparison plus a summary of every change made. Re-audit regularly to keep the site healthy. If the user wants to share results, offer a published report (see the `squirrelscan` skill).

## Report format

The LLM report is a compact XML/text hybrid optimized for token efficiency: summary with health score, issues grouped by category with affected URLs, broken links, and prioritized recommendations. Full spec: [OUTPUT-FORMAT.md](references/OUTPUT-FORMAT.md)
