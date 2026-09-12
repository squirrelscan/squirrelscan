# Behavioural checks for install.ps1's release-asset download (#2064).
#
# CI already parses install.ps1, but parsing proves only that the file is
# syntactically PowerShell. Nothing ran its functions before users did: the
# install-test workflow fetches the PUBLISHED script from main, so a change to
# this file reaches Windows users unexecuted. These checks dot-source the script
# above `Main` (so nothing installs) and exercise the two-source download path
# against a stubbed Invoke-WebRequest.
#
# Run locally with `pwsh -NoProfile -File scripts/install-ps-contract.test.ps1`.

$ErrorActionPreference = "Stop"

$installer = Join-Path (Split-Path -Parent $PSScriptRoot) "install.ps1"
$src = Get-Content $installer -Raw
# Everything above Main: the function library, with no entry point to run.
$cut = $src.Substring(0, $src.LastIndexOf("function Main {"))
. ([ScriptBlock]::Create($cut))

$script:Failures = 0
function Check {
    param([string]$Name, [bool]$Condition)
    if ($Condition) {
        Write-Host "  ok   $Name"
    } else {
        Write-Host "  FAIL $Name"
        $script:Failures++
    }
}

Write-Host "SQUIRREL_FORCE_MIRROR uses value semantics, not presence"
# A stray empty assignment in a profile must not reroute every install.
foreach ($case in @(
    @("", $false), @("0", $false), @("false", $false), @("FALSE", $false),
    @("  ", $false), @("1", $true), @("true", $true), @("yes", $true)
)) {
    $env:SQUIRREL_FORCE_MIRROR = $case[0]
    Check "'$($case[0])' -> $($case[1])" ((Test-ForceMirror) -eq $case[1])
}
Remove-Item Env:SQUIRREL_FORCE_MIRROR -ErrorAction SilentlyContinue

Write-Host "GitHub is tried first, the mirror second"
$sources = Get-DownloadSources -Version "v1.2.3" -Asset "squirrel-1.2.3-windows-x64.exe"
Check "two sources" ($sources.Count -eq 2)
Check "github.com first" ($sources[0][0] -eq "github.com")
Check "github url" ($sources[0][1] -eq "https://github.com/squirrelscan/squirrelscan/releases/download/v1.2.3/squirrel-1.2.3-windows-x64.exe")
Check "install.squirrelscan.com second" ($sources[1][0] -eq "install.squirrelscan.com")
Check "mirror url" ($sources[1][1] -eq "https://install.squirrelscan.com/dl/v1.2.3/squirrel-1.2.3-windows-x64.exe")
Check "both urls recorded for the report" (
    $script:DownloadUrlGitHub -eq $sources[0][1] -and $script:DownloadUrlMirror -eq $sources[1][1])

Write-Host "SQUIRREL_FORCE_MIRROR drops the GitHub leg"
$env:SQUIRREL_FORCE_MIRROR = "1"
$forced = Get-DownloadSources -Version "v1.2.3" -Asset "manifest.json"
Check "one source" ($forced.Count -eq 1)
Check "mirror only" ($forced[0][0] -eq "install.squirrelscan.com")
Check "github url still recorded" ($script:DownloadUrlGitHub -like "https://github.com/*")
Remove-Item Env:SQUIRREL_FORCE_MIRROR -ErrorAction SilentlyContinue

Write-Host "a blocked github.com falls through to the mirror"
function Invoke-WebRequest {
    param($Uri, $OutFile, $TimeoutSec, [switch]$UseBasicParsing)
    if ($Uri -like "*github.com*") { throw "blocked" }
    Set-Content -Path $OutFile -Value "BYTES" -NoNewline
}
$out = Join-Path ([System.IO.Path]::GetTempPath()) "squirrel-ps-contract-asset"
$ok = Get-ReleaseAsset -Version "v1.2.3" -Asset "squirrel-1.2.3-windows-x64.exe" -OutFile $out -Label "binary"
Check "download succeeds" ($ok -eq $true)
Check "source is the mirror" ($script:DownloadSource -eq "install.squirrelscan.com")
Check "bytes landed on disk" ((Get-Content $out -Raw) -eq "BYTES")
Remove-Item $out -Force -ErrorAction SilentlyContinue

Write-Host "a failed attempt leaves no partial file for the next source"
function Invoke-WebRequest {
    param($Uri, $OutFile, $TimeoutSec, [switch]$UseBasicParsing)
    # Invoke-WebRequest -OutFile really does leave a partial file behind when a
    # transfer dies mid-stream.
    Set-Content -Path $OutFile -Value "PARTIAL" -NoNewline
    throw "blocked"
}
$failed = Get-ReleaseAsset -Version "v1.2.3" -Asset "squirrel-1.2.3-windows-x64.exe" -OutFile $out -Label "binary"
Check "download reports failure" ($failed -eq $false)
Check "no partial file left behind" (-not (Test-Path $out))

