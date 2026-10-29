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

## 开关：面板「设置 → 账号授权添加」

不用改配置文件、不用重启：面板「设置」页有「账号授权添加」一栏，勾上开关选好模式保存即可，**立即生效**。

| 设置项 | 作用 |
|---|---|
| 开启开关 | 等价于 `oauth.enabled`；关掉后点「授权添加」返回 409 `oauth_disabled` |
| 授权模式 | `codearts`（推荐，真实登录）/ `sts` / `token` / `codearts-cli` |
| 自动续期 | 等价于 `oauth.refresh.enabled` |

优先级：**面板设置 > config.json**。面板里 `oauth.enabled` 存 `null` 表示「跟随配置文件」，存 `true/false`
则以面板为准（写进 `data/settings.json`）。`mode=codearts` 时即使配置文件没写 `enabled: true` 也视为开启。

接口：`GET /panel/api/settings` 返回 `effective: { enabled, mode }` 与 `modes`；`PATCH /panel/api/settings`
带 `{ "oauth": { "enabled": true, "mode": "codearts", "refreshEnabled": true } }`，非法 `mode` 返回 400 `bad_oauth_mode`。

## 码道真实登录协议（`mode: "codearts"`，走真实网络）

从 `agentkernel.exe`（Bun 编译产物）反编译还原的 auth 模块，**不是模拟**，端点/参数全部是真实值：

| 项 | 真实值 |
|---|---|
| 授权页 | `https://codearts.huaweicloud.com/portal/authorize` |
| token | `https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` |
| ticket | `https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket` |
| `client_id` | `CodeArts_Tui` |
| 协议 | 授权码 + PKCE（`code_challenge_method=SHA-256`）+ DPoP（ES256，`typ=dpop+jwt`） |
| 回调 | `http://127.0.0.1:<port>/oauth/callback`，带 `?code=…` 或 `?secret=…&redirect=…` |

### 链路

```
生成 verifier(128 hex) + challenge = base64url(sha256(verifier)) + ticket_id(32 hex)
→ 打开 https://codearts.huaweicloud.com/portal/authorize
     ?locale=zh-cn&client_id=CodeArts_Tui&port=<回调端口>
     &code_challenge=<challenge>&code_challenge_method=SHA-256&ticket_id=<ticket_id>
→ 浏览器授权后跳回 http://127.0.0.1:<port>/oauth/callback?code=…
→ POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
     Content-Type: application/x-www-form-urlencoded
     DPoP: <ES256 证明 JWT，htm=POST, htu=该 URL>
     client_id=CodeArts_Tui&code=…&code_verifier=…&grant_type=authorization_code
     &redirect_uri=http://127.0.0.1:<port>/oauth/callback
→ 响应 { credentials: { access_key_id, secret_access_key, security_token, expiration }, refresh_token }
→ 入库（authType=sts），refresh + dpop_key_pair 记进 note，可用于续期
```

另一条异步路径：回调带 `secret` 时，用 `ticket_id + secret` 去
`GET {ticketBase}/v1/login/ticket?ticket_id=…&secret=…`（最多轮询 10 次，1 秒间隔）换
`{ credential: { access, secret, securitytoken, expires_at } }`。

续期：`POST token`，`grant_type=refresh_token&refresh_token=…`，带 DPoP 头 + `x-agent-user-account`。

> **DPoP 签名格式（实测踩坑）**：JWS 要求 ECDSA 是 **P1363（r||s，64 字节）**，Node `crypto.sign` 默认给
> DER，会被 STS 直接拒：`STS5.1804 invalid DPoP proof: 'decode DPoP failed with jwk: …'`。
> `lib/dpop.mjs` 已显式用 `dsaEncoding: 'ieee-p1363'`。

### 真实网络验证结果（已实测）

```
GET  https://codearts.huaweicloud.com/portal/authorize?...  → 200 text/html（真实授权页）
POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
     不带 DPoP → 400 {"error_code":"APIGW.0106","error_msg":"...Invalid header parameter: DPoP, required"}
     带 DPoP  → 400 {"error_code":"STS5.1805","error_msg":"invalid authorization code"}
     refresh  → 400 {"error_code":"STS5.1806","error_msg":"invalid refresh token: 'decode jwt header failed'"}
```

也就是说：DPoP 证明被接受、`client_id=CodeArts_Tui` 被接受、`grant_type=authorization_code` 与
`grant_type=refresh_token` 两条链路都走到了正确的校验层，只差真实授权码 / 真实 refresh token。

