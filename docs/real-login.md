# 真实登录实测记录

环境：`agentkernel.exe` 26.10.9，Windows，真实华为云账号登录。

---

## 一、登录与凭据

### 登录必须关代理

登录走 `https://codearts.huaweicloud.com/portal/settings/cli-auth`，是**真实服务**。
开着拦截代理会直接登不进去。

```powershell
.\tools\login-real.ps1
```

脚本清掉 `HTTPS_PROXY` / `HTTP_PROXY` / `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` / `INFERHUB_BASE_URLS`，
其余环境和官方 `codearts.cmd` 一致。

### 凭据落在哪

`%USERPROFILE%\.codeartsdoer\cli-data\auth.json`（约 2.8KB）：

```
inferhub-provider.type          "oauth"
inferhub-provider.access        {"access_key_id":"HSTA…","secret_access_key":"…",
                                 "security_token":"…(572 字符)","dpop_key_pair":{…}}
inferhub-provider.refresh       JWT
inferhub-provider.expires       毫秒时间戳
inferhub-provider.accountId     {"domain_id":"…","domain_name":"…","user_id":"…"}
inferhub-provider.enterpriseUrl "prod"
```

是 **STS 临时凭据**（`HSTA` 前缀 + 572 字符 security_token），不是永久 AK/SK。

### `run` 子命令不认 OAuth

```
• 认证失败，没有设置环境变量CODEARTS_CLI_AK/CODEARTS_CLI_SK
```

`run` 只认 AK/SK。但登录拿到的 STS 三元组正好对应另一组环境变量：

```powershell
$env:HW_ACCESS_KEY     = $access.access_key_id
$env:HW_SECRET_KEY     = $access.secret_access_key
$env:HW_SECURITY_TOKEN = $access.security_token
```

`tools/run-via-mock.ps1` 会自动从 `auth.json` 读这三项，并检查是否过期。

---

## 二、真凭据下 CLI 请求了什么

一次 `run` 对话（15 条请求）：

```
GET   /snap-manager/v1/current/user              200
POST  /v1/sessions                               200   132B
GET   /v1/agent-center/agents/useragents         200
GET   /v1/agent-center/agents/detail             200
POST  /v1/model/thinking-variants                200    85B
PUT   /snap-manager/v1/chat-session/heartbeat    200
GET   /snap-manager/v1/privacy                   200
POST  /api/v2/chat/completions                   200  47922B
POST  /collector/v1/logs                         200  64650B
POST  /collector/v1/traces                       200  38201B
…
```

**零未覆盖接口。** 出站只碰 3 个域名，全部被接住：

```
20x  snap-access.cn-north-4.myhuaweicloud.com              → capture
 9x  collector-agents-access.cn-north-4.myhuaweicloud.com  → capture
 3x  cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com → capture
```

没有隐藏域名。

---

## 三、子命令全扫

`tools/sweep-cli.ps1` 跑了 15 个子命令，全部正常，**零缺口**：

```
models / models --verbose / stats / session list / agent list / memory / experience
codebase status / codebase-local / lsp-toggle / privacy / debug paths / export
upgrade --check / mcp list
```

`export` 会挂住（导出最新会话，需要交互），其余都返回。

---

## 四、工具执行：真正的坑

### `run` 模式写死了自动拒绝

反编译 `chunk-3jxnztqq.js`：

```js
if (m.type === "permission.asked") {
  let p = m.properties;
  z.println("!", `permission requested: ${p.permission} (${p.patterns.join(", ")}); auto-rejecting`);
  await t.permission.reply({ requestID: p.id, reply: "reject" });   // ← 写死
}
```

不管 `codearts_cli.json` 里怎么写 `permission`，`run` 一律拒绝。

### 解法：用 serve 的服务端权限接口

`agentkernel.exe serve` 需要 `CODEARTS_SERVER_PASSWORD`：

```powershell
$env:CODEARTS_SERVER_PASSWORD = 'mockhub-test'
.\agentkernel.exe serve --port 4097 --hostname 127.0.0.1
```

然后：

```powershell
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('codearts:mockhub-test'))
Invoke-RestMethod 'http://127.0.0.1:4097/permission/bash/mode' -Method Post `
  -Headers @{Authorization="Basic $b64"; 'content-type'='application/json'} `
  -Body '{"mode":"always_allow"}'
```

设成 `always_allow` 后，服务端直接放行，**不产生 `permission.asked` 事件**，
`run` 就能真正执行工具了：

```
$ echo mock-tool-ok
mock-tool-ok
```

`/permission/bash/mode` 三个取值：`always_allow` / `always_ask` / `sandbox`。

### 完整两轮链路

mock 支持 `[[tool]]` 标记后，一次干净循环：

```
第1轮  messages=2   → mock 返回 tool_call(bash)
        CLI 执行 bash → 输出 mock-tool-ok
第2轮  messages=4   → mock 返回文本答复 → 结束
```

