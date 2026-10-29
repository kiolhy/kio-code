// 账号信息探测：可用模型 / 每模型积分（credit） / 剩余积分余额
//
// 端点来自反编译还原（docs/codearts-reverse-engineering.md §6 §7.1）：
//   GET  {benefit}/api/v1/user/tokens/balance     剩余 token / 积分余额
//   GET  {benefit}/api/v1/gateway/config          { endpoint, models[] | models{} }  免费权益模型
//   POST {benefit}/api/v1/benefit/claim           权益领取
//   GET  {agent-center}/v1/agent-center/agents/useragents?offset=0&limit=100  → agent_id
//   GET  {agent-center}/v1/agent-center/agents/detail?agent_id=<id>
//        → data.gpts.models[] = { id, credit, limit, reasoning, enable_queue, variants_key }
//
// 鉴权：SDK-HMAC-SHA256（lib/sign.mjs）+ X-Security-Token（STS 临时 token）+ app-id
// agent-center 还要 Agent-Type: AgentCenter（缺了会 400 请求头Agent-Type为空）
//
// 解析策略：先按已知字段名认，认不出就把所有数字叶子摊平成 numbers 兜底——
// 上游字段名变了也还能看到值，不至于「200 但一片空白」。
import { signRequest } from './sign.mjs';
import { getTransport } from './transport.mjs';

export const ACCOUNT_INFO_DEFAULTS = {
  // 默认只放实测能通的；其它域名可在 config.json 里补
  bases: [
    'https://opengw.developer.huaweicloud.com',
    'https://snap-access.cn-north-4.myhuaweicloud.com',
  ],
  balancePath: '/api/v1/user/tokens/balance',
  gatewayConfigPath: '/api/v1/gateway/config',
  claimPath: '/api/v1/benefit/claim',
  userAgentsPath: '/v1/agent-center/agents/useragents?offset=0&limit=100',
  agentDetailPath: '/v1/agent-center/agents/detail?agent_id=',
  appId: 'CodeAgent3.0',
  agentType: 'AgentCenter',
  clientType: 'DevMate',
  codeAgentId: 'a8bcb36232554267a5142361cc25a393',
  timeoutMs: 20000,
  rawLimit: 6000,
  numbersLimit: 80,
};

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

const MODEL_KEYS = ['id', 'model', 'model_id', 'modelId', 'name', 'model_name'];
const PRICE_KEYS = ['credit', 'credits', 'price', 'cost', 'point', 'points', 'unit_price', 'unitPrice'];
const LIMIT_KEYS = ['limit', 'max_tokens', 'maxTokens', 'quota', 'token_limit', 'tokenLimit', 'context_length'];

const firstOf = (obj, keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
};

function toModel(id, obj, extra = {}) {
  if (typeof id !== 'string' || !id || id.length > 120) return null;
  const o = obj && typeof obj === 'object' ? obj : {};
  return {
    id,
    credit: num(firstOf(o, PRICE_KEYS)),
    limit: num(firstOf(o, LIMIT_KEYS)),
    free: o.is_free_benefit === true || o.free === true || o.maas_type === 'benefit' || o.isFree === true,
    queued: o.enable_queue === true || o.enableQueue === true,
    reasoning: o.reasoning === true,
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : (typeof o.url === 'string' ? o.url : null),
    vendor: typeof o.provider === 'string' ? o.provider : (typeof o.vendor === 'string' ? o.vendor : null),
    ...extra,
  };
}

/**
 * 在任意 JSON 里找模型清单。
 * 支持三种形状：
 *   [{ id, credit }]                      数组
 *   { models: { "glm-4.6": { credit } } } 对象 map（benefit 网关就是这种，键名即模型 id）
 *   ["glm-4.6", "kimi-k2"]                纯字符串数组
 */
