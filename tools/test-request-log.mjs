// 请求日志（分页 + 筛选 + 汇总）单测。
// 直接测 panel.requestLog()，不依赖 HTTP。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPanel } from '../lib/panel.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-reqlog-'));
fs.mkdirSync(path.join(dir, 'data'), { recursive: true });

// recordUsage 一律按账号探测到的模型价格重算 credit（不认传入值），
// 所以这里得给三个模型都配上价格，否则 credit 全是 null。
const tier = (input, cache, output) => [{
  inputFrom: 0, inputTo: -1, outputFrom: 0, outputTo: -1, input, cache, output,
}];
const priceInfo = (id, tiers) => ({ models: [{ id, name: id, alias: id, tiers }] });

fs.writeFileSync(
  path.join(dir, 'data', 'settings.json'),
  JSON.stringify({
    panel: { password: null, changed: false },
    accounts: [{
      id: 'acc1', name: '账号A', enabled: true, region: 'cn',
      accessKeyId: 'AKTEST', secretAccessKey: 'SKTEST', securityToken: 'TOK',
      info: {
        models: [
          { id: 'GLM-5.2', name: 'GLM-5.2', alias: 'GLM-5.2', tiers: tier(8, 2, 28) },
          { id: 'kimi-k3', name: 'kimi-k3', alias: 'kimi-k3', tiers: tier(20, 2, 100) },
          { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', alias: 'deepseek-v4.1-flash', tiers: tier(2, 0.2, 8) },
        ],
      },
    }],
    apiKeys: [], proxies: [], settings: {},
  })
);

const panel = createPanel({ dataDir: path.join(dir, 'data') });

// 造 12 条流水：3 个模型 × 2 个账号，其中 2 条失败
const now = Date.now();
const mk = (i, over = {}) => ({
  ts: new Date(now - (12 - i) * 60000).toISOString(),
  keyId: 'k1', keyName: '测试Key',
  accountId: 'acc1', accountName: i % 2 ? '账号A' : '账号B',
  model: ['GLM-5.2', 'kimi-k3', 'deepseek-v4.1-flash'][i % 3],
  route: 'gateway.chat',
  status: 200,
  promptTokens: 100 + i * 10,
  completionTokens: 50 + i * 5,
  cachedTokens: i * 8,
  cacheWriteTokens: 0,
  cacheRatio: 0,
  cacheSource: null,
  estimated: false,
  credit: 1.5 + i * 0.25,
  creditBreakdown: { savedCredit: 0.3 * i },
  creditTier: null,
  stream: false,
  durMs: 1000 + i * 100,
  ...over,
});

for (let i = 0; i < 12; i++) {
  panel.recordUsage(mk(i, i === 4 || i === 9 ? { status: 500, credit: null, creditBreakdown: null } : {}));
}

console.log('\n\x1b[1m[1] 基本分页\x1b[0m');
{
  const r = panel.requestLog({ range: 'all', size: 5, page: 1 });
  ok('总数 12', r.total === 12, String(r.total));
  ok('每页 5 条', r.rows.length === 5, String(r.rows.length));
  ok('共 3 页', r.pages === 3, String(r.pages));
  ok('当前第 1 页', r.page === 1);

  const p2 = panel.requestLog({ range: 'all', size: 5, page: 2 });
  ok('第 2 页 5 条', p2.rows.length === 5);
  ok('第 2 页与第 1 页不重叠', p2.rows[0].ts !== r.rows[0].ts);

  const p3 = panel.requestLog({ range: 'all', size: 5, page: 3 });
  ok('第 3 页 2 条', p3.rows.length === 2, String(p3.rows.length));

  const over = panel.requestLog({ range: 'all', size: 5, page: 99 });
  ok('页码越界钳到最后一页', over.page === 3, String(over.page));

  const zero = panel.requestLog({ range: 'all', size: 5, page: 0 });
  ok('页码 0 钳到第 1 页', zero.page === 1);

  const huge = panel.requestLog({ range: 'all', size: 9999 });
  ok('每页上限 500', huge.size === 500, String(huge.size));
}

console.log('\n\x1b[1m[2] 每条的消耗金额与缓存百分比\x1b[0m');
{
  const r = panel.requestLog({ range: 'all', size: 100, sort: 'ts', order: 'asc' });
  const row = r.rows[0];
  ok('有 credit 字段', typeof row.credit === 'number', String(row.credit));
  ok('credit 保留 4 位小数', String(row.credit).split('.')[1]?.length <= 4, String(row.credit));
  ok('有 promptTokens', row.promptTokens === 100, String(row.promptTokens));
  ok('有 completionTokens', row.completionTokens === 50, String(row.completionTokens));
  ok('有 cachedTokens', row.cachedTokens === 0, String(row.cachedTokens));
  ok('有 totalTokens', row.totalTokens === 150, String(row.totalTokens));
  ok('cachePct 是数字', row.cachePct === 0, String(row.cachePct));
  ok('有 creditSaved', typeof row.creditSaved === 'number', String(row.creditSaved));

  // 第 5 条 cached=32 prompt=140 → 22.857…% → ratioPct 保留 1 位 = 22.9
  const r5 = r.rows[4];
  ok('缓存百分比按 token 加权', r5.cachePct === 22.9, String(r5.cachePct));
  ok('cacheRatio 是小数', Math.abs(r5.cacheRatio - 32 / 140) < 1e-9, String(r5.cacheRatio));

  // credit 按模型价格算，跟状态码无关（失败请求也消耗了输入 token）
  const failed = r.rows.find((x) => x.status === 500);
  ok('失败行仍记录 token', failed?.promptTokens > 0);
  ok('失败行也按 token 算积分', typeof failed?.credit === 'number', String(failed?.credit));
}

console.log('\n\x1b[1m[3] 汇总（按筛选后的集合算）\x1b[0m');
{
  const all = panel.requestLog({ range: 'all', size: 10 });
  ok('汇总请求数 = 总数', all.summary.requests === 12, String(all.summary.requests));
  ok('汇总统计失败数', all.summary.errors === 2, String(all.summary.errors));
  ok('汇总 credit 有值', all.summary.credit > 0, String(all.summary.credit));
  ok('汇总 creditKnown = 全部条数', all.summary.creditKnown === 12, String(all.summary.creditKnown));
  ok('汇总 cachePct 是数字', typeof all.summary.cachePct === 'number', String(all.summary.cachePct));
  ok('汇总 totalTokens = 入 + 出',
    all.summary.totalTokens === all.summary.promptTokens + all.summary.completionTokens);
  ok('汇总有 creditPerKTok', all.summary.creditPerKTok > 0, String(all.summary.creditPerKTok));
  ok('汇总有 avgDurMs', all.summary.avgDurMs > 0, String(all.summary.avgDurMs));

  // 缓存百分比是 token 加权，不是各条平均
  const expectRatio = all.summary.cachedTokens / all.summary.promptTokens;
  ok('汇总缓存百分比 = Σ命中/Σ输入',
    Math.abs(all.summary.cachePct - expectRatio * 100) < 0.05,
    `${all.summary.cachePct} vs ${(expectRatio * 100).toFixed(2)}`);
}

console.log('\n\x1b[1m[4] 筛选\x1b[0m');
{
  const byModel = panel.requestLog({ range: 'all', model: 'GLM-5.2', size: 100 });
  ok('按模型筛出 4 条', byModel.total === 4, String(byModel.total));
  ok('筛出来的都是该模型', byModel.rows.every((r) => r.model === 'GLM-5.2'));
  ok('汇总跟着筛', byModel.summary.requests === 4, String(byModel.summary.requests));

  const byAcc = panel.requestLog({ range: 'all', account: '账号A', size: 100 });
  ok('按账号筛出 6 条', byAcc.total === 6, String(byAcc.total));
  ok('筛出来的都是该账号', byAcc.rows.every((r) => r.accountName === '账号A'));

  const byKey = panel.requestLog({ range: 'all', key: '测试Key', size: 100 });
  ok('按 Key 筛出 12 条', byKey.total === 12, String(byKey.total));

  const errs = panel.requestLog({ range: 'all', status: 'error', size: 100 });
  ok('status=error 筛出 2 条', errs.total === 2, String(errs.total));
  ok('筛出来的都是失败', errs.rows.every((r) => r.status >= 400));

  const oks = panel.requestLog({ range: 'all', status: 'ok', size: 100 });
  ok('status=ok 筛出 10 条', oks.total === 10, String(oks.total));

  const code = panel.requestLog({ range: 'all', status: '500', size: 100 });
  ok('按状态码筛出 2 条', code.total === 2, String(code.total));

  const q = panel.requestLog({ range: 'all', q: 'kimi', size: 100 });
  ok('关键词搜模型', q.total === 4, String(q.total));

  const q2 = panel.requestLog({ range: 'all', q: '账号B', size: 100 });
  ok('关键词搜账号', q2.total === 6, String(q2.total));

  const none = panel.requestLog({ range: 'all', model: '不存在', size: 100 });
  ok('筛不到时 0 条', none.total === 0);
  ok('筛不到时 pages 至少 1', none.pages === 1, String(none.pages));
  ok('筛不到时 rows 为空', none.rows.length === 0);
  ok('筛不到时汇总为 0', none.summary.requests === 0);
}

console.log('\n\x1b[1m[5] 排序\x1b[0m');
{
  const byCredit = panel.requestLog({ range: 'all', sort: 'credit', order: 'desc', size: 100 });
  const credits = byCredit.rows.map((r) => r.credit).filter((c) => c != null);
  ok('按积分降序', credits.every((c, i) => i === 0 || credits[i - 1] >= c), credits.slice(0, 3).join(','));

  const asc = panel.requestLog({ range: 'all', sort: 'credit', order: 'asc', size: 100 });
  const ascCredits = asc.rows.map((r) => r.credit).filter((c) => c != null);
  ok('按积分升序', ascCredits.every((c, i) => i === 0 || ascCredits[i - 1] <= c), ascCredits.slice(0, 3).join(','));

  const byDur = panel.requestLog({ range: 'all', sort: 'durMs', order: 'desc', size: 100 });
  ok('按耗时降序', byDur.rows[0].durMs >= byDur.rows[1].durMs,
    `${byDur.rows[0].durMs} vs ${byDur.rows[1].durMs}`);

  const byTok = panel.requestLog({ range: 'all', sort: 'totalTokens', order: 'desc', size: 100 });
  ok('按 token 降序', byTok.rows[0].totalTokens >= byTok.rows[1].totalTokens);

  const byCache = panel.requestLog({ range: 'all', sort: 'cachePct', order: 'desc', size: 100 });
  const pcts = byCache.rows.map((r) => r.cachePct);
  ok('按缓存比例降序', pcts.every((p, i) => i === 0 || pcts[i - 1] >= p), pcts.slice(0, 3).join(','));

  const byTs = panel.requestLog({ range: 'all', sort: 'ts', order: 'desc', size: 100 });
  const tsList = byTs.rows.map((r) => new Date(r.ts).getTime());
  ok('按时间降序', tsList.every((t, i) => i === 0 || tsList[i - 1] >= t));

  const bad = panel.requestLog({ range: 'all', sort: 'nonsense', size: 5 });
  ok('未知排序字段回落成时间', bad.rows.length === 5);
}

console.log('\n\x1b[1m[6] 筛选项候选\x1b[0m');
{
  const r = panel.requestLog({ range: 'all', model: 'GLM-5.2', size: 5 });
  ok('候选模型有 3 个', r.facets.models.length === 3, r.facets.models.join(','));
  ok('候选账号有 2 个', r.facets.accounts.length === 2, r.facets.accounts.join(','));
  ok('候选 Key 有 1 个', r.facets.keys.length === 1, r.facets.keys.join(','));
  // 候选是全量的，不随当前筛选变少
  ok('候选不受当前筛选影响', r.facets.models.length === 3, String(r.facets.models.length));
}

console.log('\n\x1b[1m[7] 时间范围\x1b[0m');
{
  const today = panel.requestLog({ range: 'today', size: 100 });
  ok('今日能查到刚写的', today.total === 12, String(today.total));

  const future = panel.requestLog({ range: 'custom', from: '2099-01-01', to: '2099-01-02', size: 100 });
  ok('未来区间 0 条', future.total === 0, String(future.total));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
