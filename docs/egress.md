# 出站面与检测面：把 CLI 指向本地网关会暴露什么

> 依据：`agentkernel.exe` 的 `.bun` 段静态分析（偏移见括号），未运行官方二进制。
> 结论分三档：**已证实** / **大概率** / **未验证**。

---

## 一、先说结论

| 问题 | 答案 |
|---|---|
| mock-hub 会往外发数据吗？ | **不会**。`mode: "mock"` 下零出站；只有 `proxyToUpstream()` 会出站，且仅在 `mode: "proxy"` 时调用 |
| 把 `inferhubBaseUrl` 指向本地，能顺带关掉官方遥测吗？ | **不能**。遥测 URL 是硬编码常量，和 `inferhubBaseUrl` 完全无关 |
| 用 `OTEL_EXPORTER_OTLP_ENDPOINT` 重定向遥测？ | **无效**（已证实）。导出器构造时显式传了 `url`，标准环境变量被忽略 |
| 用 `OTEL_SDK_DISABLED=true` 关掉遥测？ | **大概率无效**（见 §3.2）。这个开关只在 `NodeSDK` 类里生效，而 CLI 是手工组装 provider |
| 官方能检测出来吗？ | **能，但不是靠"特征"，是靠行为不一致** —— 账号在活动、服务端零计费 |

一句话：**本地网关不告密，但 CLI 自己的遥测照发。**

---

## 二、遥测是独立通道，不跟着网关走

`otelLogUrls` / `otelTraceUrls`（偏移 ≈15.69M）：

```
development                http://127.0.0.1:4318/v1/{logs,traces}
test                       https://mammoth.opentelemetry.endpoint.gamma.tools.huawei.com/v1/{logs,traces}
production                 https://mammoth.opentelemetry.endpoint.tools.huawei.com/v1/{logs,traces}
hc_development             http://127.0.0.1:4318/v1/{logs,traces}
hc_test                    https://beta-collector-agents-apig.cn-north-7.ulanqab.huawei.com:443/collector/v1/{logs,traces}
hc_production              https://collector-agents-access.cn-north-4.myhuaweicloud.com/collector/v1/{logs,traces}
hc_international_test      https://beta-hk-collector-agents-apig.cn-north-7.ulanqab.huawei.com/collector/v1/{logs,traces}
hc_international_production https://collector-agents-access.ap-southeast-1.myhuaweicloud.com/collector/v1/{logs,traces}
```

关键代码（偏移 ≈15.54M）：

```js
function tA0(Z){ return Object.fromEntries(Object.keys(Z).map(Q => [Q, {url: Z[Q]}])) }
var mZ = tA0(YO.telemetry.otelLogUrls);
var lZ = tA0(YO.telemetry.otelTraceUrls);
...
return new HL0.OTLPLogExporter({ url: k, headers: { "X-Auth-Token": q, "app-id": cZ, "x-snap-traceid": H7() } })
```

`url` 是构造参数，OTLP 导出器只有在**没有** `url` 时才去读 `OTEL_EXPORTER_OTLP_ENDPOINT`。
所以重定向环境变量这条路是死的。

遥测还带 `X-Auth-Token` —— 服务端能把每条上报**归因到具体账号**。

### hc_production 下还走系统代理

偏移 ≈15.52M：

```js
let F = async () => {
  if (XL0() !== "hc_production") return "";
  let k = await pA0();                       // 读注册表 HKCU\...\Internet Settings
  b4.info(`getLatestProxyUrl latest proxy checked: ${k}`);   // ProxyEnable + ProxyServer
  return k;
}
```

即：企业代理的访问日志里也会有这些上报。

---

## 三、上报的具体内容

### 3.1 AI SDK span（偏移 ≈19.25M）

```js
u6({ name:"ai.streamText.doStream", attributes: {
  "ai.model.provider": _1.provider,
  "ai.model.id": _1.modelId,
  "ai.prompt.messages": { input: () => KJ(F5) },      // ← 完整 prompt
  "ai.prompt.tools":    { input: () => W8?.map(n => JSON.stringify(n)) },
  "gen_ai.system": _1.provider,
  "gen_ai.request.model": _1.modelId,
  "gen_ai.request.max_tokens": ..., "temperature": ..., "top_p": ...,
}})
```

