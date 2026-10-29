#!/usr/bin/env node
// mock-hub —— 码道 CLI（codeartsdoer）后端完整模拟 / 反向代理网关
// 零依赖，Node >= 20。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore, maskHeaders, maskValue } from './lib/store.mjs';
import { buildHandlers, streamOpenAI, streamAnthropic, handleOtlp } from './lib/mock.mjs';
import { proxyToUpstream } from './lib/proxy.mjs';
import { buildRipgrepStubZip } from './lib/zip.mjs';
import { createPanel } from './lib/panel.mjs';
import {
  forwardChatOnce,
  forwardChatStream,
  anthropicToOpenAI,
  openAIToAnthropic,
  pickCredentials,
} from './lib/gateway.mjs';
import { verifyRequest, parseAuthorization } from './lib/sign.mjs';
import { createGovernor, parseRetryAfter } from './lib/pacing.mjs';
import { resolveProfile, findIdentityLeaks } from './lib/stealth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.MOCK_HUB_CONFIG || path.join(__dirname, 'config.json');
const DATA_DIR = process.env.MOCK_HUB_DATA || path.join(__dirname, 'data');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // 兼容两种写法：MOCK_HUB_* 与容器里常见的 HOST/PORT
  if (process.env.MOCK_HUB_PORT ?? process.env.PORT) cfg.port = Number(process.env.MOCK_HUB_PORT ?? process.env.PORT);
  if (process.env.MOCK_HUB_HOST ?? process.env.HOST) cfg.host = process.env.MOCK_HUB_HOST ?? process.env.HOST;
  if (process.env.MOCK_HUB_MODE) cfg.mode = process.env.MOCK_HUB_MODE;
  if (process.env.MOCK_HUB_UPSTREAM) cfg.upstream.baseUrl = process.env.MOCK_HUB_UPSTREAM;

  cfg.gateway = cfg.gateway ?? {};
  if (process.env.MOCK_HUB_GATEWAY_REGION) cfg.gateway.defaultRegion = process.env.MOCK_HUB_GATEWAY_REGION;
  cfg.gateway.regions = cfg.gateway.regions ?? {};
  if (process.env.MOCK_HUB_GATEWAY_CN) cfg.gateway.regions.cn = process.env.MOCK_HUB_GATEWAY_CN;
  if (process.env.MOCK_HUB_GATEWAY_INTL) cfg.gateway.regions.intl = process.env.MOCK_HUB_GATEWAY_INTL;
  if (process.env.MOCK_HUB_GATEWAY_MODELS) {
    cfg.gateway.models = process.env.MOCK_HUB_GATEWAY_MODELS.split(',').map((s) => s.trim()).filter(Boolean);
  }

  /* 出站指纹 / 节流：部署在服务器上时这些基本都靠环境变量给 */
  cfg.stealth = cfg.stealth ?? {};
  cfg.stealth.profile = cfg.stealth.profile ?? {};
  cfg.stealth.egress = cfg.stealth.egress ?? {};
  if (process.env.MOCK_HUB_EGRESS_PROXY) cfg.stealth.egress.proxy = process.env.MOCK_HUB_EGRESS_PROXY;
  if (process.env.MOCK_HUB_UA) cfg.stealth.profile.userAgent = process.env.MOCK_HUB_UA;
  if (process.env.MOCK_HUB_CLIENT_IP) cfg.stealth.profile.clientIp = process.env.MOCK_HUB_CLIENT_IP;
  if (process.env.MOCK_HUB_DEPART) cfg.stealth.profile.department = process.env.MOCK_HUB_DEPART;
  if (process.env.MOCK_HUB_CURRENT_USER) cfg.stealth.profile.currentUser = process.env.MOCK_HUB_CURRENT_USER;
  if (process.env.MOCK_HUB_CONCURRENCY) {
    cfg.stealth.pacing = { ...(cfg.stealth.pacing ?? {}), maxConcurrentPerAccount: Number(process.env.MOCK_HUB_CONCURRENCY) || 1 };
  }
  return cfg;
}

