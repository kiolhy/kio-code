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
  maasTypeFor,
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
  // 流式必须显式要 usage，否则上游 SSE 只在最后带 [DONE]，token 数全是 0。
  // CLI 自己的 provider 也是靠 stream_options.include_usage 才拿到用量的。
  if (out.stream === true) {
    out.stream_options = { ...(out.stream_options ?? {}), include_usage: true };
  }
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
  // 按账号的套餐状态选计费通道：没有 benefit 套餐的账号发 benefit 会被上游
  // 回 200 + 4004 benefit not found（业务错误，HTTP 层看不出来）
  const profile = resolveProfile(cfg, { maasType: maasTypeFor(account) });
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

  // 上游的业务错误也是 200：{"error_code":"4004","error_msg":"benefit not found"}
  // 只看状态码会把这种响应当成正常回复透传给客户端，客户端拿到一个
  // 没有 choices 的「成功」响应，排查起来毫无线索。这里翻成真实错误码。
  const biz = detectUpstreamBizError(resp.status, buf);
  if (biz) {
    return {
      status: biz.status,
      headers: { ...resp.headers },
      body: buf,
      account: creds.account,
      region,
      upstreamUrl: url,
      retryAfterMs: undefined,
      bizError: biz,
    };
  }

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
 * 识别上游「HTTP 200 但业务失败」的响应。
 *
 * 码道的业务错误长这样（HTTP 状态是 200）：
 *   {"error_code":"4004","error_msg":"benefit not found","result":null}
 *   {"error_code":"4000","error_msg":"invalid channel, group not found"}
 *
 * @returns {{code:string, message:string, status:number}|null}
 */
export function detectUpstreamBizError(status, buf) {
  if (status !== 200) return null;
  let j;
  try {
    j = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  // 正常响应有 choices；没有 error_code 的也不算错
  const code = j.error_code ?? j.errorCode;
  if (code == null || code === '' || code === '0' || code === '0000') return null;
  if (Array.isArray(j.choices) && j.choices.length) return null;

  const message = String(j.error_msg ?? j.errorMsg ?? j.message ?? '').slice(0, 300);
  // 业务码 → HTTP 语义
  const map = {
    '4000': 400, // 参数错误 / 无效 channel
    '4001': 400,
    '4002': 400,
    '4003': 403, // 用户禁用
    '4004': 402, // 权益不存在 / 已过期（benefit not found）
    '4006': 429, // 领取次数用尽
    '4010': 401, // 未授权
    '5000': 500,
  };
  return { code: String(code), message, status: map[String(code)] ?? 502 };
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
    const buf = await resp.buffer(cfg.stealth?.maxResponseBytes).catch(() => Buffer.alloc(0));
    const text = buf.toString('utf8');
    // 上游业务错误：HTTP 200 + JSON（不是 SSE），必须翻成真实状态码，
    // 否则客户端会收到一个「200 但没有内容」的流
    const biz = detectUpstreamBizError(resp.status, buf);
    if (biz) {
      return { status: biz.status, errorText: text, account: creds.account, region, headers: resp.headers, bizError: biz };
    }
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
  // 上游不给 usage 时的本地兜底：从 SSE 内容里数出来
  let outChars = 0;
  let outCjk = 0; // 其中中日韩字符数（token 权重更高）
  let outChunks = 0;
  let sawUsage = false;

  // 累计输出文本（按字符类型分开数，估算更准）
  const countText = (s) => {
    if (typeof s !== 'string' || !s) return;
    outChars += s.length;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3040 && cp <= 0x30ff) ||
        (cp >= 0xac00 && cp <= 0xd7af) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff)
      ) outCjk++;
    }
  };

  // 处理一行 SSE（data: {...}）
  const handleLine = (line) => {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const j = JSON.parse(payload);
      if (j.usage) { usage = j.usage; sawUsage = true; }
      // 累计输出文本长度（兜底估算用）
      const d = j.choices?.[0]?.delta ?? {};
      if (typeof d.content === 'string' && d.content) { countText(d.content); outChunks++; }
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) countText(d.reasoning_content);
      const tc = d.tool_calls;
      if (Array.isArray(tc)) {
        for (const c of tc) {
          const a = c?.function?.arguments;
          if (typeof a === 'string') countText(a);
          if (typeof c?.function?.name === 'string') countText(c.function.name);
        }
      }
    } catch {
      /* 分片不完整，忽略 */
    }
  };

  const nodeStream = Readable.from(resp.stream);

  await new Promise((resolve, reject) => {
    nodeStream.on('data', (chunk) => {
      res.write(chunk);
      // 旁路解析 usage（不干扰转发）
      carry += chunk.toString('utf8');
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    nodeStream.on('end', () => {
      // 最后一行可能没有换行结尾，补处理一次
      if (carry) { handleLine(carry); carry = ''; }
      res.end();
      resolve();
    });
    nodeStream.on('error', reject);
  });

  // 上游没给 usage → 本地估算（标记 estimated，面板会显示「估算」）
  let estimated = false;
  if (!usage && outChars > 0) {
    estimated = true;
    // CJK 约 1 token/字，其余约 3 字符/token
    const completionTokens = Math.ceil(outCjk + (outChars - outCjk) / 3);
    const promptTokens = estimatePromptTokens(body);
    usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      _estimated: true,
      _outChars: outChars,
      _outCjk: outCjk,
      _outChunks: outChunks,
      _sawUsage: sawUsage,
    };
  }

  if (onUsage) {
    onUsage({
      usage,
      account: creds.account,
      region,
      model: body?.model,
      estimated,
    });
  }
  return { status: 200, account: creds.account, region, usage, estimated };
}

