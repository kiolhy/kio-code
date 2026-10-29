# mock-hub —— 码道 CLI（codeartsdoer）后端模拟 / 反向代理网关

把华为 CodeArts CLI 会访问的**所有**后端接口在本地完整复刻一遍：模型网关、agent-center、
benefit 权益、snap-manager、prompt-center、memory、codebase，以及 **OTLP 遥测接收**。
零依赖，纯 Node（>= 20），一条命令起服务。

用途：
- 在没有真实凭据的情况下跑通 CLI 全链路（登录、拉模型、对话、心跳、上报）
- 抓 CLI 到底发了什么：完整请求头、签名、AK、token、遥测内容
- 做真实网关的**反向代理**，把上游换成任意 OpenAI 兼容服务
- 调试 SDK-HMAC-SHA256 签名实现

---

## 快速开始

```powershell
cd mock-hub
node server.mjs
```

```
  网关地址   http://127.0.0.1:8787
  推理入口   http://127.0.0.1:8787/api/v2/chat/completions
  管理面板   http://127.0.0.1:8787/admin
  健康检查   http://127.0.0.1:8787/health
```

自检（44 项，覆盖全部接口 + SSE + 遥测 + 签名）：

```powershell
node tools/selftest.mjs
```

模拟一次完整 CLI 会话（按真实调用顺序和请求头，含签名与 OTLP 上报）：

```powershell
node tools/simulate-cli.mjs
```

---

## 让码道 CLI 指向这里

```powershell
.\start-codearts.ps1                  # 起网关 + 注入环境变量 + 启动 CLI
.\start-codearts.ps1 -PatchConfig     # 额外改写 ~/.codeartsdoer/codearts_cli.json
.\start-codearts.ps1 -NoLaunch        # 只起网关
```

脚本做的事：

| 手段 | 变量/字段 | 为什么需要 |
|---|---|---|
| 环境变量 | `INFERHUB_BASE_URLS` | CLI 的 `rj()` 在配置缺失时的兜底来源 |
| 环境变量 | `PLUGIN_ENV=hc` | 打开华为云通道分支 |
| 环境变量 | `IS_PROD=false` | 走非生产域名/更宽松的 TLS |
| 环境变量 | `CODEARTS_CLI_AK/SK` | 优先级**高于** GlobalConfig 的 AK/SK，让签名走本地校验 |
| 配置文件 | `codearts_cli.json` 的 8 个后端地址 | `inferhubBaseUrl` 优先级最高，IDE 重新下发 `/v1/init` 也压得住 |

改配置前会备份成 `codearts_cli.json.bak.<时间戳>`。

### ⚠️ AgentArmor 会把请求截走

CLI 里有个 `agent_defense_combined.exe`，它用 `_Un(url)` 判断是否劫持全局 `fetch`：

> 只要目标 hostname **等于** `inferhubBaseUrl` 的 hostname，就改走 `http://127.0.0.1:<proxyPort>`。

把网关指到 `127.0.0.1:8787` 后，hostname 就是 `127.0.0.1`，命中判定成立。
三种处理方式，任选：

1. **让它别启动**（最省事）：把 `bin/agentarmor` 目录删掉，或设
   `CODEAGENT_AGENTARMOR_TOOL_NAME=disabled` 让下载失败。
2. **让它当代理用**：mock-hub 兼容 absolute-form 请求行
   （`POST http://127.0.0.1:8787/api/v2/... HTTP/1.1`），所以 armor 转发过来照样能路由；
   面板里能看到请求头多了一层 armor 的痕迹。
3. **换监听地址**：`config.json` 里 `host` 改成 `0.0.0.0`，用本机内网 IP 访问，
   避开 armor 对 `127.0.0.1` 的 no_proxy 特判。

---

## 接口覆盖

