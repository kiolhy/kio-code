<#
.SYNOPSIS
    把所有 CLI 子命令过一遍，看哪些接口 mock-hub 还没实现。

.DESCRIPTION
    用真实登录凭据 + 拦截代理，依次执行各个子命令。
    mock-hub 会把每个请求记进流水，跑完用 tools\find-gaps.mjs 出缺口清单。

.PARAMETER Only
    只跑名字匹配的子命令（正则）。

.EXAMPLE
    .\tools\sweep-cli.ps1
    .\tools\sweep-cli.ps1 -Only 'model|stats'
#>
[CmdletBinding()]
param(
    [string]$Only = '',
    [int]$TimeoutSec = 25,
    [string]$CliPath = 'D:\project\码道\_codearts_re\x\agentkernel.exe'
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not (Test-Path $CliPath)) { throw "找不到 CLI：$CliPath" }

$cd = Join-Path $env:USERPROFILE '.codeartsdoer'
$authFile = Join-Path $cd 'cli-data\auth.json'
if (-not (Test-Path $authFile)) { throw '没登录，先跑 .\tools\login-real.ps1' }
$access = (Get-Content $authFile -Raw | ConvertFrom-Json).'inferhub-provider'.access | ConvertFrom-Json

foreach ($v in @('CODEARTS_CLI_AK', 'CODEARTS_CLI_SK', 'INFERHUB_BASE_URLS', 'IS_PROD')) {
    Remove-Item "env:$v" -ErrorAction SilentlyContinue
}

$env:SCENARIO                       = 'codeartsdoer'
$env:KERNEL_DATA_DIR                = Join-Path $cd 'cli-data'
$env:KERNEL_STATE_DIR               = Join-Path $cd 'state'
$env:KERNEL_CONFIG_DIR              = $cd
$env:OPENCODE_CHANNEL               = 'latest'
$env:OPENCODE_CONFIG                = Join-Path $cd 'codearts_cli.json'
$env:OPENCODE_CONFIG_FILE           = 'codearts_cli.json,codearts_cli.jsonc'
$env:OPENCODE_MODE                  = 'tui'
$env:PLUGIN_ENV                     = 'hc'
$env:OPENCODE_DISABLE_MODELS_FETCH  = '1'
$env:CODEARTS_DISABLE_AUTO_UPDATE   = 'true'
$env:OMO_SEND_ANONYMOUS_TELEMETRY   = '0'
$env:CODEAGENT_USE_MESSAGE_FEEDBACK = 'false'
$env:NODE_TLS_REJECT_UNAUTHORIZED   = '0'
$env:HW_ACCESS_KEY                  = $access.access_key_id
$env:HW_SECRET_KEY                  = $access.secret_access_key
$env:HW_SECURITY_TOKEN              = $access.security_token
$env:HTTPS_PROXY                    = 'http://127.0.0.1:8889'
$env:HTTP_PROXY                     = 'http://127.0.0.1:8889'
$env:NO_PROXY                       = '127.0.0.1,localhost'

# 只跑会真正发请求的，纯 --help 不产生流量
$cases = @(
    @{ name = 'models';           args = @('models') },
    @{ name = 'models --verbose'; args = @('models', '--verbose') },
    @{ name = 'stats';            args = @('stats') },
    @{ name = 'session list';     args = @('session', 'list') },
    @{ name = 'agent list';       args = @('agent', 'list') },
    @{ name = 'memory';           args = @('memory', 'list') },
    @{ name = 'experience';       args = @('experience', 'list') },
    @{ name = 'codebase status';  args = @('codebase', 'status') },
    @{ name = 'codebase-local';   args = @('codebase-local', 'status') },
    @{ name = 'lsp-toggle';       args = @('lsp-toggle', '--status') },
    @{ name = 'privacy';          args = @('privacy') },
    @{ name = 'debug paths';      args = @('debug', 'paths') },
    @{ name = 'export';           args = @('export') },
    @{ name = 'upgrade --check';  args = @('upgrade', '--check') },
    @{ name = 'mcp list';         args = @('mcp', 'list') }
)

Write-Host ''
Write-Host "  子命令扫描  $($cases.Count) 个" -ForegroundColor Cyan
Write-Host ''

Push-Location (Split-Path -Parent $CliPath)
try {
    foreach ($c in $cases) {
        if ($Only -and $c.name -notmatch $Only) { continue }
        Write-Host ("  → {0,-20}" -f $c.name) -NoNewline -ForegroundColor DarkGray

        $outFile = Join-Path $env:TEMP ("sweep_" + [guid]::NewGuid().ToString('N') + ".txt")
        $p = Start-Process -FilePath $CliPath -ArgumentList $c.args -NoNewWindow -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError "$outFile.err"

        $done = $p.WaitForExit($TimeoutSec * 1000)
        if (-not $done) { $p.Kill(); $status = 'TIMEOUT' }
        else { $status = "exit=$($p.ExitCode)" }

        $text = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + (Get-Content "$outFile.err" -Raw -ErrorAction SilentlyContinue)
        Remove-Item $outFile, "$outFile.err" -ErrorAction SilentlyContinue

        $first = ($text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
        if ($first -and $first.Length -gt 70) { $first = $first.Substring(0, 70) + '…' }
        $color = if ($status -eq 'exit=0') { 'Green' } else { 'Yellow' }
        Write-Host ("  {0,-12} {1}" -f $status, $first) -ForegroundColor $color
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '  跑完了，看缺口：' -ForegroundColor Cyan
Write-Host '    node tools\find-gaps.mjs' -ForegroundColor White
Write-Host ''