/* ---------------- token 估算（上游不给 usage 时兜底） ---------------- */

/**
 * 保证有 usage：上游给了就用上游的，没给就本地估算并打 _estimated 标记。
 * @returns {{usage:object|null, estimated:boolean}}
 */
export function ensureUsage(usage, { requestBody, responseJson } = {}) {
  if (usage && (usage.prompt_tokens != null || usage.input_tokens != null)) {
    return { usage, estimated: false };
  }
  // 从响应里把输出文本拼出来
  let outText = '';
  const choices = responseJson?.choices ?? [];
  for (const c of choices) {
    const m = c?.message ?? c?.delta ?? {};
    if (typeof m.content === 'string') outText += m.content;
    if (typeof m.reasoning_content === 'string') outText += m.reasoning_content;
    for (const tc of m.tool_calls ?? []) {
      if (typeof tc?.function?.arguments === 'string') outText += tc.function.arguments;
      if (typeof tc?.function?.name === 'string') outText += tc.function.name;
    }
  }
  // 有些上游把 usage 放在别处
  const alt = responseJson?.usage ?? responseJson?.data?.usage ?? responseJson?.result?.usage;
  if (alt && (alt.prompt_tokens != null || alt.input_tokens != null)) {
    return { usage: alt, estimated: false };
  }
  if (!outText && !requestBody) return { usage: usage ?? null, estimated: false };

  const promptTokens = estimatePromptTokens(requestBody);
  const completionTokens = estimateTokensFromChars(outText);
  return {
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      _estimated: true,
    },
    estimated: true,
  };
}

/**
 * 从字符数估算 token 数。
 * 中日韩字符约 1 token/字，英文约 4 字符/token，混合按加权。
 */
export function estimateTokensFromChars(text) {
  // 兼容传字符数（流式路径只累计了长度，没留原文）
  if (typeof text === 'number') return text > 0 ? Math.ceil(text / 3) : 0;
  const s = typeof text === 'string' ? text : '';
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // 中日韩统一表意
      (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
      (cp >= 0xac00 && cp <= 0xd7af) || // 韩文
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) cjk++;
    else other++;
  }
  // CJK 约 1 token/字；其余约 4 字符/token
  return Math.ceil(cjk + other / 4);
}

