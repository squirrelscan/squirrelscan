# squirrelscan Windows installer
# Usage: iwr -useb https://install.squirrelscan.com/install.ps1 | iex
# Or: iwr -useb https://raw.githubusercontent.com/squirrelscan/squirrelscan/main/install.ps1 | iex
#
# Environment variables:
#   SQUIRREL_VERSION   - Pin to specific version (e.g., v0.0.15)
#   SQUIRREL_CHANNEL   - Release channel: stable or beta (default: stable)
#   SQUIRREL_FORCE_MIRROR - Skip github.com and download from
#                        install.squirrelscan.com (for networks that block
#                        GitHub). Any value but empty, 0 or false enables it.

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 can otherwise negotiate with its legacy protocol
# defaults. Add TLS 1.2 without replacing newer protocols such as TLS 1.3.
[Net.ServicePointManager]::SecurityProtocol = `
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "squirrelscan/squirrelscan"
$Platform = "windows-x64"

function Write-Log { param($Message) Write-Host "==> " -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-Info { param($Message) Write-Host ":: " -ForegroundColor Blue -NoNewline; Write-Host $Message }
function Write-Warn { param($Message) Write-Host "Warning: " -ForegroundColor Yellow -NoNewline; Write-Host $Message }
function Write-Err {
    param([string]$Message, [string]$Output = "", [int]$ExitCode = 1)
    Write-Host "Error: " -ForegroundColor Red -NoNewline
    Write-Host $Message
    # $Output is the failing command's own stdout/stderr, when we captured it.
    Send-ErrorReport -Step $script:CurrentStep -ExitCode $ExitCode -Line "$Message" -Output $Output
    exit 1
}

# --- Failure reporting -------------------------------------------------
# On failure, fire a tiny anonymous report to the installer worker (→ Sentry)
# so we can see when installs break in the field. Opt-out: NO_TELEMETRY (any
# non-empty value, mirroring install.sh and apps/cli/src/self/telemetry.ts).
# Fire-and-forget: never blocks or fails the install; carries only coarse
# context (os/arch/step/exit code), never paths/env/hostname/secrets. #1013
# v2 adds `error_output` — the tail of the failing command's own output (#1538).
$InstallerReportVersion = "2"
$ErrorEndpoint = if ($env:SQUIRREL_ERROR_ENDPOINT) { $env:SQUIRREL_ERROR_ENDPOINT } else { "https://install.squirrelscan.com/error" }
# Release metadata (latest version per channel) — R2-backed, no rate limits.
$ReleasesEndpoint = if ($env:SQUIRREL_RELEASES_ENDPOINT) { $env:SQUIRREL_RELEASES_ENDPOINT } else { "https://install.squirrelscan.com/releases" }
# Release assets, mirrored through our own origin. A GitHub release-asset URL
# redirects to githubusercontent.com (objects.* historically, release-assets.*
# today), which some networks cannot reach: the metadata fetch above succeeds
# and the binary download then fails on every retry, forever (#2064). Every
# asset therefore has two sources.
$DownloadEndpoint = if ($env:SQUIRREL_DOWNLOAD_ENDPOINT) { $env:SQUIRREL_DOWNLOAD_ENDPOINT } else { "https://install.squirrelscan.com/dl" }
$ErrorLineMax = 200
$ErrorOutputMax = 1000
$script:CurrentStep = "init"
$script:LastCapturedExitCode = 0
# Where `squirrel self install` puts the binary on Windows. Hoisted to script
# scope because the download-failure guidance names it too, not only the PATH
# check at the end of Main.
#
# Guarded: Join-Path throws on a null Path, and at script scope with
# $ErrorActionPreference = "Stop" that would kill the installer on line one,
# before the banner, in any environment that has no LOCALAPPDATA (a service or
# stripped-env invocation). This value is only ever printed, so naming the
# variable symbolically is a better answer than dying.
$script:InstallBinDir = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "squirrel\bin"
} else {
    "%LOCALAPPDATA%\squirrel\bin"
}

# Make an arbitrary string safe to put in a report: reduce to printable ASCII
# (control chars AND non-ASCII -> space) so truncation can't split a
# surrogate/multibyte char and no ANSI escape reaches the JSON, scrub the home
# path -> '~' so no local path leaks, then hard-truncate. Command output keeps
# its TAIL (-KeepTail) because that's where the error is; a one-line message
# keeps its head. The worker re-clamps and redacts too.
function Get-ScrubbedText {
    param([string]$Text, [int]$MaxLength = 200, [switch]$KeepTail)
    if (-not $Text) { return "" }
    $scrubbed = $Text -replace '[^\x20-\x7E]', ' '
    if ($env:USERPROFILE) { $scrubbed = $scrubbed.Replace($env:USERPROFILE, "~") }
    if ($HOME) { $scrubbed = $scrubbed.Replace($HOME, "~") }
    if ($scrubbed.Length -gt $MaxLength) {
        if ($KeepTail) {
            $scrubbed = $scrubbed.Substring($scrubbed.Length - $MaxLength)
        } else {
            $scrubbed = $scrubbed.Substring(0, $MaxLength)
        }
    }
    return $scrubbed
}

# Run a native command, echoing its output live AND returning it as one string.
# `2>&1` merges the command's stderr into the pipeline; under
# $ErrorActionPreference = "Stop" anything a native command writes to stderr
# would otherwise become a terminating NativeCommandError, so drop to
# "Continue" for the duration and restore afterwards. The exit code lands in
# $script:LastCapturedExitCode.
function Invoke-CapturedCommand {
    param([string]$FilePath, [string[]]$Arguments = @())

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = & $FilePath @Arguments 2>&1 | ForEach-Object {
            $text = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { "$_" }
            Write-Host $text
            $text
        }
        $script:LastCapturedExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return ($lines -join "`n")
}

