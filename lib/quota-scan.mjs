// 配额主动扫描：定时为「账号 × 模型」发最小请求，提前发现哪条配额线被打满
//
// 上游只在真撞到 429 时才「有记录」，在那之前没人知道离限额还有多远，
// 等到真撞上，客户端已经吃了一次失败。
//
// 本模块补的是前半段：按固定间隔（默认 6 小时）为每个「账号 × 模型」发一个
// 最小请求，主动看这条配额线是否已被打满：
//
//   * 拿到 429 + 重置时刻 → 这条线已登记，立刻记模型冷却，让真实请求不再撞同一个坑
//   * 请求通了            → 这条线还活着，继续按 6 小时查
//   * 网络/解析失败       → 不算查过，15 分钟后重试（连续失败到上限才推到下一周期）
//
// 判定条件只有一句：**本地已有 429 窗口记录的配额线不再主动查询**，
// 其余按间隔轮询；窗口记录消失（探针把它抢回来了）之后自动恢复到轮询队列。

export const QUOTA = {
  // 一条配额线两次主动查询之间至少隔这么久
  SCAN_INTERVAL: 6 * 3600,
  // 失败的查询不算查过，隔这么久重试
  RETRY_DELAY: 15 * 60,
  // 连续失败到这个次数才放弃这一轮
  MAX_ATTEMPTS: 6,
  // 首次登记要排开，别在勾选的一瞬间把请求全打上去
  FIRST_DELAY: 5,
  FIRST_STAGGER: 15,
  FIRST_DELAY_MAX: 3600,
  // 每轮最多处理几个组合，避免一个卡死的上游把调度线程占满
  BATCH_LIMIT: 6,
  // 相邻两次查询之间的间隔
  SCAN_GAP: 0.4,
  // 这么久没动过的记录直接丢弃
  MAX_AGE: 30 * 86400,
};

const keyOf = (uid, model) => `${uid}\u0000${model}`;

function newRow(uid, model, now) {
  return {
    uid,
    model,
    lastScan: 0, // 0 = 还没查过，只有成功的查询才推进它
    nextAt: 0,
    seenAt: now,
    lastTry: 0,
    attempts: 0,
    lastResult: '',
    lastDetail: '',
    resetAt: 0,
  };
}

/** 下次该查的时刻 */
function dueAt(row) {
  if (row.nextAt) return row.nextAt;
  if (row.lastScan) return row.lastScan + QUOTA.SCAN_INTERVAL;
  return 0;
}