let cfg = loadConfig();
const store = createStore({ dataDir: DATA_DIR, maxRecords: cfg.telemetry?.maxRecords ?? 5000 });
const panel = createPanel({ dataDir: DATA_DIR });
const handlers = buildHandlers(cfg, store);
// 出站节流：账号级并发/间隔/冷却，形状见 lib/pacing.mjs
const governor = createGovernor({ cfg });

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log('warn', `保存配置失败: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.MOCK_HUB_LOG_LEVEL ?? 'info'] ?? 20;

function log(level, msg, extra) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  const t = new Date().toISOString().slice(11, 23);
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  process.stdout.write(`${t} ${level.toUpperCase().padEnd(5)} ${msg}${tail}\n`);
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

const R = (src) => new RegExp(src, 'i');

const ROUTES = [
  /* ---- 模型网关 / inferhub ---- */
  { id: 'inferhub.chat', methods: ['POST'], re: R('^/(?:api/v2/)?(?:v1/)?chat/completions/?$'), proxyable: true },
  { id: 'anthropic.messages', methods: ['POST'], re: R('^/(?:api/v2/)?v1/messages/?$'), proxyable: true },
  { id: 'inferhub.models', methods: ['GET'], re: R('^/(?:api/v2/)?v1/models/?$'), proxyable: true },
  { id: 'inferhub.thinkingVariants', methods: ['POST'], re: R('^/(?:api/v2/)?v1/model/thinking-variants/?$') },

  /* ---- agent-center ---- */
  { id: 'agentCenter.list', methods: ['GET'], re: R('^/(?:api/v2/)?v1/agent-center/agents/useragents/?$'), proxyable: true },
  { id: 'session.create', methods: ['POST'], re: R('^/(?:api/v2/)?v1/sessions/?$') },
  { id: 'session.check', methods: ['GET'], re: R('^/(?:api/v2/)?v1/sessions/?$') },
  { id: 'agentCenter.detail', methods: ['GET'], re: R('^/(?:api/v2/)?v1/agent-center/agents/detail/?$'), proxyable: true },
  { id: 'agentCenter.builtinTools', methods: ['GET'], re: R('^/(?:api/v2/)?v1/agent-center/built-in-tools/?$') },
  { id: 'agentCenter.skillsRules', methods: ['GET', 'POST'], re: R('^/(?:api/v2/)?v1/skills-rules/list/?$') },
  { id: 'agentCenter.gatewayConfig', methods: ['GET'], re: R('^/(?:api/v2/)?v1/gateway-config/?$') },
  { id: 'agentCenter.skillsQuery', methods: ['POST', 'GET'], re: R('^/(?:api/v2/)?mcpService/external/skills/v1/query/?$') },
  { id: 'agentCenter.skillsLink', methods: ['GET'], re: R('^/(?:api/v2/)?mcpService/external/skills/link/v1/get/?$') },

  /* ---- benefit-service ---- */
  { id: 'benefit.claim', methods: ['POST'], re: R('^/api/v1/benefit/claim/?$') },
  { id: 'benefit.balance', methods: ['GET'], re: R('^/api/v1/user/tokens/balance/?$') },
  { id: 'benefit.gatewayConfig', methods: ['GET'], re: R('^/api/v1/gateway/config/?$') },

  /* ---- snap-manager ---- */
  { id: 'snap.currentUser', methods: ['GET'], re: R('^/snap-manager/v1/current/user/?$') },
  { id: 'snap.privacy', methods: ['GET'], re: R('^/snap-manager/v1/privacy/?$') },
  { id: 'snap.heartbeat', methods: ['PUT', 'POST'], re: R('^/snap-manager/v1/chat-session/heartbeat/?$') },
  { id: 'snap.pluginStatistics', methods: ['GET'], re: R('^/snap-manager/v1/statistics/plugin/?$') },
  { id: 'snap.skillPublish', methods: ['POST'], re: R('^/snap-manager/v1/skill/publish/?$') },
  { id: 'snap.skillComplete', methods: ['POST'], re: R('^/snap-manager/v1/skill/complete/?$') },
  { id: 'snap.skillSubmissions', methods: ['GET'], re: R('^/snap-manager/v1/skill/submissions/?$') },

  /* ---- prompt-center ---- */
  { id: 'prompt.builtinModel', methods: ['GET'], re: R('^/v1/model/builtin/?$') },
  { id: 'prompt.retrieve', methods: ['POST'], re: R('^/PromptCenterService/v1/prompts/retrieve/?$') },
  { id: 'prompt.featureToggle', methods: ['POST'], re: R('^/PromptCenterService/v1/policy/feature-toggle/?$') },

  /* ---- memory ---- */
  { id: 'memory.listPreferences', methods: ['GET'], re: R('^/v1/[^/]+/preferences/?$') },
  { id: 'memory.addPreference', methods: ['POST'], re: R('^/v1/[^/]+/preferences/?$') },
  { id: 'memory.getPreference', methods: ['GET'], re: R('^/v1/[^/]+/preferences/[^/]+/?$') },
  { id: 'memory.updatePreference', methods: ['PUT'], re: R('^/v1/[^/]+/preferences/[^/]+/?$') },
  { id: 'memory.deletePreference', methods: ['DELETE'], re: R('^/v1/[^/]+/preferences/[^/]+/?$') },

  /* ---- codebase ---- */
  { id: 'codebase.list', methods: ['GET'], re: R('^/codebaseservice/v1/codebases/?$') },
  { id: 'codebase.create', methods: ['POST'], re: R('^/codebaseservice/v1/codebases/?$') },
  { id: 'codebase.uploadIndex', methods: ['POST', 'PUT'], re: R('^/codebaseservice/v1/codebases/[^/]+/tasks/[^/]+/index/?$') },
  { id: 'codebase.taskProcess', methods: ['GET', 'POST'], re: R('^/codebaseservice/v1/codebases/[^/]+/tasks/[^/]+/?$') },
  { id: 'codebase.taskProgress', methods: ['GET'], re: R('^/codebaseservice/v1/codebases/[^/]+/tasks/[^/]+/progress/?$') },
  { id: 'codebase.taskFiles', methods: ['GET'], re: R('^/codebaseservice/v1/codebases/[^/]+/tasks/[^/]+/files/?$') },
  { id: 'codebase.search', methods: ['POST'], re: R('^/codebaseservice/v1/codebases/[^/]+/codenodes/search/?$') },
  { id: 'codebase.graphSearch', methods: ['POST'], re: R('^/codebaseservice/v1/codebases/[^/]+/graph/search/?$') },
  { id: 'codebase.embedding', methods: ['POST'], re: R('^/codebaseservice/v1/codebases/vector/embedding/?$') },
  { id: 'codebase.rerank', methods: ['POST'], re: R('^/codebaseservice/v1/codebases/vector/rerank/?$') },
  { id: 'codebase.branches', methods: ['POST'], re: R('^/parsetaskmgt/api/v1/groupRepoBranch/queryBranchTreeV2/?$') },
  { id: 'codebase.index', methods: ['POST'], re: R('^/v1/index/?$') },

  /* ---- 其它 ---- */
  { id: 'release.latest', methods: ['GET'], re: R('^/v1/release-info/latest/?$') },
  { id: 'oauth.tokens', methods: ['POST'], re: R('^/v1/oauth2/tokens/?$') },
  { id: 'ops.creditUsage', methods: ['GET'], re: R('^/v1/ops/credit/usage/?$') },
  { id: 'skills.list', methods: ['GET'], re: R('^/v1/skills/?$') },
];

const OTLP_ROUTES = [
  { re: R('^(?:/collector)?/v1/logs/?$'), kind: 'logs' },
  { re: R('^(?:/collector)?/v1/traces/?$'), kind: 'traces' },
  { re: R('^/collector/v1/metrics/?$'), kind: 'metrics' },
];

/* ------------------------------------------------------------------ */
/* 请求体读取                                                          */
/* ------------------------------------------------------------------ */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body_too_large'), { code: 'BODY_TOO_LARGE', size }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(raw, headers) {
  if (!raw || raw.length === 0) return undefined;
  const ct = String(headers['content-type'] ?? '');
  if (ct.includes('json') || ct.includes('text/')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return undefined;
    }
  }
  if (ct.includes('x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 响应工具                                                            */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
  return body.length;
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
  return body.length;
}

/* ---------- 面板辅助 ---------- */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token) {
  return `mockhub_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`;
}

function clearSessionCookie() {
  return 'mockhub_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

function redirectTo(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

function serveHtml(res, name) {
  const file = path.join(__dirname, 'public', name);
  if (!fs.existsSync(file)) return void sendText(res, 404, `${name} 缺失`);
  return void sendText(res, 200, fs.readFileSync(file, 'utf8'), 'text/html; charset=utf-8');
}

async function handleLogin(req, res) {
  let body = {};
  try {
    const raw = await readBody(req, 65536);
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return void sendJson(res, 400, { error: { code: 'bad_request', message: '请求体不是合法 JSON' } });
  }
  if (!panel.verifyPassword(body.password)) {
    return void sendJson(res, 401, { error: { code: 'bad_password', message: '面板密码错误' } });
  }
  const token = panel.createSession();
  panel.pruneSessions();
  return void sendJson(
    res,
    200,
    { ok: true, changed: panel.passwordChanged() },
    { 'set-cookie': sessionCookie(token) }
  );
}

const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 码道网关</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--accent:#2f81f7;--err:#f85149}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.card{width:340px;padding:28px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
h1{margin:0 0 6px;font-size:17px;font-weight:600}
p.sub{margin:0 0 20px;color:var(--dim);font-size:12px}
label{display:block;margin-bottom:6px;font-size:12px;color:var(--dim)}
input{width:100%;padding:9px 11px;background:#0d1117;border:1px solid var(--line);border-radius:7px;
color:var(--fg);font-size:14px;outline:none}
input:focus{border-color:var(--accent)}
button{width:100%;margin-top:16px;padding:9px;background:var(--accent);border:0;border-radius:7px;
color:#fff;font-size:14px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.err{margin-top:12px;color:var(--err);font-size:12px;min-height:16px}
</style></head><body>
<form class="card" id="f">
  <h1>码道网关</h1>
  <p class="sub">输入面板访问密码</p>
  <label for="p">面板密码</label>
  <input id="p" type="password" autocomplete="current-password" placeholder="默认 admin" autofocus>
  <button id="b" type="submit">登录</button>
  <div class="err" id="e"></div>
</form>
<script>
const f=document.getElementById('f'),p=document.getElementById('p'),b=document.getElementById('b'),e=document.getElementById('e');
f.addEventListener('submit',async(ev)=>{
  ev.preventDefault();e.textContent='';b.disabled=true;
  try{
    const r=await fetch('/panel/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p.value})});
    if(r.ok){const next=new URLSearchParams(location.search).get('next')||'/';location.href=next;return}
    const j=await r.json().catch(()=>({}));
    e.textContent=j?.error?.message||'登录失败';
  }catch(err){e.textContent='网络错误：'+err.message}
  finally{b.disabled=false}
});
</script></body></html>`;

async function handlePanelApi(req, res, url, method, reqId, started) {
  const p = url.pathname.replace(/^\/panel\/api/, '');
  const seg = p.split('/').filter(Boolean);

  try {
    /* ---- 会话 ---- */
    if (p === '/session') {
      return void sendJson(res, 200, {
        ok: true,
        passwordChanged: panel.passwordChanged(),
        settings: panel.settings(),
      });
    }

    if (p === '/password' && method === 'POST') {
      const body = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
      panel.setPassword(body.password);
      return void sendJson(res, 200, { ok: true });
    }

    /* ---- 概览 ---- */
    if (p === '/overview') {
      const snap = store.snapshot();
      const range = url.searchParams.get('range') ?? 'today';
      const agg = panel.aggregate({ range });
      return void sendJson(res, 200, {
        ok: true,
        mode: cfg.mode,
        uptimeSec: snap.uptimeSec,
        rssMb: snap.rssMb,
        counters: snap.counters,
        accounts: {
          total: panel.accounts().length,
          enabled: panel.accounts().filter((a) => a.enabled !== false).length,
          expired: panel.accounts().filter((a) => a.expiresAt && new Date(a.expiresAt).getTime() < Date.now()).length,
        },
        keys: {
          total: panel.keys().filter((k) => !k.deletedAt).length,
          enabled: panel.keys().filter((k) => !k.deletedAt && k.enabled !== false).length,
        },
        usage: agg,
      });
    }

    /* ---- 账号 ---- */
    if (p === '/accounts' && method === 'GET') {
      return void sendJson(res, 200, { ok: true, accounts: panel.publicAccounts() });
    }

    if (p === '/accounts' && method === 'POST') {
      const body = JSON.parse((await readBody(req, 1048576)).toString('utf8') || '{}');
      if (!body.accessKeyId && body.authType !== 'oauth') {
        return void sendJson(res, 400, { error: { code: 'missing_credential', message: '缺少 accessKeyId' } });
      }
      const acc = panel.addAccount(body);
      return void sendJson(res, 200, { ok: true, account: publicAccountSafe(acc) });
    }

    if (seg[0] === 'accounts' && seg[1] && method === 'PATCH') {
      const body = JSON.parse((await readBody(req, 1048576)).toString('utf8') || '{}');
      const acc = panel.updateAccount(seg[1], body);
      if (!acc) return void sendJson(res, 404, { error: { code: 'not_found' } });
      return void sendJson(res, 200, { ok: true, account: publicAccountSafe(acc) });
    }

    if (seg[0] === 'accounts' && seg[1] && method === 'DELETE') {
      const okDel = panel.deleteAccount(seg[1]);
      return void sendJson(res, okDel ? 200 : 404, { ok: okDel });
    }

    /* ---- API Key ---- */
    if (p === '/keys' && method === 'GET') {
      return void sendJson(res, 200, { ok: true, keys: panel.publicKeys() });
    }

    if (p === '/keys' && method === 'POST') {
      const body = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
      const k = panel.addKey(body);
      return void sendJson(res, 200, { ok: true, key: k });
    }

    if (seg[0] === 'keys' && seg[1] && method === 'PATCH') {
      const body = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
      const k = panel.updateKey(seg[1], body);
      if (!k) return void sendJson(res, 404, { error: { code: 'not_found' } });
      return void sendJson(res, 200, { ok: true, key: { ...k, key: k.key } });
    }

    if (seg[0] === 'keys' && seg[1] && method === 'DELETE') {
      const okDel = panel.deleteKey(seg[1]);
      return void sendJson(res, okDel ? 200 : 404, { ok: okDel });
    }

    /* ---- 用量 ---- */
    if (p === '/usage') {
      const range = url.searchParams.get('range') ?? 'today';
      return void sendJson(res, 200, {
        ok: true,
        ...panel.aggregate({
          range,
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
        }),
      });
    }

    /* ---- 设置 ---- */
    if (p === '/settings' && method === 'GET') {
      return void sendJson(res, 200, {
        ok: true,
        settings: panel.settings(),
        panel: { passwordChanged: panel.passwordChanged() },
      });
    }

    if (p === '/settings' && method === 'PATCH') {
      const body = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
      return void sendJson(res, 200, { ok: true, settings: panel.updateSettings(body) });
    }

    /* ---- 运行日志 ---- */
    if (p === '/logs') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 2000);
      const logDir = path.join(DATA_DIR, '..');
      const files = [
        path.join(DATA_DIR, 'server.log'),
        path.join(DATA_DIR, 'server.err.log'),
        path.join(DATA_DIR, 'egress-proxy.log'),
      ];
      const out = [];
      for (const f of files) {
        if (!fs.existsSync(f)) continue;
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-limit);
        out.push({ file: path.basename(f), lines });
      }
      return void sendJson(res, 200, { ok: true, logs: out });
    }

    /* ---- 请求流水（面板用） ---- */
    if (p === '/requests') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
      const snap = store.snapshot();
      return void sendJson(res, 200, { ok: true, requests: snap.requests.slice(0, limit) });
    }

    return void sendJson(res, 404, { error: { code: 'unknown_endpoint', path: p } });
  } catch (e) {
    return void sendJson(res, 500, { error: { code: 'panel_error', message: String(e?.message ?? e) } });
  }
}

