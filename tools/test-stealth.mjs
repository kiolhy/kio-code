// 出站指纹 + 节流 + 传输层单测。不依赖任何外部服务：
// 自己起假上游和假 CONNECT 代理，验证「发出去的东西长什么样」。
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

import {
  resolveProfile,
  maasTypeFor,
  isConcurrencyLimit,
  buildSignableHeaders,
  buildTransportHeaders,
  sessionFor,
  resetSessions,
  findIdentityLeaks,
  HEADER_ORDER,
} from '../lib/stealth.mjs';
import { createGovernor, parseRetryAfter } from '../lib/pacing.mjs';
import { createTransport, buildTlsOptions } from '../lib/transport.mjs';
import { buildUpstreamHeaders, detectUpstreamBizError, modelDisplayName } from '../lib/gateway.mjs';
import { verifyRequest } from '../lib/sign.mjs';

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

const AK = 'AKSTEALTHTEST0001';
const SK = 'SKSTEALTHTEST0000000000000000000000001';
const BASE_CFG = {
  identity: { department: '某事业部' },
  gateway: { chatPath: '/api/v2/chat/completions' },
  stealth: { assertNoLeaks: true, sessionTtlMs: 60000 },
};

console.log('\n\x1b[1m[1] 默认画像\x1b[0m');
{
  const p = resolveProfile({});
  ok('UA 是 Bun 运行时', p.userAgent === 'Bun/1.3.14', p.userAgent);
  // 实测 ~/.codeartsdoer 日志里 CLI 自报的就是 "CLI"，不是 codearts-cli
  ok('插件名 CLI（实测值）', p.pluginName === 'CLI', p.pluginName);
  ok('IDE 名 CLI（实测值）', p.ideName === 'CLI', p.ideName);
  ok('客户端类型 CLI（实测值）', p.clientType === 'CLI', p.clientType);
  ok('otClientType CLI', p.otClientType === 'CLI', p.otClientType);
  ok('client-ip 198.18.0.1（实测值）', p.clientIp === '198.18.0.1', p.clientIp);
  ok('maas_type 默认不发', p.maasType === '', JSON.stringify(p.maasType));
  ok('otClientVersion 跟随 pluginVersion', p.otClientVersion === p.pluginVersion, p.otClientVersion);
  ok('画像本身不带网关特征', findIdentityLeaks(buildTransportHeaders(p)).length === 0);
  ok('能识别出网关 UA 泄漏', findIdentityLeaks({ 'user-agent': 'kio-code-gateway/1.0' }).length > 0);
  ok('能识别出 x-kio 头', findIdentityLeaks({ 'x-kio-upstream': 'x' }).length > 0);
}

