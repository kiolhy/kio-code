# 缓存命中统计

## 为什么之前「看不到缓存数据」

三个原因叠在一起：

1. **只认一个字段**：`recordUsage` 只读 `usage.prompt_tokens_details.cached_tokens`（OpenAI chat 的形状），
   上游返回别的形状（DeepSeek 的 `prompt_cache_hit_tokens`、Anthropic 的 `cache_read_input_tokens`、
   或者简写 `cached_tokens`）时一律记成 `0`，于是「输入 Token」下面的缓存永远是 0。
2. **没有比例**：只累加了 `cachedTokens`，没算 `cached / prompt`，也没有按模型/账号/Key 拆分。
3. **面板没渲染**：`cachedTokens` 只在「输入 Token」的副标题里露一个数，模型表和请求流水里都没有。

## 现在怎么算

### 1. 归一化（`lib/cache-stats.mjs`）

`extractCache(usage)` 按优先级依次尝试：

| 路径 | 来源 |
|---|---|
| `prompt_tokens_details.cached_tokens` | OpenAI chat |
| `input_tokens_details.cached_tokens` | OpenAI responses |
| `prompt_cache_hit_tokens` | DeepSeek |
| `cached_tokens` / `cachedTokens` | 简写 |
| `cache_read_input_tokens` | Anthropic（读缓存 = 命中） |
| `cache_hit_tokens` | 其它 |
| `cache.cached` / `cache.hit` / `prompt_cache.hit` / `prompt_cache_hit` | 自定义嵌套 |

写入缓存单独记：`cache_creation_input_tokens` / `cache_write_tokens` / `cache.write` → `cacheWriteTokens`（**不算命中**）。

未命中 = 显式 `prompt_cache_miss_tokens`（若有）否则 `prompt - cached`。

命中比例 = `cached / prompt`（prompt 为 0 时退回 `cached / (cached + miss)`）。

### 2. 落库（`data/usage.jsonl`）

每条请求新增：

```jsonc
{
  "promptTokens": 1000,
  "cachedTokens": 800,
  "cacheWriteTokens": 0,
  "cacheRatio": 0.8,                                 // 单条缓存比例
  "cacheSource": "prompt_tokens_details.cached_tokens" // 这个数是从哪个字段读到的
}
```

`cacheSource` 是排错用的：如果它一直是 `null`，说明上游这条响应里根本没有缓存字段。

### 3. 聚合（`GET /panel/api/usage`）

```jsonc
{
  "kpi": { "cachedTokens": 1000, "cacheWriteTokens": 0, "cacheRatio": 0.4, "cachePct": 40, ... },
  "models":   [{ "name": "glm-4.6", "cachedTokens": 1000, "cachePct": 50 }, ...],
  "accounts": [{ "name": "acc1",   "cachePct": 40 }, ...],
  "keys":     [{ "name": "k1",     "cachePct": 40 }, ...],
  "recent":   [{ "cachePct": 80, "cachedTokens": 800 }, ...]   // 每条流水自己的比例
}
```

- **全部缓存百分比** = `Σcached / Σprompt`（不是各请求比例的算术平均，避免小请求拉偏）
- **单个模型缓存比** = 该模型 `Σcached / Σprompt`
- 分母为 0 时 `cachePct` 为 `null`，前端显示 `—`（区分「没数据」和「真的 0%」）

## 面板怎么看

数据看板 → 用量统计：

- KPI 多一张 **「缓存命中」**：大数字是百分比，副标题是 `命中 X / 输入 Y`，有写入缓存时补 `写入 Z`
- **模型用量**表新增两列：`缓存命中`（token 数）、`缓存比例`
- **账号用量 / Key 用量**表各加一列 `缓存比例`
- **请求流水**新增 `缓存` 列：百分比 + 下方小字是这条请求命中的 token 数

## 排查

| 现象 | 原因 |
|---|---|
| 缓存一直是 `—` / `0%` | 上游响应里没有缓存字段。看 `usage.jsonl` 的 `cacheSource`，是 `null` 就是真没有 |
| 有 `cachedTokens` 但 `cachePct` 是 `—` | `promptTokens` 为 0，分母缺失 |
| 比例异常高 | 命中数被上游算进了 `prompt_tokens` 之外；以 `cacheSource` 指到的字段为准 |

## 测试

```
npm run test:cache   # 40 项：8 种 usage 形状 / 字段路径 / 写入缓存 / 比例 / 落库 / 聚合 / 重启后仍在
```
