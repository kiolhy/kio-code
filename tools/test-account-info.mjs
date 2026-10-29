// 账号信息探测：余额 / 模型（数组 + 对象 map）/ 每模型积分 / 兜底数字 / 请求头
import http from 'node:http';
import { createAccountInfo, pickBalance, pickModels, collectNumbers, balanceTotalOf } from '../lib/account-info.mjs';
import { buildCatalog } from '../lib/model-catalog.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

const seen = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.push({
    path: u.pathname,
    search: u.search,
    auth: req.headers.authorization ?? '',
    token: req.headers['x-security-token'] ?? '',
    appId: req.headers['app-id'] ?? '',
    agentType: req.headers['agent-type'] ?? '',
    clientType: req.headers['x-client-type'] ?? '',
    currentUser: req.headers['x-current-user'] ?? '',
  });
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (u.pathname === '/api/v1/user/tokens/balance') {
    return send(200, { code: 0, data: { total_tokens: 1000000, used_tokens: 250000, remain_tokens: 750000, expire_time: 1767225600000 } });
  }
  if (u.pathname === '/api/v1/gateway/config') {
    // 真实形状：模型是对象 map，键名即模型 id
    return send(200, {
      endpoint: 'https://example/gw',
      models: {
        'glm-4.6': { credit: 5, limit: 500, endpoint: 'https://example/glm' },
        'deepseek-v3.2': { credit: 3, enable_queue: true },
        'kimi-k2': { reasoning: true, limit: 2000 },
      },
    });
  }
  if (u.pathname === '/v1/agent-center/agents/useragents') {
    return send(200, { data: [{ agent_id: 'a8bcb36232554267a5142361cc25a393', name: 'CodeAgent' }] });
  }
  if (u.pathname === '/v1/agent-center/agents/detail') {
    return send(200, {
      data: { gpts: { models: [
        { id: 'glm-4.6', credit: 8, limit: 1000, reasoning: false },
        { id: 'kimi-k2', credit: 12, limit: 2000, reasoning: true },
      ] } },
    });
  }
  if (u.pathname === '/weird/balance') {
    // 字段名完全不认识：只能靠 numbers 兜底
    return send(200, { r: { s: { x: 42, y: 8 } } });
  }
  return send(404, { error_msg: 'The API does not exist or has not been published in the environment', error_code: 'APIG.0101' });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const account = {
  id: 'acc-1',
  name: 'acc1',
  accessKeyId: 'HSTA_TEST_AK',
  secretAccessKey: 'SK_TEST_SECRET',
  securityToken: 'ST_TEST_TOKEN',
  userName: 'user-a',
};

console.log('\n\x1b[1m[1] 纯解析函数\x1b[0m');
{
  const b = pickBalance({ data: { remain_tokens: 750000, used_tokens: 250, expire_time: 1, status: 0 } });
  ok('挑出余额字段', b['data.remain_tokens'] === 750000, JSON.stringify(b));
  ok('跳过时间/状态字段', b['data.expire_time'] === undefined && b['data.status'] === undefined);
  ok('放宽到 amount/count 类', pickBalance({ a: { amount: 9, count: 2 } })['a.amount'] === 9);

  const arr = pickModels({ data: { gpts: { models: [{ id: 'x', credit: 7, limit: 9, reasoning: true }] } } });
  ok('数组形状', arr.length === 1 && arr[0].id === 'x' && arr[0].credit === 7, JSON.stringify(arr));
  ok('识别推理模型', arr[0].reasoning === true);

  const map = pickModels({ models: { 'glm-4.6': { credit: 5, limit: 500, endpoint: 'https://example/glm' }, 'kimi-k2': { reasoning: true } } });
  ok('对象 map：键名当模型 id', map.length === 2 && map.map((m) => m.id).sort().join(',') === 'glm-4.6,kimi-k2', JSON.stringify(map.map((m) => m.id)));
  ok('对象 map：读到 credit', map.find((m) => m.id === 'glm-4.6')?.credit === 5);
  ok('对象 map：读到 endpoint', map.find((m) => m.id === 'glm-4.6')?.endpoint === 'https://example/glm');

  const strs = pickModels({ models: ['glm-4.6', 'kimi-k2'] });
  ok('纯字符串数组', strs.length === 2 && strs[0].id === 'glm-4.6', JSON.stringify(strs.map((m) => m.id)));

  ok('字符串数字也认', pickModels([{ model: 'y', price: '3' }])[0].credit === 3);
  ok('非模型对象不误判', pickModels({ a: { foo: 1 }, b: { bar: 2 } }).length === 0);
  ok('普通数组不误判', pickModels({ list: [{ foo: 1 }, { bar: 2 }] }).length === 0);

  const nums = collectNumbers({ r: { s: { x: 42, y: '8', z: 'abc' } } });
  ok('兜底收数字叶子', nums.length === 2 && nums[0].path === 'r.s.x' && nums[1].value === 8, JSON.stringify(nums));
  ok('兜底有上限', collectNumbers({ a: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])) }, 10).length === 10);
}

