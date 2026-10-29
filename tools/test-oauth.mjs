// 账号池 OAuth 授权添加：授权码 → STS 临时 AK/SK → 自动入库（全程假 OAuth/STS 服务器，不碰真实网络）
import http from 'node:http';
import { createOAuth, OAuthError } from '../lib/oauth.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/ok/token') {
      send(200, { access_token: 'test-at', id_token: 'test-id', token_type: 'Bearer' });
    } else if (req.url === '/ok/sts') {
      send(200, { credential: { access: 'TESTAK', secret: 'TESTSK', securitytoken: 'TESTSTS', expires_at: '2030-01-01T00:00:00.000Z' } });
    } else if (req.url === '/fail/sts') {
      send(200, { credential: {} });
    } else if (req.url === '/err/token') {
      send(400, { error: 'invalid_grant', error_description: 'code 已被使用' });
    } else {
      send(404, { error: 'not_found' });
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const makeCfg = (over = {}) => ({
  oauth: {
    enabled: true,
    mode: 'sts',
    authorizeUrl: 'https://id.example/oauth2/authorize',
    tokenUrl: `${base}/ok/token`,
    clientId: 'test-client',
    clientSecret: 'test-secret',
    redirectUri: 'http://127.0.0.1:8787/oauth/callback',
    scope: 'openid',
    region: 'cn',
    accountNamePrefix: '测试账号',
    sts: {
      endpoint: `${base}/ok/sts`,
      domainId: 'domain-1',
      agencyName: 'codearts-agency',
      durationSeconds: 3600,
      tokenField: 'access_token',
      akPath: 'credential.access',
      skPath: 'credential.secret',
      tokenPath: 'credential.securitytoken',
      expiresAtPath: 'credential.expires_at',
    },
    ...over,
  },
});

const makePanel = () => {
  const added = [];
  return {
    added,
    addAccount(a) { const id = 'acc-' + (added.length + 1); const acc = { id, ...a }; added.push(acc); return acc; },
  };
};

console.log('\n\x1b[1m[1] 发起授权链接\x1b[0m');
{
  const panel = makePanel();
  const oauth = createOAuth({ cfg: makeCfg(), panel });
  const s = await oauth.start({});
  ok('返回 authorizeUrl', typeof s.authorizeUrl === 'string' && s.authorizeUrl.startsWith('https://id.example/'));
  const u = new URL(s.authorizeUrl);
  ok('带 client_id', u.searchParams.get('client_id') === 'test-client');
  ok('带 redirect_uri', u.searchParams.get('redirect_uri') === 'http://127.0.0.1:8787/oauth/callback');
  ok('response_type=code', u.searchParams.get('response_type') === 'code');
  ok('带 state', !!s.state);
  ok('state 有效期返回', typeof s.expiresIn === 'number' && s.expiresIn > 0);
}

console.log('\n\x1b[1m[2] 授权码 → STS → 入库\x1b[0m');
{
  const panel = makePanel();
  const oauth = createOAuth({ cfg: makeCfg(), panel });
  const s = await oauth.start({});
  const r = await oauth.exchange({ code: 'test-code', state: s.state });
  ok('exchange 成功', r.done === true && r.accountId);
  ok('STS AK 正确', panel.added[0].accessKeyId === 'TESTAK', panel.added[0].accessKeyId);
  ok('STS SK 正确', panel.added[0].secretAccessKey === 'TESTSK');
  ok('STS token 正确', panel.added[0].securityToken === 'TESTSTS');
  ok('authType=sts', panel.added[0].authType === 'sts');
  ok('expiresAt 落库', !!panel.added[0].expiresAt, panel.added[0].expiresAt);
  ok('区域透传', panel.added[0].region === 'cn');
  ok('名称前缀', String(panel.added[0].name).startsWith('测试账号'));
  ok('AK 打码', r.accessKeyIdMasked === 'TEST****');
}

console.log('\n\x1b[1m[3] 状态轮询\x1b[0m');
{
  const panel = makePanel();
  const oauth = createOAuth({ cfg: makeCfg(), panel });
  const s = await oauth.start({});
  const before = oauth.status({ state: s.state });
  ok('未完成时 pending', before.done === false && before.pending === true);
  await oauth.exchange({ code: 'c', state: s.state });
  const after = oauth.status({ state: s.state });
  ok('完成后 done', after.done === true && !!after.accountId);
  const empty = oauth.status({ state: 'no-such-state' });
  ok('未知 state 不 pending', empty.done === false && empty.pending === false);
}

console.log('\n\x1b[1m[4] 错误路径\x1b[0m');
{
  const panel = makePanel();
  const oauth = createOAuth({ cfg: makeCfg(), panel });
  await (async () => {
    try { await oauth.exchange({ code: 'x', state: 'bad' }); ok('坏 state 抛错', false); }
    catch (e) { ok('坏 state 抛错', e instanceof OAuthError && e.code === 'bad_state', e.code); }
  })();
  await (async () => {
    try { await oauth.exchange({ code: 'x', state: null }); ok('缺 state 抛错', false); }
    catch (e) { ok('缺 state 抛错', e.code === 'missing_params'); }
  })();
  await (async () => {
    const o2 = createOAuth({ cfg: makeCfg({ enabled: false }), panel });
    try { await o2.start({}); ok('未开启抛错', false); }
    catch (e) { ok('未开启抛错', e.code === 'oauth_disabled'); }
  })();
  await (async () => {
    const o2 = createOAuth({ cfg: makeCfg({ clientId: '' }), panel });
    try { await o2.start({}); ok('缺 client_id 抛错', false); }
    catch (e) { ok('缺 client_id 抛错', e.code === 'no_client_id'); }
  })();
  await (async () => {
    const o2 = createOAuth({ cfg: makeCfg({ sts: { ...makeCfg().oauth.sts, endpoint: `${base}/fail/sts` } }), panel });
    const s = await o2.start({});
    try { await o2.exchange({ code: 'x', state: s.state }); ok('STS 解析失败抛错', false); }
    catch (e) { ok('STS 解析失败抛错', e.code === 'sts_parse_failed', e.code); }
  })();
  await (async () => {
    const o2 = createOAuth({ cfg: makeCfg({ tokenUrl: `${base}/err/token` }), panel });
    const s = await o2.start({});
    try { await o2.exchange({ code: 'bad', state: s.state }); ok('token 换失败抛错', false); }
    catch (e) { ok('token 换失败抛错', e.code === 'invalid_grant', `${e.code}/${e.status}`); }
  })();
}

console.log('\n\x1b[1m[5] token 模式（存 OAuth token，不走 STS）\x1b[0m');
{
  const panel = makePanel();
  const oauth = createOAuth({ cfg: makeCfg({ mode: 'token' }), panel });
  const s = await oauth.start({});
  await oauth.exchange({ code: 'x', state: s.state });
  ok('authType=oauth', panel.added[0].authType === 'oauth');
  ok('存 access_token', panel.added[0].securityToken === 'test-at', panel.added[0].securityToken);
}

server.close();
console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
