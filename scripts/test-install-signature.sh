#!/usr/bin/env bash
# install.sh release-key signature check against the platform's REAL openssl
# (squirrelscan/repo#5032). Linux runs OpenSSL, macOS runs LibreSSL from
# /usr/bin/openssl; the script is the same on both:
#
#   bash scripts/test-install-signature.sh
#
# It generates throwaway TEST keys (never a production key), renders them into
# a temporary copy of install.sh in place of the generated release-keys block,
# builds a fake release (manifest.json, a stub binary, .sig files) and runs the
# installer against it. Only curl and gh are shimmed: curl serves the fake
# release from disk (install.sh only speaks https), gh is logged in and finds
# no attestation unless a case says otherwise. openssl, sha256 and bash are real.
# Nothing touches the network; telemetry is off and the error endpoint is dead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/install.sh"
VERSION="v9.9.9"
ASSET="squirrel-test-binary"

command -v openssl > /dev/null 2>&1 || {
  echo "openssl not found: this test needs the platform's openssl" >&2
  exit 1
}
OPENSSL="$(command -v openssl)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/install-signature.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "uname:   $(uname -sm)"
echo "openssl: $OPENSSL ($("$OPENSSL" version))"
echo "bash:    $BASH_VERSION"
echo

# --- TEST keys ---------------------------------------------------------------
KEYS="$WORK/keys"
mkdir -p "$KEYS"
make_key() {
  "$OPENSSL" ecparam -name prime256v1 -genkey -noout -out "$KEYS/$1.key" 2> /dev/null
  "$OPENSSL" ec -in "$KEYS/$1.key" -pubout -out "$KEYS/$1.pub" 2> /dev/null
}
key_id() {
  "$OPENSSL" ec -pubin -in "$KEYS/$1.pub" -pubout -outform DER 2> /dev/null |
    "$OPENSSL" dgst -sha256 | awk '{print $NF}' | cut -c1-16
}
make_key test-release-key          # pinned, current slot
make_key test-release-key-revoked  # pinned in the next slot AND listed as revoked
make_key test-foreign-key          # never pinned
PINNED_ID="$(key_id test-release-key)"
REVOKED_ID="$(key_id test-release-key-revoked)"
FOREIGN_ID="$(key_id test-foreign-key)"

# A copy of install.sh with its generated release-keys block (the one
# scripts/sync-install-header.ts renders from release-keys.json) replaced:
# `pinned` pins the TEST keys, `unpinned` pins nothing, which is what
# install.sh does until the maintainer adds the production key.
render_installer() {
  local out="$1" pin="$2" first="${3:-}" blk="$WORK/keys.${1##*/}.block"
  {
    echo "# BEGIN GENERATED RELEASE KEYS (test)"
    if [ "$pin" = pinned ]; then
      echo "RELEASE_KEY_CURRENT_ID='$PINNED_ID'"
      echo "RELEASE_KEY_CURRENT_PEM='$(cat "$KEYS/test-release-key.pub")'"
      echo "RELEASE_KEY_NEXT_ID='$REVOKED_ID'"
      echo "RELEASE_KEY_NEXT_PEM='$(cat "$KEYS/test-release-key-revoked.pub")'"
      echo "RELEASE_KEYS_REVOKED='$REVOKED_ID'"
      echo "RELEASE_FIRST_SIGNED_VERSION='$first'"
    else
      echo "RELEASE_KEY_CURRENT_ID=''"
      echo "RELEASE_KEY_CURRENT_PEM=''"
      echo "RELEASE_KEY_NEXT_ID=''"
      echo "RELEASE_KEY_NEXT_PEM=''"
      echo "RELEASE_KEYS_REVOKED=''"
      echo "RELEASE_FIRST_SIGNED_VERSION=''"
    fi
    echo "# END GENERATED RELEASE KEYS"
  } > "$blk"
  awk -v blockfile="$blk" '
    /^# BEGIN GENERATED RELEASE KEYS/ { while ((getline line < blockfile) > 0) print line; skip = 1; next }
    /^# END GENERATED RELEASE KEYS/ { skip = 0; next }
    !skip { print }
  ' "$INSTALLER" > "$out"
  grep -q "^# BEGIN GENERATED RELEASE KEYS (test)$" "$out" || {
    echo "could not render the test keys into install.sh" >&2
    exit 1
  }
}
render_installer "$WORK/install-pinned.sh" pinned
render_installer "$WORK/install-unpinned.sh" unpinned
# The signed era (first_signed_version): the version under test is v9.9.9, so
# 9.9.9 is the first signed version and 9.9.10 is still in the future.
render_installer "$WORK/install-era.sh" pinned 9.9.9
render_installer "$WORK/install-pre-era.sh" pinned 9.9.10