| 分组 | 路径 | 说明 |
|---|---|---|
| 模型网关 | `POST /api/v2/chat/completions`、`POST /v1/chat/completions` | OpenAI 兼容，支持 SSE |
| | `POST /v1/messages` | Anthropic 兼容，`message_start`/`content_block_delta`/`message_stop` |
| | `GET /v1/models`、`POST /v1/model/thinking-variants` | 模型列表 / 思考变体 |
| agent-center | `GET /v1/agent-center/agents/useragents` | agent 列表 |
| | `GET /v1/agent-center/agents/detail?agent_id=` | **模型清单来源**（`data.gpts.models`） |
| | `GET /v1/gateway-config`、`/v1/skills-rules/list`、`/v1/agent-center/built-in-tools` | |
| | `POST /mcpService/external/skills/v1/query`、`GET .../link/v1/get` | |
| benefit | `POST /api/v1/benefit/claim`、`GET /api/v1/user/tokens/balance`、`GET /api/v1/gateway/config` | 免费权益模型注入 |
| snap-manager | `GET /snap-manager/v1/current/user`、`/privacy`、`/statistics/plugin` | |
| | `PUT /snap-manager/v1/chat-session/heartbeat` | 会话心跳 |
| | `POST /snap-manager/v1/skill/publish`、`/skill/complete`、`GET /skill/submissions` | |
| prompt-center | `GET /v1/model/builtin`、`POST /PromptCenterService/v1/prompts/retrieve` | |
| | `POST /PromptCenterService/v1/policy/feature-toggle` | 四个安全开关 |
| memory | `GET/POST /v1/:ns/preferences`、`GET/PUT/DELETE .../:id` | |
| codebase | `POST /codebaseservice/v1/codebases`、`/parsetaskmgt/api/v1/...` | |
| 遥测 | `POST /collector/v1/logs`、`/collector/v1/traces`、`/v1/logs`、`/v1/traces` | **JSON 与 protobuf 都收** |
| 其它 | `/v1/release-info/latest`、`/v1/oauth2/tokens`、`/v1/ops/credit/usage`、`/v1/skills` | |

未匹配的路径返回 404 并**记入流水**，方便你发现漏掉的接口——照 `server.mjs` 里的
`ROUTES` 加一条即可。

---

## 三种工作模式

### 1. 模拟（默认，`mode: "mock"`）

所有接口返回构造好的假数据。模型回复是**回显 + 自检说明**，能直观证明链路通了：

```
[mock-hub] 收到 model=mock-flagship messages=2 tools=0 stream=true
本条回复由 mock-hub 生成，未经过任何真实模型。
--- 你发来的最后一条 user 内容（回显）---
读一下 README.md，然后告诉我这个仓库是干什么的
--- 回显结束 ---
```

`config.json` → `reply.mode` 支持 `echo` / `fixed` / `script`。

### 2. 反代（`mode: "proxy"`）

```json
{
  "mode": "proxy",
  "upstream": {
    "baseUrl": "https://snap-access.cn-north-4.myhuaweicloud.com",
    "apiBasePath": "/api/v2",
    "ak": "",
    "sk": "",
    "authToken": "",
    "apiKey": "",
    "timeoutMs": 120000
  }
}
```

鉴权按优先级：本地 `ak/sk` 重签 → 透传客户端签名 → `authToken` → `apiKey`。
SSE 流式原样透传。`route.proxyable` 为真的接口才走上游，其余继续本地 mock。

### 3. 网关（`mode: "gateway"`）：部署在服务器当反代

上面两种模式都是「给 CLI 用」。这一种是反过来：**把码道包装成一个 OpenAI 兼容服务**，
给任何支持自定义 baseURL 的客户端用，部署在服务器上，账号池在控制台里维护。

```
客户端（ChatGPT-Next-Web / LobeChat / Cursor / 自研） 
   → http://你的服务器:8787/v1/chat/completions
      → 账号池挑一个 AK/SK，按码道协议签名、补齐字段
         → https://snap-access.<region>.myhuaweicloud.com/api/v2/chat/completions
```

入口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI 协议，支持 SSE；`Authorization: Bearer mh-xxx` |
| `POST` | `/v1/messages` | Anthropic 协议，内部转成上面的 chat |
| `GET` | `/v1/models` | 取 `gateway.models`，没配就回落到 `config.models[].model_name` |

要点：

- **默认强制鉴权**（`gateway.requireKey !== false`），Key 在控制台「API Key」页创建，
  支持模型白名单；公网部署别关。
