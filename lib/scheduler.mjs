// 账号调度器：平滑加权轮询 + 四级退避 + 会话粘性 + 模型级冷却
//
// 参考 workbuddy2api-hub 的 wb_accounts.py 调度模型，按码道网关的语义重写。
//
// 四级退避（区分失败类型，不用一个计数器糊在一起）：
//   1. 软限流 429（账号级）     → 600s 起，翻倍到 2h
//   2. 软限流 429（未验证范围） → 60s 起，翻倍到 10min
//   3. 硬失败 5xx/网络          → 连续 3 次后熔断，30min 起翻倍到 6h
//   4. 未知错误                 → 连续 5 次后降级，10min 起翻倍到 2h
//
// 模型级冷却：某个模型配额耗尽只封这个模型，不拖死整个账号。
//
// 会话粘性：同一会话优先回到上次服务的账号，保住上游 prompt cache；
// 该账号不可用时，退到该会话历史里其他账号（它们也预热过），最后才用冷账号。

/* ---------------- 退避常量 ---------------- */

export const BACKOFF = {
  // 账号级软限流
  SOFT_BASE: 600, // 10 分钟
  SOFT_MAX: 7200, // 2 小时
  // 未验证范围的软限流（单模型重复撞 429）
  SOFT_UNVERIFIED_BASE: 60,
  SOFT_UNVERIFIED_MAX: 600,
  // 硬失败熔断
  BREAKER_THRESHOLD: 3,
  BREAKER_BASE: 1800, // 30 分钟
  BREAKER_MAX: 21600, // 6 小时
  // 未知错误降级
  DEGRADE_THRESHOLD: 5,
  DEGRADE_BASE: 600,
  DEGRADE_MAX: 7200,
  // 连续失败多久算「断了」（重置计数）
  FAIL_WINDOW: 1800, // 30 分钟
};

/** 指数退避：base * 2^(count - offset)，夹到 cap */
export function exponentialBackoff(count, base, cap, offset) {
  const step = Math.max(0, Number(count) - Number(offset));
  return Math.min(Number(base) * 2 ** Math.min(step, 20), Number(cap));
}

export const softBackoff = (streak) => exponentialBackoff(streak, BACKOFF.SOFT_BASE, BACKOFF.SOFT_MAX, 1);
export const unverifiedSoftBackoff = (streak) =>
  exponentialBackoff(streak, BACKOFF.SOFT_UNVERIFIED_BASE, BACKOFF.SOFT_UNVERIFIED_MAX, 1);
export const breakerBackoff = (fails) =>
  exponentialBackoff(fails, BACKOFF.BREAKER_BASE, BACKOFF.BREAKER_MAX, BACKOFF.BREAKER_THRESHOLD);
export const degradeBackoff = (fails) =>
  exponentialBackoff(fails, BACKOFF.DEGRADE_BASE, BACKOFF.DEGRADE_MAX, BACKOFF.DEGRADE_THRESHOLD);

/* ---------------- 错误分类 ---------------- */

/**
 * 把一次失败归类，决定喂哪个计数器。
 * @returns {'soft'|'soft_unverified'|'hard'|'unknown'|'auth'|'quota'}
 */
export function classifyFailure({ status, code, message, modelScoped } = {}) {
  const s = Number(status) || 0;
  const text = String(message ?? '').toLowerCase();
  const c = String(code ?? '');

  // 鉴权失效：不是限流，是凭据问题
  if (s === 401 || s === 403 || c === 'token_expired' || /token.*(expired|invalid)/i.test(text)) {
    return 'auth';
  }
  // 配额耗尽（余额/额度）
  if (s === 402 || /insufficient|quota.*exhaust|balance.*(low|empty)|额度|余额不足/.test(text)) {
    return 'quota';
  }
  // 429：区分账号级和模型级
  if (s === 429 || /rate.?limit|too many requests|throttl|限流|频率/.test(text)) {
    return modelScoped ? 'soft_unverified' : 'soft';
  }
  // 5xx / 网络
  if (s >= 500 || s === 0 || /econnreset|etimedout|socket hang up|network|fetch failed|timeout/.test(text)) {
    return 'hard';
  }
  return 'unknown';
}

