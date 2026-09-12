#!/bin/bash

# Everything below needs bash: `local`, `[[ ]]`, and the `set -o pipefail` on
# the next line. Piped into a POSIX shell — `curl ... | sh`, and /bin/sh is
# dash on Debian/Ubuntu — that `set` aborts on line 1 with
#   sh: set: Illegal option -o pipefail
# before the error reporting below is even defined, so the failure is opaque
# to the user and invisible to us. `| sh` one-liners are published in places we
# can't edit, so hand over to bash rather than trusting the shebang.
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash > /dev/null 2>&1; then
    # Saved to a file: just re-run it. Piped: this script has already been
    # consumed from stdin and cannot be rewound, so refetch it under bash.
    case "$0" in
      */install.sh | install.sh) exec bash "$0" "$@" ;;
    esac
    # Hardened by hand rather than via CURL_TLS_ARGS: this runs under /bin/sh
    # before the bash-only preamble that defines the array (see #165).
    exec bash -c 'curl -fsSL --proto "=https" --proto-redir "=https" --tlsv1.2 --max-redirs 3 https://install.squirrelscan.com/install.sh | bash'
  fi
  echo "Error: the squirrelscan installer requires bash, and none was found." >&2
  echo "  Install bash, or grab a binary from https://github.com/squirrelscan/squirrelscan/releases" >&2
  exit 1
fi

set -euo pipefail

# squirrelscan installer
# Usage: curl -fsSL https://install.squirrelscan.com/install.sh | bash
# Or: curl -fsSL https://raw.githubusercontent.com/squirrelscan/squirrelscan/main/install.sh | bash
#
# Environment variables:
#   SQUIRREL_VERSION   - Pin to specific version (e.g., v0.0.15)
#   SQUIRREL_CHANNEL   - Release channel: stable or beta (default: stable)
#   SQUIRREL_BIN_DIR   - Override bin directory for symlink
#   SQUIRREL_FORCE_MIRROR - Skip github.com and download from
#                        install.squirrelscan.com (for networks that block
#                        GitHub). Any value but empty, 0 or false enables it.
#   GITHUB_TOKEN       - GitHub token to avoid API rate limits (optional)

REPO="squirrelscan/squirrelscan"

# Transport hardening for every curl this script runs. curl's own defaults will
# happily follow a redirect from https to plain http and will negotiate whatever
# TLS version the local build still allows, so pin both: --proto bounds the
# scheme of the initial request, --proto-redir bounds it again on every hop
# (the two are separate settings — one does not imply the other), --tlsv1.2 sets
# the floor, and --max-redirs bounds the chain. The binary is checksum-verified
# against the manifest, but the metadata fetches and the bash re-exec have no
# integrity protection beyond the transport itself (#165).
# --tlsv1.2 is the youngest of the four and landed in curl 7.34 (2013), below
# every platform we support: the oldest realistic holdout is RHEL 7 at curl
# 7.29, whose glibc 2.17 is already under the bun standalone binary's floor.
# An unsupported option exits 2 with "option ...: is unknown", which
# fetch_with_retry discards, so it would read as three failed download retries.
CURL_TLS_ARGS=(--proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3)

# Detect if stdout is a terminal for colors
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

log() { echo -e "${GREEN}==>${NC} $1" >&2; }
warn() { echo -e "${YELLOW}Warning:${NC} $1" >&2; }
# error <message> [detail]
# `message` is shown to the user AND carried in the failure report, where it is
# clamped to ERROR_LINE_MAX. `detail` is remediation text shown to the user
# only: a long guidance block passed as `message` would push the actual error
# out of the report's `error_line`.
error() {
  echo -e "${RED}Error:${NC} $1" >&2
  if [ -n "${2:-}" ]; then
    echo -e "$2" >&2
  fi
  LAST_ERROR_MSG="$1"
  # Also persist to a file: error() often runs inside a command-substitution
  # subshell (e.g. version=$(get_latest_version)), where the LAST_ERROR_MSG
  # assignment can't reach the parent that runs the EXIT trap.
  [ -n "${ERROR_MSG_FILE:-}" ] && printf '%s' "$1" >"$ERROR_MSG_FILE" 2>/dev/null || true
  exit 1
}
info() { echo -e "${BLUE}::${NC} $1" >&2; }

# --- Failure reporting ----------------------------------------------------
# On failure, fire a tiny anonymous report to the installer worker (→ Sentry)
# so we can see when installs break in the field. Strictly opt-out via
# NO_TELEMETRY (mirrors the CLI, apps/cli/src/self/telemetry.ts), fire-and-
# forget (never blocks or fails the install), and carries only coarse context
# (os/arch/step/exit code) — never paths, env, hostname, or secrets. #1013
# v2 adds `error_output` — the tail of the failing command's own output (#1538).
INSTALLER_REPORT_VERSION="2"
ERROR_ENDPOINT="${SQUIRREL_ERROR_ENDPOINT:-https://install.squirrelscan.com/error}"
# Release metadata (latest version per channel) — R2-backed, no rate limits.
RELEASES_ENDPOINT="${SQUIRREL_RELEASES_ENDPOINT:-https://install.squirrelscan.com/releases}"
# Release assets, mirrored through our own origin. A GitHub release-asset URL
# redirects to githubusercontent.com (objects.* historically, release-assets.*
# today), which some networks cannot reach: the metadata fetch above succeeds
# and the binary download then fails on every retry, forever (#2064). Every
# asset therefore has two sources.
DOWNLOAD_ENDPOINT="${SQUIRREL_DOWNLOAD_ENDPOINT:-https://install.squirrelscan.com/dl}"
ERROR_LINE_MAX=200
# Chars of captured command output carried in a report. The worker clamps again.
ERROR_OUTPUT_MAX=1000
CURRENT_STEP="init"
LAST_ERROR_MSG=""
# Captured stdout/stderr of the step that failed, when we ran it under tee.
LAST_ERROR_OUTPUT=""
# Real exit code of a failed sub-command, when it isn't the one error() exits with.
LAST_ERROR_CODE=""
TMPDIR_TO_CLEAN=""
# Survives command-substitution subshells where LAST_ERROR_MSG can't (see error()).
ERROR_MSG_FILE="$(mktemp 2>/dev/null || true)"

