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

# Parse the whole file before anything else. The dot-source below only covers
# the part above `Main`, so a syntax error past that point would otherwise reach
# users unseen.
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    $installer, [ref]$null, [ref]$parseErrors) | Out-Null
if ($parseErrors) {
    $parseErrors | ForEach-Object { Write-Host "PARSE ERROR: $_" }
    exit 1
}
Write-Host "install.ps1 parsed clean"

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

Write-Host "release metadata is limited to URL-safe values"
Check "a normal version is accepted" (Test-ReleaseVersion "v1.2.3-beta.1")
Check "a dot version is rejected" (-not (Test-ReleaseVersion "."))
Check "a dot-dot version is rejected" (-not (Test-ReleaseVersion ".."))
Check "a v-dot-dot version is rejected" (-not (Test-ReleaseVersion "v.."))
Check "a path version is rejected" (-not (Test-ReleaseVersion "../v1.2.3"))
Check "a query version is rejected" (-not (Test-ReleaseVersion "v1.2.3?download=1"))
Check "a normal filename is accepted" (Test-ReleaseFilename "squirrel-1.2.3-windows-x64.exe")
Check "a path filename is rejected" (-not (Test-ReleaseFilename "../squirrel.exe"))
Check "a nested filename is rejected" (-not (Test-ReleaseFilename "nested/squirrel.exe"))
Check "a lowercase sha256 is accepted" (Test-Sha256 ("ab" * 32))
Check "an uppercase sha256 is accepted" (Test-Sha256 (("ab" * 32).ToUpperInvariant()))
Check "a malformed sha256 is rejected" (-not (Test-Sha256 "not-a-sha256"))
Check "a version with a trailing newline is rejected" (-not (Test-ReleaseVersion "v1.2.3`n"))
Check "a filename with a trailing newline is rejected" (-not (Test-ReleaseFilename "squirrel.exe`n"))
Check "a sha256 with a trailing newline is rejected" (-not (Test-Sha256 (("ab" * 32) + "`n")))

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

Write-Host "the printed recipe survives an apostrophe in the path"
# A profile under C:\Users\O'Brien would otherwise print a command that does
# not parse: the apostrophe ends the single-quoted string.
Check "an apostrophe is doubled" ((Get-SingleQuoted "C:\Users\O'Brien\bin") -eq "'C:\Users\O''Brien\bin'")
Check "an ordinary path is just quoted" ((Get-SingleQuoted "C:\Users\nik\bin") -eq "'C:\Users\nik\bin'")
$savedBinDir = $script:InstallBinDir
$script:InstallBinDir = "C:\Users\O'Brien\AppData\Local\squirrel\bin"
$apostropheGuidance = (Show-DownloadFailureGuidance -Asset "squirrel-1.2.3-windows-x64.exe" -Kind "binary" 6>&1 | Out-String)
$recipe = ($apostropheGuidance -split "`n" | Where-Object { $_ -like "*Move-Item*" }) -join ""
# Round-trip it: the printed command must parse, and its second argument must be
# the path we started from.
$recipeErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($recipe.Trim(), [ref]$null, [ref]$recipeErrors)
Check "the printed recipe parses" ($recipeErrors.Count -eq 0)
$elements = $ast.EndBlock.Statements[0].PipelineElements[0].CommandElements
Check "the destination round-trips exactly" ($elements[2].Value -eq "C:\Users\O'Brien\AppData\Local\squirrel\bin\squirrel.exe")
Check "the asset argument is quoted too" ($elements[1].Value -eq "squirrel-1.2.3-windows-x64.exe")
$script:InstallBinDir = $savedBinDir

Write-Host "a non-manifest 200 is a failed source, not a successful download"
# Invoke-RestMethod hands back an HTML body as a string rather than throwing, so
# a captive portal or proxy error page would otherwise be accepted as a manifest.
Check "an HTML string is rejected" (-not (Test-ManifestShape "<html><body>Sign in</body></html>"))
Check "null is rejected" (-not (Test-ManifestShape $null))
Check "an object missing binaries is rejected" (-not (Test-ManifestShape ([pscustomobject]@{ version = "1.2.3" })))
Check "an object missing version is rejected" (-not (Test-ManifestShape ([pscustomobject]@{ binaries = @{} })))
# `binaries` has to be a map. A scalar would otherwise be accepted, the mirror
# never tried, and the user told "No binary for platform" by a source that
# plainly failed.
Check "a scalar binaries is rejected" (-not (Test-ManifestShape ([pscustomobject]@{ version = "1.2.3"; binaries = "unavailable" })))
Check "a numeric binaries is rejected" (-not (Test-ManifestShape ([pscustomobject]@{ version = "1.2.3"; binaries = 0 })))
Check "a hashtable binaries is accepted" (Test-ManifestShape ([pscustomobject]@{ version = "1.2.3"; binaries = @{ "windows-x64" = @{} } }))
Check "a real manifest is accepted" (Test-ManifestShape ([pscustomobject]@{ version = "1.2.3"; binaries = [pscustomobject]@{ "windows-x64" = @{} } }))

