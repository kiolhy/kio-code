// 真实上游网关：把 OpenAI 兼容请求翻译成码道（CodeArts）协议，
// 用账号池里的凭据做 SDK-HMAC-SHA256 签名，再转发给 snap-access。
// 与 mock 模式互不影响：mode=gateway 时才走这里。
//
// 出站请求长什么样由 lib/stealth.mjs 决定（头集合/会话 id），
// 怎么发出去由 lib/transport.mjs 决定（头顺序/TLS/代理）。
// 两者合起来的目标：上游看到的应该是一个正常的 codearts CLI 会话。
import { Readable } from 'node:stream';
import { signRequest } from './sign.mjs';
import {
  resolveProfile,
  buildSignableHeaders,
  buildTransportHeaders,
  sessionFor,
  findIdentityLeaks,
} from './stealth.mjs';
import { getTransport } from './transport.mjs';

const DEFAULT_REGIONS = {
  cn: 'https://snap-access.cn-north-4.myhuaweicloud.com',
  intl: 'https://snap-access.ap-southeast-1.myhuaweicloud.com',
};

/** 解析上游地址（按账号区域） */
export function resolveUpstream(cfg, account) {
  const g = cfg.gateway ?? {};
  const regions = { ...DEFAULT_REGIONS, ...(g.regions ?? {}) };
  const region = account?.region ?? g.defaultRegion ?? 'cn';
  const base = (regions[region] ?? regions.cn).replace(/\/+$/, '');
  return { base, region, chatPath: g.chatPath ?? '/api/v2/chat/completions' };
}

const credentialsOf = (acc) => ({
  ak: acc.accessKeyId,
  sk: acc.secretAccessKey,
  token: acc.securityToken || '',
  account: acc,
  source: 'account',
});

/** 轮询游标：跨请求推进，避免所有流量压在同一本账号上 */
let cursor = 0;

/**
 * 选出一次调用要用的凭据：账号池优先，其次配置里的兜底 AK/SK。
 * @param {object} p
 * @param {string[]} [p.exclude] 已试过的账号 id（轮换时跳过）
 */
export function pickCredentials({ ctx, panel, cfg, exclude = [] }) {
  const skip = new Set(exclude.filter(Boolean));
  const preferred = ctx?.authAccount ?? null;
  const pool = (panel?.accounts?.() ?? []).filter(
    (a) => a.enabled !== false && a.accessKeyId && a.secretAccessKey
  );

  if (preferred && !skip.has(preferred.id) && !skip.has(preferred.ref) && preferred.accessKeyId && preferred.secretAccessKey) {
    const idx = pool.findIndex((a) => a.id === preferred.id);
    if (idx >= 0) cursor = (idx + 1) % Math.max(1, pool.length);
    return credentialsOf(preferred);
  }

  const usable = pool.filter((a) => !skip.has(a.id) && !skip.has(a.ref));
  if (usable.length > 0) {
    const chosen = usable[cursor % usable.length];
    cursor = (cursor + 1) % usable.length;
    return credentialsOf(chosen);
  }

  const up = cfg.upstream ?? {};
  if (up.ak && up.sk) {
    return { ak: up.ak, sk: up.sk, token: up.securityToken ?? '', account: null, source: 'config' };
  }
  return null;
}

/**
 * 把客户端发来的 OpenAI 请求补成码道要的形状。
 * 从实测抓包看，上游本来就吃 OpenAI 协议，只多了几个私有字段。
 */
export function buildUpstreamBody(body, { stream }) {
  const out = { ...body };
  if (out.max_tokens === undefined && out.max_completion_tokens !== undefined) {
    out.max_tokens = out.max_completion_tokens;
  }
  if (out.max_tokens === undefined) out.max_tokens = 16384;
  if (out.creditRatioDisplay === undefined) out.creditRatioDisplay = '2x';
  if (out.tool_stream === undefined) out.tool_stream = Array.isArray(out.tools) && out.tools.length > 0;
  if (out.tool_choice === undefined && Array.isArray(out.tools) && out.tools.length) out.tool_choice = 'auto';
  if (out.stream === undefined) out.stream = !!stream;
  if (out.user_prompt === undefined) {
    const msgs = Array.isArray(out.messages) ? out.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role !== 'user') continue;
      const c = msgs[i].content;
      out.user_prompt = typeof c === 'string' ? c : JSON.stringify(c);
      break;
    }
  }
  return out;
}