/** 从上游错误里抠出重置时刻（秒级 epoch），抠不到返回 0 */
export function parseResetAt({ headers, body } = {}) {
  const now = Date.now() / 1000;
  // Retry-After 头：秒数或 HTTP 日期
  const ra = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (ra != null) {
    const n = Number(ra);
    if (Number.isFinite(n) && n > 0) return now + n;
    const t = Date.parse(String(ra));
    if (Number.isFinite(t)) return t / 1000;
  }
  // 响应体里的各种字段名
  const j = typeof body === 'string' ? safeJson(body) : body;
  const candidates = [
    j?.reset_at, j?.resetAt, j?.reset_time, j?.resetTime,
    j?.data?.reset_at, j?.data?.resetAt,
    j?.error?.reset_at, j?.result?.reset_at,
    j?.quota?.reset_at,
  ];
  for (const v of candidates) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n / 1000 : n; // 兼容毫秒
    const t = Date.parse(String(v));
    if (Number.isFinite(t)) return t / 1000;
  }
  // x-ratelimit-reset 头（可能是秒数或 epoch）
  const xr = headers?.['x-ratelimit-reset'];
  if (xr != null) {
    const n = Number(xr);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n / 1000 : n > 1e9 ? n : now + n;
  }
  return 0;
}

const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/* ---------------- 账号运行时状态 ---------------- */

/** 每个账号的运行时调度状态（不落盘，重启即重置） */
export function runtimeOf(account) {
  if (!account.__rt) {
    account.__rt = {
      // 冷却截止时刻（秒）
      cooldownUntil: 0,
      balanceUntil: 0,
      breakerUntil: 0,
      degradeUntil: 0,
      restrictedUntil: 0,
      // 模型级冷却：model -> 截止时刻
      modelCooldowns: {},
      // 计数器
      softStreak: 0,
      unverifiedStreak: 0,
      fails: 0,
      degradeCount: 0,
      lastFailAt: 0,
      lastSoftAt: 0,
      lastError: '',
      lastErrorDetail: '',
      tokenExpired: false,
      // 权重（面板可设）
      weight: 1,
      // 平滑加权轮询的累计值
      currentWeight: 0,
    };
  }
  return account.__rt;
}

const nowSec = () => Date.now() / 1000;

/** 两次失败隔太久就不算「连续」，从头计数 */
function decayStrikes(rt) {
  const now = nowSec();
  if (BACKOFF.FAIL_WINDOW && rt.lastFailAt && now - rt.lastFailAt > BACKOFF.FAIL_WINDOW) {
    rt.fails = 0;
    rt.degradeCount = 0;
    rt.softStreak = 0;
    rt.unverifiedStreak = 0;
  }
  rt.lastFailAt = now;
}

/** 这个账号还要等多久才能服务（0 = 现在就行） */
export function throttleWait(account, model) {
  if (!account || account.enabled === false) return 0;
  const rt = runtimeOf(account);
  const now = nowSec();
  let wait = Math.max(
    0,
    rt.cooldownUntil - now,
    rt.balanceUntil - now,
    rt.breakerUntil - now,
    rt.degradeUntil - now,
    rt.restrictedUntil - now
  );
  if (model) {
    const m = rt.modelCooldowns[model] ?? 0;
    wait = Math.max(wait, m - now);
  }
  return wait;
}

/** 账号对这个模型是否可用 */
export function isReady(account, model) {
  if (!account || account.enabled === false) return false;
  const rt = runtimeOf(account);
  if (rt.tokenExpired) return false;
  // 账号级模型黑名单
  if (Array.isArray(account.disabledModels) && model && account.disabledModels.includes(model)) return false;
  if (throttleWait(account, model) > 0) return false;
  return true;
}

/**
 * 记一次失败，喂对应计数器。
 * @returns {{kind:string, wait:number, until:number}}
 */
