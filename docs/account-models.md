# 账号信息与模型目录

> 本文档的端点、请求头、响应结构全部来自 **2026-10-29 真实请求实测**，不是推测。

## 一、真实端点与鉴权

### 鉴权：SDK-HMAC-SHA256 + `X-Security-Token`

```
Authorization: SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=..., Signature=...
X-Security-Token: <STS security_token，572 字符，hQpjbi1... 开头>
app-id: CodeAgent3.0
```

**实测结论**：`x-auth-token` 走不通。`security_token` 不是 IAM token，塞进 `x-auth-token` 会得到：

```
401 {"error_msg":"Incorrect IAM authentication information: decrypt token fail","error_code":"APIG.0301"}
```

而 `SDK-HMAC-SHA256 + X-Security-Token` 能直接进业务层（`current/user` 返回 200 真实数据）。

### 端点归属（实测）

| 域名 | 可用路径 | 不可用 |
|---|---|---|
| `snap-access.cn-north-4.myhuaweicloud.com` | `/snap-manager/v1/current/user`、`/v1/agent-center/agents/useragents`、`/v1/agent-center/agents/detail` | `/api/v1/user/tokens/balance` → `APIG.0101` |
| `opengw.developer.huaweicloud.com` | `/api/v1/user/tokens/balance`、`/api/v1/gateway/config`、`/api/v1/benefit/claim` | `/v1/agent-center/*` → `APIG.0101` |

### 必需请求头（少一个就报错）

| 端点 | 额外头 | 缺了会怎样 |
|---|---|---|
| `/v1/agent-center/agents/useragents` | `Agent-Type: AgentCenter` | `400 TM.00001001 请求头Agent-Type为空` |
| 同上 | `X-Language: zh-cn` | `400 HDN.1005 Request-header: X-Language is validate failed` |

## 二、真实响应结构

### `GET /snap-manager/v1/current/user`

```json
{ "domain_id": "01a1…", "domain_name": "hid_…", "user_id": "01a1…", "user_name": "hid_…", "app_types": null, "user_type": null }
```

### `GET /v1/agent-center/agents/useragents?offset=0&limit=100`

```json
{ "total": 17, "agents": [ { "agent_id": "9f0e5cb6…", "agent_name": "CodeAgent", "is_primary_agent": true, "agent_type": "openapi" } ] }
```

注意 `total` 才是总数，`agents` 只是当前页 —— 代码用 `total` 作为「智能体数」。

### `GET /v1/agent-center/agents/detail?agent_id=<id>`

模型在 **`gpts.models`**（不是 `data.gpts.models`）：

```jsonc
{
  "agent_id": "9f0e5cb6…",
  "gpts": {
    "models": [{
      "model_name": "GLM-5.2",        // ← 模型 id
      "model_alias": "GLM-5.2",       // ← API 调用用的别名
      "model_type": "admin",
      "model_parameters": {
        "max_tokens": 65536,
        "context_window": 202752,
        "enable_queue": true,
        "supports_prompt_cache": true,
        "usage_limit": 0,
        "channel_source": "codearts"
      },
      "credit": [{                    // ← 价格阶梯（数组）
        "input_from": 0, "input_to": -1,
        "output_from": 0, "output_to": -1,
        "input_price": "8", "cache_price": "2", "output_price": "28"
      }]
    }]
  }
}
```

- `input_to: -1` 表示无上限
- 价格是**字符串**，要转数字
- 多档阶梯示例：`OpenPangu-2.0-Pro` 有 `[0..32000] 入3.2/缓存0.8/出14.5` 和 `[32001..-1] 入4.8/缓存1.2/出17.6`
- 首档价作为「标准价」，完整阶梯保留在 `tiers`

### 实测拿到的 8 个模型（2026-10-29）

