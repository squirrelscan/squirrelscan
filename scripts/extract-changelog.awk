# Extract the CHANGELOG.md release-notes section for version `v` (pass `-v v=X.Y.Z`).
#
# Single source of truth: release.yml (Resolve release notes) and the smoke-test
# scripts/test-changelog-extraction.sh both run THIS file, so the extraction can
# only drift if this file changes (and the smoke-test then catches it). #495/#496
#
# Matching: a `## [v]<version>` heading, dots escaped, optional leading `[`/`v`,
# with a non-digit/EOL boundary so `0.0.5` never matches `0.0.57`. Body is every
# line up to the next version heading (`## v0...`) or a `## [Unreleased]` heading;
# a stray non-version `## ` sub-heading does NOT terminate the section. A beta
# `vX.Y.Z-beta.N` matches only its exact heading; a stable `vX.Y.Z` also matches
# any `## vX.Y.Z-<suffix>` heading (e.g. `-beta.N`, `-rc.1` — the non-digit
# boundary), so a stable cut can reuse a pre-release section.
BEGIN { gsub(/\./, "\\.", v); re = "^##[[:space:]]+\\[?v?" v "([^0-9]|$)" }
$0 ~ re { grab = 1; next }
grab && /^##[[:space:]]+(\[?v?[0-9]|\[Unreleased\])/ { exit }
grab { print }
