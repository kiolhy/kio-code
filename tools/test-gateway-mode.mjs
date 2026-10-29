// 网关模式端到端：验证 CLI 请求真的被转发到上游（用假上游观察出站请求）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

/* ---- 假上游：记录收到的请求，返回一个真实的 OpenAI 形状响应 ---- */
const captured = [];
// 真实结构 fixture（取自 2026-10-29 实测）
const REAL_AGENTS = { total: 17, agents: [{ agent_id: '9f0e5cb64a104dcfb4aa90dbedab7dcf', agent_name: 'CodeAgent', is_primary_agent: true, agent_type: 'openapi' }] };
const REAL_DETAIL = {
  agent_id: '9f0e5cb64a104dcfb4aa90dbedab7dcf',
  agent_name: 'CodeAgent',
  gpts: {
    models: [
      {
        model_name: 'GLM-5.2', model_alias: 'GLM-5.2', model_type: 'admin',
        model_parameters: { max_tokens: 65536, context_window: 202752, enable_queue: true, supports_prompt_cache: true },
        credit: [{ input_from: 0, input_to: -1, output_from: 0, output_to: -1, input_price: '8', cache_price: '2', output_price: '28' }],
      },
      {
        model_name: 'Kimi-K3', model_alias: 'kimi-k3', model_type: 'admin',
        model_parameters: { max_tokens: 65536, context_window: 1048576, enable_queue: true, supports_prompt_cache: true },
        credit: [{ input_from: 0, input_to: -1, output_from: 0, output_to: -1, input_price: '20', cache_price: '2', output_price: '100' }],
      },
    ],
  },
};
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    captured.push({ method: req.method, path: req.url, headers: req.headers, body, raw });

    // CLI 的模型发现接口 → 返回真实结构
    if (/\/agent-center\/agents\/useragents/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(REAL_AGENTS));
    }
    if (/\/agent-center\/agents\/detail/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(REAL_DETAIL));
    }
    if (/\/snap-manager\/v1\/current\/user/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ domain_id: 'd1', domain_name: 'dn', user_id: 'u1', user_name: 'hid_test_user', app_types: null, user_type: null }));
    }

    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ delta: { content: '真' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ delta: { content: '实' } }], usage: { prompt_tokens: 11, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: body?.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '真实上游回复' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
    }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upBase = `http://127.0.0.1:${upstream.address().port}`;

/* ---- 起网关（gateway 模式，指向假上游） ---- */
// 先占一个空闲端口再释放，避免端口冲突
const probe = http.createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const gwPort = probe.address().port;
await new Promise((r) => probe.close(r));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-gw-'));
const cfg = {
  port: gwPort,
  host: '127.0.0.1',
  mode: 'gateway',
  upstream: { baseUrl: upBase, apiBasePath: '/api/v2', timeoutMs: 8000 },
  verifySignature: false,
  captureCredentials: false,
  logBodies: false,
  maxBodyBytes: 67108864,
  identity: { codeAgentId: 'a8bcb36232554267a5142361cc25a393', stationType: 'china', isProd: false },
  gateway: {
    defaultRegion: 'cn',
    regions: { cn: upBase },
    chatPath: '/api/v2/chat/completions',
    owner: 'codearts',
    models: [],
    requireKey: false,
  },
  stealth: { assertNoLeaks: false, timeoutMs: 8000, sessionTtlMs: 60000, egress: { proxy: '' } },
  panel: { enabled: true },
  accountInfo: { snapAccess: upBase, benefitBase: upBase, timeoutMs: 5000 },
};
const cfgPath = path.join(dataDir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// 账号池里放一个假账号（gateway 会用它签名）—— 面板数据文件是 settings.json
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  accounts: [{
    id: 'acc-test',
    name: 'test',
    accessKeyId: 'HSTAICLDUR19TESTAK',
    secretAccessKey: 'SKTESTSECRET0123456789abcdefghij',
    securityToken: 'hQpjbi1ub3J0aC00AQAABYxIU1RBSUNMRFVSMTlBS0xWN0pFT',
    userName: 'hid_test_user',
    enabled: true,
    createdAt: new Date().toISOString(),
  }],
  keys: [],
  settings: {},
}, null, 2));

const { spawn } = await import('node:child_process');
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, MOCK_HUB_CONFIG: cfgPath, MOCK_HUB_DATA: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', (d) => (out += d.toString()));
srv.stderr.on('data', (d) => (out += d.toString()));