/** 上游错误 → 客户端状态码 */
function gatewayErrorStatus(e) {
  const map = {
    no_credentials: 503,
    account_cooldown: 429,
    gateway_busy: 503,
    ETIMEDOUT: 504,
    proxy_error: 502,
    proxy_connect_failed: 502,
    fingerprint_leak: 500,
  };
  return map[e?.code] ?? 502;
}

/**
 * 一次上游调用的重试 + 轮换：命中 rotateOnStatus 就换下一个账号再试一遍。
 * 流式请求只有在还没写响应头时才能重试。
 */
async function callUpstreamWithRotation({ body, ctx, stream, res, onUsage }) {
  const st = cfg.stealth ?? {};
  const attempts = Math.max(1, Math.min(5, st.retry?.maxAttempts ?? 3));
  const rotateOn = new Set(st.retry?.rotateOnStatus ?? [401, 403, 429, 500, 502, 503, 504]);
  const tried = [];
  let lastError = null;
  let cooling = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const creds = pickCredentials({ ctx, panel, cfg, exclude: tried });
    if (!creds) {
      if (tried.length === 0) {
        const e = new Error('没有可用账号：请先在控制台添加账号，或配置 upstream.ak/sk');
        e.code = 'no_credentials';
        throw e;
      }
      break;
    }

    // 冷却中的账号直接跳过，让别的账号先顶上
    if (creds.account && governor.isCoolingDown(creds.account)) {
      cooling = creds.account.id;
      tried.push(creds.account.id);
      continue;
    }

    let release;
    try {
      // 账号级并发 / 最小间隔 / 冷却都在这里排队
      release = await governor.acquire(creds.account);
    } catch (e) {
      lastError = e;
      if (creds.account?.id) tried.push(creds.account.id);
      if (e.code === 'account_cooldown') {
        cooling = creds.account?.id ?? null;
        continue;
      }
      break;
    }

    try {
      if (stream) {
        const r = await forwardChatStream({ body, cfg, panel, ctx, res, onUsage, credentials: creds });
        if (r.status === 200 || !rotateOn.has(r.status) || attempt === attempts - 1) return r;
        governor.penalize(creds.account, r.status, parseRetryAfter(r.headers?.['retry-after']));
      } else {
        const r = await forwardChatOnce({ body, cfg, panel, ctx, credentials: creds });
        if (!rotateOn.has(r.status) || attempt === attempts - 1) return r;
        governor.penalize(creds.account, r.status, parseRetryAfter(r.headers?.['retry-after']));
      }
    } catch (e) {
      lastError = e;
      if (res?.headersSent) throw e; // 已经往外吐了字节，重试只会污染响应
      governor.penalize(creds.account, 500, 0);
      if (attempt === attempts - 1) throw e;
    } finally {
      release();
    }

    if (creds.account?.id) tried.push(creds.account.id);
  }

  if (lastError) throw lastError;
  if (cooling) {
    const e = new Error('所有可用账号都在冷却中，稍后再试');
    e.code = 'account_cooldown';
    e.account = cooling;
    throw e;
  }
  const e = new Error('上游轮换失败：没有可继续尝试的账号');
  e.code = 'no_credentials';
  throw e;
}