export function createQuotaScanner({ log = () => {}, probe, now = () => Date.now() / 1000 } = {}) {
  /** uid -> model -> row */
  let scans = new Map();
  let runLock = false;

  const prune = (t) => {
    for (const [k, row] of scans) {
      if (t - (row.seenAt ?? 0) > QUOTA.MAX_AGE) scans.delete(k);
    }
  };

  /** 首次登记：把新出现的组合排开 */
  const seed = (wanted, t) => {
    let i = 0;
    for (const { uid, model } of wanted) {
      const k = keyOf(uid, model);
      if (scans.has(k)) {
        scans.get(k).seenAt = t;
        continue;
      }
      const delay = Math.min(QUOTA.FIRST_DELAY + i * QUOTA.FIRST_STAGGER, QUOTA.FIRST_DELAY_MAX);
      const row = newRow(uid, model, t);
      // 已经过了首次延迟（比如进程刚启动就轮询）就不用再等
      row.nextAt = delay > 0 ? t + delay : 0;
      scans.set(k, row);
      i++;
    }
  };

  /**
   * 这一轮该查哪些组合。
   * @param {object[]} accounts
   * @param {string[]} models 要盯的模型（面板勾选）
   * @param {object} [opts]
   */
  const dueTargets = (accounts, models, { limit = QUOTA.BATCH_LIMIT, force = false, isCooling = null } = {}) => {
    const t = now();
    prune(t);
    const wanted = [];
    for (const a of accounts ?? []) {
      if (a.enabled === false) continue;
      for (const m of models ?? []) wanted.push({ uid: a.id, model: m });
    }
    seed(wanted, t);

    const out = [];
    for (const { uid, model } of wanted) {
      const row = scans.get(keyOf(uid, model));
      if (!row) continue;
      // 已有 429 窗口记录的线不再主动查（等探针把它抢回来）
      if (!force && row.lastResult === 'throttled' && row.resetAt > t) continue;
      // 模型正在冷却中，查了也是 429
      if (!force && isCooling && isCooling(uid, model)) continue;
      if (!force && dueAt(row) > t) continue;
      out.push({ uid, model, row: { ...row } });
      if (out.length >= limit) break;
    }
    return out;
  };

  /** 记录一次查询结果 */
  const record = (uid, model, t, { lastScan, nextAt, attempts, result, detail, resetAt } = {}) => {
    const k = keyOf(uid, model);
    const row = scans.get(k) ?? newRow(uid, model, t);
    if (lastScan) row.lastScan = Math.max(Number(row.lastScan) || 0, Number(lastScan));
    row.nextAt = Number(nextAt) || 0;
    row.attempts = attempts == null ? Number(row.attempts) || 0 : Number(attempts);
    row.lastTry = t;
    row.lastResult = String(result ?? '').slice(0, 40);
    row.lastDetail = String(detail ?? '').slice(0, 200);
    if (resetAt) row.resetAt = Number(resetAt);
    row.seenAt = t;
    scans.set(k, row);
    return { ...row };
  };

  /**
   * 跑一轮扫描。
   * @returns {Promise<{scanned:number, throttled:number, ok:number, failed:number, results:object[]}>}
   */
  const runDue = async (accounts, models, { limit = QUOTA.BATCH_LIMIT, force = false, isCooling, onThrottled } = {}) => {
    if (runLock) return { scanned: 0, throttled: 0, ok: 0, failed: 0, results: [], skipped: 'busy' };
    runLock = true;
    const results = [];
    let throttled = 0;
    let okN = 0;
    let failed = 0;
    try {
      const targets = dueTargets(accounts, models, { limit, force, isCooling });
      const byId = new Map((accounts ?? []).map((a) => [a.id, a]));
      for (let i = 0; i < targets.length; i++) {
        const { uid, model, row } = targets[i];
        const account = byId.get(uid);
        if (!account) continue;
        if (i > 0 && QUOTA.SCAN_GAP > 0) await sleep(QUOTA.SCAN_GAP * 1000);

        const t = now();
        let r;
        try {
          r = await probe({ account, model });
        } catch (e) {
          r = { status: 0, error: String(e?.message ?? e) };
        }

        const status = Number(r?.status) || 0;
        const uid8 = String(uid).slice(0, 8);

        if (status >= 200 && status < 300) {
          okN++;
          record(uid, model, t, { lastScan: t, attempts: 0, result: 'ok' });
          results.push({ uid, model, result: 'ok', status });
          log(`配额查询：账号 [${uid8}] 的 ${model} 正常`);
          continue;
        }

        const resetAt = Number(r?.resetAt) || 0;
        const detail = String(r?.error ?? r?.detail ?? `HTTP ${status}`).slice(0, 200);

        if (status === 429 || /rate.?limit|限流|too many/i.test(detail)) {
          throttled++;
          const window = resetAt || t + 3600;
          record(uid, model, t, {
            lastScan: t,
            attempts: 0,
            result: 'throttled',
            detail,
            resetAt: window,
            // 到限的线以窗口结束为下次查询时刻，而不是 6 小时周期
            nextAt: window,
          });
          if (onThrottled) onThrottled({ account, model, resetAt: window, detail });
          results.push({ uid, model, result: 'throttled', status, resetAt });
          log(
            resetAt
              ? `配额查询：账号 [${uid8}] 的 ${model} 已达限额，已登记窗口 ${new Date(resetAt * 1000).toLocaleString('zh-CN')} 到点`
              : `配额查询：账号 [${uid8}] 的 ${model} 已达限额，冷却 1 小时`
          );
          continue;
        }

        // 其他失败：不算查过，稍后重试
        failed++;
        const attempts = (Number(row.attempts) || 0) + 1;
        if (attempts >= QUOTA.MAX_ATTEMPTS) {
          record(uid, model, t, { lastScan: t, attempts: 0, result: 'error', detail });
          log(`配额查询：账号 [${uid8}] 的 ${model} 连续 ${attempts} 次失败，推迟到下一周期（${detail || '无详情'}）`);
        } else {
          record(uid, model, t, { attempts, nextAt: t + QUOTA.RETRY_DELAY, result: 'error', detail });
          log(`配额查询：账号 [${uid8}] 的 ${model} 未完成检查（${detail || '无详情'}），${QUOTA.RETRY_DELAY} 秒后重试 (${attempts}/${QUOTA.MAX_ATTEMPTS})`);
        }
        results.push({ uid, model, result: 'error', status, detail });
      }
    } finally {
      runLock = false;
    }
    return { scanned: results.length, throttled, ok: okN, failed, results };
  };

  /** 只读快照（按下次该查的时刻升序） */
  const snapshot = (limit = 50) => {
    const t = now();
    return [...scans.values()]
      .map((r) => ({
        uid: r.uid,
        model: r.model,
        lastScan: r.lastScan || null,
        nextAt: dueAt(r) || null,
        dueIn: Math.max(0, Math.round((dueAt(r) || t) - t)),
        attempts: r.attempts,
        lastResult: r.lastResult,
        lastDetail: r.lastDetail,
        resetAt: r.resetAt || null,
      }))
      .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))
      .slice(0, limit);
  };

  const drop = (uid, model) => scans.delete(keyOf(uid, model));
  const reset = () => {
    scans = new Map();
  };

  return { dueTargets, runDue, snapshot, record, drop, reset, get size() { return scans.size; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
