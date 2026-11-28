#!/usr/bin/env bash
# Runs one package script (format:check, lint, typecheck) in the workspaces a
# diff affects, in parallel (#2180). ci.yml's quality job calls it with the
# `changes` job's outputs:
#
#   FULL=false WORKSPACES="@squirrelscan/rules @squirrelscan/cli" \
#     bash scripts/ci-run-workspaces.sh typecheck
#
# Fail open: FULL anything but `false` (including empty, when the `changes` job
# did not run) or an empty WORKSPACES runs the script in every workspace.
set -euo pipefail

script="${1:?usage: ci-run-workspaces.sh <package script>}"
full="${FULL:-}"
workspaces="${WORKSPACES:-}"

filters=()
if [ "$full" = false ] && [ -n "${workspaces// /}" ]; then
  for name in $workspaces; do
    filters+=(--filter "$name")
  done
  echo "$script in affected workspaces: $workspaces"
else
  filters=(--filter '*')
  echo "$script in every workspace"
fi

exec bun run --parallel "${filters[@]}" --if-present "$script"
