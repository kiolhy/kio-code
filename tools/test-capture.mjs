// 遥测捕获验证：模拟 hosts 把官方域名指到 127.0.0.1 后，CLI 的 HTTPS 上报
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const HUB = 'http://127.0.0.1:8787';
const CAP_PORT = Number(process.env.CAP_PORT ?? 443);
const COLLECTOR = 'collector-agents-access.cn-north-4.myhuaweicloud.com';
const SNAP = 'snap-access.cn-north-4.myhuaweicloud.com';

let pass = 0;
let fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ' \x1b[90m' + d + '\x1b[0m' : ''}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n} \x1b[31m${d}\x1b[0m`); };

/** 发一个 TLS 请求，Host 头写成被 hosts 劫持的官方域名 */
function tlsRequest({ host, port = CAP_PORT, path: p, method = 'POST', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method,
        servername: host,
        rejectUnauthorized: false, // CLI 侧 NODE_TLS_REJECT_UNAUTHORIZED=0 等价物
        headers: {
          host,
          'content-type': 'application/json',
          ...(payload ? { 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const state = async () => (await fetch(HUB + '/admin/api/state')).json();

console.log('\x1b[1m[1] TLS 连通性\x1b[0m');
{
  try {
    const r = await tlsRequest({
      host: COLLECTOR,
      path: '/collector/v1/logs',
      body: { resourceLogs: [] },
    });
    if (r.status === 200) ok('自签证书握手成功，OTLP logs 被接住', `HTTP ${r.status}`);
    else bad('自签证书握手成功', `HTTP ${r.status}`);
  } catch (e) {
    bad('自签证书握手成功', e.message);
  }
}

console.log('\n\x1b[1m[2] 捕获内容落到流水\x1b[0m');
{
  // 造一条带真实结构的 OTLP logs
  const logsPayload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'CodeAgent3.0' } },
            { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: 'codearts-cli' },
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1e6),
                severityText: 'INFO',
                body: { stringValue: '模拟 CLI 上报的一条日志' },
                attributes: [
                  { key: 'ai.model.id', value: { stringValue: 'mock-flagship' } },
                  { key: 'session.id', value: { stringValue: 'sess-capture-001' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const r = await tlsRequest({
    host: COLLECTOR,
    path: '/collector/v1/logs',
    headers: { 'x-auth-token': 'capture-token-abc', 'app-id': 'codearts-cli' },
    body: logsPayload,
  });
  if (r.status === 200) ok('logs 上报返回 200');
  else bad('logs 上报返回 200', `HTTP ${r.status}`);

  await new Promise((r2) => setTimeout(r2, 300));
  const s = await state();
  const rec = s.requests.find((x) => x.route === 'otlp.logs' && x.ingress === 'https');
  if (rec) ok('流水里能看到这条上报', `${rec.host} ${rec.reqBytes}B`);
  else bad('流水里能看到这条上报', '没找到 ingress=https 的 otlp.logs 记录');

  if (rec?.host === COLLECTOR) ok('来源域名被记下来了', rec.host);
  else bad('来源域名被记下来了', String(rec?.host));

  if (rec?.headers?.['x-auth-token']) ok('上报携带的 token 被抓到', rec.headers['x-auth-token']);
  else bad('上报携带的 token 被抓到', JSON.stringify(rec?.headers ?? {}));
}

console.log('\n\x1b[1m[3] traces 也能接\x1b[0m');
{
  const tracePayload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'CodeAgent3.0' } }] },
        scopeSpans: [
          {
            scope: { name: 'ai' },
            spans: [
              {
                traceId: 'a'.repeat(32),
                spanId: 'b'.repeat(16),
                name: 'ai.streamText.doStream',
                kind: 1,
                startTimeUnixNano: String(Date.now() * 1e6),
                endTimeUnixNano: String((Date.now() + 120) * 1e6),
                attributes: [
                  { key: 'ai.model.id', value: { stringValue: 'mock-flagship' } },
                  { key: 'gen_ai.request.model', value: { stringValue: 'mock-flagship' } },
                  { key: 'ai.prompt.messages', value: { stringValue: '[{"role":"user","content":"你好"}]' } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };

  const r = await tlsRequest({ host: COLLECTOR, path: '/collector/v1/traces', body: tracePayload });
  if (r.status === 200) ok('traces 上报返回 200');
  else bad('traces 上报返回 200', `HTTP ${r.status}`);

  await new Promise((r2) => setTimeout(r2, 300));
  const s = await state();
  const rec = s.requests.find((x) => x.route === 'otlp.traces' && x.ingress === 'https');
  if (rec) ok('traces 落进流水', `${rec.host}`);
  else bad('traces 落进流水', '没找到');

  const tel = s.telemetry ?? [];
  const hit = tel.find((t) => t.kind === 'traces' && JSON.stringify(t).includes('mock-flagship'));
  if (hit) ok('遥测页能解析出模型 id', 'mock-flagship');
  else bad('遥测页能解析出模型 id', tel.length ? `共 ${tel.length} 条但没命中` : '遥测为空');
}

console.log('\n\x1b[1m[4] 业务接口也能走 443\x1b[0m');
{
  const r = await tlsRequest({
    host: SNAP,
    path: '/snap-manager/v1/current/user',
    method: 'GET',
    headers: { 'x-auth-token': 'capture-token-abc' },
  });
  if (r.status === 200 && r.body.includes('mock-user')) ok('snap 用户接口经 TLS 正常返回');
  else bad('snap 用户接口经 TLS 正常返回', `HTTP ${r.status} ${r.body.slice(0, 120)}`);

  const s = await state();
  const rec = s.requests.find((x) => x.route === 'snap.currentUser' && x.host === SNAP);
  if (rec) ok('业务请求也标了来源域名', `${rec.host}`);
  else bad('业务请求也标了来源域名', '没找到');
}

console.log('\n\x1b[1m[5] 拒绝握手要能看出来\x1b[0m');
{
  // 用会校验证书的方式连，应当失败 —— 说明"证书不被信任"是可见的，不是静默
  const strict = await new Promise((resolve) => {
    const req = https.request(
      { host: '127.0.0.1', port: CAP_PORT, path: '/collector/v1/logs', method: 'POST', servername: COLLECTOR, rejectUnauthorized: true },
      (res) => { res.resume(); resolve({ ok: true, status: res.statusCode }); }
    );
    req.on('error', (e) => resolve({ ok: false, code: e.code }));
    req.end();
  });
  if (!strict.ok && /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(strict.code ?? '')) {
    ok('严格校验会拒绝自签证书', strict.code);
  } else bad('严格校验会拒绝自签证书', JSON.stringify(strict));
}

console.log('\n\x1b[1m[6] 证书 SAN 覆盖情况\x1b[0m');
{
  const crt = path.join(process.cwd(), 'data', 'certs', 'capture.crt');
  if (!fs.existsSync(crt)) {
    bad('证书文件存在', crt);
  } else {
    ok('证书文件存在', `${Math.round(fs.statSync(crt).size / 1024)}KB`);
    const tls = await import('node:tls');
    const check = (h) => new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: CAP_PORT, servername: h, rejectUnauthorized: false }, () => {
        const c = s.getPeerCertificate();
        resolve({ ok: c.subjectaltname?.includes(h), san: c.subjectaltname?.split(', ').length ?? 0 });
        s.end();
      });
      s.on('error', () => resolve({ ok: false }));
    });
    const a = await check(COLLECTOR);
    const b = await check('snap-access.cn-north-4.myhuaweicloud.com');
    if (a.ok && b.ok) ok('SAN 覆盖两个 collector/snap 域名', `${a.san} 条 SAN`);
    else bad('SAN 覆盖', JSON.stringify({ a, b }));
  }
}

console.log(`\n\x1b[1m结果：\x1b[0m\x1b[32m${pass} 通过\x1b[0m` + (fail ? `，\x1b[31m${fail} 失败\x1b[0m` : '，\x1b[32m0 失败\x1b[0m'));
if (fail) process.exitCode = 1;
