// 网关模式端到端验证：假上游 + 真实网关进程，验证签名、协议补齐、流式透传、用量归因。
// 自带子进程，不依赖外部已启动的服务。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRequest } from '../lib/sign.mjs';
import { resolveModelId, buildUpstreamBody } from '../lib/gateway.mjs';

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

// slow-model 挂住的时长：要比排队预算长，
// 才能让「所有账号都满」那个用例真的等到超时
const SLOW_MS = 2500;
// slow-first 的节奏：TTFT_MS 后吐第一个内容片，再等 TAIL_MS 才结束
const TTFT_MS = 600;
const TAIL_MS = 500;

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

    // 占号测试用：slow-model 挂住一段时间才回，用来把账号的并发名额占满
    if (body?.model === 'slow-model') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-slow',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: '慢回复' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          })
        );
      }, SLOW_MS);
      return;
    }

    // 首字测试用：先发一个空的 role 片（不算首字），停 TTFT_MS 才吐内容，
    // 再停 TAIL_MS 才结束 —— 这样首字延迟和总耗时能明显区分开
    if (body?.model === 'slow-first' && body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'sf', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ id: 'sf', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '慢' }, finish_reason: null }] })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ id: 'sf', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }, TAIL_MS);
      }, TTFT_MS);
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
// 节流参数钉死成「单账号 1 并发 + 1.2s 排队上限」，
// [7c] 才能稳定复现「一个号忙、另一个号空闲」的场景，也不会等太久
cfg.stealth = {
  ...(cfg.stealth ?? {}),
  pacing: {
    ...(cfg.stealth?.pacing ?? {}),
    maxConcurrentPerAccount: 1,
    maxGlobalConcurrent: 8,
    minIntervalMs: 0,
    jitterMs: 0,
    queueTimeoutMs: 1200,
  },
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
  ok('带 CLI 插件头（实测值 CLI）', up1?.headers['plugin-name'] === 'CLI', String(up1?.headers['plugin-name'] ?? ''));
  ok('带 x-ot-client-type = CLI', up1?.headers['x-ot-client-type'] === 'CLI', String(up1?.headers['x-ot-client-type'] ?? ''));
  ok('x-ot-session-id 是 ses_ 格式', /^ses_[0-9a-f]{13}e[0-9A-Za-z]{17}$/.test(String(up1?.headers['x-ot-session-id'] ?? '')), String(up1?.headers['x-ot-session-id'] ?? ''));
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

  /* ---------- 首字 / 耗时 落账 ---------- */
  console.log('\n\x1b[1m[5b] 每次请求都记首字和耗时\x1b[0m');
  {
    // 让流式响应稍微停一下再吐第一个内容片，这样首字一定大于 0 且明显小于总耗时
    const j0 = await (await fetch(`${GW}/panel/api/usage?range=today`, { headers: H })).json();
    const before = j0?.recent?.length ?? 0;

    const rs = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'mock-thinking', stream: true, messages: [{ role: 'user', content: '首字测试' }] }),
    });
    await rs.text(); // 流读完，账才落

    // 非流式也走一遍：没有流式增量时首字退回「响应头到达」
    const rn = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'mock-thinking', messages: [{ role: 'user', content: '非流式首字' }] }),
    });
    await rn.json();

    const j1 = await (await fetch(`${GW}/panel/api/usage?range=today`, { headers: H })).json();
    const added = (j1?.recent ?? []).slice(0, (j1?.recent?.length ?? 0) - before);
    ok('新增了 2 条流水', added.length === 2, String(added.length));

    const st = added.find((r) => r.stream === true);
    const ns = added.find((r) => r.stream !== true);
    ok('流式流水有 ttftMs', typeof st?.ttftMs === 'number', String(st?.ttftMs));
    ok('流式 ttftMs >= 0', (st?.ttftMs ?? -1) >= 0, String(st?.ttftMs));
    ok('流式 ttftMs 不大于总耗时', (st?.ttftMs ?? 0) <= (st?.durMs ?? 0), `${st?.ttftMs} vs ${st?.durMs}`);
    ok('流式总耗时 > 0', (st?.durMs ?? 0) > 0, String(st?.durMs));

    ok('非流式流水也有 ttftMs', typeof ns?.ttftMs === 'number', String(ns?.ttftMs));
    ok('非流式 ttftMs 不大于总耗时', (ns?.ttftMs ?? 0) <= (ns?.durMs ?? 0), `${ns?.ttftMs} vs ${ns?.durMs}`);

    ok('KPI 有平均首字', typeof j1?.kpi?.avgTtftMs === 'number', String(j1?.kpi?.avgTtftMs));
    ok('KPI 首字样本数 > 0', (j1?.kpi?.ttftSamples ?? 0) > 0, String(j1?.kpi?.ttftSamples));

    // 请求日志那一侧也要有
    const jl = await (await fetch(`${GW}/panel/api/requests?range=today&sort=ttftMs&order=desc&size=10`, { headers: H })).json();
    ok('请求日志按首字排序不报错', Array.isArray(jl?.rows), String(jl?.rows?.length));
    ok('请求日志 summary 有 avgTtftMs', jl?.summary?.avgTtftMs != null, String(jl?.summary?.avgTtftMs));
  }

  /* ---------- 首字 vs 总耗时确实分开计 ---------- */
  console.log('\n\x1b[1m[5c] 首字延迟和总耗时是两个数\x1b[0m');
  {
    // slow-first：空的 role 片立刻发，600ms 后才吐内容，再 500ms 才结束。
    // 首字应该 ≈600ms（不是 0，也不是 1100ms），总耗时应该 ≈1100ms。
    const j0 = await (await fetch(`${GW}/panel/api/usage?range=today`, { headers: H })).json();
    const before = j0?.recent?.length ?? 0;

    const rf = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'slow-first', stream: true, messages: [{ role: 'user', content: '首字' }] }),
    });
    await rf.text();

    const j1 = await (await fetch(`${GW}/panel/api/usage?range=today`, { headers: H })).json();
    const row = (j1?.recent ?? []).find((r) => r.model === 'slow-first');
    ok('slow-first 落了流水', !!row, String((j1?.recent ?? []).length - before));

    // 空的 role 片不能算首字：若算成 0，这条会掉到 100ms 以下
    ok('首字 ≈ 第一个内容片的时间（不是 0）', (row?.ttftMs ?? 0) >= TTFT_MS - 150, `${row?.ttftMs}ms`);
    ok('首字没被结尾拖长', (row?.ttftMs ?? 0) < TTFT_MS + TAIL_MS, `${row?.ttftMs}ms`);
    ok('总耗时 ≈ 首字 + 尾巴', (row?.durMs ?? 0) >= TTFT_MS + TAIL_MS - 150, `${row?.durMs}ms`);
    ok('首字明显小于总耗时', (row?.ttftMs ?? 0) < (row?.durMs ?? 0), `${row?.ttftMs} vs ${row?.durMs}`);
  }

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

  /* ---------- 忙号换号（gateway_busy 修复） ---------- */
  console.log('\n\x1b[1m[7c] 一个账号忙时换号，而不是直接 503\x1b[0m');
  // 第一个账号在上面的轮换测试里吃了 429，还在冷却；再建一个号，
  // 保证这里有「两个都能用」的账号
  const acc3Res = await fetch(`${GW}/panel/api/accounts`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: 'gw-test-3',
      accessKeyId: 'AKGATEWAYTEST0003',
      secretAccessKey: 'SKGATEWAYTEST0000000000000000000000000003',
      region: 'cn',
    }),
  });
  ok('创建第三个账号', acc3Res.status === 200);
  // 解除 Key 上的账号绑定，让调度器自己挑号
  await fetch(`${GW}/panel/api/keys/${keyId}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ accountRef: null }),
  });

  const slowFetch = (tag) =>
    fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'slow-model', messages: [{ role: 'user', content: tag }] }),
    });

  seen.requests.length = 0;
  const slowP1 = slowFetch('占住第一个账号');
  await sleep(350); // 等第一个请求真正拿到名额
  const tBusy = Date.now();
  const slowR2 = await slowFetch('应该换到另一个账号');
  const busyElapsed = Date.now() - tBusy;
  const slowR1 = await slowP1;

  ok('占号请求本身成功', slowR1.status === 200, `status=${slowR1.status}`);
  ok('另一个账号空闲时第二个请求直接成功', slowR2.status === 200, `status=${slowR2.status}`);
  ok('且没有傻等排队（只花了自己那一趟的时间）', busyElapsed < SLOW_MS + 900, `${busyElapsed}ms`);
  const slowAks = seen.requests
    .filter((r) => r.body?.model === 'slow-model')
    .map((r) => /Access=([^,]+)/.exec(String(r.headers.authorization ?? ''))?.[1]);
  ok('两个慢请求分散到了两个账号', new Set(slowAks).size === 2, slowAks.join(','));

  // 两个账号都占满时，才该 503，并且必须带 Retry-After
  seen.requests.length = 0;
  const full1 = slowFetch('占满一号');
  await sleep(300);
  const full2 = slowFetch('占满二号');
  await sleep(300);
  const full3 = await slowFetch('第三个应该被限流');
  ok('两个账号都满时返回 503', full3.status === 503, `status=${full3.status}`);
  ok('503 带 Retry-After 头', !!full3.headers.get('retry-after'), String(full3.headers.get('retry-after')));
  const full3j = await full3.json();
  ok('503 错误码是 gateway_busy', full3j?.error?.code === 'gateway_busy', full3j?.error?.code ?? '');
  ok('503 带 retry_after_ms', Number(full3j?.error?.retry_after_ms) > 0, String(full3j?.error?.retry_after_ms));
  await Promise.all([full1, full2]);

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


console.log('\n\x1b[1m[显示名解析] 调用方填显示名也要能调通\x1b[0m');
{
  const acc = {
    info: {
      models: [
        { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', alias: 'deepseek-v4.1-flash-1017' },
        { id: 'GLM-5.2', name: 'GLM-5.2', alias: 'GLM-5.2' },
        { id: 'glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK', alias: 'glm-5.2-sft-harmony' },
        { id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro', alias: 'openpangu-2.0-pro' },
        { id: 'kimi-k3', name: 'Kimi-K3', alias: 'kimi-k3' },
      ],
    },
  };

  // 上游只认 model_id。调用方照着 /v1/models 填显示名会拿到
  // HTTP 200 + InferHub.002002009.404「The model is not registered」。
  ok('显示名 → id', resolveModelId(acc, 'DeepSeek-V4.1-Flash-1017') === 'deepseek-v4.1-flash-1017',
    resolveModelId(acc, 'DeepSeek-V4.1-Flash-1017'));
  ok('id 原样返回', resolveModelId(acc, 'deepseek-v4.1-flash-1017') === 'deepseek-v4.1-flash-1017');
  ok('显示名（带横线）→ id', resolveModelId(acc, 'GLM-5.2-ArkTS-SPARK') === 'glm-5.2-sft-harmony',
    resolveModelId(acc, 'GLM-5.2-ArkTS-SPARK'));
  ok('OpenPangu 显示名 → id', resolveModelId(acc, 'OpenPangu-2.0-Pro') === 'openpangu-2.0-pro',
    resolveModelId(acc, 'OpenPangu-2.0-Pro'));
  ok('Kimi 显示名 → id', resolveModelId(acc, 'Kimi-K3') === 'kimi-k3', resolveModelId(acc, 'Kimi-K3'));
  ok('id 与显示名相同的模型不受影响', resolveModelId(acc, 'GLM-5.2') === 'GLM-5.2');
  ok('未知模型原样返回（让上游报错）', resolveModelId(acc, '不存在的模型') === '不存在的模型');
  ok('空模型名安全', resolveModelId(acc, '') === '');
  ok('无 account 时原样返回', resolveModelId(null, 'DeepSeek-V4.1-Flash-1017') === 'DeepSeek-V4.1-Flash-1017');
  ok('account 无 info 时原样返回',
    resolveModelId({}, 'DeepSeek-V4.1-Flash-1017') === 'DeepSeek-V4.1-Flash-1017');

  // buildUpstreamBody 带 account 时会自动解析
  const b = buildUpstreamBody(
    { model: 'DeepSeek-V4.1-Flash-1017', messages: [{ role: 'user', content: 'hi' }] },
    { stream: false, account: acc }
  );
  ok('buildUpstreamBody 自动解析显示名', b.model === 'deepseek-v4.1-flash-1017', b.model);

  const b2 = buildUpstreamBody(
    { model: 'DeepSeek-V4.1-Flash-1017', messages: [] },
    { stream: false }
  );
  ok('不传 account 时不动 model', b2.model === 'DeepSeek-V4.1-Flash-1017', b2.model);
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
