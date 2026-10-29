// 流式 usage 修复：include_usage 注入 + 上游不给 usage 时的本地估算
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildUpstreamBody, estimateTokensFromChars, estimatePromptTokens, ensureUsage } from '../lib/gateway.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

console.log('\n\x1b[1m[1] 流式请求必须带 include_usage\x1b[0m');
{
  const b = buildUpstreamBody({ model: 'M', messages: [{ role: 'user', content: 'hi' }] }, { stream: true });
  ok('stream=true 时注入 stream_options', b.stream_options?.include_usage === true, JSON.stringify(b.stream_options));
  ok('stream 被设为 true', b.stream === true);

  const b2 = buildUpstreamBody({ model: 'M', messages: [], stream: true }, { stream: true });
  ok('已显式 stream:true 也注入', b2.stream_options?.include_usage === true);

  const b3 = buildUpstreamBody({ model: 'M', stream: true, stream_options: { foo: 1 } }, { stream: true });
  ok('保留原有 stream_options 字段', b3.stream_options?.foo === 1 && b3.stream_options?.include_usage === true, JSON.stringify(b3.stream_options));

  const b4 = buildUpstreamBody({ model: 'M', messages: [] }, { stream: false });
  ok('非流式不注入', b4.stream_options === undefined, JSON.stringify(b4.stream_options));
}

console.log('\n\x1b[1m[2] token 估算\x1b[0m');
{
  ok('纯英文 4 字符 ≈ 1 token', estimateTokensFromChars('abcd') === 1, String(estimateTokensFromChars('abcd')));
  ok('纯英文 40 字符 ≈ 10 token', estimateTokensFromChars('a'.repeat(40)) === 10, String(estimateTokensFromChars('a'.repeat(40))));
  ok('中文 1 字 ≈ 1 token', estimateTokensFromChars('你好世界') === 4, String(estimateTokensFromChars('你好世界')));
  ok('中英混合', estimateTokensFromChars('你好ab') === 3, String(estimateTokensFromChars('你好ab')));
  ok('空字符串 0', estimateTokensFromChars('') === 0);
  ok('null 安全', estimateTokensFromChars(null) === 0);

  const p = estimatePromptTokens({ messages: [{ role: 'user', content: '你好世界' }] });
  ok('从 messages 估算输入', p >= 4, String(p));

  const p2 = estimatePromptTokens({
    messages: [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: '写个函数' },
    ],
    tools: [{ function: { name: 'f', description: 'do something', parameters: { type: 'object' } } }],
  });
  ok('含 system + tools 估算更大', p2 > p, `${p2} vs ${p}`);
  ok('空 body 返回 0', estimatePromptTokens(null) === 0);
}

console.log('\n\x1b[1m[3] ensureUsage 兜底\x1b[0m');
{
  // 上游给了 usage
  const r1 = ensureUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  ok('上游有 usage 原样用', r1.usage.prompt_tokens === 100 && r1.estimated === false);

  // 上游没给，但有输出内容
  const r2 = ensureUsage(null, {
    requestBody: { messages: [{ role: 'user', content: '你好' }] },
    responseJson: { choices: [{ message: { content: '你好世界，这是回复' } }] },
  });
  ok('无 usage 时本地估算', r2.estimated === true, String(r2.estimated));
  ok('估算出输入 token', r2.usage.prompt_tokens > 0, String(r2.usage.prompt_tokens));
  ok('估算出输出 token', r2.usage.completion_tokens > 0, String(r2.usage.completion_tokens));
  ok('total = 入 + 出', r2.usage.total_tokens === r2.usage.prompt_tokens + r2.usage.completion_tokens);
  ok('打上 _estimated 标记', r2.usage._estimated === true);

  // usage 在别的字段
  const r3 = ensureUsage(null, { responseJson: { data: { usage: { prompt_tokens: 7, completion_tokens: 3 } } } });
  ok('兼容 data.usage', r3.usage.prompt_tokens === 7);

  // 完全没数据
  const r4 = ensureUsage(null, {});
  ok('无数据返回 null', r4.usage === null && r4.estimated === false);
}

