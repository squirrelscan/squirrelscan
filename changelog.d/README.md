# changelog.d

Unreleased changelog entries, one file per change. A pull request with a user-visible change adds one file here and does not edit `CHANGELOG.md`, so two pull requests never touch the same lines and merge in either order.

## Adding an entry

Name the file `<issue>-<short-name>.<section>.md`, where `<section>` is one of `added`, `changed`, `fixed`, `security` or `docs`:

```
changelog.d/3093-wcag-level.added.md
```

The file holds the bullet exactly as it would read under that section of `CHANGELOG.md`: written for users, starting with `- ` and ending with the issue reference, `(#123)`. One change per file. Contributor-only changes (tests, CI, `AGENTS.md`) need no entry.

## Commands

| Command | What it does |
| --- | --- |
| `bun run changelog` | Prints the assembled unreleased section, as the next release will read. |
| `bun run changelog:convert` | Moves the bullets this branch added to `CHANGELOG.md` into files here, with the same text, and restores the branch's `## [Unreleased]` block to the merge base. A branch opened before this folder existed runs main's copy, as shown below. |
| `bun run changelog:release <version>` | Writes `## v<version> (<date>)` into `CHANGELOG.md` with every entry grouped under Added, Changed, Fixed, Security and Docs, then deletes the files. `make release` runs it in the version bump PR. |
| `bun scripts/changelog.ts check` | Validates every file here. |

The CI changelog guard (`scripts/check-changelog-entries.sh`) fails a pull request that edits `CHANGELOG.md` outside a release, or adds a file here with an unknown section name.

## Converting an open pull request

A branch that still adds its bullet to `CHANGELOG.md` was opened before this folder existed, so it has no copy of the script yet. Run main's copy on the branch:

```bash
git fetch origin
git show origin/main:scripts/changelog.ts > /tmp/changelog.ts
bun /tmp/changelog.ts convert   # writes the files, restores CHANGELOG.md
git add -A changelog.d CHANGELOG.md
git reset --soft "$(git merge-base origin/main HEAD)"
git commit -s -m "<your PR subject>"   # one commit, so none of them edits CHANGELOG.md
git rebase origin/main
```