# Make a value safe inside a JSON string: keep only printable ASCII (drops
# control chars incl. ESC from ANSI colour codes, AND non-ASCII bytes — either
# would make the JSON invalid and the worker would reject the whole report),
# then escape backslashes and double-quotes.
json_escape() {
  printf '%s' "$1" | LC_ALL=C tr -cd '\40-\176' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Reduce a value to printable ASCII (control chars incl. newlines AND non-ASCII
# bytes → space) BEFORE truncating, so `cut -c` can't split a multibyte char
# into invalid UTF-8. Scrub $HOME → '~' so no local path leaks. Command output
# keeps its TAIL (that's where the error is); a message keeps its head. The
# worker re-clamps and redacts too.
scrub_for_report() {
  local text="$1" max="$2" keep_tail="${3:-head}" scrubbed tilde="~"
  if [ -z "$text" ]; then
    return 0
  fi
  scrubbed=$(printf '%s' "$text" | LC_ALL=C tr -c '\40-\176' ' ')
  if [ -n "${HOME:-}" ]; then
    scrubbed=${scrubbed//"$HOME"/$tilde}
  fi
  if [ "$keep_tail" = tail ] && [ "${#scrubbed}" -gt "$max" ]; then
    printf '%s' "${scrubbed:${#scrubbed}-max}"
  else
    printf '%s' "$scrubbed" | cut -c"1-$max"
  fi
}

report_error() {
  local step="$1" code="$2" line="${3:-}" output="${4:-}"
  # Presence disables reporting, including an explicitly empty value.
  [ "${NO_TELEMETRY+x}" = x ] && return 0
  command -v curl >/dev/null 2>&1 || return 0

  local os arch scrubbed="" scrubbed_output=""
  os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m 2>/dev/null)

  scrubbed=$(scrub_for_report "$line" "$ERROR_LINE_MAX")
  # The failing command's own stdout/stderr: without it a self_install failure
  # carried an exit code and nothing else (#1538).
  scrubbed_output=$(scrub_for_report "$output" "$ERROR_OUTPUT_MAX" tail)

  local payload
  payload=$(printf '{"script":"sh","script_version":"%s","channel":"%s","os":"%s","arch":"%s","step":"%s","exit_code":%s,"error_line":"%s","error_output":"%s"}' \
    "$(json_escape "$INSTALLER_REPORT_VERSION")" \
    "$(json_escape "${SQUIRREL_CHANNEL:-stable}")" \
    "$(json_escape "$os")" \
    "$(json_escape "$arch")" \
    "$(json_escape "$step")" \
    "${code:-1}" \
    "$(json_escape "$scrubbed")" \
    "$(json_escape "$scrubbed_output")")

  # Fire-and-forget: run the POST in a DETACHED subshell so it never blocks the
  # installer. `( cmd & )` backgrounds curl and lets the subshell exit
  # immediately (non-blocking); curl is reparented to init so it still gets to
  # finish after the script exits. Tight timeouts are the backstop; stdio
  # discarded so a closed pipe can't SIGPIPE it.
  ( curl "${CURL_TLS_ARGS[@]}" -fsS -m 3 --connect-timeout 2 -X POST \
      -H 'Content-Type: application/json' \
      --data "$payload" "$ERROR_ENDPOINT" >/dev/null 2>&1 & ) 2>/dev/null || true
}

# --- Killed-process diagnosis ---------------------------------------------
# A shell reports a signal-killed child as 128+signal: 137 is SIGKILL, 143 is
# SIGTERM. In the field 137 is the kernel OOM-killer taking out the bun
# standalone binary on a small VPS or a memory-capped container. It leaves
# NOTHING on stdout/stderr, so the exit code is the only evidence there is, and
# a generic "failed with exit code 137" sent users back to retry it unchanged.
SELF_INSTALL_KILL_CODES="137 143"
# Reported instead of `self_install` for these codes. The Sentry fingerprint is
# (script, step) with the exit code only in event data, so without a distinct
# step every OOM kill groups into the same issue as a real self-install bug.
SELF_INSTALL_KILLED_STEP="self_install_killed"

# Indirected so the tests can point the probe at fixtures instead of the real
# kernel interfaces. SQUIRREL_ERROR_ENDPOINT and SQUIRREL_RELEASES_ENDPOINT
# above are seamed the same way, but since #165 both are HTTPS-only: curl
# refuses a plain-http override with "Protocol http disabled", so a local
# stand-in has to serve TLS that the running curl already trusts.
CGROUP_ROOT="${SQUIRREL_CGROUP_ROOT:-/sys/fs/cgroup}"
PROC_SELF_CGROUP="${SQUIRREL_PROC_SELF_CGROUP:-/proc/self/cgroup}"
PROC_MEMINFO="${SQUIRREL_PROC_MEMINFO:-/proc/meminfo}"
# Above this, a "limit" is a not-configured sentinel rather than a real cap:
# cgroup v1 parks an uncapped controller at PAGE_COUNTER_MAX (~8 EiB).
CGROUP_LIMIT_SANITY_MAX=1099511627776 # 1TiB

is_uint() {
  case "${1:-}" in
    "" | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# True when digit-string $1 exceeds digit-string $2, compared WITHOUT bash
# arithmetic: cgroup limits routinely exceed a signed 64-bit integer (v1 writes
# UINT64_MAX for "unlimited" on many kernels), and `[ "$v" -gt ... ]` wraps on
# those, so an unlimited controller would read as a real 16-exabyte cap. Equal
# length digit strings compare correctly lexically.
uint_gt() {
  # Digits collate out of order in a handful of locales, and this decides
  # whether a cap is real, so pin the comparison.
  local LC_ALL=C
  local a="${1#"${1%%[!0]*}"}" b="${2#"${2%%[!0]*}"}"
  a="${a:-0}"
  b="${b:-0}"
  if [ "${#a}" -ne "${#b}" ]; then
    [ "${#a}" -gt "${#b}" ]
    return
  fi
  [[ "$a" > "$b" ]]
}

# This process's path within a cgroup hierarchy, selected by an awk program
# over /proc/self/cgroup. Empty when the hierarchy isn't in use.
cgroup_rel_path() {
  local program="$1"
  if [ -r "$PROC_SELF_CGROUP" ]; then
    awk -F: "$program" "$PROC_SELF_CGROUP" 2>/dev/null || true
  fi
}

# The kernel only ever writes an absolute, traversal-free path here, but this
# string is about to be concatenated into a filesystem read and fed to a loop
# that shortens it, so anything else is refused rather than followed.
is_safe_cgroup_rel() {
  case "${1:-}" in
    "") return 0 ;;
    *//* | */../* | */.. | */./* | */.) return 1 ;;
    /*) return 0 ;;
    *) return 1 ;;
  esac
}

# Headroom under one cgroup memory cap, in MiB.
#   prints a number, returns 0 -> a real cap, and this is what's left under it
#   prints nothing, returns 0 -> no cap here; the caller may look elsewhere
#   returns 1                 -> a cap exists but can't be read; the caller must
#                                stay SILENT rather than quote the host's memory
cgroup_headroom_mib() {
  local limit_file="$1" usage_file="$2" limit usage
  if [ ! -f "$limit_file" ]; then
    return 0
  fi
  limit=$(cat "$limit_file" 2>/dev/null || true)
  if ! is_uint "$limit" || uint_gt "$limit" "$CGROUP_LIMIT_SANITY_MAX"; then
    # A literal "max" (v2) or a sentinel (v1) is a genuine "uncapped"; anything
    # else here is a value we failed to understand, which is not the same thing.
    if [ "$limit" = "max" ] || is_uint "$limit"; then
      return 0
    fi
    return 1
  fi
  usage=$(cat "$usage_file" 2>/dev/null || true)
  if ! is_uint "$usage"; then
    return 1
  fi
  # Clamp rather than underflow: usage sits at or above the limit at the moment
  # of an OOM kill, and "0" is the true answer there. Compared without
  # arithmetic for the same overflow reason as the limit above; past this point
  # both values are under the sanity bound, so the subtraction is safe.
  if ! uint_gt "$limit" "$usage"; then
    printf '0'
  else
    printf '%s' "$(((limit - usage) / 1048576))"
  fi
}

# Walks from this process's own cgroup up to the mount root: a limit on an
# ancestor (a systemd slice's MemoryMax, typically) binds exactly as hard as one
# on the leaf, and the leaf is very often uncapped underneath it. The tightest
# headroom wins, and a cap anywhere in the chain that we cannot read makes the
# whole answer unknown rather than optimistic.
cgroup_tree_headroom_mib() {
  local base="$1" limit_name="$2" usage_name="$3" rel="$4"
  local best="" headroom dir previous
  while :; do
    dir="${base}${rel}"
    if headroom=$(cgroup_headroom_mib "$dir/$limit_name" "$dir/$usage_name"); then
      if [ -n "$headroom" ] && { [ -z "$best" ] || [ "$headroom" -lt "$best" ]; }; then
        best="$headroom"
      fi
    else
      return 1
    fi
    if [ -z "$rel" ]; then
      break
    fi
    # is_safe_cgroup_rel guarantees this shortens, but a loop that walks a
    # string from a file gets an explicit termination guard regardless: hanging
    # the installer would be a worse bug than the one being fixed here.
    previous="$rel"
    rel="${rel%/*}"
    if [ "$rel" = "$previous" ]; then
      break
    fi
  done
  printf '%s' "$best"
}

# Memory this process could still get, in MiB, or empty when we can't say --
# every caller must handle empty. cgroups are consulted FIRST, and a cap we can
# see but not read suppresses the answer entirely, because /proc/meminfo
# describes the HOST inside a container: it would cheerfully report gigabytes
# free moments after the kernel killed us for passing a 256MB cap.
available_memory_mib() {
  local rel headroom kib

  # cgroup v2: a single "0::<path>" line, relative to the v2 mount.
  rel=$(cgroup_rel_path '$1 == "0" { print $3; exit }')
  if [ -n "$rel" ] && is_safe_cgroup_rel "$rel"; then
    if headroom=$(cgroup_tree_headroom_mib \
      "$CGROUP_ROOT" memory.max memory.current "${rel%/}"); then
      if [ -n "$headroom" ]; then
        printf '%s' "$headroom"
        return 0
      fi
    else
      return 0
    fi
  fi

  # cgroup v1: "<n>:memory:<path>", under the memory controller's own mount.
  rel=$(cgroup_rel_path '$2 ~ /(^|,)memory(,|$)/ { print $3; exit }')
  if [ -n "$rel" ] && is_safe_cgroup_rel "$rel"; then
    if headroom=$(cgroup_tree_headroom_mib \
      "$CGROUP_ROOT/memory" memory.limit_in_bytes memory.usage_in_bytes "${rel%/}"); then
      if [ -n "$headroom" ]; then
        printf '%s' "$headroom"
        return 0
      fi
    else
      return 0
    fi
  fi

  # Demonstrably uncapped, so the host figure is the honest one. MemAvailable,
  # not MemFree: MemFree ignores reclaimable page cache and reads far too low.
  if [ -r "$PROC_MEMINFO" ]; then
    kib=$(awk '/^MemAvailable:/ { print $2; exit }' "$PROC_MEMINFO" 2>/dev/null || true)
    if is_uint "$kib"; then
      printf '%s' "$((kib / 1024))"
    fi
  fi
  return 0
}

# The step name reported for a self-install exit code: signal deaths get their
# own bucket, everything else keeps reporting as `self_install` (#1654).
self_install_step_for_code() {
  local code="$1" kill_code
  for kill_code in $SELF_INSTALL_KILL_CODES; do
    if [ "$code" = "$kill_code" ]; then
      printf '%s' "$SELF_INSTALL_KILLED_STEP"
      return 0
    fi
  done
  printf 'self_install'
}

# Names the signal behind a 128+n exit code, for the error line.
signal_name_for_code() {
  case "${1:-}" in
    137) printf 'SIGKILL' ;;
    143) printf 'SIGTERM' ;;
    *) printf 'signal %s' "$((${1:-128} - 128))" ;;
  esac
}

# The headline for a signal death. Only SIGKILL gets to assert memory: SIGTERM
# arrives from `timeout` wrappers and cancelled CI jobs too, and this whole fix
# exists because a confidently wrong diagnosis wastes the user's time.
self_install_kill_headline() {
  local code="$1" signal
  signal=$(signal_name_for_code "$code")
  if [ "$code" = 137 ]; then
    printf 'Self install was killed by the system (exit %s, %s), most likely out of memory' \
      "$code" "$signal"
  else
    printf 'Self install was stopped by a signal before it finished (exit %s, %s)' \
      "$code" "$signal"
  fi
}

# Remediation block for a signal-killed self install. Printed as error()'s
# `detail`, so it never crowds the reported error_line. Only SIGKILL gets the
# out-of-memory diagnosis and the swap recipe: SIGTERM arrives from `timeout`
# wrappers, supervisors and cancelled CI jobs at least as often, and telling
# those users to add swap would send them off fixing the wrong machine.
self_install_kill_guidance() {
  local code="$1" mib="" cause=""
  # Contained: this only ever runs on an already-failing path, so a probe that
  # trips must cost the user a memory figure, never the guidance itself.
  mib=$( (available_memory_mib) 2>/dev/null || true)

  if [ "$code" = 137 ]; then
    cause="  The download itself was fine: the binary passed its checksum, then the
  system killed it partway through installing. On a small VPS or a
  memory-capped container that is almost always the out-of-memory killer."
    if [ -n "$mib" ]; then
      cause="${cause}
  Memory available right now: ${mib} MB"
    fi
    printf '%s' "${cause}

  Give the machine more memory, then re-run this installer:
    Add 1GB of swap (usually the quickest fix on a VPS):
      sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
      sudo mkswap /swapfile && sudo swapon /swapfile
    Or resize the machine, or raise the container memory limit, to 1GB or more.

  If you cannot add memory, download the binary directly and put it on your
  PATH by hand:
    https://github.com/${REPO}/releases"
    return 0
  fi

  cause="  The download itself was fine: the binary passed its checksum, then
  something outside the installer stopped it partway through. Usually that is a
  timeout wrapper, a process supervisor, a cancelled job, or a memory limit."
  if [ -n "$mib" ]; then
    cause="${cause}
  Memory available right now: ${mib} MB"
  fi
  printf '%s' "${cause}

  Re-run the installer without a timeout or job limit around it. If it keeps
  happening, download the binary directly and put it on your PATH by hand:
    https://github.com/${REPO}/releases"
}

# --- By-hand install after a killed self install ---------------------------
# `self install` does trivial file work: copy the binary under
# ~/.squirrel/releases/<version>/, symlink it from bin_dir, record the bin dir
# in settings.json. When the kernel kills the binary before it gets to that
# work, do it here in bash, which costs nothing, then check the binary can
# actually run. A machine that cannot run `squirrel --version` gets a distinct
# step, a memory figure, and the concrete state of the install (#2023).
VERIFY_BINARY_STEP="verify_binary"
VERIFY_BINARY_KILLED_STEP="verify_binary_killed"

verify_binary_step_for_code() {
  local code="$1" kill_code
  for kill_code in $SELF_INSTALL_KILL_CODES; do
    if [ "$code" = "$kill_code" ]; then
      printf '%s' "$VERIFY_BINARY_KILLED_STEP"
      return 0
    fi
  done
  printf '%s' "$VERIFY_BINARY_STEP"
}

# The CLI reads settings from $HOME/.squirrel (apps/cli/src/self/paths.ts).
squirrel_home_dir() {
  printf '%s/.squirrel' "$HOME"
}

# True when a value can be dropped into a JSON string verbatim: printable
# ASCII with no quote or backslash. Anything else is left unrecorded rather
# than mangled — a wrong install_bin_dir sends every later `self update` to
# the wrong link (#293), a missing one falls back to the default.
is_plain_json_string() {
  # [:print:] under LC_ALL=C is exactly ASCII 0x20-0x7E (bash 3.2 does not
  # take a quoted space inside a bracket range, so no ' '-~ here).
  case "$(LC_ALL=C printf '%s' "$1" | LC_ALL=C tr -d '[:print:]')" in
    ?*) return 1 ;;
  esac
  case "$1" in
    *'"'*|*'\'*|'') return 1 ;;
  esac
  return 0
}

# Record install_bin_dir in settings.json the way `self install` does, so a
# later `self update` flips the link this installer created. Merges into an
# existing file (jq when available, a keyed substitution otherwise) and writes
# a fresh one when absent: the CLI parses settings as a partial, so a file
# holding only install_bin_dir is valid. Never fatal: prints a warning and
# returns 0, the install itself is already in place.
record_install_bin_dir() {
  local settings="$1" bin_dir="$2" tmp content
  if ! is_plain_json_string "$bin_dir"; then
    warn "Not recording the bin directory in $settings (unusual characters in the path)"
    return 0
  fi
  tmp="$settings.tmp.$$"
  if [ ! -f "$settings" ]; then
    mkdir -p "$(dirname "$settings")" 2>/dev/null || true
    if printf '{\n  "install_bin_dir": "%s"\n}\n' "$bin_dir" >"$tmp" 2>/dev/null \
        && chmod 600 "$tmp" 2>/dev/null && mv -f "$tmp" "$settings" 2>/dev/null; then
      return 0
    fi
    rm -f "$tmp" 2>/dev/null
    warn "Could not write $settings; run 'squirrel self install --bin-dir $bin_dir' later"
    return 0
  fi
  if [ "${USE_JQ:-false}" = true ]; then
    if jq --arg d "$bin_dir" '.install_bin_dir = $d' "$settings" >"$tmp" 2>/dev/null \
        && [ -s "$tmp" ] && chmod 600 "$tmp" 2>/dev/null && mv -f "$tmp" "$settings" 2>/dev/null; then
      return 0
    fi
    rm -f "$tmp" 2>/dev/null
  fi
  # No jq (or jq failed). Two shapes are handled by hand, neither through
  # pattern replacement (bash's ${var/../..} and sed both give `&` and `\` in
  # the path a meaning, and bash 3.2 mangles a `{` in the replacement): a
  # missing key is inserted after the opening brace, and a `null` value is
  # filled in. Anything else already recorded is left exactly as it is.
  content=$(cat "$settings" 2>/dev/null) || content=""
  local lead rest before after trimmed body
  lead="${content%%'{'*}"
  if [ "$lead" = "$content" ] || [ -n "${lead//[[:space:]]/}" ]; then
    warn "Could not update $settings; run 'squirrel self install --bin-dir $bin_dir' later"
    return 0
  fi
  rest="${content#*'{'}"
  case "$content" in
    *'"install_bin_dir"'*)
      before="${content%%'"install_bin_dir"'*}"
      after="${content#*'"install_bin_dir"'}"
      trimmed="${after#"${after%%[![:space:]]*}"}"
      if [ "${trimmed:0:1}" != ":" ]; then
        warn "Could not update $settings; run 'squirrel self install --bin-dir $bin_dir' later"
        return 0
      fi
      trimmed="${trimmed#:}"
      trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"
      if [ "${trimmed:0:4}" != "null" ]; then
        # A directory is already recorded. It is very likely this one (the
        # installer picks the same directory every time); if not, say so.
        if [ "$bin_dir" != "$HOME/.local/bin" ]; then
          warn "$settings already records an install directory; if it is not $bin_dir, run 'squirrel self install --bin-dir $bin_dir'"
        fi
        return 0
      fi
      content="${before}\"install_bin_dir\": \"${bin_dir}\"${trimmed#null}" ;;
    *)
      body="${rest#"${rest%%[![:space:]]*}"}"
      if [ "${body:0:1}" = "}" ]; then
        # An empty object: no trailing comma.
        content="${lead}{
  \"install_bin_dir\": \"${bin_dir}\"
${rest}"
      else
        content="${lead}{
  \"install_bin_dir\": \"${bin_dir}\",${rest}"
      fi ;;
  esac
  if printf '%s\n' "$content" >"$tmp" 2>/dev/null && chmod 600 "$tmp" 2>/dev/null \
      && mv -f "$tmp" "$settings" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null
  warn "Could not update $settings; run 'squirrel self install --bin-dir $bin_dir' later"
  return 0
}

# Lay the release out exactly as `self install` would. Prints the installed
# binary path on success. Failure (a mkdir/cp/ln error) returns non-zero with
# the reason on stderr; the caller decides how to report it.
place_release_by_hand() {
  local binary="$1" version="$2" bin_dir="$3"
  local home release_dir target link
  home=$(squirrel_home_dir)
  release_dir="$home/releases/${version#v}"
  target="$release_dir/squirrel"
  link="$bin_dir/squirrel"

  mkdir -p "$release_dir" "$bin_dir" || return 1
  # Copy to a sibling and rename over: a reader never sees a half-written binary.
  cp "$binary" "$target.tmp.$$" && chmod 755 "$target.tmp.$$" && mv -f "$target.tmp.$$" "$target" || {
    rm -f "$target.tmp.$$" 2>/dev/null
    return 1
  }
  # rm acts on the link itself, so a live, dangling or plain-file occupant all
  # go the same way (the existsSync trap from #132 applies to `-e` too).
  rm -f "$link" 2>/dev/null || true
  ln -s "$target" "$link" || return 1
  record_install_bin_dir "$home/settings.json" "$bin_dir"
  printf '%s' "$target"
}

# What to tell a user whose binary is installed but will not run. Everything
# the user needs is stated as a path or a command: nothing here says "retry".
binary_unrunnable_guidance() {
  local code="$1" target="$2" link="$3" mib="" out=""
  mib=$( (available_memory_mib) 2>/dev/null || true)
  out="  squirrel is installed, but this machine could not run it:
    Binary: ${target}
    Link:   ${link}
  Nothing needs downloading again: once the machine can run it, use it as is.
"
  if [ "$code" = 137 ]; then
    out="${out}
  The system killed it (SIGKILL), which on a small VPS or a memory-capped
  container is almost always the out-of-memory killer."
    if [ -n "$mib" ]; then
      out="${out}
  Memory available right now: ${mib} MB"
    fi
    out="${out}

  Give the machine more memory, then run: squirrel --version
    Add 1GB of swap (usually the quickest fix on a VPS):
      sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
      sudo mkswap /swapfile && sudo swapon /swapfile
    Or resize the machine, or raise the container memory limit, to 1GB or more."
    if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
      out="${out}
  On macOS, endpoint security (Santa, an MDM policy) kills binaries it has not
  approved the same way: check its log and allow ${target}."
    fi
  elif [ "$code" = 143 ]; then
    out="${out}
  Something outside the installer stopped it (SIGTERM): a timeout wrapper, a
  process supervisor or a cancelled job. Run it again outside that limit:
    squirrel --version"
  else
    out="${out}
  Run it yourself to see the failure:
    ${link} --version"
  fi
  out="${out}

  Cannot change this machine? Audits also run from the cloud dashboard, with
  no binary at all: https://app.squirrelscan.com"
  printf '%s' "$out"
}

# Single EXIT trap: cleans the temp dir and reports genuine failures. Replaces
# the per-call tmpdir trap (a second `trap ... EXIT` would clobber this one).
report_on_exit() {
  local code=$?
  set +e  # cleanup/reporting must never derail the exit path
  [ -n "$TMPDIR_TO_CLEAN" ] && rm -rf "$TMPDIR_TO_CLEAN"
  # Prefer the in-process message; fall back to the file for subshell failures.
  local msg="$LAST_ERROR_MSG"
  if [ -z "$msg" ] && [ -n "${ERROR_MSG_FILE:-}" ] && [ -f "$ERROR_MSG_FILE" ]; then
    msg=$(cat "$ERROR_MSG_FILE" 2>/dev/null)
  fi
  [ -n "${ERROR_MSG_FILE:-}" ] && rm -f "$ERROR_MSG_FILE"
  [ "$code" -eq 0 ] && return 0
  # error() always exits 1; prefer the failing sub-command's own code when the
  # call site recorded one (self install, which runs under tee).
  [ -n "$LAST_ERROR_CODE" ] && code="$LAST_ERROR_CODE"
  report_error "$CURRENT_STEP" "$code" "$msg" "$LAST_ERROR_OUTPUT"
}
trap report_on_exit EXIT

# --- Banner ---------------------------------------------------------------
# Blocky lowercase "squirrelscan" wordmark, matching the CLI's own banner
# (apps/cli/src/cli/banner.ts) instead of the old camel-case figlet art.
# BANNER_ART_COLOR is a precomputed copy of that file's gradient-string
# output for the autumn palette (#CD853F -> #D2691E -> #8B4513 -> #A0522D) --
# this installer has no Node/gradient-string available at curl|bash time.
BANNER_ART_PLAIN=' ▄█▀ ▄▀█ █ █ █ █▀▄ █▀▄ █▀▀ █   ▄█▀ ▄▀▀ ▄▀█ █▄ █
 ▀▄  █ █ █ █ █ ██▀ ██▀ █▀  █   ▀▄  █   █▀█ █ ▀█
 █▄▀ ▀▀█ ▀▄▀ █ █ █ █ █ █▄▄ █▄▄ █▄▀ ▀▄▄ █ █ █  █'

BANNER_ART_COLOR=$' \033[38;2;205;133;63m▄\033[39m\033[38;2;205;132;62m█\033[39m\033[38;2;205;131;61m▀\033[39m \033[38;2;206;130;60m▄\033[39m\033[38;2;206;129;58m▀\033[39m\033[38;2;206;128;57m█\033[39m \033[38;2;206;127;56m█\033[39m \033[38;2;206;126;55m█\033[39m \033[38;2;206;125;54m█\033[39m \033[38;2;207;124;53m█\033[39m\033[38;2;207;123;52m▀\033[39m\033[38;2;207;122;50m▄\033[39m \033[38;2;207;121;49m█\033[39m\033[38;2;207;120;48m▀\033[39m\033[38;2;207;119;47m▄\033[39m \033[38;2;208;119;46m█\033[39m\033[38;2;208;118;45m▀\033[39m\033[38;2;208;117;44m▀\033[39m \033[38;2;208;116;43m█\033[39m   \033[38;2;208;115;41m▄\033[39m\033[38;2;208;114;40m█\033[39m\033[38;2;209;113;39m▀\033[39m \033[38;2;209;112;38m▄\033[39m\033[38;2;209;111;37m▀\033[39m\033[38;2;209;110;36m▀\033[39m \033[38;2;209;109;35m▄\033[39m\033[38;2;209;108;33m▀\033[39m\033[38;2;210;107;32m█\033[39m \033[38;2;210;106;31m█\033[39m\033[38;2;210;105;30m▄\033[39m \033[38;2;207;104;30m█\033[39m\n \033[38;2;205;102;29m▀\033[39m\033[38;2;202;101;29m▄\033[39m  \033[38;2;200;100;28m█\033[39m \033[38;2;197;99;28m█\033[39m \033[38;2;195;97;28m█\033[39m \033[38;2;192;96;27m█\033[39m \033[38;2;190;95;27m█\033[39m \033[38;2;187;93;26m█\033[39m\033[38;2;185;92;26m█\033[39m\033[38;2;182;91;26m▀\033[39m \033[38;2;180;90;25m█\033[39m\033[38;2;177;88;25m█\033[39m\033[38;2;175;87;25m▀\033[39m \033[38;2;172;86;24m█\033[39m\033[38;2;169;84;24m▀\033[39m  \033[38;2;167;83;23m█\033[39m   \033[38;2;164;82;23m▀\033[39m\033[38;2;162;81;23m▄\033[39m  \033[38;2;159;79;22m█\033[39m   \033[38;2;157;78;22m█\033[39m\033[38;2;154;77;21m▀\033[39m\033[38;2;152;75;21m█\033[39m \033[38;2;149;74;21m█\033[39m \033[38;2;147;73;20m▀\033[39m\033[38;2;144;72;20m█\033[39m\n \033[38;2;142;70;19m█\033[39m\033[38;2;139;69;19m▄\033[39m\033[38;2;140;69;20m▀\033[39m \033[38;2;141;70;21m▀\033[39m\033[38;2;141;70;22m▀\033[39m\033[38;2;142;71;23m█\033[39m \033[38;2;143;71;24m▀\033[39m\033[38;2;144;72;25m▄\033[39m\033[38;2;144;72;26m▀\033[39m \033[38;2;145;73;26m█\033[39m \033[38;2;146;73;27m█\033[39m \033[38;2;147;74;28m█\033[39m \033[38;2;147;74;29m█\033[39m \033[38;2;148;75;30m█\033[39m \033[38;2;149;75;31m█\033[39m\033[38;2;150;76;32m▄\033[39m\033[38;2;150;76;33m▄\033[39m \033[38;2;151;76;34m█\033[39m\033[38;2;152;77;35m▄\033[39m\033[38;2;153;77;36m▄\033[39m \033[38;2;153;78;37m█\033[39m\033[38;2;154;78;38m▄\033[39m\033[38;2;155;79;39m▀\033[39m \033[38;2;156;79;39m▀\033[39m\033[38;2;156;80;40m▄\033[39m\033[38;2;157;80;41m▄\033[39m \033[38;2;158;81;42m█\033[39m \033[38;2;159;81;43m█\033[39m \033[38;2;159;82;44m█\033[39m  \033[38;2;160;82;45m█\033[39m'

BANNER_TEXT_FALLBACK='squirrelscan'

# Half-block glyphs need a UTF-8 locale to render correctly; CI logs and
# dumb terminals often run C/POSIX. Fall back to plain text there.
is_utf8_locale() {
  local charmap=""
  if command -v locale >/dev/null 2>&1; then
    charmap=$(locale charmap 2>/dev/null || true)
  fi
  case "$charmap" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) return 0 ;;
  esac
  local loc="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
  case "$loc" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) return 0 ;;
    *) return 1 ;;
  esac
}

print_banner() {
  echo ""
  if ! is_utf8_locale; then
    echo "  $BANNER_TEXT_FALLBACK"
  elif [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    printf '%s\n' "$BANNER_ART_COLOR"
  else
    printf '%s\n' "$BANNER_ART_PLAIN"
  fi
  echo ""
}

# Check for required commands
check_deps() {
  command -v curl >/dev/null 2>&1 || error "curl is required but not installed"

  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not found, using grep fallback (less reliable)"
    USE_JQ=false
  else
    USE_JQ=true
  fi
}

# Compute SHA256 checksum with fallbacks
compute_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    error "No SHA256 tool found (need sha256sum, shasum, or openssl)"
  fi
}

# Fetch with retry and timeout
fetch_with_retry() {
  local url="$1"
  local output="$2"
  local attempts=3
  local timeout_connect=10
  local timeout_max=120

  for i in $(seq 1 $attempts); do
    if curl "${CURL_TLS_ARGS[@]}" -fsSL --connect-timeout "$timeout_connect" --max-time "$timeout_max" "$url" -o "$output" 2>/dev/null; then
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then
      warn "Download failed, retrying ($i/$attempts)..."
      sleep 2
    fi
  done
  return 1
}

# --- Release asset download (two sources) ---------------------------------
# GitHub is the origin and always has every asset, so it is tried first; the
# mirror at DOWNLOAD_ENDPOINT proxies the same bytes through Cloudflare, which
# reaches GitHub even when the client cannot. The manifest's sha256 is verified
# over whatever comes back either way, so a second source adds no trust.
#
# A mirror that answers 404 is treated as "nothing here", which is also what a
# worker deployed before the route existed answers: the script degrades to the
# GitHub failure it would have reported anyway rather than breaking.
DOWNLOAD_URL_GITHUB=""
DOWNLOAD_URL_MIRROR=""
DOWNLOAD_SOURCE=""

# Opt-in flag semantics, matching the CLI's SQUIRREL_NO_UPDATE: empty, 0 and
# false are off, anything else is on. Presence semantics (as NO_TELEMETRY uses)
# would make a stray `SQUIRREL_FORCE_MIRROR=` in a profile silently reroute
# every install.
force_mirror_enabled() {
  local value
  value=$(printf '%s' "${SQUIRREL_FORCE_MIRROR:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case "$value" in
    "" | 0 | false) return 1 ;;
    *) return 0 ;;
  esac
}

# fetch_release_asset <version> <asset> <output> <label>
# Leaves both attempted URLs in DOWNLOAD_URL_GITHUB / DOWNLOAD_URL_MIRROR for
# the failure report, and the winner in DOWNLOAD_SOURCE.
fetch_release_asset() {
  local version="$1" asset="$2" output="$3" label="$4"

  DOWNLOAD_URL_GITHUB="https://github.com/${REPO}/releases/download/${version}/${asset}"
  DOWNLOAD_URL_MIRROR="${DOWNLOAD_ENDPOINT}/${version}/${asset}"
  DOWNLOAD_SOURCE=""

  if force_mirror_enabled; then
    info "SQUIRREL_FORCE_MIRROR is set, skipping github.com"
  elif fetch_with_retry "$DOWNLOAD_URL_GITHUB" "$output"; then
    DOWNLOAD_SOURCE="github.com"
    return 0
  else
    warn "github.com could not serve the $label, trying install.squirrelscan.com..."
  fi

  if fetch_with_retry "$DOWNLOAD_URL_MIRROR" "$output"; then
    DOWNLOAD_SOURCE="install.squirrelscan.com"
    return 0
  fi
  return 1
}

# Strip `user:password@` out of a URL before it is printed or reported.
# SQUIRREL_DOWNLOAD_ENDPOINT is user-supplied and can carry credentials, and the
# report scrubber removes home paths and clamps length — it knows nothing about
# URL userinfo, so a mirror set to https://user:token@host would otherwise send
# that token to the reporting endpoint verbatim.
redact_url_credentials() {
  printf '%s' "$1" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@]*@#\1#'
}

# Single-quote a value so the recipe we print is copy-pasteable even when the
# path holds a space or a shell metacharacter. A literal quote inside closes the
# string, escapes, and reopens: it's -> 'it'\''s'.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# The report line and the user-facing guidance for a download that ran out of
# sources. error() carries the first to Sentry (clamped to ERROR_LINE_MAX, which
# two full URLs would blow past) and prints the second to the user only; the
# URLs themselves ride along in error_output, which has room for them.
#
# The line names the hosts AND the way out, because it is the one line that
# reaches both the user's terminal and the Sentry issue title area — the
# guidance below it is local only.
download_failure_report_line() {
  local label="$1"
  if force_mirror_enabled; then
    echo "Failed to download the $label from install.squirrelscan.com (SQUIRREL_FORCE_MIRROR is set, github.com was skipped)"
  else
    echo "Failed to download the $label from github.com and install.squirrelscan.com (retry with SQUIRREL_FORCE_MIRROR=1 to skip github.com)"
  fi
}

# Skipped is not failed: with SQUIRREL_FORCE_MIRROR set we never asked GitHub,
# and a report claiming we did would send whoever reads it after the wrong host.
download_failure_output() {
  if force_mirror_enabled; then
    printf 'skipped %s (SQUIRREL_FORCE_MIRROR)\ntried %s (failed)\n' \
      "$(redact_url_credentials "$DOWNLOAD_URL_GITHUB")" \
      "$(redact_url_credentials "$DOWNLOAD_URL_MIRROR")"
  else
    printf 'tried %s (failed)\ntried %s (failed)\n' \
      "$(redact_url_credentials "$DOWNLOAD_URL_GITHUB")" \
      "$(redact_url_credentials "$DOWNLOAD_URL_MIRROR")"
  fi
}

# download_failure_guidance <asset> <kind> <bin_dir>
# `kind` is `binary` or `manifest`: only the binary has a by-hand recipe worth
# printing, because only the binary is the thing the user ultimately needs on
# disk. Telling someone to move a manifest.json to ~/.local/bin/squirrel would
# be worse than saying nothing. `bin_dir` is the directory this run actually
# resolved, so the recipe names the same place a successful install would use.
download_failure_guidance() {
  local asset="$1" kind="$2" bin_dir="$3" quoted_bin_dir
  quoted_bin_dir=$(shell_quote "$bin_dir")
  echo "  Tried:"
  if force_mirror_enabled; then
    echo "    github.com               skipped (SQUIRREL_FORCE_MIRROR is set)"
  else
    echo "    github.com               $(redact_url_credentials "$DOWNLOAD_URL_GITHUB")"
  fi
  echo "    install.squirrelscan.com $(redact_url_credentials "$DOWNLOAD_URL_MIRROR")"
  echo ""
  if ! force_mirror_enabled; then
    # The variable has to reach the bash that runs the SCRIPT, not the curl
    # that fetches it, so it goes on the right-hand side of the pipe.
    echo "  If github.com is blocked on this network, skip it and retry:"
    echo "    curl -fsSL https://install.squirrelscan.com | SQUIRREL_FORCE_MIRROR=1 bash"
    echo ""
  fi
  if [ "$kind" = binary ]; then
    echo "  If both hosts are blocked, download $asset on a machine that can"
    echo "  reach one of them, copy it here, then:"
    echo "    chmod +x $asset && mkdir -p $quoted_bin_dir && mv $asset $(shell_quote "$bin_dir/squirrel")"
  else
    echo "  If both hosts are blocked, this machine cannot reach anywhere the"
    echo "  release is published. Allowlist github.com or install.squirrelscan.com,"
    echo "  or install from a network that already reaches one of them."
  fi
}

# Detect libc (glibc vs musl)
detect_libc() {
  # Method 1: Check for musl loader (most reliable)
  if ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
    echo "-musl"
    return
  fi

  # Method 2: Check Alpine release file
  if [ -f /etc/alpine-release ]; then
    echo "-musl"
    return
  fi

  # Method 3: ldd version string
  if command -v ldd >/dev/null 2>&1; then
    if ldd --version 2>&1 | grep -qi musl; then
      echo "-musl"
      return
    fi
  fi

  # Default: glibc (no suffix)
  echo ""
}

# Detect platform and architecture
detect_platform() {
  local os arch libc=""

  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)

  case "$os" in
    darwin) os="darwin" ;;
    linux)
      os="linux"
      libc=$(detect_libc)
      ;;
    freebsd)
      error "FreeBSD is not yet supported. See: https://github.com/${REPO}/issues"
      ;;
    mingw*|msys*|cygwin*)
      error "This installer is for macOS/Linux. On Windows, run this in PowerShell instead:\n  powershell -c \"irm https://install.squirrelscan.com/install.ps1 | iex\"\n  Or download manually from: https://github.com/${REPO}/releases"
      ;;
    *) error "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $arch" ;;
  esac

  echo "${os}-${arch}${libc}"
}

# Ensure the musl C++ runtime is present.
# bun's musl --compile binary dynamically links libstdc++.so.6 + libgcc_s.so.1,
# which a bare Alpine image lacks — without them the binary can't even run
# `self install`. Auto-install as root via apk; otherwise print the exact
# command and exit cleanly (better than a wall of relocation errors).
ensure_musl_runtime() {
  # Already resolvable by the musl loader (/lib or /usr/lib)?
  if ls /usr/lib/libstdc++.so.6 >/dev/null 2>&1 ||
    ls /lib/libstdc++.so.6 >/dev/null 2>&1; then
    return 0
  fi

  if command -v apk >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    log "Installing required runtime library (libstdc++)..."
    if apk add --no-cache libstdc++ >/dev/null 2>&1; then
      info "Installed libstdc++"
      return 0
    fi
    warn "Auto-install of libstdc++ failed"
  fi

  # Non-root, no apk, or apk failed → clear, actionable instructions.
  warn "squirrel needs libstdc++ to run on Alpine/musl."
  if command -v apk >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ]; then
      echo "  Install it, then re-run the installer:" >&2
      echo "      apk add libstdc++" >&2
    else
      echo "  Install it, then re-run the installer:" >&2
      echo "      sudo apk add libstdc++" >&2
    fi
  else
    echo "  Install libstdc++ (and libgcc) with your package manager, then re-run." >&2
  fi
  error "Missing libstdc++ (required by the musl build)"
}

# Find a writable bin directory that's in PATH
find_bin_dir() {
  # If user explicitly set bin dir, use it
  if [ -n "${SQUIRREL_BIN_DIR:-}" ]; then
    mkdir -p "$SQUIRREL_BIN_DIR" 2>/dev/null || true
    if [ -d "$SQUIRREL_BIN_DIR" ] && [ -w "$SQUIRREL_BIN_DIR" ]; then
      echo "$SQUIRREL_BIN_DIR"
      return 0
    else
      warn "SQUIRREL_BIN_DIR=$SQUIRREL_BIN_DIR is not writable, searching PATH..."
    fi
  fi

  # Priority order of common bin directories
  local common_dirs=(
    "$HOME/.local/bin"      # XDG standard
    "$HOME/bin"             # Traditional user bin
    "/usr/local/bin"        # System-wide
    "/opt/homebrew/bin"     # macOS ARM Homebrew
  )

  # Parse PATH into array
  local path_dirs
  IFS=':' read -ra path_dirs <<< "$PATH"

  # First: check if any common dir is already in PATH and writable
  for dir in "${common_dirs[@]}"; do
    for path_dir in "${path_dirs[@]}"; do
      if [ "$dir" = "$path_dir" ]; then
        if [ -d "$dir" ] && [ -w "$dir" ]; then
          echo "$dir"
          return 0
        elif [ ! -e "$dir" ]; then
          # Directory doesn't exist but parent might be writable
          local parent
          parent=$(dirname "$dir")
          if [ -w "$parent" ]; then
            mkdir -p "$dir" 2>/dev/null && echo "$dir" && return 0
          fi
        fi
      fi
    done
  done

  # Fallback: create ~/.local/bin (will need PATH modification)
  mkdir -p "$HOME/.local/bin" 2>/dev/null
  echo "$HOME/.local/bin"
  return 1  # Signal that PATH update needed
}

# JSON value extraction with grep fallback
json_get() {
  local json="$1" key="$2"
  echo "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | \
    sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/' | head -1
}

# JSON nested value extraction (for binaries["platform"])
json_get_nested() {
  local json="$1" outer="$2" inner="$3"
  # Extract the outer block first, then the inner value
  local block
  block=$(echo "$json" | tr '\n' ' ' | grep -o "\"$outer\"[[:space:]]*:[[:space:]]*{[^}]*}" | head -1)
  echo "$block" | grep -o "\"$inner\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | \
    sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/' | head -1
}

# Get latest release version.
# Primary: install.squirrelscan.com/releases/{channel} — R2-backed release
# metadata with no rate limits. Fallback: the GitHub API, which anonymous
# clients share at 60 req/hr per IP — corporate NAT/VPN/CI egress hits 403s.
get_latest_version() {
  local channel="${1:-stable}"
  local api_url="https://api.github.com/repos/${REPO}/releases"
  local response version=""

  info "Fetching releases (channel: $channel)..."

  if response=$(curl "${CURL_TLS_ARGS[@]}" -fsSL -H "User-Agent: squirrelscan-installer" \
      --connect-timeout 5 --max-time 15 \
      "${RELEASES_ENDPOINT}/${channel}" 2>/dev/null); then
    if [ "$USE_JQ" = true ]; then
      version=$(echo "$response" | jq -r '.version // empty')
    else
      version=$(json_get "$response" "version")
    fi
    if [ -n "$version" ]; then
      # Manifest versions are bare ("0.0.73"); release tags carry the v prefix.
      echo "v${version#v}"
      return 0
    fi
  fi
  warn "Release metadata endpoint unavailable, falling back to GitHub API..."

  # Build curl args - add auth header if GITHUB_TOKEN is set (avoids rate limits)
  local curl_args=("${CURL_TLS_ARGS[@]}" -fsSL -H "User-Agent: squirrelscan-installer" --connect-timeout 10 --max-time 30)
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl_args+=(-H "Authorization: token $GITHUB_TOKEN")
  fi

  if ! response=$(curl "${curl_args[@]}" "$api_url" 2>&1); then
    error "Failed to fetch releases\n  URL: $api_url\n  Response: $response"
  fi

  if [ -z "$response" ] || [ "$response" = "[]" ]; then
    error "No releases found\n  Check: https://github.com/${REPO}/releases"
  fi

  version=""
  if [ "$USE_JQ" = true ]; then
    if [ "$channel" = "stable" ]; then
      version=$(echo "$response" | jq -r '[.[] | select(.prerelease == false)] | .[0].tag_name // empty')
    else
      version=$(echo "$response" | jq -r '.[0].tag_name // empty')
    fi
  else
    # Grep fallback - just get first tag (works for beta, imprecise for stable)
    version=$(echo "$response" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
  fi

  echo "$version"
}

# Download binary and run self install
download_and_install() {
  local version="$1"
  local platform="$2"
  local bin_dir="$3"
  local tmpdir

  tmpdir=$(mktemp -d)
  # Cleaned by the EXIT trap (report_on_exit) — do NOT set a local EXIT trap
  # here or it clobbers the failure-reporting trap.
  TMPDIR_TO_CLEAN="$tmpdir"

  # Download manifest to get binary filename and checksum
  CURRENT_STEP="download_manifest"
  log "Downloading manifest..."
  if ! fetch_release_asset "$version" "manifest.json" "$tmpdir/manifest.json" "manifest"; then
    LAST_ERROR_OUTPUT=$(download_failure_output)
    error "$(download_failure_report_line manifest)" "$(download_failure_guidance manifest.json manifest "$bin_dir")"
  fi

  # Read manifest content
  local manifest
  manifest=$(cat "$tmpdir/manifest.json")

  # Extract binary info
  local filename sha256
  if [ "$USE_JQ" = true ]; then
    filename=$(echo "$manifest" | jq -r ".binaries[\"${platform}\"].filename // empty")
    sha256=$(echo "$manifest" | jq -r ".binaries[\"${platform}\"].sha256 // empty")
  else
    filename=$(json_get_nested "$manifest" "$platform" "filename")
    sha256=$(json_get_nested "$manifest" "$platform" "sha256")
  fi

  if [ -z "$filename" ] || [ -z "$sha256" ]; then
    error "No binary for platform: $platform\n  See: https://github.com/${REPO}/releases/tag/${version}"
  fi

  # Download binary
  CURRENT_STEP="download_binary"
  log "Downloading squirrel ${version}..."
  if ! fetch_release_asset "$version" "$filename" "$tmpdir/squirrel" "binary"; then
    LAST_ERROR_OUTPUT=$(download_failure_output)
    error "$(download_failure_report_line binary)" "$(download_failure_guidance "$filename" binary "$bin_dir")"
  fi
  info "Downloaded from ${DOWNLOAD_SOURCE}"

  # Verify checksum
  CURRENT_STEP="verify_checksum"
  log "Verifying checksum..."
  local actual_sha256
  actual_sha256=$(compute_sha256 "$tmpdir/squirrel")

  if [ "$actual_sha256" != "$sha256" ]; then
    error "Checksum mismatch!\n  Expected: ${sha256}\n  Actual:   ${actual_sha256}"
  fi
  info "Checksum verified: ${sha256:0:16}..."

  # Make executable and run self install with bin dir
  chmod +x "$tmpdir/squirrel"

  CURRENT_STEP="self_install"
  log "Running self install..."
  # Tee rather than run bare: the user still sees the output live, and a failure
  # can report what the binary actually said instead of a bare exit code
  # (#1538). PIPESTATUS[0] is the binary's code, not tee's.
  local self_install_log="$tmpdir/self-install.log"
  set +e
  # Stamp the install channel for the CLI's one-time install registration
  # (self/install-meta.ts honors SQUIRREL_INSTALL_SOURCE; without it the
  # managed-dir binary self-reports as the ambiguous "binary"). A caller's own
  # value wins so wrappers (CI, package managers) can name themselves.
  SQUIRREL_INSTALL_SOURCE="${SQUIRREL_INSTALL_SOURCE:-install.sh}" \
    "$tmpdir/squirrel" self install --bin-dir "$bin_dir" 2>&1 | tee "$self_install_log"
  local rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -ne 0 ]; then
    # Last lines, not last bytes: a byte cut can split a $HOME path so the
    # scrubber no longer recognizes it and the username rides along. The tail
    # is where the failure is; report_error scrubs and clamps what we pass.
    LAST_ERROR_OUTPUT=$(tail -n 40 "$self_install_log" 2>/dev/null || true)
    LAST_ERROR_CODE="$rc"
    # A signal death is not a self-install bug: the binary never got to fail on
    # its own terms. Move it to its own step so it reports, and fingerprints,
    # apart from real failures (#1654), then finish the install by hand: the
    # file work needs no memory, and a binary that only died mid-install can
    # still run (#2023).
    CURRENT_STEP=$(self_install_step_for_code "$rc")
    if [ "$CURRENT_STEP" = "$SELF_INSTALL_KILLED_STEP" ]; then
      install_by_hand_and_verify "$tmpdir/squirrel" "$version" "$bin_dir" "$rc"
      return 0
    fi
    error "Self install failed with exit code $rc"
  fi
}

# Recovery path for a signal-killed self install: place the files from bash,
# then prove the binary runs. Reports under self_install_killed when even the
# file work fails, and under verify_binary / verify_binary_killed when the
# files are in place but the binary will not execute.
install_by_hand_and_verify() {
  local binary="$1" version="$2" bin_dir="$3" kill_rc="$4"
  local target link

  warn "$(self_install_kill_headline "$kill_rc")"
  log "Finishing the install by hand..."
  if ! target=$(place_release_by_hand "$binary" "$version" "$bin_dir"); then
    LAST_ERROR_CODE="$kill_rc"
    error "$(self_install_kill_headline "$kill_rc")" "$(self_install_kill_guidance "$kill_rc")"
  fi
  link="$bin_dir/squirrel"
  info "Binary: $target"
  info "Link:   $link"

  CURRENT_STEP="$VERIFY_BINARY_STEP"
  log "Checking the installed binary runs..."
  local verify_log="$TMPDIR_TO_CLEAN/verify.log"
  set +e
  "$link" --version 2>&1 | tee "$verify_log"
  local rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -ne 0 ]; then
    LAST_ERROR_OUTPUT=$(tail -n 40 "$verify_log" 2>/dev/null || true)
    LAST_ERROR_CODE="$rc"
    CURRENT_STEP=$(verify_binary_step_for_code "$rc")
    error "squirrel is installed at $target but cannot run on this machine (exit $rc)" \
      "$(binary_unrunnable_guidance "$rc" "$target" "$link")"
  fi
  info "Installed by hand after self install was killed (exit $kill_rc); the binary runs."
  echo "  If 'squirrel audit' is killed the same way, the machine needs more memory:" >&2
  echo "    sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile" >&2
}

# Detect user's shell and config file
detect_shell_config() {
  local shell="${SHELL:-}"

  # Try to detect from SHELL env var
  if [ -n "$shell" ]; then
    case "$shell" in
      */zsh)  echo "zsh:$HOME/.zshrc" ;;
      */bash)
        # Prefer .bashrc, but use .bash_profile on macOS if .bashrc doesn't exist
        if [ -f "$HOME/.bashrc" ]; then
          echo "bash:$HOME/.bashrc"
        elif [ -f "$HOME/.bash_profile" ]; then
          echo "bash:$HOME/.bash_profile"
        else
          echo "bash:$HOME/.bashrc"
        fi
        ;;
      */fish) echo "fish:$HOME/.config/fish/config.fish" ;;
      */sh)   echo "sh:$HOME/.profile" ;;
      *)      echo "unknown:$HOME/.profile" ;;
    esac
    return
  fi

  # Fallback: check which shell configs exist
  if [ -f "$HOME/.zshrc" ]; then
    echo "zsh:$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    echo "bash:$HOME/.bashrc"
  elif [ -f "$HOME/.bash_profile" ]; then
    echo "bash:$HOME/.bash_profile"
  else
    echo "unknown:$HOME/.profile"
  fi
}