export function noteFailure(account, { status, code, message, model, modelScoped, resetAt } = {}) {
  const rt = runtimeOf(account);
  const now = nowSec();
  const kind = classifyFailure({ status, code, message, modelScoped });
  rt.lastError = String(message ?? '').slice(0, 200);
  rt.lastErrorDetail = String(code ?? '').slice(0, 80);

  const until = Number(resetAt) > 0 ? Number(resetAt) : 0;

  switch (kind) {
    case 'auth': {
      // 凭据失效：停用直到续期成功
      rt.tokenExpired = true;
      return { kind, wait: Infinity, until: 0 };
    }
    case 'quota': {
      // 余额/额度耗尽：冷静 1 小时，等充值或次日
      rt.balanceUntil = Math.max(rt.balanceUntil, until || now + 3600);
      return { kind, wait: rt.balanceUntil - now, until: rt.balanceUntil };
    }
    case 'soft': {
      decayStrikes(rt);
      rt.softStreak += 1;
      rt.lastSoftAt = now;
      const wait = until ? until - now : softBackoff(rt.softStreak);
      rt.cooldownUntil = Math.max(rt.cooldownUntil, now + Math.max(0, wait));
      return { kind, wait: rt.cooldownUntil - now, until: rt.cooldownUntil };
    }
    case 'soft_unverified': {
      decayStrikes(rt);
      rt.unverifiedStreak += 1;
      rt.lastSoftAt = now;
      const wait = until ? until - now : unverifiedSoftBackoff(rt.unverifiedStreak);
      // 只封这个模型
      if (model) {
        rt.modelCooldowns[model] = Math.max(rt.modelCooldowns[model] ?? 0, now + Math.max(0, wait));
        return { kind, wait: rt.modelCooldowns[model] - now, until: rt.modelCooldowns[model] };
      }
      rt.cooldownUntil = Math.max(rt.cooldownUntil, now + Math.max(0, wait));
      return { kind, wait: rt.cooldownUntil - now, until: rt.cooldownUntil };
    }
    case 'hard': {
      decayStrikes(rt);
      rt.fails += 1;
      if (rt.fails >= BACKOFF.BREAKER_THRESHOLD) {
        const wait = until ? until - now : breakerBackoff(rt.fails);
        rt.breakerUntil = Math.max(rt.breakerUntil, now + Math.max(0, wait));
      }
      return { kind, wait: Math.max(0, rt.breakerUntil - now), until: rt.breakerUntil };
    }
    default: {
      decayStrikes(rt);
      rt.degradeCount += 1;
      rt.fails += 1;
      if (rt.degradeCount >= BACKOFF.DEGRADE_THRESHOLD) {
        const wait = until ? until - now : degradeBackoff(rt.degradeCount);
        rt.degradeUntil = Math.max(rt.degradeUntil, now + Math.max(0, wait));
      }
      if (rt.fails >= BACKOFF.BREAKER_THRESHOLD) {
        const wait = breakerBackoff(rt.fails);
        rt.breakerUntil = Math.max(rt.breakerUntil, now + wait);
      }
      // 返回实际生效的最长冷却（降级和熔断可能同时触发）
      const effective = Math.max(rt.degradeUntil, rt.breakerUntil);
      return { kind, wait: Math.max(0, effective - now), until: effective };
    }
  }
}

/** 成功一次，清掉所有惩罚（成功是最硬的证据） */
export function noteSuccess(account, model) {
  const rt = runtimeOf(account);
  if (model) delete rt.modelCooldowns[model];
  rt.softStreak = 0;
  rt.unverifiedStreak = 0;
  rt.fails = 0;
  rt.degradeCount = 0;
  rt.lastFailAt = 0;
  rt.lastSoftAt = 0;
  rt.breakerUntil = 0;
  rt.degradeUntil = 0;
  rt.restrictedUntil = 0;
  rt.lastError = '';
  rt.lastErrorDetail = '';
  rt.cooldownUntil = 0;
  rt.balanceUntil = 0;
  rt.tokenExpired = false;
}

/** 手动清冷却（面板按钮） */
export function clearCooldown(account, model) {
  const rt = runtimeOf(account);
  if (model) {
    delete rt.modelCooldowns[model];
  } else {
    rt.modelCooldowns = {};
    rt.cooldownUntil = 0;
    rt.balanceUntil = 0;
    rt.breakerUntil = 0;
    rt.degradeUntil = 0;
    rt.softStreak = 0;
    rt.unverifiedStreak = 0;
    rt.fails = 0;
    rt.degradeCount = 0;
    rt.lastError = '';
  }
}

/* ---------------- 会话粘性 ---------------- */

export function createSessionAffinity({ ttlMs = 7200000, maxEntries = 5000, history = 3 } = {}) {
  const bindings = new Map();

  const live = (key, now) => {
    const entries = bindings.get(key) ?? [];
    const ok = entries.filter((e) => e.exp > now);
    if (ok.length) bindings.set(key, ok);
    else bindings.delete(key);
    return ok;
  };

  return {
    /** 上次服务这个会话的账号 id */
    get(key) {
      if (!key) return null;
      const t = Date.now();
      const list = live(key, t);
      if (!list.length) return null;
      list[0] = { uid: list[0].uid, exp: t + ttlMs }; // 滑动续期
      return list[0].uid;
    },
    /** 这个会话最近用过的账号（新的在前） */
    recent(key) {
      if (!key) return [];
      return live(key, Date.now()).map((e) => e.uid);
    },
    /** 把账号放到会话的最前面 */
    bind(key, uid) {
      if (!key || !uid) return;
      const t = Date.now();
      if (bindings.size >= maxEntries) {
        for (const [k, v] of bindings) {
          if (!v?.length || v[0].exp <= t) bindings.delete(k);
        }
      }
      const entries = (bindings.get(key) ?? []).filter((e) => e.uid !== uid);
      entries.unshift({ uid, exp: t + ttlMs });
      bindings.set(key, entries.slice(0, history));
    },
    /** 从会话里摘掉一个账号（失败时用，保留其他） */
    demote(key, uid) {
      if (!key) return;
      const entries = bindings.get(key) ?? [];
      const next = uid == null ? entries.slice(1) : entries.filter((e) => e.uid !== uid);
      if (next.length) bindings.set(key, next);
      else bindings.delete(key);
    },
    clear() {
      bindings.clear();
    },
    get size() {
      return bindings.size;
    },
  };
}

