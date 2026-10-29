# 账号池「授权添加」：三种方式

账号池面板里除了「+ 添加账号」（手动粘 AK/SK），还有两种一键方式：

1. **🔗 授权添加**：生成登录链接 → 用户授权 → 临时 AK/SK 自动入库。支持三种模式：
   - `sts`：OAuth 授权码 → 委托 STS → 临时凭据（需自建华为云 OAuth App + 委托）
   - `token`：只存 OAuth token（上游需接受 `x-auth-token` 才用）
   - `codearts-cli`：**模拟原版码道 CLI 登录**（DPoP + 设备码），链接授权 → STS 三元组
2. **📥 导入 auth.json**：直接吃原版 CLI 登录后落盘的 `auth.json`，提取 STS 三元组入库（零配置、最可靠）。

## 为什么不能像 GitHub 那样「链接授权 → 直接给 token」

上游 `snap-access` 要的是 **SDK-HMAC-SHA256 签名**（`Authorization: SDK-HMAC-SHA256 Access=…, SignedHeaders=…, Signature=…`），签名靠 AK/SK：

- `accessKeyId` 能出现在请求里，也能在控制台看到；
- `secretAccessKey`（SK）是**静态密钥，只在创建时显示一次**，之后华为云不再展示。

所以「登录链接」里拿不到 SK，没法凭一个 token 直接签名。真 CLI 的登录流程本质是：

```
浏览器 OAuth 登录（DPoP 绑定）→ 拿到 STS 临时 AK/SK/SecurityToken → 用临时的去签名
```

本模块复刻的就是这段，账号模型里的 `securityToken`（STS 临时 token）也正是为它准备的。

## 工作流

```
面板点「授权添加」
  → POST /panel/api/oauth/start   生成 authorizeUrl + state（10 分钟有效）
  → 浏览器打开 authorizeUrl，登录华为云并同意授权
  → 华为云跳转回 redirectUri（GET /oauth/callback?code=…&state=…）
  → 网关校验 state → 用 code 换 token → STS assume-role 换临时 AK/SK/SecurityToken
  → 自动入库（authType=sts），回调页显示成功，面板轮询到 done 后刷新
```

## 配置（`config.json → oauth`）

```jsonc
{
  "oauth": {
    "enabled": false,                 // 开启后才有「授权添加」入口
    "mode": "sts",                    // sts=换临时凭据入库；token=只存 token（上游需接受 x-auth-token 才用）
    "authorizeUrl": "https://oauth-login.cloud.huawei.com/oauth2/v2/authorize",
    "tokenUrl": "https://oauth-login.cloud.huawei.com/oauth2/v2/token",
    "clientId": "",                   // 华为云 OAuth App 的 Client ID
    "clientSecret": "",               // 只在服务端换 token 用，绝不发给浏览器
    "redirectUri": "http://127.0.0.1:8787/oauth/callback",   // 必须是华为云 App 里登记的回调，且公网可达
    "scope": "openid",
    "region": "cn",
    "accountNamePrefix": "授权账号",
    "stateTtlMs": 600000,
    "proxy": "",                      // token/STS 出站代理（可留空）
    "deviceAuthorizationUrl": "",     // codearts-cli 模式：设备授权端点（华为云 OAuth 设备端点）
    "cliAuthPageUrl": "https://codearts.huaweicloud.com/portal/settings/cli-auth",   // 原版 CLI 的登录页
    "sts": {
      "endpoint": "https://sts.cn-north-4.myhuaweicloud.com/v1/{domainId}/agency/assume-role",
      "domainId": "",                 // 委托所在的华为云 domain_id
      "agencyName": "",               // 委托名称
      "durationSeconds": 3600,
      "tokenField": "access_token",   // 用 OAuth 响应里哪个字段当 X-Auth-Token（access_token 或 id_token）
      "akPath": "credential.access",           // STS 响应里 AK 的 JSON 路径
      "skPath": "credential.secret",           // SK 路径
      "tokenPath": "credential.securitytoken", // SecurityToken 路径
      "expiresAtPath": "credential.expires_at" // 过期时间路径
    }
  }
}
```

## 华为云侧要准备什么

1. **OAuth App**：华为云控制台 → 统一身份认证（IAM）→ OAuth 应用，建一个应用，拿到 Client ID / Secret，登记回调地址填 `redirectUri`（生产环境填 `https://你的域名/oauth/callback`）。
2. **委托（agency）+ STS**：建一个委托 `codearts-agency`，被委托方是「使用 OAuth 登录的用户」，委托权限给到 snap-access 所需的服务；`domainId` 填委托所属账号的 domain_id。
3. 把 Client ID / Secret、domainId、agencyName 填进配置，`enabled: true`，重启。

