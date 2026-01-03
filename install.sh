#!/bin/bash
set -euo pipefail

# SquirrelScan installer
# Usage: curl -fsSL https://squirrelscan.com/install | bash
# Or: curl -fsSL https://raw.githubusercontent.com/squirrelscan/squirrelscan/main/install.sh | bash

REPO="squirrelscan/squirrelscan"
INSTALL_DIR="${HOME}/.local/share/squirrel"
BIN_DIR="${HOME}/.local/bin"
CONFIG_DIR="${HOME}/.squirrel"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}==>${NC} $1" >&2; }
warn() { echo -e "${YELLOW}Warning:${NC} $1" >&2; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
info() { echo -e "${BLUE}::${NC} $1" >&2; }

# Check for required commands
check_deps() {
  command -v curl >/dev/null 2>&1 || error "curl is required but not installed"

  # Check for jq or provide fallback
  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not found, using grep fallback (less reliable)"
    USE_JQ=false
  else
    USE_JQ=true
  fi
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
      # Check for musl vs glibc
      if ldd --version 2>&1 | grep -qi musl; then
        libc="-musl"
      elif command -v ldd >/dev/null 2>&1; then
        if ldd /bin/ls 2>/dev/null | grep -q musl; then
          libc="-musl"
        fi
      fi
      ;;
    mingw*|msys*|cygwin*)
      error "Windows is not supported via this installer. Please download the binary manually."
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

# Get latest release version
get_latest_version() {
  local channel="${1:-beta}"
  local api_url="https://api.github.com/repos/${REPO}/releases"
  local response
  local http_code

  info "Fetching releases from GitHub (channel: $channel)..."

  # Fetch with error details
  response=$(curl -fsSL "$api_url" 2>&1) || {
    error "Failed to fetch releases from GitHub API\n  URL: $api_url\n  Response: $response"
  }

  # Check for empty response
  if [ -z "$response" ] || [ "$response" = "[]" ]; then
    error "No releases found in repository: ${REPO}\n  Check: https://github.com/${REPO}/releases"
  fi

  local version=""
  if [ "$USE_JQ" = true ]; then
    if [ "$channel" = "stable" ]; then
      version=$(echo "$response" | jq -r '[.[] | select(.prerelease == false)] | .[0].tag_name // empty')
    else
      version=$(echo "$response" | jq -r '.[0].tag_name // empty')
    fi
  else
    # Grep fallback - less reliable but works without jq
    if [ "$channel" = "stable" ]; then
      version=$(echo "$response" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
    else
      version=$(echo "$response" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
    fi
  fi

  echo "$version"
}

# Download and verify binary
download_and_install() {
  local version="$1"
  local platform="$2"
  local tmpdir

  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" EXIT

  local version_num="${version#v}"
  local release_url="https://github.com/${REPO}/releases/download/${version}"

  # Download manifest
  log "Downloading manifest..."
  local manifest_url="${release_url}/manifest.json"
  curl -fsSL "$manifest_url" -o "$tmpdir/manifest.json" 2>&1 || \
    error "Failed to download manifest.json\n  URL: $manifest_url\n  Ensure the release exists at: https://github.com/${REPO}/releases/tag/${version}"

  # Extract binary info from manifest
  local filename sha256
  if [ "$USE_JQ" = true ]; then
    filename=$(jq -r ".binaries[\"${platform}\"].filename // empty" "$tmpdir/manifest.json")
    sha256=$(jq -r ".binaries[\"${platform}\"].sha256 // empty" "$tmpdir/manifest.json")
  else
    # Grep fallback - extract filename and sha256 for the platform
    filename=$(grep -o "\"${platform}\"[^}]*" "$tmpdir/manifest.json" | grep -o '"filename"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"filename"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    sha256=$(grep -o "\"${platform}\"[^}]*" "$tmpdir/manifest.json" | grep -o '"sha256"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  fi

  if [ -z "$filename" ] || [ -z "$sha256" ]; then
    error "No binary available for platform: $platform\n  Available platforms can be found at: https://github.com/${REPO}/releases/tag/${version}"
  fi

  # Download binary
  log "Downloading squirrel ${version}..."
  local binary_url="${release_url}/${filename}"
  curl -fsSL "$binary_url" -o "$tmpdir/squirrel" 2>&1 || \
    error "Failed to download binary\n  URL: $binary_url"

  # Verify checksum
  log "Verifying checksum..."
  local actual_sha256
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256=$(sha256sum "$tmpdir/squirrel" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha256=$(shasum -a 256 "$tmpdir/squirrel" | cut -d' ' -f1)
  else
    error "Neither sha256sum nor shasum found"
  fi

  if [ "$actual_sha256" != "$sha256" ]; then
    error "Checksum verification failed!\nExpected: ${sha256}\nActual:   ${actual_sha256}"
  fi

  info "Checksum verified: ${sha256:0:16}..."

  # Install binary
  local install_version_dir="${INSTALL_DIR}/releases/${version_num}"
  log "Installing to ${install_version_dir}..."
  mkdir -p "$install_version_dir"
  mv "$tmpdir/squirrel" "$install_version_dir/squirrel"
  chmod +x "$install_version_dir/squirrel"

  # Create symlink
  mkdir -p "$BIN_DIR"
  ln -sf "$install_version_dir/squirrel" "$BIN_DIR/squirrel"
  info "Symlinked to ${BIN_DIR}/squirrel"

  # Create settings
  mkdir -p "$CONFIG_DIR"
  if [ ! -f "$CONFIG_DIR/settings.json" ]; then
    cat > "$CONFIG_DIR/settings.json" <<EOF
{
  "channel": "stable",
  "current_version": "${version_num}",
  "auto_update": true,
  "notifications": true,
  "last_update_check": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    info "Created settings at ${CONFIG_DIR}/settings.json"
  else
    # Update version in existing settings
    if [ "$USE_JQ" = true ]; then
      local tmp_settings
      tmp_settings=$(jq ".current_version = \"${version_num}\" | .last_update_check = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "$CONFIG_DIR/settings.json")
      echo "$tmp_settings" > "$CONFIG_DIR/settings.json"
    fi
    info "Updated settings with new version"
  fi
}

# Check if bin dir is in PATH
check_path() {
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo ""
    warn "${BIN_DIR} is not in your PATH"
    echo ""
    echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
    echo ""
    return 1
  fi
  return 0
}

main() {
  local channel="${SQUIRREL_CHANNEL:-beta}"

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

  local platform version
  platform=$(detect_platform)
  log "Detected platform: $platform"

  version=$(get_latest_version "$channel")
  if [ -z "$version" ]; then
    if [ "$channel" = "stable" ]; then
      error "No stable releases found. Try: SQUIRREL_CHANNEL=beta curl -fsSL ... | bash"
    else
      error "No releases found for channel '$channel'\n  Check: https://github.com/${REPO}/releases"
    fi
  fi
  log "Latest version: $version (channel: $channel)"

  download_and_install "$version" "$platform"

  echo ""
  log "Installation complete!"

  if check_path; then
    info "Run 'squirrel --help' to get started"
  else
    info "After updating PATH, run 'squirrel --help' to get started"
  fi
  echo ""
}

main "$@"
