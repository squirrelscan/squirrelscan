#!/usr/bin/env bash
# Fixture tests for check-released-changelog.sh. #1234
set -euo pipefail

CHECKER="$(cd "$(dirname "$0")" && pwd)/check-released-changelog.sh"
repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT

git init -q "$repo"
git -C "$repo" config user.name "Changelog Test"
git -C "$repo" config user.email "changelog-test@example.com"

cat > "$repo/CHANGELOG.md" <<'MD'
# Changelog

## [Unreleased]

- planned work

## v1.0.0 (2026-01-02)

- shipped feature

## Heads up

This h2 belongs to the v1.0.0 notes.

## v0.9.0 (2026-01-01)

- earlier feature
MD

git -C "$repo" add CHANGELOG.md
git -C "$repo" commit -qm "release fixtures"
git -C "$repo" tag v0.9.0
git -C "$repo" tag v1.0.0
base=$(git -C "$repo" rev-parse HEAD)

fails=0

expect_pass() {
  local description="$1"
  if ! output=$(bash "$CHECKER" "$base" "$repo" 2>&1); then
    echo "FAIL: $description (unexpected failure: $output)"
    fails=1
  fi
}

expect_fail() {
  local description="$1"
  if output=$(bash "$CHECKER" "$base" "$repo" 2>&1); then
    echo "FAIL: $description (unexpected success: $output)"
    fails=1
  fi
}

restore_fixture() {
  git -C "$repo" show HEAD:CHANGELOG.md > "$repo/CHANGELOG.md"
}

insert_after() {
  local heading="$1" bullet="$2" source="$repo/CHANGELOG.md" next="$repo/CHANGELOG.next"
  awk -v heading="$heading" -v bullet="$bullet" '
    { print }
    $0 == heading { print ""; print bullet }
  ' "$source" > "$next"
  mv "$next" "$source"
}

expect_pass "unchanged released sections pass"

insert_after "## [Unreleased]" "- another planned change"
expect_pass "an Unreleased bullet passes"

restore_fixture
insert_after "## v1.0.0 (2026-01-02)" "- not actually in v1.0.0"
expect_fail "a bullet added to a released section fails"
if ! grep -qF "released CHANGELOG section v1.0.0" <<<"$output"; then
  echo "FAIL: failure names the changed section"
  fails=1
fi
if ! grep -qF "Move new changelog bullets under ## [Unreleased]" <<<"$output"; then
  echo "FAIL: failure tells the author where the bullet belongs"
  fails=1
fi

restore_fixture
awk '
  $0 == "## v1.0.0 (2026-01-02)" { drop = 1; next }
  $0 == "## v0.9.0 (2026-01-01)" { drop = 0 }
  !drop { print }
' "$repo/CHANGELOG.md" > "$repo/CHANGELOG.next"
mv "$repo/CHANGELOG.next" "$repo/CHANGELOG.md"
expect_fail "deleting a released section fails"
if ! grep -qF "released CHANGELOG section v1.0.0" <<<"$output"; then
  echo "FAIL: deleted-section failure names the release"
  fails=1
fi

restore_fixture
awk '
  $0 == "## [Unreleased]" { print "## v1.1.0 (2026-01-03)"; next }
  { print }
' "$repo/CHANGELOG.md" > "$repo/CHANGELOG.next"
mv "$repo/CHANGELOG.next" "$repo/CHANGELOG.md"
expect_pass "an untagged release bump passes"

if [ "$fails" -ne 0 ]; then
  echo "released changelog tests FAILED"
  exit 1
fi

echo "released changelog tests OK"
