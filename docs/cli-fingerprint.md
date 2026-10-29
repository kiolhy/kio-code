# 出站指纹：完全对齐真 CLI

本文记录 `lib/stealth.mjs` 的每个默认值**从哪来**。所有值都来自本机 CLI 自己的日志，
不是猜的。

## 证据来源

CLI 装在 `~/.codeartsdoer`，日志在：

```
~/.codeartsdoer/cli-data/log/kernel-codeartsdoer-*.log
```

日志里 CLI 会打印自己构造的请求头：

```
INFO [...] service=inferhub-provider "[header-debug] full headers: {...}"
```

本机共 **56 条**样本，值全部一致。另外 `service=chat-param-plugin` 那行会打出
`maas_type` 的实际取值。

CLI 启动行（确认版本）：

```
service=default "codearts" version=26.10.9 args=["serve", "--port", "4097", "--hostname", "127.0.0.1"]
```

## 实测头（原样）

```json
{
  "x-ot-trace-id": "a3c53e942754427f910ea068dc54200e",
  "x-ot-span-id": "1046d5d879da6608",
  "x-snap-traceid": "58dc923a137146d3a4b33bff795b0bd0_a77ffb793148466a",
  "x-ot-session-id": "ses_e7e55d3daffekburR2EHBb6EGE",
  "x-ot-parent-session-id": "",
  "user-session-id": "ses_e7e55d3daffekburR2EHBb6EGE",
  "x-ot-function": "agent-tui",
  "X-Language": "zh-cn",
  "user-msg-id": "msg_181aa30020014NTr39NQypfP4u",
  "created-time": "2026-10-28T08:39:41Z",
  "model-id": "mock-thinking",
  "model-name": "mock-thinking",
  "x-ot-client-type": "CLI",
  "x-ot-client-version": "26.10.9",
  "plugin-name": "CLI",
  "plugin-version": "26.10.9",
  "ide-name": "CLI",
  "client-ip": "198.18.0.1",
  "X-Sdk-Date": "20261028T083942Z",
  "host": "snap-access.cn-north-4.myhuaweicloud.com"
}
```

## 之前猜错的值

| 字段 | 之前（猜的） | 实测 | 影响 |
|---|---|---|---|
| `plugin-name` | `codearts-cli` | **`CLI`** | 一眼假 |
| `ide-name` | `codearts` | **`CLI`** | 一眼假 |
| `x-ot-client-type` | `DevMate` | **`CLI`** | 一眼假 |
| `client-ip` | 本机私网 IP | **`198.18.0.1`** | Bun 无网卡时的占位地址，发私网 IP 反而异常 |
| `maas_type` | `benefit` | **空（不发）** | 发 benefit 会被上游按套餐通道校验 |
| `x-ot-session-id` | UUID | **`ses_<13hex>e<17b62>`** | 格式不对 |
| `user-msg-id` | UUID | **`msg_<13hex><17b62>`** | 格式不对 |
| `created-time` | 毫秒时间戳 | **ISO8601 秒精度** | 格式不对 |
| `x-snap-traceid` | 32 hex | **`<32hex>_<16hex>`** | 少一段 |
| `model-name` | 同 `model-id` | **显示名** | 见下 |

## model-id 与 model-name 是两个不同的值

实测同一请求里：

```
model-id:   openpangu-2.0-pro        ← model_id
model-name: OpenPangu-2.0-Pro        ← 显示名
```

大部分模型两者相同（`GLM-5.2`），但带连字符的模型不同。
`modelDisplayName(account, model)` 从账号的模型目录里查显示名，查不到就回落成 `model`。

## id 格式

```
x-ot-trace-id    32 hex                        crypto.randomBytes(16)
x-ot-span-id     16 hex                        crypto.randomBytes(8)
x-snap-traceid   <32 hex>_<16 hex>             两段，下划线
x-ot-session-id  ses_ + 13 hex + 'e' + 17 b62  每账号稳定，TTL 内复用
user-msg-id      msg_ + 13 hex + 17 b62        每请求新生成
created-time     YYYY-MM-DDTHH:mm:ssZ          UTC 秒精度
```

`x-ot-parent-session-id` 实测有两种取值：空串（39/51）和 `ses_silent`（12/51）。
空串要**保留并参与签名**——CLI 自己也会签空值。

## maas_type 怎么定

实测四种取值（2026-10-29，`snap-access.cn-north-4`）：

| 发的值 | 上游响应 |
|---|---|
| 不发 | 200 正常 |
| `benefit` | 200；无套餐账号回 `4004 benefit not found` |
| `default` | 200 + `TM.00009999 503 Service Unavailable` |
| `pay` | 400 未开通 |

CLI 自己发的是空（日志 `maas_type: ,`）。所以：

```js
maasTypeFor(account)  // 有 benefit 套餐 → 'benefit'，否则 → ''（不发）
```

## 传输层

CLI 是 Bun 运行时，实测出站：

```
user-agent:      Bun/1.3.14
accept:          */*
accept-encoding: gzip, deflate
TLS ALPN:        http/1.1
```

CLI 支持 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（日志 `[proxy-diag] source: Env (HTTP_PROXY)`）。
网关的 `stealth.egress.proxy` 对应这个。

## 验证

```bash
node tools/test-stealth.mjs   # 117 项，含格式正则与实测值断言
```

改任何默认值之前，先回去看日志确认——这些值不是审美选择，是对齐。