第 2 轮的 4 条消息：`system` / `user` / `assistant(tool_calls)` / `tool(结果)`。

### 死循环保护

如果 mock 每轮都返回 tool_call，CLI 会：

```
第2轮 messages=4   assistant + tool("The user rejected permission…")
第3轮 messages=6   …再一轮 + tool 里追加 <system-reminder>
第4轮 messages=9   …第三条 + user("CRITICAL - DOOM LOOP DETECTED\n\nA doom loop has…")
```

**3 次失败后注入 doom-loop 拦截消息**，是 user 角色。

所以 mock 里加了收敛逻辑：`messages` 里出现 `role:"tool"` 就返回文本，不再调用。

---

## 五、serve 暴露的私有接口

`GET /doc`（Basic 认证）返回 137KB OpenAPI，36 个路径。除了通用的会话接口，还有一堆
mock-hub 没实现的私有接口：

```
/cag/evolve/daemon/config      /cag/instance/reload        /cag/om/dump
/cag/rules                     /cag/rules/offline          /cag/system/idle-shutdown
/cag/widget/config
/im/welink/list                /im/welink/start            /im/welink/status/{ideType}
/im/welink/stop
/comm/create
/permission/bash/mode          /permission/global          /permission/global/{permission}
/sandbox/network-policy
/whitelist/global/white-list
/skillRule                     /v1/skill                   /v1/skills
/v1/skills/detail              /v1/skills/sync             /v1/builtin-tools
/v1/mcp-tools                  /v1/auth/hash               /v1/init
/v1/config
/config/skills/{skill_name}/status
/global/config                 /global/event               /global/health
/global/sync-event             /global/upgrade             /global/dispose
/log                           /auth/{providerID}
```

这些是 **serve 服务端自己提供的**，不是 CLI 客户端去调的，所以 `find-gaps` 看不到。
要模拟完整服务端，这些才是剩下的工作量。

---

## 六、第二轮补齐：工具调用 / 多智能体 / MCP / codebase

### 6.1 工具调用流

mock 现在支持标准 OpenAI `tool_calls` 流式增量。触发方式：

- 用户消息里带 `[[tool]]` → 调用 `bash`
- 带 `[[tool:task]]` → 调用 `task`
- 或 `config.simulate.toolCall = {name, args}` 强制指定

流结构（实测 9 块 / 7 块带 tool_calls）：

```
delta.tool_calls[{index:0, id:"call_…", type:"function", function:{name:"bash", arguments:""}}]
delta.tool_calls[{index:0, function:{arguments:"{\"command\":"}}]     ← 参数分片
…
finish_reason: "tool_calls"
```

**收敛规则**：`messages` 里已经出现 `role:"tool"` 就不再返回 tool_call，改回文本。
否则 CLI 会一直重复调用，3 次后注入 `CRITICAL - DOOM LOOP DETECTED`。

### 6.2 权限三态

| 模式 | 设置方式 | 行为 |
|---|---|---|
| `always_allow` | `POST /permission/bash/mode` | 不产生 `permission.asked`，直接执行 |
| `always_ask` | 同上 | 产生 `permission.asked`，等客户端 `POST /permission/{id}/reply` |
| `sandbox` | 同上 | 沙箱内执行 |

`run` 子命令**写死了 reject**，只有 `serve` 能走 ask→allow 交互流。

实测 ask 流：

```
[权限请求] bash  模式=echo mock-tool-ok  id=per_181a258630017NyL9WaBEoJ2kg
[权限回复] once
→ 工具执行 → messages=4 → 文本答复
```

### 6.3 serve 驱动脚本

`tools/serve-session.mjs` 用 serve 的 HTTP API 跑完整会话：

```powershell
$env:CODEARTS_SERVER_PASSWORD = 'mockhub-test'
.\agentkernel.exe serve --port 4097
node tools/serve-session.mjs "请执行 [[tool]] 自检"
```

认证是 Basic `codearts:<password>`。

### 6.4 多智能体（agent-team）

`task` 工具触发后，CLI 会起一个子会话，**请求特征完全不同**：

| | 父会话 | 子智能体（explore） |
|---|---|---|
| 请求体 | 50609B | 11839B |
| system prompt | 26690 字 | 2336 字 |
| 工具数 | 14 | **5**（bash/read/glob/grep/task） |
| system 开头 | `You are CodeArts, a dedicated code agent…` | `You are a file search specialist…` |

会话序列：父请求 → 子请求 → 父的 follow-up（带 `role:"tool"` 结果）。

### 6.5 MCP

配 `codearts_cli.json`：

```json
"mcp": {
  "mockhub": {
    "type": "local",
    "command": ["node", "D:/project/码道/mock-hub/tools/mcp-server.mjs"],
    "enabled": true
  }
}
```

