---
name: audit-website
description: Audit a website with SquirrelScan and fix the findings in code. Runs SEO, performance, security, technical, content, accessibility, and 15 other rule categories (260+ rules), returns an LLM-optimized report, and supports stored-audit entity-map investigation through MCP before an iterative fix loop.
license: See LICENSE file in repository root
compatibility: Requires the squirrel CLI installed and accessible in PATH, or a connected SquirrelScan MCP server for stored-audit entity-map work
metadata:
  author: squirrelscan
  version: "2.2"
allowed-tools: Bash(squirrel:*) Read Edit Grep Glob
---

# Audit a Website and Fix It

Run a squirrelscan audit or inspect a stored MCP audit, map each issue to the code or content that causes it, fix in batches, and re-audit until the score target is met.

Use the installed `squirrel` CLI ([squirrelscan.com/download](https://squirrelscan.com/download); verify with `squirrel --version`) to run audits, or a connected SquirrelScan MCP server to inspect stored audits. For CLI setup, login, publishing, MCP, and general CLI usage, use the companion `squirrelscan` skill.

## Rule docs

Look up any rule at `https://docs.squirrelscan.com/rules/{rule_category}/{rule_id}`, for example:

https://docs.squirrelscan.com/rules/links/external-links

## Running the audit

```bash
squirrel audit https://example.com --format llm
```

- Use `--format llm`: it is compact, exhaustive, and made for agents.
- If the user doesn't provide a URL, ask which site to audit.
- Prefer auditing the live site: only there do you see true rendering, performance, and redirect behavior. If both a local dev server and a live site exist, suggest the live one; apply the fixes to the local code either way.
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
2. **Propose fixes**: list the issues you can fix. Work within the user's authorized source-change scope; ask only when the needed scope is missing.
3. **Map issues to source**: find the template, component, or content file behind each finding.
4. **Fix in batches**: apply the approved fixes.
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

Sign off against a `-C full` crawl, since the quick pass samples only part of the site.

Rules carry a level (error, warning, notice) and a rank (1-10): fix errors first, then high-rank warnings. Findings that need a content edit count the same as ones that need a code edit. Broken links usually need a human decision (remove, replace, or keep): flag them rather than guessing.

## Verifying regressions

Compare against a baseline to prove improvement or catch regressions:

```bash
squirrel report --diff <baseline-audit-id> --format llm
squirrel report --regression-since example.com --format llm
```

## Entity-map fixes

For site-wide JSON-LD and entity-rule findings, inspect the saved map before editing: call native MCP `get_entity_findings`, record the returned audit/run ID, inspect each exact key with `get_entity`, and use `list_entities` and `get_entity_graph` for context. Pin all follow-up reads to that ID. `problem: ["no-id"]` also includes anonymous entities, so prioritize repeated Organization or Person nodes named by the rule finding. Page filtering searches only five published samples per entity; an empty result is not proof of absence. `get_entity` caps references at 50 in each direction, and a disconnected filtered node may connect globally.

Find the shared JSON-LD generator, template, or CMS configuration. For a confirmed shared-identity defect, give the affected entity a stable absolute `@id` and reuse it in references. Do not merge an Organization and SoftwareApplication merely because names match; determine whether they are distinct identities or one legitimate multi-type entity. Resolve confirmed conflicts, dangling references, and split identities at their source without inventing facts or deleting valid entities. Add `sameAs` only when verified evidence shows the target represents the same entity. Validate generated JSON-LD and project checks; do not promise ranking gains.

Work within the user's authorized source-change scope. Deployment and paid/cloud re-audits require the applicable authorization and must stay within the approved coverage and credit budget. After deployment, re-audit and inspect findings; call `compare_entities` with explicit before and after IDs, both of which need maps. A missing-map error does not prove no markup: the run may predate map storage. Confirm an identity repair with the intended `gainedId` and coverage, not merely an anonymous row disappearing; `gainedId` can be absent when the type or name changed in the same edit.

Example request: “Inspect the saved entity map, pin every call to its run ID, show entity findings and sampled evidence, then fix the shared markup. Keep the SoftwareApplication distinct. Validate the JSON-LD, and after an approved deployment compare explicit before and after map runs.”

## Completion

Done means: all errors fixed; warnings fixed or documented as needing human review; a re-audit confirms the improvement; and the user has seen the before/after score comparison plus a summary of every change made. Re-audit regularly to keep the site healthy. If the user wants to share results, offer a published report (see the `squirrelscan` skill).

## Report format

The LLM report is a compact XML/text hybrid optimized for token efficiency: summary with health score, issues grouped by category with affected URLs, broken links, and prioritized recommendations. Full spec: [OUTPUT-FORMAT.md](references/OUTPUT-FORMAT.md)
