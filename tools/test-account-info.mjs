// 账号信息探测：真实端点 / 真实字段结构 / 价格阶梯 / 跨账号目录
// fixture 取自 2026-10-29 真实请求响应（已裁剪）
import http from 'node:http';
import { createAccountInfo, parseModels, parseCreditTiers, pickBalance, balanceTotalOf } from '../lib/account-info.mjs';
import { buildCatalog } from '../lib/model-catalog.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

// ---- 真实响应 fixture ----
const REAL_USER = {
  domain_id: '01a13353feba7038b72fee34947c7319',
  domain_name: 'hid_9p1q7-xiz4eq6hk',
  user_id: '01a13353feba7d2cb321aac5dc360d7b',
  user_name: 'hid_9p1q7-xiz4eq6hk',
  app_types: null,
  user_type: null,
};

const REAL_AGENTS = {
  total: 17,
  agents: [
    { agent_id: '9f0e5cb64a104dcfb4aa90dbedab7dcf', agent_name: 'CodeAgent', is_primary_agent: true, agent_type: 'openapi' },
    { agent_id: 'aaaabbbbccccdddd', agent_name: 'Other', is_primary_agent: false },
  ],
};

const REAL_DETAIL = {
  agent_id: '9f0e5cb64a104dcfb4aa90dbedab7dcf',
  agent_name: 'CodeAgent',
  gpts: {
    models: [
      {
        model_alias: 'GLM-5.2',
        model_name: 'GLM-5.2',
        model_type: 'admin',
        model_parameters: { model_id: 'GLM-5.2', max_tokens: 65536, context_window: 202752, enable_queue: true, supports_prompt_cache: true, usage_limit: 0, channel_source: 'codearts' },
        credit: [{ input_from: 0, input_to: -1, output_from: 0, output_to: -1, input_price: '8', cache_price: '2', output_price: '28' }],
      },
      {
        model_alias: 'openpangu-2.0-pro',
        model_name: 'OpenPangu-2.0-Pro',
        model_type: 'admin',
        model_parameters: { model_id: 'OpenPangu-2.0-Pro', max_tokens: 65535, context_window: 524288, enable_queue: true, supports_prompt_cache: true },
        credit: [
          { input_from: 0, input_to: 32000, output_from: 0, output_to: -1, input_price: '3.2', cache_price: '0.8', output_price: '14.5' },
          { input_from: 32001, input_to: -1, output_from: 0, output_to: -1, input_price: '4.8', cache_price: '1.2', output_price: '17.6' },
        ],
      },
      {
        model_alias: 'deepseek-v4.1-flash',
        model_name: 'DeepSeek-V4.1-Flash',
        model_type: 'admin',
        model_parameters: { model_id: 'DeepSeek-V4.1-Flash', max_tokens: 65536, context_window: 1048576, enable_queue: true, supports_prompt_cache: true },
        credit: [{ input_from: 0, input_to: -1, output_from: 0, output_to: -1, input_price: '2', cache_price: '0.2', output_price: '8' }],
      },
    ],
  },
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
    language: req.headers['x-language'] ?? '',
    currentUser: req.headers['x-current-user'] ?? '',
  });
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (u.pathname === '/snap-manager/v1/current/user') return send(200, REAL_USER);
  if (u.pathname === '/v1/agent-center/agents/useragents') return send(200, REAL_AGENTS);
  if (u.pathname === '/v1/agent-center/agents/detail') return send(200, REAL_DETAIL);
  if (u.pathname === '/api/v1/user/tokens/balance') {
    return send(200, { error_code: '4000', error_msg: 'invalid channel, group not found', result: null });
  }
  if (u.pathname === '/api/v1/gateway/config') {
    return send(200, { error_code: '4000', error_msg: 'invalid channel, group not found', result: null });
  }
  return send(404, { error_msg: 'The API does not exist or has not been published in the environment', error_code: 'APIG.0101' });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const account = {
  id: 'acc-1',
  name: 'acc1',
  accessKeyId: 'HSTAICLDUR19TEST',
  secretAccessKey: 'SK_TEST_SECRET_0123456789abcdefghij',
  securityToken: 'hQpjbi1ub3J0aC00AQAABYxIU1RBSUNMRFVSMTlBS0xWN0pFT',
  userName: 'hid_9p1q7-xiz4eq6hk',
};