- 账号在控制台「账号」页添加（AK/SK/SecurityToken/区域），失败自动换号重试，
  429/401/5xx 会按 `stealth.cooldown` 冷却，见 `lib/pacing.mjs`。
- 每个账号可以单独配出口代理（账号表单里的 `proxy`）：**一个账号一条固定 IP**，
  比一堆账号共享服务器 IP 稳得多。
- 容器化：`docker compose up -d --build`，数据在 `./data`。
  Linux 首次启动前先 `mkdir -p data && sudo chown -R 1000:1000 data`（镜像内是 node/uid 1000）。
- 出站请求「像不像真 CLI」这件事单独写在 **[docs/stealth.md](docs/stealth.md)**：
  头集合、头顺序、会话 id、TLS 参数、节流与冷却，以及哪些差异做不到。

### 4. 签名校验（`verifySignature: true`）

按 CLI 里的 `f4` 类逐字节实现 `SDK-HMAC-SHA256`：

```
canonicalRequest = METHOD \n canonicalURI \n canonicalQuery \n canonicalHeaders \n signedHeaders \n payloadHash
stringToSign     = "SDK-HMAC-SHA256" \n X-Sdk-Date \n sha256Hex(canonicalRequest)
Signature        = HMAC-SHA256(sk, stringToSign)
Authorization    = SDK-HMAC-SHA256 Access=<ak>, SignedHeaders=<...>, Signature=<...>
```

两个容易踩的点（本实现已处理）：

- `canonicalURI` 每段单独 encode 且**强制尾部 `/`**
- 校验时只取 `SignedHeaders` 声明过的头重算，否则 `fetch` 自动加的
  `accept` / `user-agent` / `content-length` 会把 canonicalHeaders 带偏

签名不通过返回 `401 SignatureDoesNotMatch`，并附带重算过程便于比对。

---

## 管理面板 `http://127.0.0.1:8787/admin`

| 页签 | 内容 |
|---|---|
| 概览 | 接入地址一览、接口命中分布 |
| 请求流水 | 每条请求的方法/路径/状态/耗时/模型/大小，点开看**完整请求头和 body**（凭证自动打码），可**重放** |
| 遥测 | CLI 上报的 OTLP logs/traces，protobuf 会被解析出可读文本 |
| 凭证 | 捕获到的 `x-auth-token` / `X-Security-Token` / AK / Cookie / depart，含命中次数与首末时间 |
| 模型 | 直接编辑 `data.gpts.models` 数组，热加载 |
| 配置 | 编辑整个 `config.json`，热加载 |

面板自带「自检全部路由」按钮，一键把所有接口打一遍。

### 重放请求

流水里每行右侧的 **↻** 按钮直接原样重放；点开行内详情还能：

- 看到**未脱敏**的原始请求头（重放要用真 token，展示用脱敏版）
- 在 textarea 里改 body，点「用编辑后的 body 重放」
- 结果就地显示：状态码、耗时、响应前 3KB；SSE 请求会显示块数与是否读到 `[DONE]`
- 重放产生的**新记录**会在流水里带 `重放` 标记，并可点击跳转

细节：

- 原始头与 body 只留在**内存**（最多 500 条、单条 ≤ 1MB），不落盘；超限的记录详情里会提示"可查看但无法重放"
- 重放会带上 `x-mock-replay: <原 id>`，据此标记新记录
- 重放时丢弃 `host`/`content-length`/`connection` 等逐跳头，其余原样发送，所以**签名仍然有效**——开了 `verifySignature` 也能重放（已测）

### 批量重放（压测）

流水左侧有勾选框，配合工具栏：

| 控件 | 作用 |
|---|---|
| `选中筛选结果` | 把当前过滤出来的行全部勾上（先过滤 `chat` 再全选，就是只打对话接口） |
| `清空选择` | 取消全部勾选 |
| `并发` | 1–32，同时飞出去的重放数 |
| `间隔ms` | 每条之间的间隔，0–5000，做匀速压测用 |
| `↻ 批量重放选中` | 开打 |

结果面板给出：