console.log('\n\x1b[1m[2] 可签名头（对齐 CLI 的 getInferhubHcHeaders）\x1b[0m');
const account = { id: 'acc_test1', ref: 'acc_test1', userName: 'tester', securityToken: 'TOK-1', region: 'cn' };
{
  resetSessions();
  const s = sessionFor(account, 60000);
  const h = buildSignableHeaders({ cfg: BASE_CFG, account, model: 'deepseek-v3.2', session: s, token: 'TOK-1' });

  ok('有 x-ot-trace-id（32 hex）', /^[0-9a-f]{32}$/.test(h['x-ot-trace-id'] ?? ''), h['x-ot-trace-id']);
  ok('有 x-ot-span-id（16 hex）', /^[0-9a-f]{16}$/.test(h['x-ot-span-id'] ?? ''), h['x-ot-span-id']);
  ok('有 x-snap-traceid（<32hex>_<16hex>）', /^[0-9a-f]{32}_[0-9a-f]{16}$/.test(h['x-snap-traceid'] ?? ''), h['x-snap-traceid']);
  ok('user-msg-id 是 msg_ 前缀', /^msg_[0-9a-f]{13}[0-9A-Za-z]{17}$/.test(h['user-msg-id'] ?? ''), h['user-msg-id']);
  ok('model-id / model-name 一致', h['model-id'] === 'deepseek-v3.2' && h['model-name'] === 'deepseek-v3.2');
  ok('x-ot-function = agent-tui', h['x-ot-function'] === 'agent-tui');
  ok('x-ot-client-type = CLI', h['x-ot-client-type'] === 'CLI');
  ok('app-id = CodeAgent3.0', h['app-id'] === 'CodeAgent3.0');
  // 实测 CLI 的 maas_type 是空（日志 `maas_type: ,`），即不发这个头
  ok('maas_type 不发（实测 CLI 为空）', !('maas_type' in h));
  ok('is_confidential = false', h.is_confidential === 'false');
  ok('部门被 encode', h.depart === encodeURIComponent('某事业部'), h.depart);
  ok('x-security-token 带上', h['x-security-token'] === 'TOK-1');
  ok('x-ot-parent-session-id 保留空值（CLI 也签空）', h['x-ot-parent-session-id'] === '');
  ok('client-ip 不是 127.0.0.1', !String(h['client-ip'] ?? '').startsWith('127.'), h['client-ip'] ?? '(未发)');
  ok('没有网关特征', findIdentityLeaks(h).length === 0, findIdentityLeaks(h).join(';'));

  const keys = Object.keys(h);
  const orderOk = keys.every((k, i) => i === 0 || HEADER_ORDER.indexOf(k) > HEADER_ORDER.indexOf(keys[i - 1]));
  ok('头顺序按 CLI 构造顺序', orderOk, keys.slice(0, 5).join(','));

  const s2 = sessionFor(account, 60000);
  const h2 = buildSignableHeaders({ cfg: BASE_CFG, account, model: 'deepseek-v3.2', session: s2, token: 'TOK-1' });
  ok('同一会话 session-id 稳定', h['x-ot-session-id'] === h2['x-ot-session-id']);
  ok('同一会话 trace-id 每请求变化', h['x-ot-trace-id'] !== h2['x-ot-trace-id']);
}

console.log('\n\x1b[1m[3] 签名覆盖整套 CLI 头\x1b[0m');
{
  const url = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions';
  const bodyText = JSON.stringify({ model: 'deepseek-v3.2', messages: [{ role: 'user', content: '你好' }] });
  const { headers } = buildUpstreamHeaders({
    cfg: BASE_CFG,
    account,
    model: 'deepseek-v3.2',
    bodyText,
    creds: { ak: AK, sk: SK, token: 'TOK-1', url },
  });

  ok('Authorization 是 SDK-HMAC-SHA256', String(headers.Authorization ?? headers.authorization).startsWith('SDK-HMAC-SHA256'));
  const auth = String(headers.Authorization ?? headers.authorization);
  ok('SignedHeaders 含会话头', /x-ot-session-id/.test(auth) && /x-ot-trace-id/.test(auth));
  ok('SignedHeaders 含插件版本头', /plugin-version/.test(auth) && /kernel-version/.test(auth));
  ok('SignedHeaders 不含传输层头', !/accept-encoding/.test(auth) && !/user-agent/.test(auth));
  ok('传输层头单独补上', headers.accept === '*/*' && headers['user-agent'] === 'Bun/1.3.14');
  ok('UA 不含 kio/gateway', !/kio|gateway/i.test(headers['user-agent'] ?? ''));

  const verdict = verifyRequest({
    method: 'POST',
    url,
    headers: { ...headers, host: 'snap-access.cn-north-4.myhuaweicloud.com' },
    body: bodyText,
    skOf: (ak) => (ak === AK ? SK : null),
  });
  ok('上游侧能复算出同一个签名', verdict.ok, verdict.reason ?? '');
}