# --- shims -------------------------------------------------------------------
SHIMS="$WORK/shims"
mkdir -p "$SHIMS"
cat > "$SHIMS/curl" << 'EOF'
#!/bin/bash
out="" prev="" url=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in https://*) url="$a" ;; esac
  prev="$a"
done
echo "$url" >> "$CURL_LOG"
case "$url" in
  https://github.com/squirrelscan/squirrelscan/releases/download/*/* | https://install.squirrelscan.com/dl/*/*)
    file="$RELEASE_DIR/${url##*/}"
    [ -f "$file" ] || exit 22
    [ -n "$out" ] && cp "$file" "$out"
    exit 0
    ;;
esac
exit 22
EOF
cat > "$SHIMS/gh" << 'EOF'
#!/bin/bash
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "attestation" ] && [ "$2" = "verify" ]; then
  [ "$3" = "--help" ] && exit 0
  echo "verify" >> "$GH_LOG"
  if [ "${GH_VERIFY_EXIT:-1}" != 0 ]; then echo "Error: no attestations found for this artifact"; fi
  exit "${GH_VERIFY_EXIT:-1}"
fi
exit 99
EOF
chmod 755 "$SHIMS/curl" "$SHIMS/gh"

# A PATH without gh, and one without gh or openssl: a farm of symlinks to every
# tool in the system bin dirs except the excluded ones (the shims dir that goes
# in front carries only curl). Everything else stays the platform's real tool.
SHIMS_CURL="$WORK/shims-curl"
mkdir -p "$SHIMS_CURL"
cp "$SHIMS/curl" "$SHIMS_CURL/curl"
make_farm() {
  local dir="$1" skip=" $2 " f name
  mkdir -p "$dir"
  for f in /usr/bin/* /bin/* /usr/sbin/* /sbin/*; do
    name="${f##*/}"
    case "$skip" in *" $name "*) continue ;; esac
    [ -e "$dir/$name" ] || ln -s "$f" "$dir/$name" 2> /dev/null || true
  done
}
make_farm "$WORK/farm-nogh" "gh"
make_farm "$WORK/farm-nogh-nossl" "gh openssl"
PATH_NOGH="$SHIMS_CURL:$WORK/farm-nogh"
PATH_NOGH_NOSSL="$SHIMS_CURL:$WORK/farm-nogh-nossl"
PATH_NOSSL="$SHIMS:$WORK/farm-nogh-nossl"
CASE_PATH=""
CASE_OS_RELEASE=""

# --- fake release ------------------------------------------------------------
FAKE_BINARY='#!/bin/sh
echo ran > "$HOME/ran.txt"
if [ "$1" = "self" ] && [ "$2" = "install" ]; then
  mkdir -p "$4" && printf "#!/bin/sh\n" > "$4/squirrel" && chmod 755 "$4/squirrel"
  exit 0
fi
echo "squirrel 9.9.9"'

sha256_of() { "$OPENSSL" dgst -sha256 "$1" | awk '{print $NF}'; }
sign() { "$OPENSSL" dgst -sha256 -sign "$KEYS/$1.key" -out "$3" "$2"; }

