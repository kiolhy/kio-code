# 反代网关的「不像网关」清单

把 mock-hub 挂在服务器上、用账号池反代码道上游时，上游看到的不再是一台个人电脑上的
CLI，而是一个多租户网关。**能不能用**取决于协议对齐，**会不会被挑出来**取决于差异面。

这份文档按「上游能观测到什么」排序，逐条说明本仓库怎么处理、还剩什么做不到。

---

## 一、上游能看到什么

| 层面 | 观测点 | 真 CLI 的形状 | 裸奔网关的形状 | 本仓库处理 |
|---|---|---|---|---|
| TLS | JA3/JA4、ALPN、cipher 顺序 | Bun / BoringSSL，h1.1 | Node OpenSSL 默认 | 部分：ALPN + cipher/curve 固定 |
| HTTP | 头集合、头顺序、大小写 | 30+ 个 `x-ot-*` / 插件版本头 | 3 个头 + 自证 UA | ✅ 同构 + 定序 |
| 身份 | `Authorization` 的 SignedHeaders 组成 | 含会话/插件/模型头 | 只有 `content-type;host` | ✅ 同构 |
| 会话 | `x-ot-session-id`、`user-session-id` | 一个会话稳定 | 无 / 每请求随机 | ✅ 按账号稳定 |
| 时序 | 请求间隔、并发、突发 | 人的节奏 | 20 个客户端同时打 | ✅ 账号级串行 + 抖动 |
| 出口 | 源 IP、IP↔账号绑定 | 一台机器一个 IP | 一台服务器一个 IP | ✅ 支持每账号代理 |
| 内容 | prompt、模型名、usage | 正常对话 | 拼接/爬虫式 prompt | 只能靠使用方式 |
| 账号 | 多账号是否同源 | 各自独立 | 同 IP 同节奏 | ✅ 轮换 + 冷却 |

> 结论：**头、签名、会话是硬指标，必须同构；时序和出口是软指标，但不做就等于自报身份。**

---

## 二、本仓库的实现

```
lib/stealth.mjs     画像与头构造（谁能出现在请求里、值长什么样、顺序如何）
lib/transport.mjs   发送方式（头序 / TLS 参数 / CONNECT 代理 / 解压）
lib/pacing.mjs      节奏（账号级并发、最小间隔、抖动、冷却、Retry-After）
lib/gateway.mjs     组装：可签名头 → 签名 → 补传输层头 → 发出
```

### 2.1 头集合

真 CLI 的 `getInferhubHcHeaders()`（见 `docs/codearts-reverse-engineering.md` §5.2）
会带一整套元信息。本仓库按同一组成构造，**空值只保留 CLI 自己也会带的两个**
（`x-ot-parent-session-id`、`depart` 缺失时不发）。

| 头 | 来源 | 说明 |
|---|---|---|
| `x-ot-trace-id` / `x-snap-traceid` | 每请求随机 | 32 hex |
| `x-ot-span-id` | 每请求随机 | 16 hex |
| `x-ot-session-id` / `user-session-id` | 账号级稳定 | `sessionTtlMs` 到期换新 |
| `user-msg-id` / `created-time` | 每请求 | UUID / 毫秒时间戳 |
| `model-id` / `model-name` | 请求体 | 与 `body.model` 一致 |
| `plugin-*` / `ide-*` / `kernel-version` | `stealth.profile` | 必须和真实安装版本对得上 |
| `client-ip` | `stealth.profile.clientIp` | `auto` = 本机私网 IP，跳过 docker 网桥 |
| `app-id` / `maas_type` / `is_confidential` | 画像 | `CodeAgent3.0` / `benefit` / `false` |
| `x-ot-function` / `x-ot-client-type` | 画像 | `agent-tui` / `CLI` |
| `agent-type` / `x-referer` / `x-client-type` | 画像 | `CodeAgent` / `CodeBase` / `DevMate` |
| `accept` / `accept-encoding` / `user-agent` | 传输层 | **不参与签名**，和 CLI 一致 |

签名只覆盖 CLI 自己那批头（`SignedHeaders` 里不会出现 `accept-encoding`/`user-agent`），
所以即使有人比对 `SignedHeaders` 的组成，也看不出差别。

### 2.2 自证身份清零

出站请求里不允许出现：`kio`、`mock-hub`、`gateway/1.0`、`x-kio-*`、`undici`、
`user-agent: node`。`stealth.assertNoLeaks: true` 时，命中任意一条会直接抛
`fingerprint_leak`，而不是把请求发出去。`/health` 的 `outbound.leaking` 也是这个检查。

单元测试（`tools/test-stealth.mjs`）会对构造出的头和真实发出去的头各查一遍。

### 2.3 传输层

- 用 `node:https` 直发，**不用 fetch**：头顺序不会被重排，大小写不会丢。
- TLS：默认只谈 `http/1.1`，固定 cipher 顺序与曲线（`X25519:P-256:P-384`），
  **不关** `rejectUnauthorized` —— 关掉证书校验本身就是一个特征。
- 代理：`stealth.egress.proxy` 或账号上的 `proxy`，走 HTTP CONNECT；
  每个账号可以指不同出口，避免「10 个账号同一个公网 IP」。
- 响应：自动解 gzip/deflate/br；流式带空闲超时（`stealth.streamIdleMs`）。