```
批量重放完成 · 执行 12/12 · 成功 12 · 失败 0 · 803ms · 14.94 rps
延迟 min 108ms / p50 130ms / p95 679ms / max 679ms · 并发 6 · 状态分布 {"200":12}
```

逐条列出请求 id、状态码、耗时、SSE 块数、错误说明。

API 直连：

```jsonc
POST /admin/api/replay-batch
{
  "ids": ["req-xxx", "req-yyy"],
  "concurrency": 6,      // 1–32，默认 4
  "gapMs": 0,            // 每条间隔，默认 0
  "maxSseMs": 8000,      // SSE 最多读多久
  "stopOnError": false   // 遇错中止
}
```

配合 `config.json` 的 `simulate.errorRate` 可以造故障场景，再用批量重放观察失败率。

实测并发有效性：同一批 6 条 chat，串行 575ms → 并发 8 只需 118ms（**4.9×**）。

---

## 真 CLI 接入（已跑通）

`agentkernel.exe` 26.10.9 实测可用，完整对话跑通。没有管理员权限也能接：

```powershell
node tools/egress-proxy.mjs      # 8889，拦截官方域名 → 127.0.0.1:443
```

```powershell
$env:INFERHUB_BASE_URLS = "http://127.0.0.1:8787/api/v2/"
$env:PLUGIN_ENV         = "hc"
$env:IS_PROD            = "false"
$env:HTTPS_PROXY        = "http://127.0.0.1:8889"
$env:HTTP_PROXY         = "http://127.0.0.1:8889"
$env:NO_PROXY           = "127.0.0.1,localhost"
$env:CODEARTS_CLI_AK    = "AKMOCKHUB0000000000"
$env:CODEARTS_CLI_SK    = "SKMOCKHUB0000000000000000000000000000"
```

还需要两处一次性配置：

1. `%USERPROFILE%\.codeartsdoer\cli-data\settings.json`（**必须无 BOM**）
   ```json
   {"security":{"folderTrust":{"enabled":false}}}
   ```
2. `config.json` 里 `identity.codeAgentId` = `a8bcb36232554267a5142361cc25a393`
   （CLI 硬编码的 `CODEAGENT_ID`，不匹配就拿不到模型列表）

踩坑全过程见 [docs/egress.md](docs/egress.md) §6。

### 看它发了什么

```powershell
node tools/analyze-request.mjs --dump
```

实测一次对话的请求：**46.8KB**，其中 system prompt 26.1KB、13 个工具 18.3KB。
`data/samples/<reqId>.json` 里是完整 body。

### 插件下载

CLI 会拉 ripgrep：`/codearts/codeAgentPlugin/ripgrep/<ver>/ripgrep-<ver>-<platform>.zip`

mock-hub 返回一个合法的占位 ZIP（`lib/zip.mjs` 手写，无依赖）。
要换成真包，放到 `data/plugins/ripgrep.zip` 即可，会优先使用。

---

### 工具调用

mock 支持标准 OpenAI `tool_calls` 流式增量：

- 用户消息带 `[[tool]]` → 调 `bash`
- 带 `[[tool:task]]` → 调 `task`（会起子智能体）
- 或 `config.simulate.toolCall = {name, args}` 强制指定

拿到 `role:"tool"` 结果后自动收敛成文本，不会死循环。

### 权限

`run` 子命令写死了拒绝权限请求，只有 `serve` 能走 ask→allow：

```powershell
$env:CODEARTS_SERVER_PASSWORD = 'mockhub-test'
.\agentkernel.exe serve --port 4097
node tools/serve-session.mjs "请执行 [[tool]] 自检"
```

或设 `POST /permission/bash/mode {"mode":"always_allow"}` 让 `run` 也能执行工具。

### MCP

```json
"mcp": {
  "mockhub": {
    "type": "local",
    "command": ["node", "D:/project/码道/mock-hub/tools/mcp-server.mjs"],
    "enabled": true
  }
}
```

`codearts mcp list` 显示 `✓ mockhub connected` 即可。

完整实测记录见 [docs/real-login.md](docs/real-login.md)。

---

## 控制台

