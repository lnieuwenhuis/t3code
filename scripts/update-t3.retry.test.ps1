$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'update-t3.ps1')
$realRunner = ${function:Invoke-T3ResolutionTests}
$root = Join-Path $env:TEMP ('t3-retry-test-' + [guid]::NewGuid().ToString('N'))
$checkout = Join-Path $root 'source'
New-Item -ItemType Directory -Path $checkout -Force | Out-Null
Set-Content (Join-Path $checkout 'package.json') '{"name":"fixture"}'
foreach ($file in @('original.test.ts', 'additional.test.ts', 'first-new.ts', 'second-new.ts')) { Set-Content (Join-Path $checkout $file) '// fixture' }
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Invoke-T3ResolutionAttempt {
    param($Checkout, $ReportRoot, $FeedbackLog, $PreviousTestFiles)
    $script:calls++
    if ($script:calls -gt 1) {
        Assert ((Get-Content -LiteralPath $FeedbackLog -Raw) -match 'missing mock export') 'Repair did not receive readable host failure log'
        Assert ($PreviousTestFiles -contains 'original.test.ts') 'Original test missing from repair context'
    }
    if ($script:calls -eq 1) { return @{ testFiles = @('original.test.ts'); newFiles = @('first-new.ts') } }
    return @{ testFiles = @('additional.test.ts'); newFiles = @('second-new.ts') }
}
function Install-T3ResolutionDependencies { param($Checkout, $Files) if ($script:dependencyFailure) { throw 'dependency failure' } }
function Invoke-T3ResolutionTests {
    param($Checkout, $Files, $LogPath)
    Assert ($Files -contains 'original.test.ts') 'Repair evaded original failing test'
    if ($script:calls -gt 1) { Assert ($Files -contains 'additional.test.ts') 'Repair test was omitted' }
    Set-Content -LiteralPath $LogPath 'missing mock export'
    if ($script:alwaysFail -or $script:calls -eq 1) {
        $failure = [Exception]::new('test failure')
        $failure.Data['T3FocusedTestFailure'] = $true
        throw $failure
    }
}
function Invoke-T3Git { param($Checkout, $Arguments) $script:staged += $Arguments[-1] }
$script:calls = 0; $script:staged = @(); $script:alwaysFail = $false; $script:dependencyFailure = $false
Resolve-T3Conflicts $checkout
Assert ($script:calls -eq 2) 'Failed test was not repaired exactly once'
Assert (($script:staged -join ',') -eq 'first-new.ts,second-new.ts') 'New files from earlier attempts were lost'
$script:calls = 0; $script:staged = @(); $script:alwaysFail = $true
$failed = $false
try { Resolve-T3Conflicts $checkout } catch { $failed = $_.Exception.Message -eq 'test failure' }
Assert ($failed -and $script:calls -eq 3 -and $script:staged.Count -eq 0) 'Retry cap failed or files staged before success'
$script:calls = 0; $script:dependencyFailure = $true
$failed = $false
try { Resolve-T3Conflicts $checkout } catch { $failed = $_.Exception.Message -eq 'dependency failure' }
Assert ($failed -and $script:calls -eq 1) 'Dependency failure incorrectly retried agent'
# Exercise actual native exit handling and persisted output, not just orchestration mocks.
function vp { & powershell.exe -NoProfile -Command "[Console]::Out.WriteLine('native test diagnostic'); [Console]::Error.WriteLine('native stderr diagnostic'); exit 1"; $global:LASTEXITCODE = $LASTEXITCODE }
$log = Join-Path $root 'native-test.log'
$failed = $false
try { & $realRunner $checkout @('original.test.ts') $log } catch { $failed = $_.Exception.Data['T3FocusedTestFailure'] }
Assert ($failed -and (Get-Content $log -Raw) -match 'native test diagnostic') 'Host failure classification/log capture failed'
Assert ((Get-Content $log -Raw) -match 'native stderr diagnostic') 'Native stderr missing from feedback log'
Remove-Item Function:\vp
Write-Host "PASS: failure feedback, bounded repairs, original test retention, new-file retention, dependency failure stops, native failure logging. Fixtures: $root"
