#!/usr/bin/env node
// 模拟一次完整的码道 CLI 会话，请求头/顺序/签名都按逆向结果还原。
// 用法: node tools/simulate-cli.mjs [baseUrl]
//
// 覆盖的真实链路：
//   多模态模型 → 特性开关 → benefit 网关配置/领取 → agent 列表 → agent 详情（模型清单）
//   → 轻量分类器调用 → 主对话 SSE → 会话心跳 → 用户/隐私 → OTLP traces/logs
import crypto from 'node:crypto';
import { signRequest } from '../lib/sign.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const AK = process.env.CODEARTS_CLI_AK || 'AKMOCKHUB0000000000';
const SK = process.env.CODEARTS_CLI_SK || 'SKMOCKHUB0000000000000000000000000000';
const USER_TOKEN = 'mock-user-token-' + crypto.randomBytes(6).toString('hex');
const SESSION_ID = crypto.randomUUID();
const CLIENT_VERSION = '26.10.9-mock';

const traceId = crypto.randomBytes(16).toString('hex');
const spanId = crypto.randomBytes(8).toString('hex');
const snapTraceId = crypto.randomUUID().replace(/-/g, '');

let step = 0;
const t0 = Date.now();

function line(icon, name, detail) {
  const ms = String(Date.now() - t0).padStart(5);
  console.log(`\x1b[90m${ms}ms\x1b[0m ${icon} ${name}${detail ? ' \x1b[90m' + detail + '\x1b[0m' : ''}`);
}

/** 还原 getInferhubHcHeaders 构造的那套头 */
function cliHeaders(extra = {}) {
  return {
    'x-auth-token': USER_TOKEN,
    'x-ot-trace-id': traceId,
    'x-ot-span-id': spanId,
    'x-snap-traceid': snapTraceId,
    'x-ot-session-id': SESSION_ID,
    'x-ot-parent-session-id': '',
    'user-session-id': SESSION_ID,
    'x-ot-function': 'agent-tui',
    'x-ot-client-type': 'CLI',
    'x-ot-client-version': CLIENT_VERSION,
    'user-msg-id': crypto.randomUUID(),
    'created-time': String(Date.now()),
    'model-id': 'mock-flagship',
    'model-name': 'mock-flagship',
    'x-current-user': 'mock-user',
    depart: encodeURIComponent('华为集团'),
    'agent-type': 'CodeAgent',
    'x-referer': 'CodeBase',
    'is_confidential': 'false',
    'app-id': 'CodeAgent3.0',
    'maas_type': 'benefit',
    'plugin-name': 'codearts-cli',
    'plugin-version': CLIENT_VERSION,
    'ide-name': 'codearts',
    'ide-version': CLIENT_VERSION,
    'kernel-version': CLIENT_VERSION,
    'client-ip': '127.0.0.1',
    'x-language': 'zh-cn',
    'x-client-type': 'DevMate',
    'content-type': 'application/json',
    ...extra,
  };
}

async function signedCall(name, method, path, body, { sign = true, extraHeaders } = {}) {
  const url = BASE + path;
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  let headers = cliHeaders(extraHeaders);

  if (sign) {
    const s = signRequest({ method, url, headers, body: raw, ak: AK, sk: SK });
    headers = { ...headers, ...s.headers };
  }

  const started = Date.now();
  const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : raw });
  const text = await res.text();
  const dur = Date.now() - started;

  const tag = res.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  line(tag, `${method} ${path}`, `${res.status} ${dur}ms ${text.length}B${sign ? ' signed' : ''}`);

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { res, text, json };
}

async function streamChat(model, messages, label) {
  const url = BASE + '/api/v2/chat/completions';
  const body = { model, messages, stream: true, tools: [] };
  const raw = Buffer.from(JSON.stringify(body));
  const s = signRequest({ method: 'POST', url, headers: cliHeaders({ 'model-id': model, 'model-name': model }), body: raw, ak: AK, sk: SK });

  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...cliHeaders({ 'model-id': model, 'model-name': model }), ...s.headers },
    body: raw,
  });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let chunks = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!block.startsWith('data: ')) continue;
      const payload = block.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta?.content;
        if (d) text += d;
        chunks++;
      } catch {
        /* ignore */
      }
    }
  }
  line('\x1b[32m✓\x1b[0m', `SSE ${label}`, `${res.status} ${Date.now() - started}ms ${chunks} 块 ${text.length} 字`);
  return text;
}

