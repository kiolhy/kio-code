# 华为 CodeArts CLI（码道 / codeartsdoer）反代链路分析

样本：`agentkernel.exe`（Bun 单文件，165,646,264 B），JS 全部在 PE 段 `.bun` 内
（rawptr `0x05de8800`，rawsz `0x0400f000`，67,170,304 B）。
下文偏移均为 `_codearts_re\bun_section.bin` 内偏移。

---

## 0. 结论速览

这个 CLI 里所谓"反代"其实是**三层叠加**，不要混为一谈：

| 层 | 名称 | 谁在监听 | 作用 |
|---|---|---|---|
| L1 | 本地 opencode webserver | `127.0.0.1:<随机0>` | TUI ↔ 内核的本地 HTTP API（`/v1/init`、`/v1/chat/completions` …） |
| L2 | **AgentArmor 反向代理** | `127.0.0.1:<proxyPort>`（10000–65535 随机） | 真正意义的反代：劫持全局 `fetch`，把命中条件的请求塞进 `agent_defense_combined.exe` 做策略/身份校验后再出网 |
| L3 | 企业出站代理 | 不监听 | `HttpsProxyAgent`，用于走公司 HTTP(S)_PROXY 出网 |

模型流量本身**不经过自建服务器中转**，而是直连 inferhub 网关（`snap-access` / `snapengine-apig`），
用 AK/SK 的 SDK-HMAC-SHA256 或 `x-auth-token` 鉴权。

---

## 1. 启动链与环境变量

`install.ps1` → `codearts_cli_versioninfo_v1.0.json` → 平台 zip
（`.../codearts/cli_tui/latest/codearts-install-26.10.9-win32-x64.zip`）→ 解出
`agentkernel.exe` / `codearts.cmd` / `codearts` / `@primno+dpapi.node`。

`codearts.cmd` 注入：

```
SCENARIO=codeartsdoer
KERNEL_DATA_DIR=%USERPROFILE%\.codeartsdoer\cli-data
KERNEL_STATE_DIR=%USERPROFILE%\.codeartsdoer\state
KERNEL_CONFIG_DIR=%USERPROFILE%\.codeartsdoer
OPENCODE_CONFIG=%USERPROFILE%\.codeartsdoer\codearts_cli.json
OPENCODE_MODE=tui
PLUGIN_ENV=hc
NODE_TLS_REJECT_UNAUTHORIZED=0      ← 全局关证书校验
OPENCODE_DISABLE_MODELS_FETCH=1     ← 只关 models.dev，不关云端模型列表
CODEARTS_DISABLE_AUTO_UPDATE=true
OMO_SEND_ANONYMOUS_TELEMETRY=0
```

`PLUGIN_ENV=hc` 是关键分支开关：大量逻辑写成
`process.env.PLUGIN_ENV==="hc" ? 华为云通道 : 开源 opencode 通道`。

---

## 2. L1：本地 webserver

TUI 侧通过 `_0()`（offset ≈ 10.72M）拉起：

```
<webserverPath> serve --hostname=127.0.0.1 --port=0
```

从 stdout 里正则抠 `server listening on http(s)://...` 拿到真实端口，再
`tu({ baseUrl, directory })` 建客户端。

本地路由（`/v1/...`）：

```
/v1/init            初始化：注入 token / inferhubBaseUrl / codebaseUrl / agentCenterApiUrl
                    / promptCenterApiUrl / policyCenterDomain / proxy / noProxy / marketHost …
/v1/config          PATCH 全局配置
/global/config      PATCH provider 配置（models 定义）
/v1/chat/completions
/v1/auth/hash       签名哈希（app_id=CodeAgent3.0 / plugin_version / kernel_version / user_id）
/v1/skills, /v1/mcp-tools, /v1/builtin-tools
/v1/codebases*, /v1/index*, /v1/lsp, /v1/local-tools/*, /v1/speech/continue-stream
```

`/v1/init` 的 schema 就是攻击面清单（offset 9.413M），凡是它能 `T.update(...)` 的字段，
都可以由"外部调用方"覆盖 —— 包括 `inferhubBaseUrl`、`proxy`、`noProxy`、`marketHost`。

