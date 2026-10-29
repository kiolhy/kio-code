// 计价（按真实模型价格算积分消耗）
import { computeCost, pickTier, findModelPrice, sumCredit, PRICE_UNIT } from '../lib/pricing.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

// 真实价格（2026-10-29 实测）
const GLM = [{ inputFrom: 0, inputTo: -1, outputFrom: 0, outputTo: -1, input: 8, cache: 2, output: 28 }];
const PANGU = [
  { inputFrom: 0, inputTo: 32000, outputFrom: 0, outputTo: -1, input: 3.2, cache: 0.8, output: 14.5 },
  { inputFrom: 32001, inputTo: -1, outputFrom: 0, outputTo: -1, input: 4.8, cache: 1.2, output: 17.6 },
];
const KIMI = [{ inputFrom: 0, inputTo: -1, outputFrom: 0, outputTo: -1, input: 20, cache: 2, output: 100 }];

console.log('\n\x1b[1m[1] 选档\x1b[0m');
{
  ok('单档命中', pickTier(GLM, 1000)?.input === 8);
  ok('阶梯第一档', pickTier(PANGU, 1000)?.input === 3.2, String(pickTier(PANGU, 1000)?.input));
  ok('阶梯边界 32000', pickTier(PANGU, 32000)?.input === 3.2);
  ok('阶梯边界 32001', pickTier(PANGU, 32001)?.input === 4.8, String(pickTier(PANGU, 32001)?.input));
  ok('超上限用最后一档', pickTier(PANGU, 999999)?.input === 4.8);
  ok('空价格返回 null', pickTier(null, 100) === null && pickTier([], 100) === null);
}

console.log('\n\x1b[1m[2] 计价（积分/千 token）\x1b[0m');
{
  ok('单位是 1000', PRICE_UNIT === 1000);

  // 1000 输入（无缓存）+ 500 输出，GLM：8/2/28
  const c1 = computeCost({ tiers: GLM, promptTokens: 1000, completionTokens: 500 });
  // 输入 1000*8/1000 = 8；输出 500*28/1000 = 14 → 22
  ok('1000 入 + 500 出 = 22 积分', Math.abs(c1.credit - 22) < 1e-9, String(c1.credit));
  ok('分项 inputCredit=8', Math.abs(c1.breakdown.inputCredit - 8) < 1e-9, String(c1.breakdown.inputCredit));
  ok('分项 outputCredit=14', Math.abs(c1.breakdown.outputCredit - 14) < 1e-9, String(c1.breakdown.outputCredit));

  // 缓存命中：1000 输入里 800 命中
  const c2 = computeCost({ tiers: GLM, promptTokens: 1000, cachedTokens: 800, completionTokens: 0 });
  // 未命中 200*8/1000=1.6；命中 800*2/1000=1.6 → 3.2
  ok('800 缓存命中后只花 3.2', Math.abs(c2.credit - 3.2) < 1e-9, String(c2.credit));
  ok('省下 4.8 积分', Math.abs(c2.breakdown.savedCredit - 4.8) < 1e-9, String(c2.breakdown.savedCredit));
  ok('未命中 token=200', c2.breakdown.missInputTokens === 200, String(c2.breakdown.missInputTokens));

  // 全命中
  const c3 = computeCost({ tiers: GLM, promptTokens: 1000, cachedTokens: 1000 });
  ok('全命中 = 1000*2/1000 = 2', Math.abs(c3.credit - 2) < 1e-9, String(c3.credit));

  // 阶梯计价：40000 输入走第二档 4.8
  const c4 = computeCost({ tiers: PANGU, promptTokens: 40000, completionTokens: 0 });
  ok('40000 输入走第二档', Math.abs(c4.credit - 192) < 1e-9, String(c4.credit));
  ok('选中的档位正确', c4.tier.input === 4.8);

  // Kimi 贵
  const c5 = computeCost({ tiers: KIMI, promptTokens: 1000, completionTokens: 1000 });
  ok('Kimi 1000入+1000出 = 120', Math.abs(c5.credit - 120) < 1e-9, String(c5.credit));

  // 无价格
  const c6 = computeCost({ tiers: null, promptTokens: 100, completionTokens: 100 });
  ok('无价格 credit=null', c6.credit === null);
  ok('无价格 breakdown=null', c6.breakdown === null);

  // 缓存数超过输入（异常数据）
  const c7 = computeCost({ tiers: GLM, promptTokens: 100, cachedTokens: 999 });
  ok('缓存数被夹到输入数', c7.breakdown.cachedTokens === 100);
  ok('不会出现负的未命中', c7.breakdown.missInputTokens === 0);
}

console.log('\n\x1b[1m[3] 按模型找价格\x1b[0m');
{
  const models = [
    { id: 'GLM-5.2', name: 'GLM-5.2', alias: 'GLM-5.2', tiers: GLM },
    { id: 'kimi-k3', name: 'Kimi-K3', alias: 'kimi-k3', tiers: KIMI },
  ];
  ok('按 id 找到', findModelPrice(models, 'GLM-5.2')?.[0].input === 8);
  ok('按 name 找到', findModelPrice(models, 'Kimi-K3')?.[0].input === 20);
  ok('按 alias 找到', findModelPrice(models, 'kimi-k3')?.[0].input === 20);
  ok('找不到返回 null', findModelPrice(models, 'nope') === null);
  ok('空输入返回 null', findModelPrice(null, 'x') === null);
}

console.log('\n\x1b[1m[4] 汇总\x1b[0m');
{
  const s = sumCredit([{ credit: 1.5 }, { credit: 2.5 }, { credit: null }]);
  ok('合计 4', Math.abs(s.credit - 4) < 1e-9, String(s.credit));
  ok('已知 2 条', s.known === 2);
  ok('未知 1 条', s.unknown === 1);
  ok('空数组', sumCredit([]).credit === 0);
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
