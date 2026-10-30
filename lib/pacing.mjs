// 出站节流：按账号限并发 + 最小间隔 + 抖动 + 冷却。
//
// 为什么需要：真 CLI 是「一个人类在终端里敲」，天然就是低并发、带思考停顿的节奏。
// 网关一次挂 20 个客户端同时抢同一 AK，会把这条曲线拉成一条直线 —— 这是行为侧
// 最容易看出来的信号，且不需要任何特征库。这里把它压回接近真人的形状。
const DEFAULTS = {
  // 上游实测每账号允许 3 个并发会话（超过回 HTTP 400 + TM.00001041）。
  // 留 1 格余量，默认 2：既比 1 吞吐翻倍，又不会顶到上游的硬上限。
  maxConcurrentPerAccount: 2,
  maxGlobalConcurrent: 8,
  minIntervalMs: 250,
  jitterMs: 150,
  // 排队等待上限。原来是 30s，推理模型（kimi-k3 之类）一个请求就要
  // 30~60s，账号一忙就必然撞线 → 一堆莫名其妙的 gateway_busy。
  // 真正的 503 只该出现在「所有账号都满了且等满预算」的情况。
  queueTimeoutMs: 60000,
};

const COOLDOWN_DEFAULTS = {
  on429Ms: 60_000,
  on5xxMs: 15_000,
  onAuthErrorMs: 600_000,
  respectRetryAfter: true,
  maxRetryAfterMs: 900_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 名额被占、但不知道何时结束时的退避下限（给 Retry-After 兜底）
const BUSY_FLOOR_MS = 250;

export function createGovernor({ cfg = {}, now = () => Date.now() } = {}) {
  const pacing = { ...DEFAULTS, ...(cfg.stealth?.pacing ?? {}) };
  const cooldown = { ...COOLDOWN_DEFAULTS, ...(cfg.stealth?.cooldown ?? {}) };

  /** @type {Map<string, {inflight:number,lastAt:number,cooldownUntil:number,requests:number,penalties:number}>} */
  const accounts = new Map();
  let globalInflight = 0;

  const stateOf = (id) => {
    let st = accounts.get(id);
    if (!st) {
      st = { inflight: 0, lastAt: 0, cooldownUntil: 0, requests: 0, penalties: 0 };
      accounts.set(id, st);
    }
    return st;
  };

  const accountKey = (account) => account?.id ?? account?.ref ?? 'config';

  function isCoolingDown(account) {
    const st = accounts.get(accountKey(account));
    return !!st && st.cooldownUntil > now();
  }

  /**
   * 这个账号现在能不能立刻拿到名额（不等待、不占名额）。
   *
   * 轮换时先扫一遍所有候选账号，优先选真正空闲的那个 ——
   * 否则会傻等在一个忙账号上，明明另一个账号闲着。
   * 这里忽略抖动（只按 minIntervalMs 粗判），真正的间隔由 acquire 把关。
   */
  function hasFreeSlot(account) {
    const st = stateOf(accountKey(account));
    const t = now();
    if (st.cooldownUntil > t) return false;
    if (st.inflight >= pacing.maxConcurrentPerAccount) return false;
    if (globalInflight >= pacing.maxGlobalConcurrent) return false;
    return t - st.lastAt >= pacing.minIntervalMs;
  }

  /** 还要等多久才可能拿到名额（毫秒，0 = 现在就可以） */
  function freeInMs(account) {
    const st = stateOf(accountKey(account));
    const t = now();
    if (st.cooldownUntil > t) return st.cooldownUntil - t;
    // 名额被占着时没法知道对端什么时候结束，给个有意义的保守下限，
    // 不能直接返回 minIntervalMs —— 它配成 0 的话会退化成「立刻可重试」，
    // 客户端就变成无脑重打。
    const floorMs = Math.max(BUSY_FLOOR_MS, pacing.minIntervalMs);
    if (st.inflight >= pacing.maxConcurrentPerAccount) return floorMs;
    if (globalInflight >= pacing.maxGlobalConcurrent) return floorMs;
    const wait = st.lastAt + pacing.minIntervalMs - t;
    return wait > 0 ? wait : 0;
  }

  /**
   * 拿一个出站名额。返回 release()，必须 finally 调用。
   * @param {object|null} account
   * @param {{timeoutMs?:number}} [opts]
   */
  async function acquire(account, opts = {}) {
    const key = accountKey(account);
    const st = stateOf(key);
    const deadline = now() + (opts.timeoutMs ?? pacing.queueTimeoutMs);
    // 每次请求的间隔都带抖动，避免出现等距 spire
    const interval = pacing.minIntervalMs + Math.floor(Math.random() * Math.max(1, pacing.jitterMs));

    for (;;) {
      const t = now();
      if (st.cooldownUntil > t) {
        if (t > deadline) throw busyError('账号冷却中', { code: 'account_cooldown', account: key, retryAt: st.cooldownUntil });
        await sleep(Math.min(250, st.cooldownUntil - t));
        continue;
      }
      if (
        st.inflight < pacing.maxConcurrentPerAccount &&
        globalInflight < pacing.maxGlobalConcurrent &&
        t - st.lastAt >= interval
      ) {
        st.inflight++;
        st.requests++;
        st.lastAt = t;
        globalInflight++;
        let released = false;
        return function release() {
          if (released) return;
          released = true;
          st.inflight = Math.max(0, st.inflight - 1);
          globalInflight = Math.max(0, globalInflight - 1);
        };
      }
      if (t > deadline) {
        // 带上这个账号的预估等待，上层可以据此决定「换号」还是「让客户端 retry-after」
        throw busyError('网关繁忙：等待账号空闲超时', {
          code: 'gateway_busy',
          account: key,
          retryAfterMs: Math.max(BUSY_FLOOR_MS, freeInMs(account)),
        });
      }
      await sleep(10 + Math.floor(Math.random() * 25));
    }
  }

  /**
   * 某个账号这次请求失败后，按状态码给它上冷却。
   * @param {object|null} account
   * @param {number} status
   * @param {number} [retryAfterMs] Retry-After 解析结果
   */
  function penalize(account, status, retryAfterMs) {
    const st = stateOf(accountKey(account));
    let ms = 0;
    if (status === 429) ms = cooldown.on429Ms;
    else if (status === 401 || status === 403) ms = cooldown.onAuthErrorMs;
    else if (status >= 500) ms = cooldown.on5xxMs;
    if (ms <= 0) return 0;
    if (cooldown.respectRetryAfter && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      ms = Math.max(ms, Math.min(retryAfterMs, cooldown.maxRetryAfterMs));
    }
    st.penalties++;
    st.cooldownUntil = Math.max(st.cooldownUntil, now() + ms);
    return ms;
  }

  function reset(account) {
    accounts.delete(accountKey(account));
  }

  function snapshot() {
    const out = { globalInflight, accounts: [] };
    for (const [id, st] of accounts) {
      out.accounts.push({
        id,
        inflight: st.inflight,
        requests: st.requests,
        penalties: st.penalties,
        cooldownMs: Math.max(0, st.cooldownUntil - now()),
        lastAt: st.lastAt || null,
      });
    }
    return out;
  }

  return { acquire, penalize, isCoolingDown, hasFreeSlot, freeInMs, reset, snapshot, pacing, cooldown };
}

function busyError(message, extra = {}) {
  const e = new Error(message);
  Object.assign(e, extra);
  return e;
}

/** 解析上游 Retry-After（秒数或 HTTP 日期） */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === undefined || value === null || value === '') return 0;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - nowMs);
}

export { sleep };
