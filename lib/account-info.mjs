// 账号信息探测：可用模型 / 每模型价格 / 剩余积分
//
// 全部走真实网络，端点与字段来自真实请求实测（2026-10-29）：
//
//   GET {snap-access}/snap-manager/v1/current/user
//       → { domain_id, domain_name, user_id, user_name }         账号身份
//
//   GET {snap-access}/v1/agent-center/agents/useragents?offset=0&limit=100
//       头：Agent-Type: AgentCenter、X-Language: zh-cn
//       → { total, agents: [{ agent_id, agent_name, ... }] }
//
//   GET {snap-access}/v1/agent-center/agents/detail?agent_id=<id>
//       头：同上
//       → { gpts: { models: [...] } }       注意：不是 data.gpts
//
// 模型条目真实结构：
//   {
//     model_name: "GLM-5.2",           ← 模型 id
//     model_alias: "glm-5.2",          ← 别名（API 里用的名字）
//     model_type: "admin",
//     model_parameters: {
//       max_tokens: 65536, context_window: 202752,
//       enable_queue: true, supports_prompt_cache: true,
//       usage_limit: 0, channel_source: "codearts"
//     },
//     credit: [                         ← 价格阶梯（数组）
//       { input_from: 0, input_to: -1, output_from: 0, output_to: -1,
//         input_price: "8", cache_price: "2", output_price: "28" }
//     ]
//   }
//
// 鉴权：SDK-HMAC-SHA256 签名（lib/sign.mjs）+ X-Security-Token（STS security_token）+ app-id
// 实测：x-auth-token 走不通（security_token 不是 IAM token，会 401 decrypt token fail）
//
// 余额/免费权益（{benefit}/api/v1/user/tokens/balance、/gateway/config）：
//   签名能过，但账号没有 benefit 套餐时返回 {"error_code":"4000","error_msg":"invalid channel, group not found"}
//   —— 这是业务状态，不是鉴权问题。有权益的账号会正常返回。
//
//   channel 参数必须带，真 CLI 就是这么调的：?channel=cli
//   不带 channel 时上游回 4000「invalid channel」—— 看起来像「没套餐」，
//   其实只是没告诉它走哪个计费通道。实测 y4ik 网页端有 9600 积分，
//   网关不带参数却报 4000，就是这个原因。
import { signRequest } from './sign.mjs';
import { getTransport } from './transport.mjs';

export const ACCOUNT_INFO_DEFAULTS = {
  snapAccess: 'https://snap-access.cn-north-4.myhuaweicloud.com',
  benefitBase: 'https://opengw.developer.huaweicloud.com',
  userPath: '/snap-manager/v1/current/user',
  userAgentsPath: '/v1/agent-center/agents/useragents?offset=0&limit=100',
  agentDetailPath: '/v1/agent-center/agents/detail?agent_id=',
  balancePath: '/api/v1/user/tokens/balance?channel=cli',
  gatewayConfigPath: '/api/v1/gateway/config?channel=cli',
  claimPath: '/api/v1/benefit/claim',
  appId: 'CodeAgent3.0',
  agentType: 'AgentCenter',
  language: 'zh-cn',
  codeAgentName: 'CodeAgent',
  timeoutMs: 20000,
  rawLimit: 6000,
};

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

/** 价格阶梯：credit[] → [{ inputFrom, inputTo, outputFrom, outputTo, input, cache, output }] */
export function parseCreditTiers(credit) {
  if (!Array.isArray(credit)) return [];
  return credit
    .map((c) => ({
      inputFrom: num(c?.input_from) ?? 0,
      inputTo: num(c?.input_to) ?? -1,
      outputFrom: num(c?.output_from) ?? 0,
      outputTo: num(c?.output_to) ?? -1,
      input: num(c?.input_price),
      cache: num(c?.cache_price),
      output: num(c?.output_price),
    }))
    .filter((t) => t.input != null || t.output != null);
}

/**
 * 从 agent detail 里抽模型清单（真实结构 gpts.models）
 *
 * 模型 id 取 model_parameters.model_id（CLI 的 eK() 就是这么取的），
 * 不是顶层 model_name —— model_name 是显示名。
 * @returns {Array} [{ id, name, alias, type, maxTokens, contextWindow, inputLength,
 *                     queue, promptCache, reasoning, usageLimit, channel, tiers, price }]
 */
