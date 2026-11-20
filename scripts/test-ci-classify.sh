#!/usr/bin/env bash
# Table test for scripts/ci-classify.sh, the changed-path classifier behind
# ci.yml's per-job gates. Each `expect` case is a diff (paths separated by
# spaces) and the jobs it must run, as code/engine/installer/release/build bits.
# Each `expect_sel` case checks the workspace and suite selection (#2180).
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
  got=$(printf '%s\n' "$@" | bash "$CLASSIFY" | sed -n 1,5p | cut -d= -f2 | sed 's/true/1/;s/false/0/' | tr -d '\n')
  count=$((count + 1))
  if [ "$got" != "${want// /}" ]; then
    echo "FAIL $name: want $want, got $got (code engine installer release build)"
    failed=1
  fi
}

#      c e i r b
expect "0 0 0 0 0" "docs only" docs/guides/ci.mdx docs/docs.json
expect "0 0 0 0 0" "root markdown only" CONTRIBUTING.md
expect "0 0 0 0 0" "changelog.d entry only (#2113)" changelog.d/2113-changelog-d.changed.md
expect "1 0 0 1 0" "changelog tooling (#2113)" scripts/changelog.ts scripts/changelog.test.ts \
  scripts/check-changelog-entries.sh scripts/test-changelog-entries.sh
expect "1 0 0 1 0" "release bump assembles changelog.d (#2113)" CHANGELOG.md changelog.d/1-a.added.md
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
expect "1 1 1 1 1" "unknown top-level file" new-thing.toml
expect "1 1 1 1 1" "git-quoted path" '"docs/caf\303\251.mdx"'
expect "1 1 1 1 1" "mixed docs + workflow" docs/a.mdx .github/workflows/ci.yml
expect "1 1 1 1 1" "empty diff"
expect "1 1 1 1 1" "blank lines only" "" ""
# Prefix look-alikes must not ride a docs or installer arm.
expect "1 1 1 1 1" "docs look-alike" docsx/a.mdx
expect "1 1 1 1 1" "README in a subdirectory of npm" npm/README.md
expect "1 1 1 1 1" "installer look-alike" install.sh.bak

# expect_sel <workspaces-json> <suites-json> <name> [paths...]
expect_sel() {
  local want_ws="$1" want_suites="$2" name="$3"
  shift 3
  local out got_ws got_suites
  out=$(printf '%s\n' "$@" | bash "$CLASSIFY")
  got_ws=$(printf '%s\n' "$out" | sed -n 's/^workspaces=//p')
  got_suites=$(printf '%s\n' "$out" | sed -n 's/^suites=//p')
  count=$((count + 1))
  if [ "$got_ws" != "$want_ws" ] || [ "$got_suites" != "$want_suites" ]; then
    echo "FAIL $name: want workspaces=$want_ws suites=$want_suites, got workspaces=$got_ws suites=$got_suites"
    failed=1
  fi
}

# The full selection, from the tree: every workspace the root manifest
# declares, and every suite test-suites.ts knows.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALL=$(bun "$ROOT/scripts/test-suites.ts" --select-all)
ALL_WS=$(printf '%s\n' "$ALL" | sed -n 's/^workspaces=//p')
ALL_SUITES=$(printf '%s\n' "$ALL" | sed -n 's/^suites=//p')
# Literal, so a suite that drops out of the full set fails here too.
[ "$ALL_SUITES" = '["audit-engine","crawler","cli","rules","report","rest"]' ] || {
  echo "FAIL full suite set changed: $ALL_SUITES"
  failed=1
}
case "$ALL_WS" in
  *'"apps/cli"'*'"packages/core-contracts"'*'"packages/rules"'*) ;;
  *) echo "FAIL full workspace set is missing a workspace: $ALL_WS"; failed=1 ;;
esac

expect_sel '[]' '[]' "sel: docs only" docs/guides/ci.mdx docs/docs.json CONTRIBUTING.md
expect_sel '[]' '[]' "sel: changelog.d entry only" changelog.d/2180-ci.changed.md
expect_sel '["apps/cli","packages/audit-engine","packages/rules"]' '["audit-engine","cli","rules"]' \
  "sel: rules only reaches rules, audit-engine and cli" packages/rules/src/crawl/robots-txt.ts
expect_sel '["apps/cli","packages/audit-engine","packages/rules"]' '["audit-engine","cli","rules"]' \
  "sel: rules test only" packages/rules/tests/docs-rule-pages.test.ts
expect_sel '["apps/cli"]' '["cli"]' "sel: CLI only" apps/cli/src/cli/walk-heartbeat.ts
expect_sel '["apps/cli","packages/audit-engine"]' '["audit-engine","cli"]' \
  "sel: audit-engine" packages/audit-engine/tests/streaming-golden.test.ts
expect_sel '["apps/cli","packages/audit-engine","packages/report"]' '["audit-engine","cli","report"]' \
  "sel: report" packages/report/src/output/page/prompts.ts
expect_sel '["apps/cli","packages/api-client"]' '["cli","rest"]' \
  "sel: a non-root workspace maps to rest" packages/api-client/src/index.ts
expect_sel '["apps/cli","packages/audit-engine","packages/rules"]' '["audit-engine","cli","rules"]' \
  "sel: docs + rules" docs/a.mdx packages/rules/src/a.ts
# Every suite, but not every workspace: api-client, waf-detect and docs do not
# depend on core-contracts.
expect_sel '["apps/cli","packages/audit-engine","packages/cloud-client","packages/config","packages/core-contracts","packages/crawler","packages/fetchers","packages/page-classifier","packages/parser","packages/report","packages/rules","packages/synthetic-site","packages/tech-detect","packages/threat-intel","packages/tls-probe","packages/utils"]' \
  "$ALL_SUITES" "sel: core-contracts reaches every suite" packages/core-contracts/src/index.ts
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: root file is FULL" bun.lock
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: root manifest is FULL" package.json
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: workflow is FULL" .github/workflows/ci.yml
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: script is FULL" scripts/test-suites.ts
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: installer is FULL" install.sh
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: CHANGELOG.md is FULL" CHANGELOG.md
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: rules + root file is FULL" packages/rules/src/a.ts tsconfig.json
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: unknown package is FULL" packages/not-a-workspace/src/a.ts
expect_sel "$ALL_WS" "$ALL_SUITES" "sel: empty diff is FULL"

if [ "$failed" -ne 0 ]; then
  echo "ci-classify: some of $count cases failed" >&2
  exit 1
fi
echo "ci-classify: all $count cases pass"
