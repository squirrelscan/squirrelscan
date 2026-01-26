# SquirrelScan Windows installer
# Usage: iwr -useb https://squirrelscan.com/install.ps1 | iex
# Or: iwr -useb https://raw.githubusercontent.com/squirrelscan/squirrelscan/main/install.ps1 | iex
#
# Environment variables:
#   SQUIRREL_VERSION   - Pin to specific version (e.g., v0.0.15)
#   SQUIRREL_CHANNEL   - Release channel: stable or beta (default: stable)

$ErrorActionPreference = "Stop"

$Repo = "squirrelscan/squirrelscan"
$Platform = "windows-x64"

function Write-Log { param($Message) Write-Host "==> " -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-Info { param($Message) Write-Host ":: " -ForegroundColor Blue -NoNewline; Write-Host $Message }
function Write-Warn { param($Message) Write-Host "Warning: " -ForegroundColor Yellow -NoNewline; Write-Host $Message }
function Write-Err { param($Message) Write-Host "Error: " -ForegroundColor Red -NoNewline; Write-Host $Message; exit 1 }

function Get-LatestVersion {
    param([string]$Channel = "stable")

    Write-Info "Fetching releases (channel: $Channel)..."

    try {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -TimeoutSec 30
    } catch {
        Write-Err "Failed to fetch releases: $_"
    }

    if (-not $releases -or $releases.Count -eq 0) {
        Write-Err "No releases found. Check: https://github.com/$Repo/releases"
    }

    if ($Channel -eq "stable") {
        $release = $releases | Where-Object { -not $_.prerelease } | Select-Object -First 1
    } else {
        $release = $releases | Select-Object -First 1
    }

    if (-not $release) {
        Write-Err "No releases found for channel '$Channel'"
    }

    return $release.tag_name
}

function Get-Manifest {
    param([string]$Version)

    $manifestUrl = "https://github.com/$Repo/releases/download/$Version/manifest.json"
    Write-Log "Downloading manifest..."

    try {
        $manifest = Invoke-RestMethod -Uri $manifestUrl -TimeoutSec 30
        return $manifest
    } catch {
        Write-Err "Failed to download manifest: $_`n  URL: $manifestUrl"
    }
}

function Install-Squirrel {
    param(
        [string]$Version,
        [object]$Manifest
    )

    $binary = $Manifest.binaries.$Platform
    if (-not $binary) {
        Write-Err "No binary for platform: $Platform`n  See: https://github.com/$Repo/releases/tag/$Version"
    }

    $filename = $binary.filename
    $expectedHash = $binary.sha256

    # Create temp directory
    $tempDir = Join-Path $env:TEMP "squirrel-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        $binaryPath = Join-Path $tempDir "squirrel.exe"
        $binaryUrl = "https://github.com/$Repo/releases/download/$Version/$filename"

        Write-Log "Downloading squirrel $Version..."
        Invoke-WebRequest -Uri $binaryUrl -OutFile $binaryPath -TimeoutSec 120

        # Verify checksum
        Write-Log "Verifying checksum..."
        $actualHash = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()

        if ($actualHash -ne $expectedHash.ToLower()) {
            Write-Err "Checksum mismatch!`n  Expected: $expectedHash`n  Actual:   $actualHash"
        }
        Write-Info "Checksum verified: $($expectedHash.Substring(0, 16))..."

        # Run self install
        Write-Log "Running self install..."
        & $binaryPath self install

        if ($LASTEXITCODE -ne 0) {
            Write-Err "Self install failed with exit code $LASTEXITCODE"
        }
    } finally {
        # Cleanup
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Install-Skill {
    $npxPath = Get-Command npx -ErrorAction SilentlyContinue
    if ($npxPath) {
        Write-Log "Installing audit-website skill..."
        try {
            & npx skills add squirrelscan/skills --skill audit-website -y -g 2>$null
            Write-Info "Skill installed globally"
        } catch {
            Write-Warn "Skill installation failed (optional)"
        }
    } else {
        Write-Info "npm not found, skipping skill install"
        Write-Info "Install manually: npx skills add squirrelscan/skills --skill audit-website -y -g"
    }
}

function Main {
    Write-Host ""
    Write-Host "  ____              _                _   ____"
    Write-Host " / ___|  __ _ _   _(_)_ __ _ __ ___| | / ___|  ___ __ _ _ __"
    Write-Host " \___ \ / _`` | | | | | '__| '__/ _ \ | \___ \ / __/ _`` | '_ \"
    Write-Host "  ___) | (_| | |_| | | |  | | |  __/ |  ___) | (_| (_| | | | |"
    Write-Host " |____/ \__, |\__,_|_|_|  |_|  \___|_| |____/ \___\__,_|_| |_|"
    Write-Host "           |_|"
    Write-Host ""

    Write-Log "Installing SquirrelScan..."

    $channel = if ($env:SQUIRREL_CHANNEL) { $env:SQUIRREL_CHANNEL } else { "stable" }

    # Get version
    if ($env:SQUIRREL_VERSION) {
        $version = $env:SQUIRREL_VERSION
        Write-Log "Installing pinned version: $version"
    } else {
        $version = Get-LatestVersion -Channel $channel
        if (-not $version) {
            if ($channel -eq "stable") {
                Write-Err "No stable releases found. Try:`n  `$env:SQUIRREL_CHANNEL='beta'; iwr -useb ... | iex"
            } else {
                Write-Err "No releases found for channel '$channel'"
            }
        }
        Write-Log "Latest version: $version (channel: $channel)"
    }

    # Get manifest and install
    $manifest = Get-Manifest -Version $version
    Install-Squirrel -Version $version -Manifest $manifest

    Write-Host ""
    Write-Log "Installation complete!"

    # Install skill
    Install-Skill

    # Check PATH
    $binDir = Join-Path $env:LOCALAPPDATA "squirrel\bin"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $currentPath = $env:Path

    if (($currentPath -notlike "*$binDir*") -and ($userPath -notlike "*$binDir*")) {
        Write-Host ""
        Write-Warn "$binDir is not in your PATH"
        Write-Host ""

        # Detect shell/terminal
        $shell = if ($env:WT_SESSION) {
            "Windows Terminal"
        } elseif ($env:TERM_PROGRAM -eq "vscode") {
            "VS Code"
        } else {
            "PowerShell"
        }

        Write-Host "To add permanently, run:"
        Write-Host ""
        Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$binDir', 'User')"
        Write-Host ""
        Write-Host "Then restart your terminal ($shell)."
        Write-Host ""
        Write-Host "Or add to session temporarily:"
        Write-Host ""
        Write-Host "  `$env:Path += ';$binDir'"
    }

    Write-Host ""
}

Main
