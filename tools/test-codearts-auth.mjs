// 码道真实登录协议：授权码+PKCE+DPoP / ticket 交换 / 刷新（假服务器校验请求形状）
import http from 'node:http';
import { createCodeartsAuth, CodeartsAuthError, CODEARTS_DEFAULTS } from '../lib/codearts-auth.mjs';
import { decodeDpopProof, verifyDpopProof, generateDpopKeyPair } from '../lib/dpop.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
};

let lastToken = null;
let lastTicketUrl = null;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/v1/oauth2/tokens') {
      const form = new URLSearchParams(body);
      lastToken = { form: Object.fromEntries(form), dpop: req.headers.dpop ?? null, hdrs: req.headers };
      if (form.get('grant_type') === 'refresh_token') {
        send(200, {
          credentials: { access_key_id: 'REFAK', secret_access_key: 'REFSK', security_token: 'REFST', expiration: '2032-01-01T00:00:00Z' },
          refresh_token: 'new-refresh',
        });
        return;
      }
      send(200, {
        credentials: { access_key_id: 'HSTA_TEST', secret_access_key: 'SK_TEST', security_token: 'ST_TEST', expiration: '2031-01-01T00:00:00Z' },
        refresh_token: 'jwt-refresh-token',
      });
    } else if (req.url.startsWith('/v1/login/ticket')) {
      lastTicketUrl = req.url;
      send(200, { credential: { access: 'TICKETAK', secret: 'TICKETSK', securitytoken: 'TICKETST', expires_at: '2033-01-01T00:00:00Z' } });
    } else {
      send(404, { error: 'not_found' });
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const makeCfg = () => ({
  port: 8787,
  oauth: {
    proxy: '',
    codearts: {
      authorizeBase: base,
      tokenUrl: `${base}/v1/oauth2/tokens`,
      ticketBase: base,
      clientId: 'CodeArts_Tui',
      enterprise: 'prod',
      locale: 'zh-cn',
    },
  },
});

const makePanel = () => {
  const added = [];
  return {
    added,
    addAccount(a) { const acc = { id: 'acc-' + (added.length + 1), ...a }; added.push(acc); return acc; },
    updateAccount(id, patch) { const acc = added.find((x) => x.id === id); if (!acc) return null; Object.assign(acc, patch); return acc; },
    accounts() { return added; },
  };
};

console.log('\n\x1b[1m[1] 真实常量\x1b[0m');
{
  ok('authorize 基址', CODEARTS_DEFAULTS.authorizeBase === 'https://codearts.huaweicloud.com/portal', CODEARTS_DEFAULTS.authorizeBase);
  ok('token 端点', CODEARTS_DEFAULTS.tokenUrl === 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens', CODEARTS_DEFAULTS.tokenUrl);
  ok('ticket 基址', CODEARTS_DEFAULTS.ticketBase === 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager', CODEARTS_DEFAULTS.ticketBase);
  ok('client_id = CodeArts_Tui', CODEARTS_DEFAULTS.clientId === 'CodeArts_Tui');
}

console.log('\n\x1b[1m[2] 生成授权链接（PKCE + ticket）\x1b[0m');
{
  const a = createCodeartsAuth({ cfg: makeCfg(), panel: makePanel() });
  const s = a.start({ callbackPort: 8787 });
  const u = new URL(s.authorizeUrl);
  ok('路径 /authorize', u.pathname === '/authorize', u.pathname);
  ok('client_id 正确', u.searchParams.get('client_id') === 'CodeArts_Tui');
  ok('code_challenge_method=SHA-256', u.searchParams.get('code_challenge_method') === 'SHA-256');
  ok('带 code_challenge', (u.searchParams.get('code_challenge') ?? '').length >= 43);
  ok('带 port', u.searchParams.get('port') === '8787');
  ok('带 ticket_id', (u.searchParams.get('ticket_id') ?? '').length === 32);
  ok('带 locale', !!u.searchParams.get('locale'));
}

console.log('\n\x1b[1m[3] 授权码换 token（真实请求形状 + DPoP）\x1b[0m');
{
  const panel = makePanel();
  const a = createCodeartsAuth({ cfg: makeCfg(), panel });
  const s = a.start({ callbackPort: 8787 });
  const r = await a.completeFromUrl({ url: `${base}/oauth/callback?code=THE_CODE&ticket_id=${s.ticketId}` });

  ok('入库成功', r.done === true && !!r.accountId);
  ok('client_id=CodeArts_Tui', lastToken.form.client_id === 'CodeArts_Tui', lastToken.form.client_id);
  ok('grant_type=authorization_code', lastToken.form.grant_type === 'authorization_code');
  ok('带 code', lastToken.form.code === 'THE_CODE');
  ok('带 code_verifier', (lastToken.form.code_verifier ?? '').length === 128);
  ok('redirect_uri 指向 127.0.0.1 回调', String(lastToken.form.redirect_uri).includes('/oauth/callback'), lastToken.form.redirect_uri);
  ok('请求带 DPoP 头', !!lastToken.dpop);
  {
    const d = decodeDpopProof(lastToken.dpop);
    ok('DPoP typ=dpop+jwt', d.header.typ === 'dpop+jwt');
    ok('DPoP alg=ES256', d.header.alg === 'ES256');
    ok('DPoP htm/htu 正确', d.claims.htm === 'POST' && d.claims.htu === `${base}/v1/oauth2/tokens`);
  }
  ok('AK 入库', panel.added[0].accessKeyId === 'HSTA_TEST', panel.added[0].accessKeyId);
  ok('SK 入库', panel.added[0].secretAccessKey === 'SK_TEST');
  ok('SecurityToken 入库', panel.added[0].securityToken === 'ST_TEST');
  ok('过期时间入库', panel.added[0].expiresAt === '2031-01-01T00:00:00Z', panel.added[0].expiresAt);
  ok('refresh 记入 note', String(panel.added[0].note).includes('jwt-refresh-token'));
  ok('dpop 记入 note', String(panel.added[0].note).includes('dpop'));
}

console.log('\n\x1b[1m[4] secret → ticket 交换\x1b[0m');
{
  const panel = makePanel();
  const a = createCodeartsAuth({ cfg: makeCfg(), panel });
  const s = a.start({ callbackPort: 8787 });
  const r = await a.completeFromUrl({ url: `${base}/oauth/callback?secret=THE_SECRET&redirect=https://x/y&ticket_id=${s.ticketId}` });
  ok('ticket 入库成功', r.done === true);
  ok('ticket 请求带 ticket_id', String(lastTicketUrl).includes(`ticket_id=${s.ticketId}`), lastTicketUrl);
  ok('ticket 请求带 secret', String(lastTicketUrl).includes('secret=THE_SECRET'));
  ok('AK 来自 ticket', panel.added[0].accessKeyId === 'TICKETAK');
  ok('过期时间来自 ticket', panel.added[0].expiresAt === '2033-01-01T00:00:00Z');
}

console.log('\n\x1b[1m[5] 刷新 token（真实 DPoP 密钥）\x1b[0m');
{
  const a = createCodeartsAuth({ cfg: makeCfg(), panel: makePanel() });
  const kp = generateDpopKeyPair();
  const r = await a.refresh({
    refreshToken: 'old-refresh',
    dpopKeyPair: { publicJwk: kp.publicJwk, privatePem: kp.privatePem },
    accountId: 'dom-1',
  });
  ok('刷新返回新凭据', r.cred.accessKeyId === 'REFAK', r.cred.accessKeyId);
  ok('刷新返回新 refresh', r.refreshToken === 'new-refresh', r.refreshToken);
  ok('刷新请求 grant_type=refresh_token', lastToken.form.grant_type === 'refresh_token');
  ok('刷新请求带 x-agent-user-account', lastToken.hdrs['x-agent-user-account'] === 'dom-1', lastToken.hdrs['x-agent-user-account']);
  ok('刷新请求带 DPoP', !!lastToken.dpop);
}

console.log('\n\x1b[1m[6] 账号就地续期（refreshAccount）\x1b[0m');
{
  const panel = makePanel();
  const a = createCodeartsAuth({ cfg: makeCfg(), panel });
  const kp = generateDpopKeyPair();
  const acc = panel.addAccount({
    name: '续期测试',
    authType: 'sts',
    accessKeyId: 'OLD_AK',
    secretAccessKey: 'OLD_SK',
    securityToken: 'OLD_ST',
    expiresAt: '2020-01-01T00:00:00Z',
    domainId: 'dom-9',
    note: JSON.stringify({ source: 'codearts-oauth', refresh: 'old-refresh', dpop: { publicJwk: kp.publicJwk, privatePem: kp.privatePem } }),
  });

  const r = await a.refreshAccount(acc);
  ok('续期返回账号', !!r.account);
  ok('AK 已更新', r.account.accessKeyId === 'REFAK', r.account.accessKeyId);
  ok('SK 已更新', r.account.secretAccessKey === 'REFSK');
  ok('token 已更新', r.account.securityToken === 'REFST');
  ok('过期时间已更新', r.account.expiresAt === '2032-01-01T00:00:00Z', r.account.expiresAt);
  ok('refresh 已轮换', String(r.account.note).includes('new-refresh'));
  ok('dpop 保留', String(r.account.note).includes('privatePem'));
  ok('没有新增账号（就地更新）', panel.added.length === 1);

  await (async () => {
    const plain = panel.addAccount({ name: '无凭据', authType: 'sts', accessKeyId: 'A', secretAccessKey: 'B' });
    try { await a.refreshAccount(plain); ok('无 refresh 材料抛错', false); }
    catch (e) { ok('无 refresh 材料抛错', e.code === 'no_refresh_material', e.code); }
  })();
}

console.log('\n\x1b[1m[7] 批量续期（refreshExpiring）\x1b[0m');
{
  const panel = makePanel();
  const a = createCodeartsAuth({ cfg: makeCfg(), panel });
  const kp = generateDpopKeyPair();
  const soon = new Date(Date.now() + 60000).toISOString();   // 1 分钟后过期 → 该续
  const far = new Date(Date.now() + 86400000).toISOString(); // 1 天后 → 不该动
  panel.addAccount({ name: '快过期', authType: 'sts', accessKeyId: 'A1', secretAccessKey: 'B1', expiresAt: soon, note: JSON.stringify({ refresh: 'r1', dpop: { publicJwk: kp.publicJwk, privatePem: kp.privatePem } }) });
  panel.addAccount({ name: '还早', authType: 'sts', accessKeyId: 'A2', secretAccessKey: 'B2', expiresAt: far, note: JSON.stringify({ refresh: 'r2', dpop: { publicJwk: kp.publicJwk, privatePem: kp.privatePem } }) });

  const r = await a.refreshExpiring({ leadMs: 900000 });
  ok('只检查到 1 个', r.checked === 1, `checked=${r.checked}`);
  ok('续期 1 个', r.refreshed === 1, `refreshed=${r.refreshed}`);
  ok('没有失败', r.failed.length === 0, JSON.stringify(r.failed));
  ok('快过期账号已换新 AK', panel.added[0].accessKeyId === 'REFAK');
  ok('远期账号没被动', panel.added[1].accessKeyId === 'A2', panel.added[1].accessKeyId);
}

console.log('\n\x1b[1m[8] 错误路径\x1b[0m');
{
  const a = createCodeartsAuth({ cfg: makeCfg(), panel: makePanel() });
  await (async () => {
    try { await a.completeFromUrl({ url: `${base}/oauth/callback` }); ok('无 code/secret 抛错', false); }
    catch (e) { ok('无 code/secret 抛错', e.code === 'no_code_no_secret', e.code); }
  })();
  await (async () => {
    try { await a.completeFromUrl({ url: 'not-a-url' }); ok('非法 URL 抛错', false); }
    catch (e) { ok('非法 URL 抛错', e.code === 'bad_callback_url'); }
  })();
  await (async () => {
    try { await a.completeFromUrl({ url: `${base}/oauth/callback?code=x` }); ok('无待授权请求抛错', false); }
    catch (e) { ok('无待授权请求抛错', e.code === 'no_pending', e.code); }
  })();
  {
    const a2 = createCodeartsAuth({ cfg: makeCfg(), panel: makePanel() });
    const s = a2.start({ callbackPort: 8787 });
    await (async () => {
      try { await a2.completeFromUrl({ url: `${base}/oauth/callback?code=x&ticket_id=deadbeef` }); ok('ticket 不匹配抛错', false); }
      catch (e) { ok('ticket 不匹配抛错', e.code === 'ticket_mismatch', e.code); }
    })();
  }
}

server.close();
console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