Write-Host "the failure report names both hosts and carries both urls"
Get-DownloadSources -Version "v1.2.3" -Asset "squirrel-1.2.3-windows-x64.exe" | Out-Null
$line = Get-DownloadFailureLine "binary"
Check "line names github.com" ($line -like "*github.com*")
Check "line names install.squirrelscan.com" ($line -like "*install.squirrelscan.com*")
# The acceptance criterion asks for one actionable line: the hosts tried AND the
# way out, not the hosts alone.
Check "line names the escape hatch" ($line -like "*SQUIRREL_FORCE_MIRROR=1*")
# Two full asset URLs would be truncated out of error_line, so they ride in
# error_output instead.
Check "line fits ErrorLineMax" ($line.Length -le $ErrorLineMax)
$output = Get-DownloadFailureOutput
Check "output carries the github url" ($output -like "*https://github.com/*")
Check "output carries the mirror url" ($output -like "*https://install.squirrelscan.com/dl/*")

Write-Host "a skipped GitHub leg is reported as skipped, not failed"
$env:SQUIRREL_FORCE_MIRROR = "1"
Get-DownloadSources -Version "v1.2.3" -Asset "squirrel-1.2.3-windows-x64.exe" | Out-Null
$forcedOutput = Get-DownloadFailureOutput
Check "github recorded as skipped" ($forcedOutput -like "*skipped https://github.com/*(SQUIRREL_FORCE_MIRROR)*")
Check "github not recorded as failed" (-not ($forcedOutput -like "*tried https://github.com/*(failed)*"))
$forcedLine = Get-DownloadFailureLine "binary"
Check "line says github was skipped" ($forcedLine -like "*github.com was skipped*")
Check "line drops the retry instruction" (-not ($forcedLine -like "*retry with SQUIRREL_FORCE_MIRROR=1*"))
Check "forced line still fits ErrorLineMax" ($forcedLine.Length -le $ErrorLineMax)
Remove-Item Env:SQUIRREL_FORCE_MIRROR -ErrorAction SilentlyContinue

Write-Host "a mirror URL carrying credentials is redacted"
# SQUIRREL_DOWNLOAD_ENDPOINT is user-supplied. The report scrubber strips home
# paths and clamps length; it knows nothing about URL userinfo.
Check "userinfo stripped" ((Get-RedactedUrl "https://alice:dummy-secret@mirror.test/dl/a") -eq "https://mirror.test/dl/a") # pragma: allowlist secret
Check "ordinary url untouched" ((Get-RedactedUrl "https://install.squirrelscan.com/dl/a") -eq "https://install.squirrelscan.com/dl/a")
Check "an @ in the path is not userinfo" ((Get-RedactedUrl "https://host/p@th/a") -eq "https://host/p@th/a")
$script:DownloadUrlMirror = "https://alice:dummy-secret@mirror.test/dl/a" # pragma: allowlist secret
$redactedOutput = Get-DownloadFailureOutput
Check "report carries no credentials" (-not ($redactedOutput -like "*dummy-secret*"))
$redactedGuidance = (Show-DownloadFailureGuidance -Asset "a" -Kind "binary" 6>&1 | Out-String)
Check "guidance shows no credentials" (-not ($redactedGuidance -like "*dummy-secret*"))

Write-Host "guidance is specific to what failed"
$binaryGuidance = (Show-DownloadFailureGuidance -Asset "squirrel-1.2.3-windows-x64.exe" -Kind "binary" 6>&1 | Out-String)
Check "a binary gets the by-hand recipe" ($binaryGuidance -like "*Move-Item squirrel-1.2.3-windows-x64.exe*")
# The bin directory does not exist until the first successful install, and
# Move-Item will not create it.
Check "the recipe creates its destination first" ($binaryGuidance -like "*New-Item -ItemType Directory -Force -Path*")
Check "the retry recipe sets the variable before the pipe" ($binaryGuidance -like "*`$env:SQUIRREL_FORCE_MIRROR='1'; iwr*")
$manifestGuidance = (Show-DownloadFailureGuidance -Asset "manifest.json" -Kind "manifest" 6>&1 | Out-String)
# Telling someone to move a manifest.json to <bin>\squirrel.exe is worse than
# saying nothing.
Check "a manifest gets no by-hand recipe" (-not ($manifestGuidance -like "*Move-Item manifest.json*"))
Check "a manifest names the allowlist route" ($manifestGuidance -like "*Allowlist github.com*")

if ($script:Failures -gt 0) {
    Write-Host ""
    Write-Host "$($script:Failures) check(s) failed"
    exit 1
}
Write-Host ""
Write-Host "install.ps1 contract checks passed"