# make_release <dir> <signing key> <key id the manifest names>
make_release() {
  local dir="$1" key="$2" id="$3"
  mkdir -p "$dir"
  printf '%s\n' "$FAKE_BINARY" > "$dir/$ASSET"
  write_manifest "$dir" "$id" "${VERSION#v}"
  sign "$key" "$dir/manifest.json" "$dir/manifest.json.sig"
  sign "$key" "$dir/$ASSET" "$dir/$ASSET.sig"
}
write_manifest() {
  local dir="$1" id="$2" version="$3" sha size platforms="" p
  sha="$(sha256_of "$dir/$ASSET")"
  size="$(wc -c < "$dir/$ASSET" | tr -d '[:space:]')"
  for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl; do
    platforms="$platforms${platforms:+,}\"$p\":{\"filename\":\"$ASSET\",\"sha256\":\"$sha\",\"size\":$size}"
  done
  printf '{"version":"%s","channel":"stable","signing_key_id":"%s","binaries":{%s}}\n' \
    "$version" "$id" "$platforms" > "$dir/manifest.json"
}
flip_last_byte() {
  local f="$1" size
  size="$(wc -c < "$f" | tr -d '[:space:]')"
  head -c "$((size - 1))" "$f" > "$f.tmp"
  printf 'X' >> "$f.tmp"
  mv "$f.tmp" "$f"
}

# --- runner ------------------------------------------------------------------
PASSED=0
FAILED=0
LAST_STDERR=""

# run_case <name> <installer> <release dir> <expect: pass|fail> <stderr must contain> [gh verify exit]
run_case() {
  local name="$1" installer="$2" release="$3" expect="$4" needle="$5" gh_exit="${6:-1}"
  local root="$WORK/run-$PASSED-$FAILED-$RANDOM" rc=0 ok=true why=""
  mkdir -p "$root/home" "$root/tmp"
  env -i \
    PATH="${CASE_PATH:-$SHIMS:/usr/bin:/bin:/usr/sbin:/sbin}" \
    HOME="$root/home" TMPDIR="$root/tmp" OS_RELEASE_FILE="${CASE_OS_RELEASE:-}" \
    RELEASE_DIR="$release" CURL_LOG="$root/curl.log" GH_LOG="$root/gh.log" GH_VERIFY_EXIT="$gh_exit" \
    SQUIRREL_VERSION="$VERSION" SQUIRREL_BIN_DIR="$root/home/bin" SQUIRREL_NO_MODIFY_PATH=1 \
    SQUIRREL_ERROR_ENDPOINT="http://127.0.0.1:9/error" NO_TELEMETRY=1 CI=true LC_ALL=C \
    bash "$installer" > "$root/stdout" 2> "$root/stderr" < /dev/null || rc=$?
  LAST_STDERR="$(cat "$root/stderr")"
  LAST_ROOT="$root"
  if [ "$expect" = pass ]; then
    [ "$rc" -eq 0 ] || { ok=false; why="exit $rc, expected 0"; }
    [ -x "$root/home/bin/squirrel" ] || { ok=false; why="$why; nothing installed"; }
  else
    [ "$rc" -ne 0 ] || { ok=false; why="exit 0, expected a failure"; }
    [ ! -e "$root/home/ran.txt" ] || { ok=false; why="$why; the binary was run"; }
    [ ! -e "$root/home/bin/squirrel" ] || { ok=false; why="$why; the binary was installed"; }
  fi
  case "$LAST_STDERR" in
    *"$needle"*) ;;
    *) ok=false; why="$why; stderr lacks: $needle" ;;
  esac
  if [ "$ok" = true ]; then
    PASSED=$((PASSED + 1))
    printf 'ok   %-4s %s\n' "$expect" "$name"
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL %-4s %s (%s)\n' "$expect" "$name" "${why#; }"
    printf '%s\n' "$LAST_STDERR" | tail -n 15 | sed 's/^/       | /'
  fi
}
gh_verify_ran() { [ -s "$LAST_ROOT/gh.log" ]; }
fetched() { grep -q "$1" "$LAST_ROOT/curl.log" 2> /dev/null; }
check() {
  if "$@"; then return 0; fi
  FAILED=$((FAILED + 1))
  echo "FAIL      previous case: check failed: $*"
}

R="$WORK/releases"

# PASS: a correctly signed release installs on the signature alone; gh is never asked.
make_release "$R/good" test-release-key "$PINNED_ID"
run_case "correctly signed asset and manifest (pinned key)" "$WORK/install-pinned.sh" "$R/good" pass \
  "Release signature verified: signed by squirrelscan release key $PINNED_ID"
check eval '! gh_verify_ran'

