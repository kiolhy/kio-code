// 账号信息探测：可用模型 / 每模型积分（credit） / 剩余积分余额
//
// 端点来自反编译还原（docs/codearts-reverse-engineering.md §6 §7.1）：
//   GET  {benefit}/api/v1/user/tokens/balance     剩余 token / 积分余额
//   GET  {benefit}/api/v1/gateway/config          { endpoint, models[] }  免费权益模型
//   POST {benefit}/api/v1/benefit/claim           权益领取
//   GET  {agent-center}/v1/agent-center/agents/useragents?offset=0&limit=100  → agent_id
//   GET  {agent-center}/v1/agent-center/agents/detail?agent_id=<id>
//        → data.gpts.models[] = { id, credit, limit, reasoning, enable_queue, variants_key }
//
// 鉴权：SDK-HMAC-SHA256（lib/sign.mjs）+ X-Security-Token（STS 临时 token）+ app-id
// 各服务的域名不同且会随环境变化，所以这里按候选列表逐个试，能通的就记下来。
import { signRequest } from './sign.mjs';
import { getTransport } from './transport.mjs';

export const ACCOUNT_INFO_DEFAULTS = {
  bases: [
    'https://opengw.developer.huaweicloud.com',
    'https://snapengine-apig.cn-north-7.myhuaweicloud.com',
    'https://snap-access.cn-north-4.myhuaweicloud.com',
  ],
  balancePath: '/api/v1/user/tokens/balance',
  gatewayConfigPath: '/api/v1/gateway/config',
  claimPath: '/api/v1/benefit/claim',
  userAgentsPath: '/v1/agent-center/agents/useragents?offset=0&limit=100',
  agentDetailPath: '/v1/agent-center/agents/detail?agent_id=',
  appId: 'CodeAgent3.0',
  codeAgentId: 'a8bcb36232554267a5142361cc25a393',
  timeoutMs: 20000,
};

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

/** 在任意 JSON 里找「像余额/积分」的数值字段 */
export function pickBalance(json) {
  const out = {};
  const want = /(balance|remain|left|avail|credit|point|quota|total|used|free|limit)/i;
  const skip = /(expire|time|date|id|count|version|code|status|ms|seconds)/i;
  const walk = (node, path = '', depth = 0) => {
    if (!node || depth > 6 || Object.keys(out).length > 60) return;
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      const n = num(v);
      if (n != null && want.test(k) && !skip.test(k)) out[p] = n;
      else walk(v, p, depth + 1);
    }
  };
  walk(json);
  return out;
}

/** 在任意 JSON 里找模型数组，抽出 id / credit / limit / 免费标记 */
export function pickModels(json) {
  const found = [];
  const seen = new Set();
  const walk = (node, depth = 0) => {
    if (!node || depth > 7) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const id = item.id ?? item.model ?? item.model_id ?? item.name ?? item.modelId;
          if (typeof id === 'string' && id.length > 0 && id.length < 120) {
            const m = {
              id,
              credit: num(item.credit ?? item.credits ?? item.price ?? item.cost ?? item.point ?? item.points ?? item.unit_price),
              limit: num(item.limit ?? item.max_tokens ?? item.quota ?? item.token_limit),
              free: item.is_free_benefit === true || item.free === true || item.maas_type === 'benefit' || item.isFree === true,
              queued: item.enable_queue === true,
              reasoning: item.reasoning === true,
              endpoint: typeof item.endpoint === 'string' ? item.endpoint : (typeof item.url === 'string' ? item.url : null),
              vendor: typeof item.provider === 'string' ? item.provider : (typeof item.vendor === 'string' ? item.vendor : null),
            };
            const key = `${m.id}|${m.credit ?? ''}|${m.limit ?? ''}`;
            if (!seen.has(key)) {
              seen.add(key);
              found.push(m);
            }
          }
        }
        walk(item, depth + 1);
      }
      return;
    }
    if (typeof node === 'object') for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(json);
  return found;
}

/** 余额合计：优先用「剩余类」字段，避免把 total+used+remain 加在一起 */
export function balanceTotalOf(balance) {
  if (!balance) return null;
  const prefer = Object.entries(balance).filter(([k]) => /(remain|left|avail|balance|credit|point|free)/i.test(k));
  const src = prefer.length ? prefer : Object.entries(balance);
  if (!src.length) return null;
  return src.reduce((a, [, v]) => a + (typeof v === 'number' ? v : 0), 0);
}