# Get-started epilogue: one scannable next-steps block instead of the old
# scattered "Tip:"/"Installation complete!"/skill-hint tail (#1029).
# "squirrel skills install" is the canonical path (installs both skills,
# no --skill filter); the npx fallback line stays copy-paste-able for
# docs/agents that can't shell out to the freshly-installed binary.
print_epilogue() {
  local version="$1"
  # Same UTF-8 gate as the banner -- CI logs / dumb terminals shouldn't get
  # mojibake from the checkmark/arrow glyphs either (codex review, #1029).
  local check="✓" arrow="→"
  if ! is_utf8_locale; then
    check="v"
    arrow="->"
  fi
  echo ""
  echo -e "${GREEN}${check}${NC} squirrel ${version} installed"
  echo ""
  echo "Get started:"
  echo "  1. Run your first audit:   squirrel audit https://your-site.com"
  echo "  2. Add agent skills:       squirrel skills install   (Claude Code, Cursor, Codex, ...)"
  echo "                             or: npx skills add squirrelscan/skills -y -g"
  echo "  3. Unlock cloud audits:    squirrel auth login       ${arrow} https://squirrelscan.com/login"
  echo "  Shell completions:         squirrel self completion <bash|zsh|fish>"
  echo "  Docs: https://docs.squirrelscan.com"
  echo ""
}