启动后打开 **http://127.0.0.1:8787/**，默认密码 `admin`（首次登录后请在「设置」里改掉）。

五个页签：

| 页签 | 内容 |
|---|---|
| **网关与账号** | 网关状态、接入地址、账号池（增删启停）、API Key（生成/停用/删除） |
| **数据看板** | 今日/本周/本月/全部 KPI、模型用量、账号用量、Key 用量、请求流水 |
| **智能体配置** | 现成的 curl / 环境变量 / Claude Code 配置片段，一键复制 |
| **设置** | 面板密码（PBKDF2-SHA256 21 万轮）、默认区域、超时、强制鉴权开关 |
| **运行日志** | server.log / egress-proxy.log 在线查看 |

### 鉴权

- **面板密码** 只用于登录控制台，与 API Key 相互独立，以 PBKDF2 摘要存于 `data/settings.json`。
- **API Key** 用于 `/v1` 调用。默认 **不强制**（方便本地调试）；在「设置」里打开「强制 API Key 鉴权」后，
  所有推理请求必须带 `Authorization: Bearer <key>`。
- Key 支持**模型白名单**（`mock-*` 这类通配符），不在白名单直接 401 `model_not_allowed`。
- Key 删除后立即失效，但保留历史用量归因。

### 旧面板

`http://127.0.0.1:8787/admin` 是原来的调试面板（请求流水 / 遥测 / 凭证 / 重放），
现在也需要登录。它的 API `/admin/api/*` 保持免鉴权，供测试脚本使用。

---

## 会不会被官方检测出来
**简短回答：本地网关不告密，但 CLI 自己的遥测照发。**

遥测 URL 是硬编码常量（`collector-agents-access.cn-north-4.myhuaweicloud.com` 等），
和 `inferhubBaseUrl` 完全无关，而且导出器构造时显式传了 `url`，所以：

- `OTEL_EXPORTER_OTLP_ENDPOINT` **无效**
- `OTEL_SDK_DISABLED` **大概率无效**（只在 `NodeSDK` 里生效，CLI 是手工搭 provider）

真正有效的是网络层隔离：

```powershell
.\tools\lockdown.ps1 -WhatIf    # 预览
.\tools\lockdown.ps1            # 需要管理员：遥测+账号域名 → 127.0.0.1
.\tools\lockdown.ps1 -All       # 连网关/市场/codehub 一起堵，完全离线
.\tools\lockdown.ps1 -Revert    # 还原（只删标记块，不动其它内容）
```

光堵住看不见东西，所以还内置了**捕获入口**：hosts 把域名指到 127.0.0.1 后，
mock-hub 在 443 上用自签证书接住，CLI 想上报什么就原样落进流水。

```powershell
.\tools\make-cert.ps1           # 生成 data/certs/capture.pfx（SAN 覆盖 22 个域名）
# config.json: capture.enabled = true, capture.port = 443
node server.mjs                 # 8787 + 443 同时监听
```

被捕获的上报在流水里带紫色 `⇅ collector-agents-access` 标记，展开能看到完整来源和请求头。

完整的出站面清单、上报内容、检测信号强弱排序，见 **[docs/egress.md](docs/egress.md)**。

### 部署成反代网关时

这一节讲的是「本地拦住自己」。网关部署在服务器上时，问题变成「上游怎么看待这个客户端」，
本仓库按下面四层处理（细节见 **[docs/stealth.md](docs/stealth.md)**）：

| 层 | 做法 |
|---|---|
| 头 | 按 CLI 的 `getInferhubHcHeaders()` 同构构造 30+ 个头，顺序固定，空值有白名单 |
| 自证 | 出站不许出现 `kio` / `mock-hub` / `gateway/1.0` / `undici` / `user-agent: node`；`assertNoLeaks` 命中直接报错 |
| 会话 | `x-ot-session-id` 按账号稳定、trace/span 每请求更新，和真 CLI 一致 |
| 节奏 | 单账号并发 1、最小间隔 + 抖动、429/401/5xx 冷却 + `Retry-After`、失败换号重试 |