---

## 3. L2：AgentArmor 反向代理（核心）

### 3.1 定位与下载

```
gm = { SERVICES:"all",
       EXECUTABLE_NAME:"agent_defense_combined.exe",
       AGENTARMOR_PATH:"agentarmor" }

Im = process.env.CODEAGENT_AGENTARMOR_TOOL_NAME
     || "agent_defense_combined_codeAgent_v2.3.1"

Pm = {
  TOOL_ZIP_URL   : https://cmc-nkg-artifactory.cmc.tools.huawei.com/artifactory/
                   cmc-software-release/CloudBuild/AgentArmor/v1.0.0/${Im}.zip
  POLICY_JSON_URL: .../AgentArmor/v1.0.0/policy.json
  PLUGIN_JS_URL  : .../AgentArmor/v1.0.0/intentv3.js
  DOWNLOAD_TIMEOUT: 60000, CONFIG_DOWNLOAD_TIMEOUT: 30000
}
```

装到 `<bin>/agentarmor/<Im>/agent_defense_combined.exe`，
策略文件 `<bin>/agentarmor/plugin/policy.json`。

### 3.2 端口分配 `Sz()`

```
Oz = { portRangeStart:10000, portRangeEnd:65535,
       maxRetryAttempts:10, portCheckTimeout:1000 }
```

依次为 `["proxy","identity","health"]` 各分配一个端口：

1. `randomInt(10000, 65536)`
2. 已分配集合去重
3. 范围校验
4. `net.connect({port})`：**能连上 = 已占用 = 换端口**；`error` = 空闲 = 采用

返回 `{ proxyPort, identityPort, healthPort }`。

### 3.3 启动命令

```
agent_defense_combined.exe
  --services all
  --proxy-host 127.0.0.1
  --proxy-port   <proxyPort>
  --identity-port <identityPort>
  --health-port  <healthPort>
  --list-dir <data>/agentarmor
  --plugin-preset mcp_protected_plugin      # featureSwitches.input_output_control
  --plugin-preset identity_plugin           # featureSwitches.identity_security
```

`spawn(..., { detached:false, stdio:["ignore","pipe","pipe"], windowsHide:true })`，
stdout/stderr 按 **GBK** 解码（`new TextDecoder("gbk")`），带 `[AgentArmor:stdout]` 前缀进日志。

### 3.4 健康检查

```
{ checkInterval:30, failureThreshold:3, requestTimeout:5000, gracefulTerminateTimeout:10000 }
```

连续 3 次失败 → `SIGTERM`，3s 内未退 → `SIGKILL` → 重新 `startProcess`。
`confirmTerminated()` 用 `process.kill(pid,0)` + 端口可连性双确认。

### 3.5 请求劫持（最关键的一段）

```
var K3 = globalThis.fetch;

vUn = Object.assign(async (n, t={}) => {
  let e = ve.getProcessInfo();            // armor 进程信息
  let i = e && e.status === "RUNNING";
  let r = _Un(url, t);                    // 命中判定
  if (i && r) {
     let f = `http://127.0.0.1:${e.proxyPort}`;
     c = await K3(n, { ...t, proxy: f }); // Bun 的 fetch proxy 选项
  } else c = await K3(n, { ...t });
  return c;
}, { preconnect: K3.preconnect.bind(K3) });

if (!K()) globalThis.fetch = vUn;         // K() = 是否开源 opencode 模式
```

命中判定 `_Un(url, init)`：

1. `GlobalConfig.inferhubBaseUrl` 为空 → 不代理
2. 取 `inferhubBaseUrl` 按 `,` 切成主/备 URL 列表，逐个比 `new URL(x).hostname`
   —— **目标 URL 的 hostname 与网关 hostname 相同即命中**
3. 否则看请求头：`Headers` 用 `.has("cookie")`；数组/对象形式逐项
   `toLowerCase()==="cookie"` 且值非空 —— **只要带 Cookie 也命中**

日志标记：`use armor proxy because host match` / `use armor proxy because cookie match` /
`proxy raw fetch: http://127.0.0.1:<port>`。

