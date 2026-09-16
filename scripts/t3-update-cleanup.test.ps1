$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 't3-update-cleanup.ps1')
function Assert-Cleanup { param($Condition, $Message) if (-not $Condition) { throw $Message } }
$fixture = Join-Path $env:TEMP ('t3-cleanup-test-' + [guid]::NewGuid().ToString('N'))
$runs = Join-Path $fixture 'runs'
$builds = Join-Path $fixture 'builds'
New-Item -ItemType Directory -Path $runs, $builds | Out-Null
function New-TestRun {
    param([int]$Day, [switch]$Unmarked)
    $path = Join-Path $runs ('202601{0:00}-120000-abcdef' -f $Day)
    $source = Join-Path $path 'source'
    New-Item -ItemType Directory -Path $source | Out-Null
    & git init -q $source
    & git -C $source remote add origin https://github.com/lnieuwenhuis/t3code.git
    Set-Content (Join-Path $source '.git/info/exclude') 'node_modules/'
    Set-Content (Join-Path $source '.env.example') 'tracked template'
    & git -C $source add .env.example
    & git -C $source -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m fixture
    if ($LASTEXITCODE) { throw 'Fixture git creation failed' }
    if (-not $Unmarked) {
        @{ schemaVersion = 1; completedAt = ('2026-01-{0:00}T12:00:00Z' -f $Day); commit = (& git -C $source rev-parse HEAD) } |
            ConvertTo-Json | Set-Content (Join-Path $path '.update-complete.json')
    }
    return $path
}
function New-TestBuild {
    param([int]$Day)
    $version = '0.0.40-fork.202601{0:00}120000' -f $Day
    $path = Join-Path $builds $version
    New-Item -ItemType Directory -Path $path | Out-Null
    $installer = Join-Path $path 'setup.exe'
    Set-Content $installer 'fixture'
    @{ repository = 'lnieuwenhuis/t3code'; installer = $installer } | ConvertTo-Json | Set-Content (Join-Path $path 'build-info.json')
    return $path
}
$old = New-TestRun 1
$generatedSource = Join-Path $old 'source'
foreach ($generated in @('.generated', '.pnpm-store', '.vite-hooks/_', 'apps/desktop/dist-electron', 'apps/server/dist', 'apps/web/dist', 'native/resource-monitor/target', 'scripts/node_modules', 'packages/shared/node_modules')) {
    New-Item -ItemType Directory -Path (Join-Path $generatedSource $generated) -Force | Out-Null
    Set-Content (Join-Path (Join-Path $generatedSource $generated) 'fixture') 'generated'
    Add-Content (Join-Path $generatedSource '.git/info/exclude') ($generated + '/')
}
Set-Content (Join-Path $generatedSource '.vite-hooks/_/applypatch-msg') 'generated hook'
foreach ($parent in @('apps/desktop', 'apps/server', 'apps/web', 'native/resource-monitor', 'scripts', 'packages/shared')) {
    Set-Content (Join-Path (Join-Path $generatedSource $parent) 'package-fixture.txt') 'tracked package'
    & git -C $generatedSource add ($parent + '/package-fixture.txt')
}
# Tracking one hook prevents Git from collapsing the whole hooks directory.
Set-Content (Join-Path $generatedSource '.vite-hooks/pre-commit') 'tracked hook'
& git -C $generatedSource add .vite-hooks/pre-commit
& git -C $generatedSource -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -q -m hook
$markerPath = Join-Path $old '.update-complete.json'
$marker = Get-Content $markerPath -Raw | ConvertFrom-Json
$marker.commit = (& git -C $generatedSource rev-parse HEAD)
$marker | ConvertTo-Json | Set-Content $markerPath
$current = New-TestRun 2
$dirty = New-TestRun 3
Set-Content (Join-Path $dirty 'source/untracked.txt') 'retain'
$unmarked = New-TestRun 4 -Unmarked
$wrongCommit = New-TestRun 5
(Get-Content (Join-Path $wrongCommit '.update-complete.json') -Raw).Replace('"commit":', '"unused":') | Set-Content (Join-Path $wrongCommit '.update-complete.json')
$data = New-TestRun 6
New-Item -ItemType Directory -Path (Join-Path $data 'source/.t3') | Out-Null
$linked = New-TestRun 7
Rename-Item (Join-Path $linked 'source/.git') '.git-retained'
Set-Content (Join-Path $linked 'source/.git') 'gitdir: outside'
$wrongOrigin = New-TestRun 10
& git -C (Join-Path $wrongOrigin 'source') remote set-url origin https://github.com/example/other.git
$headMismatch = New-TestRun 11
& git -C (Join-Path $headMismatch 'source') -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m changed
$withWorktrees = New-TestRun 13
New-Item -ItemType Directory -Path (Join-Path $withWorktrees 'source/.git/worktrees') | Out-Null
$withEnv = New-TestRun 14
Add-Content (Join-Path $withEnv 'source/.git/info/exclude') '.env*'
Set-Content (Join-Path $withEnv 'source/.env.local') 'secret fixture'
$withStash = New-TestRun 15
Set-Content (Join-Path $withStash 'source/.env.example') 'stashed work'
& git -C (Join-Path $withStash 'source') -c user.name=Fixture -c user.email=fixture@example.invalid stash push -q
$withBranch = New-TestRun 16
$branchSource = Join-Path $withBranch 'source'
$tree = & git -C $branchSource rev-parse 'HEAD^{tree}'
$uniqueCommit = & git -C $branchSource -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit-tree $tree -p HEAD -m unique
& git -C $branchSource branch retained $uniqueCommit
$withTag = New-TestRun 17
$tagSource = Join-Path $withTag 'source'
$tree = & git -C $tagSource rev-parse 'HEAD^{tree}'
$uniqueCommit = & git -C $tagSource -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit-tree $tree -p HEAD -m unique
& git -C $tagSource tag retained $uniqueCommit
$nestedEnv = New-TestRun 18
New-Item -ItemType Directory -Path (Join-Path $nestedEnv 'source/apps/web') | Out-Null
Add-Content (Join-Path $nestedEnv 'source/.git/info/exclude') '.env*'
Set-Content (Join-Path $nestedEnv 'source/apps/web/.env.local') 'nested fixture'
$newer = New-TestRun 8
$newest = New-TestRun 9
$oldBuild = New-TestBuild 1
$secondBuild = New-TestBuild 2
$newBuild = New-TestBuild 3
$malformedBuild = New-TestBuild 4
@{ repository = 'lnieuwenhuis/t3code'; installer = (Join-Path $oldBuild 'setup.exe') } | ConvertTo-Json | Set-Content (Join-Path $malformedBuild 'build-info.json')
$outside = Join-Path $fixture 'outside'
New-Item -ItemType Directory -Path $outside | Out-Null
Set-Content (Join-Path $outside 'keep.txt') 'must survive'
New-Item -ItemType Junction -Path (Join-Path $old 'source/node_modules') -Target $outside | Out-Null
Invoke-T3Cleanup -RunsRoot $runs -BuildsRoot $builds -CurrentRun $current -Preview
Assert-Cleanup (Test-Path $old) 'Preview removed run'
Assert-Cleanup (Test-Path $oldBuild) 'Preview removed build'
Invoke-T3Cleanup -RunsRoot $runs -BuildsRoot $builds -CurrentRun $current
Assert-Cleanup (-not (Test-Path $old)) 'Old successful run retained'
Assert-Cleanup (-not (Test-Path $oldBuild)) 'Old valid build retained'
foreach ($path in @($current, $dirty, $unmarked, $wrongCommit, $data, $linked, $wrongOrigin, $headMismatch, $withWorktrees, $withEnv, $withStash, $withBranch, $withTag, $nestedEnv, $newer, $newest, $secondBuild, $newBuild, $malformedBuild)) {
    Assert-Cleanup (Test-Path $path) "Protected/recent directory removed: $path"
}
Assert-Cleanup (Test-Path (Join-Path $outside 'keep.txt')) 'Junction target modified'
Invoke-T3Cleanup -RunsRoot $runs -BuildsRoot $builds -CurrentRun $current
$linkedRoot = Join-Path $fixture 'linked-root'
New-Item -ItemType Junction -Path $linkedRoot -Target $builds | Out-Null
Invoke-T3Cleanup -RunsRoot $runs -BuildsRoot $linkedRoot -CurrentRun $current
Assert-Cleanup (Test-Path $secondBuild) 'Reparse root traversed'
$lastRun = New-TestRun 12
Invoke-T3Cleanup -RunsRoot $runs -BuildsRoot $builds -CurrentRun $lastRun
Assert-Cleanup (-not (Test-Path $newer)) 'Current success did not count toward two retained runs'
Assert-Cleanup (Test-Path $newest) 'Previous successful run removed'
Assert-Cleanup (Test-Path $lastRun) 'Current successful run removed'
Write-Host "PASS: cleanup preview, retention, preserved work, invalid metadata, junction safety, and repeat execution. Fixtures: $fixture"