export function parseModels(detail) {
  const raw = detail?.gpts?.models ?? detail?.data?.gpts?.models ?? [];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    const p = m?.model_parameters ?? {};
    // 上游认的 id 是 model_parameters.model_id。
    //
    // 实测三种账号形态：
    //   A（hid_9p1q7 域）：model_id='kimi-k3', model_name='Kimi-K3'
    //   B（CSDN 域）    ：model_id 缺失, model_name 缺失, model_alias='kimi-k3'
    //                     ↑ 只有 alias 是对的，id 位置放的是显示名
    //
    // 所以回落顺序是 model_id → model_alias，绝不回落 model_name
    // （那是显示名，上游不认，发过去会回
    //  InferHub.002002009.404「Route missed for model: Kimi-K3」）。
    const candId = p.model_id;
    const candAlias = m?.model_alias;
    const id =
      (typeof candId === 'string' && candId ? candId : null)
      ?? (typeof candAlias === 'string' && candAlias ? candAlias : null);
    if (!id) continue;
    const tiers = parseCreditTiers(m.credit);
    const first = tiers[0] ?? {};
    const isThird = m?.model_type === 'third';
    out.push({
      id,
      // 显示名只在 model_name 真的有值时才记；空就留空，
      // 让 upstreamModelHeaders 回落到 id（B 类账号根本没显示名）
      name: typeof m.model_name === 'string' && m.model_name ? m.model_name : null,
      alias: typeof m.model_alias === 'string' && m.model_alias ? m.model_alias : null,
      type: typeof m.model_type === 'string' ? m.model_type : null,
      // third 模型走第三方名
      variantsKey: isThird ? (p.third_party_model ?? id) : id,
      maxTokens: num(p.max_tokens),
      contextWindow: num(p.context_window),
      inputLength: num(p.input_length),
      queue: p.enable_queue === true,
      promptCache: p.supports_prompt_cache === true,
      reasoning: p.thinking_type != null,
      usageLimit: num(p.usage_limit),
      channel: typeof p.channel_source === 'string' ? p.channel_source : null,
      price: { input: first.input ?? null, cache: first.cache ?? null, output: first.output ?? null },
      tiers,
    });
  }
  return out;
}

/** 兜底：把任意 JSON 的数字叶子摊平 */
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

