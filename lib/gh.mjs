// GitHub 侧的最小客户端：REST 读取 + tarball 下载 + 设备码登录（登录链接授权）
// 走 lib/transport.mjs，所以能带出口代理；不引第三方依赖
import fs from 'node:fs';
import path from 'node:path';
import { createTransport } from './transport.mjs';

const UA = 'kio-code-gateway-updater';

export class GithubError extends Error {
  constructor(message, { status = 0, code = 'github_error', body = '' } = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const trimBase = (v) => String(v ?? '').replace(/\/+$/, '');

export function createGithub({ cfg = {}, dataDir, log = () => {} } = {}) {
  const gh = cfg.github ?? {};
  const apiBase = trimBase(gh.apiBase ?? 'https://api.github.com');
  const webBase = trimBase(gh.webBase ?? 'https://github.com');
  const codeloadBase = trimBase(gh.codeloadBase ?? 'https://codeload.github.com');
  const repo = gh.repo ?? 'kiolhy/kio-code';
  const branch = gh.branch ?? 'main';
  const proxy = gh.proxy || '';
  const tokenFile = path.join(dataDir ?? '.', 'gh-token.json');
  const transport = createTransport({});

  async function raw(url, { method = 'GET', headers = {}, body, timeoutMs = 25000 } = {}) {
    let res;
    try {
      res = await transport.request({ url, method, headers: { 'user-agent': UA, ...headers }, body, proxy, timeoutMs });
    } catch (e) {
      throw new GithubError(`请求 GitHub 失败：${e?.message ?? e}`, { code: e?.code ?? 'network_error' });
    }
    const buf = await res.buffer();
    return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8') };
  }

  function authHeaders(extra = {}) {
    const t = readToken();
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(t?.token ? { authorization: `Bearer ${t.token}` } : {}),
      ...extra,
    };
  }

  async function json(url, opts = {}) {
    const r = await raw(url, { ...opts, headers: authHeaders(opts.headers) });
    let parsed = null;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      /* 非 JSON（比如网关错误页） */
    }
    if (r.status < 200 || r.status >= 300) {
      const msg = parsed?.message ?? r.text.slice(0, 200) ?? `HTTP ${r.status}`;
      throw new GithubError(msg, { status: r.status, code: parsed?.error ?? 'http_error', body: r.text });
    }
    return parsed;
  }

  /* ---------------- token 存取 ---------------- */

  function readToken() {
    if (gh.token) return { token: gh.token, source: 'config' };
    const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (env) return { token: env, source: 'env' };
    try {
      const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (saved?.token) return { ...saved, source: 'device-flow' };
    } catch {
      /* 没存过 */
    }
    return null;
  }

  function saveToken({ token, scope, login }) {
    if (!token) throw new GithubError('空 token', { code: 'empty_token' });
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const payload = { token, scope: scope ?? null, login: login ?? null, savedAt: new Date().toISOString() };
    fs.writeFileSync(tokenFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(tokenFile, 0o600);
    } catch {
      /* Windows 上忽略 */
    }
    log('info', `GitHub token 已保存（${scope ?? 'scope 未知'}）`);
    return { ...payload, source: 'device-flow' };
  }

  function clearToken() {
    try {
      fs.rmSync(tokenFile, { force: true });
    } catch {
      /* 忽略 */
    }
  }

  const maskedToken = () => {
    const t = readToken();
    if (!t?.token) return null;
    return `${t.token.slice(0, 4)}…${t.token.slice(-4)}`;
  };

  /* ---------------- 读仓库 ---------------- */

  async function repoInfo() {
    return json(`${apiBase}/repos/${repo}`);
  }

  async function latestCommits(limit = 10) {
    return json(`${apiBase}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`);
  }

  async function downloadTarball(sha, { maxBytes = 64 * 1024 * 1024 } = {}) {
    const r = await raw(`${codeloadBase}/${repo}/tar.gz/${sha}`, {
      headers: authHeaders({ accept: 'application/vnd.github+json' }),
      timeoutMs: 120000,
    });
    if (r.status !== 200) {
      throw new GithubError(`下载更新包失败：HTTP ${r.status}`, { status: r.status, code: 'download_failed' });
    }
    if (r.buf.length > maxBytes) {
      throw new GithubError(`更新包过大：${r.buf.length}B > ${maxBytes}B`, { code: 'too_large' });
    }
    return r.buf;
  }

  /* ---------------- 设备码登录（登录链接授权） ---------------- */

  async function startDeviceFlow({ scope = 'repo', clientId } = {}) {
    const id = clientId || gh.clientId || process.env.GH_CLIENT_ID;
    if (!id) {
      throw new GithubError('没有配置 GitHub OAuth App 的 client_id', { code: 'no_client_id', status: 400 });
    }
    const body = new URLSearchParams({ client_id: id, scope }).toString();
    const r = await raw(`${webBase}/login/device/code`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    let data = null;
    try {
      data = JSON.parse(r.text);
    } catch {
      /* 下面统一报错 */
    }
    if (r.status !== 200 || !data?.device_code) {
      throw new GithubError(data?.error_description ?? `设备码申请失败：HTTP ${r.status}`, {
        status: r.status,
        code: data?.error ?? 'device_code_failed',
      });
    }
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri ?? `${webBase}/login/device`,
      expiresIn: data.expires_in ?? 900,
      interval: data.interval ?? 5,
    };
  }

  async function pollDeviceFlow(deviceCode, { clientId } = {}) {
    const id = clientId || gh.clientId || process.env.GH_CLIENT_ID;
    if (!id) throw new GithubError('没有配置 client_id', { code: 'no_client_id', status: 400 });
    const body = new URLSearchParams({
      client_id: id,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).toString();
    const r = await raw(`${webBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    let data = null;
    try {
      data = JSON.parse(r.text);
    } catch {
      /* 下面统一报错 */
    }
    if (data?.access_token) {
      saveToken({ token: data.access_token, scope: data.scope });
      return { status: 'success', scope: data.scope ?? null };
    }
    const err = data?.error ?? 'unknown_error';
    if (err === 'authorization_pending') return { status: 'pending' };
    if (err === 'slow_down') return { status: 'slow_down', interval: (data.interval ?? 5) + 5 };
    if (err === 'expired_token') return { status: 'expired' };
    if (err === 'access_denied') return { status: 'denied' };
    throw new GithubError(data?.error_description ?? `轮询失败：HTTP ${r.status}`, {
      status: r.status,
      code: err,
    });
  }

  return {
    repo,
    branch,
    apiBase,
    webBase,
    codeloadBase,
    proxy,
    clientId: gh.clientId || process.env.GH_CLIENT_ID || null,
    readToken,
    saveToken,
    clearToken,
    maskedToken,
    repoInfo,
    latestCommits,
    downloadTarball,
    startDeviceFlow,
    pollDeviceFlow,
  };
}