# FAIL 1: tampered asset (one byte changed) with an otherwise valid signature.
make_release "$R/tampered" test-release-key "$PINNED_ID"
flip_last_byte "$R/tampered/$ASSET"
run_case "tampered asset, signatures from the original" "$WORK/install-pinned.sh" "$R/tampered" fail "Checksum mismatch"

# FAIL 1b: tampered asset whose manifest sha256 was rewritten to match; the manifest signature is now wrong.
make_release "$R/tampered-manifest" test-release-key "$PINNED_ID"
flip_last_byte "$R/tampered-manifest/$ASSET"
write_manifest "$R/tampered-manifest" "$PINNED_ID" "${VERSION#v}"
run_case "tampered asset + rewritten manifest, old manifest.json.sig" "$WORK/install-pinned.sh" "$R/tampered-manifest" fail \
  "manifest.json is not signed by key $PINNED_ID"

# FAIL 1c: a correctly signed manifest but an asset .sig that does not verify.
make_release "$R/bad-asset-sig" test-release-key "$PINNED_ID"
sign test-release-key "$R/bad-asset-sig/manifest.json" "$R/bad-asset-sig/$ASSET.sig"
run_case "asset .sig that does not cover the asset" "$WORK/install-pinned.sh" "$R/bad-asset-sig" fail \
  "$ASSET is not signed by key $PINNED_ID"

# FAIL 2: no .sig files and no attestation (gh logged in, finds none).
make_release "$R/unsigned" test-release-key "$PINNED_ID"
rm -f "$R/unsigned/"*.sig
run_case "missing .sig files and no attestation" "$WORK/install-pinned.sh" "$R/unsigned" fail \
  "release carries no squirrelscan release-key signature either"

# PASS: no .sig files but a valid attestation (an attested release).
run_case "missing .sig files, attestation verifies" "$WORK/install-pinned.sh" "$R/unsigned" pass \
  "Attestation verified" 0

# FAIL 2b: only one of the two .sig files.
make_release "$R/half-signed" test-release-key "$PINNED_ID"
rm -f "$R/half-signed/$ASSET.sig"
run_case "manifest.json.sig present, asset .sig missing" "$WORK/install-pinned.sh" "$R/half-signed" fail \
  "$ASSET.sig is missing" 0

# FAIL 3: a valid signature from an unpinned key, even with a passing attestation.
make_release "$R/foreign" test-foreign-key "$FOREIGN_ID"
run_case "valid signature from an unpinned key (attestation would pass)" "$WORK/install-pinned.sh" "$R/foreign" fail \
  "signed with key $FOREIGN_ID, which this installer does not pin" 0
check eval '! gh_verify_ran'

# FAIL 3b: an unpinned key's signature on a manifest that claims the pinned id.
make_release "$R/foreign-claims-pinned" test-foreign-key "$PINNED_ID"
run_case "unpinned key's signature claiming the pinned id" "$WORK/install-pinned.sh" "$R/foreign-claims-pinned" fail \
  "manifest.json is not signed by key $PINNED_ID" 0

# FAIL 4: a pinned key id listed as revoked, even with a passing attestation.
make_release "$R/revoked" test-release-key-revoked "$REVOKED_ID"
run_case "signature from a pinned key id listed as revoked (attestation would pass)" "$WORK/install-pinned.sh" "$R/revoked" fail \
  "signed with revoked key $REVOKED_ID" 0

# FAIL 5: a correctly signed manifest replayed under another version (downgrade).
make_release "$R/replayed" test-release-key "$PINNED_ID"
write_manifest "$R/replayed" "$PINNED_ID" "9.9.8"
sign test-release-key "$R/replayed/manifest.json" "$R/replayed/manifest.json.sig"
run_case "signed manifest for another version" "$WORK/install-pinned.sh" "$R/replayed" fail \
  "the signed manifest is for version '9.9.8'"

# No key pinned (today's install.sh): signatures are ignored, never fetched, and the attestation decides.
run_case "no key pinned, attestation verifies" "$WORK/install-unpinned.sh" "$R/good" pass "Attestation verified" 0
check eval '! fetched "\.sig$"'
run_case "no key pinned, attestation fails (signature not consulted)" "$WORK/install-unpinned.sh" "$R/good" fail \
  "Attestation verification failed" 1