> 含义：AgentArmor 不是全局 MITM，而是**只对"模型网关域名"和"带 Cookie 的请求"做中间人**。
> 换掉 `inferhubBaseUrl` 就等于换掉被代理的域名集合。

### 3.6 远程特性开关

```
POST {policyCenterDomain}/PromptCenterService/v1/policy/feature-toggle
headers: { "Content-Type":"application/json", "x-auth-token": <userToken>, ...mi() }
body:    { department: <dept> }
timeout: 3000ms     轮询: 30 分钟 (INTERVAL_MS=1800000)

DEFAULT_SWITCHES = { base_enable:false, input_output_control:false,
                     identity_security:false, permission_security:false }
```

开关生效逻辑：

* `input_output_control` → 加 `--plugin-preset mcp_protected_plugin`
* `identity_security`    → 加 `--plugin-preset identity_plugin`
* `permission_security`  → 改写 `policy.json` 的
  `runtime.policyGroups.{systemSecurityProtection, fileSecurityProtection,
  applicationResourceAccessControl}.enabled`
* 其余变化判定 `RESTART_REQUIRED` 才重启进程

---

## 4. L3：出站代理与企业网络策略

### 4.1 代理选择优先级 `Zj()`

```
1. GlobalConfig.proxy        （IDE 下发）
2. HTTP_PROXY / HTTPS_PROXY / http_proxy / https_proxy
3. 系统代理 —— 仅当 PLUGIN_ENV=hc && IS_PROD=true
   Windows: 注册表 ProxyServer，支持 "http=host:port;https=host:port" 多协议映射
4. 都没有 → 空
```

noProxy 合并顺序：`GlobalConfig.noProxy` + `NO_PROXY/no_proxy` + 系统 no_proxy
+ 硬编码 `"localhost,127.0.0.1"`；`*.foo` → `.foo`，`*` 前缀剥离；
匹配支持精确、`*.` 后缀、`.` 后缀三种。

命中 noProxy → 直连；否则 `Aj(url)` 返回 `new HttpsProxyAgent(proxy)`。
日志 `[proxy-diag] source: IDE|Env|System|None`，代理串里的 `user:pass` 打码成 `***:***`。

### 4.2 network-interceptor 允许清单

```
allowlist : [".local", ".lan", ".internal", ".corp", ".huawei.com", ".myhuaweicloud.com"]
localhost : ["localhost", "127.0.0.1", "::1", "0.0.0.0"]
schemes   : ["data:", "file://"]
```

拦截文案（对外可见）：

```
Request blocked by corporate proxy due to excessive context length or file size.
您的对话上下文过长或上传...
```

即：内网域名白名单 + 上下文/文件体积上限，两道一起卡。

### 4.3 TLS

* launcher 直接 `NODE_TLS_REJECT_UNAUTHORIZED=0`
* `se()`：`IS_PROD!=="true"` 时返回 `{ tls:{ rejectUnauthorized:false } }`（Bun）
  或 `new undici.Agent({ connect:{ rejectUnauthorized:false } })`
* 各处 `httpsAgent: new https.Agent({ rejectUnauthorized: D4() })`

---

## 5. 模型网关（inferhub）请求构造

### 5.1 base URL 解析链 `HV()` / `DFn()` / `rj()`

```
1. GlobalConfig.inferhubBaseUrl          （/v1/init 注入，最优先）
2. model.metadata.{inferhubBaseUrl|baseURL|baseUrl|url|api.url|options.baseURL}
3. GlobalConfig.provider["inferhub-provider"] 的 options.baseURL / models[*].api.url
4. provider.list() → 找 id==="inferhub-provider"
5. 兜底 "" 并 warn "inferhub base URL not resolved"
```

`rj()` 再补 `/api/v2/` 后缀；chat 走 `bA()` → 补 `/chat/completions`。

### 5.2 鉴权：两条互斥路线

**A. AK/SK（优先）** —— `getInferhubHcHeaders()`（offset ≈ 6.77M）