console.log('\n\x1b[1m[4] 节流：并发 / 间隔 / 冷却\x1b[0m');
{
  const gov = createGovernor({
    cfg: {
      stealth: {
        pacing: { maxConcurrentPerAccount: 1, maxGlobalConcurrent: 4, minIntervalMs: 0, jitterMs: 1, queueTimeoutMs: 2000 },
        cooldown: { on429Ms: 5000, on5xxMs: 1000, onAuthErrorMs: 5000 },
      },
    },
  });
  const acc = { id: 'acc_gov' };
  const release1 = await gov.acquire(acc);
  let secondDone = false;
  const second = gov.acquire(acc).then((r) => {
    secondDone = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 80));
  ok('单账号并发 1：第二个请求排队', secondDone === false);
  ok('快照 inflight = 1', gov.snapshot().accounts[0]?.inflight === 1, JSON.stringify(gov.snapshot()));
  release1();
  const release2 = await second;
  ok('释放后第二个拿到名额', secondDone === true);
  release2();
  ok('释放后 inflight 归零', gov.snapshot().accounts[0]?.inflight === 0);

  gov.penalize(acc, 429, 0);
  ok('429 之后进入冷却', gov.isCoolingDown(acc) === true);
  let cooled = null;
  try {
    await gov.acquire(acc, { timeoutMs: 60 });
  } catch (e) {
    cooled = e.code;
  }
  ok('冷却期内直接拒绝而不是硬打', cooled === 'account_cooldown', String(cooled));

  const gov2 = createGovernor({
    cfg: { stealth: { pacing: { maxConcurrentPerAccount: 1, minIntervalMs: 120, jitterMs: 0, queueTimeoutMs: 2000 } } },
  });
  const t0 = Date.now();
  const r1 = await gov2.acquire(acc);
  r1();
  const r2 = await gov2.acquire(acc);
  r2();
  const gap = Date.now() - t0;
  ok('最小间隔生效', gap >= 100, `${gap}ms`);

  ok('Retry-After 秒数解析', parseRetryAfter('3') === 3000);
  ok('Retry-After 日期解析', parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 3000);
}

console.log('\n\x1b[1m[4b] 名额探测：hasFreeSlot / freeInMs\x1b[0m');
{
  // 轮换时靠这两个方法判断「要不要傻等」，踩过的坑：
  // 一个账号忙、另一个账号闲着，代码却死等第一个然后 503。
  const gov = createGovernor({
    cfg: { stealth: { pacing: { maxConcurrentPerAccount: 1, maxGlobalConcurrent: 4, minIntervalMs: 0, jitterMs: 1, queueTimeoutMs: 2000 } } },
  });
  const a = { id: 'acc_a' };
  const b = { id: 'acc_b' };

  ok('空闲账号有免费名额', gov.hasFreeSlot(a) === true);
  const rel = await gov.acquire(a);
  ok('占住后该账号没有免费名额', gov.hasFreeSlot(a) === false);
  ok('另一个账号仍然空闲', gov.hasFreeSlot(b) === true);
  ok('占住后 freeInMs 非 0', gov.freeInMs(a) > 0, String(gov.freeInMs(a)));
  ok('空闲账号 freeInMs = 0', gov.freeInMs(b) === 0);

  rel();
  ok('释放后恢复可探测到空闲', gov.hasFreeSlot(a) === true);

  gov.penalize(b, 429, 0);
  ok('冷却中的账号不算空闲', gov.hasFreeSlot(b) === false);
  ok('冷却中 freeInMs 反映冷却剩余', gov.freeInMs(b) > 1000, String(gov.freeInMs(b)));

  // 繁忙错误要带上 retryAfterMs，客户端才有退避依据
  const gov3 = createGovernor({
    cfg: { stealth: { pacing: { maxConcurrentPerAccount: 1, minIntervalMs: 0, jitterMs: 1, queueTimeoutMs: 0 } } },
  });
  const hold = await gov3.acquire(a);
  let busy = null;
  try {
    await gov3.acquire(a, { timeoutMs: 30 });
  } catch (e) {
    busy = e;
  }
  ok('排队超时报 gateway_busy', busy?.code === 'gateway_busy', String(busy?.code));
  ok('繁忙错误带 retryAfterMs', Number(busy?.retryAfterMs) > 0, String(busy?.retryAfterMs));
  ok('繁忙错误带账号标识', busy?.account === 'acc_a', String(busy?.account));
  hold();

  // 全局并发上限
  const gov4 = createGovernor({
    cfg: { stealth: { pacing: { maxConcurrentPerAccount: 5, maxGlobalConcurrent: 1, minIntervalMs: 0, jitterMs: 1, queueTimeoutMs: 0 } } },
  });
  const g1 = await gov4.acquire(a);
  let globalBusy = null;
  try {
    await gov4.acquire(b, { timeoutMs: 30 });
  } catch (e) {
    globalBusy = e.code;
  }
  ok('全局并发满了也拒绝', globalBusy === 'gateway_busy', String(globalBusy));
  ok('全局满时 hasFreeSlot 为假', gov4.hasFreeSlot(b) === false);
  g1();
}

