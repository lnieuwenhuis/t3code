#Requires -Version 5.1
<#
.SYNOPSIS
Build and install lnieuwenhuis/t3code from source on Windows.
.DESCRIPTION
Requires Git, Vite+ (vp), Rust, Python 3, and Visual Studio C++ build tools,
a Windows SDK and Spectre libraries. Does not install system prerequisites.
Uses a fresh shallow clone by default. Existing T3 Code is replaced on install.
The silent installer does not launch the app or modify its user data.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows-fork.ps1
.EXAMPLE
.\install-windows-fork.ps1 -BuildOnly
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'lnieuwenhuis/t3code',
    [ValidateNotNullOrEmpty()]
    [string]$Branch = 'main',
    [string]$SourcePath,
    [string]$OutputDirectory = (Join-Path $env:USERPROFILE 'Downloads\T3Code-Fork'),
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'This script currently builds Windows x64 only. Run it in a 64-bit PowerShell on x64 Windows.'
}

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE." }
}

foreach ($command in @('git', 'vp', 'cargo', 'rustup')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing $command. See docs/operations/windows-fork-install.md for prerequisites."
    }
}
Invoke-Checked git @('check-ref-format', '--branch', $Branch)

if (-not $SourcePath) {
    $buildRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'GitHub'
    $SourcePath = Join-Path $buildRoot ('t3code-build-' + [guid]::NewGuid().ToString('N').Substring(0, 10))
    Invoke-Checked git @('clone', '--depth', '1', '--single-branch', '--branch', $Branch,
        "https://github.com/$Repository.git", $SourcePath)
}
$SourcePath = (Resolve-Path -LiteralPath $SourcePath).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$previousUpdateRepository = $env:T3CODE_DESKTOP_UPDATE_REPOSITORY
Push-Location $SourcePath
try {
    if (-not (Test-Path -LiteralPath 'scripts/build-desktop-artifact.ts')) {
        throw 'SourcePath must contain a T3 Code checkout with the desktop artifact builder.'
    }
    $changes = & git status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Source checkout must have no tracked changes.' }
    $commit = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read source commit.' }
    $manifest = Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json
    $baseVersion = ($manifest.version -split '-')[0]
    $version = "$baseVersion-fork.$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
    $buildOutput = Join-Path $OutputDirectory $version
    Write-Host "Building $Repository ($commit) from $SourcePath"
    Write-Host 'The checkout and artifacts are retained for rebuilding and troubleshooting.'

    Invoke-Checked vp @('install', '--filter=@t3tools/desktop...', '--filter=t3...',
        '--filter=@t3tools/scripts...', '--frozen-lockfile')
    # Keep packaged update metadata on the fork, never the upstream release feed.
    $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = $Repository
    Invoke-Checked vp @('run', 'dist:desktop:win:x64', '--build-version', $version,
        '--output-dir', $buildOutput, '--verbose')

    $installer = Join-Path $buildOutput "T3-Code-$version-x64.exe"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw "Build finished without the expected installer: $installer"
    }
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    [ordered]@{ repository = $Repository; commit = $commit; version = $version;
        sourcePath = $SourcePath; installer = $installer; sha256 = $hash } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildOutput 'build-info.json') -Encoding UTF8
    Write-Host "Installer: $installer"
    Write-Host "SHA256: $hash"
    if ($BuildOnly) { return }

    # electron-builder's one-click NSIS installer skips launch when /S is used.
    # Let the user close T3; never terminate their running agent sessions.
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object ProcessName -Like 'T3 Code*')
    if ($running.Count -gt 0) {
        throw "T3 Code is running. Close it when safe, then run: & '$installer' /S"
    }
    Write-Host 'Installing for the current user; this replaces the existing T3 Code application.'
    $process = Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser' -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)." }
    Write-Host 'Installer completed. Launch T3 Code from the Start menu when ready.'
} finally {
    $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = $previousUpdateRepository
    Pop-Location
}
