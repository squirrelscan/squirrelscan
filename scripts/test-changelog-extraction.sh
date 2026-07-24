#!/usr/bin/env bash
# Smoke-test for scripts/extract-changelog.awk — the CHANGELOG section extractor
# release.yml uses to build release notes (and release.ts's preflight reuses).
# Guards the awk against regressions: exact match, version boundary (0.0.5 vs
# 0.0.57), beta suffix, stray non-version `## ` sub-heading, missing→empty, and
# stable reusing a beta heading. Run: bash scripts/test-changelog-extraction.sh
# (or `make test-changelog`). #496
set -euo pipefail

AWK="$(cd "$(dirname "$0")" && pwd)/extract-changelog.awk"
FIXTURE="$(mktemp)"
trap 'rm -f "$FIXTURE"' EXIT
cat >"$FIXTURE" <<'MD'
## v3.0.0

three-body

## [Unreleased]

unreleased-wip

## v2.0.0-beta.1

twozero-beta

## v1.3.0

stable-130

## v1.2.0-beta.4

beta-120b4

## v0.0.5

boundary-five
## Heads up
five-extra

## v0.0.57

high-five-seven

## v0.0.4

old-four
MD

fails=0
extract() { awk -v "v=$1" -f "$AWK" "$FIXTURE"; }
check() { # desc, output, mode(has|hasnt|empty), needle
  local desc="$1" out="$2" mode="$3" needle="${4:-}"
  case "$mode" in
    has) grep -qF -- "$needle" <<<"$out" || { echo "FAIL: $desc (missing '$needle')"; fails=1; } ;;
    hasnt) if grep -qF -- "$needle" <<<"$out"; then echo "FAIL: $desc (unexpected '$needle')"; fails=1; fi ;;
    empty) [ -z "${out//[[:space:]]/}" ] || { echo "FAIL: $desc (expected empty, got '$out')"; fails=1; } ;;
  esac
}

out=$(extract 1.3.0)
check "exact stable match" "$out" has "stable-130"
check "exact stable isolation" "$out" hasnt "beta-120b4"

out=$(extract 1.2.0-beta.4)
check "beta suffix match" "$out" has "beta-120b4"
check "beta suffix isolation" "$out" hasnt "stable-130"

out=$(extract 0.0.5)
check "boundary body" "$out" has "boundary-five"
check "boundary 0.0.5 != 0.0.57" "$out" hasnt "high-five-seven"
check "stray ## sub-heading does not truncate" "$out" has "five-extra"

out=$(extract 2.0.0)
check "stable reuses beta heading" "$out" has "twozero-beta"
check "stable reuses beta isolation" "$out" hasnt "stable-130"

out=$(extract 3.0.0)
check "section above unreleased" "$out" has "three-body"
check "## [Unreleased] terminates section" "$out" hasnt "unreleased-wip"

out=$(extract 9.9.9)
check "missing version -> empty" "$out" empty

if [ "$fails" -ne 0 ]; then
  echo "changelog extraction smoke-test FAILED"
  exit 1
fi
echo "changelog extraction smoke-test OK"
