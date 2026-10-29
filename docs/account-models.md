# 账号信息与模型目录

## 一、探测什么、打哪里

| 数据 | 端点 | 关键请求头 |
|---|---|---|
| 剩余积分 / 余额 | `GET {benefit}/api/v1/user/tokens/balance` | `X-Security-Token`、`app-id` |
| 免费权益模型 | `GET {benefit}/api/v1/gateway/config` | 同上 |
| 模型 + 每模型积分 | `GET {agent-center}/v1/agent-center/agents/useragents?offset=0&limit=100`<br>`GET {agent-center}/v1/agent-center/agents/detail?agent_id=<id>` | `X-Security-Token`、`app-id`、**`Agent-Type: AgentCenter`**、`x-client-type: DevMate`、`x-current-user` |

全部用 `SDK-HMAC-SHA256` 签名（`lib/sign.mjs`）。

### 为什么 agent-center 必须带 `Agent-Type`

实测缺这个头会直接 400：

```json
{"error_code":"TM.00001001","error_msg":"请求头Agent-Type为空"}
```

补上 `Agent-Type: AgentCenter` 才会进到业务逻辑。`x-current-user` 取账号的 `userName`/`userId`，没有就不带。

## 二、模型清单的三种形状

反编译文档里 benefit 网关的模型是 **map**（`r_(id)` 查 `model map (P1)`），不是数组。所以 `pickModels` 三种都吃：

```jsonc
// 1) 数组
[{ "id": "glm-4.6", "credit": 5 }]

// 2) 对象 map —— 键名就是模型 id
{ "models": { "glm-4.6": { "credit": 5, "limit": 500 },
              "deepseek-v3.2": { "credit": 3, "enable_queue": true } } }

// 3) 纯字符串数组
{ "models": ["glm-4.6", "kimi-k2"] }
```

判定「值是不是一个模型」看它有没有 `credit/price/limit/endpoint/reasoning` 之类字段，避免把 `{"code":0,"msg":"ok"}` 当成模型。

字段别名：`id|model|model_id|modelId|name|model_name`、`credit|credits|price|cost|point|points|unit_price`、`limit|max_tokens|quota|token_limit|context_length`。

## 三、认不出字段怎么办

`balance` 和 `gateway/config` 都可能 200 但结构陌生。所以探测会同时存两份：

1. `balance`：按已知关键词（`balance/remain/left/avail/rest/surplus/credit/point/quota/total/used/amount/count`）挑出的字段
2. `numbers`：**所有数字叶子**摊平（路径 → 值，最多 80 条）——字段名再怪也能看到值
3. `raw`：原始响应 JSON，每个截断 6 KB

弹窗里「响应里的数字字段」默认展开（余额表为空时），「原始响应」可折叠，右上角有「复制原始响应」。

`balanceTotal` 取值顺序：余额表里的 remain 类字段求和 → `numbers` 里路径含 `remain/left/avail/balance/credit/point` 的求和 → `null`（前端显示 `—`）。

## 四、跨账号模型目录

`GET /panel/api/models` 把所有账号的 `info.models` 合成一张表：

```jsonc
{
  "models": [
    { "id": "glm-4.6", "credit": 8, "limit": 1000, "free": true,
      "queued": false, "reasoning": false, "endpoint": null,
      "accounts": ["acc1", "acc2"] }
  ],
  "accounts": [
    { "id": "…", "name": "acc1", "enabled": true,
      "modelCount": 12, "balanceTotal": 750000, "checkedAt": "…", "errors": 0 }
  ]
}
```

合并规则（`lib/model-catalog.mjs`）：

- 同一 `id` 的 `credit` **取最大值**（保守：按最贵的算）
- 标记位（免费/排队/推理）取并集
- `limit` / `endpoint` / `vendor` 取第一个非空
- 按 `credit` 降序，同价按 id 字典序

`POST /panel/api/models/refresh` 并发探测所有启用账号（并发 4），返回 `{ok, probed, total, failed[]}`。

## 五、面板

- **账号池**：账号名下面直接显示 chips —— `积分 750,000` / `模型 12` / `缓存 40%`
- **信息弹窗**：宽 920px，内容区独立滚动；分区为 KPI → 剩余积分 → 数字兜底 → 模型价格 → 数据来源 → 原始响应 → 失败尝试
- **「模型」菜单**：跨账号模型表（模型 / 价格 / 额度 / 标记 / 可用账号）+ 账号探测状态表，右上「重新探测全部账号」

## 六、失败信息怎么读

失败按 base 合并成一条，最多 8 条：

```
https://snap-access.cn-north-4.myhuaweicloud.com → 3 个端点失败：balance HTTP 404 {"error_msg":"The API does not exist…"}；gateway/config HTTP 404 …；useragents HTTP 400 {"error_code":"TM.00001001","error_msg":"请求头Agent-Type为空"}
```

| 报错 | 含义 |
|---|---|
| `getaddrinfo ENOTFOUND <host>` | 这个域名在你的网络里不解析，从 `accountInfo.bases` 里删掉 |
| `APIG.0101 The API does not exist or has not been published` | 这个域名下没有这个 API，换个 base |
| `TM.00001001 请求头Agent-Type为空` | 缺 `Agent-Type`（已默认补上） |
| 200 但一片空白 | 看「原始响应」，把 JSON 贴出来按实际结构校准 |

## 七、配置

```jsonc
"accountInfo": {
  "bases": ["https://opengw.developer.huaweicloud.com",
            "https://snap-access.cn-north-4.myhuaweicloud.com"],
  "appId": "CodeAgent3.0",
  "agentType": "AgentCenter",
  "codeAgentId": "a8bcb36232554267a5142361cc25a393",
  "timeoutMs": 20000,
  "rawLimit": 6000,
  "numbersLimit": 80
}
```

`snapengine-apig.cn-north-7.myhuaweicloud.com` 在部分网络下 DNS 不解析，默认列表已去掉；需要时自己加回。

## 八、测试

```
npm run test:account-info   # 61 项：数组/map/字符串三种模型形状、数字兜底、Agent-Type 头、
                            #       原始响应截断、失败合并、跨账号目录合并规则
```
