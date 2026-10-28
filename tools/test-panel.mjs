// 面板层回归：认证、账号池、API Key、鉴权开关、用量归因。
const HUB = process.env.HUB ?? 'http://127.0.0.1:8787';
const PWD = process.env.PANEL_PASSWORD ?? 'admin';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  }
};

const req = async (path, opts = {}) => {
  const r = await fetch(HUB + path, { redirect: 'manual', ...opts });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
};

console.log('\n\x1b[1m[1] 登录与鉴权\x1b[0m');
{
  const anon = await req('/');
  ok('未登录访问 / 跳登录', anon.status === 302 && anon.headers.get('location') === '/login', `${anon.status}`);

  const page = await req('/login');
  ok('/login 返回登录页', page.status === 200 && String(page.body).includes('面板密码'));

  const bad = await req('/panel/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-wrong' }),
  });
  ok('错误密码 401', bad.status === 401, bad.body?.error?.code ?? '');

  const gate = await req('/panel/api/overview');
  ok('未登录调面板 API 401', gate.status === 401);
}

const login = await req('/panel/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PWD }),
});
ok('正确密码登录成功', login.status === 200, `status=${login.status}`);
const cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0];
ok('下发会话 cookie', cookie.startsWith('mockhub_session='));
const H = { cookie, 'content-type': 'application/json' };

{
  const dash = await req('/', { headers: H });
  ok('登录后可访问看板', dash.status === 200 && String(dash.body).includes('码道'));
  const sess = await req('/panel/api/session', { headers: H });
  ok('/panel/api/session 可用', sess.status === 200 && sess.body?.ok === true);
  const ov = await req('/panel/api/overview?range=today', { headers: H });
  ok('overview 返回 KPI', ov.status === 200 && !!ov.body?.usage?.kpi, `mode=${ov.body?.mode}`);
}

console.log('\n\x1b[1m[2] 账号池\x1b[0m');
let accId;
{
  const create = await req('/panel/api/accounts', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: 'test-account',
      accessKeyId: 'HSTAPANELTEST00001',
      secretAccessKey: 'secretpanel',
      securityToken: 'tokenpanel',
      region: 'cn',
    }),
  });
  ok('创建账号 200', create.status === 200);
  accId = create.body?.account?.id;
  ok('返回账号 id', !!accId, accId ?? '');

  const list = await req('/panel/api/accounts', { headers: H });
  const acc = (list.body?.accounts ?? []).find((a) => a.id === accId);
  ok('列表里有该账号', !!acc);
  ok('AccessKey 已脱敏', /^\w{4}\*{4}/.test(acc?.accessKeyIdMasked ?? ''), acc?.accessKeyIdMasked ?? '');
  ok('不下发明文 secret', acc?.secretAccessKey === undefined && acc?.hasSecret === true);
  ok('不下发明文 token', acc?.securityToken === undefined && acc?.hasToken === true);

  const patch = await req('/panel/api/accounts/' + accId, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ enabled: false }),
  });
  ok('停用账号', patch.status === 200 && patch.body?.account?.enabled === false);
  await req('/panel/api/accounts/' + accId, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ enabled: true }),
  });
}

console.log('\n\x1b[1m[3] API Key 与鉴权开关\x1b[0m');
let keyId;
let keyValue;
{
  const create = await req('/panel/api/keys', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: 'test-key', models: ['*'] }),
  });
  ok('创建 Key 200', create.status === 200);
  keyId = create.body?.key?.id;
  keyValue = create.body?.key?.key;
  ok('Key 形如 mh-…', String(keyValue).startsWith('mh-'), String(keyValue).slice(0, 10) + '…');

  const chat = (key, model = 'mock-thinking') =>
    req('/api/v2/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '面板测试' }] }),
    });

  // 默认不强制鉴权
  const noEnforce = await chat(null);
  ok('默认（未强制）无 Key 可调用', noEnforce.status === 200, `status=${noEnforce.status}`);

  // 打开强制鉴权
  await req('/panel/api/settings', {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ enforceKeys: true }),
  });

  const noKey = await chat(null);
  ok('强制后无 Key 401', noKey.status === 401, noKey.body?.error?.code ?? '');
  const badKey = await chat('mh-not-a-real-key');
  ok('强制后错 Key 401', badKey.status === 401, badKey.body?.error?.code ?? '');
  const goodKey = await chat(keyValue);
  ok('强制后对 Key 200', goodKey.status === 200, `status=${goodKey.status}`);
  ok('返回 usage', typeof goodKey.body?.usage?.total_tokens === 'number', String(goodKey.body?.usage?.total_tokens));

  // 模型白名单
  await req('/panel/api/keys/' + keyId, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ models: ['only-this-model'] }),
  });
  const denied = await chat(keyValue, 'mock-thinking');
  ok('模型不在白名单 401', denied.status === 401, denied.body?.error?.code ?? '');
  ok('错误码是 model_not_allowed', denied.body?.error?.code === 'model_not_allowed');

  await req('/panel/api/keys/' + keyId, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ models: ['mock-*'] }),
  });
  const wildcard = await chat(keyValue, 'mock-thinking');
  ok('通配符白名单放行', wildcard.status === 200, `status=${wildcard.status}`);

  // 关掉强制鉴权，恢复默认
  await req('/panel/api/settings', {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ enforceKeys: false }),
  });
  const restored = await chat(null);
  ok('关闭强制后恢复放行', restored.status === 200);
}

console.log('\n\x1b[1m[4] 用量归因\x1b[0m');
{
  const u = await req('/panel/api/usage?range=today', { headers: H });
  ok('usage 200', u.status === 200);
  ok('有请求计数', (u.body?.kpi?.requests ?? 0) > 0, String(u.body?.kpi?.requests));
  ok('有 token 计数', (u.body?.kpi?.totalTokens ?? 0) > 0, String(u.body?.kpi?.totalTokens));
  ok('模型分布非空', (u.body?.models ?? []).length > 0, (u.body?.models ?? []).map((m) => m.name).join(','));
  ok('Key 归因非空', (u.body?.keys ?? []).length > 0, (u.body?.keys ?? []).map((m) => m.name).join(','));

  for (const r of ['week', 'month', 'all']) {
    const x = await req('/panel/api/usage?range=' + r, { headers: H });
    ok(`range=${r} 可用`, x.status === 200 && typeof x.body?.kpi?.requests === 'number');
  }
}

console.log('\n\x1b[1m[5] 设置与清理\x1b[0m');
{
  const s = await req('/panel/api/settings', { headers: H });
  ok('settings 200', s.status === 200);
  ok('含 region 字段', !!s.body?.settings?.region, s.body?.settings?.region ?? '');
  ok('含 enforceKeys 字段', typeof s.body?.settings?.enforceKeys === 'boolean');

  const logs = await req('/panel/api/logs?limit=20', { headers: H });
  ok('logs 200', logs.status === 200);

  const delKey = await req('/panel/api/keys/' + keyId, { method: 'DELETE', headers: H });
  ok('删除 Key', delKey.status === 200);
  const afterDel = await req('/panel/api/keys', { headers: H });
  const stillThere = (afterDel.body?.keys ?? []).find((k) => k.id === keyId);
  ok('删除后标记 deletedAt（保留用量归因）', !!stillThere?.deletedAt);

  const delAcc = await req('/panel/api/accounts/' + accId, { method: 'DELETE', headers: H });
  ok('删除账号', delAcc.status === 200);

  const logout = await req('/panel/api/logout', { method: 'POST', headers: H });
  ok('登出 200', logout.status === 200);
  const after = await req('/', { headers: H });
  ok('登出后需重新登录', after.status === 302);
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
