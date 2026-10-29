# 在线更新与 GitHub 授权

面板「维护」页提供两个能力：

1. **在线更新**：检测 GitHub 仓库的新提交 → 下载 tarball → 校验 → 备份 → 换文件 → 重启生效，可回滚。
2. **GitHub 授权**：设备码登录（生成链接 + 8 位码），或手动粘贴 token，供私有仓库 / 提高 API 限额使用。

## 为什么这么做

- 镜像里没有 `.git`，靠 `build-info.json`（构建时写入）判断「我现在是哪个提交」。
- 更新只替换代码文件，**绝不覆盖** `config.json` 和 `data/`（账号、Key、用量、日志）。
- 换文件前先跑 `node --check` 校验所有 `.mjs`，有语法错误就整体放弃，不碰现有代码。
- 每次更新都先把当前代码备份到 `data/update/backup-<时间戳>/`，随时能一键回滚。
- 解包强制路径安全：拒绝绝对路径与 `../` 穿越。

## 工作流

```
检查更新  GET  /panel/api/update          (状态)
          POST /panel/api/update/check    (拉最新提交对比)
一键更新  POST /panel/api/update/apply    (下载→校验→备份→替换)
回滚      POST /panel/api/update/rollback (恢复最近一次备份)
重启      POST /panel/api/update/restart  (退出进程，交给 docker/systemd 拉起)
```

更新完成后必须重启才生效：容器用 `restart: unless-stopped`（`docker compose` 自带），裸机建议挂在 systemd 的 `Restart=always` 下。

## GitHub 授权

公开仓库（默认 `kiolhy/kio-code`）不需要任何授权；私有仓库或想提高 API 限额（未授权 60 次/小时，授权后 5000 次/小时）时才需要。

三种方式（优先级从高到低）：

| 来源 | 说明 |
|---|---|
| `config.github.token` | 写死在配置里，不建议（配置可能被分享） |
| 环境变量 `GITHUB_TOKEN` / `GH_TOKEN` | 适合 systemd / compose secrets |
| 设备码登录 | 面板点「生成登录链接」，存到 `data/gh-token.json`（0600） |

### 设备码登录需要 OAuth App

GitHub 的设备码接口需要一个 OAuth App 的 `client_id`：

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. 名称随意，Authorization callback URL 填 `http://127.0.0.1:8787/callback`（不会被用到，占位即可）
3. 把 Client ID 填进 `config.json → github.clientId`（或环境变量 `GH_CLIENT_ID`），重启
4. 面板「维护 → 生成登录链接」→ 打开链接输码 → 授权

> 为什么不能内置 client_id：GitHub 要求 OAuth App 归属明确，内置一个公开的 ID 任何人都能顶替授权、风险不可控。没有 client_id 时设备码接口会明确报 `no_client_id`。

## 配置参考

```jsonc
{
  "github": {
    "repo": "kiolhy/kio-code",          // 仓库 owner/name
    "branch": "main",
    "clientId": "",                      // 设备码登录需要，公开仓库可留空
    "apiBase": "https://api.github.com",
    "webBase": "https://github.com",
    "codeloadBase": "https://codeload.github.com",
    "proxy": "",                         // GitHub 不可达时走出口代理 http://host:port
    "token": ""                          // 可选，不推荐直接写
  },
  "update": {
    "enabled": true,
    "allowApply": true,                  // false 时面板只能看，不能换文件
    "autoCheckMs": 21600000,             // 6 小时自动检查一次，只记录不自动更新
    "checkCommits": 10                   // 检查时取最近 N 条提交做 changelog
  }
}
```

## 构建信息

- 本地源码部署：读 `.git/HEAD`，无需配置。
- Docker 构建：`Dockerfile` 接受 `--build-arg GIT_SHA=…`，写入 `/app/build-info.json`。
- `docker compose build` 会透传 `GIT_SHA` 环境变量（`GIT_SHA=xxx docker compose build`）。
- 在线更新成功后，会重写 `build-info.json` 指向新提交，后续检查基于新基线。

## 检查更新报 502 怎么办

`check_failed / HTTP 502` 只有一个原因：**服务器连不上 `api.github.com`**（DNS 被污染、出网被封、TLS 被重置）。
不是仓库问题，也不是权限问题（公开仓库不需要 token）。

三条出路，按省事程度排：

### 1. 给出口加代理（最干净）

```jsonc
"github": { "proxy": "http://127.0.0.1:7890" }
```

`github.proxy` 同时作用于 API、tarball 下载和面板里的设备码登录。

### 2. 面板「从 URL 更新」（不依赖 GitHub API）

维护 → 版本与更新 → 填一个能下载到的 tar.gz 地址 → 「从 URL 更新」：

```
https://ghfast.top/https://github.com/kiolhy/kio-code/archive/<sha>.tar.gz
```

后端是 `POST /panel/api/update/from-url`，参数 `{ "url": "...", "sha": "可选" }`。
下载 → `node --check` 校验 → 备份 → 换文件，流程与「一键更新」完全一致；URL 里带 40 位 sha 会自动识别成目标版本。
只接受 `http://` / `https://`，大小上限 64MB，`config.json` 与 `data/` 同样不会被覆盖。

### 3. 手动 bootstrap（连「从 URL 更新」都还没用上的时候）

老版本没有 from-url 入口，先在服务器上手动换一次文件：

```bash
cd /path/to/kio-code-gateway
SHA=<40位sha>
curl -fL -o /tmp/kio.tar.gz "https://ghfast.top/https://github.com/kiolhy/kio-code/archive/$SHA.tar.gz"
rm -rf /tmp/kio && mkdir -p /tmp/kio && tar xzf /tmp/kio.tar.gz -C /tmp/kio
SRC=$(ls -d /tmp/kio/kio-code-*)
cp -a "$SRC/server.mjs" "$SRC/package.json" "$SRC/README.md" "$SRC/LICENSE" . 2>/dev/null
cp -a "$SRC/lib" "$SRC/public" "$SRC/tools" "$SRC/docs" "$SRC/.github" . 2>/dev/null
node --check server.mjs && echo "语法 OK"
# config.json 与 data/ 没动过，重启服务即可
```

镜像可用性实测（2026-10）：`ghfast.top` ✅、`codeload.github.com` 直连 ✅（境外）、
`gh-proxy.com` ⚠️（共享 IP 会撞 API 限流）、`api.kkgithub.com` ❌、`ghproxy.net` ❌。

## 做不到 / 注意

- 更新是「整体换文件」，不是 git merge：本地改过的代码会被覆盖（配置和数据不受影响）。本地二开请以提交为准，别只改文件不提交。
- 只做语法级校验（`node --check`），不跑测试。跑不跑得起来最终靠 CI 和重启后的健康检查兜底。
- 换文件不中断正在运行的进程；**重启**才生效。
- GitHub 被墙时走 `github.proxy`；设备码登录的 `github.com` 端点同样需要代理可达。

## 测试

```bash
npm run test:update   # 42 项：check/apply/回滚/语法与缺文件兜底/从 URL 更新/设备码/token
```

`tools/test-update.mjs` 用本地假 GitHub 服务器 + 临时目录跑全程，不碰真实网络、不碰真实仓库。
