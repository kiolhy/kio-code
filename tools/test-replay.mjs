// 重放功能验证
const HUB = 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ' \x1b[90m' + d + '\x1b[0m' : ''}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n} \x1b[31m${d}\x1b[0m`); };

const state = async () => (await fetch(HUB + '/admin/api/state')).json();
const newest = async (pred) => (await state()).requests.find(pred);

// 1) 造一条带 token 的 chat 请求
const sentBody = { model: 'mock-flagship', messages: [{ role: 'user', content: '原始请求：重放测试' }] };
const r1 = await fetch(HUB + '/api/v2/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-auth-token': 'replay-secret-token' },
  body: JSON.stringify(sentBody),
});
const t1 = await r1.text();
const rec1 = await newest((r) => r.path === '/api/v2/chat/completions' && r.route === 'inferhub.chat');
if (rec1) ok('造出原始请求', rec1.id);
else { bad('造出原始请求', '没找到记录'); process.exit(1); }

// 2) 取详情
{
  const d = await (await fetch(`${HUB}/admin/api/request/${rec1.id}`)).json();
  if (d.canReplay) ok('详情：可重放', `${d.bodyBytes}B body`);
  else bad('详情：可重放', 'canReplay=false');
  if (d.bodyText?.includes('重放测试')) ok('详情：原始 body 完整');
  else bad('详情：原始 body 完整', String(d.bodyText).slice(0, 80));
  if (d.rawHeaders?.['x-auth-token'] === 'replay-secret-token') ok('详情：原始头未脱敏（重放需要真 token）');
  else bad('详情：原始头未脱敏', JSON.stringify(d.rawHeaders?.['x-auth-token']));
}

// 3) 原样重放
{
  const rep = await (await fetch(HUB + '/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rec1.id }),
  })).json();
  if (rep.ok && rep.status === 200) ok('原样重放', `${rep.status} ${rep.durationMs}ms`);
  else bad('原样重放', JSON.stringify(rep).slice(0, 200));
  if (rep.preview?.includes('重放测试')) ok('重放响应与原请求一致（回显到了）');
  else bad('重放响应与原请求一致', String(rep.preview).slice(0, 120));
  if (rep.replayedId) {
    const fresh = await newest((r) => r.id === rep.replayedId);
    if (fresh?.replayOf === rec1.id) ok('新记录已标记 replayOf', fresh.id);
    else bad('新记录已标记 replayOf', JSON.stringify(fresh?.replayOf));
  } else bad('新记录已标记 replayOf', 'replayedId 为空');
}

// 4) 改 body 重放
{
  const mutated = { model: 'mock-lightweight', messages: [{ role: 'user', content: '被改写的 body' }] };
  const rep = await (await fetch(HUB + '/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rec1.id, bodyText: JSON.stringify(mutated) }),
  })).json();
  if (rep.ok && rep.bodyOverride) ok('改 body 重放', `${rep.status}`);
  else bad('改 body 重放', JSON.stringify(rep).slice(0, 200));
  if (rep.preview?.includes('mock-lightweight') && rep.preview?.includes('被改写的 body')) {
    ok('改 body 生效（模型与内容都变了）');
  } else bad('改 body 生效', String(rep.preview).slice(0, 160));
}

// 5) 重放 SSE
{
  const r = await fetch(HUB + '/api/v2/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-flagship', stream: true, messages: [{ role: 'user', content: 'sse 重放' }] }),
  });
  await r.text();
  const rec = await newest((x) => x.stream === 'openai');
  const rep = await (await fetch(HUB + '/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rec.id }),
  })).json();
  if (rep.ok && rep.sse?.blocks > 0) ok('重放 SSE', `${rep.sse.blocks} 块, done=${rep.sse.sawDone}`);
  else bad('重放 SSE', JSON.stringify(rep).slice(0, 200));
  if (rep.sse?.sawDone) ok('SSE 重放读到 [DONE]');
  else bad('SSE 重放读到 [DONE]', '未见 [DONE]');
}

// 6) 重放 GET（无 body）
{
  await fetch(HUB + '/snap-manager/v1/current/user', { headers: { 'x-auth-token': 'replay-secret-token' } });
  const rec = await newest((x) => x.route === 'snap.currentUser');
  if (!rec) bad('重放 GET', '没找到 snap.currentUser 记录');
  else {
    const rep = await (await fetch(HUB + '/admin/api/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: rec.id }),
    })).json();
    // 断言重放拿到了真实响应体（用户名来自 config.identity，不硬编码具体值）
    if (rep.ok && rep.status === 200 && rep.preview?.includes('user_name')) ok('重放 GET', `${rep.status} 无 body`);
    else bad('重放 GET', JSON.stringify(rep).slice(0, 200));
  }
}

// 7) 不存在的 id
{
  const r = await fetch(HUB + '/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'req-nope' }),
  });
  if (r.status === 404) ok('未知 id → 404');
  else bad('未知 id → 404', String(r.status));
}

// 8) 重放带签名的请求（校验开着也要能过）
{
  const { signRequest } = await import('../lib/sign.mjs');
  const AK = 'AKMOCKHUB0000000000';
  const SK = 'SKMOCKHUB0000000000000000000000000000';
  await fetch(HUB + '/admin/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verifySignature: true, upstream: { sk: SK } }),
  });

  const url = HUB + '/api/v2/chat/completions';
  const body = JSON.stringify({ model: 'mock-flagship', messages: [{ role: 'user', content: '签名后重放' }] });
  const signed = signRequest({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(body),
    ak: AK,
    sk: SK,
  });

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed.headers },
    body,
  });
  await r.text();
  if (r.status !== 200) bad('签名请求本身', String(r.status));
  else {
    const rec = await newest((x) => x.route === 'inferhub.chat' && x.signature?.ok === true);
    if (!rec) bad('签名请求已记录', '未找到 ok 的签名记录');
    else {
      const rep = await (await fetch(HUB + '/admin/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: rec.id }),
      })).json();
      if (rep.ok && rep.status === 200) ok('重放签名请求（校验开启）', `${rep.status}`);
      else bad('重放签名请求（校验开启）', JSON.stringify(rep).slice(0, 240));
    }
  }

  await fetch(HUB + '/admin/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verifySignature: false }),
  });
}

console.log(`\n\x1b[1m结果：\x1b[0m\x1b[32m${pass} 通过\x1b[0m` + (fail ? `，\x1b[31m${fail} 失败\x1b[0m` : '，\x1b[32m0 失败\x1b[0m'));
if (fail) process.exitCode = 1;