console.log('\n\x1b[1m[1] 价格阶梯解析\x1b[0m');
{
  const one = parseCreditTiers([{ input_from: 0, input_to: -1, input_price: '8', cache_price: '2', output_price: '28' }]);
  ok('单档', one.length === 1 && one[0].input === 8 && one[0].cache === 2 && one[0].output === 28, JSON.stringify(one));
  ok('input_to=-1 表示无上限', one[0].inputTo === -1);

  const two = parseCreditTiers([
    { input_from: 0, input_to: 32000, input_price: '3.2', cache_price: '0.8', output_price: '14.5' },
    { input_from: 32001, input_to: -1, input_price: '4.8', cache_price: '1.2', output_price: '17.6' },
  ]);
  ok('两档阶梯', two.length === 2 && two[1].input === 4.8, JSON.stringify(two.map((t) => t.input)));
  ok('字符串价格转数字', typeof two[0].input === 'number');
  ok('空/非数组返回空', parseCreditTiers(null).length === 0 && parseCreditTiers({}).length === 0);
}

console.log('\n\x1b[1m[2] 模型解析（真实结构 gpts.models）\x1b[0m');
{
  const models = parseModels(REAL_DETAIL);
  ok('解析出 3 个模型', models.length === 3, String(models.length));
  const glm = models.find((m) => m.id === 'GLM-5.2');
  ok('id 用 model_parameters.model_id', glm?.id === 'GLM-5.2');
  ok('name 用 model_name', glm?.name === 'GLM-5.2', glm?.name);
  ok('alias 用 model_alias', glm?.alias === 'GLM-5.2');
  ok('maxTokens', glm?.maxTokens === 65536, String(glm?.maxTokens));
  ok('contextWindow', glm?.contextWindow === 202752, String(glm?.contextWindow));
  ok('promptCache 能力', glm?.promptCache === true);
  ok('queue 能力', glm?.queue === true);
  ok('首档价格', glm?.price.input === 8 && glm.price.cache === 2 && glm.price.output === 28, JSON.stringify(glm?.price));

  const pangu = models.find((m) => m.id === 'OpenPangu-2.0-Pro');
  ok('多档保留 tiers', pangu?.tiers.length === 2);
  ok('首档价即标准价', pangu?.price.input === 3.2, String(pangu?.price.input));

  ok('data.gpts 兼容', parseModels({ data: { gpts: { models: REAL_DETAIL.gpts.models } } }).length === 3);
  ok('空结构不炸', parseModels(null).length === 0 && parseModels({}).length === 0);
}

console.log('\n\x1b[1m[3] 余额识别与兜底\x1b[0m');
{
  const b = pickBalance({ data: { remain_tokens: 750000, used_tokens: 250, expire_time: 1, status: 0 } });
  ok('挑出余额字段', b['data.remain_tokens'] === 750000, JSON.stringify(b));
  ok('跳过时间/状态', b['data.expire_time'] === undefined && b['data.status'] === undefined);
  ok('合计只算剩余类', balanceTotalOf({ 'a.total_tokens': 1000, 'a.used_tokens': 250, 'a.remain_tokens': 750 }) === 750);
  ok('空返回 null', balanceTotalOf(null, []) === null);
}

console.log('\n\x1b[1m[4] 真实链路（假服务，真实字段）\x1b[0m');
{
  const cfg = { accountInfo: { snapAccess: base, benefitBase: base, timeoutMs: 8000 } };
  const info = createAccountInfo({ cfg });
  const r = await info.probe(account);

  ok('探测 ok', r.ok === true);
  ok('账号身份解析', r.user?.userId === '01a13353feba7d2cb321aac5dc360d7b', JSON.stringify(r.user));
  ok('智能体数 17', r.agentCount === 17, String(r.agentCount));
  ok('选中 primary agent', r.agentId === '9f0e5cb64a104dcfb4aa90dbedab7dcf', r.agentId);
  ok('模型数 3', r.modelCount === 3, String(r.modelCount));
  ok('余额为 null（无 benefit）', r.balanceTotal === null);
  // 无 benefit 套餐是账号侧状态，不再写进 errors（避免每次都报一条）
  ok('无套餐不写进 errors', !r.errors.some((e) => e.includes('benefit') || e.includes('channel')), JSON.stringify(r.errors));
  ok('benefit 标记为 skipped', r.benefit?.skipped === true, JSON.stringify(r.benefit));
  ok('benefit 保留错误码原文', r.benefit?.code === '4000', r.benefit?.code);
  ok('benefit 保留人话说明', String(r.benefit?.message ?? '').includes('channel'), r.benefit?.message);
  ok('benefit 未启用', r.benefit?.enabled === false);
  ok('无套餐时不调 claim', r.benefit?.claimed === undefined, String(r.benefit?.claimed));
  ok('记录三处来源', !!r.sources.user && !!r.sources.userAgents && !!r.sources.agentDetail, JSON.stringify(Object.keys(r.sources)));
  ok('原始响应已保存', typeof r.raw.user === 'string' && r.raw.user.includes('domain_id'));

  const ua = seen.find((s) => s.path === '/v1/agent-center/agents/useragents');
  ok('useragents 带 Agent-Type', ua?.agentType === 'AgentCenter', ua?.agentType);
  ok('useragents 带 X-Language', ua?.language === 'zh-cn', ua?.language);
  ok('useragents 带 x-current-user', ua?.currentUser === 'hid_9p1q7-xiz4eq6hk', ua?.currentUser);
  ok('用 SDK-HMAC 签名', String(ua?.auth).startsWith('SDK-HMAC-SHA256 Access=HSTAICLDUR19TEST'), String(ua?.auth).slice(0, 50));
  ok('带 X-Security-Token', ua?.token?.startsWith('hQpjbi1'), String(ua?.token).slice(0, 20));
  ok('带 app-id', ua?.appId === 'CodeAgent3.0', ua?.appId);

  const det = seen.find((s) => s.path === '/v1/agent-center/agents/detail');
  ok('detail 带 agent_id', String(det?.search).includes('agent_id=9f0e5cb64a104dcfb4aa90dbedab7dcf'), det?.search);
}

