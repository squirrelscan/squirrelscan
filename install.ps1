# SquirrelScan Windows installer
# Usage: iwr -useb https://install.squirrelscan.com/install.ps1 | iex
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
function Write-Err { param($Message) Write-Host "Error: " -ForegroundColor Red -NoNewline; Write-Host $Message; Send-ErrorReport -Step $script:CurrentStep -ExitCode 1 -Line "$Message"; exit 1 }

# --- Failure reporting -------------------------------------------------
# On failure, fire a tiny anonymous report to the installer worker (→ Sentry)
# so we can see when installs break in the field. Opt-out: NO_TELEMETRY (any
# non-empty value, mirroring install.sh and apps/cli/src/self/telemetry.ts).
# Fire-and-forget: never blocks or fails the install; carries only coarse
# context (os/arch/step/exit code), never paths/env/hostname/secrets. #1013
$InstallerReportVersion = "1"
$ErrorEndpoint = if ($env:SQUIRREL_ERROR_ENDPOINT) { $env:SQUIRREL_ERROR_ENDPOINT } else { "https://install.squirrelscan.com/error" }
# Release metadata (latest version per channel) — R2-backed, no rate limits.
$ReleasesEndpoint = if ($env:SQUIRREL_RELEASES_ENDPOINT) { $env:SQUIRREL_RELEASES_ENDPOINT } else { "https://install.squirrelscan.com/releases" }
$script:CurrentStep = "init"