export function createAccountInfo({ cfg = {}, log = () => {} } = {}) {
  const o = { ...ACCOUNT_INFO_DEFAULTS, ...(cfg.accountInfo ?? {}) };
  const transport = getTransport({});
  const proxy = cfg.oauth?.proxy || cfg.github?.proxy || '';

  async function signedCall(account, base, path, { method = 'GET', body = '' } = {}) {
    const url = base + path;
    const headers = {
      'content-type': 'application/json',
      'x-security-token': account.securityToken ?? '',
      'app-id': o.appId,
    };
    const signed = signRequest({
      method,
      url,
      headers,
      body,
      ak: account.accessKeyId,
      sk: account.secretAccessKey,
    });
    const r = await transport.request({
      url,
      method,
      headers: signed.headers,
      body: method === 'GET' ? undefined : body,
      proxy,
      timeoutMs: o.timeoutMs,
    });
    const text = (await r.buffer()).toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON，比如网关错误页 */
    }
    return { status: r.status, json, text: text.slice(0, 2000) };
  }

  /** 探测一个账号：返回 { balance, models, sources, errors, raw } */
  async function probe(account) {
    if (!account?.accessKeyId || !account?.secretAccessKey) {
      const e = new Error('账号缺少 AK/SK，无法探测');
      e.code = 'no_credential';
      throw e;
    }
    const startedAt = Date.now();
    const errors = [];
    const sources = {};
    const raw = {};
    let balance = null;
    let models = [];

    // 1) 余额
    for (const base of o.bases) {
      try {
        const r = await signedCall(account, base, o.balancePath);
        if (r.status >= 200 && r.status < 300) {
          balance = pickBalance(r.json);
          sources.balance = base + o.balancePath;
          raw.balance = r.json ?? r.text;
          break;
        }
        errors.push(`balance ${base} → HTTP ${r.status} ${r.text.slice(0, 120)}`);
      } catch (e) {
        errors.push(`balance ${base} → ${e?.message ?? e}`);
      }
    }

    // 2) 免费权益模型（gateway config）
    for (const base of o.bases) {
      try {
        const r = await signedCall(account, base, o.gatewayConfigPath);
        if (r.status >= 200 && r.status < 300) {
          const list = pickModels(r.json);
          sources.gatewayConfig = base + o.gatewayConfigPath;
          raw.gatewayConfig = r.json ?? r.text;
          if (list.length) {
            models = list.map((m) => ({ ...m, free: true }));
            break;
          }
        } else {
          errors.push(`gateway/config ${base} → HTTP ${r.status} ${r.text.slice(0, 120)}`);
        }
      } catch (e) {
        errors.push(`gateway/config ${base} → ${e?.message ?? e}`);
      }
    }

    // 3) agent-center 详情里的模型（带 credit / limit）
    for (const base of o.bases) {
      try {
        const ua = await signedCall(account, base, o.userAgentsPath);
        if (ua.status < 200 || ua.status >= 300) {
          errors.push(`useragents ${base} → HTTP ${ua.status} ${ua.text.slice(0, 120)}`);
          continue;
        }
        const arr = Array.isArray(ua.json) ? ua.json : (ua.json?.data ?? ua.json?.agents ?? []);
        const hit = (Array.isArray(arr) ? arr : []).find((a) => {
          const ids = [a?.agent_id, a?.original_id, a?.id, a?.agentId].filter(Boolean).map(String);
          return ids.includes(o.codeAgentId) || ids.length > 0;
        });
        const agentId = hit?.agent_id ?? hit?.original_id ?? hit?.id ?? o.codeAgentId;
        const det = await signedCall(account, base, o.agentDetailPath + encodeURIComponent(String(agentId)));
        if (det.status >= 200 && det.status < 300) {
          const list = pickModels(det.json);
          if (list.length) {
            sources.agentDetail = `${base}${o.agentDetailPath}${agentId}`;
            raw.agentDetail = det.json ?? det.text;
            // 合并：同 id 以 agent-center 的 credit 为准
            const byId = new Map(models.map((m) => [m.id, m]));
            for (const m of list) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
            models = [...byId.values()];
            break;
          }
        } else {
          errors.push(`agent/detail ${base} → HTTP ${det.status} ${det.text.slice(0, 120)}`);
        }
      } catch (e) {
        errors.push(`agent-center ${base} → ${e?.message ?? e}`);
      }
    }

    const info = {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      balance,
      balanceTotal: balanceTotalOf(balance),
      models,
      modelCount: models.length,
      sources,
      errors: errors.slice(0, 12),
      ok: !!(balance || models.length),
    };
    log('info', `账号信息探测 ${account.id}：模型 ${info.modelCount} 个，余额字段 ${balance ? Object.keys(balance).length : 0} 个，耗时 ${info.durationMs}ms`);
    return info;
  }

  return { probe, bases: o.bases };
}
