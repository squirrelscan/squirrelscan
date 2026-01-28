#!/bin/bash
set -euo pipefail

# SquirrelScan installer
# Usage: curl -fsSL https://squirrelscan.com/install.sh | bash
# Or: curl -fsSL https://raw.githubusercontent.com/squirrelscan/squirrelscan/main/install.sh | bash
#
# Environment variables:
#   SQUIRREL_VERSION   - Pin to specific version (e.g., v0.0.15)
#   SQUIRREL_CHANNEL   - Release channel: stable or beta (default: stable)
#   SQUIRREL_BIN_DIR   - Override bin directory for symlink

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

  if ! response=$(curl -fsSL -H "User-Agent: squirrelscan-installer" --connect-timeout 10 --max-time 30 "$api_url" 2>&1); then
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

# Install audit-website skill if npm available
install_skill() {
  if command -v npx >/dev/null 2>&1; then
    log "Installing audit-website skill..."
    if npx skills add squirrelscan/skills --skill audit-website -y -g 2>/dev/null; then
      info "Skill installed globally"
    else
      warn "Skill installation failed (optional)"
    fi
  else
    info "npm not found, skipping skill install"
    info "Install manually: npx skills add squirrelscan/skills --skill audit-website -y -g"
  fi
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
}

main() {
  local channel="${SQUIRREL_CHANNEL:-stable}"

  echo ""
  echo "  ____              _                _   ____"
  echo " / ___|  __ _ _   _(_)_ __ _ __ ___| | / ___|  ___ __ _ _ __"
  echo " \\___ \\ / _\` | | | | | '__| '__/ _ \\ | \\___ \\ / __/ _\` | '_ \\"
  echo "  ___) | (_| | |_| | | |  | | |  __/ |  ___) | (_| (_| | | | |"
  echo " |____/ \\__, |\\__,_|_|_|  |_|  \\___|_| |____/ \\___\\__,_|_| |_|"
  echo "           |_|"
  echo ""

  log "Installing SquirrelScan..."

  check_deps

  local platform version bin_dir needs_path_update=false
  platform=$(detect_platform)
  log "Detected platform: $platform"

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

  echo ""
  log "Installation complete!"

  # Install skill if npx available
  install_skill

  # Print PATH instructions if needed
  if [ "$needs_path_update" = true ]; then
    echo ""
    print_path_instructions "$bin_dir"
  fi

  echo ""
}

main "$@"