### 2.4 节奏

| 参数 | 默认 | 作用 |
|---|---|---|
| `pacing.maxConcurrentPerAccount` | 1 | 一个账号同时只跑一个请求，像一个人 |
| `pacing.maxGlobalConcurrent` | 8 | 全局上限，防止把服务器变成压测机 |
| `pacing.minIntervalMs` + `jitterMs` | 250 + 0~150 | 请求间隔随机化，避免等距 spire |
| `cooldown.on429Ms` | 60s | 429 后该账号歇一会，而不是继续顶 |
| `cooldown.onAuthErrorMs` | 600s | 401/403 基本等于凭据废了，长冷却 |
| `retry.maxAttempts` | 3 | 失败换号重试次数 |
| `retry.rotateOnStatus` | 401/403/429/5xx | 命中就换下一个账号 |

`Retry-After` 会被解析并遵守（秒数与 HTTP 日期两种格式都支持）。

---

## 三、部署清单（照做即可）

1. **镜像**：`docker compose up -d --build`；容器已拷 `lib/`，`/health` 有 `outbound` 段。
2. **强鉴权**：面板首次登录改密码；`gateway.requireKey` 保持默认 `true`；
   公网入口只开在反代（Nginx/Caddy）后面，别直接暴露 8787。
3. **一账号一出口**：在面板账号里填 `proxy`，或全局 `MOCK_HUB_EGRESS_PROXY`。
   同一出口 IP 上挂太多账号，比任何头都显眼。
4. **版本对齐**：`stealth.profile.*` 填你实际安装的 CLI 版本
   （`pluginVersion` / `ideVersion` / `kernelVersion`），别留着示例值。
5. **身份对齐**：`department`、`currentUser` 和账号本身一致；
   `client-ip` 留 `auto` 或显式填客户端所在私网段。
6. **并发压到 1**：`MOCK_HUB_CONCURRENCY=1`（默认）。多人共用一个账号时，
   排队比并发的观感好得多。
7. **别用主账号**：试用号 / 小号，出问题只损失它。
8. **遥测另算**：网关只管模型流量。CLI 自己的 OTLP 上报是独立通道，
   见 `docs/egress.md`，要一起处理。

---

## 四、怎么验证「确实像」

```bash
# 1) 出站画像自检（不联网）
node tools/test-stealth.mjs

# 2) 端到端：假上游会断言收到的头
node tools/test-gateway.mjs

# 3) 部署后看运行时视角
curl -s http://127.0.0.1:8787/health | jq .outbound
# { "client": "codearts-cli/26.10.9", "userAgent": "Bun/1.3.14",
#   "egressProxy": true, "perAccountConcurrency": 1, "accounts": 3, "leaking": false }

# 4) 抓一次真实出站对比
#    上游侧看到的头应该和你本机 CLI 抓包逐项对得上，除了 trace/session 的值
```

如果 `leaking` 是 `true`，说明画像里有自证字符串，先去改 `stealth.profile`。

---

## 五、做不到的部分（别自欺）

1. **JA3/JA4 只能近似**。Node 的 OpenSSL 和 Bun 的 BoringSSL 指纹不同，
   固定 cipher/曲线/ALPN 只能缩小差距，不能完全一致。真要一致得上 uTLS 级别的
   原生实现，本项目零依赖，没做。
2. **`client-ip` 是自报的**。它和 TCP 源 IP 对不上时，上游如果交叉校验就能看出来。
   所以要么让它等于真实出口所在网段，要么干脆别发（`clientIp: ""`）。
3. **HTTP/2 没开**。真 CLI 走 h1.1，这里也走 h1.1；如果哪天上游只收 h2，
   需要补 `node:http2` 并把签名头映射到伪头。
4. **行为一致性是统计问题**。头再像，一个账号 7×24 每秒一次请求也会被看出来。
   并发、间隔、账号分布才是长期活下来的关键。
5. **官方安全组件的行为未知**。`agent_defense_combined.exe` 那类组件若在客户端运行，
   它看到的是「所有模型流量都指向内网」，这不是网关能控制的，见 `docs/egress.md` §五。

---

## 六、配置速查

```jsonc
{
  "stealth": {
    "profile": {
      "userAgent": "Bun/1.3.14",
      "pluginVersion": "26.10.9",       // 必改：你的实际版本
      "clientIp": "auto",               // auto / 显式私网 IP / "" 不发
      "department": "",                 // 留空回落 config.identity.department
      "currentUser": ""
    },
    "assertNoLeaks": true,              // 出站前自检，命中即报错
    "egress": { "proxy": "" },          // http(s)://user:pass@host:port
    "pacing": { "maxConcurrentPerAccount": 1, "minIntervalMs": 250, "jitterMs": 150 },
    "cooldown": { "on429Ms": 60000, "onAuthErrorMs": 600000 },
    "retry": { "maxAttempts": 3 },
    "tls": { "alpn": ["http/1.1"], "curves": "X25519:P-256:P-384" }
  }
}
```

环境变量：`MOCK_HUB_EGRESS_PROXY`、`MOCK_HUB_UA`、`MOCK_HUB_CLIENT_IP`、
`MOCK_HUB_DEPART`、`MOCK_HUB_CURRENT_USER`、`MOCK_HUB_CONCURRENCY`。