# Print shell profile instructions
print_path_instructions() {
  local bin_dir="$1"
  local shell_info rc_file shell_name

  shell_info=$(detect_shell_config)
  shell_name="${shell_info%%:*}"
  rc_file="${shell_info#*:}"

  warn "$bin_dir is not in your PATH"
  echo ""

  case "$shell_name" in
    fish)
      echo "Add to $rc_file:"
      echo ""
      echo "  fish_add_path $bin_dir"
      echo ""
      echo "Or run now:"
      echo ""
      echo "  echo 'fish_add_path $bin_dir' >> $rc_file && source $rc_file"
      ;;
    zsh|bash|sh|unknown)
      echo "Add to $rc_file:"
      echo ""
      echo "  export PATH=\"$bin_dir:\$PATH\""
      echo ""
      echo "Or run now:"
      echo ""
      echo "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> $rc_file && source $rc_file"
      ;;
  esac

  echo ""
  echo "After updating PATH, verify with: squirrel self doctor"
}

main() {
  local channel="${SQUIRREL_CHANNEL:-stable}"

  print_banner

  log "Installing squirrel..."

  CURRENT_STEP="check_deps"
  check_deps

  local platform version bin_dir needs_path_update=false
  CURRENT_STEP="detect_platform"
  platform=$(detect_platform)
  log "Detected platform: $platform"

  # musl builds need libstdc++ at runtime — ensure it before we exec the binary.
  case "$platform" in
    *-musl) CURRENT_STEP="musl_runtime"; ensure_musl_runtime ;;
  esac

  # Find writable bin directory in PATH
  CURRENT_STEP="find_bin_dir"
  if ! bin_dir=$(find_bin_dir); then
    needs_path_update=true
  fi
  info "Bin directory: $bin_dir"

  # Version: pinned or latest
  if [ -n "${SQUIRREL_VERSION:-}" ]; then
    version="$SQUIRREL_VERSION"
    log "Installing pinned version: $version"
  else
    CURRENT_STEP="fetch_releases"
    version=$(get_latest_version "$channel")
    if [ -z "$version" ]; then
      if [ "$channel" = "stable" ]; then
        error "No stable releases found. Try:\n  SQUIRREL_CHANNEL=beta curl -fsSL ... | bash"
      else
        error "No releases found for channel '$channel'\n  Check: https://github.com/${REPO}/releases"
      fi
    fi
    log "Latest version: $version (channel: $channel)"
  fi

  download_and_install "$version" "$platform" "$bin_dir"

  print_epilogue "$version"

  # Print PATH instructions if needed
  if [ "$needs_path_update" = true ]; then
    echo ""
    print_path_instructions "$bin_dir"
  fi

  echo ""
}

main "$@"