/** 网关模式：把 OpenAI 兼容请求转发到真实码道上游 */
async function handleGateway(req, res, url, method, headers, reqId, started) {
  const p = url.pathname.replace(/\/+$/, '') || '/v1';

  /* ---- 模型列表 ---- */
  if (p === '/v1/models' && method === 'GET') {
    const gw = cfg.gateway ?? {};
    const list = gw.models ?? (cfg.models ?? []).map((m) => m.model_name).filter(Boolean);
    return void sendJson(res, 200, {
      object: 'list',
      data: list.map((id) => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: gw.owner ?? 'codearts',
      })),
    });
  }

  /* ---- 其余都要读体 ---- */
  let body = {};
  let rawBody = Buffer.alloc(0);
  try {
    rawBody = await readBody(req, cfg.maxBodyBytes ?? 67108864);
    body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
  } catch (e) {
    return void sendJson(res, 400, {
      error: { code: 'bad_request', message: `请求体解析失败: ${e?.message ?? e}` },
    });
  }

  /* ---- 鉴权 ---- */
  const rawKey = (() => {
    const h = headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) return m[1].trim();
    return headers['x-api-key'] ?? headers['api-key'] ?? '';
  })();
  // 网关模式默认强制鉴权（公网部署时不能裸奔），可用 gateway.requireKey=false 显式关闭
  const gwRequireKey = cfg.gateway?.requireKey !== false;
  const enforce = panel.settings().enforceKeys === true || (cfg.mode === 'gateway' && gwRequireKey);
  const verdict = panel.authorize(rawKey, body?.model);
  if (!verdict.ok && enforce) {
    return void sendJson(res, 401, {
      error: { code: verdict.code, message: verdict.message, type: 'invalid_request_error' },
    });
  }

  const ctx = {
    authKey: verdict.ok ? verdict.key : null,
    authAccount: verdict.ok ? panel.pickAccount(verdict.key?.accountRef ?? null) : panel.pickAccount(null),
  };

  const finishUsage = ({ usage, account, model, status, stream }) => {
    panel.recordUsage({
      keyId: ctx.authKey?.id ?? null,
      keyName: ctx.authKey?.name ?? null,
      accountId: account?.id ?? null,
      accountName: account?.name ?? null,
      model: model ?? body?.model ?? 'unknown',
      route: p.includes('messages') ? 'gateway.messages' : 'gateway.chat',
      status: status ?? 200,
      promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      durMs: Date.now() - started,
      stream: !!stream,
    });
    store.recordRequest({
      id: reqId, ts: new Date().toISOString(), method, route: p.includes('messages') ? 'gateway.messages' : 'gateway.chat',
      path: url.pathname, status: status ?? 200, durMs: Date.now() - started, mode: 'gateway',
      reqBytes: rawBody.length, resBytes: 0, host: cfg.gateway?.regions?.cn ?? '',
    }, null);
  };

  /* ---- chat completions ---- */
if (p === '/v1/chat/completions' && method === 'POST') {
  try {
    if (body.stream === true) {
      const r = await callUpstreamWithRotation({
        body, ctx, stream: true, res,
        onUsage: ({ usage, account, model }) => finishUsage({ usage, account, model, status: 200, stream: true }),
      });
      if (r.status !== 200) {
        if (!res.headersSent) {
          return void sendJson(res, r.status, { error: { code: 'upstream_error', message: r.errorText?.slice(0, 2000) } });
        }
        res.end();
        finishUsage({ usage: null, account: r.account, model: body?.model, status: r.status, stream: true });
      }
      return;
    }

    const r = await callUpstreamWithRotation({ body, ctx, stream: false });
    let json;
    try {
      json = JSON.parse(r.body.toString('utf8'));
    } catch {
      return void sendJson(res, 502, {
        error: { code: 'bad_upstream_response', message: r.body.toString('utf8').slice(0, 2000) },
      });
    }
    finishUsage({ usage: json?.usage, account: r.account, model: body?.model, status: r.status, stream: false });
    return void sendJson(res, r.status, json);
  } catch (e) {
    const code = gatewayErrorStatus(e);
    return void sendJson(res, code, {
      error: { code: e?.code ?? 'gateway_error', message: String(e?.message ?? e) },
    });
  }
}

/* ---- Anthropic messages ---- */
if (p === '/v1/messages' && method === 'POST') {
  try {
    const oaBody = anthropicToOpenAI(body);
    // 这里只做「非流式 Anthropic 响应」：上游开流会拿到 SSE，JSON.parse 必然失败，
    // 所以强制走非流式转换。要真流式得单独实现 Anthropic SSE 事件序列。
    oaBody.stream = false;
    const r = await callUpstreamWithRotation({ body: oaBody, ctx, stream: false });
    let json;
    try {
      json = JSON.parse(r.body.toString('utf8'));
    } catch {
      return void sendJson(res, 502, { error: { code: 'bad_upstream_response', message: r.body.toString('utf8').slice(0, 2000) } });
    }
    finishUsage({ usage: json?.usage, account: r.account, model: oaBody.model, status: r.status, stream: false });
    return void sendJson(res, r.status, openAIToAnthropic(json));
  } catch (e) {
    const code = gatewayErrorStatus(e);
    return void sendJson(res, code, { error: { code: e?.code ?? 'gateway_error', message: String(e?.message ?? e) } });
  }
}

  return void sendJson(res, 404, {
    error: {
      code: 'unknown_endpoint',
      message: `网关模式暂不支持 ${method} ${p}`,
      supported: ['GET /v1/models', 'POST /v1/chat/completions', 'POST /v1/messages'],
    },
  });
}

/** 账号对象脱敏（给 API 用） */
function publicAccountSafe(acc) {
  const { secretAccessKey, securityToken, ...rest } = acc;
  return {
    ...rest,
    accessKeyId: rest.accessKeyId ? `${String(rest.accessKeyId).slice(0, 4)}****` : '',
    hasSecret: !!secretAccessKey,
    hasToken: !!securityToken,
  };
}


/* ------------------------------------------------------------------ */
/* 凭证捕获                                                            */
/* ------------------------------------------------------------------ */

function captureCredentials(headers, body, route) {
  if (cfg.captureCredentials === false) return;
  const h = (k) => headers[k.toLowerCase()];
  const meta = { route, seenAt: new Date().toISOString() };

  if (h('x-auth-token')) store.recordCredential('x-auth-token', h('x-auth-token'), meta);
  if (h('x-security-token')) store.recordCredential('x-security-token', h('x-security-token'), meta);
  if (h('cookie')) store.recordCredential('cookie', h('cookie'), meta);

  const auth = parseAuthorization(h('authorization'));
  if (auth) {
    store.recordCredential('ak', auth.ak, { ...meta, note: 'SDK-HMAC-SHA256 Access key' });
    store.recordCredential('authorization', h('authorization'), meta);
  }
  if (h('x-current-user')) store.recordCredential('x-current-user', h('x-current-user'), meta);
  if (h('depart')) store.recordCredential('depart', h('depart'), meta);
  if (body?.token) store.recordCredential('body.token', String(body.token), meta);
  if (body?.userInfo?.accessKeyId) store.recordCredential('body.accessKeyId', body.userInfo.accessKeyId, meta);
}

/* ------------------------------------------------------------------ */
/* 主处理                                                              */
/* ------------------------------------------------------------------ */

