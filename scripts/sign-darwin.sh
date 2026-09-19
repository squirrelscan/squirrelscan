#!/usr/bin/env bash
#
# Re-sign the darwin release binaries after `bun build --compile` (#2310).
#
# `bun build --compile` writes the bundle into the Mach-O and moves the
# linker's ad-hoc signature to the end of the file, but it never recomputes
# the page hashes the signature seals. `codesign --verify --strict` therefore
# reports "code or signature have been modified" on every darwin asset we have
# ever published, and macOS kills the binary outright on a machine that
# enforces signatures, which is the SIGKILL (exit 137) installs on Apple
# Silicon were hitting. Re-signing ad-hoc rehashes the finished file; no
# certificate is involved and nothing about the binary changes but its
# signature.
#
# The release builds on Linux, where Apple's `codesign` does not exist, so
# rcodesign (apple-codesign) signs there. On a Mac, `codesign` is used when
# rcodesign is not installed, so a local `make build-all` signs the same
# binaries the release does.
#
# Signing CHANGES THE FILE BYTES. It has to run before anything hashes the
# build directory, which means before `make manifest`: a manifest generated
# first would publish hashes that no published asset matches, and every
# `squirrel self update` would fail its checksum check.

set -euo pipefail

BUILD_DIR="${1:-apps/cli/build}"
# Pinned rather than derived from the filename: `codesign` defaults the
# identifier to the file's basename, which carries the version, so an
# allowlist rule in an MDM or endpoint-security policy would stop matching at
# every release.
IDENTIFIER="${SQUIRREL_CODESIGN_IDENTIFIER:-com.squirrelscan.squirrel}"
RCODESIGN="${RCODESIGN:-rcodesign}"

have() {
  command -v "$1" >/dev/null 2>&1
}

sign_one() {
  local file="$1"
  if have "$RCODESIGN"; then
    "$RCODESIGN" sign --binary-identifier "$IDENTIFIER" "$file"
  elif have codesign; then
    codesign --force --sign - --identifier "$IDENTIFIER" "$file"
  else
    echo "error: neither rcodesign nor codesign is available, cannot sign $file" >&2
    echo "  install rcodesign: https://github.com/indygreg/apple-platform-rs/releases" >&2
    exit 1
  fi
}

verify_one() {
  local file="$1" out="" rc=0 line="" unexpected=0
  if have codesign; then
    # Apple's own verifier. This is the authoritative check, and it is the one
    # the release workflow repeats on a macOS runner before anything publishes.
    codesign --verify --strict "$file"
    return
  fi

  # Linux. `rcodesign verify` prints its own warning that it is unreliable,
  # and it calls a VALID ad-hoc signature a CMS failure because an ad-hoc
  # signature carries no CMS blob at all, so a non-zero exit says nothing on
  # its own. The one thing it does get right is comparing the recorded page
  # digests against the file, which is exactly the breakage this script exists
  # to fix.
  out=$("$RCODESIGN" verify "$file" 2>&1) || rc=$?
  # A future rcodesign that verifies an ad-hoc signature properly exits 0, and
  # that needs no interpreting.
  [ "$rc" -eq 0 ] && return 0

  # Otherwise read the complaints and allow ONLY the ones an ad-hoc signature
  # is expected to draw. Allowing everything except one known-bad string would
  # turn a crashed or confused verifier into a pass, which is the failure mode
  # this whole change exists to remove. Lines are matched by the shell, not by
  # grep: a check that needs another command on PATH is a check that silently
  # passes when it is not there.
  while IFS= read -r line; do
    case "$line" in
      "") ;;
      *"known to be buggy"*) ;;
      *"CMS error"*) ;;
      *"problems reported during verification"*) ;;
      *) unexpected=1 ;;
    esac
  done <<<"$out"

  if [ -z "$out" ] || [ "$unexpected" -eq 1 ]; then
    printf '%s\n' "$out" >&2
    echo "error: $file did not pass rcodesign verify after signing" >&2
    exit 1
  fi
}

main() {
  local found=0 file

  if [ ! -d "$BUILD_DIR" ]; then
    echo "error: build directory $BUILD_DIR does not exist" >&2
    exit 1
  fi

  for file in "$BUILD_DIR"/squirrel-*darwin-*; do
    # An unmatched glob expands to itself, so check before trusting it.
    [ -f "$file" ] || continue
    found=$((found + 1))
    echo "==> Signing $(basename "$file")..."
    sign_one "$file"
    verify_one "$file"
  done

  if [ "$found" -eq 0 ]; then
    echo "error: no darwin binaries found in $BUILD_DIR" >&2
    exit 1
  fi

  echo "==> Signed and checked $found darwin binaries."
}

main "$@"
