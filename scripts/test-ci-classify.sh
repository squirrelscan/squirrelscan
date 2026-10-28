#!/usr/bin/env bash
# Table test for scripts/ci-classify.sh, the changed-path classifier behind
# ci.yml's per-job gates. Each case is a diff (paths separated by spaces) and
# the jobs it must run, as code/engine/installer/release/build bits.
# Run: bash scripts/test-ci-classify.sh
set -euo pipefail

CLASSIFY="$(cd "$(dirname "$0")" && pwd)/ci-classify.sh"
failed=0
count=0

# expect <c e i r b> <name> [paths...]
expect() {
  local want="$1" name="$2"
  shift 2
  local got
  got=$(printf '%s\n' "$@" | bash "$CLASSIFY" | cut -d= -f2 | sed 's/true/1/;s/false/0/' | tr -d '\n')
  count=$((count + 1))
  if [ "$got" != "${want// /}" ]; then
    echo "FAIL $name: want $want, got $got (code engine installer release build)"
    failed=1
  fi
}

#      c e i r b
expect "0 0 0 0 0" "docs only" docs/guides/ci.mdx docs/docs.json
expect "0 0 0 0 0" "root markdown only" CONTRIBUTING.md
expect "0 0 0 0 0" "docs + root markdown (#1051)" docs/glossary/index.mdx CONTRIBUTING.md
expect "0 0 0 0 0" "all root docs + templates" README.md AGENTS.md CODE_OF_CONDUCT.md SECURITY.md \
  TRADEMARKS.md .github/DOCS_STYLE.md .github/ISSUE_TEMPLATE/bug.md .github/PULL_REQUEST_TEMPLATE.md
expect "1 1 1 1 1" "AGENTS.md in a subdirectory of npm" npm/AGENTS.md
expect "0 0 0 0 0" "docs scripts edit (#1051)" docs/package.json docs/scripts/glossary.ts CONTRIBUTING.md
expect "1 1 1 1 1" "docs dependency bump" docs/package.json bun.lock
expect "1 0 0 0 0" "rules tests only (#1052)" packages/rules/tests/docs-rule-pages.test.ts
expect "1 0 0 0 0" "package test inside src" packages/fetchers/src/set-cookie.test.ts
expect "1 1 0 0 1" "rules/src test file (golden globs it)" packages/rules/src/foo.test.ts
expect "1 1 0 0 1" "rule source" packages/rules/src/crawl/robots-txt.ts
expect "1 1 0 0 1" "audit-engine test (golden lives here)" packages/audit-engine/tests/streaming-golden.test.ts
expect "1 1 0 1 1" "report source + test + changelog (#1069)" packages/report/src/output/page/prompts.ts \
  packages/report/tests/report-page-prompts.test.ts CHANGELOG.md
expect "1 0 0 0 1" "CLI only (#967)" apps/cli/src/cli/walk-heartbeat.ts apps/cli/tests/cli/walk-heartbeat-950.test.ts
expect "1 0 0 0 0" "CLI tests only" apps/cli/tests/controllers/analyze.test.ts
expect "1 0 1 0 0" "installer only" install.sh install.ps1
expect "1 0 1 0 0" "installer contract test" scripts/install-ps-contract.test.ps1
expect "1 0 0 1 0" "changelog only" CHANGELOG.md
expect "1 0 0 1 0" "release script" scripts/release.ts scripts/release-version.test.ts
expect "1 0 0 1 0" "released changelog guard" scripts/check-released-changelog.sh
expect "1 0 0 1 0" "released changelog guard tests" scripts/test-released-changelog.sh
expect "1 0 0 1 1" "CLI version file" apps/cli/package.json
expect "1 1 1 1 1" "release bump (#1056: npm manifest is unnamed)" CHANGELOG.md apps/cli/package.json npm/package.json
expect "1 1 1 1 1" "lockfile only" bun.lock
expect "1 1 1 1 1" "root manifest" package.json
expect "1 1 1 1 1" "workflow file" .github/workflows/ci.yml
expect "1 1 1 1 1" "setup action" .github/actions/setup-bun/action.yml
expect "1 1 1 1 1" "classifier itself" scripts/ci-classify.sh
expect "1 1 1 1 1" "other script" scripts/generate-third-party-notices.ts
expect "1 1 1 1 1" "notices" THIRD_PARTY_NOTICES.md
expect "1 1 1 1 1" "license" LICENSE
expect "1 1 1 1 1" "secrets baseline" .secrets.baseline
expect "1 1 1 1 1" "unknown top-level file" new-thing.toml
expect "1 1 1 1 1" "git-quoted path" '"docs/caf\303\251.mdx"'
expect "1 1 1 1 1" "mixed docs + workflow" docs/a.mdx .github/workflows/ci.yml
expect "1 1 1 1 1" "empty diff"
expect "1 1 1 1 1" "blank lines only" "" ""
# Prefix look-alikes must not ride a docs or installer arm.
expect "1 1 1 1 1" "docs look-alike" docsx/a.mdx
expect "1 1 1 1 1" "README in a subdirectory of npm" npm/README.md
expect "1 1 1 1 1" "installer look-alike" install.sh.bak

if [ "$failed" -ne 0 ]; then
  echo "ci-classify: some of $count cases failed" >&2
  exit 1
fi
echo "ci-classify: all $count cases pass"