自定义 span 类型（偏移 ≈15.69M）：`Session` / `Agent Span` / `Tool Span` / `Inference Span` /
`Turn Span` / `Approval Span` / `Session Error Span`，service name 默认 `CodeAgent3.0`。

**这意味着**：你发给本地 mock 的 prompt、模型 id（`mock-flagship`）、工具定义，都会原样上报到官方 collector。

### 3.2 本地地址会不会被上报？——**实测：不会**

早期静态分析推测"大概率不会"，**已用真 CLI 验证**（`agentkernel.exe` 26.10.9，一次完整对话，捕获 12 条遥测共 45KB）：

```
真捕获内容里的敏感项
无   127.0.0.1            0 次
无   localhost            0 次
无   http.url             0 次
无   server.address       0 次
命中 mock-                10 次     ← 假模型名
命中 ai.model.id          4 次
命中 CodeAgent3.0         26 次     ← service.name
```

原因也验证了：没有注册 `getNodeAutoInstrumentations`，HTTP 自动埋点没开，
`http.url` / `server.address` 这些属性虽然在包里（偏移 ≈14.18M / 14.22M），但不会被填。

**但是**：`model_id` 会原样上报，而且 span 名字里直接带模型名。

### 3.3 实测：真实上报长什么样

一次 `codearts run "1+1=?"` 产生的 span/log 名称：

```
Kernel-Session            Kernel-Turn Span         Kernel-Agent Span
Kernel-Inference Span     Kernel-AgentTeam Span    agent_start / agent_finish
codeagent.user_prompt     codeagent.config         codeagent.model_list_config
chat compression          memory.call              cron
API request to mock-thinking.        ← span 名字里直接写了假模型名
```

`API request to mock-thinking.` 这个 span 的全部属性：

```json
{
  "event.name": "api_request",
  "session_id": "ses_e7e9a7aabffeq19GXeobiErJGK",
  "model_id": "mock-thinking",          ← 假模型，一眼看穿
  "request_text": "*********",          ← 用户 prompt 被脱敏成星号
  "message_id": "msg_181658d56001QoowkMP28asz3N",
  "inference_id": "ffede8bd...ffb5e30#1",
  "x_snap_trace_id": "ffede8bd...66175ecf654048ba",
  "domainId": "00000000-0000-0000-0000-0000000000ff",
  "user.id": "00000000-0000-0000-0000-000000000001",
  "git.repo": "", "git.branch": "", "git.base_commit": "",
  "is_human_request": "true",
  "prompt_id": "b679bacbbae542c88b7dc78f943863ee"
}
```

全部属性键（实测）：

```
agent_id  agent_name  available_skills  available_tools  domainId
duration_ms  error_count  event.*  execution.*  finish_reason
git.base_commit  git.branch  git.repo  inference_id  is_human_request
message_id  model  model_id  parent.session.id  process.domain  process.owner
prompt_id  reasoning_effort  request_receiver_domain  request_text
service.function  session.id  session_count  session_id  terminate_reason
turn_count  user.id  x_snap_trace_id
```

**结论修正**：

| 项 | 实测结果 |
|---|---|
| 本地地址（127.0.0.1） | ✅ 不上报 |
| 用户 prompt 原文 | ✅ 被脱敏成 `*********` |
| 假模型名 `mock-thinking` | 🔴 **上报，而且写在 span 名字里** |
| 账号 domainId / user.id | 🔴 上报（这是本来就有的行为） |
| git 仓库 / 分支 / commit | 🔴 上报（本地仓库信息） |
| 可用工具 / 技能清单 | 🔴 上报 |

### 3.3 `OTEL_SDK_DISABLED` 为什么大概率无效

全库只有 2 处读这个变量，都在 `@opentelemetry/sdk-node` 内部：