/**
 * 造出站头：先造 CLI 那批可签名的头，签完再补传输层头。
 * 顺序 = 签名里的 canonicalHeaders 排序无关，但发送顺序按这里来。
 * @returns {{headers:object, signable:object, profile:object, session:object}}
 */
export function buildUpstreamHeaders({ cfg, account, model, bodyText, creds }) {
  const profile = resolveProfile(cfg);
  const session = sessionFor(account, cfg.stealth?.sessionTtlMs);
  const signable = buildSignableHeaders({
    cfg,
    account,
    model,
    session,
    token: creds?.token ?? account?.securityToken ?? '',
    profile,
  });

  const url = creds?.url; // 仅用于签名，调用方保证已带上
  const { headers } = signRequest({
    method: 'POST',
    url,
    headers: signable,
    body: bodyText,
    ak: creds.ak,
    sk: creds.sk,
  });

  // host 交给传输层按 URL 生成（与签名时算出来的一致），避免出现重复 Host
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'host') continue;
    out[k] = v;
  }
  Object.assign(out, buildTransportHeaders(profile)); // 不参与签名

  if (cfg.stealth?.assertNoLeaks) {
    const leaks = findIdentityLeaks(out);
    if (leaks.length) {
      const e = new Error(`出站请求带上了网关特征：${leaks.join('; ')}`);
      e.code = 'fingerprint_leak';
      throw e;
    }
  }

  return { headers: out, signable, profile, session };
}

function requestTimeout(cfg) {
  return cfg.stealth?.timeoutMs ?? cfg.gateway?.timeoutMs ?? 300_000;
}

/**
 * 转发一次 chat 调用。
 * @param {object} p
 * @param {object} [p.credentials] 已经选好的凭据（轮换时由上层传入）
 * @returns {Promise<{status:number, headers:object, body:Buffer, account:object|null}>}
 */
export async function forwardChatOnce({ body, cfg, panel, ctx, timeoutMs, credentials, transport, excludeAccountIds = [] }) {
  const creds = credentials ?? pickCredentials({ ctx, panel, cfg, exclude: excludeAccountIds });
  if (!creds) {
    const e = new Error('没有可用账号：请先在控制台添加账号，或配置 upstream.ak/sk');
    e.code = 'no_credentials';
    throw e;
  }
  const { base, chatPath, region } = resolveUpstream(cfg, creds.account);
  const url = base + chatPath;
  const upstreamBody = buildUpstreamBody(body, { stream: !!body?.stream });
  const bodyText = JSON.stringify(upstreamBody);
  const { headers } = buildUpstreamHeaders({
    cfg,
    account: creds.account ?? null,
    model: upstreamBody.model ?? body?.model,
    bodyText,
    creds: { ...creds, url },
  });

  const t = transport ?? getTransport(cfg);
  const resp = await t.request({
    url,
    method: 'POST',
    headers,
    body: bodyText,
    timeoutMs: timeoutMs ?? requestTimeout(cfg),
    proxy: creds.account?.proxy || cfg.stealth?.egress?.proxy || '',
  });

  const buf = await resp.buffer(cfg.stealth?.maxResponseBytes);
  return {
    status: resp.status,
    headers: { ...resp.headers },
    body: buf,
    account: creds.account,
    region,
    upstreamUrl: url,
    retryAfterMs: undefined,
  };
}

/**
 * 流式转发：把上游 SSE 原样写给客户端，同时旁路解析 usage。
 */