function otlpTrace(chatMs) {
  const varint = (n) => {
    const out = [];
    let v = BigInt(n);
    while (v > 0x7fn) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return Buffer.from(out);
  };
  const tag = (f, w) => varint((f << 3) | w);
  const len = (f, p) => {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(p);
    return Buffer.concat([tag(f, 2), varint(b.length), b]);
  };
  const str = (f, s) => len(f, Buffer.from(String(s), 'utf8'));
  const kv = (k, v) => Buffer.concat([str(1, k), len(2, str(1, v))]);

  const now = BigInt(Date.now()) * 1000000n;
  const span = Buffer.concat([
    len(1, Buffer.from(traceId, 'hex')),
    len(2, Buffer.from(spanId, 'hex')),
    str(5, 'gen_ai.chat'),
    varint(7, now - BigInt(chatMs) * 1000000n),
    varint(8, now),
    len(9, kv('gen_ai.request.model', 'mock-flagship')),
    len(9, kv('gen_ai.usage.input_tokens', '42')),
    len(9, kv('gen_ai.usage.output_tokens', '128')),
  ]);
  const scopeSpans = Buffer.concat([len(1, str(1, 'codearts-cli')), len(2, span)]);
  const resource = len(1, kv('service.name', 'codearts-cli'));
  return Buffer.concat([len(1, Buffer.concat([resource, len(2, scopeSpans)]))]);
}

/* ---------------- 会话开始 ---------------- */

console.log(`\n\x1b[1m模拟码道 CLI 会话\x1b[0m → ${BASE}`);
console.log(`\x1b[90msession=${SESSION_ID}  trace=${traceId.slice(0, 16)}…  ak=${AK}\x1b[0m\n`);

console.log('\x1b[1m[启动阶段]\x1b[0m');
await signedCall('多模态模型清单', 'GET', '/v1/model/builtin', undefined, { sign: false });
await signedCall('拉特性开关', 'POST', '/PromptCenterService/v1/policy/feature-toggle', { department: '华为集团' });

console.log('\n\x1b[1m[benefit 权益]\x1b[0m');
const gw = await signedCall('网关配置', 'GET', '/api/v1/gateway/config?channel=cli');
await signedCall('领取权益', 'POST', '/api/v1/benefit/claim', {});
await signedCall('余额查询', 'GET', '/api/v1/user/tokens/balance?channel=cli');

console.log('\n\x1b[1m[模型发现]\x1b[0m');
const agents = await signedCall('agent 列表', 'GET', '/v1/agent-center/agents/useragents?offset=0&limit=100');
const agentId = agents.json?.agents?.[0]?.agent_id ?? 'mock-agent-0001';
const detail = await signedCall('agent 详情（模型清单）', 'GET', `/v1/agent-center/agents/detail?agent_id=${encodeURIComponent(agentId)}`);
const models = detail.json?.gpts?.models ?? [];
line('  ', '解析到模型', models.map((m) => m.model_parameters?.model_id).join(', ') || '(空)');

console.log('\n\x1b[1m[对话阶段]\x1b[0m');
// 1) 复杂度分类器：轻量模型、非流式、max_tokens 很小
await signedCall('复杂度分类器', 'POST', '/api/v2/chat/completions', {
  model: 'mock-lightweight',
  max_tokens: 256,
  stream: false,
  messages: [{ role: 'user', content: '这个任务需要多复杂的推理？' }],
});

// 2) 主对话：SSE
const chatStart = Date.now();
const answer = await streamChat('mock-flagship', [
  { role: 'system', content: 'You are CodeArts CLI mock agent.' },
  { role: 'user', content: '读一下 README.md，然后告诉我这个仓库是干什么的' },
], '主对话');

console.log('\n\x1b[90m--- 模型返回（前 400 字）---\x1b[0m');
console.log(answer.slice(0, 400).split('\n').map((l) => '  \x1b[90m│\x1b[0m ' + l).join('\n'));
console.log('\x1b[90m--- 结束 ---\x1b[0m\n');

console.log('\x1b[1m[会话维持]\x1b[0m');
await signedCall('会话心跳', 'PUT', '/snap-manager/v1/chat-session/heartbeat', { status: 'running' });
await signedCall('当前用户', 'GET', '/snap-manager/v1/current/user');
await signedCall('隐私配置', 'GET', '/snap-manager/v1/privacy');
await signedCall('插件统计', 'GET', '/snap-manager/v1/statistics/plugin');

console.log('\n\x1b[1m[遥测上报]\x1b[0m');
{
  const pb = otlpTrace(Date.now() - chatStart);
  const res = await fetch(BASE + '/collector/v1/traces', {
    method: 'POST',
    headers: cliHeaders({ 'content-type': 'application/x-protobuf' }),
    body: pb,
  });
  line(res.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m', 'POST /collector/v1/traces', `${res.status} ${pb.length}B protobuf`);
}
{
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codearts-cli' } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(BigInt(Date.now()) * 1000000n),
                severityText: 'INFO',
                body: { stringValue: 'chat turn completed' },
                traceId,
                spanId,
                attributes: [
                  { key: 'gen_ai.request.model', value: { stringValue: 'mock-flagship' } },
                  { key: 'session.id', value: { stringValue: SESSION_ID } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const res = await fetch(BASE + '/collector/v1/logs', {
    method: 'POST',
    headers: cliHeaders(),
    body: JSON.stringify(payload),
  });
  line(res.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m', 'POST /collector/v1/logs', `${res.status} JSON`);
}

console.log(`\n\x1b[1m会话完成\x1b[0m 总耗时 ${Date.now() - t0}ms`);
console.log(`查看面板: ${BASE}/admin\n`);