function Send-ErrorReport {
    param([string]$Step, [int]$ExitCode = 1, [string]$Line = "")
    # NO_TELEMETRY (any non-empty value) disables ALL install-script reporting.
    if ($env:NO_TELEMETRY) { return }
    try {
        $scrubbed = ""
        if ($Line) {
            # Reduce to printable ASCII (control chars AND non-ASCII -> space) so
            # truncation can't split a surrogate/multibyte char, scrub the home
            # path -> '~' so no local path leaks, then hard-truncate. The worker
            # re-clamps and redacts too.
            $scrubbed = $Line -replace '[^\x20-\x7E]', ' '
            if ($env:USERPROFILE) { $scrubbed = $scrubbed.Replace($env:USERPROFILE, "~") }
            if ($HOME) { $scrubbed = $scrubbed.Replace($HOME, "~") }
            if ($scrubbed.Length -gt 200) { $scrubbed = $scrubbed.Substring(0, 200) }
        }
        $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
            "AMD64" { "x64" }
            "ARM64" { "arm64" }
            default { "$($env:PROCESSOR_ARCHITECTURE)" }
        }
        $channel = if ($env:SQUIRREL_CHANNEL) { $env:SQUIRREL_CHANNEL } else { "stable" }
        $payload = @{
            script         = "ps1"
            script_version = $InstallerReportVersion
            channel        = $channel
            os             = "windows"
            arch           = $arch
            step           = $Step
            exit_code      = $ExitCode
            error_line     = $scrubbed
        } | ConvertTo-Json -Compress
        # Fire-and-forget: run the POST in a background job so it never blocks
        # the installer. Not awaited; the 3s timeout inside is the backstop and
        # failures are swallowed.
        Start-Job -ScriptBlock {
            param($Uri, $Body)
            try {
                Invoke-RestMethod -Uri $Uri -Method Post -Body $Body `
                    -ContentType "application/json" -TimeoutSec 3 | Out-Null
            } catch {}
        } -ArgumentList $ErrorEndpoint, $payload | Out-Null
    } catch {
        # Reporting must never surface or fail the install.
    }
}

# --- Banner ------------------------------------------------------------
# Blocky lowercase "squirrelscan" wordmark, matching the CLI's own banner
# (apps/cli/src/cli/banner.ts) instead of the old camel-case ASCII art.
# $BannerArtColor is a precomputed copy of that file's gradient-string
# output for the autumn palette (#CD853F -> #D2691E -> #8B4513 -> #A0522D) --
# this installer has no Node/gradient-string available at iwr|iex time.
$BannerArtPlain = @'
 ▄█▀ ▄▀█ █ █ █ █▀▄ █▀▄ █▀▀ █   ▄█▀ ▄▀▀ ▄▀█ █▄ █
 ▀▄  █ █ █ █ █ ██▀ ██▀ █▀  █   ▀▄  █   █▀█ █ ▀█
 █▄▀ ▀▀█ ▀▄▀ █ █ █ █ █ █▄▄ █▄▄ █▄▀ ▀▄▄ █ █ █  █
'@

$BannerArtColor = @'
 [38;2;205;133;63m▄[39m[38;2;205;132;62m█[39m[38;2;205;131;61m▀[39m [38;2;206;130;60m▄[39m[38;2;206;129;58m▀[39m[38;2;206;128;57m█[39m [38;2;206;127;56m█[39m [38;2;206;126;55m█[39m [38;2;206;125;54m█[39m [38;2;207;124;53m█[39m[38;2;207;123;52m▀[39m[38;2;207;122;50m▄[39m [38;2;207;121;49m█[39m[38;2;207;120;48m▀[39m[38;2;207;119;47m▄[39m [38;2;208;119;46m█[39m[38;2;208;118;45m▀[39m[38;2;208;117;44m▀[39m [38;2;208;116;43m█[39m   [38;2;208;115;41m▄[39m[38;2;208;114;40m█[39m[38;2;209;113;39m▀[39m [38;2;209;112;38m▄[39m[38;2;209;111;37m▀[39m[38;2;209;110;36m▀[39m [38;2;209;109;35m▄[39m[38;2;209;108;33m▀[39m[38;2;210;107;32m█[39m [38;2;210;106;31m█[39m[38;2;210;105;30m▄[39m [38;2;207;104;30m█[39m
 [38;2;205;102;29m▀[39m[38;2;202;101;29m▄[39m  [38;2;200;100;28m█[39m [38;2;197;99;28m█[39m [38;2;195;97;28m█[39m [38;2;192;96;27m█[39m [38;2;190;95;27m█[39m [38;2;187;93;26m█[39m[38;2;185;92;26m█[39m[38;2;182;91;26m▀[39m [38;2;180;90;25m█[39m[38;2;177;88;25m█[39m[38;2;175;87;25m▀[39m [38;2;172;86;24m█[39m[38;2;169;84;24m▀[39m  [38;2;167;83;23m█[39m   [38;2;164;82;23m▀[39m[38;2;162;81;23m▄[39m  [38;2;159;79;22m█[39m   [38;2;157;78;22m█[39m[38;2;154;77;21m▀[39m[38;2;152;75;21m█[39m [38;2;149;74;21m█[39m [38;2;147;73;20m▀[39m[38;2;144;72;20m█[39m
 [38;2;142;70;19m█[39m[38;2;139;69;19m▄[39m[38;2;140;69;20m▀[39m [38;2;141;70;21m▀[39m[38;2;141;70;22m▀[39m[38;2;142;71;23m█[39m [38;2;143;71;24m▀[39m[38;2;144;72;25m▄[39m[38;2;144;72;26m▀[39m [38;2;145;73;26m█[39m [38;2;146;73;27m█[39m [38;2;147;74;28m█[39m [38;2;147;74;29m█[39m [38;2;148;75;30m█[39m [38;2;149;75;31m█[39m[38;2;150;76;32m▄[39m[38;2;150;76;33m▄[39m [38;2;151;76;34m█[39m[38;2;152;77;35m▄[39m[38;2;153;77;36m▄[39m [38;2;153;78;37m█[39m[38;2;154;78;38m▄[39m[38;2;155;79;39m▀[39m [38;2;156;79;39m▀[39m[38;2;156;80;40m▄[39m[38;2;157;80;41m▄[39m [38;2;158;81;42m█[39m [38;2;159;81;43m█[39m [38;2;159;82;44m█[39m  [38;2;160;82;45m█[39m
'@

$BannerTextFallback = 'squirrelscan'

# Half-block glyphs need a UTF-8 console to render correctly; the classic
# Windows console defaults to codepage 437/850 unless configured otherwise.
function Test-Utf8Console {
    try {
        return [Console]::OutputEncoding.CodePage -eq 65001
    } catch {
        return $false
    }
}

function Test-ColorSupported {
    if ($env:NO_COLOR) { return $false }
    try {
        if ([Console]::IsOutputRedirected) { return $false }
    } catch {
        return $false
    }
    # A non-redirected console isn't enough -- it also needs to actually
    # process raw ANSI/VT escapes, or the truecolor codes print literally.
    # Windows Terminal and PowerShell 7+ do this by default; classic
    # Windows PowerShell 5.1 in conhost.exe often doesn't (codex review,
    # #1029), so only opt in for hosts known to handle it.
    if ($env:WT_SESSION -or $env:TERM_PROGRAM) { return $true }
    return $PSVersionTable.PSVersion.Major -ge 7
}

function Show-Banner {
    Write-Host ""
    if (-not (Test-Utf8Console)) {
        Write-Host "  $BannerTextFallback"
    } elseif (Test-ColorSupported) {
        Write-Host $BannerArtColor
    } else {
        Write-Host $BannerArtPlain
    }
    Write-Host ""
}

function Get-LatestVersion {
    param([string]$Channel = "stable")

    $script:CurrentStep = "fetch_releases"
    Write-Info "Fetching releases (channel: $Channel)..."

    # Primary: install.squirrelscan.com/releases/{channel} — R2-backed release
    # metadata with no rate limits. Fallback: the GitHub API, which anonymous
    # clients share at 60 req/hr per IP — corporate NAT/VPN/CI egress hits 403s.
    try {
        $meta = Invoke-RestMethod -Uri "$ReleasesEndpoint/$Channel" -Headers @{"User-Agent"="squirrelscan-installer"} -TimeoutSec 15
        if ($meta.version) {
            # Manifest versions are bare ("0.0.73"); release tags carry the v prefix.
            return "v" + ($meta.version -replace '^v', '')
        }
    } catch {
        Write-Warn "Release metadata endpoint unavailable, falling back to GitHub API..."
    }

    try {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Headers @{"User-Agent"="squirrelscan-installer"} -TimeoutSec 30
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

    $script:CurrentStep = "download_manifest"
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

        $script:CurrentStep = "download_binary"
        Write-Log "Downloading squirrel $Version..."
        Invoke-WebRequest -Uri $binaryUrl -OutFile $binaryPath -TimeoutSec 120

        # Verify checksum
        $script:CurrentStep = "verify_checksum"
        Write-Log "Verifying checksum..."
        $actualHash = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()

        if ($actualHash -ne $expectedHash.ToLower()) {
            Write-Err "Checksum mismatch!`n  Expected: $expectedHash`n  Actual:   $actualHash"
        }
        Write-Info "Checksum verified: $($expectedHash.Substring(0, 16))..."

        # Run self install
        $script:CurrentStep = "self_install"
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

function Show-Epilogue {
    # Get-started epilogue: one scannable next-steps block instead of the old
    # "Installation complete!" + skill-hint tail (#1029). "squirrel skills
    # install" is the canonical path (installs both skills, no --skill
    # filter); the npx fallback line stays copy-paste-able for docs/agents.
    param([string]$Version)

    Write-Host ""
    Write-Host "squirrel $Version installed" -ForegroundColor Green
    Write-Host ""
    Write-Host "Get started:"
    Write-Host "  1. Run your first audit:   squirrel audit https://your-site.com"
    Write-Host "  2. Add agent skills:       squirrel skills install   (Claude Code, Cursor, Codex, ...)"
    Write-Host "                             or: npx skills add squirrelscan/skills -y -g"
    Write-Host "  3. Unlock cloud audits:    squirrel auth login       -> https://squirrelscan.com/login"
    Write-Host "  Shell completions:         squirrel self completion <bash|zsh|fish>"
    Write-Host "  Docs: https://docs.squirrelscan.com"
    Write-Host ""
}

function Main {
    Show-Banner

    Write-Log "Installing squirrel..."

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

    Show-Epilogue -Version $version

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
        Write-Host ""
        Write-Host "After updating PATH, verify with: squirrel self doctor"
    }

    Write-Host ""
    exit 0
}

try {
    Main
} catch {
    # A terminating error that didn't route through Write-Err (e.g. an
    # unexpected cmdlet failure under $ErrorActionPreference = "Stop").
    Send-ErrorReport -Step $script:CurrentStep -ExitCode 1 -Line "$($_.Exception.Message)"
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