console.log('\n\x1b[1m[5] 异常与降级\x1b[0m');
{
  const bad = createAccountInfo({ cfg: { accountInfo: { snapAccess: `${base}/nope`, benefitBase: `${base}/nope`, timeoutMs: 5000 } } });
  const r = await bad.probe(account);
  ok('全失败 ok=false', r.ok === false);
  // benefit 拒绝不再计入 errors，所以这里只剩 snap-access 的两条
  ok('失败被记录', r.errors.length >= 2, `${r.errors.length} 条`);
  ok('模型数 0', r.modelCount === 0);

  let threw = null;
  try { await bad.probe({ id: 'x' }); } catch (e) { threw = e; }
  ok('缺 AK/SK 报 no_credential', threw?.code === 'no_credential', threw?.code);
}

console.log('\n\x1b[1m[5b] benefit 成功码 "0000" + gateway config 真实结构\x1b[0m');
{
  // CLI 里成功判定是 error_code === "0000"（四个零），不是 "0"
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/snap-manager/v1/current/user') return send(REAL_USER);
    if (u.pathname === '/v1/agent-center/agents/useragents') return send({ total: 1, agents: [{ agent_id: 'A1', agent_name: 'CodeAgent', is_primary_agent: true }] });
    if (u.pathname === '/v1/agent-center/agents/detail') return send(REAL_DETAIL);
    if (u.pathname === '/api/v1/user/tokens/balance') {
      return send({ error_code: '0000', result: { remain_tokens: 750000, used_tokens: 250 } });
    }
    if (u.pathname === '/api/v1/gateway/config') {
      return send({
        error_code: '0000',
        result: {
          endpoint: 'https://benefit-gw.example.com',
          models: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2', model_alias: 'GLM-5.2' },
            { model_id: 'Free-Only-Model', model_name: 'Free-Only-Model', model_alias: 'free-only' },
          ],
        },
      });
    }
    if (u.pathname === '/api/v1/benefit/claim') {
      return send({ error_code: '0000', result: { claimed: true, benefit_id: 'B-001', name: '每日免费额度' } });
    }
    return send({ error_code: 'APIG.0101' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${srv.address().port}`;
  const info = createAccountInfo({ cfg: { accountInfo: { snapAccess: b2, benefitBase: b2, timeoutMs: 8000 } } });
  const r = await info.probe(account);

  ok('"0000" 视为成功', r.balanceTotal === 750000, String(r.balanceTotal));
  ok('余额字段解析', r.balance?.['result.remain_tokens'] === 750000, JSON.stringify(r.balance));
  ok('无错误', r.errors.length === 0, JSON.stringify(r.errors));
  ok('gateway config 记录来源', !!r.sources.gatewayConfig, JSON.stringify(Object.keys(r.sources)));
  ok('benefit 独有模型被并入', r.models.some((m) => m.id === 'Free-Only-Model'), r.models.map((m) => m.id).join(','));
  ok('benefit 模型标 free', r.models.find((m) => m.id === 'Free-Only-Model')?.free === true);
  ok('benefit 模型带 endpoint', r.models.find((m) => m.id === 'Free-Only-Model')?.endpoint === 'https://benefit-gw.example.com');
  ok('同 id 保留 agent-center 价格', r.models.find((m) => m.id === 'GLM-5.2')?.price.input === 8, String(r.models.find((m) => m.id === 'GLM-5.2')?.price.input));
  ok('模型总数 4', r.modelCount === 4, String(r.modelCount));

  // claim：有 benefit 套餐才会调
  ok('benefit 标记 enabled', r.benefit?.enabled === true, JSON.stringify(r.benefit));
  ok('claim 已领取', r.benefit?.claimed === true, String(r.benefit?.claimed));
  ok('claim 返回结果保留', r.benefit?.claimResult?.benefit_id === 'B-001', JSON.stringify(r.benefit?.claimResult));
  ok('claim 记录来源', !!r.sources.claim, JSON.stringify(Object.keys(r.sources)));
  ok('claim 原始响应已存', typeof r.raw.claim === 'string' && r.raw.claim.includes('B-001'), String(r.raw.claim).slice(0, 60));
  srv.close();
}

console.log('\n\x1b[1m[5c] claim 失败（每日名额耗尽）\x1b[0m');
{
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/snap-manager/v1/current/user') return send(REAL_USER);
    if (u.pathname === '/v1/agent-center/agents/useragents') return send({ total: 1, agents: [{ agent_id: 'A1', agent_name: 'CodeAgent', is_primary_agent: true }] });
    if (u.pathname === '/v1/agent-center/agents/detail') return send(REAL_DETAIL);
    if (u.pathname === '/api/v1/user/tokens/balance') return send({ error_code: '0000', result: { remain_tokens: 100 } });
    if (u.pathname === '/api/v1/gateway/config') return send({ error_code: '0000', result: { endpoint: 'https://x', models: [{ model_id: 'M1', model_name: 'M1' }] } });
    if (u.pathname === '/api/v1/benefit/claim') return send({ error_code: '4006', error_msg: 'daily claim limit exhausted', result: null });
    return send({ error_code: 'APIG.0101' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b3 = `http://127.0.0.1:${srv.address().port}`;
  const info = createAccountInfo({ cfg: { accountInfo: { snapAccess: b3, benefitBase: b3, timeoutMs: 8000 } } });
  const r = await info.probe(account);

  ok('claim 失败 claimed=false', r.benefit?.claimed === false, String(r.benefit?.claimed));
  ok('claim 错误码 4006', r.benefit?.claimCode === '4006', r.benefit?.claimCode);
  ok('claim 错误码翻译成中文', String(r.benefit?.claimMessage ?? '').includes('每日名额'), r.benefit?.claimMessage);
  ok('claim 失败不写进 errors', !r.errors.some((e) => e.includes('claim')), JSON.stringify(r.errors));
  ok('余额仍然拿到', r.balanceTotal === 100, String(r.balanceTotal));
  srv.close();
}

console.log('\n\x1b[1m[6] 跨账号模型目录\x1b[0m');
{
  const cat = buildCatalog([
    { id: 'a1', name: 'acc1', info: JSON.stringify({ checkedAt: 't1', modelCount: 2, agentCount: 17, balanceTotal: null, user: { userName: 'u1' }, models: parseModels(REAL_DETAIL).slice(0, 2) }) },
    { id: 'a2', name: 'acc2', enabled: false, info: { checkedAt: 't2', models: [{ id: 'GLM-5.2', alias: 'GLM-5.2', tiers: [{ inputFrom: 0, inputTo: -1, input: 5, cache: 1, output: 20 }], price: { input: 5, cache: 1, output: 20 } }] } },
    { id: 'a3', name: 'acc3', info: 'not json' },
  ]);
  ok('去重后 2 个模型', cat.models.length === 2, String(cat.models.length));
  const glm = cat.models.find((m) => m.id === 'GLM-5.2');
  ok('价格取更低的那份', glm?.price.input === 5, String(glm?.price.input));
  ok('账号列表合并', (glm?.accounts ?? []).join(',') === 'acc1,acc2', JSON.stringify(glm?.accounts));
  ok('能力取并集', glm?.promptCache === true);
  ok('按首档价升序', cat.models[0].id === 'OpenPangu-2.0-Pro', cat.models[0].id);
  ok('账号表 3 条', cat.accounts.length === 3);
  ok('坏 info 不炸', cat.accounts[2].modelCount === 0);
  ok('user 透传', cat.accounts[0].user?.userName === 'u1');
  ok('agentCount 透传', cat.accounts[0].agentCount === 17);
  ok('空账号返回空', buildCatalog([]).models.length === 0);
}

server.close();
console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
