// 网关模式端到端验证：假上游 + 真实网关进程，验证签名、协议补齐、流式透传、用量归因。
// 自带子进程，不依赖外部已启动的服务。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRequest } from '../lib/sign.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);

const UP_PORT = 8897;
const GW_PORT = 8788;
const GW = `http://127.0.0.1:${GW_PORT}`;

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${n}${e ? '  \x1b[90m' + e + '\x1b[0m' : ''}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${n}${e ? '  ' + e : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假上游 ---------- */
const seen = { requests: [] };

const upstream = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', () => {
    let body = null;
    try {
      body = JSON.parse(buf);
    } catch {
      /* ignore */
    }
    seen.requests.push({ path: req.url, headers: req.headers, body, raw: buf });

    // 轮换测试用：第一个账号固定吃 429，逼网关换号
    if (body?.model === 'rot-model' && String(req.headers.authorization ?? '').includes('AKGATEWAYTEST0001')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }));
      return;
    }

    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = [
        { id: 'chatcmpl-up', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { id: 'chatcmpl-up', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: '上游' }, finish_reason: null }] },
        { id: 'chatcmpl-up', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: '回复' }, finish_reason: null }] },
        {
          id: 'chatcmpl-up',
          object: 'chat.completion.chunk',
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
        },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-upstream',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? 'unknown',
        choices: [{ index: 0, message: { role: 'assistant', content: '上游回复' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 33, completion_tokens: 11, total_tokens: 44 },
      })
    );
  });
});

await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

/* ---------- 网关配置 ---------- */
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
cfg.mode = 'gateway';
cfg.host = '127.0.0.1';
cfg.port = GW_PORT;
cfg.capture = { ...(cfg.capture ?? {}), enabled: false };
cfg.gateway = {
  ...(cfg.gateway ?? {}),
  defaultRegion: 'cn',
  regions: { cn: `http://127.0.0.1:${UP_PORT}`, intl: `http://127.0.0.1:${UP_PORT}` },
  chatPath: '/api/v2/chat/completions',
  models: ['mock-thinking', 'mock-flagship'],
};

const dataDir = path.join(ROOT, 'data', 'gateway-test');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const cfgPath = path.join(dataDir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

/* ---------- 起网关 ---------- */
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, MOCK_HUB_CONFIG: cfgPath, MOCK_HUB_DATA: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d.toString()));
child.stderr.on('data', (d) => (serverLog += d.toString()));

