#!/usr/bin/env node
// mock-hub 自检：把 CLI 会打的每一个接口都走一遍，并验证 SSE / 遥测 / 签名。
// 用法: node tools/selftest.mjs [baseUrl]
import { signRequest } from '../lib/sign.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const AK = 'AKMOCKHUB0000000000';
const SK = 'SKMOCKHUB0000000000000000000000000000';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra = '') {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? ' \x1b[90m' + extra + '\x1b[0m' : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}: ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[31m${detail}\x1b[0m`);
}

async function call(name, method, path, { body, headers = {}, expect = 200, check } = {}) {
  const url = BASE + path;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-auth-token': 'selftest-token', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (res.status !== expect) return bad(name, `期望 ${expect} 实得 ${res.status}: ${text.slice(0, 160)}`);
    if (check) {
      const problem = check(json, text, res);
      if (problem) return bad(name, problem);
    }
    ok(name, `${res.status} ${text.length}B`);
    return { json, text, res };
  } catch (e) {
    bad(name, String(e.message ?? e));
  }
}

async function sse(name, path, body, { expectEvents, expectDone = true } = {}) {
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-token': 'selftest-token' },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) return bad(name, `状态 ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('event-stream')) return bad(name, `content-type 不是 SSE: ${ct}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let chunks = 0;
    let sawDone = false;
    let sawEvent = 0;
    const wanted = new Set(expectEvents ?? []);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.includes('data: [DONE]')) sawDone = true;
        if (/^event: /m.test(block)) sawEvent++;
        for (const w of wanted) if (block.includes(`event: ${w}`)) wanted.delete(w);
        if (block.includes('data: ')) chunks++;
      }
    }

    if (chunks < 2) return bad(name, `SSE 数据块太少: ${chunks}`);
    if (expectDone && !sawDone) return bad(name, '缺少 [DONE]');
    if (wanted.size) return bad(name, `缺少事件: ${[...wanted].join(',')}`);
    ok(name, `${chunks} 块${sawEvent ? `, ${sawEvent} 个 event` : ''}${sawDone ? ', [DONE]' : ''}`);
  } catch (e) {
    bad(name, String(e.message ?? e));
  }
}

/* ---------------- OTLP protobuf 手工编码 ---------------- */

function varint(n) {
  const out = [];
  let v = typeof n === 'bigint' ? n : BigInt(n);
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}
function tag(field, wire) {
  return varint((field << 3) | wire);
}
function lenField(field, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([tag(field, 2), varint(p.length), p]);
}
function strField(field, s) {
  return lenField(field, Buffer.from(String(s), 'utf8'));
}
function varintField(field, n) {
  return Buffer.concat([tag(field, 0), varint(n)]);
}
function anyValueString(s) {
  return strField(1, s); // AnyValue.string_value = 1
}
function keyValue(k, v) {
  return Buffer.concat([strField(1, k), lenField(2, anyValueString(v))]);
}
function buildTraceRequest() {
  const span = Buffer.concat([
    lenField(1, Buffer.from('0123456789abcdef0123456789abcdef', 'hex')), // trace_id
    lenField(2, Buffer.from('0123456789abcdef', 'hex')), // span_id
    strField(5, 'gen_ai.chat'), // name
    varintField(7, 1761000000000000000n), // start_time_unix_nano
    varintField(8, 1761000000500000000n), // end_time_unix_nano
    lenField(9, keyValue('gen_ai.request.model', 'mock-flagship')),
    lenField(9, keyValue('http.status_code', '200')),
  ]);
  const scopeSpans = Buffer.concat([lenField(1, strField(1, 'mock-hub')), lenField(2, span)]);
  const resource = lenField(1, keyValue('service.name', 'codearts-cli'));
  const resourceSpans = Buffer.concat([resource, lenField(2, scopeSpans)]);
  return Buffer.concat([lenField(1, resourceSpans)]);
}

/* ---------------- 主流程 ---------------- */

console.log(`\n\x1b[1mmock-hub 自检\x1b[0m → ${BASE}\n`);

console.log('\x1b[1m[1] 基础\x1b[0m');
await call('GET /health', 'GET', '/health', {
  check: (j) => (j?.ok ? null : 'ok 不为 true'),
});

console.log('\n\x1b[1m[2] 模型网关\x1b[0m');
await call('POST /api/v2/chat/completions（非流式）', 'POST', '/api/v2/chat/completions', {
  body: { model: 'mock-flagship', messages: [{ role: 'user', content: '你好，自检一下' }] },
  check: (j) => (j?.choices?.[0]?.message?.content?.includes('自检') ? null : '回复里没有回显内容'),
});
await sse('POST /api/v2/chat/completions（SSE）', '/api/v2/chat/completions', {
  model: 'mock-flagship',
  stream: true,
  messages: [{ role: 'user', content: '流式自检' }],
});
await call('POST /v1/chat/completions（兼容路径）', 'POST', '/v1/chat/completions', {
  body: { model: 'mock-lightweight', messages: [{ role: 'user', content: 'hi' }] },
  check: (j) => (j?.object === 'chat.completion' ? null : 'object 字段不对'),
});
await sse(
  'POST /v1/messages（Anthropic SSE）',
  '/v1/messages',
  { model: 'mock-thinking', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'anthropic 自检' }] },
  { expectEvents: ['message_start', 'content_block_delta', 'message_stop'], expectDone: false }
);
await call('POST /v1/messages（非流式）', 'POST', '/v1/messages', {
  body: { model: 'mock-thinking', max_tokens: 256, messages: [{ role: 'user', content: 'x' }] },
  check: (j) => (j?.type === 'message' ? null : 'type 不是 message'),
});
await call('GET /v1/models', 'GET', '/v1/models', {
  check: (j) => (j?.data?.length ? null : '模型列表为空'),
});
await call('POST /v1/model/thinking-variants', 'POST', '/v1/model/thinking-variants', {
  body: { model_names: ['mock-thinking'] },
});

console.log('\n\x1b[1m[3] agent-center\x1b[0m');
await call('GET /agents/useragents', 'GET', '/v1/agent-center/agents/useragents?offset=0&limit=100', {
  check: (j) => (j?.agents?.length ? null : 'agents 为空'),
});
await call('GET /agents/detail', 'GET', '/v1/agent-center/agents/detail?agent_id=mock-agent-0001', {
  check: (j) => (j?.gpts?.models?.length ? null : 'gpts.models 为空'),
});
await call('GET /v1/gateway-config', 'GET', '/v1/gateway-config?name=model_switch');
await call('GET /v1/skills-rules/list', 'GET', '/v1/skills-rules/list');
await call('GET /v1/agent-center/built-in-tools', 'GET', '/v1/agent-center/built-in-tools');

console.log('\n\x1b[1m[4] benefit-service\x1b[0m');
await call('POST /api/v1/benefit/claim', 'POST', '/api/v1/benefit/claim', {
  body: {},
  check: (j) => (j?.error_code === '0000' ? null : 'error_code 不是 0000'),
});
await call('GET /api/v1/user/tokens/balance', 'GET', '/api/v1/user/tokens/balance?channel=cli');
await call('GET /api/v1/gateway/config', 'GET', '/api/v1/gateway/config?channel=cli', {
  check: (j) => (j?.result?.models?.length ? null : 'result.models 为空'),
});

console.log('\n\x1b[1m[5] snap-manager\x1b[0m');
await call('GET /snap-manager/v1/current/user', 'GET', '/snap-manager/v1/current/user', {
  check: (j) => (j?.user_name ? null : '缺 user_name'),
});
await call('GET /snap-manager/v1/privacy', 'GET', '/snap-manager/v1/privacy', {
  check: (j) => (typeof j?.collect_data === 'boolean' ? null : 'collect_data 不是布尔'),
});
await call('PUT /snap-manager/v1/chat-session/heartbeat', 'PUT', '/snap-manager/v1/chat-session/heartbeat', {
  body: { status: 'running' },
  headers: { 'user-session-id': 'selftest-session' },
  check: (j) => (j?.data?.status === 'running' ? null : 'status 未回显'),
});
await call('GET /snap-manager/v1/statistics/plugin', 'GET', '/snap-manager/v1/statistics/plugin');
await call('POST /snap-manager/v1/skill/publish', 'POST', '/snap-manager/v1/skill/publish', {
  body: { skillName: 'demo', files: [{ fileName: 'a.zip' }, { fileName: 'b.zip' }] },
  check: (j) => (j?.urls?.length === 2 ? null : 'urls 数量不对'),
});
await call('POST /snap-manager/v1/skill/complete', 'POST', '/snap-manager/v1/skill/complete', { body: { skillName: 'demo' } });
await call('GET /snap-manager/v1/skill/submissions', 'GET', '/snap-manager/v1/skill/submissions?page=1&page_size=10');

console.log('\n\x1b[1m[6] prompt-center / memory\x1b[0m');
await call('GET /v1/model/builtin', 'GET', '/v1/model/builtin', {
  check: (j) => (j?.data?.builtinModels?.length ? null : 'builtinModels 为空'),
});
await call('POST /PromptCenterService/v1/prompts/retrieve', 'POST', '/PromptCenterService/v1/prompts/retrieve', { body: {} });
await call('POST /policy/feature-toggle', 'POST', '/PromptCenterService/v1/policy/feature-toggle', {
  body: { department: '华为集团' },
  headers: { depart: encodeURIComponent('华为集团') },
  check: (j) => (j?.data && 'permission_security' in j.data ? null : '缺少开关字段'),
});
await call('GET memory preferences', 'GET', '/v1/DevMate/preferences?limit=200&offset=0');
await call('POST memory preference', 'POST', '/v1/DevMate/preferences', { body: { type: 'general', content: 'x' } });

console.log('\n\x1b[1m[7] 其它\x1b[0m');
await call('GET /v1/release-info/latest', 'GET', '/v1/release-info/latest');
await call('POST /v1/oauth2/tokens', 'POST', '/v1/oauth2/tokens', { body: { grant_type: 'client_credentials' } });
await call('GET /v1/ops/credit/usage', 'GET', '/v1/ops/credit/usage');
await call('POST /codebaseservice/v1/codebases', 'POST', '/codebaseservice/v1/codebases', { body: {} });
await call('未知路由应 404', 'GET', '/no/such/route', { expect: 404 });

console.log('\n\x1b[1m[8] 遥测 OTLP\x1b[0m');
await call(
  'POST /collector/v1/logs（JSON）',
  'POST',
  '/collector/v1/logs',
  {
    body: {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codearts-cli' } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1761000000000000000',
                  severityText: 'INFO',
                  body: { stringValue: 'selftest log record' },
                  attributes: [{ key: 'gen_ai.model', value: { stringValue: 'mock-flagship' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  },
  { check: (j) => (j?.partialSuccess ? null : '缺 partialSuccess') }
);

try {
  const pb = buildTraceRequest();
  const res = await fetch(BASE + '/collector/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf', 'x-auth-token': 'selftest' },
    body: pb,
  });
  const j = await res.json();
  if (res.status !== 200) bad('POST /collector/v1/traces（protobuf）', `状态 ${res.status}`);
  else if (!j?.partialSuccess) bad('POST /collector/v1/traces（protobuf）', '缺 partialSuccess');
  else ok('POST /collector/v1/traces（protobuf）', `${pb.length}B 已解析`);
} catch (e) {
  bad('POST /collector/v1/traces（protobuf）', String(e.message ?? e));
}

console.log('\n\x1b[1m[9] SDK-HMAC-SHA256 签名校验\x1b[0m');
{
  // 打开校验并设置 SK
  await fetch(BASE + '/admin/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verifySignature: true, upstream: { sk: SK } }),
  });

  const path = '/api/v2/chat/completions';
  const url = BASE + path;
  const baseHeaders = { 'content-type': 'application/json' };
  const signed = signRequest({
    method: 'POST',
    url,
    headers: baseHeaders,
    body: Buffer.from(JSON.stringify({ model: 'mock-flagship', messages: [{ role: 'user', content: 'sig' }] })),
    ak: AK,
    sk: SK,
  });

  const good = await fetch(url, {
    method: 'POST',
    headers: { ...baseHeaders, ...signed.headers },
    body: JSON.stringify({ model: 'mock-flagship', messages: [{ role: 'user', content: 'sig' }] }),
  });
  if (good.status === 200) ok('合法签名 → 200', `SignedHeaders=${signed.headers.Authorization.split('SignedHeaders=')[1].split(',')[0]}`);
  else bad('合法签名 → 200', `状态 ${good.status}: ${(await good.text()).slice(0, 200)}`);

  const tampered = signed.headers.Authorization.replace(/Signature=([0-9a-f]{6})/, (m, p) =>
    'Signature=' + (p[0] === 'a' ? 'b' : 'a') + p.slice(1)
  );
  const evil = await fetch(url, {
    method: 'POST',
    headers: { ...baseHeaders, ...signed.headers, authorization: tampered },
    body: JSON.stringify({ model: 'mock-flagship', messages: [{ role: 'user', content: 'sig' }] }),
  });
  if (evil.status === 401) ok('篡改签名 → 401');
  else bad('篡改签名 → 401', `状态 ${evil.status}`);

  await fetch(BASE + '/admin/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verifySignature: false }),
  });
}

console.log('\n\x1b[1m[10] 状态汇总\x1b[0m');
{
  const r = await fetch(BASE + '/admin/api/state');
  const s = await r.json();
  const check = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));
  check('请求已被记录', s.counters.requests > 30, `${s.counters.requests} 条`);
  check('模型调用已计数', s.counters.chats >= 3, `${s.counters.chats} 次`);
  check('遥测已入库', s.counters.telemetry >= 2, `${s.counters.telemetry} 条`);
  check('凭证已捕获', s.credentials.length >= 1, `${s.credentials.length} 项`);
  check('凭证含 AK', s.credentials.some((c) => c.kind === 'ak'), s.credentials.map((c) => c.kind).join(','));
  check('管理面板可访问', (await fetch(BASE + '/admin')).status === 200);
  const tel = s.telemetry.find((t) => t.format === 'protobuf');
  check('protobuf 遥测已解析出文本', Boolean(tel?.texts?.some((t) => t.includes('gen_ai.chat'))), tel ? `${tel.texts?.length} 段文本` : '无');
}

console.log(
  `\n\x1b[1m结果：\x1b[0m\x1b[32m${pass} 通过\x1b[0m` +
    (fail ? `，\x1b[31m${fail} 失败\x1b[0m` : '，\x1b[32m0 失败\x1b[0m')
);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('');
