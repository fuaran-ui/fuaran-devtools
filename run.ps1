<#
.SYNOPSIS
    Entry point for fuaran-devtools — install, check, test, and build the extension.

.DESCRIPTION
    Runs the full happy path in one command:

        pnpm install  ->  format:check  ->  typecheck  ->  test  ->  build

    The build writes the load-unpacked extension to dist/. Load it via
    chrome://extensions -> Developer mode -> "Load unpacked" -> select dist/.

    The test suite includes a conformance leg against the shared relay fixture
    corpus, which is expected as a SIBLING checkout at ../wire-format-fixtures:

        git clone https://github.com/fuaran-ui/fuaran-ui-specification ../wire-format-fixtures

    A missing corpus fails the suite loudly rather than skipping it.

.PARAMETER SkipInstall
    Skip `pnpm install`. Use when node_modules is already in sync.

.PARAMETER SkipFormat
    Skip the Prettier check.

.PARAMETER SkipTests
    Skip the vitest suite.

.PARAMETER SkipBuild
    Skip the extension bundle.

.EXAMPLE
    .\run.ps1
    The full gate: install, format check, typecheck, test, build.

.EXAMPLE
    .\run.ps1 -SkipInstall -SkipBuild
    Fast inner loop: format check, typecheck, test only.
#>

#Requires -Version 7.0

[CmdletBinding()]
param(
    [switch] $SkipInstall,
    [switch] $SkipFormat,
    [switch] $SkipTests,
    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Node ships a pnpm.ps1 shim that rebuilds its arguments from the CALLER's
# command-line text via Substring(InvocationName.Length). Invoked from inside
# another .ps1 as `& pnpm install`, the slice eats the leading characters and
# pnpm sees a mangled command. Resolving pnpm.cmd directly skips the shim.
#
# `Get-Command pnpm.cmd` returns EVERY pnpm.cmd on PATH — typically two (the
# Node installer shim and the per-user one). $cmd.Source would then be an array
# and `& $cmd.Source` concatenates the paths into one bogus string. The
# `Select-Object -First 1` guard is load-bearing; both shims behave alike.
#
# Note the ${LASTEXITCODE} brace form — `$LASTEXITCODE:` parses as a
# drive-qualified variable reference, which is a hard parse error.
function Invoke-Pnpm {
    [CmdletBinding()]
    param([Parameter(ValueFromRemainingArguments = $true)] $Arguments)
    $cmd = Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $cmd.Source @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm exited with code ${LASTEXITCODE}: $($Arguments -join ' ')"
    }
}

$pnpm = Get-Command pnpm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pnpm) {
    Write-Error @"
pnpm was not found on PATH.

Install Node.js 22+ (https://nodejs.org/) and pnpm 9+ via:
    corepack enable
    corepack prepare pnpm@9 --activate

Then re-run this script.
"@
    exit 1
}

$corpus = Join-Path $PSScriptRoot '..' 'wire-format-fixtures' 'devtools-relay'
if (-not (Test-Path $corpus)) {
    Write-Host ""
    Write-Host "The relay conformance corpus is not present at ../wire-format-fixtures." -ForegroundColor Yellow
    Write-Host "The conformance leg of the test suite will fail. Clone it as a sibling:" -ForegroundColor Yellow
    Write-Host "    git clone https://github.com/fuaran-ui/fuaran-ui-specification ../wire-format-fixtures" -ForegroundColor Yellow
    Write-Host ""
}

if (-not $SkipInstall) {
    Write-Host "=== pnpm install ===" -ForegroundColor Cyan
    Invoke-Pnpm install
}

if (-not $SkipFormat) {
    Write-Host ""
    Write-Host "=== prettier --check ===" -ForegroundColor Cyan
    Invoke-Pnpm run format:check
}

Write-Host ""
Write-Host "=== typecheck ===" -ForegroundColor Cyan
Invoke-Pnpm run typecheck

if (-not $SkipTests) {
    Write-Host ""
    Write-Host "=== vitest ===" -ForegroundColor Cyan
    Invoke-Pnpm run test
}

if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "=== build the extension bundle ===" -ForegroundColor Cyan
    Invoke-Pnpm run build

    Write-Host ""
    Write-Host "Extension built to dist/." -ForegroundColor Green
    Write-Host "Load it: chrome://extensions -> Developer mode -> Load unpacked -> select dist/" -ForegroundColor Green
}