export function pickModels(json) {
  const found = [];
  const seen = new Set();
  const push = (m) => {
    if (!m) return;
    const key = `${m.id}|${m.credit ?? ''}|${m.limit ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(m);
  };

  const walk = (node, depth = 0) => {
    if (!node || depth > 7) return;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string') push(toModel(item, null));
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const id = firstOf(item, MODEL_KEYS);
          if (typeof id === 'string') push(toModel(id, item));
          else walk(item, depth + 1);
        } else walk(item, depth + 1);
      }
      return;
    }

    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        // 对象 map：键是模型 id，值是这个模型的描述
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const looksLikeModel =
            firstOf(v, PRICE_KEYS) !== undefined ||
            firstOf(v, LIMIT_KEYS) !== undefined ||
            v.endpoint !== undefined ||
            v.url !== undefined ||
            v.reasoning !== undefined;
          if (looksLikeModel && /^[A-Za-z0-9._:/-]{2,120}$/.test(k)) {
            push(toModel(k, v));
            continue;
          }
        }
        walk(v, depth + 1);
      }
    }
  };

  walk(json);
  return found;
}

const BALANCE_WANT = /(balance|remain|left|avail|rest|surplus|credit|point|quota|total|used|free|limit|amount|count)/i;
const BALANCE_SKIP = /(expire|time|date|timestamp|version|ms|seconds|status|code|id$|Id$|_id)/i;

/** 在任意 JSON 里找「像余额/积分」的数值字段 */
export function pickBalance(json) {
  const out = {};
  const walk = (node, path = '', depth = 0) => {
    if (!node || depth > 6 || Object.keys(out).length > 60) return;
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      const n = num(v);
      if (n != null && BALANCE_WANT.test(k) && !BALANCE_SKIP.test(k)) out[p] = n;
      else walk(v, p, depth + 1);
    }
  };
  walk(json);
  return out;
}

/** 兜底：把所有数字叶子摊平（字段名不认识时至少还能看到值） */
export function collectNumbers(json, limit = 80) {
  const out = [];
  const walk = (node, path = '', depth = 0) => {
    if (!node || depth > 7 || out.length >= limit) return;
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (out.length >= limit) return;
      const p = path ? `${path}.${k}` : k;
      const n = num(v);
      if (n != null) out.push({ path: p, value: n });
      else walk(v, p, depth + 1);
    }
  };
  walk(json);
  return out;
}

/** 余额合计：优先 remain 类字段，其次从 numbers 里挑，再不行返回 null */
export function balanceTotalOf(balance, numbers = []) {
  const prefer = (o) => {
    const hit = Object.entries(o).filter(([k]) => /(remain|left|avail|rest|surplus|balance|credit|point|free)/i.test(k));
    return hit.length ? hit : [];
  };
  if (balance && Object.keys(balance).length) {
    const hit = prefer(balance);
    const src = hit.length ? hit : Object.entries(balance);
    return src.reduce((a, [, v]) => a + (typeof v === 'number' ? v : 0), 0);
  }
  const fromNumbers = numbers.filter((x) => /(remain|left|avail|balance|credit|point)/i.test(x.path));
  if (fromNumbers.length) return fromNumbers.reduce((a, x) => a + x.value, 0);
  return null;
}

const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : s);

export function createAccountInfo({ cfg = {}, log = () => {} } = {}) {
  const o = { ...ACCOUNT_INFO_DEFAULTS, ...(cfg.accountInfo ?? {}) };
  const transport = getTransport({});
  const proxy = cfg.oauth?.proxy || cfg.github?.proxy || '';

  function headersFor(account, kind) {
    const h = {
      'content-type': 'application/json',
      'x-security-token': account.securityToken ?? '',
      'app-id': o.appId,
    };
    if (kind === 'agent') {
      h['agent-type'] = o.agentType;
      h['x-client-type'] = o.clientType;
      const who = account.userName || account.userId || account.domainId;
      if (who) h['x-current-user'] = String(who);
    }
    return h;
  }

  async function signedCall(account, base, path, { method = 'GET', body = '', kind = 'benefit' } = {}) {
    const url = base + path;
    const headers = headersFor(account, kind);
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
    return { status: r.status, json, text };
  }

  /** 探测一个账号 */
  async function probe(account) {
    if (!account?.accessKeyId || !account?.secretAccessKey) {
      const e = new Error('账号缺少 AK/SK，无法探测');
      e.code = 'no_credential';
      throw e;
    }
    const startedAt = Date.now();
    const byBase = new Map(); // base -> [失败描述]
    const sources = {};
    const raw = {};
    const note = (base, ep, msg) => {
      const list = byBase.get(base) ?? [];
      list.push(`${ep} ${clip(String(msg ?? ''), 110)}`);
      byBase.set(base, list);
    };

    let balance = null;
    let numbers = [];
    let models = [];

    // 1) 余额
    for (const base of o.bases) {
      try {
        const r = await signedCall(account, base, o.balancePath);
        if (r.status >= 200 && r.status < 300) {
          balance = pickBalance(r.json);
          numbers = collectNumbers(r.json, o.numbersLimit);
          sources.balance = base + o.balancePath;
          raw.balance = clip(r.json ? JSON.stringify(r.json) : r.text, o.rawLimit);
          break;
        }
        note(base, 'balance', `HTTP ${r.status} ${clip(r.text, 90)}`);
      } catch (e) {
        note(base, 'balance', e?.message ?? e);
      }
    }

    // 2) 免费权益模型（gateway config）——数组或对象 map 都吃
    for (const base of o.bases) {
      try {
        const r = await signedCall(account, base, o.gatewayConfigPath);
        if (r.status >= 200 && r.status < 300) {
          const list = pickModels(r.json);
          sources.gatewayConfig = base + o.gatewayConfigPath;
          raw.gatewayConfig = clip(r.json ? JSON.stringify(r.json) : r.text, o.rawLimit);
          if (!numbers.length) numbers = collectNumbers(r.json, o.numbersLimit);
          if (list.length) {
            models = list.map((m) => ({ ...m, free: true }));
            break;
          }
        } else {
          note(base, 'gateway/config', `HTTP ${r.status} ${clip(r.text, 90)}`);
        }
      } catch (e) {
        note(base, 'gateway/config', e?.message ?? e);
      }
    }

    // 3) agent-center：useragents → detail（带 credit / limit）
    for (const base of o.bases) {
      try {
        const ua = await signedCall(account, base, o.userAgentsPath, { kind: 'agent' });
        if (ua.status < 200 || ua.status >= 300) {
          note(base, 'useragents', `HTTP ${ua.status} ${clip(ua.text, 90)}`);
          continue;
        }
        const arr = Array.isArray(ua.json) ? ua.json : (ua.json?.data ?? ua.json?.agents ?? []);
        const list = Array.isArray(arr) ? arr : [];
        const hit = list.find((a) => {
          const ids = [a?.agent_id, a?.original_id, a?.id, a?.agentId].filter(Boolean).map(String);
          return ids.includes(o.codeAgentId);
        }) ?? list[0];
        const agentId = hit?.agent_id ?? hit?.original_id ?? hit?.id ?? o.codeAgentId;
        const det = await signedCall(account, base, o.agentDetailPath + encodeURIComponent(String(agentId)), { kind: 'agent' });
        if (det.status >= 200 && det.status < 300) {
          const got = pickModels(det.json);
          if (got.length) {
            sources.agentDetail = `${base}${o.agentDetailPath}${agentId}`;
            raw.agentDetail = clip(det.json ? JSON.stringify(det.json) : det.text, o.rawLimit);
            const byId = new Map(models.map((m) => [m.id, m]));
            for (const m of got) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
            models = [...byId.values()];
            break;
          }
        } else {
          note(base, 'agent/detail', `HTTP ${det.status} ${clip(det.text, 90)}`);
        }
      } catch (e) {
        note(base, 'agent-center', e?.message ?? e);
      }
    }

    const errors = [];
    for (const [base, list] of byBase) {
      if (!list.length) continue;
      errors.push(list.length === 1 ? `${base} → ${list[0]}` : `${base} → ${list.length} 个端点失败：${list.join('；')}`);
    }

    const info = {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      balance,
      balanceTotal: balanceTotalOf(balance, numbers),
      numbers,
      models,
      modelCount: models.length,
      sources,
      errors: errors.slice(0, 8),
      raw,
      ok: !!(balance || models.length || numbers.length),
    };
    log(
      'info',
      `账号信息探测 ${account.id}：模型 ${info.modelCount} 个，余额字段 ${balance ? Object.keys(balance).length : 0} 个，数字字段 ${numbers.length} 个，耗时 ${info.durationMs}ms`,
    );
    return info;
  }

  return { probe, bases: o.bases };
}
