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
 * 从账号的模型目录里查显示名。
 *
 * 真 CLI 发两个头：
 *   model-id     = model_id（openpangu-2.0-pro）
 *   model-name   = 显示名（OpenPangu-2.0-Pro）
 * 两个都发 model_id 或都发显示名，跟真 CLI 的请求就对不上。
 *
 * @returns {string|undefined} 查不到就返回 undefined（调用方回落成 model）
 */
export function modelDisplayName(account, model) {
  if (!model) return undefined;
  let info = account?.info;
  if (!info) return undefined;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch { return undefined; }
  }
  const list = info?.models;
  if (!Array.isArray(list)) return undefined;
  const hit = list.find((m) => m?.id === model || m?.alias === model);
  const name = hit?.name;
  return typeof name === 'string' && name ? name : undefined;
}

/**
 * 按「这个账号自己的模型表」给出要发到上游的 model-id / model-name。
 *
 * 关键：不同账号对同一个模型报的字段不一样，上游按账号认各自的写法。
 *
 *   码道-y4ik 报 { id:'kimi-k3', name:'Kimi-K3' }
 *     → model-id: kimi-k3      model-name: Kimi-K3
 *   码道-ij09 报 { id:'Kimi-K3' }        ← id 本身就是显示名
 *     → model-id: Kimi-K3      model-name: Kimi-K3
 *
 * 实测把 kimi-k3 派给 ij09、或把 Kimi-K3 派给 y4ik，上游都回
 * InferHub.002002009.404「Route missed for model」。所以这里必须
 * 以「命中该账号自己那条记录」为准，不能用全局目录里的 id。
 *
 * @returns {{modelId:string, modelName:string}} 查不到时两个都用传入值
 */
export function upstreamModelHeaders(account, model) {
  const fallback = { modelId: model, modelName: model };
  if (!model) return fallback;
  let info = account?.info;
  if (!info) return fallback;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch { return fallback; }
  }
  const list = info?.models;
  if (!Array.isArray(list) || !list.length) return fallback;
  const hit = list.find((m) => m?.id === model || m?.alias === model || m?.name === model);
  if (!hit) return fallback;
  const modelId = typeof hit.id === 'string' && hit.id ? hit.id : model;
  // 这个账号没单独给 name 时，显示名就用 id（ij09 就是这种情况）
  const modelName = typeof hit.name === 'string' && hit.name ? hit.name : modelId;
  return { modelId, modelName };
}

/**
 * 把调用方传进来的模型名解析成该账号模型表里的 model_id。
 *
 * 调用方可能填显示名（Kimi-K3），这里按 id / alias / name 三种匹配，
 * 统一回落到该账号自己那条记录的 id。
 *
 * 注意：这只是「归一化到本账号的写法」，不同账号的 id 可能不同
 * （y4ik 是 kimi-k3，ij09 是 Kimi-K3），所以选账号时还要用
 * accountHasModel 过滤，发头时用 upstreamModelHeaders。
 *
 * @returns {string} 解析出的 model_id；匹配不上原样返回（让上游自己报错）
 */
export function resolveModelId(account, model) {
  if (!model) return model;
  let info = account?.info;
  if (!info) return model;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch { return model; }
  }
  const list = info?.models;
  if (!Array.isArray(list) || !list.length) return model;
  const hit = list.find((m) => m?.id === model || m?.alias === model || m?.name === model);
  return hit?.id && typeof hit.id === 'string' ? hit.id : model;
}

/**
 * 账号的模型表里有没有这个模型（id / alias / name 任一命中），
 * 并且这个模型在可用性验证里没被判死。
 *
 * 不同账号的模型表可能不一样：实测账号 A 有 kimi-k3，账号 B 只有
 * Kimi-K3。更坑的是账号 B 表里列了 8 个模型，实际只有 1 个能调通，
 * 其余全回 InferHub.002002009.404。所以探测时会把结果写进 usable，
 * 这里一并检查。
 *
 * @returns {boolean|null} true/false；账号没探测过模型表时返回 null（未知，放行）
 */
export function accountHasModel(account, model) {
  if (!model) return null;
  let info = account?.info;
  if (!info) return null;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch { return null; }
  }
  const list = info?.models;
  if (!Array.isArray(list) || !list.length) return null;
  const hit = list.find((m) => m?.id === model || m?.alias === model || m?.name === model);
  if (!hit) return false;
  // 验证过且明确不可用 → 排除
  if (hit.usable === false) return false;
  return true;
}