function Invoke-RestMethod { param($Uri, $TimeoutSec)
  if ($Uri -like "*github.com*") { return "<html><body>Sign in to continue</body></html>" }
  return [pscustomobject]@{ version = "1.2.3"; binaries = [pscustomobject]@{ "windows-x64" = [pscustomobject]@{ filename = "f"; sha256 = "s" } } }
}
$recovered = Get-ReleaseAssetJson -Version "v1.2.3" -Asset "manifest.json" -Label "manifest"
Check "an HTML GitHub response falls through to the mirror" ($null -ne $recovered)
Check "the mirror is recorded as the source" ($script:DownloadSource -eq "install.squirrelscan.com")

function Invoke-RestMethod { param($Uri, $TimeoutSec) return "<html><body>Sign in</body></html>" }
$exhausted = Get-ReleaseAssetJson -Version "v1.2.3" -Asset "manifest.json" -Label "manifest"
Check "HTML from both sources returns null, so the caller reports the actionable error" ($null -eq $exhausted)

Write-Host "a mirror URL carrying credentials is redacted"
# SQUIRREL_DOWNLOAD_ENDPOINT is user-supplied. The report scrubber strips home
# paths and clamps length; it knows nothing about URL userinfo.
Check "userinfo stripped" ((Get-RedactedUrl "https://alice:dummy-secret@mirror.test/dl/a") -eq "https://mirror.test/dl/a") # pragma: allowlist secret
Check "ordinary url untouched" ((Get-RedactedUrl "https://install.squirrelscan.com/dl/a") -eq "https://install.squirrelscan.com/dl/a")
Check "an @ in the path is not userinfo" ((Get-RedactedUrl "https://host/p@th/a") -eq "https://host/p@th/a")
# A token can hide in the query or the fragment just as easily as in userinfo.
Check "a query token is dropped" ((Get-RedactedUrl "https://mirror.test/dl/a?token=secret") -eq "https://mirror.test/dl/a")
Check "a fragment is dropped" ((Get-RedactedUrl "https://mirror.test/dl/a#secret") -eq "https://mirror.test/dl/a")
Check "userinfo, query and fragment all go at once" ((Get-RedactedUrl "https://u:p@host/x?token=y#z") -eq "https://host/x")
# Order matters: a `@` inside the QUERY must not be read as userinfo. Stripping
# userinfo first ate `host?token=user@` and promoted the token's value to the
# host, so the secret survived.
Check "an @ inside the query does not smuggle a secret through" ((Get-RedactedUrl "https://mirror.test?token=user@querysecret/v1/manifest.json") -eq "https://mirror.test")
$script:DownloadUrlMirror = "https://alice:dummy-secret@mirror.test/dl/a?token=querysecret#fragsecret" # pragma: allowlist secret
$redactedOutput = Get-DownloadFailureOutput
Check "report carries no userinfo password" (-not ($redactedOutput -like "*dummy-secret*"))
Check "report carries no query token" (-not ($redactedOutput -like "*querysecret*"))
Check "report carries no fragment" (-not ($redactedOutput -like "*fragsecret*"))
Check "report still names the host and path" ($redactedOutput -like "*https://mirror.test/dl/a*")
$redactedGuidance = (Show-DownloadFailureGuidance -Asset "a" -Kind "binary" 6>&1 | Out-String)
Check "guidance shows no userinfo password" (-not ($redactedGuidance -like "*dummy-secret*"))
Check "guidance shows no query token" (-not ($redactedGuidance -like "*querysecret*"))
Check "guidance shows no fragment" (-not ($redactedGuidance -like "*fragsecret*"))