const requestHandler = async (req, res) => {
  const started = Date.now();
  const reqId = `req-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(req.url, `http://${req.headers.host ?? `${cfg.host}:${cfg.port}`}`);
  const method = req.method.toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  // 记录来源域名：capture 模式下同一个服务会同时接 127.0.0.1:8787 和 443 的流量
  const ingressHost = (headers.host ?? '').split(':')[0].toLowerCase();
  const ingress = req.socket.encrypted ? 'https' : 'http';

  /* ---------- 面板：登录 / 看板 / 旧 admin ---------- */
  const cookieMap = parseCookies(headers.cookie);
  const sessionToken = cookieMap.mockhub_session;
  const authed = panel.checkSession(sessionToken);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!authed) return void redirectTo(res, '/login');
    return void serveHtml(res, 'dashboard.html');
  }

  if (url.pathname === '/login') {
    if (authed) return void redirectTo(res, '/');
    return void sendText(res, 200, LOGIN_HTML, 'text/html; charset=utf-8');
  }

  if (url.pathname === '/logout') {
    panel.dropSession(sessionToken);
    return void redirectTo(res, '/login', { 'set-cookie': clearSessionCookie() });
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    if (!authed) return void redirectTo(res, '/login?next=/admin');
    return void serveHtml(res, 'admin.html');
  }

  if (url.pathname === '/panel/api/login' && method === 'POST') {
    return void handleLogin(req, res);
  }

  if (url.pathname === '/panel/api/logout' && method === 'POST') {
    panel.dropSession(sessionToken);
    return void sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
  }

  if (url.pathname.startsWith('/panel/api/')) {
    if (!authed) {
      return void sendJson(res, 401, { error: { code: 'unauthorized', message: '请先登录面板' } });
    }
    return void handlePanelApi(req, res, url, method, reqId, started);
  }

  /* 旧面板 API：保持免鉴权，供测试与脚本使用 */
  if (url.pathname.startsWith('/admin/api/')) {
    return handleAdminApi(req, res, url, method, reqId, started);
  }

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    const prof = resolveProfile(cfg);
    return void sendJson(res, 200, {
      ok: true,
      mode: cfg.mode,
      uptimeSec: Math.round(process.uptime()),
      requests: store.counters.requests,
      // 出站视角：部署后先看这里，确认 UA / 代理 / 并发是不是你要的那套
      outbound: {
        client: `${prof.pluginName}/${prof.pluginVersion}`,
        userAgent: prof.userAgent,
        egressProxy: !!(cfg.stealth?.egress?.proxy),
        perAccountConcurrency: cfg.stealth?.pacing?.maxConcurrentPerAccount ?? 1,
        accounts: governor.snapshot().accounts.length,
        leaking: findIdentityLeaks({ 'user-agent': prof.userAgent }).length > 0,
      },
    });
  }

  /* ---------- 网关模式：真实上游（OpenAI 兼容入口） ---------- */
  if (cfg.mode === 'gateway' && (url.pathname === '/v1' || url.pathname.startsWith('/v1/'))) {
    return void handleGateway(req, res, url, method, headers, reqId, started);
  }

  /* ---------- 读体 ---------- */
  let rawBody = Buffer.alloc(0);
  try {
    rawBody = await readBody(req, cfg.maxBodyBytes ?? 67108864);
  } catch (e) {
    store.recordRequest({
      id: reqId, ts: new Date().toISOString(), method, route: 'error', path: url.pathname,
      status: 413, durMs: Date.now() - started, error: e.code ?? 'read_error',
    });
    return void sendJson(res, 413, { error: { code: 'payload_too_large', message: String(e.message) } });
  }

  const body = parseBody(rawBody, headers);
  captureCredentials(headers, body, url.pathname);

  const cleanPath = url.pathname.replace(/^\/api\/v2/, '') || '/';
  const replayOf = headers['x-mock-replay'] || undefined;
  const rawForReplay = { headers, body: rawBody };

  /* ---------- 遥测 ---------- */
  for (const t of OTLP_ROUTES) {
    if (t.re.test(cleanPath)) {
      const out = handleOtlp(
        { url, headers, rawBody, body, host: ingressHost, ingress },
        t.kind,
        cfg,
        store
      );
      const bytes = sendJson(res, 200, out.json ?? {});
      store.recordRequest({
        id: reqId, ts: new Date().toISOString(), method, route: `otlp.${t.kind}`,
        path: url.pathname, status: 200, durMs: Date.now() - started,
        mode: 'mock', reqBytes: rawBody.length, resBytes: bytes,
        contentType: headers['content-type'],
        headers: maskHeaders(pickCliHeaders(headers)),
        ingress,
        host: ingressHost || undefined,
      }, rawForReplay);
      log(
        'info',
        `OTLP ${t.kind} ${rawBody.length}B ← ${headers['content-type'] ?? '?'}` +
          (ingress === 'https' ? ` @${ingressHost}` : '')
      );
      return;
    }
  }

  /* ---------- 插件下载（ripgrep 等） ---------- */
  if (/^\/(?:codearts\/)?codeAgentPlugin\/.+\.zip$/i.test(url.pathname)) {
    const realZip = path.join(__dirname, 'data', 'plugins', 'ripgrep.zip');
    let buf;
    let source;
    try {
      if (fs.existsSync(realZip)) {
        buf = fs.readFileSync(realZip);
        source = 'local-file';
      } else {
        buf = buildRipgrepStubZip();
        source = 'stub';
      }
    } catch (e) {
      buf = buildRipgrepStubZip();
      source = `stub (${e?.message ?? e})`;
    }

    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': buf.length,
      'x-mock-plugin': source,
    });
    res.end(buf);

    store.recordRequest(
      {
        id: reqId, ts: new Date().toISOString(), method, route: 'plugin.download',
        path: url.pathname, status: 200, durMs: Date.now() - started,
        mode: 'mock', reqBytes: rawBody.length, resBytes: buf.length,
        contentType: 'application/zip',
        headers: maskHeaders(pickCliHeaders(headers)),
        ingress,
        host: ingressHost || undefined,
      },
      rawForReplay
    );
    log('info', `插件下载 ${url.pathname} → ${buf.length}B (${source})` + (ingress === 'https' ? ` @${ingressHost}` : ''));
    return;
  }

  /* ---------- mock 下载 / OBS 占位 ---------- */
  if (url.pathname.startsWith('/mock-download/') || url.pathname.startsWith('/mock-obs/')) {
    return void sendJson(res, 200, { ok: true, path: url.pathname });
  }

  /* ---------- 路由匹配 ---------- */
  const route = ROUTES.find((r) => r.methods.includes(method) && r.re.test(cleanPath));

  if (!route) {
    const bytes = sendJson(res, 404, {
      error: {
        code: 'not_found',
        message: `mock-hub 没有为 ${method} ${url.pathname} 定义行为`,
        hint: '在 server.mjs 的 ROUTES 里加一条，或把 mode 改成 proxy',
      },
    });
    store.recordRequest({
      id: reqId, ts: new Date().toISOString(), method, route: 'unmatched', path: url.pathname,
      query: url.search || undefined, status: 404, durMs: Date.now() - started,
      mode: cfg.mode, reqBytes: rawBody.length, resBytes: bytes,
      headers: maskHeaders(pickCliHeaders(headers)),
      bodyPreview: cfg.logBodies ? preview(rawBody) : undefined,
      replayOf,
    }, rawForReplay);
    log('warn', `未匹配 ${method} ${url.pathname}`);
    return;
  }

  /* ---------- 签名校验 ---------- */
  let sigResult = null;
  const hasSig = Boolean(headers.authorization && String(headers.authorization).startsWith('SDK-HMAC'));
  if (cfg.verifySignature && hasSig) {
    sigResult = verifyRequest({
      method,
      url: `${url.protocol}//${headers.host ?? `${cfg.host}:${cfg.port}`}${url.pathname}${url.search}`,
      headers,
      body: rawBody,
      skOf: (ak) => cfg.upstream?.sk || process.env.MOCK_HUB_SK || null,
    });
    if (!sigResult.ok) {
      const bytes = sendJson(res, 401, {
        error: { code: 'SignatureDoesNotMatch', message: sigResult.reason, ak: sigResult.ak },
      });
      store.recordRequest({
        id: reqId, ts: new Date().toISOString(), method, route: route.id, path: url.pathname,
        status: 401, durMs: Date.now() - started, mode: 'mock', signature: sigResult,
        headers: maskHeaders(pickCliHeaders(headers)),
        reqBytes: rawBody.length, replayOf,
      }, rawForReplay);
      log('warn', `签名校验失败 ${route.id}: ${sigResult.reason}`);
      return;
    }
  }

  /* ---------- 错误注入 ---------- */
  const errRate = cfg.simulate?.errorRate ?? 0;
  if (errRate > 0 && Math.random() < errRate) {
    const st = cfg.simulate?.errorStatus ?? 500;
    const bytes = sendJson(res, st, { error: { code: 'InjectedError', message: 'mock-hub 主动注入的故障' } });
    store.recordRequest({
      id: reqId, ts: new Date().toISOString(), method, route: route.id, path: url.pathname,
      status: st, durMs: Date.now() - started, mode: 'mock', injected: true,
      reqBytes: rawBody.length, replayOf,
    }, rawForReplay);
    return;
  }

  if (cfg.simulate?.latencyMs) await sleep(cfg.simulate.latencyMs);

  /* ---------- 反代模式 ---------- */
  if (cfg.mode === 'proxy' && route.proxyable) {
    const r = await proxyToUpstream(
      { req, res, url, method, rawBody, headers },
      cfg
    );
    store.recordRequest({
      id: reqId, ts: new Date().toISOString(), method, route: route.id, path: url.pathname,
      query: url.search || undefined, status: r.status, durMs: Date.now() - started,
      mode: 'proxy', upstream: cfg.upstream.baseUrl,
      reqBytes: rawBody.length, headers: maskHeaders(pickCliHeaders(headers)),
      bodyPreview: cfg.logBodies ? preview(rawBody) : undefined,
      error: r.error, replayOf,
    }, rawForReplay);
    log(r.error ? 'error' : 'info', `PROXY ${method} ${route.id} → ${r.status} ${r.error ?? ''}`);
    return;
  }

  /* ---------- mock 模式 ---------- */
  const handler = handlers[route.id];
  if (!handler) {
    const bytes = sendJson(res, 501, { error: { code: 'no_handler', route: route.id } });
    store.recordRequest({
      id: reqId, ts: new Date().toISOString(), method, route: route.id, path: url.pathname,
      status: 501, durMs: Date.now() - started, mode: 'mock', resBytes: bytes,
      reqBytes: rawBody.length, replayOf,
    }, rawForReplay);
    return;
  }

  let out;
  // 鉴权与归属：只在推理类路由上做，避免影响其它接口
  let authKey = null;
  let authAccount = null;
  let authError = null;
  const isInference = route.id === 'inferhub.chat' || route.id === 'anthropic.messages';
  const enforceKeys = panel.settings().enforceKeys === true;
  if (isInference) {
    const rawKey = (() => {
      const h = headers.authorization ?? '';
      const m = /^Bearer\s+(.+)$/i.exec(h);
      if (m) return m[1].trim();
      return headers['x-api-key'] ?? headers['api-key'] ?? '';
    })();
    const verdict = panel.authorize(rawKey, body?.model);
    if (!verdict.ok) {
      // 未开启强制鉴权时放行，但仍记为匿名，方便本地调试与回归测试
      if (enforceKeys) authError = verdict;
    } else {
      authKey = verdict.key;
      authAccount = panel.pickAccount(verdict.key?.accountRef);
    }
  }

  if (authError) {
    const bytes = sendJson(res, 401, {
      error: { code: authError.code, message: authError.message, type: 'invalid_request_error' },
    });
    store.recordRequest({
      id: reqId, ts: new Date().toISOString(), method, route: route.id, path: url.pathname,
      status: 401, durMs: Date.now() - started, mode: 'mock', resBytes: bytes,
      reqBytes: rawBody.length, replayOf, error: authError.code,
    }, rawForReplay);
    panel.recordUsage({
      keyId: null, keyName: '(被拒绝)', accountId: null, accountName: null,
      model: body?.model ?? 'unknown', route: route.id, status: 401,
      promptTokens: 0, completionTokens: 0, durMs: Date.now() - started, stream: !!body?.stream,
    });
    return;
  }

  try {
    out = handler({
      req, res, url, method, headers, body, rawBody, cfg, store,
      panel, authKey, authAccount, started,
    });
  } catch (e) {
    const bytes = sendJson(res, 500, { error: { code: 'handler_error', message: String(e.message) } });
    store.recordRequest({
      id: reqId, ts: new Date().toISOString(), method, route: route.id, path: url.pathname,
      status: 500, durMs: Date.now() - started, mode: 'mock', error: String(e.message),
      reqBytes: rawBody.length, replayOf,
    }, rawForReplay);
    log('error', `handler 异常 ${route.id}: ${e.message}`);
    return;
  }

  let status = 200;
  let resBytes = 0;

  if (out?.stream) {
    if (route.id === 'inferhub.chat') await streamOpenAI({ res, cfg, body }, out.reply);
    else await streamAnthropic({ res, cfg, body }, out.reply);
    status = 200;
    resBytes = out.reply.length;
    store.counters.chats++;
  } else if (out?.json !== undefined) {
    status = out.status ?? 200;
    resBytes = sendJson(res, status, out.json, out.headers ?? {});
    if (route.id === 'inferhub.chat' || route.id === 'anthropic.messages') store.counters.chats++;
  } else if (out?.text !== undefined) {
    status = out.status ?? 200;
    resBytes = sendText(res, status, out.text, out.contentType);
  } else {
    status = 204;
    res.writeHead(204);
    res.end();
  }

  const entry = {
    id: reqId,
    ts: new Date().toISOString(),
    method,
    route: route.id,
    path: url.pathname,
    query: url.search || undefined,
    status,
    durMs: Date.now() - started,
    mode: 'mock',
    stream: out?.stream ?? undefined,
    model: body?.model ?? headers['model-id'] ?? undefined,
    reqBytes: rawBody.length,
    resBytes,
    signature: sigResult ?? (hasSig ? 'unverified' : undefined),
    headers: maskHeaders(pickCliHeaders(headers)),
    bodyPreview: cfg.logBodies ? preview(rawBody) : undefined,
    replayOf,
    ingress,
    host: ingressHost || undefined,
  };
  store.recordRequest(entry, rawForReplay);
  log(
    'info',
    `${method} ${route.id} → ${status} ${Date.now() - started}ms` +
      (entry.model ? ` model=${entry.model}` : '') +
      (out?.stream ? ` [${out.stream} stream]` : '') +
      (ingress === 'https' ? ` @${ingressHost}` : '')
  );
};