# --- signed era (first_signed_version) ---------------------------------------
# From the first signed version up: a valid pinned-key signature or a valid
# attestation, nothing else. sha256 alone is a hard failure, with or without gh.
ERA="$WORK/install-era.sh"
PRE_ERA="$WORK/install-pre-era.sh"
no_sig_dir="$R/unsigned"   # no .sig files, from the unsigned case above

CASE_PATH="$PATH_NOGH"
run_case "era: no gh, no .sig files" "$ERA" "$no_sig_dir" fail "the sha256 checksum alone is not accepted"
check eval 'case "$LAST_STDERR" in *"the release has no .sig files"*"openssl dgst -sha256 -verify"*) true ;; *) false ;; esac'
run_case "era: no gh, valid signature" "$ERA" "$R/good" pass "Release signature verified: signed by squirrelscan release key $PINNED_ID"
CASE_PATH="$PATH_NOGH_NOSSL"
run_case "era: no openssl, no gh, no attestation" "$ERA" "$R/good" fail "openssl is not installed"
CASE_PATH="$PATH_NOSSL"
run_case "era: no openssl, valid attestation (the attestation can still carry it)" "$ERA" "$R/good" pass "Attestation verified" 0
CASE_PATH=""
run_case "era: valid attestation, no .sig files" "$ERA" "$no_sig_dir" pass "Attestation verified" 0
run_case "era: attestation fails, no .sig files" "$ERA" "$no_sig_dir" fail "Attestation verification failed" 1
run_case "era: foreign key signature, attestation would pass" "$ERA" "$R/foreign" fail "which this installer does not pin" 0
check eval '! gh_verify_ran'

# No openssl, no gh, signed era: the error names the fix, the distro's line first,
# and never runs a package manager.
os_release() { printf '%s\n' "$2" > "$WORK/os-release.$1"; echo "$WORK/os-release.$1"; }
CASE_PATH="$PATH_NOGH_NOSSL"
CASE_OS_RELEASE="$(os_release debian 'ID=debian')"
run_case "era: no openssl, no gh, Debian: names apt-get install -y openssl" "$ERA" "$R/good" fail "apt-get install -y openssl"
check eval 'case "$LAST_STDERR" in *"Debian/Ubuntu: apt-get install -y openssl"*"Fedora/RHEL:   dnf install openssl"*"Alpine:        apk add openssl"*"log in to the GitHub CLI (gh)"*) true ;; *) false ;; esac'
CASE_OS_RELEASE="$(os_release ubuntu-like 'ID=pop
ID_LIKE="ubuntu debian"')"
run_case "era: no openssl, no gh, Ubuntu derivative (ID_LIKE): apt line first" "$ERA" "$R/good" fail "Debian/Ubuntu: apt-get install -y openssl"
CASE_OS_RELEASE="$(os_release fedora 'ID=fedora')"
run_case "era: no openssl, no gh, Fedora: dnf line first" "$ERA" "$R/good" fail "Fedora/RHEL:   dnf install openssl"
check eval 'case "$LAST_STDERR" in *"Fedora/RHEL:   dnf install openssl"*"Debian/Ubuntu: apt-get install -y openssl"*"Alpine:        apk add openssl"*) true ;; *) false ;; esac'
CASE_OS_RELEASE="$(os_release alpine 'ID=alpine')"
run_case "era: no openssl, no gh, Alpine: apk line first" "$ERA" "$R/good" fail "Alpine:        apk add openssl"
check eval 'case "$LAST_STDERR" in *"Alpine:        apk add openssl"*"Debian/Ubuntu: apt-get install -y openssl"*) true ;; *) false ;; esac'
CASE_OS_RELEASE="$WORK/no-such-os-release"
run_case "era: no openssl, no gh, unknown distro: all three lines" "$ERA" "$R/good" fail "apk add openssl"
check eval 'case "$LAST_STDERR" in *"apt-get install -y openssl"*"dnf install openssl"*"apk add openssl"*) true ;; *) false ;; esac'
CASE_OS_RELEASE=""
# The hint is only for a missing openssl: with openssl present but no .sig files it is absent.
CASE_PATH="$PATH_NOGH"
run_case "era: openssl present, no .sig files, no gh: no openssl hint" "$ERA" "$no_sig_dir" fail "the release has no .sig files"
check eval 'case "$LAST_STDERR" in *"apt-get install -y openssl"*) false ;; *) true ;; esac'