TLS 层面只能近似（Node OpenSSL ≠ Bun BoringSSL），这一点没打算糊弄，见 stealth 文档
「做不到的部分」。运行时自检：

```bash
curl -s http://127.0.0.1:8787/health | jq .outbound
node tools/test-stealth.mjs     # 53 项：头集合 / 签名 / 节流 / 头顺序 / CONNECT 代理
```

---

## 数据落盘
```
data/
  requests.jsonl     所有请求（含脱敏请求头、body 预览、签名校验结果）
  telemetry.jsonl    所有 OTLP 上报（json 结构化 / protobuf 提取文本）
  credentials.json   捕获的凭证
  server.log         服务日志
```

`config.json` 里 `logBodies: false` 可关掉 body 记录，`captureCredentials: false` 可关凭证捕获。

---

## 配置速查

| 字段 | 作用 |
|---|---|
| `mode` | `mock` / `proxy` / `gateway` |
| `simulate.latencyMs` | 每个请求的假延迟 |
| `simulate.streamChunkDelayMs` | SSE 每块间隔 |
| `simulate.errorRate` | 错误注入概率（0–1），配 `errorStatus` |
| `identity.*` | 假用户 / agent_id / 部门，影响 `/snap-manager/v1/current/user` 等 |
| `featureSwitches.*` | `base_enable` / `input_output_control` / `identity_security` / `permission_security` |
| `models[]` | 模型清单，字段与真实 `data.gpts.models` 一致 |
| `benefit.balance` | 余额、可领取状态 |
| `privacy.collect_data` | 影响 CLI 的 `shouldMaskData` |
| `multimodalModel` | `/v1/model/builtin` 返回的内置多模态模型 |
| `gateway.*` | 网关模式：区域地址、chat 路径、对外模型清单、`requireKey` |
| `stealth.*` | 出站画像 / 代理 / 节流 / 冷却 / TLS，见 [docs/stealth.md](docs/stealth.md) |
| `github.*` | 在线更新的仓库 / 分支 / OAuth client_id / 代理 / token |
| `update.*` | 在线更新开关、是否允许一键更新、自动检查间隔，见 [docs/update.md](docs/update.md) |
| `oauth.*` | 账号池「授权添加」：OAuth 登录 → STS 临时 AK/SK 入库，见 [docs/oauth.md](docs/oauth.md) |

环境变量覆盖：`MOCK_HUB_PORT`、`MOCK_HUB_HOST`、`MOCK_HUB_MODE`、`MOCK_HUB_UPSTREAM`、
`MOCK_HUB_CONFIG`、`MOCK_HUB_DATA`、`MOCK_HUB_LOG_LEVEL`、`MOCK_HUB_GATEWAY_REGION`、
`MOCK_HUB_EGRESS_PROXY`、`MOCK_HUB_CONCURRENCY`、`GITHUB_TOKEN`/`GH_TOKEN`、`GH_CLIENT_ID`。

---

## 在线更新

面板「维护」页：检测 GitHub 新提交 → 一键更新（下载 tarball → 语法校验 → 备份 → 换文件 → 重启生效，可回滚），
支持 GitHub 设备码登录（生成链接 + 8 位码授权）与手动 token。详见 [docs/update.md](docs/update.md)。

## 账号授权添加

账号池面板三种方式：`+ 添加账号`（手动 AK/SK）、`🔗 授权添加`（链接授权 → STS 临时 AK/SK 入库，支持
`sts`/`token`/`codearts`/`codearts-cli` 模式，其中 **`codearts` 是反编译还原的真实登录协议**：
`codearts.huaweicloud.com/portal/authorize` + PKCE + DPoP → `sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`）、
`📥 导入 auth.json`（直接贴原版 CLI 登录产物）。上游要的是 SDK 签名、SK 是静态密钥，所以只能走 OAuth → STS 拿临时凭据。
码道 OAuth 账号支持**自动续期**：`refresh_token + dpop` 在过期前换新，不用重新登录。
授权是**弹窗式**的（不自动跳转），成功即自动关闭；随后自动探测该账号的**可用模型、每模型积分、剩余积分**。
开关在面板「设置 → 账号授权添加」（勾选 + 选模式 + 保存，立即生效，不用改 config.json 也不用重启）。
详见 [docs/oauth.md](docs/oauth.md)。