/** 余额字段识别（benefit 账号才有） */
export function pickBalance(json) {
  const out = {};
  // 先认已知的套餐结构（网页端 /portal/snap-manager/v1/package/overview 就是这种）：
  //   { all_credit_package:{package_credit_amount, package_credit_used, package_credit_remain},
  //     basic_package:{...}, bonus_credit_package:{...}, ondemand_credit_package:null }
  // 直接摊平成 all_credit_package.package_credit_remain 这种路径，
  // 比通用遍历更稳（不会被 expiring_credit_amount 之类的干扰）。
  const pkgKeys = ['all_credit_package', 'basic_package', 'bonus_credit_package', 'ondemand_credit_package'];
  for (const pk of pkgKeys) {
    const node = json?.[pk];
    if (!node || typeof node !== 'object') continue;
    for (const [k, v] of Object.entries(node)) {
      const n = num(v);
      if (n != null) out[`${pk}.${k}`] = n;
    }
  }
  if (Object.keys(out).length) return out;

  const want = /(balance|remain|left|avail|rest|surplus|credit|point|quota|total|used|amount|count)/i;
  const skip = /(expire|time|date|timestamp|version|status|code|_id|Id$)/i;
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

export function balanceTotalOf(balance, numbers = []) {
  if (balance && Object.keys(balance).length) {
    // 套餐结构里 all_credit_package 是总和，basic/bonus 是分项，
    // 直接全加会重复计算（9600 = 500 基础 + 9100 赠送）。
    // 有 all_credit_package.package_credit_remain 就只取它。
    const allRemain = balance['all_credit_package.package_credit_remain'];
    if (typeof allRemain === 'number') return allRemain;

    const hit = Object.entries(balance).filter(([k]) => /(remain|left|avail|rest|surplus|balance|credit|point)/i.test(k));
    const src = hit.length ? hit : Object.entries(balance);
    return src.reduce((a, [, v]) => a + (typeof v === 'number' ? v : 0), 0);
  }
  const fromNumbers = numbers.filter((x) => /(remain|left|avail|balance|credit|point)/i.test(x.path));
  if (fromNumbers.length) return fromNumbers.reduce((a, x) => a + x.value, 0);
  return null;
}

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
      h['x-language'] = o.language;
      const who = account.userName || account.userId;
      if (who) h['x-current-user'] = String(who);
    }
    // benefit 通道（余额 / 网关配置 / 领取权益）：
    // 上游靠 maas_type 决定走哪个计费通道，缺了它就算 channel=cli 也回
    // 4000「invalid channel, group not found」——看起来像没套餐，其实只是
    // 没告诉它走 benefit 通道。真实 CLI 的请求头里 maas_type=benefit。
    if (kind === 'benefit') {
      h['maas_type'] = 'benefit';
      h['agent-type'] = o.agentType;
      h['x-language'] = o.language;
      h['x-client-type'] = 'DevMate';
      h['x-referer'] = 'CodeBase';
      const who = account.userName || account.userId;
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
      /* 非 JSON */
    }
    return { status: r.status, json, text };
  }

  /**
   * 业务错误判定。
   * CLI 里的成功码是 "0000"（四个零），不是 "0" —— 见 bun_section 的 MG()：
   *   let m = d?.error_code === "0000";
   * 所以这里两种都算成功。
   */
  const bizError = (json) => {
    if (!json || json.error_code === undefined || json.error_code === null) return null;
    const code = String(json.error_code);
    if (code === '0' || code === '0000') return null;
    return json.error_msg ?? json.error_message ?? code;
  };

  /** benefit 业务错误码 → 人话（来自 CLI 内置文案表） */
  const BENEFIT_ERR = {
    balance: {
      '4000': '参数错误 / 无效 channel（该账号没有 benefit 套餐）',
      '4001': 'X-Auth-Token 缺失或无效',
      '4002': 'X-Auth-Token 过期',
      '4004': 'benefit not found / user not found（账号没有免费权益）',
      '5000': 'internal error',
    },
    config: {
      '4000': '参数错误 / invalid channel（该账号没有 benefit 套餐）',
      '4004': 'group not found（账号没有免费权益分组）',
      '5000': 'internal error',
    },
    claim: {
      '4000': '参数错误 / JSON 解析失败',
      '4001': 'X-Auth-Token 缺失或无效',
      '4002': 'X-Auth-Token 过期',
      '4003': '用户禁用',
      '4004': '权益不存在 / 已过期 / user 不存在',
      '4006': 'daily claim limit exhausted（每日名额耗尽）',
      '5000': 'internal error',
    },
  };

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

    let user = null;
    let agents = [];
    let models = [];
    let balance = null;
    let numbers = [];
    // benefit 套餐状态：{ enabled, endpoint, modelCount, code, message }
    let benefit = { enabled: false, endpoint: null, modelCount: 0, code: null, message: null };
    // 1) 账号身份
    try {
      const r = await signedCall(account, o.snapAccess, o.userPath, { kind: 'agent' });
      if (r.status >= 200 && r.status < 300 && r.json) {
        user = {
          domainId: r.json.domain_id ?? null,
          domainName: r.json.domain_name ?? null,
          userId: r.json.user_id ?? null,
          userName: r.json.user_name ?? null,
        };
        sources.user = o.snapAccess + o.userPath;
        raw.user = clip(JSON.stringify(r.json), o.rawLimit);
      } else {
        errors.push(`current/user → HTTP ${r.status} ${clip(r.text, 100)}`);
      }
    } catch (e) {
      errors.push(`current/user → ${e?.message ?? e}`);
    }

    // 2) 智能体列表
    let agentId = null;
    let agentTotal = 0;
    try {
      const r = await signedCall(account, o.snapAccess, o.userAgentsPath, { kind: 'agent' });
      if (r.status >= 200 && r.status < 300) {
        agents = Array.isArray(r.json?.agents) ? r.json.agents : [];
        // total 是真实总数，agents 只是当前页
        agentTotal = num(r.json?.total) ?? agents.length;
        sources.userAgents = o.snapAccess + o.userAgentsPath;
        raw.userAgents = clip(JSON.stringify({ total: r.json?.total, agents: agents.slice(0, 5) }), o.rawLimit);
        const pick =
          agents.find((a) => a?.agent_name === o.codeAgentName) ??
          agents.find((a) => a?.is_primary_agent === true) ??
          agents[0];
        agentId = pick?.agent_id ?? null;
      } else {
        errors.push(`useragents → HTTP ${r.status} ${clip(r.text, 100)}`);
      }
    } catch (e) {
      errors.push(`useragents → ${e?.message ?? e}`);
    }

    // 3) 智能体详情 → 模型 + 价格
    if (agentId) {
      try {
        const r = await signedCall(
          account,
          o.snapAccess,
          o.agentDetailPath + encodeURIComponent(agentId),
          { kind: 'agent' },
        );
        if (r.status >= 200 && r.status < 300) {
          models = parseModels(r.json);
          sources.agentDetail = `${o.snapAccess}${o.agentDetailPath}${agentId}`;
          raw.agentDetail = clip(JSON.stringify({ agent_id: agentId, models: (r.json?.gpts?.models ?? []).map((m) => ({ model_name: m.model_name, model_alias: m.model_alias, credit: m.credit, model_parameters: { max_tokens: m.model_parameters?.max_tokens, context_window: m.model_parameters?.context_window, enable_queue: m.model_parameters?.enable_queue, supports_prompt_cache: m.model_parameters?.supports_prompt_cache } })) }), o.rawLimit);
        } else {
          errors.push(`agent/detail → HTTP ${r.status} ${clip(r.text, 100)}`);
        }
      } catch (e) {
        errors.push(`agent/detail → ${e?.message ?? e}`);
      }
    }

    // 4) 余额 / 免费权益（benefit 套餐才有）
    try {
      const r = await signedCall(account, o.benefitBase, o.balancePath);
      const be = bizError(r.json);
      if (r.status >= 200 && r.status < 300 && !be) {
        balance = pickBalance(r.json);
        numbers = collectNumbers(r.json, 80);
        benefit.enabled = true;
        sources.balance = o.benefitBase + o.balancePath;
        raw.balance = clip(JSON.stringify(r.json), o.rawLimit);
      } else if (be) {
        const code = String(r.json?.error_code ?? '');
        const human = BENEFIT_ERR.balance[code] ?? be;
        benefit.code = code;
        benefit.message = human;
        // 没有 benefit 套餐是账号侧状态，不是错误 —— 不写进 errors，避免每次都报一条
        benefit.skipped = true;
        raw.balance = clip(JSON.stringify(r.json), o.rawLimit);
      } else {
        errors.push(`balance → HTTP ${r.status} ${clip(r.text, 100)}`);
      }
    } catch (e) {
      errors.push(`balance → ${e?.message ?? e}`);
    }

    // 5) 免费权益模型（gateway config）—— 真实结构：{ endpoint, models: [{ model_id, model_name, model_alias }] }
    try {
      const r = await signedCall(account, o.benefitBase, o.gatewayConfigPath);
      const be = bizError(r.json);
      if (r.status >= 200 && r.status < 300 && !be) {
        const data = r.json?.result ?? r.json?.data ?? r.json;
        const list = Array.isArray(data?.models) ? data.models : [];
        const benefitEndpoint = data?.endpoint ?? data?.base_url ?? null;
        benefit.enabled = true;
        benefit.endpoint = benefitEndpoint;
        sources.gatewayConfig = o.benefitBase + o.gatewayConfigPath;
        raw.gatewayConfig = clip(JSON.stringify(r.json), o.rawLimit);
        const benefitModels = list
          .map((m) => {
            // 同上：model_id → model_alias，绝不回落 model_name
            const candId = m?.model_id;
            const candAlias = m?.model_alias;
            const id =
              (typeof candId === 'string' && candId ? candId : null)
              ?? (typeof candAlias === 'string' && candAlias ? candAlias : null);
            if (!id) return null;
            return {
              id: String(id),
              name: typeof m?.model_name === 'string' && m.model_name ? m.model_name : null,
              alias: typeof candAlias === 'string' && candAlias ? candAlias : null,
              type: m?.model_type ?? null,
              maxTokens: num(m?.model_parameters?.max_tokens ?? m?.max_tokens),
              contextWindow: num(m?.model_parameters?.context_window ?? m?.context_window),
              queue: m?.model_parameters?.enable_queue === true || m?.enable_queue === true,
              promptCache: m?.model_parameters?.supports_prompt_cache === true || m?.supports_prompt_cache === true,
              usageLimit: num(m?.model_parameters?.usage_limit),
              channel: 'benefit',
              price: { input: null, cache: null, output: null },
              tiers: parseCreditTiers(m?.credit),
              endpoint: benefitEndpoint,
              free: true,
            };
          })
          .filter(Boolean);
        if (benefitModels.length) {
          benefit.modelCount = benefitModels.length;
          // 与 agent-center 的模型合并：同 id 以 agent-center（带价格）为准，benefit 独有的补进来
          const byId = new Map(models.map((m) => [m.id, m]));
          for (const m of benefitModels) {
            const cur = byId.get(m.id);
            byId.set(m.id, cur ? { ...m, ...cur, free: true, endpoint: cur.endpoint ?? m.endpoint } : m);
          }
          models = [...byId.values()];
        }
      } else if (be) {
        const code = String(r.json?.error_code ?? '');
        const human = BENEFIT_ERR.config[code] ?? be;
        if (!benefit.code) {
          benefit.code = code;
          benefit.message = human;
          benefit.skipped = true;
        }
        raw.gatewayConfig = clip(JSON.stringify(r.json), o.rawLimit);
      } else {
        errors.push(`gateway/config → HTTP ${r.status} ${clip(r.text, 100)}`);
      }
    } catch (e) {
      errors.push(`gateway/config → ${e?.message ?? e}`);
    }

    // 6) 领取免费权益（claim）
    // CLI 的 kjn() 逻辑：gateway config 有模型 → claim 成功 → 才能用 benefit 模型。
    // claim 本身不返回价格，它只是「解锁开关」，所以只在有 benefit 套餐时才调。
    if (benefit.enabled) {
      try {
        const r = await signedCall(account, o.benefitBase, o.claimPath, { method: 'POST', body: '{}' });
        const be = bizError(r.json);
        if (r.status >= 200 && r.status < 300 && !be) {
          benefit.claimed = true;
          benefit.claimResult = r.json?.result ?? null;
          sources.claim = o.benefitBase + o.claimPath;
          raw.claim = clip(JSON.stringify(r.json), o.rawLimit);
        } else if (be) {
          const code = String(r.json?.error_code ?? '');
          benefit.claimed = false;
          benefit.claimCode = code;
          benefit.claimMessage = BENEFIT_ERR.claim[code] ?? be;
          raw.claim = clip(JSON.stringify(r.json), o.rawLimit);
        }
      } catch (e) {
        benefit.claimMessage = String(e?.message ?? e);
      }
    }

    const info = {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      user,
      agentId,
      agentCount: agentTotal,
      agents: agents.slice(0, 20).map((a) => ({ id: a?.agent_id ?? null, name: a?.agent_name ?? null, primary: a?.is_primary_agent === true })),
      models,
      modelCount: models.length,
      balance,
      balanceTotal: balanceTotalOf(balance, numbers),
      numbers,
      benefit,
      sources,
      errors: errors.slice(0, 8),
      raw,
      ok: !!(models.length || user),
    };

    // 6) 模型可用性验证：模型表列出来 ≠ 上游真的认。
    //    实测某账号表里 8 个模型，实际只有 1 个能调通，其余全是
    //    InferHub.002002009.404。不验证的话调度会把请求派给这个账号
    //    然后失败。这里对每个模型发一次最小请求，把结果标进 usable。
    if (o.verifyModels !== false && models.length) {
      const verdicts = await verifyModels(account, models, o);
      let bad = 0;
      for (const m of info.models) {
        const v = verdicts.get(m.id);
        if (!v) continue;
        m.usable = v.ok;
        if (!v.ok) { m.unusableReason = v.reason; bad++; }
      }
      info.verifiedAt = new Date().toISOString();
      info.usableModelCount = info.models.filter((m) => m.usable !== false).length;
      log(
        'info',
        `模型可用性验证 ${account.id}：${info.usableModelCount}/${info.models.length} 可用${bad ? `，${bad} 个调不通` : ''}`,
      );
    }

    log(
      'info',
      `账号信息探测 ${account.id}：模型 ${info.modelCount} 个，智能体 ${info.agentCount} 个，余额 ${balance ? Object.keys(balance).length : 0} 个字段，耗时 ${info.durationMs}ms`,
    );
    return info;
  }

  /**
   * 对每个模型发一次最小 chat 请求，判断上游认不认。
   *
   * 只关心「路由是否命中」，不关心回复内容：max_tokens 给 1，
   * 拿到 404 / Route missed 就算不可用，其余都算可用。
   *
   * 串行执行并留间隔，避免触发上游并发限制（TM.00001041）。
   */
  async function verifyModels(account, models, o) {
    const out = new Map();
    const chatPath = o.chatPath ?? '/api/v2/chat/completions';
    const base = o.chatBase ?? o.agentBase;
    if (!base) return out;
    for (const m of models) {
      if (!m?.id) continue;
      const payload = {
        model: m.id,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      };
      try {
        const r = await signedCall(account, base, chatPath, {
          method: 'POST',
          body: JSON.stringify(payload),
          kind: 'agent',
        });
        const text = typeof r.text === 'string' ? r.text : JSON.stringify(r.json ?? '');
        const missed = /Route missed for model|is not registered/i.test(text);
        if (missed) {
          out.set(m.id, { ok: false, reason: 'route_missed' });
        } else if (r.status >= 400) {
          out.set(m.id, { ok: false, reason: `http_${r.status}` });
        } else {
          out.set(m.id, { ok: true });
        }
      } catch (e) {
        out.set(m.id, { ok: false, reason: `error:${e?.message ?? e}`.slice(0, 120) });
      }
      await new Promise((r2) => setTimeout(r2, 400));
    }
    return out;
  }

  return { probe };
}