# musl: ensure_musl_runtime adds openssl with apk (as root), and the signed-era
# install then succeeds on the signature alone. apk and id are shims: apk
# "installs" openssl (a link to the real one, in the shims dir) and records its
# arguments. detect_libc is forced to musl in a copy of the installer.
SHIMS_MUSL="$WORK/shims-musl"
mkdir -p "$SHIMS_MUSL"
cp "$SHIMS/curl" "$SHIMS_MUSL/curl"
printf '#!/bin/sh\necho 0\n' > "$SHIMS_MUSL/id"
cat > "$SHIMS_MUSL/apk" <<APKEOF
#!/bin/sh
echo "\$*" >> "$WORK/apk.log"
case "\$*" in *openssl*) ln -sf "$OPENSSL" "$SHIMS_MUSL/openssl" ;; esac
exit 0
APKEOF
chmod 755 "$SHIMS_MUSL/id" "$SHIMS_MUSL/apk"
sed 's/^detect_libc() {$/detect_libc() { echo "-musl"; return/' "$ERA" > "$WORK/install-era-musl.sh"
rm -f "$WORK/apk.log"
CASE_PATH="$SHIMS_MUSL:$WORK/farm-nogh-nossl"
run_case "era: Alpine/musl, no openssl, no gh: ensure_musl_runtime adds openssl, install succeeds" \
  "$WORK/install-era-musl.sh" "$R/good" pass "Release signature verified: signed by squirrelscan release key $PINNED_ID"
check eval 'grep -q "add --no-cache.*openssl" "$WORK/apk.log"'
check eval '! gh_verify_ran'
CASE_PATH=""

# apk add is atomic: with BOTH libstdc++ and openssl missing and openssl
# unavailable from the mirror, the combined add fails; libstdc++ alone must be
# retried, openssl reported as a warning, and the install must go on.
SHIMS_MUSL2="$WORK/shims-musl2"
mkdir -p "$SHIMS_MUSL2"
cp "$SHIMS/curl" "$SHIMS_MUSL2/curl"
cp "$SHIMS_MUSL/id" "$SHIMS_MUSL2/id"
cat > "$SHIMS_MUSL2/apk" <<APKEOF
#!/bin/sh
echo "\$*" >> "$WORK/apk2.log"
case "\$*" in *openssl*) exit 1 ;; esac
echo "\$*" >> "$WORK/apk2.installed"
exit 0
APKEOF
chmod 755 "$SHIMS_MUSL2/id" "$SHIMS_MUSL2/apk"
# ensure_musl_runtime sees no libstdc++ (ls shim) and no openssl on PATH.
{
  echo 'ls() { return 1; }'
  cat "$WORK/install-era-musl.sh"
} > "$WORK/install-era-musl2.sh"
rm -f "$WORK/apk2.log" "$WORK/apk2.installed"
CASE_PATH="$SHIMS_MUSL2:$WORK/farm-nogh-nossl"
# The install then stops at the signature check (no openssl anywhere), which
# proves it got past ensure_musl_runtime instead of dying on libstdc++.
run_case "era: Alpine/musl, libstdc++ and openssl missing, apk refuses openssl: libstdc++ retried alone, install continues" \
  "$WORK/install-era-musl2.sh" "$R/good" fail "Auto-install of openssl failed"
check eval 'case "$LAST_STDERR" in *"Missing libstdc++"*) false ;; *"Installed libstdc++"*) true ;; *) false ;; esac'
check eval 'grep -qx "add --no-cache libstdc++" "$WORK/apk2.installed"'
CASE_PATH=""

# Before the era, and with the field unset, today's behaviour holds exactly.
CASE_PATH="$PATH_NOGH"
run_case "pre-era version, no gh, no .sig files: warns, installs (unchanged)" "$PRE_ERA" "$no_sig_dir" pass "relying on the sha256 checksum only"
run_case "first_signed_version unset, no gh, no .sig files: warns, installs (unchanged)" "$WORK/install-pinned.sh" "$no_sig_dir" pass "relying on the sha256 checksum only"
CASE_PATH=""

echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