console.log('\n\x1b[1m[4] 端到端：上游 SSE 不带 usage\x1b[0m');
{
  // 模拟上游：SSE 只给内容，最后 [DONE]，完全不给 usage
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 故意不给 usage，模拟 CodeArts 实际行为
      res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: '这是' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: '一段测试回复内容' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-usage-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'data', 'settings.json'),
    JSON.stringify({
      panel: { password: null, changed: false },
      accounts: [{
        id: 'acc1', name: 'test', enabled: true, region: 'cn',
        accessKeyId: 'HSTAICLDUR19TESTAK', secretAccessKey: 'SK_TEST_SECRET_0123456789abcdef',
        securityToken: 'TOK', userName: 'hid_test_user',
      }],
      apiKeys: [], proxies: [], settings: {},
    })
  );
  const cfg = {
    mode: 'gateway',
    identity: { agentId: 'a', codeAgentId: 'c', userName: 'u', userId: 'i', domainId: 'd', stationType: 'china' },
    gateway: { defaultRegion: 'cn', regions: { cn: `http://127.0.0.1:${upPort}` }, chatPath: '/v1/chat/completions', owner: 'codearts', requireKey: false, models: [] },
    stealth: { enabled: false },
    capture: { enabled: false },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const { spawn } = await import('node:child_process');
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, MOCK_HUB_CONFIG: path.join(dir, 'config.json'), MOCK_HUB_DATA: path.join(dir, 'data'), PORT: String(port) },
    stdio: 'ignore',
  });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      if (h.ok) { ready = true; break; }
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    ok('服务启动', false, '超时');
  } else {
    ok('服务启动', true);

    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash-1017', messages: [{ role: 'user', content: '你好，请介绍一下自己' }], stream: true }),
    });
    const text = await r.text();
    ok('流式返回 200', r.status === 200, String(r.status));
    ok('内容透传', text.includes('一段测试回复内容'), text.slice(0, 80));

    await new Promise((r2) => setTimeout(r2, 400));

    const usageFile = path.join(dir, 'data', 'usage.jsonl');
    const rows = fs.existsSync(usageFile)
      ? fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    ok('落库 1 条', rows.length === 1, String(rows.length));
    const row = rows[0] ?? {};
    ok('promptTokens 不为 0', (row.promptTokens ?? 0) > 0, String(row.promptTokens));
    ok('completionTokens 不为 0', (row.completionTokens ?? 0) > 0, String(row.completionTokens));
    ok('标记为估算', row.estimated === true, String(row.estimated));
    ok('模型名记录正确', row.model === 'DeepSeek-V4.1-Flash-1017', row.model);
    ok('输出 token 约等于内容长度', row.completionTokens >= 8 && row.completionTokens <= 20, String(row.completionTokens));

    srv.kill();
  }
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n\x1b[1m[5] 端到端：上游 SSE 用 data:无空格 + 带 usage\x1b[0m');
{
  // 真实码道上游发的是 `data:{...}`（冒号后没有空格），不是标准 SSE 的
  // `data: {...}`。只认带空格的那种会把所有 chunk 都跳过，usage 永远是 0
  // 但 estimated 又是 false（因为以为上游给了）—— 流水里就是 in=0 out=0。
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (o) => res.write(`data:${JSON.stringify(o)}\n\n`);
      w({ id: 'c1', choices: [{ delta: { content: '这是' } }] });
      w({ id: 'c1', choices: [{ delta: { content: '一段测试回复内容' } }] });
      w({ id: 'c1', choices: [{ delta: { content: '' }, finish_reason: 'stop' }] });
      w({ id: 'c1', choices: [], usage: { prompt_tokens: 25, completion_tokens: 40, total_tokens: 65 } });
      res.write('data:[DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-usage2-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'data', 'settings.json'),
    JSON.stringify({
      panel: { password: null, changed: false },
      accounts: [{
        id: 'acc1', name: 'test', enabled: true, region: 'cn',
        accessKeyId: 'HSTAICLDUR19TESTAK', secretAccessKey: 'SK_TEST_SECRET_0123456789abcdef',
        securityToken: 'TOK', userName: 'hid_test_user',
      }],
      apiKeys: [], proxies: [], settings: {},
    })
  );
  const cfg = {
    mode: 'gateway',
    identity: { agentId: 'a', codeAgentId: 'c', userName: 'u', userId: 'i', domainId: 'd', stationType: 'china' },
    gateway: { defaultRegion: 'cn', regions: { cn: `http://127.0.0.1:${upPort}` }, chatPath: '/v1/chat/completions', owner: 'codearts', requireKey: false, models: [] },
    stealth: { enabled: false },
    capture: { enabled: false },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const { spawn } = await import('node:child_process');
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, MOCK_HUB_CONFIG: path.join(dir, 'config.json'), MOCK_HUB_DATA: path.join(dir, 'data'), PORT: String(port) },
    stdio: 'ignore',
  });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      if (h.ok) { ready = true; break; }
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    ok('服务启动', false, '超时');
  } else {
    ok('服务启动', true);

    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: '你好' }], stream: true }),
    });
    const text = await r.text();
    ok('流式返回 200', r.status === 200, String(r.status));
    ok('内容透传', text.includes('一段测试回复内容'), text.slice(0, 60));

    await new Promise((r2) => setTimeout(r2, 400));

    const usageFile = path.join(dir, 'data', 'usage.jsonl');
    const rows = fs.existsSync(usageFile)
      ? fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    ok('落库 1 条', rows.length === 1, String(rows.length));
    const row = rows[0] ?? {};
    // 这两条是回归重点：之前是 0/0
    ok('promptTokens 用上游真实值 25', row.promptTokens === 25, String(row.promptTokens));
    ok('completionTokens 用上游真实值 40', row.completionTokens === 40, String(row.completionTokens));
    ok('标记为真实值（非估算）', row.estimated === false, String(row.estimated));
    // 测试环境没有模型价格表，credit 会是 null；这里只验证 token 落库正确
    ok('total = 入 + 出', row.promptTokens + row.completionTokens === 65, `${row.promptTokens}+${row.completionTokens}`);

    srv.kill();
  }
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
}