/** 从请求体估算输入 token（messages + system + tools） */
export function estimatePromptTokens(body) {
  if (!body) return 0;
  const parts = [];
  const push = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) for (const x of v) push(x);
    else if (v && typeof v === 'object') {
      if (typeof v.text === 'string') parts.push(v.text);
      if (typeof v.content === 'string') parts.push(v.content);
    }
  };
  for (const m of body.messages ?? []) {
    push(m?.content);
    if (typeof m?.reasoning_content === 'string') parts.push(m.reasoning_content);
    for (const tc of m?.tool_calls ?? []) {
      push(tc?.function?.arguments);
      if (typeof tc?.function?.name === 'string') parts.push(tc.function.name);
    }
  }
  if (typeof body.system === 'string') parts.push(body.system);
  push(body.system);
  for (const t of body.tools ?? []) {
    if (t?.function) {
      if (typeof t.function.description === 'string') parts.push(t.function.description);
      if (t.function.parameters) parts.push(JSON.stringify(t.function.parameters));
    }
  }
  if (typeof body.user_prompt === 'string') parts.push(body.user_prompt);
  return estimateTokensFromChars(parts.join('\n'));
}

/**
 * 通用上游转发：把 CLI 的任意元数据请求（模型发现、agent 详情等）
 * 用账号池凭据签名后真实转发到 snap-access。
 *
 * 与 forwardChatOnce 的区别：不改造 body、不改路径，原样转发。
 * @returns {Promise<{status:number, headers:object, body:Buffer, account:object|null, upstreamUrl:string}>}
 */
export async function forwardRawOnce({ method = 'GET', path, search = '', headers: inHeaders = {}, cfg, panel, ctx, bodyText = '', timeoutMs, credentials }) {
  const creds = credentials ?? pickCredentials({ ctx, panel, cfg });
  if (!creds) {
    const e = new Error('没有可用账号：请先在控制台添加账号，或配置 upstream.ak/sk');
    e.code = 'no_credentials';
    throw e;
  }
  const { base, region } = resolveUpstream(cfg, creds.account);
  const url = base + path + (search || '');

  // 只保留 CLI 自己的业务头，签名头由我们重造
  const skip = new Set([
    'host', 'content-length', 'connection', 'accept-encoding',
    'authorization', 'x-security-token', 'x-auth-token',
  ]);
  const keep = {};
  for (const [k, v] of Object.entries(inHeaders ?? {})) {
    if (skip.has(k.toLowerCase())) continue;
    keep[k] = v;
  }
  // 补上账号身份（真实 userName）
  if (creds.account?.userName) keep['x-current-user'] = String(creds.account.userName);
  if (String(path).includes('agent-center')) {
    keep['agent-type'] = cfg.accountInfo?.agentType ?? 'AgentCenter';
    if (!keep['x-language'] && !keep['X-Language']) keep['x-language'] = cfg.accountInfo?.language ?? 'zh-cn';
  }

  const signable = { ...keep, 'x-security-token': creds.token || '', 'app-id': cfg.stealth?.profile?.appId ?? 'CodeAgent3.0' };
  const { headers } = signRequest({
    method,
    url,
    headers: signable,
    body: bodyText,
    ak: creds.ak,
    sk: creds.sk,
  });

  const t = getTransport(cfg);
  const resp = await t.request({
    url,
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : bodyText,
    timeoutMs: timeoutMs ?? requestTimeout(cfg),
    proxy: creds.account?.proxy || cfg.stealth?.egress?.proxy || '',
  });
  const buf = await resp.buffer(cfg.stealth?.maxResponseBytes);
  return { status: resp.status, headers: { ...resp.headers }, body: buf, account: creds.account, region, upstreamUrl: url };
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
      cache_read_input_tokens: json?.usage?.prompt_tokens_details?.cached_tokens ?? json?.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: json?.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}
