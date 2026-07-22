param(
    [int]$Port = 9237,
    [string]$ProfileDir = "$env:LOCALAPPDATA\FeishuAttendanceCollector\ChromeProfile",
    [string]$MessengerUrl = "https://thundersoft.feishu.cn/next/messenger",
    [switch]$Headless
)

$ErrorActionPreference = "Stop"

try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1 | Out-Null
    Write-Host "Dedicated Chrome is already running at 127.0.0.1:$Port."
    exit 0
} catch {
    # Port is not active; continue with a new dedicated Chrome instance.
}

$Candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$Chrome = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) {
    throw "Google Chrome was not found. Add its path to collector/start_chrome.ps1."
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
$Arguments = @(
    "--user-data-dir=$ProfileDir",
    "--remote-debugging-port=$Port",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check"
)
if ($Headless) {
    $Arguments += "--headless=new"
    $Arguments += "--disable-gpu"
    $Arguments += "about:blank"
} else {
    $Arguments += $MessengerUrl
}

Start-Process -FilePath $Chrome -ArgumentList $Arguments

$Ready = $false
for ($Attempt = 0; $Attempt -lt 40; $Attempt += 1) {
    Start-Sleep -Milliseconds 250
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1 | Out-Null
        $Ready = $true
        break
    } catch {
        # Keep polling for at most ten seconds.
    }
}
if (-not $Ready) {
    throw "Chrome started, but CDP port $Port was not ready within 10 seconds."
}

Write-Host "Dedicated Chrome started at 127.0.0.1:$Port."
if ($Headless) {
    Write-Host "Headless mode is active. Run the collector with --refresh-seconds if needed."
} else {
    Write-Host "For first use, sign in to Feishu in this window. The session stays in the dedicated profile."
}
