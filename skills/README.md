# squirrelscan skills (mirror)

**This directory is a read-only mirror of [squirrelscan/skills](https://github.com/squirrelscan/skills).** That repo is the canonical source of the squirrelscan agent skills. Open issues and pull requests for skill changes there, not here: anything edited in this directory is overwritten by the next sync.

The copy exists because this repo's Claude Code and Cursor plugin manifests (`.claude-plugin/`, `.cursor-plugin/`) ship the skills from this directory. It is refreshed one way, from upstream, by:

```bash
bun run scripts/sync-skills.ts            # mirror squirrelscan/skills main
bun run scripts/sync-skills.ts --check    # exit 1 if this copy has drifted
```

Everything here except this README comes from upstream byte for byte.

## Skills

| Skill | What it does |
|---|---|
| [`audit-website`](https://github.com/squirrelscan/skills/tree/main/skills/audit-website) | The full fix loop: run an audit, read the LLM report, map each finding to the source file that causes it, fix in batches, re-audit until the site scores well. |
| [`squirrelscan`](https://github.com/squirrelscan/skills/tree/main/skills/squirrelscan) | Operating the CLI: install, login, API keys, credits, running audits, publishing reports, the entity map, MCP setup, config, troubleshooting. |

Both require the `squirrel` CLI on your PATH. Install it from [squirrelscan.com/download](https://squirrelscan.com/download) and check with `squirrel --version`.

## Install

Install from the canonical repo, not from this mirror:

```bash
npx skills add squirrelscan/skills
```

In Claude Code, the plugin bundles the skills and the hosted MCP server:

```
/plugin marketplace add squirrelscan/skills
/plugin install squirrelscan@squirrelscan
```

Or let the CLI run the install for you: `squirrel skills install`. Per-tool instructions are in the [squirrelscan/skills README](https://github.com/squirrelscan/skills#installing).