console.log('\n\x1b[1m[5] 传输层：头顺序 / gzip / CONNECT 代理\x1b[0m');
{
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: raw });
      const payload = JSON.stringify({ ok: true, echo: raw.length });
      if (req.headers['x-want-gzip'] === '1') {
        const buf = zlib.gzipSync(Buffer.from(payload));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(buf);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
      }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  // 假 CONNECT 代理
  let proxyConnects = 0;
  const proxy = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on('connect', (req, clientSocket, head) => {
    proxyConnects++;
    const [host, port] = String(req.url).split(':');
    const target = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) target.write(head);
      target.pipe(clientSocket);
      clientSocket.pipe(target);
    });
    target.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => target.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = proxy.address().port;

  try {
    resetSessions();
    const cfg = { ...BASE_CFG, stealth: { ...BASE_CFG.stealth } };
    const transport = createTransport(cfg);
    const url = `http://127.0.0.1:${upPort}/api/v2/chat/completions`;
    const bodyText = JSON.stringify({ model: 'deepseek-v3.2', messages: [{ role: 'user', content: 'hi' }] });
    const { headers } = buildUpstreamHeaders({
      cfg,
      account,
      model: 'deepseek-v3.2',
      bodyText,
      creds: { ak: AK, sk: SK, token: 'TOK-1', url },
    });
    headers['x-want-gzip'] = '1';

    const resp = await transport.request({ url, headers, body: bodyText, timeoutMs: 5000 });
    const json = JSON.parse((await resp.buffer()).toString('utf8'));
    ok('直连拿到 200', resp.status === 200, String(resp.status));
    ok('gzip 自动解压', json.ok === true);

    const raw = seen[0];
    ok('上游收到完整的可签名头', String(raw.headers.authorization ?? '').startsWith('SDK-HMAC-SHA256'));
    ok('上游收到的 UA 不是网关', !/kio|gateway|mock-hub/i.test(String(raw.headers['user-agent'] ?? '')), String(raw.headers['user-agent']));
    const idx = (name) => raw.rawHeaders.findIndex((v, i) => i % 2 === 0 && v.toLowerCase() === name);
    ok(
      '头顺序：content-type → x-ot-trace-id → accept → user-agent',
      idx('content-type') >= 0 &&
        idx('content-type') < idx('x-ot-trace-id') &&
        idx('x-ot-trace-id') < idx('accept') &&
        idx('accept') < idx('user-agent')
    );
    ok('带 content-length', raw.headers['content-length'] === String(Buffer.byteLength(bodyText)), String(raw.headers['content-length']));

    // 走代理
    seen.length = 0;
    const proxyCfg = { ...BASE_CFG, stealth: { ...BASE_CFG.stealth, egress: { proxy: `http://127.0.0.1:${proxyPort}` } } };
    const viaProxy = createTransport(proxyCfg);
    const resp2 = await viaProxy.request({ url, headers, body: bodyText, timeoutMs: 5000 });
    await resp2.buffer();
    ok('经 CONNECT 代理仍然 200', resp2.status === 200, String(resp2.status));
    ok('代理确实被使用', proxyConnects >= 1, String(proxyConnects));
    ok('代理链路上游同样收到签名头', String(seen[0]?.headers?.authorization ?? '').startsWith('SDK-HMAC-SHA256'));

    const tlsOpts = buildTlsOptions(cfg);
    ok('TLS 只谈 http/1.1', JSON.stringify(tlsOpts.ALPNProtocols) === '["http/1.1"]', JSON.stringify(tlsOpts.ALPNProtocols));
    ok('TLS 校验证书', tlsOpts.rejectUnauthorized === true);
    ok('TLS 有 cipher 顺序', String(tlsOpts.ciphers).includes('ECDHE-RSA-AES128-GCM-SHA256'));
    ok('TLS 曲线顺序', tlsOpts.ecdhCurve === 'X25519:P-256:P-384');

    transport.close();
    viaProxy.close();
  } finally {
    upstream.close();
    proxy.close();
  }
}