Write-Host "guidance is specific to what failed"
$binaryGuidance = (Show-DownloadFailureGuidance -Asset "squirrel-1.2.3-windows-x64.exe" -Kind "binary" 6>&1 | Out-String)
Check "a binary gets the by-hand recipe" ($binaryGuidance -like "*Move-Item 'squirrel-1.2.3-windows-x64.exe'*")
# The bin directory does not exist until the first successful install, and
# Move-Item will not create it.
Check "the recipe creates its destination first" ($binaryGuidance -like "*New-Item -ItemType Directory -Force -Path*")
Check "the retry recipe sets the variable before the pipe" ($binaryGuidance -like "*`$env:SQUIRREL_FORCE_MIRROR='1'; iwr*")
$manifestGuidance = (Show-DownloadFailureGuidance -Asset "manifest.json" -Kind "manifest" 6>&1 | Out-String)
# Telling someone to move a manifest.json to <bin>\squirrel.exe is worse than
# saying nothing.
Check "a manifest gets no by-hand recipe" (-not ($manifestGuidance -like "*Move-Item manifest.json*"))
Check "a manifest names the allowlist route" ($manifestGuidance -like "*Allowlist github.com*")

Write-Host "PATH setup decides before it writes (never the registry here)"
# Every branch exercised below returns before Set-UserPath's one write, so this
# script never edits the real User Path.
foreach ($case in @(
    @("", $false), @("0", $false), @("false", $false), @("1", $true), @("yes", $true)
)) {
    $env:SQUIRREL_NO_MODIFY_PATH = $case[0]
    Check "SQUIRREL_NO_MODIFY_PATH '$($case[0])' -> $($case[1])" ((Test-NoModifyPath) -eq $case[1])
}
Remove-Item Env:SQUIRREL_NO_MODIFY_PATH -ErrorAction SilentlyContinue
Check "a path entry matches case-insensitively, trailing slash ignored" (Test-PathHasDir "C:\a;C:\Tools\Bin\;C:\b" "c:\tools\bin")
$env:SQUIRREL_CONTRACT_PROBE = "C:\probe"
Check "a %VAR% entry is compared expanded" (Test-PathHasDir "C:\a;%SQUIRREL_CONTRACT_PROBE%\bin" "C:\probe\bin")
Remove-Item Env:SQUIRREL_CONTRACT_PROBE -ErrorAction SilentlyContinue
Check "a prefix is not a match" (-not (Test-PathHasDir "C:\a\bin2" "C:\a\bin"))
$probeDir = "C:\squirrel-contract-probe\bin"
$savedPath = $env:Path
$env:Path = "$savedPath;$probeDir"
Check "a dir already on the session Path is on_path" ((Set-UserPath -BinDir $probeDir) -eq "on_path")
$env:Path = $savedPath
$env:SQUIRREL_NO_MODIFY_PATH = "1"
Check "opt-out writes nothing" ((Set-UserPath -BinDir $probeDir) -eq "opted_out")
Remove-Item Env:SQUIRREL_NO_MODIFY_PATH -ErrorAction SilentlyContinue
$savedCi = $env:CI
$savedGithubPath = $env:GITHUB_PATH
$env:CI = "true"
Remove-Item Env:GITHUB_PATH -ErrorAction SilentlyContinue
Check "CI does not edit the Path" ((Set-UserPath -BinDir $probeDir) -eq "ci")
if ($null -ne $savedCi) { $env:CI = $savedCi } else { Remove-Item Env:CI -ErrorAction SilentlyContinue }
if ($null -ne $savedGithubPath) { $env:GITHUB_PATH = $savedGithubPath }
Check "the Path is untouched after the checks" ($env:Path -eq $savedPath)

Write-Host "release attestation: gh present and matching, gh present and mismatching, gh absent (#169)"
# Write-Err really exits and Write-Warn really prints: record both instead.
$script:Warnings = @()
$script:ErrorsSeen = @()
function Write-Warn { param($Message) $script:Warnings += "$Message" }
function Write-Err {
    param([string]$Message, [string]$Output = "", [int]$ExitCode = 1)
    $script:ErrorsSeen += $Message
    throw "write-err"
}
# The real Invoke-GhBounded kills a process that outlives its deadline (runs the
# current PowerShell host as the slow child).
$hostExe = (Get-Process -Id $PID).Path
$env:SQUIRREL_TEST_GH_TIMEOUT_SECS = "2"
$realBounded = Invoke-GhBounded -GhName $hostExe -GhArgs @("-NoProfile", "-Command", "Start-Sleep -Seconds 60") -TimeoutSec 120
$fastBounded = Invoke-GhBounded -GhName $hostExe -GhArgs @("-NoProfile", "-Command", "Write-Output hi; exit 3") -TimeoutSec 120
Remove-Item Env:SQUIRREL_TEST_GH_TIMEOUT_SECS -ErrorAction SilentlyContinue
Check "a process that outlives the deadline is killed and reported as timed out" ($realBounded.TimedOut)
Check "a process that exits in time reports its code and output" (-not $fastBounded.TimedOut -and $fastBounded.Code -eq 3 -and $fastBounded.Output -like "*hi*")

