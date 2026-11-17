#!/usr/bin/env bash
# Changelog guard for pull requests (#2113). CI runs it from the end of
# check-released-changelog.sh (ci.yml's "Changelog guard" job). A user-visible change adds one file
# under changelog.d/ and leaves CHANGELOG.md alone; the release bump PR is the
# only change that writes CHANGELOG.md (it adds a new `## vX.Y.Z` heading).
#
#   bash scripts/check-changelog-entries.sh <base-commit> [repo]
#
# Fails when:
#   - a file in changelog.d/ is not named <name>.<section>.md with a known
#     section, is empty, or does not start with a "- " bullet;
#   - CHANGELOG.md differs from the base and the PR adds no new version heading.
# A PR with no entry at all (tests, CI, contributor docs) passes.
#
# SECTIONS mirrors SECTIONS in scripts/changelog.ts (lowercase); changelog.test.ts
# fails if the two lists differ. Kept in bash so this job needs no bun install.
set -euo pipefail

SECTIONS="added changed fixed security docs"

base="${1:-}"
repo="${2:-.}"
if [ -z "$base" ]; then
  echo "ERROR: pass the pull request base commit to compare against." >&2
  exit 1
fi
root=$(git -C "$repo" rev-parse --show-toplevel)
failed=0

# 1. Entry files.
entries=0
if [ -d "$root/changelog.d" ]; then
  while IFS= read -r -d '' path; do
    file=${path##*/}
    [ "$file" = "README.md" ] && continue
    section=""
    if [[ "$file" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.([A-Za-z]+)\.md$ ]]; then
      section=${BASH_REMATCH[1]}
    fi
    if [ -z "$section" ] || [[ " $SECTIONS " != *" $section "* ]]; then
      echo "ERROR: changelog.d/$file: name must be <name>.<section>.md, section one of: $SECTIONS" >&2
      failed=1
      continue
    fi
    first=$(grep -m1 -v '^[[:space:]]*$' "$path" || true)
    if [[ "$first" != "- "* ]]; then
      echo "ERROR: changelog.d/$file: must hold a Markdown bullet starting with \"- \"" >&2
      failed=1
      continue
    fi
    entries=$((entries + 1))
  done < <(find "$root/changelog.d" -mindepth 1 -maxdepth 1 -print0 | sort -z)
  if [ -n "$(find "$root/changelog.d" -mindepth 2 -print -quit)" ]; then
    echo "ERROR: changelog.d/ takes files only, no subdirectories." >&2
    failed=1
  fi
fi

# 2. CHANGELOG.md is written by a release only. A base that still has a
# `## [Unreleased]` heading predates changelog.d/ (the switch PR itself, #2113),
# so the old rule applies to it and this part is skipped.
base_changelog=$(git -C "$root" show "$base:CHANGELOG.md" 2>/dev/null || true)
if grep -q '^## \[Unreleased\]' <<<"$base_changelog"; then
  echo "NOTE: base $base still collects entries under ## [Unreleased]; CHANGELOG.md edit check skipped." >&2
elif ! git -C "$root" diff --quiet "$base" -- CHANGELOG.md; then
  version_headings() {
    awk '$1 == "##" && $2 ~ /^\[?v?[0-9]+\.[0-9]+\.[0-9]+/ { print $2 }' | sort -u
  }
  base_versions=$(version_headings <<<"$base_changelog")
  head_versions=$(version_headings < "$root/CHANGELOG.md")
  new_versions=$(comm -13 <(printf '%s\n' "$base_versions") <(printf '%s\n' "$head_versions") | sed '/^$/d')
  if [ -z "$new_versions" ]; then
    echo "ERROR: this PR edits CHANGELOG.md, which only a release writes." >&2
    echo "Add your entry as a file instead: changelog.d/<issue>-<short-name>.<section>.md (see changelog.d/README.md)." >&2
    echo "An open PR with a CHANGELOG.md bullet converts with: bun run changelog:convert (steps in changelog.d/README.md)" >&2
    failed=1
  else
    echo "CHANGELOG.md edited by a release: $(echo "$new_versions" | tr '\n' ' ')"
  fi
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "changelog entries OK ($entries in changelog.d/)"
