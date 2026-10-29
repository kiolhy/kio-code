# 账号调度

参考 [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) 的调度模型，
按码道网关的语义重写。核心是**选号**和**退避**两件事。

## 之前的问题

`pickAccount` 就是一行纯轮询：

```js
const a = usable[rrIndex % usable.length];
rrIndex = (rrIndex + 1) % usable.length;
```

三个后果：

1. **不看可用性**。账号刚 429 完，下一轮照样轮到它。
2. **不区分失败类型**。401、429、500 一视同仁，全塞一个计数器。
3. **没有会话粘性**。同一会话第二轮换账号，上游 prompt cache 直接作废。

## 选号顺序

```
会话粘性 → 手动权重 → 平滑加权轮询
```

### 1. 会话粘性

同一会话优先回到上次服务的账号。上游的 prompt cache 是**按账号**存的，换账号等于
从头重建，多轮对话每轮都亏一遍。

```js
const affinity = createSessionAffinity();  // ttl 2h, history 3
affinity.bind(sessionKey, accountId);
affinity.get(sessionKey);     // 上次的账号
affinity.recent(sessionKey);  // 最近用过的（新的在前）
affinity.demote(sessionKey, failedId);  // 失败时摘掉，保留其他
```

保留**最近 3 个**而不是 1 个：粘住的账号冷却时，退到该会话历史里其他账号
（它们也预热过），最后才用冷账号。

### 2. 手动权重

面板给账号设了 `weight > 1` 时，这些账号**优先于一切自动偏好**接单。
权重是「我就想让这个号多用」的直接表达，不该被自动偏好覆盖。

### 3. 平滑加权轮询

nginx 算法。每个候选每次累加自己的权重，最大的胜出，胜出者减掉本轮总权重。
权重相等时退化成纯轮询。

```
权重 3:1，8 次请求 → 6:2
```

## 四级退避

不用一个计数器糊在一起，按失败类型分开：

| 类型 | 触发 | 首次冷却 | 封顶 | 作用范围 |
|---|---|---|---|---|
| 软限流 | 429（账号级） | 600s | 2h | 整个账号 |
| 未验证软限流 | 429（模型级） | 60s | 10min | 只封那个模型 |
| 硬失败熔断 | 5xx / 网络，连续 3 次 | 1800s | 6h | 整个账号 |
| 未知错误降级 | 其他，连续 5 次 | 600s | 2h | 整个账号 |
| 鉴权失效 | 401 / 403 | 停用 | — | 直到续期 |
| 配额耗尽 | 402 / 余额不足 | 3600s | — | 整个账号 |

全部指数退避：`base * 2^(count - offset)`，夹到 cap。

### 模型级冷却

一个模型配额耗尽**不该拖死整个账号**：

```js
noteFailure(acc, { status: 429, model: 'GLM-5.2', modelScoped: true });
isReady(acc, 'GLM-5.2');  // false
isReady(acc, 'Kimi-K3');  // true  ← 别的模型照常服务
```

### 成功清一切

一次真正成功的请求是最硬的证据 —— 上游确实服务了，说明凭据有效、限流已解、
配额还在。所以 `noteSuccess` 清掉**所有**惩罚，包括 `tokenExpired`。

## 配额主动扫描

上游只在真撞到 429 时才「有记录」，在那之前没人知道离限额还有多远。
等到真撞上，客户端已经吃了一次失败。

`lib/quota-scan.mjs` 补的是前半段：按固定间隔（默认 6 小时）为每个
「账号 × 模型」发一个最小请求（`max_tokens: 1`），主动看这条线是否被打满。

| 结果 | 处理 |
|---|---|
| 2xx | 这条线还活着，继续按 6 小时查 |
| 429 + 重置时刻 | 登记窗口，立刻记模型冷却，真实请求不再撞同一个坑 |
| 网络/解析失败 | 不算查过，15 分钟后重试（连续 6 次才推到下一周期） |

**判定条件只有一句**：本地已有 429 窗口记录的线不再主动查，窗口结束后自动恢复。

其他细节：

- 首次登记排开（5s + 15s × n），别在勾选的一瞬间把请求全打上去
- 每轮最多 6 条，相邻两条间隔 0.4s，避免卡死的上游占满线程
- 并发保护：一轮没跑完，第二轮直接返回 `busy`
- 模型正在冷却时跳过，查了也是 429

## 配置

```json
{
  "quotaScan": {
    "enabled": true,
    "intervalMs": 21600000,
    "batchLimit": 6,
    "models": ["GLM-5.2", "Kimi-K3", "DeepSeek-V4.1-Flash-1017"]
  }
}
```

## 面板

新增「调度」页：

- **账号状态**：可用性、权重、各类冷却剩余、模型级冷却、连击计数、最近错误
- **配额扫描**：每条「账号 × 模型」的上次/下次查询、结果、重试次数、窗口结束时刻
- 可以改权重、清冷却、立即跑一轮扫描

## 代码

- `lib/scheduler.mjs` — 退避 / 分类 / 会话粘性 / 平滑加权轮询 / 选号
- `lib/quota-scan.mjs` — 配额主动扫描
- `lib/panel.mjs` — `pickAccount` / `reportFailure` / `reportSuccess` / `affinity`
- `server.mjs` — `callUpstreamWithRotation` 走调度器；`/panel/api/schedule`、`/panel/api/quota/scan`
- `tools/test-scheduler.mjs` — 90 项
- `tools/test-quota-scan.mjs` — 38 项

## 和节流层的关系

两层职责不同，互补：

| | `pacing.mjs`（governor） | `scheduler.mjs` |
|---|---|---|
| 管什么 | 出站节奏：并发、最小间隔、抖动 | 选谁：会话、权重、退避 |
| 冷却 | 固定时长（429 → 60s） | 分级指数退避 |
| 粒度 | 账号 | 账号 + 模型 |
| 目的 | 行为像真人，不像脚本 | 把请求送到能服务的账号 |

一次失败两个都喂：`governor.penalize` 防立刻再打，`panel.reportFailure` 决定下一轮选谁。
