# 代理池

给账号池里的每个账号单独指定出口代理，支持批量导入。

## 支持的写法

| 写法 | 说明 |
|---|---|
| `http://1.2.3.4:8080` | HTTP 代理 |
| `https://1.2.3.4:443` | HTTPS 代理 |
| `socks5://1.2.3.4:1080` | SOCKS5 |
| `socks4://1.2.3.4:1080` | SOCKS4 |
| `http://user:pass@1.2.3.4:8080` | 带认证 |
| `1.2.3.4:8080` | 裸写，默认 http |
| `1.2.3.4:8080:user:pass` | 常见代理商格式 |
| `user:pass@1.2.3.4:8080` | 省略协议 |

- `#` 开头为注释
- 空行忽略
- 同批次内自动去重（`1.2.3.4:8080` 和 `http://1.2.3.4:8080` 视为同一个）
- 已存在的代理再次添加会跳过

## 批量添加

面板「代理」页 → 文本框一行一个 → 点「添加」。

返回：

```json
{
  "added":   [{ "id": "px_1a2b3c", "label": "1.2.3.4:8080", "url": "http://1.2.3.4:8080" }],
  "skipped": ["http://5.6.7.8:1080"],
  "errors":  [{ "line": 8, "text": "badline", "error": "缺少端口" }],
  "total": 12
}
```

API：

```bash
curl -X POST http://127.0.0.1:8787/panel/proxies \
  -H 'content-type: application/json' \
  -d '{"text":"http://1.2.3.4:8080\nsocks5://u:p@5.6.7.8:1080"}'
```

## 绑定到账号

账号表「代理」列是下拉框，选一个就绑定，选「不使用代理」解绑。

API：

```bash
# 绑定
curl -X POST http://127.0.0.1:8787/panel/accounts/<账号ID>/proxy \
  -H 'content-type: application/json' -d '{"proxy":"px_1a2b3c"}'

# 解绑
curl -X POST http://127.0.0.1:8787/panel/accounts/<账号ID>/proxy \
  -H 'content-type: application/json' -d '{"proxy":""}'
```

绑定后，该账号的所有出站请求（探测、对话转发）都走这个代理。

## 健康检查

```bash
# 检测单个
curl -X POST http://127.0.0.1:8787/panel/proxies/check \
  -H 'content-type: application/json' -d '{"id":"px_1a2b3c"}'

# 检测全部启用的
curl -X POST http://127.0.0.1:8787/panel/proxies/check \
  -H 'content-type: application/json' -d '{}'
```

返回：

```json
{
  "ok": true,
  "okCount": 3,
  "total": 5,
  "results": [
    { "id": "px_1a2b3c", "label": "1.2.3.4:8080", "ok": true, "status": 200, "durMs": 320, "bytes": 1024, "error": null }
  ]
}
```

并发 6，默认打 `https://www.huaweicloud.com`，超时 8 秒。可在 `config.json` 改：

```json
"proxyCheck": { "testUrl": "https://www.huaweicloud.com", "timeoutMs": 8000 }
```

## 停用 / 删除

- 停用：`PATCH /panel/proxies/<id>` body `{"enabled":false}` — 保留配置但不参与轮询
- 删除：`DELETE /panel/proxies/<id>` — **绑定它的账号会自动解绑**

## 存储

`data/settings.json` 的 `proxies` 数组：

```json
{
  "id": "px_1a2b3c",
  "url": "http://user:pass@1.2.3.4:8080",
  "protocol": "http",
  "host": "1.2.3.4",
  "port": 8080,
  "username": "user",
  "password": "pass",
  "label": "1.2.3.4:8080",
  "enabled": true,
  "note": "",
  "createdAt": "2026-10-29T08:00:00.000Z",
  "lastCheckAt": null,
  "lastCheckOk": null,
  "lastCheckMs": null,
  "lastError": null
}
```

账号里存 `proxy` 字段（代理的 url）。

## 安全

面板 API 返回的是 `maskedUrl`（密码打码成 `******`），
真实密码只在服务端使用，不下发到浏览器。

## 代码

- `lib/proxy-pool.mjs` — `parseProxyLine` / `parseProxyList` / `proxyId` / `maskProxyUrl` / `pickProxy` / `checkProxy`
- `lib/panel.mjs` — `addProxies` / `updateProxy` / `deleteProxy` / `setAccountProxy` / `publicProxies`
- `tools/test-proxy-pool.mjs` — 46 项断言

## 测试

```
npm run test:proxy
```