# A stand-in for gh: records its argument lists and answers per subcommand.
$script:GhCalls = @()
$script:GhVerifyExit = 0
$script:GhAuthExit = 0
$script:GhHelpExit = 0
function squirrel-fake-gh {
    $script:GhCalls += ,@($args)
    if ($args[0] -eq "auth") { $global:LASTEXITCODE = $script:GhAuthExit; return }
    if ($args[0] -eq "attestation" -and $args[2] -eq "--help") { $global:LASTEXITCODE = $script:GhHelpExit; return }
    if ($args[0] -eq "attestation" -and $args[1] -eq "verify") {
        $global:LASTEXITCODE = $script:GhVerifyExit
        if ($script:GhVerifyExit -ne 0) { "verification failed" }
        return
    }
    $global:LASTEXITCODE = 99
}
$script:GhTimeoutOn = ""
# The stub function cannot run under Start-Process, so replace the bounded runner
# with one that calls it in-process and can simulate a timeout of one subcommand.
function Invoke-GhBounded {
    param([string]$GhName, [string[]]$GhArgs, [int]$TimeoutSec)
    $label = if ($GhArgs[0] -eq "auth") { "auth" } elseif ($GhArgs[2] -eq "--help") { "help" } else { "verify" }
    $script:GhTimeouts += ,@($label, $TimeoutSec)
    if ($script:GhTimeoutOn -eq $label) { $script:GhCalls += ,@($GhArgs); return @{ Code = -1; Output = ""; TimedOut = $true } }
    $out = (& $GhName @GhArgs 2>&1 | ForEach-Object { "$_" }) -join "`n"
    return @{ Code = $global:LASTEXITCODE; Output = $out; TimedOut = $false }
}
$script:GhTimeouts = @()
$binaryStub = Join-Path ([System.IO.Path]::GetTempPath()) "squirrel-ps-contract-binary"

$threw = $false
try { Test-ReleaseAttestation -Path $binaryStub -GhName "squirrel-fake-gh" } catch { $threw = $true }
$verifyCall = $script:GhCalls | Where-Object { $_[0] -eq "attestation" -and $_[1] -eq "verify" -and $_[2] -ne "--help" }
Check "a matching attestation does not fail" (-not $threw)
Check "it ran gh attestation verify <file> --repo squirrelscan/squirrelscan" (
    $verifyCall -and $verifyCall[2] -eq $binaryStub -and $verifyCall[3] -eq "--repo" -and $verifyCall[4] -eq "squirrelscan/squirrelscan" -and $verifyCall[5] -eq "--cert-identity" -and $verifyCall[6] -eq "https://github.com/squirrelscan/squirrelscan/.github/workflows/release.yml@refs/heads/main" -and $verifyCall[7] -eq "--deny-self-hosted-runners")
Check "a match prints no warning" ($script:Warnings.Count -eq 0)

$script:GhVerifyExit = 1
$script:ErrorsSeen = @()
$threw = $false
try { Test-ReleaseAttestation -Path $binaryStub -GhName "squirrel-fake-gh" } catch { $threw = $true }
Check "a mismatch fails the install" ($threw -and $script:ErrorsSeen.Count -eq 1)
Check "the failure says nothing was installed" ($script:ErrorsSeen[0] -like "*Nothing was installed*")

$script:GhVerifyExit = 1
$script:GhAuthExit = 1
$script:Warnings = @()
$threw = $false
try { Test-ReleaseAttestation -Path $binaryStub -GhName "squirrel-fake-gh" } catch { $threw = $true }
Check "a gh that is not logged in warns and falls back" (-not $threw -and $script:Warnings.Count -eq 1 -and $script:Warnings[0] -like "*not logged in*")
$script:GhAuthExit = 0

$script:GhHelpExit = 1
$script:Warnings = @()
$threw = $false
try { Test-ReleaseAttestation -Path $binaryStub -GhName "squirrel-fake-gh" } catch { $threw = $true }
Check "a gh without the attestation command warns and falls back" (-not $threw -and $script:Warnings.Count -eq 1 -and $script:Warnings[0] -like "*too old*")
$script:GhHelpExit = 0