```
ak = userInfo.accessKeyId   || env CODEARTS_CLI_AK
sk = userInfo.secretAccessKey || env CODEARTS_CLI_SK
token = userInfo.accessToken

req = new I1; req.data = body; req.endpoint = url; req.method = "POST";
req.headers = { "X-Security-token": token||"", "x-ot-trace-id":…, "x-ot-span-id":…,
                "x-snap-traceid":…, "x-ot-session-id":…, "x-ot-parent-session-id":…,
                "user-session-id":…, "x-ot-function":"agent-tui", "X-Language":…,
                "user-msg-id":…, "created-time":…, "model-id":…, "model-name":…,
                "x-ot-client-type":"CLI", "x-ot-client-version":…,
                "plugin-name"/"plugin-version"/"ide-name"/"ide-version":…,
                "client-ip":… }

signed = nh.sign(req, new g1(ak, sk))
```

签名实现（offset ≈ 15.53M）：

```
SDK_SIGNING_ALGORITHM = "SDK-HMAC-SHA256"
HeaderXDate           = "X-Sdk-Date"        （yyyyMMdd'T'HHmmss'Z'，UTC）
HeaderHost            = "host"
HeaderContentSha256   = "X-Sdk-Content-Sha256"
EMPTY_BODY_SHA256     = e3b0c442...b855

canonicalRequest = METHOD \n canonicalURI \n canonicalQuery \n
                   canonicalHeaders \n signedHeaders \n payloadHash
stringToSign     = SDK-HMAC-SHA256 \n X-Sdk-Date \n sha256Hex(canonicalRequest)
Signature        = HMAC-SHA256(sk, stringToSign)
Authorization    = SDK-HMAC-SHA256 Access=<ak>, SignedHeaders=<...>, Signature=<...>
```

`canonicalURI` 会对每段做 URL encode 且强制以 `/` 结尾；
`signSimple()` 版本额外固定 `X-Sdk-Content-Sha256: UNSIGNED-PAYLOAD`。

**B. userToken（无 AK/SK 时）**

```
x-auth-token: <GlobalConfig.userToken | env W3_TOKEN>
```

### 5.3 公共头

```
x-auth-token / X-Security-token / Authorization: Bearer <apiKey>
is_confidential: "true"|"false"       ← checkIsKia(directory)===ok
app-id: "CodeAgent3.0"                ← SCENARIO ∈ {opencode,codemate,codeartsdoer}
maas_type: "benefit"                  ← 免费权益模型
mi() → depart（encodeURIComponent 部门）+ traceId/spanId
```

`mi()` 是两套同名函数，注意区分：一处是 **traceparent 解析**（`00-<trace>-<span>-01`），
另一处（app 自己的）返回 `{ depart }` 头，注入到
`AgentCenter` / `PromptCenter` / `MemoryAgent` / `CodeBase` 等各服务的请求里。

### 5.4 域名主备切换（domain-switch）

```
字段表 V = ["inferhubBaseUrl","policyCenterDomain","knowledgeBaseUrl",
            "memoryServiceBaseUrl","codebaseUrl","codehubApiUrl",
            "agentCenterApiUrl","marketHost"]

配置值格式："<primary>,<standby>"   （逗号分隔，只认前两段）
```

* 熔断器：`failureThreshold` 次失败 → `Open`；`forceHalfOpen()` 有冷却 `minForceHalfOpenIntervalMs`
* 触发错误码：`ECONNREFUSED/ECONNRESET/EPIPE/ETIMEDOUT/ENOTFOUND/EAI_AGAIN/EAI_NONAME/
  UND_ERR_CONNECT_TIMEOUT/UND_ERR_SOCKET/UND_ERR_DNS/ConnectionRefused`
* `getRetryUrlForPrimaryFailure(url)` / `getPrimaryRetryUrlForStandbyFailure(url)` 做 hostname 替换
* **注意**：日志里写着 `switch triggered, but domain switch disabled, report only`
  —— 当前版本只上报不真的切域名，`kJ()` 里 `instant retry disabled`。

---

## 6. 后端服务清单（含域名/路径/头）

