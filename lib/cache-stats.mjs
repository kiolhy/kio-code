// 缓存统计：把各家 usage 里五花八门的「缓存命中」字段归一化
//
// 上游（inferhub / 各 provider）可能返回这些形状中的任意一种：
//   usage.prompt_tokens_details.cached_tokens        OpenAI
//   usage.input_tokens_details.cached_tokens         OpenAI（responses）
//   usage.cached_tokens                              简写
//   usage.prompt_cache_hit_tokens / _miss_tokens     DeepSeek
//   usage.cache_read_input_tokens                    Anthropic（读缓存 = 命中）
//   usage.cache_creation_input_tokens                Anthropic（写缓存，不算命中）
//   usage.cache.{cached,hit,miss}                    自定义嵌套
//   usage.prompt_cache.{hit,miss}                    自定义嵌套

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

const pick = (cands) => {
  for (const [path, v] of cands) {
    const n = num(v);
    if (n != null && n >= 0) return { value: n, path };
  }
  return { value: null, path: null };
};

/**
 * @param {object} usage 上游返回的 usage 对象
 * @returns {{promptTokens:number, cachedTokens:number, cacheWriteTokens:number,
 *            missTokens:number, hitRatio:number, cachePath:string|null}}
 */
export function extractCache(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};

  const promptTokens =
    num(u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? u.inputTokens ?? 0) ?? 0;

  const hit = pick([
    ['prompt_tokens_details.cached_tokens', u.prompt_tokens_details?.cached_tokens],
    ['input_tokens_details.cached_tokens', u.input_tokens_details?.cached_tokens],
    ['prompt_cache_hit_tokens', u.prompt_cache_hit_tokens],
    ['cached_tokens', u.cached_tokens],
    ['cachedTokens', u.cachedTokens],
    ['cache_read_input_tokens', u.cache_read_input_tokens],
    ['cache_hit_tokens', u.cache_hit_tokens],
    ['cache.cached', u.cache?.cached],
    ['cache.hit', u.cache?.hit],
    ['prompt_cache.hit', u.prompt_cache?.hit],
    ['prompt_cache_hit', u.prompt_cache_hit],
  ]);

  const write = pick([
    ['cache_creation_input_tokens', u.cache_creation_input_tokens],
    ['cache_write_tokens', u.cache_write_tokens],
    ['cache.write', u.cache?.write],
    ['prompt_cache_write', u.prompt_cache_write],
  ]);

  const missGiven = pick([
    ['prompt_cache_miss_tokens', u.prompt_cache_miss_tokens],
    ['cache.miss', u.cache?.miss],
    ['prompt_cache.miss', u.prompt_cache?.miss],
    ['prompt_cache_miss', u.prompt_cache_miss],
  ]);

  const cachedTokens = hit.value ?? 0;
  const cacheWriteTokens = write.value ?? 0;
  const missTokens = missGiven.value ?? Math.max(0, promptTokens - cachedTokens);
  const denom = promptTokens > 0 ? promptTokens : cachedTokens + missTokens;
  const hitRatio = denom > 0 ? cachedTokens / denom : 0;

  return {
    promptTokens,
    cachedTokens,
    cacheWriteTokens,
    missTokens,
    hitRatio,
    cachePath: hit.path,
  };
}

/** 百分比，保留一位小数；分母为 0 时返回 null（前端显示 —） */
export function ratioPct(part, whole) {
  if (!whole || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** 聚合一批行，返回缓存相关的汇总 */
export function summarizeCache(rows = []) {
  let prompt = 0;
  let cached = 0;
  let write = 0;
  for (const r of rows) {
    prompt += r.promptTokens ?? 0;
    cached += r.cachedTokens ?? 0;
    write += r.cacheWriteTokens ?? 0;
  }
  return {
    promptTokens: prompt,
    cachedTokens: cached,
    cacheWriteTokens: write,
    hitRatio: prompt > 0 ? cached / prompt : 0,
    hitPct: ratioPct(cached, prompt),
  };
}
