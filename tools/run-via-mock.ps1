<#
.SYNOPSIS
    用真实登录凭据跑一次，但流量全部被 mock-hub 接住。

.DESCRIPTION
    和 login-real.ps1 的区别：
      - 开拦截代理（8889），官方域名 → 127.0.0.1:443 → mock-hub
      - 不设 CODEARTS_CLI_AK / CODEARTS_CLI_SK（用登录拿到的真凭据）
      - 不设 INFERHUB_BASE_URLS（让它走默认地址，被代理接住）

    这样采集到的是"真实登录态下 CLI 到底请求了什么"，
    哪些接口 mock-hub 还没实现，一眼就能看出来。

.PARAMETER Prompt
    要问 CLI 的问题。默认 "列出当前目录的文件"。

.EXAMPLE
    .\tools\run-via-mock.ps1
    .\tools\run-via-mock.ps1 -Prompt '写一个 hello world'
#>
[CmdletBinding()]
param(
    [string]$Prompt = '列出当前目录的文件',
    [string]$CliPath = 'D:\project\码道\_codearts_re\x\agentkernel.exe',
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $CliPath)) { throw "找不到 CLI：$CliPath" }

# 确认代理和网关都在
$proxyUp = $false
try { $proxyUp = (Test-NetConnection -ComputerName 127.0.0.1 -Port 8889 -InformationLevel Quiet -WarningAction SilentlyContinue) } catch {}
if (-not $proxyUp) {
    Write-Host '拦截代理没起来，先执行：node tools\egress-proxy.mjs' -ForegroundColor Red
    exit 1
}
try {
    $null = Invoke-WebRequest 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 2
} catch {
    Write-Host 'mock-hub 没起来，先执行：node server.mjs' -ForegroundColor Red
    exit 1
}

# 关键：清掉会覆盖真实凭据和真实地址的变量
foreach ($v in @('CODEARTS_CLI_AK', 'CODEARTS_CLI_SK', 'INFERHUB_BASE_URLS', 'IS_PROD',
                 'HW_ACCESS_KEY', 'HW_SECRET_KEY', 'HW_SECURITY_TOKEN')) {
    Remove-Item "env:$v" -ErrorAction SilentlyContinue
}

$cd = Join-Path $env:USERPROFILE '.codeartsdoer'

# 从真实登录结果里取 STS 三元组（run 子命令不认 OAuth token，只认 AK/SK）
$authFile = Join-Path $cd 'cli-data\auth.json'
if (-not (Test-Path $authFile)) {
    Write-Host '没找到 auth.json，先执行 .\tools\login-real.ps1 登录' -ForegroundColor Red
    exit 1
}
$auth = Get-Content $authFile -Raw | ConvertFrom-Json
$prov = $auth.'inferhub-provider'
if (-not $prov) { Write-Host 'auth.json 里没有 inferhub-provider' -ForegroundColor Red; exit 1 }

$access = $prov.access | ConvertFrom-Json
$env:HW_ACCESS_KEY     = $access.access_key_id
$env:HW_SECRET_KEY     = $access.secret_access_key
$env:HW_SECURITY_TOKEN = $access.security_token

$exp = [datetime]::Parse($access.expiration).ToLocalTime()
if ($exp -lt (Get-Date)) {
    Write-Host "凭据已过期（$exp），重新登录：.\tools\login-real.ps1" -ForegroundColor Red
    exit 1
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
$env:CODEAGENT_AGENTARMOR_TOOL_NAME = 'disabled'
$env:NODE_TLS_REJECT_UNAUTHORIZED   = '0'

$env:HTTPS_PROXY = 'http://127.0.0.1:8889'
$env:HTTP_PROXY  = 'http://127.0.0.1:8889'
$env:NO_PROXY    = '127.0.0.1,localhost'

Write-Host ''
Write-Host '  采集模式（真凭据 → mock-hub）' -ForegroundColor Cyan
Write-Host "  问题       $Prompt"
Write-Host "  代理       $env:HTTPS_PROXY"
Write-Host '  凭据       使用登录保存的真实凭据'
Write-Host ''

Push-Location (Split-Path -Parent $CliPath)
try {
    & $CliPath run $Prompt
} finally {
    Pop-Location
}