| 服务 | 域名 | 路径 | 鉴权头 |
|---|---|---|---|
| benefit-service（非 prod） | `https://snapengine-apig.cn-north-7.myhuaweicloud.com` | `/api/v1/benefit/claim`、`/api/v1/user/tokens/balance`、`/api/v1/gateway/config` | SDK-HMAC-SHA256 + `X-Security-token` |
| benefit-service（prod） | `https://opengw.developer.huaweicloud.com` | 同上 | 同上 |
| snap-manager（prod） | `https://snap-access.cn-north-4.myhuaweicloud.com` | `/snap-manager/v1/current/user`、`/privacy`、`/chat-session/heartbeat`、`/statistics/plugin`、`/skill/{publish,complete,submissions}` | `X-Security-Token`+签名 / `x-auth-token` |
| snap-manager（beta） | `https://snapengine-apig.cn-north-7.myhuaweicloud.com` | 同上 | 同上 |
| agent-center | GlobalConfig.agentCenterApiUrl | `/v1/agent-center/agents/useragents?offset=0&limit=100`、`/v1/agent-center/agents/detail?agent_id=`、`/v1/skills-rules/list`、`/v1/gateway-config`、`/mcpService/external/skills/v1/{query,link/v1/get}` | `x-auth-token`+`x-current-user`+`Agent-Type: AgentCenter` |
| prompt-center | GlobalConfig.promptCenterApiUrl / policyCenterDomain | `/v1/model/builtin`、`/PromptCenterService/v1/prompts/retrieve`、`/PromptCenterService/v1/policy/feature-toggle` | `x-auth-token`+`Agent-Type: PromptCenter` |
| memory-service | GlobalConfig.memoryServiceBaseUrl | `/v1/<ns>/preferences[/{id}]` | `x-client-type: DevMate`+`Agent-Type: MemoryAgent` |
| codebase | GlobalConfig.codebaseUrl | `/codebaseservice/v1/codebases`、`/parsetaskmgt/api/v1/{groupRepoBranch/queryBranchTreeV2,personal/increase,personal/progress}` | `x-auth-token`+`x-current-user`+`X-Referer: CodeBase`+`x-snap-traceid` |
| skills 市场 | `https://skills.huaweicloud.com/community`（dev: `skillstest.developer.huaweicloud.com`） | — | — |
| OTLP logs/traces（hc prod） | `https://collector-agents-access.cn-north-4.myhuaweicloud.com/collector/v1/{logs,traces}` | — | 签名 |
| OTLP（hc beta） | `https://beta-collector-agents-apig.cn-north-7.ulanqab.huawei.com:443/collector/v1/...` | — | 签名 |
| OTLP（hc 国际站） | `https://beta-hk-collector-agents-apig...` / `...ap-southeast-1.myhuaweicloud.com` | — | 签名 |
| ripgrep 下载 | `https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/codeAgentPlugin/ripgrep` | — | 无 |
| 文档 | `https://support.huaweicloud.com/productdesc-codeartssnap/codeartsdoer_pd_0001.html` | — | — |

### 内部/测试通道（生产包里没删）

```
inferhubBaseUrl 默认值（非 prod）:
  http://snapengine.codemate.cce.prod-kwe-g.dragon.tools.huawei.com/api/v2/

CloudDragon 登录：
  POST https://rnd-idea-api.huawei.com/ideaclientservice/login/v4/secureLogin
       { user, password } → cloudDragonTokens.authToken / refreshToken
  POST .../login/v5/refreshToken  { refreshToken }
  凭据来源：环境变量 CODEMATE_ACCOUNT / CODEMATE_PASSWORD

CMC 制品库：
  https://cmc-nkg-artifactory.cmc.tools.huawei.com/artifactory/
  cmc-software-release/CloudBuild/AgentArmor/v1.0.0/*
```

---

## 7. 模型列表与路由

### 7.1 模型列表（不是 models.dev）

`OPENCODE_DISABLE_MODELS_FETCH=1` 只关掉 `models.dev` 拉取，云端模型照样拉：