const server = http.createServer(requestHandler);

/* ------------------------------------------------------------------ */
/* 重放                                                                */
/* ------------------------------------------------------------------ */

const REPLAY_DROP = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding',
  'accept-encoding', 'expect', 'keep-alive', 'upgrade', 'te', 'trailer',
]);

/**
 * 重放一条已记录的请求。
 * @param {string} id
 * @param {{bodyText?:string, maxSseMs?:number, findReplayedId?:boolean}} opts
 */
async function replayOne(id, { bodyText, maxSseMs = 8000, findReplayedId = false } = {}) {
  const rec = store.findRequest(id);
  if (!rec) return { id, ok: false, error: 'request_not_found', durationMs: 0 };

  const rawReq = store.findRaw(id);
  if (!rawReq) {
    return {
      id,
      ok: false,
      error: 'raw_unavailable',
      message: '原始请求体未保留（超过 1MB 或已被环形缓冲淘汰），无法重放',
      durationMs: 0,
    };
  }

  const target = `http://${cfg.host}:${cfg.port}${rec.path}${rec.query ?? ''}`;
  const headers = {};
  for (const [k, v] of Object.entries(rawReq.headers)) {
    if (REPLAY_DROP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers['x-mock-replay'] = id;

  const hasOverride = bodyText !== undefined;
  const bodyBuf = hasOverride ? Buffer.from(String(bodyText), 'utf8') : rawReq.body;

  const startedAt = Date.now();
  let out;
  try {
    const r = await fetch(target, {
      method: rec.method,
      headers,
      body: ['GET', 'HEAD'].includes(rec.method) || bodyBuf.length === 0 ? undefined : bodyBuf,
      signal: AbortSignal.timeout(60000),
    });

    const ct = r.headers.get('content-type') ?? '';
    const isSse = ct.includes('event-stream');
    let text = '';
    let blocks = 0;
    let sawDone = false;

    if (isSse) {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      const deadline = Date.now() + maxSseMs;
      let buf = '';
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.includes('data: ')) blocks++;
          if (block.includes('[DONE]')) sawDone = true;
          if (text.length < 4000) text += block + '\n\n';
        }
        if (blocks > 5000) break;
      }
      await reader.cancel().catch(() => {});
    } else {
      text = await r.text();
    }

    out = {
      id,
      ok: true,
      status: r.status,
      contentType: ct,
      durationMs: Date.now() - startedAt,
      bytes: bodyBuf.length,
      bodyOverride: hasOverride,
      sse: isSse ? { blocks, sawDone } : null,
      preview: truncate(text, 3000),
      replayedId: null,
    };
  } catch (e) {
    out = {
      id,
      ok: false,
      error: 'replay_failed',
      message: String(e?.message ?? e),
      durationMs: Date.now() - startedAt,
    };
  }

  if (findReplayedId) {
    const fresh = store.latestReplayOf(id);
    if (fresh) out.replayedId = fresh.id;
  }

  if (out.ok) log('info', `重放 ${rec.method} ${rec.path} → ${out.status} ${out.durationMs}ms`);
  else log('warn', `重放失败 ${rec.method} ${rec.path} → ${out.error ?? out.message}`);
  return out;
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/* ------------------------------------------------------------------ */
/* 管理 API                                                            */
/* ------------------------------------------------------------------ */