console.log('\n\x1b[1m[2] 比例与合计\x1b[0m');
{
  ok('余额合计只算剩余类字段', balanceTotalOf({ 'a.total_tokens': 1000, 'a.used_tokens': 250, 'a.remain_tokens': 750 }) === 750);
  ok('无剩余字段时退化为求和', balanceTotalOf({ 'a.x': 3, 'a.y': 4 }) === 7);
  ok('余额为空时用 numbers 兜底', balanceTotalOf({}, [{ path: 'r.remain', value: 500 }, { path: 'r.x', value: 1 }]) === 500);
  ok('都没有返回 null', balanceTotalOf(null, []) === null);
}

console.log('\n\x1b[1m[3] 探测真实链路（假服务）\x1b[0m');
{
  const cfg = { accountInfo: { bases: [base], timeoutMs: 8000, rawLimit: 400 }, oauth: { proxy: '' } };
  const info = createAccountInfo({ cfg });
  const r = await info.probe(account);

  ok('探测成功', r.ok === true, JSON.stringify({ ok: r.ok, models: r.modelCount }));
  ok('余额解析到 remain_tokens', r.balance?.['data.remain_tokens'] === 750000, JSON.stringify(r.balance));
  ok('余额合计 = 剩余 token', r.balanceTotal === 750000, String(r.balanceTotal));
  ok('兜底数字也记下', r.numbers.length >= 3, String(r.numbers.length));
  ok('模型数 = 3', r.modelCount === 3, String(r.modelCount));

  const glm = r.models.find((m) => m.id === 'glm-4.6');
  ok('同 id 以 agent-center 的 credit 为准', glm?.credit === 8, String(glm?.credit));
  ok('glm limit 也更新', glm?.limit === 1000, String(glm?.limit));
  ok('对象 map 的 deepseek 也在', !!r.models.find((m) => m.id === 'deepseek-v3.2'));
  ok('对象 map 的排队标记', r.models.find((m) => m.id === 'deepseek-v3.2')?.queued === true);
  ok('agent detail 的 kimi credit', r.models.find((m) => m.id === 'kimi-k2')?.credit === 12);
  ok('gateway config 的模型标 free', r.models.find((m) => m.id === 'deepseek-v3.2')?.free === true);
  ok('记录三处来源', !!r.sources.balance && !!r.sources.gatewayConfig && !!r.sources.agentDetail, JSON.stringify(r.sources));
  ok('无失败尝试', r.errors.length === 0, JSON.stringify(r.errors));
  ok('带耗时', typeof r.durationMs === 'number');

  ok('原始响应已保存', typeof r.raw.balance === 'string' && r.raw.balance.includes('remain_tokens'));
  ok('原始响应按 rawLimit 截断', r.raw.balance.length <= 401, String(r.raw.balance.length));

  const bal = seen.find((s) => s.path === '/api/v1/user/tokens/balance');
  ok('用 SDK-HMAC-SHA256 签名', String(bal?.auth).startsWith('SDK-HMAC-SHA256 Access=HSTA_TEST_AK'), String(bal?.auth).slice(0, 60));
  ok('带 X-Security-Token', bal?.token === 'ST_TEST_TOKEN', bal?.token);
  ok('benefit 端点不带 Agent-Type', bal?.agentType === '', `"${bal?.agentType}"`);

  const ua = seen.find((s) => s.path === '/v1/agent-center/agents/useragents');
  ok('agent-center 带 Agent-Type', ua?.agentType === 'AgentCenter', `"${ua?.agentType}"`);
  ok('agent-center 带 x-client-type', ua?.clientType === 'DevMate', ua?.clientType);
  ok('agent-center 带 x-current-user', ua?.currentUser === 'user-a', ua?.currentUser);
  const det = seen.find((s) => s.path === '/v1/agent-center/agents/detail');
  ok('agent detail 带 agent_id', String(det?.search).includes('agent_id=a8bcb36232554267a5142361cc25a393'), det?.search);
}

