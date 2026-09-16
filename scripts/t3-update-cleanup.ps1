# Cleanup is deliberately limited to positively identified completed runs and builds.
function Test-T3CleanupPlainPath {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        if ($item -is [IO.DirectoryInfo]) { $item = $item.Parent } else { $item = $item.Directory }
    }
    return $true
}

function Remove-T3CleanupTree {
    param([string]$Path, [string]$Root, [switch]$Preview)
    $target = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $boundary = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($target), $boundary, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup target is not a direct child of its root: $target"
    }
    if (-not (Test-T3CleanupPlainPath $target)) { throw "Cleanup target or ancestor is a reparse point: $target" }
    if ($Preview) { Write-Host "Cleanup preview: $target"; return }
    # Enumerate one level at a time. Delete links themselves, never their targets.
    function Remove-T3CleanupEntry {
        param([IO.FileSystemInfo]$Entry)
        $Entry.Refresh()
        if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Entry -is [IO.FileInfo]) {
            if ($Entry -is [IO.FileInfo] -and -not ($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                $Entry.IsReadOnly = $false
            }
            $Entry.Delete()
            return
        }
        foreach ($child in $Entry.GetFileSystemInfos()) { Remove-T3CleanupEntry $child }
        $Entry.Delete()
    }
    Remove-T3CleanupEntry (Get-Item -LiteralPath $target -Force)
    Write-Host "Cleaned up: $target"
}

function Get-T3CleanupRun {
    param([IO.DirectoryInfo]$Directory)
    if ($Directory.Name -notmatch '^\d{8}-\d{6}-[0-9a-f]{6}$') { return }
    if (-not (Test-T3CleanupPlainPath $Directory.FullName)) { return }
    $marker = Join-Path $Directory.FullName '.update-complete.json'
    $source = Join-Path $Directory.FullName 'source'
    $gitDirectory = Join-Path $source '.git'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        -not (Test-Path -LiteralPath $gitDirectory -PathType Container)) { return }
    if (-not (Test-T3CleanupPlainPath $marker) -or -not (Test-T3CleanupPlainPath $gitDirectory)) { return }
    if ((Test-Path -LiteralPath (Join-Path $source '.t3')) -or (Test-Path -LiteralPath (Join-Path $Directory.FullName '.t3'))) { return }
    if (Test-Path -LiteralPath (Join-Path $gitDirectory 'worktrees')) { return }
    $ignored = & git -C $source ls-files --others --ignored --exclude-standard --directory 2>$null
    if ($LASTEXITCODE -ne 0) { return }
    foreach ($entry in $ignored) {
        if ($entry -match '^(node_modules/|scripts/node_modules/|(apps|packages)/[^/]+/node_modules/|\.generated/|\.pnpm-store/|\.vite-hooks/|apps/desktop/dist-electron/|apps/server/dist/|apps/web/dist/|native/resource-monitor/target/)$') { continue }
        if ($entry -match '^\.vite-hooks/(_/.*|[^/]+)$') { continue }
        return
    }
    $metadata = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($metadata.schemaVersion -ne 1 -or $metadata.commit -notmatch '^[0-9a-f]{40}$') { return }
    if ($metadata.completedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$') { return }
    $completed = [DateTimeOffset]::Parse($metadata.completedAt, [Globalization.CultureInfo]::InvariantCulture)
    $head = & git -C $source rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or $head -ne $metadata.commit) { return }
    $localRefs = & git -C $source for-each-ref '--format=%(refname)' refs/heads refs/stash refs/tags 2>$null
    if ($LASTEXITCODE -ne 0) { return }
    foreach ($localRef in $localRefs) {
        if ($localRef -eq 'refs/stash') { return }
        & git -C $source merge-base --is-ancestor $localRef HEAD 2>$null
        if ($LASTEXITCODE -ne 0) { return }
    }
    $origin = & git -C $source remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0 -or $origin -ne 'https://github.com/lnieuwenhuis/t3code.git') { return }
    $changes = & git -C $source status --porcelain --untracked-files=all 2>$null
    if ($LASTEXITCODE -ne 0 -or $changes) { return }
    [pscustomobject]@{ Path = $Directory.FullName; Order = $completed }
}

function Get-T3CleanupBuild {
    param([IO.DirectoryInfo]$Directory)
    if ($Directory.Name -notmatch '^\d+\.\d+\.\d+-fork\.(\d{14})$') { return }
    $stamp = $Matches[1]
    if (-not (Test-T3CleanupPlainPath $Directory.FullName)) { return }
    $report = Join-Path $Directory.FullName 'build-info.json'
    if (-not (Test-Path -LiteralPath $report -PathType Leaf) -or -not (Test-T3CleanupPlainPath $report)) { return }
    $metadata = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    if ($metadata.repository -ne 'lnieuwenhuis/t3code' -or -not [IO.Path]::IsPathRooted($metadata.installer)) { return }
    $installer = [IO.Path]::GetFullPath($metadata.installer)
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($installer), $Directory.FullName, [StringComparison]::OrdinalIgnoreCase)) { return }
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or -not (Test-T3CleanupPlainPath $installer)) { return }
    $built = [DateTime]::ParseExact($stamp, 'yyyyMMddHHmmss', [Globalization.CultureInfo]::InvariantCulture)
    [pscustomobject]@{ Path = $Directory.FullName; Order = $built }
}

function Invoke-T3Cleanup {
    param([Parameter(Mandatory)][string]$RunsRoot, [Parameter(Mandatory)][string]$BuildsRoot,
        [string]$CurrentRun, [switch]$Preview)
    $current = if ($CurrentRun) { [IO.Path]::GetFullPath($CurrentRun).TrimEnd('\') } else { '' }
    foreach ($category in @(@{ Root = $RunsRoot; Kind = 'run' }, @{ Root = $BuildsRoot; Kind = 'build' })) {
        try {
            if (-not (Test-Path -LiteralPath $category.Root -PathType Container)) { continue }
            $root = [IO.Path]::GetFullPath($category.Root).TrimEnd('\')
            if (-not (Test-T3CleanupPlainPath $root)) { throw "Cleanup root or ancestor is a reparse point: $root" }
            $eligible = @(
                foreach ($directory in Get-ChildItem -LiteralPath $root -Directory -Force) {
                    try {
                        if ($category.Kind -eq 'run') { Get-T3CleanupRun $directory } else { Get-T3CleanupBuild $directory }
                    } catch { Write-Warning "Preserving $($directory.FullName): $($_.Exception.Message)" }
                }
            )
            foreach ($candidate in @($eligible | Sort-Object Order -Descending | Select-Object -Skip 2)) {
                if ([string]::Equals($candidate.Path, $current, [StringComparison]::OrdinalIgnoreCase)) { continue }
                try { Remove-T3CleanupTree -Path $candidate.Path -Root $root -Preview:$Preview }
                catch { Write-Warning "Could not clean up $($candidate.Path): $($_.Exception.Message)" }
            }
        } catch { Write-Warning "Cleanup skipped: $($_.Exception.Message)" }
    }
}