> 委托授权本质是「把 OAuth 身份映射到一套临时 AK/SK」。没有委托关系，登录链接只能拿到身份 token，变不出 AK/SK。

## 模拟原版 CLI 登录（`mode: "codearts-cli"`）

原版 CLI 登录实测（`docs/real-login.md`）会打印一个链接、用户浏览器授权后拿到 STS 三元组，落盘到
`auth.json` 里带一个 `dpop_key_pair`——说明它用 **OAuth + DPoP（RFC 9449）+ 设备码**。

本模式复刻同一条链路，`lib/dpop.mjs` 生成 ES256（P-256）密钥对、每次请求带上 DPoP 证明 JWT：

```
面板「授权添加」
  → 生成 DPoP 密钥对
  → POST deviceAuthorizationUrl（带 DPoP 头）拿 device_code / user_code / verification_uri
  → 打开 verification_uri（或 cliAuthPageUrl），展示 user_code
  → 轮询 tokenUrl（grant_type=device_code + DPoP 头），直到 success
  → 从 token 响应解析 STS 三元组（支持 access_key_id/credential.access 多种形状）
  → 入库（authType=sts，domainId/userId/refresh 一并落库）
```

配置：`mode: "codearts-cli"` + `deviceAuthorizationUrl` + `tokenUrl` + `clientId`。响应字段路径复用 `sts.*Path`
（默认就能识别原版 CLI 的顶层 `access_key_id`/`secret_access_key`/`security_token` 形状）。

> 端点名称这里用占位符：华为云 OAuth 设备端点需要从原版 CLI 反编译拿到确切 URL（本仓库之前提取的
> `_codearts_re/` 已清理）。`codearts-cli` 模式把协议、DPoP、解析、入库全部做对了，只差把两个真实 URL 填进去。

## 导入原版 CLI 的 auth.json（零配置，最可靠）

原版 CLI 登录一次后，凭据在 `%USERPROFILE%\.codeartsdoer\cli-data\auth.json`。面板「📥 导入 auth.json」直接贴这个文件：

```json
{ "inferhub-provider": {
    "type": "oauth",
    "access": "{\"access_key_id\":\"HSTA…\",\"secret_access_key\":\"…\",\"security_token\":\"…\",\"dpop_key_pair\":{…}}",
    "refresh": "JWT…",
    "expires": 1760000000000,
    "accountId": {"domain_id":"…","domain_name":"…","user_id":"…"}
} }
```

网关解析 `inferhub-provider.access`（字符串 JSON 或对象都认），提取 `access_key_id`/`secret_access_key`/
`security_token`/`expires`/`accountId`，按 STS 账号入库。`refresh` 记进 `note` 备查。**这是唯一不需要任何华为云侧配置、
开箱即用的方式**——你只需要在真机用原版 CLI 登录一次，把 auth.json 粘进来。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/panel/api/oauth/start` | 需要面板登录态；生成登录链接 + state（或 deviceCode） |
| POST | `/panel/api/oauth/poll` | 需要面板登录态；`codearts-cli` 设备码轮询 |
| GET | `/panel/api/oauth/status?state=…` | 需要面板登录态；轮询授权结果 |
| GET | `/oauth/callback?code=…&state=…` | 无需登录态（华为云回调）；换凭据 + 入库 |
| POST | `/panel/api/accounts/import-auth` | 需要面板登录态；粘贴 auth.json 导入账号 |

## 安全边界

- `state` 是 24 字节随机数、10 分钟过期，回调时严格校验，防 CSRF / 重放。
- `clientSecret` 只在服务端换 token 时用，不出现在任何前端响应里。
- DPoP 私钥只存在于本次授权流程内存，入库后不落盘（网关后续只用 STS 三元组签名）。
- STS 模式下 **不落盘 OAuth token**，只存临时 AK/SK/SecurityToken，过期后账号自动标记失效。
- `proxy` 走传输层（`lib/transport.mjs`），支持单请求 CONNECT 隧道。

## 测试

```bash
npm run test:oauth   # 56 项：链接生成 / code→STS→入库 / 轮询 / 错误路径 / token 模式 / DPoP / 设备码模式 / auth.json 导入
```

`tools/test-oauth.mjs` 用本地假 OAuth + 假 STS + 假设备授权服务器跑全程，不碰真实网络。