$script:Warnings = @()
$threw = $false
try { Test-ReleaseAttestation -Path $binaryStub -GhName "squirrel-no-such-gh-on-this-machine" } catch { $threw = $true }
Check "no gh: warns visibly and does not fail" (-not $threw -and $script:Warnings.Count -eq 1 -and $script:Warnings[0] -like "*sha256*")

$authCall = $script:GhCalls | Where-Object { $_[0] -eq "auth" } | Select-Object -First 1
Check "the auth probe is pinned to github.com" ($authCall -and ($authCall -join " ") -eq "auth status --hostname github.com")
Check "deadlines are 15s for the probes and 120s for verify" (
    ($script:GhTimeouts | Where-Object { $_[0] -eq "help" -or $_[0] -eq "auth" } | Where-Object { $_[1] -ne 15 }).Count -eq 0 -and
    ($script:GhTimeouts | Where-Object { $_[0] -eq "verify" } | Where-Object { $_[1] -ne 120 }).Count -eq 0)

foreach ($probe in @("help", "auth")) {
    $script:GhTimeoutOn = $probe
    $script:Warnings = @()
    $threw = $false
    try { Test-ReleaseAttestation -Path $binaryStub -GhName "squirrel-fake-gh" } catch { $threw = $true }
    Check "a $probe probe timeout warns and skips" (-not $threw -and $script:Warnings.Count -eq 1 -and $script:Warnings[0] -like "*timed out*")
}
$script:GhTimeoutOn = "verify"
$script:ErrorsSeen = @()
$threw = $false
try { Test-ReleaseAttestation -Path $binaryStub -GhName "squirrel-fake-gh" } catch { $threw = $true }
Check "a verify timeout fails closed" ($threw -and $script:ErrorsSeen[0] -eq "gh attestation verify timed out after 120s, nothing was installed.")
$script:GhTimeoutOn = ""

# ---------------------------------------------------------------------------
Write-Host "release-key signatures and the signed era (squirrelscan/repo#5032)"
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $openssl) { Write-Host "  FAIL openssl is required for these checks"; $script:Failures++ }
$work = Join-Path ([System.IO.Path]::GetTempPath()) "squirrel-ps-sig-$(Get-Random)"
New-Item -ItemType Directory -Path $work | Out-Null
$fixture = Get-Content (Join-Path $PSScriptRoot "fixtures/version-compare.json") -Raw | ConvertFrom-Json

# The shared comparison table, the same one install.sh and the updater read.
$cmpBad = @($fixture.compare | Where-Object { (Compare-ReleaseVersion $_.a $_.b) -ne $_.cmp })
Check "version compare matches the shared table ($($fixture.compare.Count) cases)" ($cmpBad.Count -eq 0)
$eraBad = @($fixture.era | Where-Object { (Test-SignedEra $_.version $_.first) -ne $_.era })
Check "signed-era decisions match the shared table ($($fixture.era.Count) cases)" ($eraBad.Count -eq 0)
Check "a prerelease of the first signed version is not signed-era" (-not (Test-SignedEra "0.0.190-beta.1" "0.0.190"))
Check "an unset first_signed_version is never signed-era" (-not (Test-SignedEra "0.0.999" ""))

# THROWAWAY test keys, made by the real openssl. Never a production key.
function New-TestKey {
    param([string]$Name)
    & $openssl ecparam -name prime256v1 -genkey -noout -out (Join-Path $work "$Name.key") 2> $null
    & $openssl ec -in (Join-Path $work "$Name.key") -pubout -out (Join-Path $work "$Name.pub") 2> $null
    $spki = ConvertFrom-PemPublicKey (Get-Content (Join-Path $work "$Name.pub") -Raw)
    $id = ([BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($spki)) -replace '-', '').ToLowerInvariant().Substring(0, 16)
    return @{ Name = $Name; Id = $id; Pem = (Get-Content (Join-Path $work "$Name.pub") -Raw).TrimEnd(); Spki = $spki }
}
function Set-OpensslSignature {
    param([string]$Key, [string]$File, [string]$Out)
    & $openssl dgst -sha256 -sign (Join-Path $work "$Key.key") -out $Out $File
}
$kGood = New-TestKey "good"
$kRevoked = New-TestKey "revoked"
$kForeign = New-TestKey "foreign"