async function handleAdminApi(req, res, url, method, reqId, started) {
  const p = url.pathname.replace('/admin/api/', '');
  res.setHeader('Cache-Control', 'no-store');

  if (p === 'state' && method === 'GET') {
    return void sendJson(res, 200, {
      config: redactConfig(cfg),
      ...store.snapshot(),
    });
  }

  if (p === 'config' && method === 'POST') {
    const raw = await readBody(req, 4 * 1024 * 1024);
    let patch;
    try {
      patch = JSON.parse(raw.toString('utf8'));
    } catch {
      return void sendJson(res, 400, { error: 'invalid_json' });
    }
    cfg = deepMerge(cfg, patch);
    saveConfig();
    log('info', '配置已更新', Object.keys(patch));
    return void sendJson(res, 200, { ok: true, config: redactConfig(cfg) });
  }

  if (p === 'reset' && method === 'POST') {
    store.reset();
    return void sendJson(res, 200, { ok: true });
  }

  if (p === 'models' && method === 'POST') {
    const raw = await readBody(req, 4 * 1024 * 1024);
    try {
      const models = JSON.parse(raw.toString('utf8'));
      if (!Array.isArray(models)) throw new Error('models must be an array');
      cfg.models = models;
      saveConfig();
      return void sendJson(res, 200, { ok: true, count: models.length });
    } catch (e) {
      return void sendJson(res, 400, { error: String(e.message) });
    }
  }

  if (p === 'probe' && method === 'POST') {
    // 自检：打自己一遍，确认路由都在
    const results = [];
    const base = `http://${cfg.host}:${cfg.port}`;
    for (const route of ROUTES) {
      const sample = samplePathFor(route.id);
      if (!sample) continue;
      const m = route.methods[0];
      try {
        const r = await fetch(base + sample, {
          method: m,
          headers: { 'content-type': 'application/json', 'x-auth-token': 'probe' },
          body: m === 'GET' || m === 'DELETE' ? undefined : '{}',
        });
        results.push({ id: route.id, method: m, path: sample, status: r.status });
      } catch (e) {
        results.push({ id: route.id, method: m, path: sample, error: String(e.message) });
      }
    }
    return void sendJson(res, 200, { ok: true, results });
  }

  if (p.startsWith('request/') && method === 'GET') {
    const id = decodeURIComponent(p.slice('request/'.length));
    const rec = store.findRequest(id);
    if (!rec) return void sendJson(res, 404, { error: 'request_not_found', id });
    const rawReq = store.findRaw(id);
    return void sendJson(res, 200, {
      entry: rec,
      canReplay: Boolean(rawReq),
      rawHeaders: rawReq ? rawReq.headers : null,
      bodyText: rawReq ? truncate(rawReq.body.toString('utf8'), 200000) : null,
      bodyBytes: rawReq?.body?.length ?? 0,
    });
  }

  if (p === 'replay' && method === 'POST') {
    const rawIn = await readBody(req, 4 * 1024 * 1024);
    let payload;
    try {
      payload = JSON.parse(rawIn.toString('utf8') || '{}');
    } catch {
      return void sendJson(res, 400, { error: 'invalid_json' });
    }

    const id = payload.id;
    const rec = store.findRequest(id);
    if (!rec) return void sendJson(res, 404, { error: 'request_not_found', id });

    const hasOverride = payload.body !== undefined || payload.bodyText !== undefined;
    const bodyText = hasOverride
      ? typeof (payload.bodyText ?? payload.body) === 'string'
        ? payload.bodyText ?? payload.body
        : JSON.stringify(payload.body)
      : undefined;

    const out = await replayOne(id, { bodyText, findReplayedId: true });
    if (out.error === 'request_not_found') return void sendJson(res, 404, out);
    if (out.error === 'raw_unavailable') return void sendJson(res, 409, out);
    return void sendJson(res, out.ok ? 200 : 502, out);
  }

  if (p === 'replay-batch' && method === 'POST') {
    const rawIn = await readBody(req, 8 * 1024 * 1024);
    let payload;
    try {
      payload = JSON.parse(rawIn.toString('utf8') || '{}');
    } catch {
      return void sendJson(res, 400, { error: 'invalid_json' });
    }

    const ids = Array.isArray(payload.ids) ? payload.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
    if (ids.length === 0) return void sendJson(res, 400, { error: 'no_ids', message: 'ids 为空或格式不对' });

    const concurrency = clampInt(payload.concurrency, 1, 32, 4);
    const gapMs = clampInt(payload.gapMs, 0, 5000, 0);
    const maxSseMs = clampInt(payload.maxSseMs, 1000, 30000, 8000);
    const stopOnError = Boolean(payload.stopOnError);

    const startedAt = Date.now();
    const results = new Array(ids.length);
    let cursor = 0;
    let aborted = false;

    async function worker() {
      while (true) {
        if (aborted) return;
        const i = cursor++;
        if (i >= ids.length) return;
        if (gapMs > 0) await sleep(gapMs);
        try {
          results[i] = await replayOne(ids[i], { maxSseMs, findReplayedId: false });
        } catch (e) {
          results[i] = { id: ids[i], ok: false, error: 'replay_failed', message: String(e?.message ?? e), durationMs: 0 };
        }
        if (stopOnError && !results[i].ok) aborted = true;
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

    const done = results.filter(Boolean);
    const durationMs = Math.max(1, Date.now() - startedAt);
    const succeeded = done.filter((r) => r.ok).length;
    const byStatus = {};
    for (const r of done) {
      const k = String(r.status ?? r.error ?? 'unknown');
      byStatus[k] = (byStatus[k] ?? 0) + 1;
    }
    const durations = done.map((r) => r.durationMs).sort((a, b) => a - b);
    const pct = (q) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * q))] : 0);

    const summary = {
      ok: true,
      total: ids.length,
      executed: done.length,
      skipped: ids.length - done.length,
      succeeded,
      failed: done.length - succeeded,
      aborted,
      concurrency,
      gapMs,
      durationMs,
      qps: Number((done.length / (durationMs / 1000)).toFixed(2)),
      latency: { min: durations[0] ?? 0, p50: pct(0.5), p95: pct(0.95), max: durations[durations.length - 1] ?? 0 },
      byStatus,
      results: done.map((r) => ({
        id: r.id,
        ok: r.ok,
        status: r.status,
        error: r.error,
        message: r.message,
        durationMs: r.durationMs,
        sse: r.sse ? `${r.sse.blocks} 块${r.sse.sawDone ? '+DONE' : ''}` : undefined,
      })),
    };

    log(
      'info',
      `批量重放 ${done.length} 条 → 成功 ${succeeded} 失败 ${done.length - succeeded} · ${durationMs}ms · ${summary.qps} rps`
    );
    return void sendJson(res, 200, summary);
  }

  return void sendJson(res, 404, { error: 'unknown_admin_api' });
}