/**
 * 选出一次调用要用的凭据：账号池优先，其次配置里的兜底 AK/SK。
 * @param {object} p
 * @param {string[]} [p.exclude] 已试过的账号 id（轮换时跳过）
 * @param {string} [p.model]     目标模型；给了就只选模型表里有它的账号
 */
export function pickCredentials({ ctx, panel, cfg, exclude = [], model = '' }) {
  const skip = new Set(exclude.filter(Boolean));
  const preferred = ctx?.authAccount ?? null;
  const pool = (panel?.accounts?.() ?? []).filter(
    (a) => a.enabled !== false && a.accessKeyId && a.secretAccessKey
  );
  // true = 有这个模型；null = 没探测过（放行）；false = 明确没有
  const fits = (a) => accountHasModel(a, model) !== false;

  if (
    preferred && !skip.has(preferred.id) && !skip.has(preferred.ref)
    && preferred.accessKeyId && preferred.secretAccessKey && fits(preferred)
  ) {
    const idx = pool.findIndex((a) => a.id === preferred.id);
    if (idx >= 0) cursor = (idx + 1) % Math.max(1, pool.length);
    return credentialsOf(preferred);
  }

  const usable = pool.filter((a) => !skip.has(a.id) && !skip.has(a.ref) && fits(a));
  if (usable.length > 0) {
    const chosen = usable[cursor % usable.length];
    cursor = (cursor + 1) % usable.length;
    return credentialsOf(chosen);
  }

  // 没有账号声明支持这个模型 —— 仍然选一个（模型表可能过期），
  // 让上游给出真实错误，比直接本地拒绝更有用。
  const fallback = pool.filter((a) => !skip.has(a.id) && !skip.has(a.ref));
  if (fallback.length > 0) {
    const chosen = fallback[cursor % fallback.length];
    cursor = (cursor + 1) % fallback.length;
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
export function buildUpstreamBody(body, { stream, account } = {}) {
  const out = { ...body };
  // 调用方可能填的是显示名（DeepSeek-V4.1-Flash-1017），上游只认 model_id
  // （deepseek-v4.1-flash-1017）。这里统一解析成 id，避免上游返回
  // HTTP 200 + InferHub.002002009.404「The model is not registered」。
  if (account && out.model) out.model = resolveModelId(account, out.model);
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
 * @param {object} p
 * @param {string} [p.model]     model_id（model-id 头 + 请求体 model）
 * @param {string} [p.modelName] 显示名（model-name 头），不给就用 model
 * @returns {{headers:object, signable:object, profile:object, session:object}}
 */
export function buildUpstreamHeaders({ cfg, account, model, modelName, bodyText, creds }) {
  // 按账号的套餐状态选计费通道：没有 benefit 套餐的账号发 benefit 会被上游
  // 回 200 + 4004 benefit not found（业务错误，HTTP 层看不出来）
  const profile = resolveProfile(cfg, { maasType: maasTypeFor(account) });
  const session = sessionFor(account, cfg.stealth?.sessionTtlMs);
  const signable = buildSignableHeaders({
    cfg,
    account,
    model,
    modelName,
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
  const creds = credentials ?? pickCredentials({ ctx, panel, cfg, exclude: excludeAccountIds, model: body?.model });
  if (!creds) {
    const e = new Error('没有可用账号：请先在控制台添加账号，或配置 upstream.ak/sk');
    e.code = 'no_credentials';
    throw e;
  }
  const { base, chatPath, region } = resolveUpstream(cfg, creds.account);
  const url = base + chatPath;
  const upstreamBody = buildUpstreamBody(body, { stream: !!body?.stream, account: creds.account });
  const bodyText = JSON.stringify(upstreamBody);
  // 上游按「这个账号自己模型表里的写法」路由，不能拿全局目录的 id 硬套
  const mh = upstreamModelHeaders(creds.account, upstreamBody.model ?? body?.model);
  const { headers } = buildUpstreamHeaders({
    cfg,
    account: creds.account ?? null,
    model: mh.modelId,
    modelName: mh.modelName,
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
  // 响应头到手的时间就是非流式场景下的「首字节 / 首字」时间：
  // transport.request 在收到 response 事件时就 resolve，body 是后面再读的。
  const headersAt = Date.now();

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
      firstByteAt: headersAt,
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
    firstByteAt: headersAt,
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
  const creds = credentials ?? pickCredentials({ ctx, panel, cfg, model: body?.model });
  if (!creds) {
    const e = new Error('没有可用账号：请先在控制台添加账号，或配置 upstream.ak/sk');
    e.code = 'no_credentials';
    throw e;
  }
  const { base, chatPath, region } = resolveUpstream(cfg, creds.account);
  const url = base + chatPath;
  const upstreamBody = buildUpstreamBody(body, { stream: true, account: creds.account });
  const bodyText = JSON.stringify(upstreamBody);
  const mh = upstreamModelHeaders(creds.account, upstreamBody.model ?? body?.model);
  const { headers } = buildUpstreamHeaders({
    cfg,
    account: creds.account ?? null,
    model: mh.modelId,
    modelName: mh.modelName,
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
  // 响应头到手 = 上游已经开始回字节，作为首字计时的起点之一
  const headersAt = Date.now();

  if (resp.status !== 200 || !resp.stream) {
    const buf = await resp.buffer(cfg.stealth?.maxResponseBytes).catch(() => Buffer.alloc(0));
    const text = buf.toString('utf8');
    // 上游业务错误：HTTP 200 + JSON（不是 SSE），必须翻成真实状态码，
    // 否则客户端会收到一个「200 但没有内容」的流
    const biz = detectUpstreamBizError(resp.status, buf);
    if (biz) {
      return { status: biz.status, errorText: text, account: creds.account, region, headers: resp.headers, bizError: biz, firstByteAt: headersAt };
    }
    return { status: resp.status, errorText: text, account: creds.account, region, headers: resp.headers, firstByteAt: headersAt };
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
  // 首字延迟（TTFT）的计时点：
  //   headersAt = 上游响应头到达的时间（连接+排队+上游预处理的耗时）
  //   firstTokenAt = 第一条真正带内容的增量到达的时间
  // 两个都留着，面板里能区分「上游慢」和「上游一直在思考才吐字」。
  const firstTokenAt = { at: null };
  // 上游不给 usage 时的本地兜底：从 SSE 内容里数出来
  let outChars = 0;
  let outCjk = 0; // 其中中日韩字符数（token 权重更高）
  let outChunks = 0;
  let sawUsage = false;
  // 流里夹带的业务错误（HTTP 200 但内容报错，如模型未注册）
  let streamBizError = null;

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
    // 上游发的是 `data:{...}`（冒号后无空格），标准 SSE 是 `data: {...}`。
    // 只认带空格的那种会把所有 chunk 都跳过，usage 永远是 0。
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const j = JSON.parse(payload);

      // 流式响应里也可能夹着业务错误。实测上游对未注册的模型返回：
      //   data:{"text":"[DONE]","error_code":"InferHub.002002009.404",
      //         "error_msg":"The model is not registered, please request other model"}
      // HTTP 状态还是 200，没有 choices。以前这种被当成正常数据转发，
      // 流水记成 200 + in=3090 + out=0，看着像成功其实一个字都没生成。
      if (j.error_code != null && j.error_code !== '' && j.error_code !== '0' && j.error_code !== '0000') {
        if (!(Array.isArray(j.choices) && j.choices.length)) {
          streamBizError = {
            code: String(j.error_code),
            message: String(j.error_msg ?? j.message ?? '').slice(0, 300),
          };
          return;
        }
      }

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
      // 第一条带内容的增量 = 首字。空的 role 增量不算 ——
      // 上游经常先发一个 {"delta":{"role":"assistant"}} 就把计时骗过去了。
      if (
        firstTokenAt.at == null &&
        ((typeof d.content === 'string' && d.content) ||
          (typeof d.reasoning_content === 'string' && d.reasoning_content) ||
          (Array.isArray(tc) && tc.length))
      ) {
        firstTokenAt.at = Date.now();
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
  //
  // 原来的条件是 `!usage && outChars > 0`，导致「上游没发 usage chunk 且
  // 一个 delta 都没收到」时两边都不成立，usage 保持 null，流水里就是
  // in=0 out=0 —— 看着像没记录，其实是没数据。
  //
  // 现在只要没拿到 usage 就估算：输入 token 总能从请求体算出来，
  // 输出拿不到就如实记 0，并带上 _noUsageChunk 标记说明上游没发 usage。
  let estimated = false;
  if (!usage) {
    estimated = true;
    // CJK 约 1 token/字，其余约 3 字符/token
    const completionTokens = outChars > 0 ? Math.ceil(outCjk + (outChars - outCjk) / 3) : 0;
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
      // 上游整段响应里没有 usage chunk —— 这才是 in=0/out=0 的真正来源
      _noUsageChunk: !sawUsage,
    };
  }

  if (onUsage) {
    onUsage({
      usage,
      account: creds.account,
      region,
      model: body?.model,
      estimated,
      // 流里夹带的业务错误：上游 HTTP 200 但内容报错，一个 token 都没生成
      bizError: streamBizError,
      // 计时：响应头到达 / 第一条内容到达（都是绝对毫秒时间戳）
      firstByteAt: headersAt,
      firstTokenAt: firstTokenAt.at,
    });
  }
  return { status: 200, account: creds.account, region, usage, estimated, bizError: streamBizError, firstByteAt: headersAt, firstTokenAt: firstTokenAt.at };
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

/* ============================ OpenAI Responses API ============================
 * POST /v1/responses 是 OpenAI 新推的接口，和 chat/completions 的差别：
 *
 *   请求：
 *     { model, input, instructions?, max_output_tokens?, stream? }
 *     input 可以是字符串，也可以是数组：
 *       [{ role:'user', content:'hi' }]
 *       [{ role:'user', content:[{type:'input_text', text:'hi'}] }]
 *       [{ type:'function_call_output', call_id, output }]
 *     工具用扁平的 { type:'function', name, description, parameters }，
 *     不是 chat 的 { type:'function', function:{...} }。
 *
 *   响应：
 *     { id, object:'response', status:'completed', output:[...],
 *       output_text: '拼好的文本', usage:{ input_tokens, output_tokens, ... } }
 *     output 里是 item 数组：message（内含 output_text 块）/ function_call。
 *
 * 上游只认 chat/completions，所以这里做双向转换。
 * ========================================================================== */

/** 把 Responses 的 content 数组拍平成纯文本 */
function responsesContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (typeof b === 'string') out.push(b);
    // input_text / output_text / text 都是文本块
    else if (b?.type === 'input_text' || b?.type === 'output_text' || b?.type === 'text') {
      out.push(b.text ?? '');
    } else if (b?.type === 'refusal') {
      out.push(b.refusal ?? '');
    }
    // input_image 等非文本块上游不支持，直接丢
  }
  return out.filter(Boolean).join('\n');
}

/**
 * Responses 请求 → chat/completions 请求
 * @param {object} body POST /v1/responses 的 body
 */
export function responsesToOpenAI(body) {
  const messages = [];

  // instructions 等价于 system
  const inst = body?.instructions;
  if (typeof inst === 'string' && inst.trim()) messages.push({ role: 'system', content: inst });

  const input = body?.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const type = item.type;

      // 工具调用结果 → role:tool
      if (type === 'function_call_output') {
        const out = item.output;
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof out === 'string' ? out : JSON.stringify(out ?? ''),
        });
        continue;
      }

      // 上一轮模型发起的工具调用 → assistant.tool_calls
      if (type === 'function_call') {
        const last = messages[messages.length - 1];
        const call = {
          id: item.call_id ?? item.id,
          type: 'function',
          function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
        };
        if (last?.role === 'assistant') {
          (last.tool_calls ??= []).push(call);
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        }
        continue;
      }

      // 普通消息（role 可能是 user / assistant / system / developer）
      const role = item.role === 'developer' ? 'system' : (item.role ?? 'user');
      const text = responsesContentToText(item.content);
      if (text) messages.push({ role, content: text });
    }
  }

  // 工具：Responses 是扁平结构，chat 要套一层 function
  const tools = (body?.tools ?? [])
    .filter((t) => t?.type === 'function' && t?.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));

  // max_output_tokens → max_tokens
  const maxTokens = body?.max_output_tokens ?? body?.max_tokens;

  return {
    model: body?.model,
    messages,
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    stream: !!body?.stream,
    ...(tools.length ? { tools, tool_choice: body?.tool_choice ?? 'auto' } : {}),
    ...(body?.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body?.top_p !== undefined ? { top_p: body.top_p } : {}),
    // Responses 的 text.format 对应 chat 的 response_format
    ...(body?.text?.format ? { response_format: body.text.format } : {}),
  };
}

/**
 * chat/completions 响应 → Responses 响应
 * @param {object} json 上游返回的 chat completion
 * @param {object} [req] 原始 Responses 请求（取 model / 工具名映射）
 */
export function openAIToResponses(json, req = {}) {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const output = [];

  // 推理模型的思维链。kimi-k3 / deepseek 这类会先把内容写进
  // reasoning_content，content 才是最终回答。上游两个字段都可能在，
  // 不能只读 content —— 小 max_tokens 时模型可能全花在思维链上，
  // 只读 content 会得到空串。
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  if (reasoning) {
    output.push({
      id: `rs_${json?.id ?? Date.now()}`,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }

  const text = typeof msg.content === 'string' ? msg.content : responsesContentToText(msg.content);
  if (text) {
    output.push({
      id: `msg_${json?.id ?? Date.now()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  for (const tc of msg.tool_calls ?? []) {
    output.push({
      id: `fc_${tc.id ?? Date.now()}`,
      type: 'function_call',
      status: 'completed',
      call_id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments ?? '{}',
    });
  }

  // 上游啥都没给：补一个空文本块，保证 output 非空（客户端普遍假设至少一项）
  if (!output.length) {
    output.push({
      id: `msg_${json?.id ?? Date.now()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  const u = json?.usage ?? {};
  const inputTokens = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? u.output_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = u.completion_tokens_details?.reasoning_tokens ?? 0;

  return {
    id: `resp_${json?.id ?? Date.now()}`,
    object: 'response',
    created_at: json?.created ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    model: json?.model ?? req?.model ?? 'unknown',
    // 拼好的纯文本，SDK 的 output_text 便捷属性就取这个
    // （只算 message 项，思维链不算回答正文）
    output_text: output
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content)
      .map((c) => c.text ?? '')
      .join(''),
    output,
    parallel_tool_calls: true,
    tool_choice: req?.tool_choice ?? 'auto',
    tools: (req?.tools ?? []).filter((t) => t?.type === 'function'),
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: cached },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: u.total_tokens ?? inputTokens + outputTokens,
    },
    ...(choice?.finish_reason ? { incomplete_details: null } : {}),
  };
}

/** Responses 的 SSE 事件名 → 需要发出的事件序列（流式用） */
export function responsesStreamEvents({ responseId, model, text, reasoning, usage }) {
  const seq = [];
  const base = { response_id: responseId, model };
  const rsId = `rs_${responseId}`;
  const msgId = `msg_${responseId}`;
  seq.push({ event: 'response.created', data: { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', model } } });
  seq.push({ event: 'response.in_progress', data: { type: 'response.in_progress', response: { id: responseId, object: 'response', status: 'in_progress', model } } });

  // 思维链先发（推理模型的顺序就是这样：先 reasoning，再 content）
  if (reasoning) {
    seq.push({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: rsId, type: 'reasoning', status: 'in_progress', summary: [] },
      },
    });
    seq.push({
      event: 'response.reasoning_summary_part.added',
      data: { type: 'response.reasoning_summary_part.added', item_id: rsId, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    });
    seq.push({
      event: 'response.reasoning_summary_text.delta',
      data: { type: 'response.reasoning_summary_text.delta', item_id: rsId, output_index: 0, summary_index: 0, delta: reasoning },
    });
    seq.push({
      event: 'response.reasoning_summary_text.done',
      data: { type: 'response.reasoning_summary_text.done', item_id: rsId, output_index: 0, summary_index: 0, text: reasoning },
    });
    seq.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: rsId, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: reasoning }] },
      },
    });
  }

  const textIndex = reasoning ? 1 : 0;
  if (text) {
    seq.push({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: textIndex,
        item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      },
    });
    seq.push({
      event: 'response.content_part.added',
      data: { type: 'response.content_part.added', item_id: msgId, output_index: textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    });
    seq.push({
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', item_id: msgId, output_index: textIndex, content_index: 0, delta: text },
    });
    seq.push({
      event: 'response.output_text.done',
      data: { type: 'response.output_text.done', item_id: msgId, output_index: textIndex, content_index: 0, text },
    });
    seq.push({
      event: 'response.content_part.done',
      data: { type: 'response.content_part.done', item_id: msgId, output_index: textIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } },
    });
    seq.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: textIndex,
        item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
      },
    });
  }

  // 完成事件里也带上 output，方便只读 completed 的客户端
  const finalOutput = [];
  if (reasoning) finalOutput.push({ id: rsId, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: reasoning }] });
  if (text) finalOutput.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  if (!finalOutput.length) {
    finalOutput.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] });
  }

  seq.push({
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        status: 'completed',
        model,
        output_text: text ?? '',
        output: finalOutput,
        usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    },
  });
  return seq.map((e) => ({ ...e, data: { ...base, ...e.data } }));
}