- `class sV0 { constructor(Z={}) { if (getBooleanFromEnv("OTEL_SDK_DISABLED")) this._disabled = !0; ... } }`（≈15.41M）
- `class bN0 { this._config.disabled = getBooleanFromEnv("OTEL_SDK_DISABLED") }`（≈15.45M）

而 CLI 的遥测是手工搭的：

```js
new s3.BatchLogRecordProcessor(H, { scheduledDelayMillis:5000, maxExportBatchSize:30, ... })
new r3.BatchSpanProcessor(...)
```

没有 `new NodeSDK(...)`。`@opentelemetry/api` 里也没有 `isDisabled()` 检查（该变量只出现在 sdk-node 两处）。
所以这个开关大概率不会拦住任何东西 —— **别指望它**。

---

## 四、官方能看到的检测信号（按强度排序）

### ① 行为不一致（最强，且不需要任何"特征"）

服务端视角：

| 维度 | 正常用户 | 指向本地网关后 |
|---|---|---|
| 模型调用 / 计费 | 有记录 | **0** |
| 心跳 `chat-session/heartbeat` | 有 | 有（若域名没改） |
| 遥测 traces | 有，含真实模型 id | 有，含 `mock-flagship` |
| feature-toggle 轮询 | 有 | 有（若域名没改） |

一个账号天天在线、天天上报 span，但计费侧一条调用都没有 —— 这是最直接的信号，纯统计就能发现。

### ② 遥测里的模型 id 和 prompt

`ai.model.id = "mock-flagship"`、`gen_ai.request.model = "mock-lightweight"`，
配上 prompt 内容与实际模型能力不匹配（本地是回显），一眼可疑。

### ③ 认证头对不上

遥测带 `X-Auth-Token`，但同一 token 在网关侧没有任何调用记录。

### ④ 错误日志里的本地地址

见 §3.2，属于偶发但确实存在。

### ⑤ AgentArmor 的上报（未验证）

`agent_defense_combined.exe` 是官方下发的安全组件，我们只做了宿主侧的静态分析，
它自身会上报什么**没有验证**。如果它在运行，并且观察到"所有模型流量都指向 127.0.0.1"，
那是它自己的判断，我们控制不了。**这是最大的未知项。**

---

## 五、止血：按有效性排序

### 1. 网络层黑洞（最确定，推荐）

```powershell
.\tools\lockdown.ps1            # 备份 hosts 并把出站域名指到 127.0.0.1
.\tools\lockdown.ps1 -Revert    # 还原
```

hosts 指向 `127.0.0.1` 后连接被拒，上报静默丢失，不依赖任何代码开关。
CLI 侧表现为"遥测上报失败"日志，不影响本地对话。

### 2. 进程层：别让 AgentArmor 跑起来

```powershell
Remove-Item "$env:USERPROFILE\.codeartsdoer\bin\agentarmor" -Recurse -Force
```

或设 `CODEAGENT_AGENTARMOR_TOOL_NAME=disabled` 让它的下载失败。
这同时解决两件事：不截走你的 fetch，也不让它上报。

### 3. 代理层

`Zj()` 的优先级是 `GlobalConfig.proxy` > 环境变量 > 系统代理。设一个黑洞代理：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:9"   # 9 端口没人听，快速失败
$env:NO_PROXY    = "localhost,127.0.0.1"
```

### 4. 内容层：让上报内容不刺眼

改 `mock-hub/config.json`：

- `models[].model_parameters.model_id` 换成真实模型名（`DeepSeek-V3.2` 之类）
- `reply.mode` 改成 `fixed`，内容写得像正常模型输出
- `identity.department` 等字段和真实账号一致

这样即使漏出去几条 span，也不至于一眼看出是假的。

### 5. 账号层

用小号 / 试用账号，不要用主账号或企业账号。这是唯一能兜住"未知上报"的手段。

### 6. 最彻底：全离线

把所有后端域名都指向本地（`lockdown.ps1 -All`），CLI 变成完全离线。
代价：模型清单、技能市场、codehub 全部不可用 —— 但 mock-hub 已经把这些都模拟了。

---

## 六、真 CLI 接入实录（已跑通）

环境：`agentkernel.exe` 26.10.9（从安装包提取，未重新下载），Windows，无需管理员。

### 6.1 用代理替代 hosts

没有管理员权限就改不了 hosts，所以改用**出站代理**：`tools/egress-proxy.mjs`

```powershell
node tools/egress-proxy.mjs     # 监听 8889
```

它做的事和 hosts 一样，但不用提权，而且能捕获：

- CONNECT 目标在拦截清单里 → 隧道转发到 `127.0.0.1:443`（mock-hub 的捕获入口）
- 其余一律 403，只记录不转发

CLI 侧：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:8889"
$env:HTTP_PROXY  = "http://127.0.0.1:8889"
$env:NO_PROXY    = "127.0.0.1,localhost"
```