function samplePathFor(id) {
  const map = {
    'inferhub.chat': '/api/v2/chat/completions',
    'anthropic.messages': '/v1/messages',
    'inferhub.models': '/v1/models',
    'inferhub.thinkingVariants': '/v1/model/thinking-variants',
    'agentCenter.list': '/v1/agent-center/agents/useragents?offset=0&limit=100',
    'session.create': '/v1/sessions',
    'session.check': '/v1/sessions?page=1&page_size=10',
    'agentCenter.detail': '/v1/agent-center/agents/detail?agent_id=mock-agent-0001',
    'agentCenter.builtinTools': '/v1/agent-center/built-in-tools',
    'agentCenter.skillsRules': '/v1/skills-rules/list',
    'agentCenter.gatewayConfig': '/v1/gateway-config?name=test',
    'benefit.claim': '/api/v1/benefit/claim',
    'benefit.balance': '/api/v1/user/tokens/balance?channel=x',
    'benefit.gatewayConfig': '/api/v1/gateway/config?channel=x',
    'snap.currentUser': '/snap-manager/v1/current/user',
    'snap.privacy': '/snap-manager/v1/privacy',
    'snap.heartbeat': '/snap-manager/v1/chat-session/heartbeat',
    'snap.pluginStatistics': '/snap-manager/v1/statistics/plugin',
    'prompt.builtinModel': '/v1/model/builtin',
    'prompt.featureToggle': '/PromptCenterService/v1/policy/feature-toggle',
    'memory.listPreferences': '/v1/DevMate/preferences?limit=200&offset=0',
    'release.latest': '/v1/release-info/latest',
    'skills.list': '/v1/skills',
    'codebase.list': '/codebaseservice/v1/codebases',
  };
  return map[id];
}

function redactConfig(c) {
  const clone = JSON.parse(JSON.stringify(c));
  if (clone.upstream) {
    if (clone.upstream.sk) clone.upstream.sk = maskValue('sk', clone.upstream.sk);
    if (clone.upstream.apiKey) clone.upstream.apiKey = maskValue('api-key', clone.upstream.apiKey);
    if (clone.upstream.authToken) clone.upstream.authToken = maskValue('x-auth-token', clone.upstream.authToken);
  }
  if (clone.capture?.pfxPass) clone.capture.pfxPass = '******';
  return clone;
}

function deepMerge(a, b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k] ?? {}, v) : v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function pickCliHeaders(headers) {
  const keep = [
    'x-auth-token', 'x-security-token', 'authorization', 'x-ot-trace-id', 'x-ot-span-id',
    'x-snap-traceid', 'x-ot-session-id', 'x-ot-parent-session-id', 'user-session-id',
    'x-ot-function', 'x-ot-client-type', 'x-ot-client-version', 'user-msg-id', 'created-time',
    'model-id', 'model-name', 'x-current-user', 'depart', 'agent-type', 'x-referer',
    'is_confidential', 'app-id', 'maas_type', 'plugin-name', 'plugin-version', 'ide-name',
    'ide-version', 'kernel-version', 'client-ip', 'x-language', 'x-client-type', 'content-type',
    'cookie', 'user-agent', 'accept',
  ];
  const out = {};
  for (const k of keep) if (headers[k] !== undefined) out[k] = headers[k];
  return out;
}

function preview(buf) {
  if (!buf || buf.length === 0) return undefined;
  const text = buf.toString('utf8');
  const isJson = /^\s*[[{]/.test(text);
  if (isJson) {
    try {
      return truncate(JSON.stringify(JSON.parse(text)), 2000);
    } catch {
      /* fallthrough */
    }
  }
  return truncate(text, 1200);
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n) + `…[+${s.length - n}]`;
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

server.listen(cfg.port, cfg.host, () => {
  const base = `http://${cfg.host}:${cfg.port}`;
  log('info', 'mock-hub 已启动');
  console.log('');
  console.log(`  网关地址   ${base}`);
  console.log(`  推理入口   ${base}/api/v2/chat/completions`);
  console.log(`  管理面板   ${base}/admin`);
  console.log(`  健康检查   ${base}/health`);
  console.log(`  当前模式   ${cfg.mode}${cfg.mode === 'proxy' ? ` → ${cfg.upstream.baseUrl}` : ''}`);
  console.log(`  数据目录   ${DATA_DIR}`);
  console.log('');
  console.log('  让码道 CLI 指向这里（PowerShell）：');
  console.log(`    $env:INFERHUB_BASE_URLS = "${base}/api/v2/"`);
  console.log(`    $env:PLUGIN_ENV = "hc"`);
  console.log('');
});

/* ------------------------------------------------------------------ */
/* 遥测捕获：在 443 上用自签证书接住被 hosts 指过来的官方域名          */
/* ------------------------------------------------------------------ */

let captureServer = null;

function startCapture() {
  const cap = cfg.capture;
  if (!cap?.enabled) return;

  const pfxPath = path.isAbsolute(cap.pfxPath ?? '')
    ? cap.pfxPath
    : path.join(__dirname, cap.pfxPath ?? 'data/certs/capture.pfx');

  if (!fs.existsSync(pfxPath)) {
    log('warn', `capture 已启用但证书不存在：${pfxPath}，先跑 tools/make-cert.ps1，已跳过`);
    return;
  }

  const port = Number(cap.port ?? 443);
  const host = cap.host ?? '0.0.0.0';

  try {
    captureServer = https.createServer(
      { pfx: fs.readFileSync(pfxPath), passphrase: cap.pfxPass ?? 'mock-hub' },
      requestHandler
    );

    captureServer.on('tlsClientError', (e) => {
      log('warn', `capture TLS 握手失败: ${e?.message ?? e}（客户端可能不接受自签证书）`);
    });
    captureServer.on('error', (e) => {
      log('error', `capture 监听 ${host}:${port} 失败: ${e?.message ?? e}`);
    });
    captureServer.listen(port, host, () => {
      log('info', `遥测捕获已开启 https://${host}:${port}`);
      console.log(`  捕获入口   https://${host}:${port}  (自签证书，hosts 指过来即可)`);
      console.log('');
    });
  } catch (e) {
    log('error', `capture 启动失败: ${e?.message ?? e}`);
  }
}

startCapture();

process.on('uncaughtException', (e) => log('error', `未捕获异常: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log('error', `未处理拒绝: ${e?.stack ?? e}`));