let up = false;
for (let i = 0; i < 80; i++) {
  await sleep(150);
  try {
    const r = await fetch(`${GW}/health`);
    if (r.ok) {
      up = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
}
if (!up) {
  console.error('网关没起来：\n' + serverLog);
  upstream.close();
  child.kill();
  process.exit(1);
}

const cleanup = () => {
  try {
    child.kill();
  } catch {}
  try {
    upstream.close();
  } catch {}
};

try {
  /* ---------- 登录并准备账号 ---------- */
  console.log('\n\x1b[1m[1] 准备账号与 Key\x1b[0m');
  const login = await fetch(`${GW}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin' }),
  });
  const cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0];
  const H = { cookie, 'content-type': 'application/json' };

  const accRes = await fetch(`${GW}/panel/api/accounts`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: 'gw-test',
      accessKeyId: 'AKGATEWAYTEST0001',
      secretAccessKey: 'SKGATEWAYTEST0000000000000000000000000001',
      securityToken: 'TOKEN-GW-TEST',
      region: 'cn',
    }),
  });
  const accResJson = await accRes.json();
  ok('创建账号', accRes.status === 200, accResJson?.account?.id ?? '');

  const keyRes = await fetch(`${GW}/panel/api/keys`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: 'gw-key', models: ['*'] }),
  });
  const keyJson = await keyRes.json();
  const API_KEY = keyJson?.key?.key;
  ok('创建 Key', keyRes.status === 200, String(API_KEY).slice(0, 10) + '…');

  await fetch(`${GW}/panel/api/settings`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ enforceKeys: true }),
  });

  /* ---------- 模型列表 ---------- */
  console.log('\n\x1b[1m[2] 模型列表\x1b[0m');
  const models = await (await fetch(`${GW}/v1/models`)).json();
  ok('GET /v1/models 200', models?.object === 'list');
  ok('返回配置里的模型', (models?.data ?? []).length === 2, (models?.data ?? []).map((m) => m.id).join(','));

  /* ---------- 鉴权 ---------- */
  console.log('\n\x1b[1m[3] 鉴权\x1b[0m');
  const noKey = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-thinking', messages: [{ role: 'user', content: 'hi' }] }),
  });
  ok('强制鉴权后无 Key 401', noKey.status === 401);

  /* ---------- 非流式 ---------- */
  console.log('\n\x1b[1m[4] 非流式转发\x1b[0m');
  seen.requests.length = 0;
  const r1 = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'mock-thinking', messages: [{ role: 'user', content: '你好' }] }),
  });
  const j1 = await r1.json();
  ok('状态 200', r1.status === 200, `status=${r1.status}`);
  ok('透传上游内容', j1?.choices?.[0]?.message?.content === '上游回复', j1?.choices?.[0]?.message?.content ?? '');
  ok('上游只收到 1 次请求', seen.requests.length === 1, `${seen.requests.length}`);

  const up1 = seen.requests[0];
  ok('打到 chatPath', String(up1?.path).includes('/api/v2/chat/completions'), up1?.path ?? '');
  ok('带 SDK-HMAC-SHA256 签名', String(up1?.headers?.authorization ?? '').startsWith('SDK-HMAC-SHA256'), String(up1?.headers?.authorization ?? '').slice(0, 30));
  ok('签名里是账号 AK', String(up1?.headers?.authorization ?? '').includes('AKGATEWAYTEST0001'));
  ok('带 x-sdk-date', /^\d{8}T\d{6}Z$/.test(String(up1?.headers['x-sdk-date'] ?? '')), String(up1?.headers['x-sdk-date'] ?? ''));
  ok('带 x-security-token', up1?.headers['x-security-token'] === 'TOKEN-GW-TEST');
  ok('补齐 creditRatioDisplay', up1?.body?.creditRatioDisplay === '2x');
  ok('补齐 max_tokens', typeof up1?.body?.max_tokens === 'number', String(up1?.body?.max_tokens));
  ok('补齐 user_prompt', up1?.body?.user_prompt === '你好', String(up1?.body?.user_prompt));
  ok('补齐 tool_stream 字段存在', typeof up1?.body?.tool_stream === 'boolean', String(up1?.body?.tool_stream));

  /* ---------- 出站指纹（上游看到的应该是一个正常 CLI） ---------- */
  console.log('\n\x1b[1m[4b] 出站指纹\x1b[0m');
  ok('UA 不是网关自证', !/kio|gateway|mock-hub/i.test(String(up1?.headers['user-agent'] ?? '')), String(up1?.headers['user-agent'] ?? ''));
  ok('带 CLI 插件头', up1?.headers['plugin-name'] === 'codearts-cli', String(up1?.headers['plugin-name'] ?? ''));
  ok('带 x-ot-client-type = CLI', up1?.headers['x-ot-client-type'] === 'CLI', String(up1?.headers['x-ot-client-type'] ?? ''));
  ok('x-ot-session-id 是 UUID', /^[0-9a-f-]{36}$/.test(String(up1?.headers['x-ot-session-id'] ?? '')), String(up1?.headers['x-ot-session-id'] ?? ''));
  ok('x-ot-trace-id 是 32 hex', /^[0-9a-f]{32}$/.test(String(up1?.headers['x-ot-trace-id'] ?? '')), String(up1?.headers['x-ot-trace-id'] ?? ''));
  ok('没有 x-kio / mock 痕迹头', !Object.keys(up1?.headers ?? {}).some((k) => /^(x-kio|x-mock)/.test(k)));
  ok('SignedHeaders 含 CLI 会话头', /x-ot-session-id/.test(String(up1?.headers?.authorization ?? '')));
  {
    const v = verifyRequest({
      method: 'POST',
      url: `http://127.0.0.1:${UP_PORT}${up1.path}`,
      headers: { ...up1.headers },
      body: up1.raw,
      skOf: () => 'SKGATEWAYTEST0000000000000000000000000001',
    });
    ok('上游能复算出同一个签名', v.ok, v.reason ?? '');
  }

  /* ---------- 流式 ---------- */
  console.log('\n\x1b[1m[5] 流式转发\x1b[0m');
  seen.requests.length = 0;
  const r2 = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'mock-thinking', stream: true, messages: [{ role: 'user', content: '流式' }] }),
  });
  const text2 = await r2.text();
  ok('状态 200', r2.status === 200);
  ok('是 SSE', String(r2.headers.get('content-type')).includes('text/event-stream'));
  ok('透传了上游分片', text2.includes('上游') && text2.includes('回复'));
  ok('包含 [DONE]', text2.includes('[DONE]'));
  ok('标注上游地址', !!r2.headers.get('x-kio-upstream'), r2.headers.get('x-kio-upstream') ?? '');
  ok('流式请求复用同一会话 id', seen.requests[0]?.headers['x-ot-session-id'] === up1?.headers['x-ot-session-id'], String(seen.requests[0]?.headers['x-ot-session-id'] ?? ''));
  ok('流式请求换了 trace id', seen.requests[0]?.headers['x-ot-trace-id'] !== up1?.headers['x-ot-trace-id']);

  /* ---------- Anthropic 入口 ---------- */
  console.log('\n\x1b[1m[6] Anthropic /v1/messages 转换\x1b[0m');
  seen.requests.length = 0;
  const r3 = await fetch(`${GW}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: 'mock-thinking',
      max_tokens: 128,
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    }),
  });
  const j3 = await r3.json();
  ok('状态 200', r3.status === 200);
  ok('返回 Anthropic 形状', j3?.type === 'message' && Array.isArray(j3?.content), j3?.type ?? '');
  ok('含 text 块', j3?.content?.[0]?.type === 'text', j3?.content?.[0]?.text ?? '');
  const up3 = seen.requests[0];
  ok('system 被转成 system 消息', up3?.body?.messages?.[0]?.role === 'system', up3?.body?.messages?.[0]?.content ?? '');
  ok('user 文本被转出', up3?.body?.messages?.[1]?.content === '你好');

  /* ---------- 用量归因 ---------- */
  console.log('\n\x1b[1m[7] 用量归因\x1b[0m');
  const usage = await (await fetch(`${GW}/panel/api/usage?range=today`, { headers: H })).json();
  ok('有请求记录', (usage?.kpi?.requests ?? 0) >= 3, String(usage?.kpi?.requests));
  ok('记录了 token', (usage?.kpi?.totalTokens ?? 0) > 0, String(usage?.kpi?.totalTokens));
  ok('归到账号', (usage?.accounts ?? []).some((a) => a.name === 'gw-test'), (usage?.accounts ?? []).map((a) => a.name).join(','));
  ok('归到 Key', (usage?.keys ?? []).some((k) => k.name === 'gw-key'), (usage?.keys ?? []).map((k) => k.name).join(','));

  /* ---------- 轮换与冷却 ---------- */
  console.log('\n\x1b[1m[7b] 账号轮换与冷却\x1b[0m');
  const acc1Id = accResJson?.account?.id;
  const keyId = keyJson?.key?.id;
  await fetch(`${GW}/panel/api/keys/${keyId}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ accountRef: acc1Id }),
  });
  const acc2Res = await fetch(`${GW}/panel/api/accounts`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: 'gw-test-2',
      accessKeyId: 'AKGATEWAYTEST0002',
      secretAccessKey: 'SKGATEWAYTEST0000000000000000000000000002',
      region: 'cn',
    }),
  });
  ok('创建第二个账号', acc2Res.status === 200);

  seen.requests.length = 0;
  const rot1 = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'rot-model', messages: [{ role: 'user', content: '轮换' }] }),
  });
  ok('第一个账号 429 后自动换号成功', rot1.status === 200, `status=${rot1.status}`);
  ok('上游一共收到 2 次', seen.requests.length === 2, String(seen.requests.length));
  const aks = seen.requests.map((r) => /Access=([^,]+)/.exec(String(r.headers.authorization ?? ''))?.[1]);
  ok('两次用的是不同账号', new Set(aks).size === 2, aks.join(','));

  seen.requests.length = 0;
  const rot2 = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'rot-model', messages: [{ role: 'user', content: '再来一次' }] }),
  });
  ok('冷却期内第二次请求直接成功', rot2.status === 200, `status=${rot2.status}`);
  ok('冷却账号被跳过（只打 1 次上游）', seen.requests.length === 1, String(seen.requests.length));
  ok(
    '只用了没冷却的账号',
    String(seen.requests[0]?.headers?.authorization ?? '').includes('AKGATEWAYTEST0002'),
    String(seen.requests[0]?.headers?.authorization ?? '').slice(0, 40)
  );

  /* ---------- 无凭据时的行为 ---------- */
  console.log('\n\x1b[1m[8] 无账号时的错误\x1b[0m');
  const accs = await (await fetch(`${GW}/panel/api/accounts`, { headers: H })).json();
  for (const a of accs?.accounts ?? []) {
    await fetch(`${GW}/panel/api/accounts/${a.id}`, { method: 'DELETE', headers: H });
  }
  const r4 = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'mock-thinking', messages: [{ role: 'user', content: 'hi' }] }),
  });
  ok('无可用账号返回 503', r4.status === 503, `status=${r4.status}`);
  const j4 = await r4.json();
  ok('错误码是 no_credentials', j4?.error?.code === 'no_credentials', j4?.error?.code ?? '');
} finally {
  cleanup();
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