```
eK(models)                      // loadXCenterModels
 ├─ kjn(models)                 // 免费权益模型：IG() 拿 gateway config，再 gG() claim
 │     GET  /api/v1/gateway/config  → { endpoint, models[] }
 │     POST /api/v1/benefit/claim
 │     合并成 { id, is_free_benefit:true, limit }
 └─ Kjn(ak,sk,token)            // 取 agent_id
       GET {base}/v1/agent-center/agents/useragents?offset=0&limit=100
       匹配 original_id/agent_id === CODEAGENT_ID
 fK({urls: Ao, ...})            // 带重试(2次)+主备回落
       GET {base}/v1/agent-center/agents/detail?agent_id=<id>
       → data.gpts.models[] → { id, reasoning, limit, enable_queue,
                                variants_key, credit }
 缓存: <cache>/models-cache.json  (TTL 86400000ms)
```

`Ao` 即日志里的 `XCENTER_BASE_URLS`；为空时回落到
`inferhubBaseUrl` 去掉 `/api/v2/` 后缀（`J1t()` → `q1t()`）。

`enable_queue:true` 的模型会被 `setQueuedModels()` 收集，进入排队/限流通道。

### 7.2 路由装配

```
provider["inferhub-provider"]  →  npm: "@ai-sdk/inferhub-provider"
provider["benefit-model"]      →  npm: "@ai-sdk/inferhub-provider"
CUSTOM_PROVIDER_KEYS=<k1,k2>   →  追加自定义 provider（默认 @ai-sdk/openai-compatible）

每个 model 的 api.url = r_(id) ? PG(id)||f : f
  r_(id)   = 该模型在 benefit 网关的 model map（P1）里
  PG(id)   = 该模型的专属 endpoint（来自 gateway config）
  f        = aK() = inferhub 默认 baseUrl
```

`chat.params` hook 对 `inferhub-provider` 强制 `options.tool_stream = true`；
`chat.headers` hook 对命中 benefit 的模型加 `maas_type: benefit`。

### 7.3 复杂度分类器

独立的 `POST {inferhub}/chat/completions`，`max_tokens:256`，`stream:false`，
模型按 `{provider:"inferhub-provider", groupId:"auto", targetTag:"lightweight"}` 挑；
`CODEAGENT_CLASSIFIER_LOG_BODY=1` 可把请求/响应体打到 console。

---

## 8. 可干预/可观测的注入点

| 变量 / 配置 | 效果 |
|---|---|
| `GlobalConfig.inferhubBaseUrl` 或 `INFERHUB_BASE_URLS` | 改模型网关 + 改 armor 代理命中域名集合 |
| `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` | 优先级**高于** GlobalConfig 的 AK/SK |
| `HW_ACCESS_KEY` / `HW_SECRET_KEY` / `HW_SECURITY_TOKEN` | 另一组环境变量凭据（`source:"hw_env"`） |
| `W3_TOKEN` / `W3_USER` | 覆盖 `userToken` / `userName` |
| `GlobalConfig.proxy` / `noProxy` / `HTTP(S)_PROXY` / `NO_PROXY` | 出站代理与绕过 |
| `CODEAGENT_AGENTARMOR_TOOL_NAME` | 改 AgentArmor 下载包名 → 改下载 URL |
| `GlobalConfig.provider[...]`（经 `/global/config` PATCH） | 直接改 provider/models/baseURL/apiKey |
| `GlobalConfig.marketHost` / `extensionMarketHost` | 改 MCP/插件市场地址 |
| `IS_PROD` | 决定 benefit 走 opengw 还是 snapengine-apig、遥测走哪个 collector |
| `PLUGIN_ENV=hc` | 打开华为云通道（否则走开源 opencode 分支） |

---

## 9. 待办 / 未展开

* `Ao`（`XCENTER_BASE_URLS`）的静态初始化位置尚未定位 —— 它经
  `chunk-4z1vmdrn.js` 的 `ZF` 导出，实际运行时更像由 `GlobalConfig` 派生，
  建议动态侧验证（`strings` 无法给出赋值点，需 hook `q1t()`）。
* `agent_defense_combined.exe` 本体（armor zip 内）未下载分析 ——
  其 `--proxy-port` 实现的策略判定、`identity_plugin` 的身份校验协议都在里面。
* 本地 webserver 的 `tu()` 客户端未验证是否有鉴权（当前看是裸 `127.0.0.1`）。
