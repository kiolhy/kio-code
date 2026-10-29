# 用量统计

## 问题：只有输入没有回复

面板请求流水里 token 全是 0：

```
2026/10/29 16:45:40  POST  /v1/chat/completions  DeepSeek-V4.1-Flash-1017  200  2161 ms  0  —  0
```

## 原因

上游 CodeArts 的 SSE **默认不返回 usage**，只在最后给 `data: [DONE]`。

CLI 自己的 provider 是这么要的（`bun_section` @6781991）：

```js
e = this.transformRequestBody({
  ...t,
  stream: true,
  stream_options: this.config.includeUsage ? { include_usage: true } : undefined
})
```

**只有 `config.includeUsage` 为真才发 `stream_options.include_usage: true`。**
我们的网关转发的是 CLI 原始 body，CLI 没带这个字段，上游就不给 usage。

## 修复

### 1. 主动补 `include_usage`

`buildUpstreamBody()` 现在对流式请求强制注入：

```js
if (out.stream === true) {
  out.stream_options = { ...(out.stream_options ?? {}), include_usage: true };
}
```

非流式不注入（不需要）。

### 2. 上游还是不给时，本地估算

两条路都做了兜底：

**流式**：旁路解析 SSE，累计输出字符数

```js
const d = j.choices?.[0]?.delta ?? {};
countText(d.content);
countText(d.reasoning_content);
// tool_calls 的 arguments / name 也算
```

累计时区分 CJK 和 ASCII：

```js
// CJK 约 1 token/字，其余约 3 字符/token
const completionTokens = Math.ceil(outCjk + (outChars - outCjk) / 3);
const promptTokens = estimatePromptTokens(body);
```

**非流式**：`ensureUsage()` 从响应 `choices[].message.content` 估算。

### 3. 标记为「估算」

估算的记录带 `estimated: true`，面板显示「估算」标签，不会和上游真实 usage 混淆。

```json
{
  "promptTokens": 10,
  "completionTokens": 5,
  "estimated": true,
  "credit": 0.0001
}
```

## 面板显示

请求流水现在每列都分开：

| 时间 | 方法 | 路径 | 模型 | 状态 | 耗时 | 输入 | 输出 | 缓存 | 积分 |
|---|---|---|---|---|---|---|---|---|---|
| 16:45:40 | POST | /v1/chat/completions | DeepSeek-V4.1-Flash-1017 估算 | 200 | 2161 ms | 10 入 | 5 出 | — | 0.0001 |

- 模型名后面带「估算」标签 = 上游没给 usage，本地算的
- 输入 / 输出分两列，不再合并成「Token」
- 缓存列显示命中比例和命中 token 数
- 积分按真实价格算

## 估算精度

| 内容 | 规则 |
|---|---|
| 中文 | 约 1 token / 字 |
| 英文 | 约 3 字符 / token |
| 混合 | 分开算再加总 |
| tool_calls | arguments + name 都算 |

估算**只用于统计展示**，不影响实际计费（计费在上游）。

## 代码

- `lib/gateway.mjs`
  - `buildUpstreamBody()` — 注入 `stream_options.include_usage`
  - `forwardChatStream()` — 旁路累计输出字符，区分 CJK
  - `estimateTokensFromChars()` — 字符数 → token
  - `estimatePromptTokens()` — 请求体 → 输入 token
  - `ensureUsage()` — 非流式兜底
- `lib/panel.mjs` — `recordUsage()` 保存 `estimated` 标记
- `tools/test-stream-usage.mjs` — 31 项断言

## 测试

```
npm run test:stream-usage
```

端到端验证：起一个**故意不返回 usage** 的假上游，确认
`promptTokens > 0`、`completionTokens > 0`、`estimated === true`。