console.log('\n\x1b[1m[10] maas_type 按套餐状态选择\x1b[0m');
{
  // 实测 2026-10-29：不发 → 200；benefit → 200（无套餐时 4004）；
  // default → 503；pay → 400。所以只有真有套餐才发 benefit。
  ok('无套餐 → 空串（不发）', maasTypeFor({ info: { benefit: { enabled: false } } }) === '');
  ok('有套餐 → benefit', maasTypeFor({ info: { benefit: { enabled: true } } }) === 'benefit');
  ok('info 是字符串也能解析', maasTypeFor({ info: JSON.stringify({ benefit: { enabled: false } }) }) === '');
  ok('没探测过 → benefit（保持原默认）', maasTypeFor({}) === 'benefit');
  ok('info 坏 JSON → benefit', maasTypeFor({ info: '{bad' }) === 'benefit');
  ok('benefit 字段缺失 → benefit', maasTypeFor({ info: {} }) === 'benefit');

  // resolveProfile 必须让空串生效（不能用 if (opts.maasType) 判断）
  const p1 = resolveProfile({ stealth: { profile: {} } }, { maasType: '' });
  ok('空串覆盖默认值', p1.maasType === '', JSON.stringify(p1.maasType));
  const p2 = resolveProfile({ stealth: { profile: {} } }, { maasType: 'benefit' });
  ok('benefit 正常覆盖', p2.maasType === 'benefit');
  const p3 = resolveProfile({ stealth: { profile: {} } });
  ok('不传时保留默认（空 = 不发）', p3.maasType === '', JSON.stringify(p3.maasType));

  // 空 maas_type 不进签名头
  const h = buildSignableHeaders({
    cfg: {},
    account: { id: 'a', userName: 'u' },
    model: 'GLM-5.2',
    session: {},
    token: 't',
    profile: p1,
  });
  ok('空 maas_type 不出现在头里', !('maas_type' in h), JSON.stringify(Object.keys(h).filter((k) => k.includes('maas'))));

  // 上游并发会话上限
  ok('识别 TM.00001041', isConcurrencyLimit('{"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)"}'));
  ok('识别中文文案', isConcurrencyLimit('并发会话数已达上限(3个)，请关闭部分会话后重试。'));
  ok('普通 429 不算并发上限', !isConcurrencyLimit('rate limit exceeded'));
}

