#!/bin/bash
set -euo pipefail

# SquirrelScan installer
# Usage: curl -fsSL https://install.squirrelscan.com/install.sh | bash
# Or: curl -fsSL https://raw.githubusercontent.com/squirrelscan/squirrelscan/main/install.sh | bash
#
# Environment variables:
#   SQUIRREL_VERSION   - Pin to specific version (e.g., v0.0.15)
#   SQUIRREL_CHANNEL   - Release channel: stable or beta (default: stable)
#   SQUIRREL_BIN_DIR   - Override bin directory for symlink
#   GITHUB_TOKEN       - GitHub token to avoid API rate limits (optional)

REPO="squirrelscan/squirrelscan"

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
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
info() { echo -e "${BLUE}::${NC} $1" >&2; }

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
    if curl -fsSL --connect-timeout "$timeout_connect" --max-time "$timeout_max" "$url" -o "$output" 2>/dev/null; then
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then
      warn "Download failed, retrying ($i/$attempts)..."
      sleep 2
    fi
  done
  return 1
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
      error "Windows is not supported via this installer. Download manually from:\n  https://github.com/${REPO}/releases"
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

# Get latest release version
get_latest_version() {
  local channel="${1:-stable}"
  local api_url="https://api.github.com/repos/${REPO}/releases"
  local response

  info "Fetching releases (channel: $channel)..."

  # Build curl args - add auth header if GITHUB_TOKEN is set (avoids rate limits)
  local curl_args=(-fsSL -H "User-Agent: squirrelscan-installer" --connect-timeout 10 --max-time 30)
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl_args+=(-H "Authorization: token $GITHUB_TOKEN")
  fi

  if ! response=$(curl "${curl_args[@]}" "$api_url" 2>&1); then
    error "Failed to fetch releases\n  URL: $api_url\n  Response: $response"
  fi

  if [ -z "$response" ] || [ "$response" = "[]" ]; then
    error "No releases found\n  Check: https://github.com/${REPO}/releases"
  fi

  local version=""
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
  trap "rm -rf '$tmpdir'" EXIT

  local release_url="https://github.com/${REPO}/releases/download/${version}"

  # Download manifest to get binary filename and checksum
  log "Downloading manifest..."
  local manifest_url="${release_url}/manifest.json"
  if ! fetch_with_retry "$manifest_url" "$tmpdir/manifest.json"; then
    error "Failed to download manifest\n  URL: $manifest_url"
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
  log "Downloading squirrel ${version}..."
  local binary_url="${release_url}/${filename}"
  if ! fetch_with_retry "$binary_url" "$tmpdir/squirrel"; then
    error "Failed to download binary\n  URL: $binary_url"
  fi

  # Verify checksum
  log "Verifying checksum..."
  local actual_sha256
  actual_sha256=$(compute_sha256 "$tmpdir/squirrel")

  if [ "$actual_sha256" != "$sha256" ]; then
    error "Checksum mismatch!\n  Expected: ${sha256}\n  Actual:   ${actual_sha256}"
  fi
  info "Checksum verified: ${sha256:0:16}..."

  # Make executable and run self install with bin dir
  chmod +x "$tmpdir/squirrel"

  log "Running self install..."
  "$tmpdir/squirrel" self install --bin-dir "$bin_dir"
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

  check_deps

  local platform version bin_dir needs_path_update=false
  platform=$(detect_platform)
  log "Detected platform: $platform"

  # musl builds need libstdc++ at runtime — ensure it before we exec the binary.
  case "$platform" in
    *-musl) ensure_musl_runtime ;;
  esac

  # Find writable bin directory in PATH
  if ! bin_dir=$(find_bin_dir); then
    needs_path_update=true
  fi
  info "Bin directory: $bin_dir"

  # Version: pinned or latest
  if [ -n "${SQUIRREL_VERSION:-}" ]; then
    version="$SQUIRREL_VERSION"
    log "Installing pinned version: $version"
  else
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