/* ---------------- 选号：平滑加权轮询 ---------------- */

/**
 * 平滑加权轮询（nginx 算法）。
 * 每个候选每次累加自己的权重，最大的胜出，胜出者减掉本轮总权重。
 * 权重相等时退化成纯轮询。
 *
 * @param {Array<{account:object, weight:number}>} entries
 * @returns {object|null} 选中的 account
 */
export function smoothWeightedPick(entries) {
  if (!entries?.length) return null;
  let total = 0;
  let chosen = null;
  for (const e of entries) {
    const rt = runtimeOf(e.account);
    const w = Math.max(1, Number(e.weight) || 1);
    rt.currentWeight = (rt.currentWeight ?? 0) + w;
    total += w;
    if (chosen === null || rt.currentWeight > runtimeOf(chosen.account).currentWeight) {
      chosen = e;
    }
  }
  if (!chosen) return null;
  runtimeOf(chosen.account).currentWeight -= total;
  return chosen.account;
}

/**
 * 从账号池里挑一个账号。
 *
 * 顺序：
 *   1. 会话粘性：这个会话上次用的账号还可用 → 直接回它（保住 prompt cache）
 *   2. 会话历史：该会话用过、仍可用的其他账号
 *   3. 手动权重 > 1 的账号优先（面板明确设置）
 *   4. 平滑加权轮询（含配额将尽的加权）
 *
 * @param {object} p
 * @param {object[]} p.accounts
 * @param {string} [p.model]
 * @param {string} [p.sessionKey]
 * @param {Set|string[]} [p.exclude]
 * @param {object} [p.affinity]
 * @param {string} [p.ref]      指定账号（跳过调度）
 * @param {Function} [p.find]   按 ref 找账号
 * @param {Function} [p.quotaWeight] (account, model) => number  配额权重
 */
export function pickAccount({
  accounts = [],
  model,
  sessionKey,
  exclude,
  affinity,
  ref,
  find,
  quotaWeight,
} = {}) {
  const skip = new Set(exclude ?? []);

  // 指定账号：不走调度，但仍要检查可用性
  if (ref) {
    const a = find ? find(ref) : accounts.find((x) => x.id === ref || x.ref === ref);
    if (!a || a.enabled === false) return null;
    return a;
  }

  const ready = accounts.filter((a) => !skip.has(a.id) && !skip.has(a.ref) && isReady(a, model));
  if (!ready.length) return null;

  // 1 & 2. 会话粘性
  if (sessionKey && affinity) {
    for (const uid of affinity.recent(sessionKey)) {
      const hit = ready.find((a) => a.id === uid || a.ref === uid);
      if (hit) return hit;
    }
  }

  // 3. 手动权重 > 1
  const manual = ready.filter((a) => (runtimeOf(a).weight ?? 1) > 1);
  if (manual.length) {
    const picked = smoothWeightedPick(manual.map((a) => ({ account: a, weight: runtimeOf(a).weight })));
    if (picked) return picked;
  }

  // 4. 平滑加权轮询（配额将尽的加权，没有就全 1 = 纯轮询）
  const entries = ready.map((a) => {
    const w = quotaWeight ? Math.max(1, Number(quotaWeight(a, model)) || 1) : 1;
    return { account: a, weight: w };
  });
  return smoothWeightedPick(entries);
}

/** 账号的调度状态快照（给面板） */
export function scheduleSnapshot(account, model) {
  const rt = runtimeOf(account);
  const now = nowSec();
  const left = (t) => (t > now ? Math.round(t - now) : 0);
  return {
    ready: isReady(account, model),
    weight: rt.weight ?? 1,
    waitSec: Math.round(throttleWait(account, model)),
    cooldownSec: left(rt.cooldownUntil),
    breakerSec: left(rt.breakerUntil),
    degradeSec: left(rt.degradeUntil),
    balanceSec: left(rt.balanceUntil),
    restrictedSec: left(rt.restrictedUntil),
    softStreak: rt.softStreak,
    unverifiedStreak: rt.unverifiedStreak,
    fails: rt.fails,
    degradeCount: rt.degradeCount,
    tokenExpired: rt.tokenExpired,
    lastError: rt.lastError,
    modelCooldowns: Object.fromEntries(
      Object.entries(rt.modelCooldowns)
        .filter(([, t]) => t > now)
        .map(([m, t]) => [m, Math.round(t - now)])
    ),
  };
}