---

## 目录

```
mock-hub/
├── server.mjs              路由分发、管理 API、启动
├── config.json             全部可调参数
├── Dockerfile              生产镜像（必须带 lib/）
├── docker-compose.yml      一键部署
├── .github/workflows/ci.yml  lint / 测试 / 镜像冒烟 / 443 捕获
├── lib/
│   ├── sign.mjs            SDK-HMAC-SHA256 签名与校验
│   ├── mock.mjs            各接口响应体 + SSE 流
│   ├── proxy.mjs           真实上游转发
│   ├── gateway.mjs         网关模式：协议补齐 + 签名 + 流式透传
│   ├── stealth.mjs         出站画像：头集合 / 会话 id / 泄漏自检
│   ├── transport.mjs       传输层：头顺序 / TLS 参数 / CONNECT 代理
│   ├── pacing.mjs          节流：账号并发 / 间隔抖动 / 冷却
│   ├── gh.mjs              GitHub 客户端：REST / tarball / 设备码登录
│   ├── oauth.mjs           账号池授权添加：OAuth 授权码 / 设备码 / auth.json → STS 临时凭据
│   ├── codearts-auth.mjs   码道真实登录协议（反编译还原：PKCE + DPoP + ticket）
│   ├── account-info.mjs    账号信息探测：可用模型 / 每模型积分 / 剩余积分
│   ├── cache-stats.mjs     缓存命中归一化（OpenAI/DeepSeek/Anthropic 各家字段）
│   ├── dpop.mjs            DPoP（RFC 9449）：ES256 密钥对 + 证明 JWT
│   ├── updater.mjs         在线更新：检查 / 应用 / 回滚
│   ├── tar.mjs             最小 tar.gz 读写（更新包解包/打包）
│   ├── version.mjs         版本与本地修订（build-info / .git）
│   ├── proto.mjs           OTLP protobuf 轻量解析
│   └── store.mjs           JSONL 落盘 + 环形缓冲 + 脱敏
├── public/admin.html       管理面板
├── docs/
│   ├── egress.md           出站面与检测面分析
│   ├── stealth.md          反代网关的「不像网关」清单
│   ├── update.md           在线更新与 GitHub 授权
│   └── oauth.md            账号池授权添加（OAuth → STS）
├── tools/
│   ├── selftest.mjs        44 项接口自检
│   ├── simulate-cli.mjs    完整 CLI 会话模拟
│   ├── test-proxy.mjs      反代与 absolute-form 验证
│   ├── test-replay.mjs     单条重放 14 项验证
│   ├── test-batch.mjs      批量重放 15 项验证（含并发有效性）
│   ├── test-stealth.mjs    出站指纹 / 节流 / 代理 53 项验证
│   ├── test-gateway.mjs    网关模式端到端（假上游断言签名与头）
│   ├── test-update.mjs     在线更新 / 设备码授权 32 项验证
│   ├── test-oauth.mjs      账号池授权添加 56 项验证（含 DPoP / 设备码 / auth.json）
│   ├── test-codearts-auth.mjs  码道真实登录协议 57 项验证（PKCE/DPoP/ticket/续期）
│   ├── test-account-info.mjs   账号信息探测 28 项验证（余额/模型/积分/签名）
│   ├── test-cache.mjs          缓存命中统计 40 项验证（8 种 usage 形状/比例/聚合）
│   ├── test-capture.mjs    遥测捕获 13 项验证（自签证书 / OTLP / 来源域名）
│   ├── egress-proxy.mjs    出站代理：不用管理员权限替代 hosts，拦截+捕获
│   ├── analyze-request.mjs 拆解一条请求：结构 / 工具清单 / 体积分布
│   ├── make-cert.ps1       生成捕获用自签证书
│   └── lockdown.ps1        hosts 隔离：切断官方遥测（可逆）
└── start-codearts.ps1      一键接入
```

---

## License

[MIT](LICENSE) © 2026 kiolhy (kio-code / 码道)
