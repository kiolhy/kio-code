// 账号信息探测：余额 / 模型 / 每模型积分（假服务校验签名与解析）
import http from 'node:http';
import { createAccountInfo, pickBalance, pickModels, balanceTotalOf } from '../lib/account-info.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

const seen = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.push({ path: u.pathname, search: u.search, auth: req.headers.authorization ?? '', token: req.headers['x-security-token'] ?? '', appId: req.headers['app-id'] ?? '' });
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (u.pathname === '/api/v1/user/tokens/balance') {
    return send(200, { code: 0, data: { total_tokens: 1000000, used_tokens: 250000, remain_tokens: 750000, expire_time: 1767225600000 } });
  }
  if (u.pathname === '/api/v1/gateway/config') {
    return send(200, {
      endpoint: 'https://example/gw',
      models: [
        { id: 'glm-4.6', credit: 5, limit: 500 },
        { id: 'deepseek-v3.2', credit: 3, enable_queue: true },
      ],
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
  return send(404, { error: 'not_found' });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const cfg = { accountInfo: { bases: [base], timeoutMs: 8000 }, oauth: { proxy: '' } };
const info = createAccountInfo({ cfg });

const account = {
  id: 'acc-1',
  accessKeyId: 'HSTA_TEST_AK',
  secretAccessKey: 'SK_TEST_SECRET',
  securityToken: 'ST_TEST_TOKEN',
};

console.log('\n\x1b[1m[1] 纯解析函数\x1b[0m');
{
  const b = pickBalance({ data: { remain_tokens: 750000, used_tokens: 250, expire_time: 1, status: 0 } });
  ok('挑出余额字段', b['data.remain_tokens'] === 750000, JSON.stringify(b));
  ok('跳过时间/状态字段', b['data.expire_time'] === undefined && b['data.status'] === undefined);

  const m = pickModels({ data: { gpts: { models: [{ id: 'x', credit: 7, limit: 9, reasoning: true }] } } });
  ok('从深层数组里挑出模型', m.length === 1 && m[0].id === 'x' && m[0].credit === 7, JSON.stringify(m));
  ok('识别推理模型', m[0].reasoning === true);
  ok('字符串数字也认', pickModels([{ model: 'y', price: '3' }])[0].credit === 3);
  ok('非模型数组不误判', pickModels({ a: [{ foo: 1 }] }).length === 0);
}

console.log('\n\x1b[1m[2] 探测真实链路（假服务）\x1b[0m');
{
  ok('余额合计只算剩余类字段', balanceTotalOf({ 'a.total_tokens': 1000, 'a.used_tokens': 250, 'a.remain_tokens': 750 }) === 750, String(balanceTotalOf({ 'a.total_tokens': 1000, 'a.used_tokens': 250, 'a.remain_tokens': 750 })));
  ok('无剩余字段时退化为求和', balanceTotalOf({ 'a.x': 3, 'a.y': 4 }) === 7);

  const r = await info.probe(account);
  ok('探测成功', r.ok === true, JSON.stringify({ ok: r.ok, models: r.modelCount }));
  ok('余额解析到 remain_tokens', r.balance?.['data.remain_tokens'] === 750000, JSON.stringify(r.balance));
  ok('余额合计 = 剩余 token', r.balanceTotal === 750000, String(r.balanceTotal));
  ok('模型数 >= 3', r.modelCount >= 3, String(r.modelCount));
  const glm = r.models.find((m) => m.id === 'glm-4.6');
  ok('同 id 以 agent-center 的 credit 为准', glm?.credit === 8, String(glm?.credit));
  ok('glm limit 也更新', glm?.limit === 1000, String(glm?.limit));
  ok('deepseek 来自 gateway config', !!r.models.find((m) => m.id === 'deepseek-v3.2'));
  ok('kimi 来自 agent detail', !!r.models.find((m) => m.id === 'kimi-k2'));
  ok('gateway config 的模型标 free', r.models.find((m) => m.id === 'deepseek-v3.2')?.free === true);
  ok('记录数据来源', !!r.sources.balance && !!r.sources.gatewayConfig && !!r.sources.agentDetail, JSON.stringify(r.sources));
  ok('无失败尝试', r.errors.length === 0, JSON.stringify(r.errors));
  ok('带耗时', typeof r.durationMs === 'number');

  const bal = seen.find((s) => s.path === '/api/v1/user/tokens/balance');
  ok('用 SDK-HMAC-SHA256 签名', String(bal?.auth).startsWith('SDK-HMAC-SHA256 Access=HSTA_TEST_AK'), String(bal?.auth).slice(0, 60));
  ok('带 X-Security-Token', bal?.token === 'ST_TEST_TOKEN', bal?.token);
  ok('带 app-id', bal?.appId === 'CodeAgent3.0', bal?.appId);
  const det = seen.find((s) => s.path === '/v1/agent-center/agents/detail');
  ok('agent detail 带 agent_id', String(det?.search).includes('agent_id=a8bcb36232554267a5142361cc25a393'), det?.search);
}

console.log('\n\x1b[1m[3] 异常与降级\x1b[0m');
{
  const bad = createAccountInfo({ cfg: { accountInfo: { bases: [`${base}/nope`], timeoutMs: 5000 } } });
  const r = await bad.probe(account);
  ok('全失败时 ok=false', r.ok === false);
  ok('失败原因被记录', r.errors.length >= 3, `${r.errors.length} 条`);
  ok('模型数为 0', r.modelCount === 0);

  let threw = null;
  try { await info.probe({ id: 'x' }); } catch (e) { threw = e; }
  ok('缺 AK/SK 明确报错', threw?.code === 'no_credential', threw?.code);
}

server.close();
console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
