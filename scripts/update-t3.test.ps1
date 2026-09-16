$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'update-t3.ps1')

$root = Join-Path $env:TEMP ('t3-sync-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
function G { param([string[]]$A) & git @A | Out-Null; if ($LASTEXITCODE) { throw "git failed: $A" } }
function Assert { param($Condition, $Message) if (-not $Condition) { throw $Message } }
$upstream = Join-Path $root 'upstream'
$fork = Join-Path $root 'fork.git'
G @('init', '-b', 'main', $upstream)
G @('-C', $upstream, 'config', 'user.name', 'Fixture')
G @('-C', $upstream, 'config', 'user.email', 'fixture@example.invalid')
Set-Content (Join-Path $upstream 'feature.txt') 'base'
G @('-C', $upstream, 'add', 'feature.txt')
G @('-C', $upstream, 'commit', '-m', 'test: base')
G @('clone', '--bare', $upstream, $fork)
Set-Content (Join-Path $upstream 'upstream.txt') 'new upstream feature'
G @('-C', $upstream, 'add', 'upstream.txt')
G @('-C', $upstream, 'commit', '-m', 'test: upstream change')
$script:verified = $false
Sync-T3Source -ForkUrl $fork -UpstreamUrl $upstream -Checkout (Join-Path $root 'clean') -Publish -ResolveConflicts { throw 'Unexpected resolver invocation' } -Verify {
    param($path)
    Assert (Test-Path (Join-Path $path 'upstream.txt')) 'Missing upstream change'
    $script:verified = $true
}
Assert $script:verified 'Verification was skipped'
$published = & git --git-dir=$fork rev-parse main
Assert ($published -eq (& git -C (Join-Path $root 'clean') rev-parse HEAD)) 'Merge was not published'

# A failed verification must leave remote main unchanged.
Set-Content (Join-Path $upstream 'upstream.txt') 'another upstream change'
G @('-C', $upstream, 'commit', '-am', 'test: next upstream change')
$failed = $false
try {
    Sync-T3Source -ForkUrl $fork -UpstreamUrl $upstream -Checkout (Join-Path $root 'failed') -Publish -ResolveConflicts { throw 'Unexpected conflict' } -Verify { throw 'Fixture verification failed' }
} catch { $failed = $_.Exception.Message -match 'Fixture verification failed' }
Assert $failed 'Verification failure was not propagated'
Assert ((& git --git-dir=$fork rev-parse main) -eq $published) 'Failed build changed remote main'

# Divergent edits require the resolver and must preserve both intended values.
Set-Content (Join-Path $root 'clean/feature.txt') 'fork customization'
G @('-C', (Join-Path $root 'clean'), 'commit', '-am', 'test: fork edit')
G @('-C', (Join-Path $root 'clean'), 'push', 'origin', 'HEAD:main')
Set-Content (Join-Path $upstream 'feature.txt') 'upstream improvement'
G @('-C', $upstream, 'commit', '-am', 'test: upstream edit')
$script:resolved = $false
Sync-T3Source -ForkUrl $fork -UpstreamUrl $upstream -Checkout (Join-Path $root 'conflict') -ResolveConflicts {
    param($path)
    $script:resolved = $true
    Set-Content (Join-Path $path 'feature.txt') 'fork customization plus upstream improvement'
} -Verify {
    param($path)
    Assert ((Get-Content (Join-Path $path 'feature.txt')) -eq 'fork customization plus upstream improvement') 'Resolution was lost'
}
Assert $script:resolved 'Conflict resolver was not called'
Assert ((& git --git-dir=$fork rev-parse main) -ne (& git -C (Join-Path $root 'conflict') rev-parse HEAD)) 'Build-only unexpectedly published'

$failed = $false
try {
    Sync-T3Source -ForkUrl $fork -UpstreamUrl $upstream -Checkout (Join-Path $root 'unresolved') -Publish -ResolveConflicts { } -Verify { throw 'Verification should not run' }
} catch { $failed = $_.Exception.Message -match 'conflict|unresolved' }
Assert $failed 'Unresolved conflicts were accepted'

# Publishing must reject a fork that advanced while verification was running.
$resolve = { param($path) Set-Content (Join-Path $path 'feature.txt') 'fork customization plus upstream improvement' }
$failed = $false
try {
    Sync-T3Source -ForkUrl $fork -UpstreamUrl $upstream -Checkout (Join-Path $root 'race') -Publish -ResolveConflicts $resolve -Verify {
        Set-Content (Join-Path $root 'clean/race.txt') 'concurrent fork change'
        G @('-C', (Join-Path $root 'clean'), 'add', 'race.txt')
        G @('-C', (Join-Path $root 'clean'), 'commit', '-m', 'test: concurrent change')
        G @('-C', (Join-Path $root 'clean'), 'push', 'origin', 'HEAD:main')
    }
} catch { $failed = $_.Exception.Message -match 'push.*failed' }
Assert $failed 'Concurrent remote advancement was overwritten'
Assert ((& git --git-dir=$fork rev-parse main) -eq (& git -C (Join-Path $root 'clean') rev-parse HEAD)) 'Concurrent commit was lost'

$failed = $false
try {
    Sync-T3Source -ForkUrl $fork -UpstreamUrl $upstream -Checkout (Join-Path $root 'mutation') -Publish -ResolveConflicts $resolve -Verify {
        param($path) Set-Content (Join-Path $path 'feature.txt') 'unexpected verification edit'
    }
} catch { $failed = $_.Exception.Message -match 'Verification changed' }
Assert $failed 'Source changes after verification were published'
Set-Content -LiteralPath (Join-Path $root 'clean/[ab].txt') 'intentional file'
Set-Content -LiteralPath (Join-Path $root 'clean/a.txt') 'unrelated file'
Invoke-T3Git (Join-Path $root 'clean') @('--literal-pathspecs', 'add', '--', '[ab].txt')
$staged = @(& git -C (Join-Path $root 'clean') diff --cached --name-only)
Assert ($staged.Count -eq 1 -and $staged[0] -eq '[ab].txt') 'Explicit filename expanded as wildcard'
Write-Host "PASS: clean merge, publish, failed verification, conflict resolution, build-only, unresolved refusal, concurrent push refusal, verification mutation refusal, literal file staging. Fixtures: $root"
