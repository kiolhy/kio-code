<#
.SYNOPSIS
    把码道 CLI 的出站域名指向 127.0.0.1（hosts 黑洞），切断官方遥测与后端。

.DESCRIPTION
    遥测 URL 是硬编码的，OTEL_EXPORTER_OTLP_ENDPOINT 无效，OTEL_SDK_DISABLED 大概率无效。
    唯一确定有效的是网络层：hosts 把域名指到 127.0.0.1，连接被拒，上报静默丢失。

    所有改动写在 `# >>> mock-hub-lockdown >>>` 标记块内，-Revert 只删这个块，不碰其它内容。

.PARAMETER Revert
    移除标记块，还原 hosts。

.PARAMETER All
    连模型网关/技能市场/codehub 一起堵（完全离线）。不加则只堵遥测和权益/用户服务。

.PARAMETER WhatIf
    只打印将要写入的内容，不实际改 hosts。

.EXAMPLE
    .\tools\lockdown.ps1 -WhatIf
    .\tools\lockdown.ps1
    .\tools\lockdown.ps1 -All
    .\tools\lockdown.ps1 -Revert
#>
[CmdletBinding()]
param(
    [switch]$Revert,
    [switch]$All,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$marker    = '# >>> mock-hub-lockdown >>>'
$endMarker = '# <<< mock-hub-lockdown <<<'

# 遥测 + 账号侧服务：这些是"上报"通道，优先堵
$telemetryHosts = @(
    'collector-agents-access.cn-north-4.myhuaweicloud.com',
    'collector-agents-access.ap-southeast-1.myhuaweicloud.com',
    'beta-collector-agents-apig.cn-north-7.ulanqab.huawei.com',
    'beta-hk-collector-agents-apig.cn-north-7.ulanqab.huawei.com',
    'mammoth.opentelemetry.endpoint.tools.huawei.com',
    'mammoth.opentelemetry.endpoint.gamma.tools.huawei.com',
    'snap-access.cn-north-4.myhuaweicloud.com',
    'snapengine-apig.cn-north-7.myhuaweicloud.com',
    'opengw.developer.huaweicloud.com',
    'skills.huaweicloud.com',
    'skillstest.developer.huaweicloud.com',
    'rnd-idea-api.huawei.com',
    'cmc-nkg-artifactory.cmc.tools.huawei.com',
    'sts.cn-north-4.myhuaweicloud.com',
    'ide.cn-north-4.myhuaweicloud.com'
)

# 完全离线时额外堵的
$backendHosts = @(
    'codearts.huaweicloud.com',
    'open.codehub.huawei.com',
    'codehub-g.huawei.com',
    'codehub-y.huawei.com',
    'gamma.codehub.huawei.com',
    'cr-y.codehub.huawei.com',
    'cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com',
    'codearts-agent-obs-cdn.huaweicloud.com'
)

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "改 hosts 需要管理员权限。请用『以管理员身份运行』的 PowerShell 重试。"
    }
}

function Read-Hosts {
    if (-not (Test-Path $hostsPath)) { throw "找不到 hosts: $hostsPath" }
    return Get-Content $hostsPath -Raw -Encoding UTF8
}

function Strip-Block([string]$text) {
    $pattern = "(?ms)^\s*" + [regex]::Escape($marker) + ".*?" + [regex]::Escape($endMarker) + "\s*\r?\n?"
    return [regex]::Replace($text, $pattern, '')
}

function Write-Hosts([string]$text) {
    if ($WhatIf) {
        Write-Host "`n--- 将要写入 $hostsPath ---" -ForegroundColor Cyan
        Write-Host $text
        Write-Host "--- 结束 ---`n" -ForegroundColor Cyan
        return
    }
    Set-Content -Path $hostsPath -Value $text -Encoding UTF8 -NoNewline
}

# ---------- Revert ----------
if ($Revert) {
    if (-not $WhatIf) { Assert-Admin }
    $raw = Read-Hosts
    if ($raw -notmatch [regex]::Escape($marker)) {
        Write-Host "hosts 里没有 lockdown 标记块，无需还原。" -ForegroundColor Yellow
        return
    }
    $bak = "$hostsPath.bak.mockhub.$((Get-Date).ToString('yyyyMMddHHmmss'))"
    Copy-Item $hostsPath $bak
    Write-Hosts (Strip-Block $raw)
    Write-Host "已移除标记块。备份：$bak" -ForegroundColor Green
    Write-Host "刷新 DNS 缓存…" -ForegroundColor DarkGray
    ipconfig /flushdns | Out-Null
    return
}

# ---------- Apply ----------
if (-not $WhatIf) { Assert-Admin }

$targets = $telemetryHosts
if ($All) { $targets = $telemetryHosts + $backendHosts }
$targets = $targets | Select-Object -Unique

$lines = @($marker, "# 由 mock-hub/tools/lockdown.ps1 生成于 $((Get-Date).ToString('s'))",
           "# 目的：切断 CLI 的出站上报。还原用 -Revert")
foreach ($h in $targets) { $lines += "127.0.0.1`t$h" }
$lines += $endMarker
$block = ($lines -join "`r`n") + "`r`n"

$raw = Read-Hosts
$clean = Strip-Block $raw
if (-not $clean.EndsWith("`n")) { $clean += "`r`n" }
$new = $clean + $block

Write-Hosts $new

if (-not $WhatIf) {
    $bak = "$hostsPath.bak.mockhub.$((Get-Date).ToString('yyyyMMddHHmmss'))"
    Set-Content -Path $bak -Value $raw -Encoding UTF8 -NoNewline
    Write-Host "已写入 $($targets.Count) 条规则 → 127.0.0.1" -ForegroundColor Green
    Write-Host "备份：$bak" -ForegroundColor DarkGray
    Write-Host "刷新 DNS 缓存…" -ForegroundColor DarkGray
    ipconfig /flushdns | Out-Null
    Write-Host ""
    Write-Host "验证：" -ForegroundColor Cyan
    Write-Host "  Resolve-DnsName collector-agents-access.cn-north-4.myhuaweicloud.com   # 应返回 127.0.0.1"
    Write-Host "  Test-NetConnection collector-agents-access.cn-north-4.myhuaweicloud.com -Port 443   # 应失败"
    Write-Host ""
    Write-Host "还原：.\tools\lockdown.ps1 -Revert" -ForegroundColor DarkGray
}
