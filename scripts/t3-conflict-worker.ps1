#Requires -Version 5.1
param([string]$Checkout, [string]$PromptPath, [string]$SchemaPath, [string]$ReportPath)
$ErrorActionPreference = 'Stop'
try {
    Get-Content -LiteralPath $PromptPath -Raw |
        & codex exec -C $Checkout -m gpt-6-astra -c 'model_reasoning_effort="medium"' -c 'approval_policy="never"' -s workspace-write --color never --output-schema $SchemaPath -o $ReportPath -
    exit $LASTEXITCODE
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