验证：

```
codearts mcp list
✓ mockhub connected
```

MCP 工具是**延迟加载**的，不出现在那 14 个里，要通过 `tool_search` / `tool_call` 访问。
`tools/mcp-server.mjs` 是一个最小 stdio MCP 服务器（`mock_echo` / `mock_time`）。

### 6.6 codebase 接口

补齐 9 个（响应是 `{status:'ok', httpStatusCode, result}`，不是 `{code,data}`）：

```
GET  /codebaseservice/v1/codebases                          → 索引列表（result 是数组）
POST /codebaseservice/v1/codebases                          → 创建索引任务（result 是对象）
GET  /codebaseservice/v1/codebases/{id}/tasks/{tid}/progress → 任务进度
GET  /codebaseservice/v1/codebases/{id}/tasks/{tid}/files    → 已索引文件
POST /codebaseservice/v1/codebases/{id}/tasks/{tid}/index    → 文件分片上传
POST /codebaseservice/v1/codebases/{id}/codenodes/search     → 语义检索
POST /codebaseservice/v1/codebases/{id}/graph/search         → 调用链
POST /codebaseservice/v1/codebases/vector/embedding          → 向量
POST /codebaseservice/v1/codebases/vector/rerank             → 重排
```

**契约要点**（踩了三次才摸清）：

| 端点 | 关键约束 |
|---|---|
| `GET /codebases` | `result` 必须是**数组**，元素含 `codebaseId` / `branch` / `isIndexed` |
| `POST /codebases` | `result` 必须是**对象**，含 `codebase_id` 和 `task_id`（拿不到就 `failed to executeIndex`） |
| `.../tasks/{tid}/progress` | `status` 小写等于 `ok`；`result` 必须同时有 `files`（数组）、`finished_count`、`task_status` |
| `.../tasks/{tid}/files` | 必须带 `status` 和 `total` |

`codebase --init` 现在完整跑通：

```
代码库索引开始创建...
代码库索引创建完成
```

16 条请求：`create` 2 次、`uploadIndex` 7 次（分片上传）、`taskProgress` 4 次（轮询）、`list` 2 次。

**`--detail` 仍显示"未创建索引"**：它依赖 CLI 进程内的 `fileStatusManager` 状态，
不是后端契约问题。`--init` 成功即说明后端契约已经对了。

### 6.7 experience hook（意外发现）

`codearts experience --use` 开启后，CLI 会在**用户消息前面注入检索到的经验**：

```
[经验检索上下文]
以下内容由经验库 hook 自动检索并注入，请先吸收后再继续当前主任务。
经验库根目录：`.codeartsdoer/experience-reuse/experiences`
```

这会让请求体从 47922B 涨到 50609B。是本地 hook，不走网络。

---

## 七、还没覆盖

| 项 | 状态 |
|---|---|
| 端点（run + 15 子命令） | ✅ 零缺口 |
| 出站域名 | ✅ 3 个，全部接住 |
| 工具执行（bash） | ✅ 已打通 |
| 多轮对话 / 死循环保护 | ✅ 已观测 |
| 权限三态 | ✅ always_allow / always_ask 都测了 |
| agent-team 多智能体 | ✅ 父子请求特征已采集 |
| MCP | ✅ 已连接 |
| codebase 9 个接口 | ✅ 已实现并测试 |
| codebase `--init` 建索引 | ✅ 已跑通（上传 7 次分片 + 轮询 4 次） |
| codebase `--detail` | ⚠️ 显示"未创建索引"，依赖 CLI 内部 fileStatusManager，非后端契约 |
| `sandbox` 权限模式 | ❌ 未测 |
| `analyzeImage` / D2C-Agent | ❌ 工具默认 disabled，触发不了 |
| `serve` 的 36 个私有接口 | ❌ 那是 CLI 自己的服务端，不是后端，mock 不需要实现 |
| TUI 交互路径 | ❌ 无 TTY，但 serve 覆盖了同等能力 |

---

## 八、复现命令

```powershell
# 1. 真实登录（关代理）
.\tools\login-real.ps1

# 2. 起拦截代理 + 网关
node tools\egress-proxy.mjs
node server.mjs

# 3. 用真凭据跑，看缺什么
.\tools\run-via-mock.ps1 -Prompt '列出当前目录的文件'
node tools\find-gaps.mjs

# 4. 扫全部子命令
.\tools\sweep-cli.ps1

# 5. 触发工具调用（需要 serve 放行权限）
$env:CODEARTS_SERVER_PASSWORD = 'mockhub-test'
.\agentkernel.exe serve --port 4097
# 另开窗口设 always_allow，然后
.\tools\run-via-mock.ps1 -Prompt '请执行 [[tool]] 自检'

# 6. 看它发了什么
node tools\analyze-request.mjs --dump
```
