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

/** 选档：按输入 token 数匹配 input_from..input_to */
export function pickTier(tiers, inputTokens) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const n = Number(inputTokens) || 0;
  for (const t of tiers) {
    const from = t.inputFrom ?? 0;
    const to = t.inputTo ?? -1;
    if (n >= from && (to < 0 || n <= to)) return t;
  }
  // 超出所有档位 → 用最后一档
  return tiers[tiers.length - 1];
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
 * @returns {{credit:number|null, tier:object|null, breakdown:object}}
 */
export function computeCost({ tiers, promptTokens = 0, cachedTokens = 0, cacheWriteTokens = 0, completionTokens = 0 } = {}) {
  const tier = pickTier(tiers, promptTokens);
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
  const credit = inputCredit + cacheCredit + outputCredit;

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
      // 分项积分
      inputCredit,
      cacheCredit,
      outputCredit,
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