| 模型 | 上下文 | 最大输出 | 入 / 缓存 / 出 |
|---|---|---|---|
| GLM-5.2 | 202,752 | 65,536 | 8 / 2 / 28 |
| GLM-5.2-ArkTS-SPARK | 202,752 | 65,535 | 8 / 2 / 28 |
| OpenPangu-2.0-Pro | 524,288 | 65,535 | 3.2 / 0.8 / 14.5（≤32k）；4.8 / 1.2 / 17.6（>32k） |
| OpenPangu-2.0-Flash | 524,288 | 65,535 | 0.8 / 0.2 / 1.6 |
| GLM-5.3 | 1,048,576 | 65,536 | 8 / 2 / 28 |
| DeepSeek-V4.1-Flash | 1,048,576 | 65,536 | 2 / 0.2 / 8 |
| Kimi-K3 | 1,048,576 | 65,536 | 20 / 2 / 100 |
| DeepSeek-V4.1-Flash-1017 | 1,048,576 | 65,536 | 2 / 0.2 / 8 |

全部 `supports_prompt_cache: true`、`enable_queue: true`。

## 三、余额与免费权益

`/api/v1/user/tokens/balance` 和 `/api/v1/gateway/config` 签名能过，但**账号没有 benefit 套餐时**返回：

```json
{"error_code":"4000","error_msg":"invalid channel, group not found","result":null}
```

这是**业务状态**（账号没开通免费权益），不是鉴权失败。代码把它单独记为「业务拒绝」，不当成错误。

有 benefit 套餐的账号会正常返回余额，届时 `balance` / `balanceTotal` 自动填充。

## 四、跨账号模型目录

`GET /panel/api/models`：

```jsonc
{
  "models": [{
    "id": "GLM-5.2", "alias": "GLM-5.2",
    "price": { "input": 8, "cache": 2, "output": 28 },
    "tiers": [{ "inputFrom": 0, "inputTo": -1, "input": 3.2, "cache": 0.8, "output": 14.5 }],
    "contextWindow": 202752, "maxTokens": 65536,
    "promptCache": true, "queue": true,
    "accounts": ["acc1", "acc2"]
  }],
  "accounts": [{ "id": "…", "name": "acc1", "modelCount": 8, "agentCount": 17,
                 "balanceTotal": null, "checkedAt": "…", "user": { "userName": "hid_…" } }]
}
```

合并规则（`lib/model-catalog.mjs`）：

- 同一 `id` 的**价格取更低的那份**（对用户有利）
- `tiers` 取档数更完整的
- 能力标记（`queue` / `promptCache`）取并集
- 按首档 input 价升序

`POST /panel/api/models/refresh` 并发探测所有启用账号（并发 4）。

## 五、真实请求自检工具

```bash
npm run probe:upstream                        # 不带凭据，看端点是否存在（401=存在，APIG.0101=不存在）
node tools/probe-upstream.mjs --account acc1  # 用账号池里的真实凭据签名请求
node tools/probe-upstream.mjs --raw           # 打印完整响应体
node tools/probe-upstream.mjs --base https://xxx
```

每个结果都是一次真实 HTTPS 请求，带 `request-id`，没有任何模拟数据。

## 六、面板

- **账号池**：账号名下方 chips —— `积分` / `模型 n` / `缓存 x%`
- **信息弹窗**：宽 920px，内容区独立滚动；分区 KPI（模型 / 智能体 / 剩余积分）→ 账号身份 → 模型价格表 → 余额 → 数据来源 → 原始响应 → 失败尝试
- **「模型」菜单**：跨账号模型表（模型 / 别名 / 价格阶梯 / 上下文 / 最大输出 / 能力 / 可用账号）+ 账号探测状态表

## 七、测试

```
npm run test:account-info   # 51 项：真实字段结构 / 价格阶梯 / 请求头 / 业务拒绝 / 目录合并
```

fixture 直接取自真实响应（`REAL_USER` / `REAL_AGENTS` / `REAL_DETAIL`），不是编的。
