// 批量重放验证
const HUB = 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ' \x1b[90m' + d + '\x1b[0m' : ''}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n} \x1b[31m${d}\x1b[0m`); };
const state = async () => (await fetch(HUB + '/admin/api/state')).json();

// 造 12 条不同类型的请求
console.log('\x1b[1m[1] 准备样本\x1b[0m');
const ids = [];
for (let i = 0; i < 6; i++) {
  await fetch(HUB + '/api/v2/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': 'batch-token' },
    body: JSON.stringify({ model: 'mock-flagship', messages: [{ role: 'user', content: `批量样本 ${i}` }] }),
  });
}
for (let i = 0; i < 3; i++) {
  await fetch(HUB + '/snap-manager/v1/current/user', { headers: { 'x-auth-token': 'batch-token' } });
}
await fetch(HUB + '/api/v2/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'mock-flagship', stream: true, messages: [{ role: 'user', content: '批量 SSE' }] }),
}).then((r) => r.text());
await fetch(HUB + '/v1/agent-center/agents/detail?agent_id=mock-agent-0001', {
  headers: { 'x-auth-token': 'batch-token' },
});

const s = await state();
const recent = s.requests.slice(0, 12);
const chatIds = recent.filter((r) => r.route === 'inferhub.chat' && !r.stream).map((r) => r.id);
const getIds = recent.filter((r) => r.route === 'snap.currentUser').map((r) => r.id);
const sseId = recent.find((r) => r.stream === 'openai')?.id;
const detailId = recent.find((r) => r.route === 'agentCenter.detail')?.id;
for (const id of [...chatIds, ...getIds, sseId, detailId]) if (id) ids.push(id);
ok('样本就绪', `${ids.length} 条（chat ${chatIds.length} / GET ${getIds.length} / SSE ${sseId ? 1 : 0} / detail ${detailId ? 1 : 0}）`);

console.log('\n\x1b[1m[2] 并发批量重放\x1b[0m');
let batch;
{
  const t0 = Date.now();
  const r = await fetch(HUB + '/admin/api/replay-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, concurrency: 6, gapMs: 0 }),
  });
  batch = await r.json();
  if (r.status === 200 && batch.ok) ok('批量接口返回', `${Date.now() - t0}ms 客户端`);
  else bad('批量接口返回', JSON.stringify(batch).slice(0, 200));

  if (batch.executed === ids.length) ok('全部执行', `${batch.executed}/${batch.total}`);
  else bad('全部执行', `${batch.executed}/${batch.total}`);

  if (batch.succeeded === ids.length && batch.failed === 0) ok('全部成功', `成功 ${batch.succeeded}`);
  else bad('全部成功', `成功 ${batch.succeeded} 失败 ${batch.failed}`);

  if (batch.qps > 0) ok('吞吐统计', `${batch.qps} rps, 总 ${batch.durationMs}ms`);
  else bad('吞吐统计', String(batch.qps));

  if (batch.latency.p50 > 0 && batch.latency.max >= batch.latency.p50) {
    ok('延迟分位', `p50 ${batch.latency.p50}ms / p95 ${batch.latency.p95}ms / max ${batch.latency.max}ms`);
  } else bad('延迟分位', JSON.stringify(batch.latency));

  const sseRow = batch.results.find((r) => r.sse);
  if (sseRow?.sse?.includes('DONE')) ok('批量里的 SSE 读完了', sseRow.sse);
  else bad('批量里的 SSE 读完了', JSON.stringify(sseRow));

  if (Object.keys(batch.byStatus).length > 0) ok('状态分布', JSON.stringify(batch.byStatus));
  else bad('状态分布', '空');
}

console.log('\n\x1b[1m[3] 并发度生效\x1b[0m');
{
  // 并发 1 vs 并发 8：同样 6 条 chat，串行应明显更慢（mock 有 latencyMs=80）
  const six = chatIds.slice(0, 6);
  const run = async (c) => {
    const r = await fetch(HUB + '/admin/api/replay-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: six, concurrency: c }),
    });
    return r.json();
  };
  const serial = await run(1);
  const parallel = await run(8);
  const speedup = serial.durationMs / Math.max(1, parallel.durationMs);
  if (speedup > 1.8) ok('并发确实更快', `串行 ${serial.durationMs}ms → 并发8 ${parallel.durationMs}ms（${speedup.toFixed(1)}×）`);
  else bad('并发确实更快', `串行 ${serial.durationMs}ms vs 并发 ${parallel.durationMs}ms`);
}

console.log('\n\x1b[1m[4] 边界情况\x1b[0m');
{
  const r1 = await fetch(HUB + '/admin/api/replay-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  });
  if (r1.status === 400) ok('空 ids → 400');
  else bad('空 ids → 400', String(r1.status));

  const r2 = await (await fetch(HUB + '/admin/api/replay-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['req-nope-1', 'req-nope-2'], concurrency: 2 }),
  })).json();
  if (r2.failed === 2 && r2.succeeded === 0) ok('未知 id 计入失败', JSON.stringify(r2.byStatus));
  else bad('未知 id 计入失败', JSON.stringify(r2).slice(0, 160));

  // 混入一条不存在的 id，其余照常
  const mixed = await (await fetch(HUB + '/admin/api/replay-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [chatIds[0], 'req-nope-3', chatIds[1]], concurrency: 3 }),
  })).json();
  if (mixed.succeeded === 2 && mixed.failed === 1) ok('部分失败不影响其他', `成功 ${mixed.succeeded} 失败 ${mixed.failed}`);
  else bad('部分失败不影响其他', JSON.stringify(mixed).slice(0, 160));

  // stopOnError
  const stopped = await (await fetch(HUB + '/admin/api/replay-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['req-nope-4', chatIds[0], chatIds[1], chatIds[2]], concurrency: 1, stopOnError: true }),
  })).json();
  if (stopped.aborted && stopped.executed < 4) ok('stopOnError 生效', `执行 ${stopped.executed}/${stopped.total}`);
  else bad('stopOnError 生效', JSON.stringify(stopped).slice(0, 160));

  // 并发上限钳制
  const clamped = await (await fetch(HUB + '/admin/api/replay-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [chatIds[0]], concurrency: 999, gapMs: -5 }),
  })).json();
  if (clamped.concurrency === 32 && clamped.gapMs === 0) ok('参数钳制', `并发 ${clamped.concurrency}, 间隔 ${clamped.gapMs}`);
  else bad('参数钳制', JSON.stringify({ c: clamped.concurrency, g: clamped.gapMs }));
}

console.log('\n\x1b[1m[5] 结果落回流水\x1b[0m');
{
  const after = await state();
  const marked = after.requests.filter((r) => r.replayOf && ids.includes(r.replayOf));
  if (marked.length >= ids.length) ok('重放记录已标记 replayOf', `${marked.length} 条`);
  else bad('重放记录已标记 replayOf', `${marked.length} 条`);
}

console.log(`\n\x1b[1m结果：\x1b[0m\x1b[32m${pass} 通过\x1b[0m` + (fail ? `，\x1b[31m${fail} 失败\x1b[0m` : '，\x1b[32m0 失败\x1b[0m'));
if (fail) process.exitCode = 1;