console.log('\n\x1b[1m[11] 上游业务错误识别（HTTP 200 但失败）\x1b[0m');
{
  const mk = (obj) => Buffer.from(JSON.stringify(obj));

  const e1 = detectUpstreamBizError(200, mk({ error_code: '4004', error_msg: 'benefit not found', result: null }));
  ok('4004 被识别', e1?.code === '4004', e1?.code);
  ok('4004 翻成 402', e1?.status === 402, String(e1?.status));

  const e2 = detectUpstreamBizError(200, mk({ error_code: '4000', error_msg: 'invalid channel, group not found' }));
  ok('4000 翻成 400', e2?.status === 400, String(e2?.status));

  const e3 = detectUpstreamBizError(200, mk({ error_code: '4003', error_msg: 'user disabled' }));
  ok('4003 翻成 403', e3?.status === 403);

  const e4 = detectUpstreamBizError(200, mk({ error_code: '4006', error_msg: 'daily limit' }));
  ok('4006 翻成 429', e4?.status === 429);

  const e5 = detectUpstreamBizError(200, mk({ error_code: '9999', error_msg: 'unknown' }));
  ok('未知码翻成 502', e5?.status === 502);

  // 正常响应不该被误判
  ok('有 choices 不算错', detectUpstreamBizError(200, mk({ choices: [{ message: { content: 'hi' } }] })) === null);
  ok('error_code=0 不算错', detectUpstreamBizError(200, mk({ error_code: '0' })) === null);
  ok('error_code=0000 不算错', detectUpstreamBizError(200, mk({ error_code: '0000' })) === null);
  ok('无 error_code 不算错', detectUpstreamBizError(200, mk({ id: 'x', object: 'chat.completion' })) === null);
  ok('非 JSON 不算错', detectUpstreamBizError(200, Buffer.from('data: hello')) === null);
  ok('非 200 不处理', detectUpstreamBizError(500, mk({ error_code: '4004' })) === null);
  ok('空 body 不算错', detectUpstreamBizError(200, Buffer.alloc(0)) === null);
}

