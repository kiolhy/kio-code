# 积分计价

按**模型真实价格**计算每次请求消耗多少积分，不是估算。

## 价格从哪来

`GET /v1/agent-center/agents/detail?agent_id=…` → `gpts.models[].credit[]`

```json
{
  "model_name": "OpenPangu-2.0-Pro",
  "model_parameters": {
    "model_id": "OpenPangu-2.0-Pro",
    "context_window": 524288,
    "max_tokens": 65535
  },
  "credit": [
    { "input_from": 0,     "input_to": 32000, "input_price": "3.2", "cache_price": "0.8", "output_price": "14.5" },
    { "input_from": 32001, "input_to": -1,    "input_price": "4.8", "cache_price": "1.2", "output_price": "17.6" }
  ]
}
```

- 单价单位：**积分 / 千 token**
- `input_to: -1` 表示无上限
- 阶梯按**输入 token 数**选档

## 计价公式

```
未命中缓存的输入 × input_price
+ 命中缓存的输入   × cache_price
+ 输出 token       × output_price
────────────────────────────────────
              1000
```

## 例子（GLM-5.2：入 8 / 缓存 2 / 出 28）

| 场景 | 计算 | 积分 |
|---|---|---|
| 1000 输入（无缓存）+ 500 输出 | (1000×8 + 500×28) / 1000 | **22** |
| 1000 输入里 800 命中缓存 | (200×8 + 800×2) / 1000 | **3.2** |
| 1000 输入全命中缓存 | (1000×2) / 1000 | **2** |
| 相比不命中省下 | 800×(8−2)/1000 | **4.8** |

## 阶梯计价（OpenPangu-2.0-Pro）

| 输入 token | 单价 |
|---|---|
| ≤ 32000 | 入 3.2 / 缓存 0.8 / 出 14.5 |
| > 32000 | 入 4.8 / 缓存 1.2 / 出 17.6 |

40000 输入 → 走第二档 → 40000 × 4.8 / 1000 = **192 积分**

## 落库字段

`data/usage.jsonl` 每条记录新增：

```json
{
  "credit": 3.2,
  "creditTier": { "inputFrom": 0, "inputTo": -1, "input": 8, "cache": 2, "output": 28 },
  "creditBreakdown": {
    "promptTokens": 1000,
    "cachedTokens": 800,
    "missInputTokens": 200,
    "completionTokens": 0,
    "inputPrice": 8, "cachePrice": 2, "outputPrice": 28,
    "inputCredit": 1.6, "cacheCredit": 1.6, "outputCredit": 0,
    "savedCredit": 4.8
  }
}
```

## 面板显示

「数据看板」页：

- KPI：**积分消耗** / **缓存省下**
- 模型表：每模型积分合计 + 每千 token 平均成本
- 账号表 / Key 表：积分合计
- 请求流水：每条请求的积分

## 没有价格时

模型没探测过 → `credit: null`，面板显示 `—`，KPI 里单独计数 `creditUnknown`，**不会混进总数**。

## 代码

- `lib/pricing.mjs` — `pickTier` / `computeCost` / `findModelPrice` / `sumCredit`
- `lib/panel.mjs` — `recordUsage()` 里自动查价并计算
- `tools/test-pricing.mjs` — 30 项断言

## 测试

```
npm run test:pricing
```