console.log('\n\x1b[1m[6] 上游整段响应没有 usage chunk\x1b[0m');
{
  // 复现远程实例那条 in=0 out=0：上游只发 delta，不发 usage，
  // 且 max_tokens 小到正文为空（只有 reasoning）。旧代码 outChars>0
  // 才估算，导致 usage 保持 null，流水记成 0/0 却标 estimated=false。
  const upstream = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (o) => res.write(`data:${JSON.stringify(o)}\n\n`);
      w({ id: 'c1', choices: [{ delta: { role: 'assistant', reasoning_content: '思考中' } }] });
      w({ id: 'c1', choices: [{ delta: { content: '' }, finish_reason: 'length' }] });
      // 故意不发 usage chunk
      res.write('data:[DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-nousage-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'data', 'settings.json'),
    JSON.stringify({
      panel: { password: null, changed: false },
      accounts: [{
        id: 'acc1', name: 'test', enabled: true, region: 'cn',
        accessKeyId: 'HSTAICLDUR19TESTAK', secretAccessKey: 'SK_TEST_SECRET_0123456789abcdef',
        securityToken: 'TOK', userName: 'hid_test_user',
      }],
      apiKeys: [], proxies: [], settings: {},
    })
  );
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    mode: 'gateway',
    identity: { agentId: 'a', codeAgentId: 'c', userName: 'u', userId: 'i', domainId: 'd', stationType: 'china' },
    gateway: { defaultRegion: 'cn', regions: { cn: `http://127.0.0.1:${upPort}` }, chatPath: '/v1/chat/completions', owner: 'codearts', requireKey: false, models: [] },
    stealth: { enabled: false },
    capture: { enabled: false },
  }, null, 2));

  const { spawn } = await import('node:child_process');
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, MOCK_HUB_CONFIG: path.join(dir, 'config.json'), MOCK_HUB_DATA: path.join(dir, 'data'), PORT: String(port) },
    stdio: 'ignore',
  });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      if (h.ok) { ready = true; break; }
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    ok('服务启动', false, '超时');
  } else {
    ok('服务启动', true);

    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: '你好世界' }], stream: true }),
    });
    ok('流式返回 200', r.status === 200, String(r.status));
    await r.text();

    await new Promise((r2) => setTimeout(r2, 500));

    const usageFile = path.join(dir, 'data', 'usage.jsonl');
    const rows = fs.existsSync(usageFile)
      ? fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    ok('落库 1 条', rows.length === 1, String(rows.length));
    const row = rows[0] ?? {};
    // 关键回归：输入 token 必须估算出来，不能是 0
    ok('输入 token 按请求体估算', row.promptTokens > 0, String(row.promptTokens));
    ok('标记为估算', row.estimated === true, String(row.estimated));
    ok('标记 noUsageChunk', row.noUsageChunk === true, String(row.noUsageChunk));
    // reasoning_content 也算输出，所以不是 0，而是按「思考中」估出来的 3
    ok('输出 token 按 reasoning 估算', row.completionTokens > 0, String(row.completionTokens));

    srv.kill();
  }
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
}


