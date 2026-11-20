#!/usr/bin/env bash
# Decides which CI jobs a diff needs. ci.yml's `changes` job pipes the changed
# paths in (`git diff --name-only --no-renames`, one per line) and writes the
# output to $GITHUB_OUTPUT; scripts/test-ci-classify.sh tests it offline:
#
#   printf 'docs/a.mdx\nCHANGELOG.md\n' | bash scripts/ci-classify.sh
#
# Output, always these seven lines in this order. The first five are each
# `true` or `false`:
#
#   code       any path outside the docs set: Format, lint, and typecheck,
#              CLI tests, Dependency audit, Public suffix data freshness
#   engine     Audit engine golden tests
#   installer  Installer script syntax
#   release    Release tooling tests
#   build      Compile CLI
#
# The last two are JSON arrays (#2180), from `scripts/test-suites.ts --select`:
#
#   workspaces  workspace dirs that hold a changed file or depend on one,
#               transitively: where quality runs format, lint and typecheck
#   suites      the scripts/test-suites.ts suites those workspaces own (a
#               workspace that is no named suite root maps to `rest`): one
#               CLI tests matrix job each
#
# The selection is FULL (every workspace, every suite) on any path outside
# apps/*, packages/* and the docs set, so install.sh, CHANGELOG.md and the
# release scripts select everything even though the five bits above stay
# narrow. A docs-only change selects nothing: `[]` twice. Pushes to main and an
# unknown base are FULL too, but that is decided in ci.yml, not here.
#
# Fail open. An empty list, or ANY path no rule below names, sets all five to
# true: a workflow, the setup action, bun.lock, the root package.json, a root
# config, npm/, scripts/ (bar the few named below) and this file all land there.
# So a new top-level file runs everything until someone decides otherwise.
#
# To add a path: put it in the narrowest arm that is TRUE for it, and prove it
# first (grep the tests, workflows and scripts for readers of that file). Then
# add a row to scripts/test-ci-classify.sh. When in doubt, leave it unnamed.
set -euo pipefail

code=false engine=false installer=false release=false build=false
all=false seen=false
# sel_full: some path is outside apps/*, packages/* and the docs set.
# ws_paths: the apps/* and packages/* paths, for test-suites.ts --select.
sel_full=false ws_paths=()

# bun's own test-file convention, as in scripts/test-suites.ts (TEST_FILE).
test_file='(\.|_)([Tt][Ee][Ss][Tt]|[Ss][Pp][Ee][Cc])\.(m|c)?[jt]sx?$'

while IFS= read -r path || [ -n "$path" ]; do
  [ -n "$path" ] || continue
  seen=true
  case "$path" in
    # Docs set: no job reads these but "Docs check and build" and "Secret
    # scan", which run on every change anyway. Checked for the root files:
    # nothing in a test, script, notices or release step reads them (npm/
    # ships its own README.md and LICENSE). docs/** is read by three tests
    # (packages/rules/tests/docs-*.test.ts, apps/cli/tests/mcp/docs-sync.test.ts);
    # the docs job runs those itself. docs/package.json counts too: docs is a
    # root workspace member, so a dependency change there also moves bun.lock
    # (which runs everything), and without that the docs job's frozen install
    # fails.
    # changelog.d/ entries: the changelog guard job (not path-gated) validates them.
    changelog.d/* | \
    docs/* | README.md | CONTRIBUTING.md | AGENTS.md | CODE_OF_CONDUCT.md | SECURITY.md | \
      TRADEMARKS.md | .github/DOCS_STYLE.md | .github/ISSUE_TEMPLATE/* | \
      .github/PULL_REQUEST_TEMPLATE*)
      ;;
    # Read only by the installer-scripts job (pwsh contract, bash -n). The
    # header-sync check lives in quality, which `code` already runs.
    install.sh | install.ps1 | scripts/install-ps-contract.test.ps1 | \
      scripts/install-contract.test.ts)
      code=true installer=true sel_full=true ;;
    # Release inputs. CHANGELOG.md changes only in a release bump PR now (#2113),
    # and must not fall through to "everything": only release.ts and release.yml
    # read it, at release time, and the shell tests use their own fixtures.
    CHANGELOG.md | scripts/release.ts | scripts/release-version.test.ts | \
      scripts/extract-changelog.awk | scripts/test-changelog-extraction.sh | \
      scripts/check-released-changelog.sh | scripts/test-released-changelog.sh | \
      scripts/changelog.ts | scripts/changelog.test.ts | \
      scripts/check-changelog-entries.sh | scripts/test-changelog-entries.sh)
      code=true release=true sel_full=true ;;
    # The golden suite lives here, fixtures included: any change runs it.
    packages/audit-engine/*)
      code=true engine=true build=true ws_paths+=("$path") ;;
    # The version file is also a release input.
    apps/cli/package.json)
      code=true build=true release=true ws_paths+=("$path") ;;
    packages/* | apps/cli/*)
      code=true
      ws_paths+=("$path")
      # Test-only: CLI tests run it; the golden suite and the compiled binary
      # never see it (rules-fingerprint.ts skips test files for the same
      # reason). The one cross-package read in the golden tests globs every
      # .ts under packages/rules/src, test files too, so those stay engine.
      if [[ "$path" =~ ^(packages/[^/]+|apps/cli)/tests/ ]] ||
        { [[ "$path" =~ $test_file ]] && [[ "$path" != packages/rules/src/* ]]; }; then
        :
      elif [[ "$path" == apps/cli/* ]]; then
        build=true
      else
        engine=true build=true
      fi
      ;;
    *)
      all=true ;;
  esac
done

if [ "$all" = true ] || [ "$seen" = false ]; then
  code=true engine=true installer=true release=true build=true sel_full=true
fi

printf 'code=%s\nengine=%s\ninstaller=%s\nrelease=%s\nbuild=%s\n' \
  "$code" "$engine" "$installer" "$release" "$build"

# The workspace graph and the suite table live in test-suites.ts; bun is only
# needed when a workspace path is in play. Any failure here fails the script,
# and ci.yml then runs everything.
suites_ts="$(cd "$(dirname "$0")" && pwd)/test-suites.ts"
if [ "$sel_full" = true ]; then
  bun "$suites_ts" --select-all < /dev/null
elif [ "${#ws_paths[@]}" -gt 0 ]; then
  printf '%s\n' "${ws_paths[@]}" | bun "$suites_ts" --select
else
  printf 'workspaces=[]\nsuites=[]\n'
fi