Write-Host "DER to raw r||s and the 5.1 key blob"
# Real openssl signatures, verified after conversion by .NET's own P1363 verifier,
# so the converter is checked against something that did not write it.
$msg = [System.Text.Encoding]::UTF8.GetBytes("squirrel release")
$msgFile = Join-Path $work "msg.bin"
[System.IO.File]::WriteAllBytes($msgFile, $msg)
function New-P256Verifier {
    param([byte[]]$X, [byte[]]$Y)
    $q = [System.Security.Cryptography.ECPoint]::new()
    $q.X = $X
    $q.Y = $Y
    $p = [System.Security.Cryptography.ECParameters]::new()
    $p.Curve = [System.Security.Cryptography.ECCurve]::CreateFromFriendlyName("nistP256")
    $p.Q = $q
    return [System.Security.Cryptography.ECDsa]::Create($p)
}
$point = Get-SpkiPoint $kGood.Spki
$verifier = New-P256Verifier ([byte[]]$point[0..31]) ([byte[]]$point[32..63])
$convBad = 0
$sigFile = Join-Path $work "sig.der"
for ($i = 0; $i -lt 150; $i++) {
    Set-OpensslSignature "good" $msgFile $sigFile
    $raw = ConvertFrom-DerSignature ([System.IO.File]::ReadAllBytes($sigFile))
    if ($null -eq $raw -or $raw.Length -ne 64 -or -not $verifier.VerifyData($msg, $raw, [System.Security.Cryptography.HashAlgorithmName]::SHA256)) { $convBad++ }
}
Check "150 real openssl signatures convert to a raw signature that verifies" ($convBad -eq 0)