export async function forwardChatStream({ body, cfg, panel, ctx, res, onUsage, credentials, transport }) {
  const creds = credentials ?? pickCredentials({ ctx, panel, cfg });
  if (!creds) {
    const e = new Error('没有可用账号：请先在控制台添加账号，或配置 upstream.ak/sk');
    e.code = 'no_credentials';
    throw e;
  }
  const { base, chatPath, region } = resolveUpstream(cfg, creds.account);
  const url = base + chatPath;
  const upstreamBody = buildUpstreamBody(body, { stream: true });
  const bodyText = JSON.stringify(upstreamBody);
  const { headers } = buildUpstreamHeaders({
    cfg,
    account: creds.account ?? null,
    model: upstreamBody.model ?? body?.model,
    bodyText,
    creds: { ...creds, url },
  });

  const t = transport ?? getTransport(cfg);
  const resp = await t.request({
    url,
    method: 'POST',
    headers,
    body: bodyText,
    timeoutMs: requestTimeout(cfg),
    idleTimeoutMs: cfg.stealth?.streamIdleMs ?? 180_000,
    proxy: creds.account?.proxy || cfg.stealth?.egress?.proxy || '',
  });

  if (resp.status !== 200 || !resp.stream) {
    const text = (await resp.buffer(cfg.stealth?.maxResponseBytes).catch(() => Buffer.alloc(0))).toString('utf8');
    return { status: resp.status, errorText: text, account: creds.account, region, headers: resp.headers };
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-kio-upstream': base,
    'x-kio-region': region,
  });

  let usage = null;
  let carry = '';
  const nodeStream = Readable.from(resp.stream);

  await new Promise((resolve, reject) => {
    nodeStream.on('data', (chunk) => {
      res.write(chunk);
      // 旁路解析 usage（不干扰转发）
      carry += chunk.toString('utf8');
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.usage) usage = j.usage;
        } catch {
          /* 分片不完整，忽略 */
        }
      }
    });
    nodeStream.on('end', () => {
      res.end();
      resolve();
    });
    nodeStream.on('error', reject);
  });

  if (onUsage) {
    onUsage({
      usage,
      account: creds.account,
      region,
      model: body?.model,
    });
  }
  return { status: 200, account: creds.account, region };
}

/**
 * Anthropic /v1/messages → OpenAI chat 的请求转换（最小可用集）。
 */
export function anthropicToOpenAI(body) {
  const messages = [];
  const sys = body?.system;
  if (typeof sys === 'string' && sys.trim()) messages.push({ role: 'system', content: sys });
  else if (Array.isArray(sys)) {
    const text = sys.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n');
    if (text.trim()) messages.push({ role: 'system', content: text });
  }

  for (const m of body?.messages ?? []) {
    const content = m?.content;
    if (typeof content === 'string') {
      messages.push({ role: m.role, content });
      continue;
    }
    if (Array.isArray(content)) {
      const texts = [];
      const toolCalls = [];
      const toolResults = [];
      for (const b of content) {
        if (b?.type === 'text') texts.push(b.text ?? '');
        else if (b?.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        } else if (b?.type === 'tool_result') {
          const c = b.content;
          toolResults.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof c === 'string' ? c : JSON.stringify(c ?? ''),
          });
        }
      }
      if (m.role === 'assistant' && toolCalls.length) {
        messages.push({ role: 'assistant', content: texts.join('\n') || null, tool_calls: toolCalls });
      } else if (texts.length) {
        messages.push({ role: m.role, content: texts.join('\n') });
      }
      for (const tr of toolResults) messages.push(tr);
    }
  }

  const tools = (body?.tools ?? [])
    .filter((t) => t?.name)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } },
    }));

  return {
    model: body?.model,
    messages,
    max_tokens: body?.max_tokens ?? 4096,
    stream: !!body?.stream,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(body?.temperature !== undefined ? { temperature: body.temperature } : {}),
  };
}

/** OpenAI 响应 → Anthropic messages 响应 */
export function openAIToAnthropic(json) {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments ?? '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: json?.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: json?.model ?? 'unknown',
    content,
    stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: json?.usage?.prompt_tokens ?? 0,
      output_tokens: json?.usage?.completion_tokens ?? 0,
    },
  };
}