console.log('\n\x1b[1m[12] 请求级 id 格式对齐真 CLI\x1b[0m');
{
  // 实测样本（~/.codeartsdoer/cli-data/log 的 [header-debug]）：
  //   x-ot-trace-id    a3c53e942754427f910ea068dc54200e      32 hex
  //   x-ot-span-id     1046d5d879da6608                      16 hex
  //   x-snap-traceid   58dc923a137146d3a4b33bff795b0bd0_a77ffb793148466a
  //   x-ot-session-id  ses_e7e55d3daffekburR2EHBb6EGE
  //   user-msg-id      msg_181aa30020014NTr39NQypfP4u
  //   created-time     2026-10-28T08:39:41Z
  const prof = resolveProfile({});
  const mk = () => buildSignableHeaders({
    cfg: {}, account: { id: 'a', userName: 'u' }, model: 'GLM-5.2', session: {}, token: 't', profile: prof,
  });

  const h = mk();
  ok('x-ot-trace-id 是 32 hex', /^[0-9a-f]{32}$/.test(h['x-ot-trace-id']), h['x-ot-trace-id']);
  ok('x-ot-span-id 是 16 hex', /^[0-9a-f]{16}$/.test(h['x-ot-span-id']), h['x-ot-span-id']);
  ok('x-snap-traceid 是 <32hex>_<16hex>', /^[0-9a-f]{32}_[0-9a-f]{16}$/.test(h['x-snap-traceid']), h['x-snap-traceid']);
  ok('user-msg-id 是 msg_ 前缀', /^msg_[0-9a-f]{13}[0-9A-Za-z]{17}$/.test(h['user-msg-id']), h['user-msg-id']);
  ok('created-time 是 ISO 秒精度', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(h['created-time']), h['created-time']);
  ok('created-time 不是毫秒戳', !/^\d{13}$/.test(h['created-time']), h['created-time']);
  ok('user-msg-id 不是 UUID', !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(h['user-msg-id']), h['user-msg-id']);

  // 每请求都要换，不能复用
  const h2 = mk();
  ok('trace-id 每请求不同', h['x-ot-trace-id'] !== h2['x-ot-trace-id']);
  ok('span-id 每请求不同', h['x-ot-span-id'] !== h2['x-ot-span-id']);
  ok('user-msg-id 每请求不同', h['user-msg-id'] !== h2['user-msg-id']);

  // 会话 id 格式
  resetSessions();
  const s1 = sessionFor({ id: 'x1' }, 60000);
  ok('session id 是 ses_ 前缀', s1.id.startsWith('ses_'), s1.id);
  ok('session id 格式 ses_<13hex>e<17b62>', /^ses_[0-9a-f]{13}e[0-9A-Za-z]{17}$/.test(s1.id), s1.id);
  ok('session id 不是 UUID', !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s1.id), s1.id);
  const s1b = sessionFor({ id: 'x1' }, 60000);
  ok('同账号会话稳定', s1b.id === s1.id);
  const s2 = sessionFor({ id: 'x2' }, 60000);
  ok('不同账号会话不同', s2.id !== s1.id);
  resetSessions();

  // model-id / model-name 分离
  const hm = buildSignableHeaders({
    cfg: {}, account: { id: 'a' }, model: 'openpangu-2.0-pro', modelName: 'OpenPangu-2.0-Pro',
    session: {}, token: 't', profile: prof,
  });
  ok('model-id 用 model_id', hm['model-id'] === 'openpangu-2.0-pro', hm['model-id']);
  ok('model-name 用显示名', hm['model-name'] === 'OpenPangu-2.0-Pro', hm['model-name']);
  const hm2 = buildSignableHeaders({
    cfg: {}, account: { id: 'a' }, model: 'GLM-5.2', session: {}, token: 't', profile: prof,
  });
  ok('不给 modelName 时回落成 model', hm2['model-name'] === 'GLM-5.2', hm2['model-name']);

  // 实测的指纹四件套
  ok('plugin-name=CLI', h['plugin-name'] === 'CLI', h['plugin-name']);
  ok('ide-name=CLI', h['ide-name'] === 'CLI', h['ide-name']);
  ok('x-ot-client-type=CLI', h['x-ot-client-type'] === 'CLI', h['x-ot-client-type']);
  ok('client-ip=198.18.0.1', h['client-ip'] === '198.18.0.1', h['client-ip']);
  ok('x-ot-function=agent-tui', h['x-ot-function'] === 'agent-tui', h['x-ot-function']);
  ok('x-language=zh-cn', h['x-language'] === 'zh-cn');
  ok('没有 maas_type（实测 CLI 不发）', !('maas_type' in h), JSON.stringify(Object.keys(h).filter((k) => k.includes('maas'))));
}

console.log('\n\x1b[1m[13] 模型显示名解析\x1b[0m');
{
  const acc = {
    info: {
      models: [
        { id: 'GLM-5.2', name: 'GLM-5.2', alias: 'GLM-5.2' },
        { id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro', alias: 'openpangu-2.0-pro' },
        { id: 'glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK', alias: 'glm-5.2-sft-harmony' },
      ],
    },
  };
  ok('按 id 查到显示名', modelDisplayName(acc, 'openpangu-2.0-pro') === 'OpenPangu-2.0-Pro');
  ok('按 alias 查到显示名', modelDisplayName(acc, 'glm-5.2-sft-harmony') === 'GLM-5.2-ArkTS-SPARK');
  ok('id 与 name 相同时照常返回', modelDisplayName(acc, 'GLM-5.2') === 'GLM-5.2');
  ok('查不到返回 undefined', modelDisplayName(acc, 'nope') === undefined);
  ok('info 是字符串也能查', modelDisplayName({ info: JSON.stringify(acc.info) }, 'openpangu-2.0-pro') === 'OpenPangu-2.0-Pro');
  ok('info 坏 JSON 返回 undefined', modelDisplayName({ info: '{bad' }, 'x') === undefined);
  ok('没有 info 返回 undefined', modelDisplayName({}, 'x') === undefined);
  ok('空 model 返回 undefined', modelDisplayName(acc, '') === undefined);
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
