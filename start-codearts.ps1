<#
.SYNOPSIS
    把码道 CLI 指向本地 mock-hub，并启动 CLI。

.DESCRIPTION
    CLI 的 inferhub 地址来源有两个，本脚本两条都覆盖：
      1. 环境变量 INFERHUB_BASE_URLS（rj() 的兜底路径）
      2. %USERPROFILE%\.codeartsdoer\codearts_cli.json 里的 inferhubBaseUrl（最高优先级）
    加 -PatchConfig 时会把 2 也改掉，这样即使 IDE 重新下发 /v1/init 也会被本地值覆盖。

.EXAMPLE
    .\start-codearts.ps1
    .\start-codearts.ps1 -Port 8787 -PatchConfig
    .\start-codearts.ps1 -NoLaunch          # 只起网关，不启动 CLI
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$CodeartsExe,
    [switch]$PatchConfig,
    [switch]$NoLaunch,
    [switch]$SkipGateway
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = "http://127.0.0.1:$Port"

# ---------- 1. 起网关 ----------
if (-not $SkipGateway) {
    $alive = $false
    try {
        $r = Invoke-WebRequest -Uri "$base/health" -TimeoutSec 2 -UseBasicParsing
        $alive = ($r.StatusCode -eq 200)
    } catch { $alive = $false }

    if ($alive) {
        Write-Host "[mock-hub] 已在运行: $base" -ForegroundColor Green
    } else {
        Write-Host "[mock-hub] 启动中..." -ForegroundColor Cyan
        $env:MOCK_HUB_PORT = $Port
        Start-Process -FilePath 'node' `
            -ArgumentList @("`"$here\server.mjs`"") `
            -WorkingDirectory $here `
            -WindowStyle Minimized
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 250
            try {
                $r = Invoke-WebRequest -Uri "$base/health" -TimeoutSec 1 -UseBasicParsing
                if ($r.StatusCode -eq 200) { $alive = $true; break }
            } catch { }
        }
        if (-not $alive) { throw "mock-hub 启动失败，检查 node 是否在 PATH 里" }
        Write-Host "[mock-hub] 就绪: $base  (面板 $base/admin)" -ForegroundColor Green
    }
}

# ---------- 2. 注入环境变量 ----------
$env:INFERHUB_BASE_URLS          = "$base/api/v2/"
$env:PLUGIN_ENV                  = 'hc'
$env:IS_PROD                     = 'false'
$env:CODEARTS_CLI_AK             = 'AKMOCKHUB0000000000'
$env:CODEARTS_CLI_SK             = 'SKMOCKHUB0000000000000000000000000000'
$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
$env:OPENCODE_DISABLE_MODELS_FETCH = '1'
$env:CODEARTS_DISABLE_AUTO_UPDATE  = 'true'

Write-Host "[env] INFERHUB_BASE_URLS = $env:INFERHUB_BASE_URLS" -ForegroundColor DarkGray
Write-Host "[env] PLUGIN_ENV = hc, IS_PROD = false, AK/SK = MOCK" -ForegroundColor DarkGray

# ---------- 3. 可选：改 GlobalConfig ----------
if ($PatchConfig) {
    $cfgPath = Join-Path $env:USERPROFILE '.codeartsdoer\codearts_cli.json'
    if (Test-Path $cfgPath) {
        $bak = "$cfgPath.bak.$((Get-Date).ToString('yyyyMMddHHmmss'))"
        Copy-Item $cfgPath $bak
        Write-Host "[config] 已备份 → $bak" -ForegroundColor DarkGray

        $raw = Get-Content $cfgPath -Raw -Encoding UTF8
        $json = $raw | ConvertFrom-Json

        $fields = [ordered]@{
            inferhubBaseUrl      = "$base/api/v2/"
            codebaseUrl          = $base
            agentCenterApiUrl    = $base
            promptCenterApiUrl   = $base
            policyCenterDomain   = $base
            memoryServiceBaseUrl = $base
            knowledgeBaseUrl     = $base
            codehubApiUrl        = $base
            marketHost           = $base
        }
        foreach ($k in $fields.Keys) {
            if ($json.PSObject.Properties.Name -contains $k) {
                $json.$k = $fields[$k]
            } else {
                $json | Add-Member -NotePropertyName $k -NotePropertyValue $fields[$k] -Force
            }
        }
        $json | ConvertTo-Json -Depth 32 | Set-Content $cfgPath -Encoding UTF8
        Write-Host "[config] 已把 8 个后端地址指向本地" -ForegroundColor Green
    } else {
        Write-Host "[config] 未找到 $cfgPath（CLI 还没跑过一次？），跳过" -ForegroundColor Yellow
    }
}

if ($NoLaunch) {
    Write-Host "`n只起了网关。手动启动 CLI 时请在同一 shell 里执行 codearts。" -ForegroundColor Cyan
    return
}

# ---------- 4. 定位并启动 CLI ----------
if (-not $CodeartsExe) {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.codeartsdoer\bin\codearts.cmd'),
        (Join-Path $env:USERPROFILE '.codeartsdoer\codearts.cmd'),
        (Join-Path $env:LOCALAPPDATA 'codearts\codearts.cmd'),
        (Join-Path $env:LOCALAPPDATA 'Programs\codearts\codearts.cmd'),
        (Join-Path $here '..\_codearts_re\x\codearts.cmd')
    )
    $CodeartsExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $CodeartsExe) {
        $cmd = Get-Command codearts -ErrorAction SilentlyContinue
        if ($cmd) { $CodeartsExe = $cmd.Source }
    }
}

if (-not $CodeartsExe) {
    Write-Host "`n找不到 codearts 可执行文件。用 -CodeartsExe 指定路径：" -ForegroundColor Yellow
    Write-Host "  .\start-codearts.ps1 -CodeartsExe 'C:\path\to\codearts.cmd'" -ForegroundColor DarkGray
    return
}

Write-Host "`n[cli] 启动 $CodeartsExe" -ForegroundColor Cyan
Write-Host "[cli] 打开另一个窗口看面板: $base/admin" -ForegroundColor DarkGray
& $CodeartsExe @args
