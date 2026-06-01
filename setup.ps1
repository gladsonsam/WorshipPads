# setup.ps1 — checks the prerequisites needed to build StagePal with
# ASIO support. Run from a PowerShell prompt:  .\setup.ps1
# This script only inspects your machine; it does not install anything.

Write-Host "StagePal — environment check`n" -ForegroundColor Cyan

function Test-Tool($name, $cmd, $hint) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        Write-Host "[ok]   $name found" -ForegroundColor Green
    } else {
        Write-Host "[miss] $name NOT found — $hint" -ForegroundColor Yellow
    }
}

Test-Tool "Node.js"      "node"  "install from https://nodejs.org"
Test-Tool "Rust (cargo)" "cargo" "install from https://rustup.rs"
Test-Tool "LLVM/Clang"   "clang" "install LLVM (e.g. 'winget install LLVM.LLVM') for ASIO bindgen"

Write-Host ""

if ([string]::IsNullOrEmpty($env:CPAL_ASIO_DIR)) {
    Write-Host "[miss] CPAL_ASIO_DIR is not set." -ForegroundColor Yellow
    Write-Host "       Download the Steinberg ASIO SDK, extract it, then set e.g.:" -ForegroundColor Gray
    Write-Host '       [Environment]::SetEnvironmentVariable("CPAL_ASIO_DIR", "C:\sdks\asiosdk", "User")' -ForegroundColor Gray
} else {
    if (Test-Path $env:CPAL_ASIO_DIR) {
        Write-Host "[ok]   CPAL_ASIO_DIR = $env:CPAL_ASIO_DIR" -ForegroundColor Green
    } else {
        Write-Host "[warn] CPAL_ASIO_DIR is set but the path does not exist: $env:CPAL_ASIO_DIR" -ForegroundColor Yellow
    }
}

if (-not [string]::IsNullOrEmpty($env:LIBCLANG_PATH)) {
    Write-Host "[ok]   LIBCLANG_PATH = $env:LIBCLANG_PATH" -ForegroundColor Green
}

Write-Host "`nWithout the ASIO items above the app still builds and runs against the" -ForegroundColor Gray
Write-Host "default Windows output (WASAPI). Per-channel routing to a multichannel" -ForegroundColor Gray
Write-Host "interface needs them." -ForegroundColor Gray
