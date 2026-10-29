// 按模型真实价格计算每次请求的积分消耗
//
// 价格来源：agent-center detail 的 gpts.models[].credit[]（阶梯数组）
//   { input_from, input_to, output_from, output_to,
//     input_price, cache_price, output_price }
//
// 语义（实测 OpenPangu-2.0-Pro 有两档）：
//   [0..32000]    入 3.2 / 缓存 0.8 / 出 14.5
//   [32001..-1]   入 4.8 / 缓存 1.2 / 出 17.6
//   input_to = -1 表示无上限
//
// 计价规则：
//   输入未命中缓存的 token → input_price
//   输入命中缓存的 token   → cache_price
//   输出 token             → output_price
//   单价单位是「积分 / 千 token」，所以最后除以 1000
//
// 阶梯按「输入 token 数」选档（与 input_from/input_to 对齐）。

/** 价格单位：积分 / 千 token */
export const PRICE_UNIT = 1000;

/**
 * 选档：按输入 token 数匹配 input_from..input_to。
 *
 * 参考 workbuddy2api-hub 的 band_for()：分档可能按输入长度，也可能按时段
 * （days + start/end，UTC 的 HHMM 整数）。这里两种都支持，取**最后一个**
 * 匹配的档 —— 长度档按阈值升序排列，取最后一个等于取最紧的那档；
 * 时段档互不重叠，同一条规则也成立。
 *
 * @param {Array} tiers
 * @param {number} inputTokens
 * @param {number} [epochSec] 请求时刻（秒），有时段档才需要
 */
export function pickTier(tiers, inputTokens, epochSec) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const n = Number(inputTokens) || 0;
  let hit = null;
  for (const t of tiers) {
    if (!tierApplies(t, n, epochSec)) continue;
    hit = t;
  }
  if (hit) return hit;
  // 都不匹配 → 用没有条件的那一档，再退到最后一档
  const flat = tiers.find((t) => t.inputFrom == null && t.start == null);
  return flat ?? tiers[tiers.length - 1];
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 这一档是否适用于本次请求 */
function tierApplies(t, inputTokens, epochSec) {
  // 时段档：days + start/end（UTC HHMM）
  if (t.start != null || t.end != null || Array.isArray(t.days)) {
    if (!epochSec) return false;
    const d = new Date(Number(epochSec) * 1000);
    const day = WEEKDAYS[d.getUTCDay()];
    if (Array.isArray(t.days) && t.days.length && !t.days.includes(day)) return false;
    const hhmm = d.getUTCHours() * 100 + d.getUTCMinutes();
    const start = Number(t.start ?? 0);
    const end = Number(t.end) || 2400;
    return hhmm >= start && hhmm < end;
  }
  // 长度档
  const from = t.inputFrom ?? 0;
  const to = t.inputTo ?? -1;
  return inputTokens >= from && (to < 0 || inputTokens <= to);
}

const nz = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 计算一次请求的积分消耗。
 * @param {object} p
 * @param {Array}  p.tiers        价格阶梯（来自模型探测结果）
 * @param {number} p.promptTokens 输入 token 总数
 * @param {number} p.cachedTokens 其中命中缓存的
 * @param {number} p.cacheWriteTokens 写入缓存的（按 input_price 计，因为也走了模型）
 * @param {number} p.completionTokens 输出 token
 * @param {number} [p.epochSec]   请求时刻（秒），有时段档才需要
 * @param {number} [p.markup]     加价倍率（1 = 不加价）
 * @returns {{credit:number|null, tier:object|null, breakdown:object}}
 */
export function computeCost({
  tiers,
  promptTokens = 0,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  completionTokens = 0,
  epochSec,
  markup = 1,
} = {}) {
  const tier = pickTier(tiers, promptTokens, epochSec);
  if (!tier) return { credit: null, tier: null, breakdown: null };

  const prompt = nz(promptTokens);
  const cached = Math.min(nz(cachedTokens), prompt);
  const cacheWrite = Math.min(nz(cacheWriteTokens), Math.max(0, prompt - cached));
  const completion = nz(completionTokens);

  // 未命中缓存的输入
  const missInput = Math.max(0, prompt - cached);
  const inputPrice = nz(tier.input);
  const cachePrice = nz(tier.cache ?? tier.input);
  const outputPrice = nz(tier.output);

  const inputCredit = (missInput * inputPrice) / PRICE_UNIT;
  const cacheCredit = (cached * cachePrice) / PRICE_UNIT;
  const outputCredit = (completion * outputPrice) / PRICE_UNIT;
  const raw = inputCredit + cacheCredit + outputCredit;
  // 加价倍率（面板可配，1 = 原价）
  const factor = Number.isFinite(Number(markup)) && Number(markup) > 0 ? Number(markup) : 1;
  const credit = raw * factor;

  return {
    credit,
    tier,
    breakdown: {
      // token 数
      promptTokens: prompt,
      cachedTokens: cached,
      missInputTokens: missInput,
      cacheWriteTokens: cacheWrite,
      completionTokens: completion,
      // 单价（积分/千 token）
      inputPrice,
      cachePrice,
      outputPrice,
      // 分项积分（未加价）
      inputCredit,
      cacheCredit,
      outputCredit,
      rawCredit: raw,
      markup: factor,
      // 省下的积分（缓存带来的）
      savedCredit: (cached * (inputPrice - cachePrice)) / PRICE_UNIT,
    },
  };
}

/** 从模型清单里按 id 找价格阶梯（兼容 name / alias） */
export function findModelPrice(models, modelId) {
  if (!Array.isArray(models) || !modelId) return null;
  const hit =
    models.find((m) => m.id === modelId) ??
    models.find((m) => m.name === modelId) ??
    models.find((m) => m.alias === modelId);
  return hit?.tiers ?? null;
}

/** 汇总一批用量记录的积分 */
export function sumCredit(rows) {
  let total = 0;
  let known = 0;
  let unknown = 0;
  for (const r of rows ?? []) {
    if (typeof r?.credit === 'number' && Number.isFinite(r.credit)) {
      total += r.credit;
      known++;
    } else {
      unknown++;
    }
  }
  return { credit: total, known, unknown };
}