日志在 `data/egress.log`，每次连接一行。

### 6.2 跑通真 CLI 需要补的四件事

按踩坑顺序：

| # | 现象 | 根因 | 解法 |
|---|---|---|---|
| 1 | `文件夹未被信任: <path>` | `<KERNEL_DATA_DIR>\settings.json` 里 `security.folderTrust` | 写 `{"security":{"folderTrust":{"enabled":false}}}` |
| 1b | 同上，且日志报 `failed to read settings.json` | PowerShell `Set-Content -Encoding UTF8` 带 **BOM**，Bun 的 `JSON.parse` 拒绝 | 用 `[IO.File]::WriteAllText(path, json, UTF8Encoding($false))` |
| 2 | `Create session failed` 404 | 缺 `POST /v1/sessions` | 已补，返回 `{data:{session_id,status:0}}` |
| 2b | 会话会被强制登出 | 缺 `GET /v1/sessions`，`data.sessions[0].status !== 0` 就登出 | 已补，返回 `status: 0` |
| 3 | `CODEAGENT_ID set but no matching agent found` | `CODEAGENT_ID` 是**硬编码常量** `a8bcb36232554267a5142361cc25a393`（偏移 ≈21.86M），匹配逻辑是 `agent.original_id === CODEAGENT_ID` | `config.identity.codeAgentId` 改成这个值 |
| 4 | `模型列表获取失败，请刷新重试` | 上一步拿不到 agent → 没有 agent_id → 不拉模型 → 缓存也没有 | 同 #3 |

### 6.3 跑通后的实测结果

```
POST  /v1/sessions                     200   132B
GET   /v1/agent-center/agents/useragents 200
GET   /v1/agent-center/agents/detail   200
POST  /v1/model/thinking-variants      200    85B
PUT   /snap-manager/v1/chat-session/heartbeat 200
POST  /api/v2/chat/completions         200  47862B   ← 13 个工具
POST  /collector/v1/logs               200  28582B   ← 真遥测
POST  /collector/v1/traces             200  26717B   ← 真遥测
```

全部经由 `snap-access.cn-north-4.myhuaweicloud.com` / `collector-agents-access.cn-north-4.myhuaweicloud.com`
这两个域名，也就是**被 443 捕获入口接住的**。

CLI 的 TUI 正常渲染出了 mock 回复，模型显示为 `mock-thinking`。

### 6.4 还有一个小缺口

CLI 会去下 `ripgrep-14.1.1-x86_64-pc-windows-msvc.zip`：

```
GET /codearts/codeAgentPlugin/ripgrep/14.1.1/...zip → 404
```

不影响对话（它降级继续了），但要在 mock 里彻底消掉这条 404，
需要在 `ROUTES` 里加一条 `/codearts/codeAgentPlugin/` 的下载路由。

---

## 七、真要隐身时的优先级

基于实测，按有效性重排：

1. **`config.json` 里把模型名改成真的**（`DeepSeek-V3.2` 之类）—— 这是唯一会直接暴露的信号，而且写在 span 名字里
2. **代理/hosts 隔离** —— 切断上报通道
3. **别让 AgentArmor 跑** —— 官方二进制，行为未知
4. **用小号** —— 兜住未知上报
5. `OTEL_SDK_DISABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT` —— 实测无效，别指望
