#!/usr/bin/env bash
# Released changelog sections are immutable: any tagged section changed by a PR
# must match the CHANGELOG.md snapshot stored in that tag. Limiting the check to
# sections changed from the PR base avoids making unrelated historical drift a
# permanent failure. New entries belong under ## [Unreleased]. A new release
# heading has no tag yet, so release bump PRs are intentionally ignored. #1234
set -euo pipefail

base="${1:-}"
repo="${2:-.}"
root=$(git -C "$repo" rev-parse --show-toplevel)
changelog="$root/CHANGELOG.md"

if [ -z "$base" ]; then
  echo "ERROR: pass the pull request base commit to compare against." >&2
  exit 1
fi

if [ ! -f "$changelog" ]; then
  echo "ERROR: CHANGELOG.md not found at $changelog" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

base_changelog="$tmp/base-changelog"
if ! git -C "$root" show "$base:CHANGELOG.md" > "$base_changelog"; then
  echo "ERROR: cannot read CHANGELOG.md from base commit $base." >&2
  exit 1
fi

versions="$tmp/versions"
awk '
  $1 == "##" && $2 ~ /^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/ {
    print $2
  }
' "$changelog" "$base_changelog" | sort -u > "$versions"

extract_section() {
  local version="$1" file="$2"
  awk -v target="$version" '
    function is_release_boundary(token) {
      return token == "[Unreleased]" || token ~ /^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/
    }

    $1 == "##" && $2 == target {
      emit = 1
    }

    emit && $1 == "##" && $2 != target && is_release_boundary($2) {
      exit
    }

    emit {
      print
    }
  ' "$file"
}

tagged=0
changed=0
failed=0
while IFS= read -r version; do
  [ -n "$version" ] || continue

  # A release bump introduces a heading before its tag exists. It is not a
  # released section yet and must not fail this check.
  if ! git -C "$root" rev-parse --verify --quiet "refs/tags/$version^{commit}" >/dev/null; then
    continue
  fi

  tagged_changelog="$tmp/tagged-changelog"
  current_section="$tmp/current-section"
  base_section="$tmp/base-section"
  tagged_section="$tmp/tagged-section"

  # Early releases predate CHANGELOG.md, so there is no tagged section that
  # can serve as their immutable snapshot.
  if ! git -C "$root" show "$version:CHANGELOG.md" > "$tagged_changelog" 2>/dev/null; then
    continue
  fi
  tagged=$((tagged + 1))

  extract_section "$version" "$changelog" > "$current_section"
  extract_section "$version" "$base_changelog" > "$base_section"

  # Existing main-branch differences predate this gate. Only a PR that changes
  # this released section is responsible for restoring it to the tag snapshot.
  if cmp -s "$current_section" "$base_section"; then
    continue
  fi

  changed=$((changed + 1))
  extract_section "$version" "$tagged_changelog" > "$tagged_section"

  if ! cmp -s "$current_section" "$tagged_section"; then
    echo "ERROR: released CHANGELOG section $version differs from tag $version." >&2
    echo "Move new changelog bullets under ## [Unreleased]; released sections must remain unchanged." >&2
    failed=1
  fi
done < "$versions"

if [ "$tagged" -eq 0 ]; then
  echo "ERROR: no tagged release sections were available for comparison." >&2
  echo "Fetch the repository's v* tags before running this check." >&2
  exit 1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "released changelog sections OK ($changed changed, $tagged tagged)"
