// 缓存统计：各家用例归一化 + 落库 + 聚合比例
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractCache, ratioPct, summarizeCache } from '../lib/cache-stats.mjs';
import { createPanel } from '../lib/panel.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

console.log('\n\x1b[1m[1] 各家 usage 形状归一化\x1b[0m');
{
  const cases = [
    ['OpenAI chat', { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } }, 800, 'prompt_tokens_details.cached_tokens'],
    ['OpenAI responses', { input_tokens: 500, output_tokens: 10, input_tokens_details: { cached_tokens: 300 } }, 300, 'input_tokens_details.cached_tokens'],
    ['简写 cached_tokens', { prompt_tokens: 200, cached_tokens: 50 }, 50, 'cached_tokens'],
    ['DeepSeek hit', { prompt_tokens: 900, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 300 }, 600, 'prompt_cache_hit_tokens'],
    ['Anthropic read', { input_tokens: 400, cache_read_input_tokens: 250, cache_creation_input_tokens: 100 }, 250, 'cache_read_input_tokens'],
    ['嵌套 cache', { prompt_tokens: 100, cache: { cached: 40 } }, 40, 'cache.cached'],
    ['嵌套 prompt_cache', { prompt_tokens: 100, prompt_cache: { hit: 25 } }, 25, 'prompt_cache.hit'],
    ['驼峰 cachedTokens', { promptTokens: 80, cachedTokens: 20 }, 20, 'cachedTokens'],
  ];
  for (const [name, usage, expect, expectPath] of cases) {
    const c = extractCache(usage);
    ok(name, c.cachedTokens === expect, `cached=${c.cachedTokens} path=${c.cachePath}`);
    ok(`${name} 识别到字段路径`, c.cachePath === expectPath, String(c.cachePath));
  }
  ok('没有缓存字段时归零', extractCache({ prompt_tokens: 100 }).cachedTokens === 0);
  ok('usage 为 null 不炸', extractCache(null).cachedTokens === 0);
}

console.log('\n\x1b[1m[2] 比例与写入缓存\x1b[0m');
{
  const c = extractCache({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } });
  ok('命中比例 = 0.8', Math.abs(c.hitRatio - 0.8) < 1e-9, String(c.hitRatio));
  ok('未命中 = 输入 - 命中', c.missTokens === 200, String(c.missTokens));
  ok('显式 miss 优先', extractCache({ prompt_tokens: 900, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 111 }).missTokens === 111);

  const w = extractCache({ input_tokens: 400, cache_read_input_tokens: 250, cache_creation_input_tokens: 100 });
  ok('写入缓存单独记录', w.cacheWriteTokens === 100, String(w.cacheWriteTokens));
  ok('写入不算命中', w.cachedTokens === 250, String(w.cachedTokens));

  ok('ratioPct 一位小数', ratioPct(1, 3) === 33.3, String(ratioPct(1, 3)));
  ok('ratioPct 分母 0 → null', ratioPct(5, 0) === null);

  const s = summarizeCache([
    { promptTokens: 100, cachedTokens: 80, cacheWriteTokens: 10 },
    { promptTokens: 900, cachedTokens: 100, cacheWriteTokens: 0 },
  ]);
  ok('汇总命中率 = 180/1000', Math.abs(s.hitRatio - 0.18) < 1e-9, String(s.hitRatio));
  ok('汇总写入缓存', s.cacheWriteTokens === 10, String(s.cacheWriteTokens));
}

console.log('\n\x1b[1m[3] 落库与聚合（真实 panel）\x1b[0m');
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
  const panel = createPanel({ dataDir });
  panel.load();

  const r1 = panel.recordUsage({
    model: 'glm-4.6', promptTokens: 1000, completionTokens: 50,
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
    durMs: 100, status: 200,
  });
  ok('单条记录带 cachedTokens', r1.cachedTokens === 800, String(r1.cachedTokens));
  ok('单条记录带缓存比例', Math.abs(r1.cacheRatio - 0.8) < 1e-9, String(r1.cacheRatio));
  ok('记录缓存字段来源', r1.cacheSource === 'prompt_tokens_details.cached_tokens', String(r1.cacheSource));

  panel.recordUsage({
    model: 'glm-4.6', promptTokens: 1000, completionTokens: 60,
    usage: { prompt_tokens: 1000, completion_tokens: 60, prompt_cache_hit_tokens: 200 },
    durMs: 120, status: 200,
  });
  panel.recordUsage({
    model: 'deepseek-v3.2', promptTokens: 500, completionTokens: 30,
    usage: { prompt_tokens: 500, completion_tokens: 30 },
    durMs: 90, status: 200,
  });

  const agg = panel.aggregate({ range: 'all' });
  ok('全局命中 token = 1000', agg.kpi.cachedTokens === 1000, String(agg.kpi.cachedTokens));
  ok('全局输入 token = 2500', agg.kpi.promptTokens === 2500, String(agg.kpi.promptTokens));
  ok('全局缓存比例 = 40%', agg.kpi.cachePct === 40, String(agg.kpi.cachePct));
  ok('全局 cacheRatio 同步', Math.abs(agg.kpi.cacheRatio - 0.4) < 1e-9, String(agg.kpi.cacheRatio));

  const glm = agg.models.find((m) => m.name === 'glm-4.6');
  ok('单模型命中 token = 1000', glm?.cachedTokens === 1000, String(glm?.cachedTokens));
  ok('单模型缓存比例 = 50%', glm?.cachePct === 50, String(glm?.cachePct));
  const ds = agg.models.find((m) => m.name === 'deepseek-v3.2');
  ok('无缓存模型比例 = 0%', ds?.cachePct === 0, String(ds?.cachePct));

  ok('流水每条都带缓存比例', agg.recent.every((r) => typeof r.cachePct === 'number' || r.cachePct === null));
  const first = agg.recent.find((r) => r.model === 'glm-4.6' && r.cachedTokens === 800);
  ok('流水单条比例 = 80%', first?.cachePct === 80, String(first?.cachePct));

  // 重启后从 usage.jsonl 读回来仍在
  const panel2 = createPanel({ dataDir });
  panel2.load();
  const agg2 = panel2.aggregate({ range: 'all' });
  ok('重启后缓存统计仍在', agg2.kpi.cachedTokens === 1000 && agg2.kpi.cachePct === 40, `${agg2.kpi.cachedTokens}/${agg2.kpi.cachePct}`);

  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