function Send-ErrorReport {
    param([string]$Step, [int]$ExitCode = 1, [string]$Line = "", [string]$Output = "")
    # Presence disables reporting, including an explicitly empty value.
    if (Test-Path Env:NO_TELEMETRY) { return }
    try {
        $scrubbed = Get-ScrubbedText -Text $Line -MaxLength $ErrorLineMax
        # The tail of the failing command's own stdout/stderr. Without it a
        # self_install failure carried an exit code and nothing else (#1538).
        $scrubbedOutput = Get-ScrubbedText -Text $Output -MaxLength $ErrorOutputMax -KeepTail
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
            error_output   = $scrubbedOutput
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

# --- Release asset download (two sources) ------------------------------
# GitHub is the origin and always has every asset, so it is tried first; the
# mirror at $DownloadEndpoint proxies the same bytes through Cloudflare, which
# reaches GitHub even when the client cannot. The manifest's sha256 is verified
# over whatever comes back either way, so a second source adds no trust.
#
# A mirror that answers 404 is treated as "nothing here", which is also what a
# worker deployed before the route existed answers: the script degrades to the
# GitHub failure it would have reported anyway rather than breaking.
$script:DownloadUrlGitHub = ""
$script:DownloadUrlMirror = ""
$script:DownloadSource = ""

# Opt-in flag semantics, matching the CLI's SQUIRREL_NO_UPDATE: empty, 0 and
# false are off, anything else is on. Presence semantics would make a stray
# empty SQUIRREL_FORCE_MIRROR silently reroute every install.
function Test-ForceMirror {
    $value = "$($env:SQUIRREL_FORCE_MIRROR)".Trim().ToLowerInvariant()
    return -not ($value -eq "" -or $value -eq "0" -or $value -eq "false")
}

# The two sources for one asset, in the order to try them, as (host, url)
# pairs. Also records both URLs for the failure report.
function Get-DownloadSources {
    param([string]$Version, [string]$Asset)

    $script:DownloadUrlGitHub = "https://github.com/$Repo/releases/download/$Version/$Asset"
    $script:DownloadUrlMirror = "$DownloadEndpoint/$Version/$Asset"
    $script:DownloadSource = ""

    $sources = @()
    if (Test-ForceMirror) {
        Write-Info "SQUIRREL_FORCE_MIRROR is set, skipping github.com"
    } else {
        $sources += ,@("github.com", $script:DownloadUrlGitHub)
    }
    $sources += ,@("install.squirrelscan.com", $script:DownloadUrlMirror)
    return ,$sources
}

# Invoke-WebRequest -OutFile leaves a partial file behind when a transfer dies
# mid-stream, and the next source would then be asked to overwrite it. Delete a
# failed attempt so only a completed download is ever handed back.
function Get-ReleaseAsset {
    param(
        [string]$Version,
        [string]$Asset,
        [string]$OutFile,
        [string]$Label
    )

    $sources = Get-DownloadSources -Version $Version -Asset $Asset
    for ($i = 0; $i -lt $sources.Count; $i++) {
        try {
            Invoke-WebRequest -Uri $sources[$i][1] -OutFile $OutFile -TimeoutSec 120 -UseBasicParsing
            $script:DownloadSource = $sources[$i][0]
            return $true
        } catch {
            if (Test-Path $OutFile) { Remove-Item -Path $OutFile -Force -ErrorAction SilentlyContinue }
            if ($i -lt ($sources.Count - 1)) {
                Write-Warn "$($sources[$i][0]) could not serve the $Label, trying $($sources[$i + 1][0])..."
            }
        }
    }
    return $false
}

# Same two sources for a small JSON asset. Returns the parsed object, or $null
# when both sources failed.
function Get-ReleaseAssetJson {
    param([string]$Version, [string]$Asset, [string]$Label)

    $sources = Get-DownloadSources -Version $Version -Asset $Asset
    for ($i = 0; $i -lt $sources.Count; $i++) {
        try {
            $parsed = Invoke-RestMethod -Uri $sources[$i][1] -TimeoutSec 30
            $script:DownloadSource = $sources[$i][0]
            return $parsed
        } catch {
            if ($i -lt ($sources.Count - 1)) {
                Write-Warn "$($sources[$i][0]) could not serve the $Label, trying $($sources[$i + 1][0])..."
            }
        }
    }
    return $null
}

# Strip `user:password@` out of a URL before it is printed or reported.
# SQUIRREL_DOWNLOAD_ENDPOINT is user-supplied and can carry credentials, and the
# report scrubber removes home paths and clamps length — it knows nothing about
# URL userinfo, so a mirror set to https://user:token@host would otherwise send
# that token to the reporting endpoint verbatim.
function Get-RedactedUrl {
    param([string]$Url)
    return [regex]::Replace($Url, '^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@]*@', '$1')
}

# The report line and the user-facing guidance for a download that ran out of
# sources. Write-Err carries the first to Sentry (clamped to $ErrorLineMax,
# which two full URLs would blow past) and prints it; the URLs themselves ride
# along in error_output, which has room for them.
#
# The line names the hosts AND the way out, because it is the one line that
# reaches both the user's console and the Sentry issue; the guidance below it is
# local only.
function Get-DownloadFailureLine {
    param([string]$Label)
    if (Test-ForceMirror) {
        return "Failed to download the $Label from install.squirrelscan.com (SQUIRREL_FORCE_MIRROR is set, github.com was skipped)"
    }
    return "Failed to download the $Label from github.com and install.squirrelscan.com (retry with SQUIRREL_FORCE_MIRROR=1 to skip github.com)"
}

# Skipped is not failed: with SQUIRREL_FORCE_MIRROR set we never asked GitHub,
# and a report claiming we did would send whoever reads it after the wrong host.
function Get-DownloadFailureOutput {
    $github = Get-RedactedUrl $script:DownloadUrlGitHub
    $mirror = Get-RedactedUrl $script:DownloadUrlMirror
    $githubLine = if (Test-ForceMirror) {
        "skipped $github (SQUIRREL_FORCE_MIRROR)"
    } else {
        "tried $github (failed)"
    }
    return "$githubLine`ntried $mirror (failed)"
}

# `Kind` is `binary` or `manifest`: only the binary has a by-hand recipe worth
# printing, because only the binary is the thing the user ultimately needs on
# disk.
function Show-DownloadFailureGuidance {
    param([string]$Asset, [string]$Kind)

    Write-Host "  Tried:"
    if (Test-ForceMirror) {
        Write-Host "    github.com               skipped (SQUIRREL_FORCE_MIRROR is set)"
    } else {
        Write-Host "    github.com               $(Get-RedactedUrl $script:DownloadUrlGitHub)"
    }
    Write-Host "    install.squirrelscan.com $(Get-RedactedUrl $script:DownloadUrlMirror)"
    Write-Host ""
    if (-not (Test-ForceMirror)) {
        Write-Host "  If github.com is blocked on this network, skip it and retry:"
        Write-Host "    `$env:SQUIRREL_FORCE_MIRROR='1'; iwr -useb https://install.squirrelscan.com/install.ps1 | iex"
        Write-Host ""
    }
    if ($Kind -eq "binary") {
        Write-Host "  If both hosts are blocked, download $Asset on a machine that can"
        Write-Host "  reach one of them, copy it here, then:"
        # The bin directory does not exist until the first successful install,
        # and Move-Item does not create it.
        Write-Host "    New-Item -ItemType Directory -Force -Path '$($script:InstallBinDir)' | Out-Null"
        Write-Host "    Move-Item $Asset '$($script:InstallBinDir)\squirrel.exe'"
    } else {
        Write-Host "  If both hosts are blocked, this machine cannot reach anywhere the"
        Write-Host "  release is published. Allowlist github.com or install.squirrelscan.com,"
        Write-Host "  or install from a network that already reaches one of them."
    }
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
    Write-Log "Downloading manifest..."

    $manifest = Get-ReleaseAssetJson -Version $Version -Asset "manifest.json" -Label "manifest"
    if ($null -eq $manifest) {
        Show-DownloadFailureGuidance -Asset "manifest.json" -Kind "manifest"
        Write-Err (Get-DownloadFailureLine "manifest") -Output (Get-DownloadFailureOutput)
    }
    return $manifest
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

        $script:CurrentStep = "download_binary"
        Write-Log "Downloading squirrel $Version..."
        if (-not (Get-ReleaseAsset -Version $Version -Asset $filename -OutFile $binaryPath -Label "binary")) {
            Show-DownloadFailureGuidance -Asset $filename -Kind "binary"
            Write-Err (Get-DownloadFailureLine "binary") -Output (Get-DownloadFailureOutput)
        }
        Write-Info "Downloaded from $($script:DownloadSource)"

        # Verify checksum
        $script:CurrentStep = "verify_checksum"
        Write-Log "Verifying checksum..."
        $actualHash = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()

        if ($actualHash -ne $expectedHash.ToLower()) {
            Write-Err "Checksum mismatch!`n  Expected: $expectedHash`n  Actual:   $actualHash"
        }
        Write-Info "Checksum verified: $($expectedHash.Substring(0, 16))..."

        # Run self install. Its output is echoed live AND captured, so a failure
        # reports what the binary actually said instead of a bare exit code
        # (#1538) — the tail rides along on the error report.
        $script:CurrentStep = "self_install"
        Write-Log "Running self install..."
        $selfInstallOutput = Invoke-CapturedCommand -FilePath $binaryPath -Arguments @("self", "install")
        $selfInstallExit = $script:LastCapturedExitCode

        if ($selfInstallExit -ne 0) {
            Write-Err "Self install failed with exit code $selfInstallExit" `
                -Output $selfInstallOutput -ExitCode $selfInstallExit
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
    $binDir = $script:InstallBinDir
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