// 等端口就绪（主动探测而不是解析日志）
const gwBase = `http://127.0.0.1:${gwPort}`;
let ready = false;
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 100));
  try {
    const r = await fetch(`${gwBase}/health`);
    if (r.ok || r.status === 404) { ready = true; break; }
  } catch { /* 还没起来 */ }
}
ok('网关已启动', ready, ready ? gwBase : out.slice(0, 300));

if (gwBase) {
  console.log('\n\x1b[1m[1] 模型列表来自真实探测（无探测时为空，不回退 mock 名）\x1b[0m');
  {
    const r = await fetch(`${gwBase}/v1/models`);
    const j = await r.json();
    ok('GET /v1/models 200', r.status === 200, String(r.status));
    ok('不含 mock-flagship', !JSON.stringify(j).includes('mock-flagship'), JSON.stringify(j).slice(0, 120));
    ok('返回 list 结构', j.object === 'list' && Array.isArray(j.data));
  }

  console.log('\n\x1b[1m[2] CLI 原生路径 /api/v2/chat/completions 被转发\x1b[0m');
  {
    captured.length = 0;
    const r = await fetch(`${gwBase}/api/v2/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: '你好' }] }),
    });
    const j = await r.json();
    ok('网关返回 200', r.status === 200, String(r.status));
    ok('内容来自上游', j?.choices?.[0]?.message?.content === '真实上游回复', JSON.stringify(j).slice(0, 150));
    ok('上游真的收到请求', captured.length === 1, `${captured.length} 次`);
    const c = captured[0];
    ok('上游路径正确', c?.path === '/api/v2/chat/completions', c?.path);
    ok('模型透传', c?.body?.model === 'GLM-5.2', c?.body?.model);
    ok('消息透传', c?.body?.messages?.[0]?.content === '你好');
    ok('带 SDK-HMAC 签名', String(c?.headers?.authorization).startsWith('SDK-HMAC-SHA256 Access=HSTAICLDUR19TESTAK'), String(c?.headers?.authorization).slice(0, 60));
    ok('带 X-Security-Token', String(c?.headers['x-security-token']).startsWith('hQpjbi1'), String(c?.headers['x-security-token']).slice(0, 16));
    ok('带 x-current-user（真实账号名）', c?.headers['x-current-user'] === 'hid_test_user', c?.headers['x-current-user']);
    ok('带 app-id', c?.headers['app-id'] === 'CodeAgent3.0', c?.headers['app-id']);
    ok('补了 user_prompt', c?.body?.user_prompt === '你好', String(c?.body?.user_prompt));
    ok('补了 max_tokens', typeof c?.body?.max_tokens === 'number', String(c?.body?.max_tokens));
  }

  console.log('\n\x1b[1m[3] /v1/chat/completions 同样转发\x1b[0m');
  {
    captured.length = 0;
    const r = await fetch(`${gwBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Kimi-K3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const j = await r.json();
    ok('200', r.status === 200, String(r.status));
    ok('上游收到', captured.length === 1);
    ok('模型透传', captured[0]?.body?.model === 'Kimi-K3', captured[0]?.body?.model);
  }

  console.log('\n\x1b[1m[4] 流式转发 + usage 旁路解析\x1b[0m');
  {
    captured.length = 0;
    const r = await fetch(`${gwBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', stream: true, messages: [{ role: 'user', content: 'stream' }] }),
    });
    const text = await r.text();
    ok('200', r.status === 200, String(r.status));
    ok('SSE 内容透传', text.includes('真') && text.includes('真实'.slice(0, 1)), text.slice(0, 80));
    ok('含 [DONE]', text.includes('[DONE]'));
    ok('上游收到 stream:true', captured[0]?.body?.stream === true);
  }

  console.log('\n\x1b[1m[6] 下游能拿到真实模型（CLI 模型发现链路）\x1b[0m');
  {
    // 6.1 CLI 先问 agent 列表
    captured.length = 0;
    const r1 = await fetch(`${gwBase}/api/v2/v1/agent-center/agents/useragents?offset=0&limit=100`, {
      headers: { 'x-current-user': 'hid_test_user' },
    });
    const j1 = await r1.json();
    ok('useragents 200', r1.status === 200, String(r1.status));
    ok('拿到真实 total=17', j1?.total === 17, String(j1?.total));
    ok('请求转发到上游', captured.length === 1, `${captured.length} 次`);
    ok('上游路径保留', captured[0]?.path?.includes('/v1/agent-center/agents/useragents'), captured[0]?.path);
    ok('元数据也带签名', String(captured[0]?.headers?.authorization).startsWith('SDK-HMAC-SHA256'), String(captured[0]?.headers?.authorization).slice(0, 40));
    ok('元数据带 Agent-Type', captured[0]?.headers['agent-type'] === 'AgentCenter', captured[0]?.headers['agent-type']);
    ok('元数据带 X-Language', captured[0]?.headers['x-language'] === 'zh-cn', captured[0]?.headers['x-language']);
    ok('x-current-user 用账号真实名', captured[0]?.headers['x-current-user'] === 'hid_test_user', captured[0]?.headers['x-current-user']);

    // 6.2 再问 agent 详情 → 这就是 CLI 的模型来源
    captured.length = 0;
    const agentId = j1?.agents?.[0]?.agent_id;
    const r2 = await fetch(`${gwBase}/api/v2/v1/agent-center/agents/detail?agent_id=${agentId}`);
    const j2 = await r2.json();
    ok('detail 200', r2.status === 200, String(r2.status));
    const models = j2?.gpts?.models ?? [];
    ok('拿到真实模型 2 个', models.length === 2, String(models.length));
    ok('模型名是 GLM-5.2', models[0]?.model_name === 'GLM-5.2', models[0]?.model_name);
    ok('带真实价格', models[0]?.credit?.[0]?.input_price === '8', JSON.stringify(models[0]?.credit?.[0] ?? {}));
    ok('带上下文窗口', models[0]?.model_parameters?.context_window === 202752, String(models[0]?.model_parameters?.context_window));
    ok('detail 转发到上游', captured.length === 1);
    ok('agent_id 透传', captured[0]?.path?.includes(`agent_id=${agentId}`), captured[0]?.path);

    // 6.3 用拿到的模型名真的能调通
    captured.length = 0;
    const r3 = await fetch(`${gwBase}/api/v2/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: models[0].model_name, messages: [{ role: 'user', content: '用真实模型名调用' }] }),
    });
    const j3 = await r3.json();
    ok('用真实模型名调用成功', r3.status === 200, String(r3.status));
    ok('上游收到该模型', captured[0]?.body?.model === 'GLM-5.2', captured[0]?.body?.model);
    ok('返回真实内容', j3?.choices?.[0]?.message?.content === '真实上游回复');
  }

  console.log('\n\x1b[1m[7] 上游挂掉时回落（用探测结果，不用假数据）\x1b[0m');
  {
    // 让上游直接断开
    upstream.close();
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${gwBase}/api/v2/v1/agent-center/agents/detail?agent_id=X`);
    const j = await r.json();
    ok('回落返回 200', r.status === 200, String(r.status));
    ok('回落结构可解析', !!j?.gpts, JSON.stringify(j).slice(0, 120));
    // 账号池没探测过 → 模型为空，但结构正确（不会返回 mock-flagship）
    ok('回落不含 mock 模型', !JSON.stringify(j).includes('mock-'), JSON.stringify(j).slice(0, 150));
  }
  console.log('\n\x1b[1m[5] 用量落库（真实 token 数）\x1b[0m');
  {
    // 面板 API 要登录，直接读落盘文件验证
    const usageFile = path.join(dataDir, 'usage.jsonl');
    let rows = [];
    if (fs.existsSync(usageFile)) {
      rows = fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    ok('有请求记录', rows.length >= 2, `${rows.length} 条`);
    const withTok = rows.find((x) => (x.promptTokens ?? 0) > 0);
    ok('记录到 promptTokens', !!withTok, JSON.stringify(rows[0] ?? {}).slice(0, 200));
    ok('记录到缓存命中', rows.some((x) => (x.cachedTokens ?? 0) > 0), JSON.stringify(rows.map((x) => x.cachedTokens)));
    ok('缓存比例已算', rows.some((x) => x.cacheRatio != null), JSON.stringify(rows.map((x) => x.cacheRatio)));
    ok('记了账号名', rows.some((x) => x.accountName === 'test'), JSON.stringify(rows.map((x) => x.accountName)));
  }
}

srv.kill();
upstream.close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
