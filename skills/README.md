# squirrelscan skills

Two [Agent Skills](https://agentskills.io) that let a coding agent (Claude Code, Cursor, Codex, OpenCode, Gemini CLI, or anything else that reads `SKILL.md`) audit a website with the `squirrel` CLI or inspect stored audits through SquirrelScan MCP.

This repository is the canonical source for these skills. Mirror the complete `skills/squirrelscan/` and `skills/audit-website/` directories to the legacy `squirrelscan/skills` repository after every skill change, and bump the affected skill's metadata version.

| Skill | What it does |
|---|---|
| [`audit-website`](./audit-website/SKILL.md) | The full fix loop: run an audit, read the LLM report, map each finding to the source file that causes it, fix in batches, re-audit until the site scores well. |
| [`squirrelscan`](./squirrelscan/SKILL.md) | Operating the CLI: install, login, API keys, credits, running audits, publishing reports, MCP setup, config, troubleshooting. |

Run new audits with the `squirrel` CLI on your PATH; install it from [squirrelscan.com/download](https://squirrelscan.com/download) and check with `squirrel --version`. Stored entity-map investigations can instead use a connected SquirrelScan MCP server. Local CLI audits are free.

## Install

```bash
npx skills add squirrelscan/squirrelscan
```

This lands both skills in `.agents/skills/`. Claude Code users can instead install the plugin, which bundles the skills and the MCP server:

```
/plugin marketplace add squirrelscan/squirrelscan
/plugin install squirrelscan@squirrelscan
```

## Use

Ask your agent in plain language. For example:

```
Use the audit-website skill to audit https://example.com and fix all the issues, but only crawl 10 pages
```

```
Use the squirrelscan skill to publish the last audit and share the report
```

## Layout

```
skills/
  audit-website/
    SKILL.md              the skill (instructions the agent follows)
    references/           output format reference the skill points at
    agents/openai.yaml    Codex metadata
    assets/               icons
  squirrelscan/
    SKILL.md
    agents/openai.yaml
    assets/
```

Rule documentation for every finding lives at [docs.squirrelscan.com/rules](https://docs.squirrelscan.com/rules). The MCP server, GitHub Action, and CLI reference are in the [main README](../README.md).