console.log('\n\x1b[1m[7] 流里夹带业务错误（HTTP 200 但内容是报错）\x1b[0m');
{
  // 实测上游对未注册的模型返回：
  //   data:{"text":"[DONE]","error_code":"InferHub.002002009.404",
  //         "error_msg":"The model is not registered, please request other model"}
  // HTTP 状态还是 200，没有 choices。以前这种被当成正常数据转发，
  // 流水记成 200 + in=3090 + out=0，看着像成功其实一个字都没生成。
  const upstream = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data:{"text":"[DONE]","error_code":"InferHub.002002009.404","error_msg":"The model is not registered, please request other model"}\n\n');
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-bizerr-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'data', 'settings.json'),
    JSON.stringify({
      panel: { password: null, changed: false },
      accounts: [{
        id: 'acc1', name: 'test', enabled: true, region: 'cn',
        accessKeyId: 'HSTAICLDUR19TESTAK', secretAccessKey: 'SK_TEST_SECRET_0123456789abcdef',
        securityToken: 'TOK', userName: 'hid_test_user',
      }],
      apiKeys: [], proxies: [], settings: {},
    })
  );
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    mode: 'gateway',
    identity: { agentId: 'a', codeAgentId: 'c', userName: 'u', userId: 'i', domainId: 'd', stationType: 'china' },
    gateway: { defaultRegion: 'cn', regions: { cn: `http://127.0.0.1:${upPort}` }, chatPath: '/v1/chat/completions', owner: 'codearts', requireKey: false, models: [] },
    stealth: { enabled: false },
    capture: { enabled: false },
  }, null, 2));

  const { spawn } = await import('node:child_process');
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, MOCK_HUB_CONFIG: path.join(dir, 'config.json'), MOCK_HUB_DATA: path.join(dir, 'data'), PORT: String(port) },
    stdio: 'ignore',
  });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      if (h.ok) { ready = true; break; }
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    ok('服务启动', false, '超时');
  } else {
    ok('服务启动', true);

    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash-1017', messages: [{ role: 'user', content: '你好' }], stream: true }),
    });
    await r.text();

    await new Promise((r2) => setTimeout(r2, 500));

    const usageFile = path.join(dir, 'data', 'usage.jsonl');
    const rows = fs.existsSync(usageFile)
      ? fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    ok('落库 1 条', rows.length === 1, String(rows.length));
    const row = rows[0] ?? {};
    // 关键回归：不能记成 200 成功
    ok('状态记成失败（404）', row.status === 404, String(row.status));
    ok('带 bizError 标记', row.bizError != null, JSON.stringify(row.bizError));
    ok('bizError.code 保留原始码',
      String(row.bizError?.code) === 'InferHub.002002009.404', String(row.bizError?.code));
    ok('bizError.message 有内容',
      String(row.bizError?.message || '').includes('not registered'), String(row.bizError?.message));

    srv.kill();
  }
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