console.log('\n\x1b[1m[4] 字段名不认识时的兜底\x1b[0m');
{
  const cfg = { accountInfo: { bases: [base], balancePath: '/weird/balance', gatewayConfigPath: '/weird/gw', timeoutMs: 8000 } };
  const info = createAccountInfo({ cfg });
  const r = await info.probe(account);
  ok('认不出余额字段', Object.keys(r.balance ?? {}).length === 0);
  ok('但数字兜底拿到了', r.numbers.length === 2, JSON.stringify(r.numbers));
  ok('有数字就算 ok', r.ok === true);
  ok('合计从 numbers 推不出来时为 null', r.balanceTotal === null, String(r.balanceTotal));
}

console.log('\n\x1b[1m[5] 异常与降级\x1b[0m');
{
  const bad = createAccountInfo({ cfg: { accountInfo: { bases: [`${base}/nope`], timeoutMs: 5000 } } });
  const r = await bad.probe(account);
  ok('全失败时 ok=false', r.ok === false);
  ok('同一 base 的失败合并成一条', r.errors.length === 1, `${r.errors.length} 条`);
  ok('失败信息含端点名', /balance|gateway|useragents/.test(r.errors[0] ?? ''), String(r.errors[0]).slice(0, 80));
  ok('模型数为 0', r.modelCount === 0);

  let threw = null;
  try { await bad.probe({ id: 'x' }); } catch (e) { threw = e; }
  ok('缺 AK/SK 明确报错', threw?.code === 'no_credential', threw?.code);
}

server.close();

console.log('\n\x1b[1m[6] 跨账号模型目录\x1b[0m');
{
  const cat = buildCatalog([
    { id: 'a1', name: 'acc1', info: JSON.stringify({ checkedAt: 't1', modelCount: 2, balanceTotal: 100, models: [{ id: 'glm-4.6', credit: 5, free: true }, { id: 'kimi-k2', credit: 12, reasoning: true }] }) },
    { id: 'a2', name: 'acc2', enabled: false, info: { checkedAt: 't2', balanceTotal: null, models: [{ id: 'glm-4.6', credit: 8, limit: 1000 }] } },
    { id: 'a3', name: 'acc3', info: 'not json' },
  ]);
  ok('去重后 2 个模型', cat.models.length === 2, String(cat.models.length));
  const glm = cat.models.find((m) => m.id === 'glm-4.6');
  ok('同 id 取最大 credit', glm?.credit === 8, String(glm?.credit));
  ok('标记位取并集', glm?.free === true);
  ok('额度取非空', glm?.limit === 1000, String(glm?.limit));
  ok('账号列表合并去重', (glm?.accounts ?? []).join(',') === 'acc1,acc2', JSON.stringify(glm?.accounts));
  ok('按 credit 降序', cat.models[0].id === 'kimi-k2', cat.models[0].id);
  ok('账号状态表 3 条', cat.accounts.length === 3);
  ok('坏 info 不炸', cat.accounts[2].modelCount === 0, String(cat.accounts[2].modelCount));
  ok('balanceTotal 透传', cat.accounts[0].balanceTotal === 100, String(cat.accounts[0].balanceTotal));
  ok('停用标记透传', cat.accounts[1].enabled === false);
  ok('空账号返回空目录', buildCatalog([]).models.length === 0);
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
