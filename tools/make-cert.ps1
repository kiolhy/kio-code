<#
.SYNOPSIS
    为 mock-hub 生成一张自签证书（PFX），SAN 覆盖 CLI 会上报的所有域名。

.DESCRIPTION
    CLI 启动脚本里设了 NODE_TLS_REJECT_UNAUTHORIZED=0（且 IS_PROD!=="true" 时代码里
    还会显式传 rejectUnauthorized:false），所以自签证书会被接受。

    配合 hosts 把 collector 域名指向 127.0.0.1，mock-hub 在 443 上就能原样接住
    CLI 想上报的 OTLP 数据 —— 既阻断了外发，又能看清内容。

    证书生成在 CurrentUser\My，导出 PFX 后立刻从证书库删除，不留痕迹。
    不需要管理员权限。

.EXAMPLE
    .\tools\make-cert.ps1
    .\tools\make-cert.ps1 -Days 365 -Force
#>
[CmdletBinding()]
param(
    [int]$Days = 825,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$certDir = Join-Path $root 'data\certs'
$pfxPath = Join-Path $certDir 'capture.pfx'
$crtPath = Join-Path $certDir 'capture.crt'
$pfxPass = 'mock-hub'

if ((Test-Path $pfxPath) -and -not $Force) {
    Write-Host "证书已存在：$pfxPath" -ForegroundColor Yellow
    Write-Host "要重新生成请加 -Force" -ForegroundColor DarkGray
    return
}

New-Item -ItemType Directory -Path $certDir -Force | Out-Null

# CLI 的遥测/后端域名（与 lockdown.ps1 保持一致）
$domains = @(
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
    'ide.cn-north-4.myhuaweicloud.com',
    'codearts.huaweicloud.com',
    'open.codehub.huawei.com',
    'codehub-g.huawei.com',
    'codehub-y.huawei.com',
    'gamma.codehub.huawei.com',
    'cr-y.codehub.huawei.com',
    'localhost'
)

Write-Host "生成自签证书（SAN $($domains.Count) 个域名，有效期 $Days 天）…" -ForegroundColor Cyan

$cert = New-SelfSignedCertificate `
    -Subject 'CN=mock-hub-capture' `
    -DnsName $domains `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddDays($Days) `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -Type SSLServerAuthentication

try {
    # 导出 PFX（Node https 直接用 pfx + passphrase）
    $secure = ConvertTo-SecureString -String $pfxPass -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure -Force | Out-Null

    # 顺带导出 PEM 格式的证书，方便 openssl / 浏览器查看
    $b64 = [Convert]::ToBase64String($cert.RawData, [Base64FormattingOptions]::InsertLineBreaks)
    [IO.File]::WriteAllText($crtPath, "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----`n",
        [Text.UTF8Encoding]::new($false))
} finally {
    # 从证书库移除，不留痕迹
    Remove-Item -Path $cert.PSPath -Force -ErrorAction SilentlyContinue
}

$size = [Math]::Round((Get-Item $pfxPath).Length / 1KB, 1)

Write-Host ""
Write-Host "已生成：" -ForegroundColor Green
Write-Host "  PFX   $pfxPath   ($size KB, 口令 $pfxPass)"
Write-Host "  证书  $crtPath   (PEM，仅供查看)"
Write-Host "  指纹  $($cert.Thumbprint)"
Write-Host "  已从证书库移除：$($cert.PSPath)"
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. config.json 里设 capture.enabled = true，capture.port = 443"
Write-Host "  2. node server.mjs        # 会额外监听 443"
Write-Host "  3. .\tools\lockdown.ps1   # 管理员：把域名指到 127.0.0.1"
Write-Host "  4. 跑一次 CLI，遥测会出现在 data\telemetry.jsonl 和面板「遥测」页"
