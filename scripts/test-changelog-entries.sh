#!/usr/bin/env bash
# Fixture tests for check-changelog-entries.sh, the CI changelog guard. #2113
# Run: bash scripts/test-changelog-entries.sh
set -euo pipefail

CHECKER="$(cd "$(dirname "$0")" && pwd)/check-changelog-entries.sh"
repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT

git init -q "$repo"
git -C "$repo" config user.name "Changelog Test"
git -C "$repo" config user.email "changelog-test@example.com"

mkdir -p "$repo/changelog.d" "$repo/src"
printf '%s\n' '# Changelog' '' '## v1.0.0 (2026-01-02)' '' '### Added' '' '- shipped feature' > "$repo/CHANGELOG.md"
printf '%s\n' '# changelog.d' > "$repo/changelog.d/README.md"
printf '%s\n' 'code' > "$repo/src/a.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm "fixture"
base=$(git -C "$repo" rev-parse HEAD)

fails=0
output=""

expect_pass() {
  if ! output=$(bash "$CHECKER" "$base" "$repo" 2>&1); then
    echo "FAIL: $1 (unexpected failure: $output)"
    fails=1
  fi
}

expect_fail() {
  if output=$(bash "$CHECKER" "$base" "$repo" 2>&1); then
    echo "FAIL: $1 (unexpected success: $output)"
    fails=1
  fi
}

expect_output() {
  if ! grep -qF -- "$1" <<<"$output"; then
    echo "FAIL: output lacks \"$1\": $output"
    fails=1
  fi
}

reset_fixture() {
  git -C "$repo" checkout -q "$base" -- .
  git -C "$repo" clean -qfd
}

printf '%s\n' 'more code' >> "$repo/src/a.ts"
expect_pass "a contributor-only change with no entry passes"
reset_fixture

printf '%s\n' '- New thing (#12)' > "$repo/changelog.d/12-new-thing.added.md"
expect_pass "a PR that adds an entry file passes"
expect_output "changelog entries OK (1 in changelog.d/)"
reset_fixture

for section in added changed fixed security docs; do
  printf '%s\n' "- a $section entry" > "$repo/changelog.d/1-x.$section.md"
done
expect_pass "every known section passes"
expect_output "(5 in changelog.d/)"
reset_fixture

printf '%s\n' '- Something (#13)' > "$repo/changelog.d/13-thing.removed.md"
expect_fail "an unknown section name fails"
expect_output "changelog.d/13-thing.removed.md: name must be <name>.<section>.md"
reset_fixture

printf '%s\n' '- No section' > "$repo/changelog.d/14-thing.md"
expect_fail "a file name with no section fails"
reset_fixture

: > "$repo/changelog.d/15-empty.fixed.md"
expect_fail "an empty entry fails"
expect_output "must hold a Markdown bullet"
reset_fixture

printf '%s\n' 'Fixed a thing' > "$repo/changelog.d/16-prose.fixed.md"
expect_fail "an entry that is not a bullet fails"
reset_fixture

mkdir -p "$repo/changelog.d/nested"
printf '%s\n' '- nested' > "$repo/changelog.d/nested/17-x.fixed.md"
expect_fail "a subdirectory fails"
reset_fixture

printf '%s\n' '' '- edited directly (#18)' >> "$repo/CHANGELOG.md"
expect_fail "a direct CHANGELOG.md edit outside a release fails"
expect_output "this PR edits CHANGELOG.md, which only a release writes"
expect_output "bun run changelog:convert"
reset_fixture

printf '%s\n' '- New thing (#19)' > "$repo/changelog.d/19-new.added.md"
printf '%s\n' '' '## [Unreleased]' '' '- old style (#19)' >> "$repo/CHANGELOG.md"
expect_fail "an entry file does not excuse a direct CHANGELOG.md edit"
reset_fixture

awk '$0 == "## v1.0.0 (2026-01-02)" { print "## v1.1.0 (2026-01-03)"; print ""; print "### Added"; print ""; print "- assembled"; print "" } { print }' \
  "$repo/CHANGELOG.md" > "$repo/CHANGELOG.next"
mv "$repo/CHANGELOG.next" "$repo/CHANGELOG.md"
expect_pass "a release that adds a new version heading may write CHANGELOG.md"
expect_output "CHANGELOG.md edited by a release: v1.1.0"
reset_fixture

# The switch PR itself: its base still has ## [Unreleased], so the old rule applies.
printf '%s\n' '# Changelog' '' '## [Unreleased]' '' '- planned' '' '## v1.0.0 (2026-01-02)' > "$repo/CHANGELOG.md"
git -C "$repo" commit -qam "old scheme base"
old_base=$(git -C "$repo" rev-parse HEAD)
printf '%s\n' '# Changelog' '' '## v1.0.0 (2026-01-02)' > "$repo/CHANGELOG.md"
if ! output=$(bash "$CHECKER" "$old_base" "$repo" 2>&1); then
  echo "FAIL: a base that still has [Unreleased] skips the CHANGELOG.md edit check ($output)"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "changelog entries guard tests FAILED"
  exit 1
fi
echo "changelog entries guard tests OK"