# r or s with a leading zero byte (a short integer, or the 0x00 sign pad) is the
# edge: sign with .NET until both shapes were seen, then convert every one.
$ec2 = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve]::CreateFromFriendlyName("nistP256"))
$p2 = $ec2.ExportParameters($false)
$ver2 = New-P256Verifier $p2.Q.X $p2.Q.Y
$short = 0; $padded = 0; $bad2 = 0; $n = 0
while (($short -lt 5 -or $padded -lt 5) -and $n -lt 20000) {
    $n++
    $der = $ec2.SignData($msg, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
    $rLen = $der[3]
    $sLen = $der[5 + $rLen]
    if ($rLen -lt 32 -or $sLen -lt 32) { $short++ }
    if ($rLen -eq 33 -or $sLen -eq 33) { $padded++ }
    $raw = ConvertFrom-DerSignature $der
    if ($null -eq $raw -or -not $ver2.VerifyData($msg, $raw, [System.Security.Cryptography.HashAlgorithmName]::SHA256)) { $bad2++ }
}
Check "signatures with a short r or s ($short seen) and a 0x00-padded r or s ($padded seen) convert and verify" ($short -ge 5 -and $padded -ge 5 -and $bad2 -eq 0)
$goodShort = ConvertFrom-DerSignature ([byte[]](0x30,0x06,0x02,0x01,0x01,0x02,0x01,0x02))
Check "r=1, s=2 left-pads to 32 bytes each" ($goodShort.Length -eq 64 -and $goodShort[31] -eq 1 -and $goodShort[63] -eq 2 -and ($goodShort[0..30] + $goodShort[32..62] | Where-Object { $_ -ne 0 }).Count -eq 0)
foreach ($case in @(
    @("a negative integer", [byte[]](0x30,0x06,0x02,0x01,0x81,0x02,0x01,0x02)),
    @("a non-minimal leading zero", [byte[]](0x30,0x07,0x02,0x02,0x00,0x01,0x02,0x01,0x02)),
    @("trailing bytes", [byte[]](0x30,0x07,0x02,0x01,0x01,0x02,0x01,0x02,0x00)),
    @("a wrong sequence length", [byte[]](0x30,0x05,0x02,0x01,0x01,0x02,0x01,0x02)),
    @("not a sequence", [byte[]](0x31,0x06,0x02,0x01,0x01,0x02,0x01,0x02)),
    @("an oversized integer", [byte[]](@(0x30,0x28,0x02,0x21,0x01) + (,0 * 32) + @(0x02,0x01,0x02))),
    @("empty input", [byte[]]@())
)) {
    Check "DER with $($case[0]) is rejected" ($null -eq (ConvertFrom-DerSignature $case[1]))
}

$blob = New-EccPublicBlob $point
Check "the blob is 72 bytes: magic ECS1, length 32, X, Y" (
    $blob.Length -eq 72 -and [Text.Encoding]::ASCII.GetString($blob[0..3]) -eq "ECS1" -and
    [BitConverter]::ToUInt32($blob, 4) -eq 32 -and ($blob[0] -eq 0x45 -and $blob[3] -eq 0x31))
Set-OpensslSignature "good" $msgFile $sigFile
$viaBlob = New-P256Verifier ([byte[]]$blob[8..39]) ([byte[]]$blob[40..71])
Check "the key rebuilt from the blob verifies an openssl signature" ($viaBlob.VerifyData($msg, (ConvertFrom-DerSignature ([System.IO.File]::ReadAllBytes($sigFile))), [System.Security.Cryptography.HashAlgorithmName]::SHA256))
Check "a SPKI that is not P-256 gives no point" ($null -eq (Get-SpkiPoint ([byte[]](1,2,3))))

Write-Host "provenance: signature, attestation, and the signed-era hard fail"
$script:Served = @{}
function Invoke-WebRequest {
    param($Uri, $OutFile, $TimeoutSec, [switch]$UseBasicParsing)
    $name = ($Uri -split '/')[-1]
    if (-not $script:Served.ContainsKey($name)) { throw "404" }
    Copy-Item -Path $script:Served[$name] -Destination $OutFile -Force
}
function New-Release {
    param([string]$Dir, [string]$Version, [string]$SignWith, [string]$KeyId, [string]$ManifestVersion = "")
    if (-not $ManifestVersion) { $ManifestVersion = $Version }
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    $bin = Join-Path $Dir "squirrel.exe"
    [System.IO.File]::WriteAllBytes($bin, [System.Text.Encoding]::UTF8.GetBytes("squirrel binary $Version"))
    $sha = (Get-FileHash $bin -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = Join-Path $Dir "manifest.json"
    [System.IO.File]::WriteAllText($manifest, "{`"version`":`"$ManifestVersion`",`"signing_key_id`":`"$KeyId`",`"binaries`":{`"windows-x64`":{`"filename`":`"squirrel.exe`",`"sha256`":`"$sha`"}}}`n")
    if ($SignWith) {
        Set-OpensslSignature $SignWith $manifest "$manifest.sig"
        Set-OpensslSignature $SignWith $bin "$bin.sig"
    }
    return $Dir
}
function Invoke-Provenance {
    param([string]$Dir, [string]$Version, [string]$Gh = "squirrel-fake-gh")
    $script:Served = @{}
    foreach ($f in Get-ChildItem $Dir) { $script:Served[$f.Name] = $f.FullName }
    $null = Get-DownloadSources -Version $Version -Asset "squirrel.exe"
    $script:DownloadSource = "github.com"
    $script:GhCalls = @(); $script:Warnings = @(); $script:ErrorsSeen = @()
    $threw = $false
    try { Test-ReleaseProvenance -Version $Version -Filename "squirrel.exe" -BinaryPath (Join-Path $Dir "squirrel.exe") -GhName $Gh } catch { $threw = $true }
    $verify = @($script:GhCalls | Where-Object { $_[0] -eq "attestation" -and $_[1] -eq "verify" -and $_[2] -ne "--help" })
    return @{ Threw = $threw; Error = ($script:ErrorsSeen -join "`n"); Warn = ($script:Warnings -join "`n"); GhVerified = ($verify.Count -gt 0) }
}

$ReleaseKeyCurrentId = $kGood.Id;    $ReleaseKeyCurrentPem = $kGood.Pem
$ReleaseKeyNextId = $kRevoked.Id;    $ReleaseKeyNextPem = $kRevoked.Pem
$ReleaseKeysRevoked = $kRevoked.Id
$ReleaseFirstSignedVersion = "0.0.190"
$script:GhVerifyExit = 0; $script:GhAuthExit = 0; $script:GhHelpExit = 0
$NoGh = "squirrel-no-such-gh-on-this-machine"
$rel = Join-Path $work "rel"

$d = New-Release "$rel/good" "0.0.190" "good" $kGood.Id
$r = Invoke-Provenance $d "v0.0.190" $NoGh
Check "signed era, no gh, valid signature: installs" (-not $r.Threw -and $r.Warn -eq "")
$r = Invoke-Provenance $d "v0.0.190"
Check "a valid signature never asks gh" (-not $r.Threw -and -not $r.GhVerified)

$d = New-Release "$rel/nosig" "0.0.190" "" $kGood.Id
$r = Invoke-Provenance $d "v0.0.190" $NoGh
Check "signed era, no gh, no .sig: hard fail" ($r.Threw -and $r.Error -like "*sha256 checksum alone is not accepted*" -and $r.Error -like "*no .sig files*" -and $r.Error -like "*openssl dgst -sha256 -verify*")
Check "signed era, no gh, no .sig: it is not a warning" ($r.Warn -eq "")
$script:GhAuthExit = 1
$r = Invoke-Provenance $d "v0.0.190"
Check "signed era, gh not logged in, no .sig: hard fail" ($r.Threw -and $r.Error -like "*not logged in*")
$script:GhAuthExit = 0; $script:GhHelpExit = 1
$r = Invoke-Provenance $d "v0.0.190"
Check "signed era, gh too old, no .sig: hard fail" ($r.Threw -and $r.Error -like "*too old*")
$script:GhHelpExit = 0
$r = Invoke-Provenance $d "v0.0.190"
Check "signed era, valid attestation, no .sig: installs" (-not $r.Threw -and $r.GhVerified)
$script:GhVerifyExit = 1
$r = Invoke-Provenance $d "v0.0.190"
Check "signed era, attestation fails, no .sig: hard fail" ($r.Threw -and $r.Error -like "*Attestation verification failed*")
$script:GhVerifyExit = 0

$d = New-Release "$rel/tampered" "0.0.190" "good" $kGood.Id
[System.IO.File]::AppendAllText("$d/squirrel.exe", "X")
$r = Invoke-Provenance $d "v0.0.190"
Check "a tampered binary fails the signature even with a passing attestation" ($r.Threw -and $r.Error -like "*squirrel.exe is not signed by key*" -and -not $r.GhVerified)
$d = New-Release "$rel/foreign" "0.0.190" "foreign" $kForeign.Id
$r = Invoke-Provenance $d "v0.0.190"
Check "a foreign key fails even with a passing attestation" ($r.Threw -and $r.Error -like "*does not pin*" -and -not $r.GhVerified)
$d = New-Release "$rel/revoked" "0.0.190" "revoked" $kRevoked.Id
$r = Invoke-Provenance $d "v0.0.190"
Check "a revoked key id fails even with a passing attestation" ($r.Threw -and $r.Error -like "*revoked key*" -and -not $r.GhVerified)
$d = New-Release "$rel/replay" "0.0.190" "good" $kGood.Id "0.0.189"
$r = Invoke-Provenance $d "v0.0.190"
Check "a signed manifest for another version fails" ($r.Threw -and $r.Error -like "*signed manifest is for version*")
$d = New-Release "$rel/half" "0.0.190" "good" $kGood.Id
Remove-Item "$d/squirrel.exe.sig"
$r = Invoke-Provenance $d "v0.0.190"
Check "one .sig without the other fails" ($r.Threw -and $r.Error -like "*squirrel.exe.sig is missing*")

$d = New-Release "$rel/pre-era" "0.0.189" "" $kGood.Id
$r = Invoke-Provenance $d "v0.0.189" $NoGh
Check "before the era, no gh, no .sig: warns and installs (unchanged)" (-not $r.Threw -and $r.Warn -like "*relying on the sha256 checksum only*")
$d = New-Release "$rel/pre-beta" "0.0.190-beta.1" "" $kGood.Id
$r = Invoke-Provenance $d "0.0.190-beta.1" $NoGh
Check "a prerelease of the first signed version is before the era (unchanged)" (-not $r.Threw)
$ReleaseFirstSignedVersion = ""
$d = New-Release "$rel/unset" "0.0.999" "" $kGood.Id
$r = Invoke-Provenance $d "0.0.999" $NoGh
Check "first_signed_version unset, no gh, no .sig: warns and installs (unchanged)" (-not $r.Threw -and $r.Warn -like "*relying on the sha256 checksum only*")
$ReleaseKeyCurrentPem = ""; $ReleaseKeyNextPem = ""; $ReleaseKeyCurrentId = ""; $ReleaseKeyNextId = ""
$d = New-Release "$rel/nokey" "0.0.189" "good" $kGood.Id
$r = Invoke-Provenance $d "0.0.189"
Check "no key pinned: signatures are ignored and the attestation decides" (-not $r.Threw -and $r.GhVerified)

$verifier.Dispose(); $ec2.Dispose(); $ver2.Dispose(); $viaBlob.Dispose()
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

if ($script:Failures -gt 0) {
    Write-Host ""
    Write-Host "$($script:Failures) check(s) failed"
    exit 1
}
Write-Host ""
Write-Host "install.ps1 contract checks passed"
