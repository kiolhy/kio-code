# 网关模式（真实上游）

> 本文档描述 `mode: "gateway"` 下的真实转发链路。所有出站请求都是真实 HTTPS，
> 用账号池里的 STS 凭据做 SDK-HMAC-SHA256 签名。

## 一、三种模式的区别

| 模式 | CLI 对话 | 模型列表 | 用途 |
|---|---|---|---|
| `mock` | ❌ `lib/mock.mjs` 返回假回复 | `config.json` 的静态清单 | 链路自检、离线调试 |
| `proxy` | ✅ 原样反代到 `upstream.baseUrl` | 上游决定 | 接别的真实上游 |
| **`gateway`** | ✅ **转发到真实码道上游** | **账号池探测到的真实模型** | **生产使用** |

切换方式：`config.json` 的 `"mode"`，或环境变量 `MOCK_HUB_MODE`。

## 二、gateway 模式的完整链路

```
CLI  ──POST /api/v2/chat/completions──▶  网关
                                          │
                                          │ 1. 从账号池选凭据（轮询）
                                          │ 2. buildUpstreamBody：补 user_prompt / max_tokens / tool_stream
                                          │ 3. buildSignableHeaders：造 CLI 头集合
                                          │ 4. signRequest：SDK-HMAC-SHA256 签名
                                          │ 5. transport：真实 HTTPS
                                          ▼
                              https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
```

### 支持的入口路径

| 路径 | 说明 |
|---|---|
| `POST /api/v2/chat/completions` | 码道 CLI 原生路径 |
| `POST /v1/chat/completions` | OpenAI 兼容 |
| `POST /v1/messages` | Anthropic 兼容（转成 OpenAI 后转发） |
| `GET /v1/models` | 模型列表（来自账号池真实探测） |

`/api/v2/chat/completions` 在 `handleGateway` 里归一化成 `/v1/chat/completions` 处理。

### 出站请求头（实测对齐 CLI）

```
Authorization: SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=..., Signature=...
X-Security-Token: <STS security_token>
x-current-user: <账号真实 userName>
app-id: CodeAgent3.0
content-type: application/json
x-ot-trace-id / x-ot-span-id / x-snap-traceid / x-ot-session-id / user-session-id
x-ot-function / x-language / user-msg-id / created-time / model-id
```

`x-current-user` 取账号的 `userName`，不是 `config.identity.userName`。

### 请求体补全

上游本来就吃 OpenAI 协议，只补几个私有字段：

```js
max_tokens        // 缺省 16384；max_completion_tokens 会映射过来
creditRatioDisplay // 缺省 '2x'
tool_stream       // 有 tools 时 true
tool_choice       // 有 tools 时 'auto'
user_prompt       // 取最后一条 user 消息
```

## 三、账号选择与轮换

`pickCredentials()`：

1. 优先用请求头 `x-account` 指定的账号（如果存在且可用）
2. 否则在启用且有 AK/SK 的账号里**轮询**（游标跨请求推进）
3. 都没有才退回 `config.upstream.ak/sk`

失败轮换：`callUpstreamWithRotation` 会排除已试过的账号重试。

## 四、模型列表

`GET /v1/models` 的数据源：

```js
const catalog = buildCatalog(panel.state?.accounts ?? []);
const fromCatalog = catalog.models.map((m) => m.id);
const list = gw.models ?? (fromCatalog.length ? fromCatalog : cfg.models.map((m) => m.model_name));
```

- 有探测结果 → 用真实的 8 个模型（GLM-5.2 / OpenPangu / DeepSeek / Kimi-K3 …）
- 没探测过 → 才退回 `config.models` 静态清单
- `gateway.models` 非空时强制用配置的清单

返回里带 `context_window` / `max_tokens`（来自真实探测）。

## 五、流式与用量

`forwardChatStream()`：

- 上游 SSE **原样**写给客户端（不缓冲、不改写）
- 旁路解析 `data:` 行里的 `usage`（不干扰转发）
- 结束后回调 `onUsage` → `panel.recordUsage()`

落盘字段（`data/usage.jsonl`）：

```jsonc
{
  "accountId": "acc-1", "accountName": "acc1",
  "model": "GLM-5.2", "route": "gateway.chat", "status": 200,
  "promptTokens": 11, "completionTokens": 5,
  "cachedTokens": 4, "cacheWriteTokens": 0, "cacheRatio": 0.364,
  "stream": true, "durMs": 1234
}
```

## 六、配置

```jsonc
{
  "mode": "gateway",
  "gateway": {
    "defaultRegion": "cn",
    "regions": {
      "cn": "https://snap-access.cn-north-4.myhuaweicloud.com",
      "intl": "https://snap-access.ap-southeast-1.myhuaweicloud.com"
    },
    "chatPath": "/api/v2/chat/completions",
    "owner": "codearts",
    "models": [],          // 留空 = 用账号池探测结果
    "requireKey": true     // 公网部署必须开
  },
  "stealth": {
    "assertNoLeaks": true, // 出站头里出现网关特征就抛错
    "timeoutMs": 300000,
    "streamIdleMs": 180000
  }
}
```

`config.identity` 在 gateway 模式下只作为兜底（`department` / `currentUser` 为空时），
真实身份来自账号池。

## 七、让 CLI 指向网关

```powershell
$env:INFERHUB_BASE_URLS = "http://127.0.0.1:8787/api/v2/"
$env:PLUGIN_ENV = "hc"
```

前提：账号池里至少有一个可用账号（面板「账号池 → 授权添加」）。

## 八、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `no_credentials` | 账号池空 / 账号缺 AK/SK | 授权添加账号 |
| `401 unauthorized` | `gateway.requireKey=true` 但没带 key | 面板建 key，或临时设 `requireKey:false` |
| 上游 401 `APIG.0301` | 凭据过期 | 面板点「续期」，或重新授权 |
| `fingerprint_leak` | 出站头带上网关特征 | 检查 `stealth.profile`，别改 `userAgent` |
| 模型列表为空 | 没探测过账号 | 面板「模型」页 →「重新探测全部账号」 |

## 九、测试

```
npm run test:gateway-mode   # 28 项：真实转发 / 签名头 / 流式 / 用量落库
```

测试用假上游观察出站请求，验证：

- `/api/v2/chat/completions` 被正确转发到上游同路径
- `SDK-HMAC-SHA256` 签名、`X-Security-Token`、`x-current-user`（账号真实名）、`app-id` 都在
- `user_prompt` / `max_tokens` 被补全
- 流式 SSE 透传 + `[DONE]`
- 用量落盘含 `promptTokens` / `cachedTokens` / `cacheRatio` / `accountName`
