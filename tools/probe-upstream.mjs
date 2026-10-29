// 真实请求探测：直接打真实上游，打印状态码 + 响应体
//
// 用法（在网关目录下）：
//   node tools/probe-upstream.mjs                    只探端点存活（不带凭据，看 401/404 区分路径对不对）
//   node tools/probe-upstream.mjs --account <id|name> 用账号池里的真实凭据签名请求
//   node tools/probe-upstream.mjs --raw              打印完整响应体（不截断）
//   node tools/probe-upstream.mjs --base https://xxx  只探指定域名
//
// 不产生任何模拟数据：每一个结果都是一次真实的 HTTPS 请求。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRequest } from '../lib/sign.mjs';
import { createPanel } from '../lib/panel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const cfgPath = process.env.MOCK_HUB_CONFIG
  ? path.resolve(process.cwd(), process.env.MOCK_HUB_CONFIG)
  : path.join(root, 'config.json');
const dataDir = process.env.MOCK_HUB_DATA
  ? path.resolve(process.cwd(), process.env.MOCK_HUB_DATA)
  : path.join(root, 'data');

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch {
  console.error(`读不到配置：${cfgPath}`);
  process.exit(2);
}

const oi = cfg.accountInfo ?? {};
const bases = opt('--base') ? [opt('--base')] : (oi.bases ?? [
  'https://opengw.developer.huaweicloud.com',
  'https://snap-access.cn-north-4.myhuaweicloud.com',
]);
const appId = oi.appId ?? 'CodeAgent3.0';
const agentType = oi.agentType ?? 'AgentCenter';
const timeoutMs = Number(opt('--timeout', oi.timeoutMs ?? 20000));

const ENDPOINTS = [
  { name: 'balance', path: oi.balancePath ?? '/api/v1/user/tokens/balance', kind: 'benefit' },
  { name: 'gateway/config', path: oi.gatewayConfigPath ?? '/api/v1/gateway/config', kind: 'benefit' },
  { name: 'benefit/claim', path: oi.claimPath ?? '/api/v1/benefit/claim', kind: 'benefit', method: 'POST' },
  { name: 'useragents', path: oi.userAgentsPath ?? '/v1/agent-center/agents/useragents?offset=0&limit=1', kind: 'agent' },
  { name: 'current/user', path: '/snap-manager/v1/current/user', kind: 'agent' },
];

/* ---- 取账号 ---- */
let account = null;
const accRef = opt('--account');
if (accRef) {
  const panel = createPanel({ dataDir });
  panel.load();
  account = panel.findAccount(accRef);
  if (!account) {
    console.error(`账号池里没有 ${accRef}（data 目录：${dataDir}）`);
    process.exit(2);
  }
} else if (process.env.AK && process.env.SK) {
  account = {
    id: 'env',
    name: 'env',
    accessKeyId: process.env.AK,
    secretAccessKey: process.env.SK,
    securityToken: process.env.TOKEN ?? process.env.SECURITY_TOKEN ?? '',
    userName: process.env.CODEARTS_USER ?? '',
  };
}

const clip = (s, n = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
};

console.log(`\n真实请求探测${account ? `（账号 ${account.name}，AK ${String(account.accessKeyId).slice(0, 8)}…）` : '（不带凭据）'}`);
console.log(`配置：${cfgPath}`);
console.log(`域名：${bases.join(', ')}\n`);

let okCount = 0;
let total = 0;

for (const base of bases) {
  for (const ep of ENDPOINTS) {
    const url = base + ep.path;
    const method = ep.method ?? 'GET';
    const headers = { 'content-type': 'application/json', 'app-id': appId };
    if (account) headers['x-security-token'] = account.securityToken ?? '';
    if (ep.kind === 'agent') {
      headers['agent-type'] = agentType;
      headers['x-client-type'] = 'DevMate';
      const who = account?.userName || account?.userId;
      if (who) headers['x-current-user'] = String(who);
    }

    let finalHeaders = headers;
    if (account) {
      const signed = signRequest({
        method,
        url,
        headers,
        body: '',
        ak: account.accessKeyId,
        sk: account.secretAccessKey,
      });
      finalHeaders = signed.headers;
    }

    total++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const r = await fetch(url, {
        method,
        headers: finalHeaders,
        body: method === 'GET' ? undefined : '{}',
        signal: ctl.signal,
      });
      const text = await r.text();
      const ms = Date.now() - started;
      const good = r.status >= 200 && r.status < 300;
      if (good) okCount++;
      console.log(`${good ? '\x1b[32m' : '\x1b[31m'}${r.status}\x1b[0m  ${ms}ms  ${method} ${url.replace('https://', '')}`);
      console.log(`      ${flag('--raw') ? text : clip(text)}`);
      const rid = r.headers.get('x-request-id') ?? r.headers.get('x-apigw-request-id');
      if (rid) console.log(`      request-id: ${rid}`);
    } catch (e) {
      console.log(`\x1b[31mERR\x1b[0m  ${Date.now() - started}ms  ${method} ${url.replace('https://', '')}`);
      console.log(`      ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log('');
}

console.log(`合计 ${total} 个请求，2xx ${okCount} 个。`);
if (!account) {
  console.log('提示：不带凭据时 401/403 说明路径存在（只差鉴权）；APIG.0101 说明该网关下没有这个 API。');
}