## 自动续期（STS 过期前换新，不用重新登录）

码道 OAuth 账号入库时，`refresh_token` 和 `dpop_key_pair` 存在账号的 `note` 里（`publicAccount` 只对外给
「可自动续期」标记，不泄露私钥）。续期就是 `POST token`，`grant_type=refresh_token` + 同一把 DPoP 密钥。

两种触发：

1. **后台自动**：`config.oauth.refresh` 控制，默认每 5 分钟扫一次，把 15 分钟内将过期的账号续掉。
2. **面板手动**：账号行上出现「续期」按钮（`canRefresh=true` 时），或调
   `POST /panel/api/accounts/{id}/refresh`。

```jsonc
"oauth": {
  "refresh": {
    "enabled": true,
    "checkMs": 300000,   // 扫描间隔
    "leadMs": 900000     // 提前多久续（15 分钟）
  }
}
```

续期成功会**就地更新**账号（AK/SK/SecurityToken/过期时间），并把 `refresh_token` 轮换成新的；
不会新增账号，也不会改动 `dpop_key_pair`。没有 refresh 材料的账号（手动粘 AK/SK、或 auth.json 导入）
调用续期会明确返回 `no_refresh_material`。

### 远程部署怎么用

授权页固定跳 `127.0.0.1:<port>`，所以：

- **网关跑在本机**（`127.0.0.1:8787`）：回调直接打到网关，全自动。
- **网关在远程服务器**：浏览器会跳到本机 `127.0.0.1:<port>` 打不开——把地址栏那条
  `http://127.0.0.1:8787/oauth/callback?code=…` 整条复制，粘进面板「完成授权」输入框，
  由服务器端完成 token 交换（交换本身不需要浏览器）。

面板会同时给出**可复制的授权链接**（只读输入框 + 「复制授权链接」按钮），可以复制到任意浏览器打开。

> 回调里的 `state` 是码道自己的随机串（96 位 hex），**不是**我们的 `ticket_id`（32 位 hex）。
> 早期版本误把 `state` 当 `ticket_id` 校验，会报 `ticket_mismatch`；现在只认显式 `ticket_id`，
> 且同一时间只有一个待授权会话，标识对不上时按当前会话继续。

配置：`oauth.mode = "codearts"`，端点可用 `oauth.codearts.*` 覆盖（区域/企业版不同时改这里）。

## 导入原版 CLI 的 auth.json（零配置）

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
`security_token`/`expires`/`accountId`，按 STS 账号入库。`refresh` 记进 `note` 备查。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/panel/api/oauth/start` | 需要面板登录态；生成登录链接 + state（或 deviceCode） |
| POST | `/panel/api/oauth/poll` | 需要面板登录态；`codearts-cli` 设备码轮询 |
| POST | `/panel/api/oauth/complete` | 需要面板登录态；粘贴回调地址完成 `codearts` 授权（远程部署用） |
| GET | `/panel/api/oauth/status?state=…` | 需要面板登录态；轮询授权结果 |
| GET | `/oauth/callback?code=…&state=…` | 无需登录态（华为云回调）；换凭据 + 入库 |
| POST | `/panel/api/accounts/import-auth` | 需要面板登录态；粘贴 auth.json 导入账号 |
| POST | `/panel/api/accounts/{id}/refresh` | 需要面板登录态；就地续期（refresh_token + DPoP） |

## 安全边界

- `state` 是 24 字节随机数、10 分钟过期，回调时严格校验，防 CSRF / 重放。
- `clientSecret` 只在服务端换 token 时用，不出现在任何前端响应里。
- DPoP 私钥只存在于本次授权流程内存，入库后不落盘（网关后续只用 STS 三元组签名）。
- STS 模式下 **不落盘 OAuth token**，只存临时 AK/SK/SecurityToken，过期后账号自动标记失效。
- `proxy` 走传输层（`lib/transport.mjs`），支持单请求 CONNECT 隧道。

## 测试

```bash
npm run test:oauth      # 56 项：链接生成 / code→STS→入库 / 轮询 / 错误路径 / DPoP / 设备码 / auth.json 导入
npm run test:codearts   # 57 项：真实授权链接 / PKCE / DPoP 请求形状 / code→token / secret→ticket / 续期 / 批量续期 / 回调容错 / 错误路径
```

`tools/test-oauth.mjs` / `tools/test-codearts-auth.mjs` 用本地假服务器跑全程（校验请求形状与签名），不碰真实网络。
