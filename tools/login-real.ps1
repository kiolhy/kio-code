<#
.SYNOPSIS
    真实登录码道 CLI（不经过 mock-hub，不经过拦截代理）。

.DESCRIPTION
    登录走的是华为真实服务（codearts.huaweicloud.com/portal/settings/cli-auth），
    必须能出网。所以这个脚本刻意：
      - 不设 INFERHUB_BASE_URLS
      - 不设 HTTPS_PROXY / HTTP_PROXY
      - 清掉 NO_PROXY 里可能残留的干扰
    其余环境变量和官方 codearts.cmd 保持一致。

    登录成功后凭据会落在 %USERPROFILE%\.codeartsdoer 下，
    之后用 mock-hub 时 CLI 会带着真 token 发请求。

.PARAMETER Command
    传给 agentkernel.exe 的参数。默认不带参数（进入 TUI 登录）。
    例如：.\tools\login-real.ps1 -Command run,'你好'

.EXAMPLE
    .\tools\login-real.ps1
    .\tools\login-real.ps1 -Command run,'hello'
#>
[CmdletBinding()]
param(
    [string[]]$Command = @(),
    [string]$CliPath = 'D:\project\码道\_codearts_re\x\agentkernel.exe'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $CliPath)) {
    throw "找不到 CLI：$CliPath"
}

# 关键：清掉所有把流量引向本地的设置
foreach ($v in @(
        'INFERHUB_BASE_URLS', 'IS_PROD',
        'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY',
        'CODEARTS_CLI_AK', 'CODEARTS_CLI_SK',
        'NODE_TLS_REJECT_UNAUTHORIZED'
    )) {
    Remove-Item "env:$v" -ErrorAction SilentlyContinue
}
$env:NO_PROXY = ''

$cd = Join-Path $env:USERPROFILE '.codeartsdoer'
New-Item -ItemType Directory -Force -Path (Join-Path $cd 'cli-data'), (Join-Path $cd 'state') | Out-Null

# 官方 codearts.cmd 里的那一套
$env:SCENARIO                  = 'codeartsdoer'
$env:KERNEL_DATA_DIR           = Join-Path $cd 'cli-data'
$env:KERNEL_STATE_DIR          = Join-Path $cd 'state'
$env:KERNEL_CONFIG_DIR         = $cd
$env:OPENCODE_CHANNEL          = 'latest'
$env:OPENCODE_CONFIG           = Join-Path $cd 'codearts_cli.json'
$env:OPENCODE_CONFIG_FILE      = 'codearts_cli.json,codearts_cli.jsonc'
$env:OPENCODE_MODE             = 'tui'
$env:PLUGIN_ENV                = 'hc'
$env:OPENCODE_DISABLE_MODELS_FETCH = '1'
$env:OPENCODE_DISABLE_AUTOUPDATE   = 'true'
$env:OPENCODE_ALWAYS_NOTIFY_UPDATE = 'false'
$env:CODEARTS_DISABLE_AUTO_UPDATE  = 'true'
$env:OMO_SEND_ANONYMOUS_TELEMETRY  = '0'
$env:CODEAGENT_USE_MESSAGE_FEEDBACK = 'false'
$env:NODE_TLS_REJECT_UNAUTHORIZED  = '0'

Write-Host ''
Write-Host '  真实登录模式' -ForegroundColor Cyan
Write-Host "  CLI        $CliPath"
Write-Host "  配置目录   $cd"
Write-Host "  代理       已清除（登录要能出网）"
Write-Host "  推理地址   官方默认（未指向 mock-hub）"
Write-Host ''
Write-Host '  登录方式：CLI 会打印一个链接，用浏览器打开并授权，' -ForegroundColor Yellow
Write-Host '  授权完成后回到终端继续。' -ForegroundColor Yellow
Write-Host ''

Push-Location (Split-Path -Parent $CliPath)
try {
    if ($Command.Count -gt 0) {
        & $CliPath @Command
    } else {
        & $CliPath
    }
} finally {
    Pop-Location
}
