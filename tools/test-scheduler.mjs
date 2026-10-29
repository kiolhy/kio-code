// 调度器：四级退避 / 平滑加权轮询 / 会话粘性 / 模型级冷却
import {
  exponentialBackoff, softBackoff, unverifiedSoftBackoff, breakerBackoff, degradeBackoff,
  classifyFailure, parseResetAt, BACKOFF,
  runtimeOf, throttleWait, isReady, noteFailure, noteSuccess, clearCooldown,
  createSessionAffinity, smoothWeightedPick, pickAccount, scheduleSnapshot,
} from '../lib/scheduler.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

const mkAcc = (id, extra = {}) => ({ id, name: id, enabled: true, ...extra });

console.log('\n\x1b[1m[1] 指数退避\x1b[0m');
{
  ok('base*2^0', exponentialBackoff(1, 600, 7200, 1) === 600, String(exponentialBackoff(1, 600, 7200, 1)));
  ok('base*2^1', exponentialBackoff(2, 600, 7200, 1) === 1200, String(exponentialBackoff(2, 600, 7200, 1)));
  ok('base*2^2', exponentialBackoff(3, 600, 7200, 1) === 2400);
  ok('夹到 cap', exponentialBackoff(10, 600, 7200, 1) === 7200, String(exponentialBackoff(10, 600, 7200, 1)));
  ok('count < offset 不出负数', exponentialBackoff(0, 600, 7200, 1) === 600);

  ok('软限流 1 次 = 600s', softBackoff(1) === 600);
  ok('软限流 4 次 = 4800s', softBackoff(4) === 4800, String(softBackoff(4)));
  ok('软限流封顶 7200s', softBackoff(20) === 7200);
  ok('未验证软限流 1 次 = 60s', unverifiedSoftBackoff(1) === 60);
  ok('未验证封顶 600s', unverifiedSoftBackoff(20) === 600);
  ok('熔断 3 次 = 1800s', breakerBackoff(3) === 1800, String(breakerBackoff(3)));
  ok('熔断封顶 21600s', breakerBackoff(30) === 21600);
  ok('降级 5 次 = 600s', degradeBackoff(5) === 600, String(degradeBackoff(5)));
}

console.log('\n\x1b[1m[2] 错误分类\x1b[0m');
{
  ok('401 → auth', classifyFailure({ status: 401 }) === 'auth');
  ok('403 → auth', classifyFailure({ status: 403 }) === 'auth');
  ok('token expired 文案 → auth', classifyFailure({ message: 'token has expired' }) === 'auth');
  ok('402 → quota', classifyFailure({ status: 402 }) === 'quota');
  ok('额度不足 → quota', classifyFailure({ message: '余额不足' }) === 'quota');
  ok('429 账号级 → soft', classifyFailure({ status: 429 }) === 'soft');
  ok('429 模型级 → soft_unverified', classifyFailure({ status: 429, modelScoped: true }) === 'soft_unverified');
  ok('限流文案 → soft', classifyFailure({ message: 'rate limit exceeded' }) === 'soft');
  ok('500 → hard', classifyFailure({ status: 500 }) === 'hard');
  ok('502 → hard', classifyFailure({ status: 502 }) === 'hard');
  ok('网络错误 → hard', classifyFailure({ message: 'socket hang up' }) === 'hard');
  ok('其他 → unknown', classifyFailure({ status: 400, message: 'bad request' }) === 'unknown');
}

console.log('\n\x1b[1m[3] 重置时刻解析\x1b[0m');
{
  const now = Date.now() / 1000;
  const a = parseResetAt({ headers: { 'retry-after': '120' } });
  ok('Retry-After 秒数', Math.abs(a - (now + 120)) < 3, String(a - now));

  const b = parseResetAt({ body: { reset_at: now + 3600 } });
  ok('body.reset_at', Math.abs(b - (now + 3600)) < 3, String(b - now));

  const c = parseResetAt({ body: JSON.stringify({ data: { resetAt: now + 1800 } }) });
  ok('body 字符串 + data.resetAt', Math.abs(c - (now + 1800)) < 3);

  const d = parseResetAt({ body: { reset_at: (now + 600) * 1000 } });
  ok('毫秒自动转秒', Math.abs(d - (now + 600)) < 3, String(d - now));

  ok('抠不到返回 0', parseResetAt({ headers: {}, body: {} }) === 0);
  ok('空入参返回 0', parseResetAt() === 0);
}

console.log('\n\x1b[1m[4] 四级退避生效\x1b[0m');
{
  const a = mkAcc('a1');
  ok('初始可用', isReady(a, 'M1') === true);
  ok('初始无等待', throttleWait(a, 'M1') === 0);

  // 软限流
  const r1 = noteFailure(a, { status: 429, message: 'rate limit', model: 'M1' });
  ok('429 归类 soft', r1.kind === 'soft', r1.kind);
  ok('429 后不可用', isReady(a, 'M1') === false);
  ok('429 冷却约 600s', Math.abs(r1.wait - 600) < 2, String(r1.wait));
  ok('账号级冷却影响所有模型', isReady(a, 'M2') === false);

  // 成功清掉
  noteSuccess(a, 'M1');
  ok('成功后恢复', isReady(a, 'M1') === true);
  ok('成功后计数器归零', runtimeOf(a).softStreak === 0);

  // 硬失败熔断
  const b = mkAcc('b1');
  noteFailure(b, { status: 500, message: 'boom' });
  noteFailure(b, { status: 500, message: 'boom' });
  ok('2 次硬失败还没熔断', isReady(b) === true, String(runtimeOf(b).fails));
  const r2 = noteFailure(b, { status: 500, message: 'boom' });
  ok('3 次硬失败熔断', isReady(b) === false);
  ok('熔断 1800s', Math.abs(r2.wait - 1800) < 2, String(r2.wait));

  // 未知错误降级（注意：未知错误同时累加 fails，所以熔断会先触发）
  const c = mkAcc('c1');
  for (let i = 0; i < 2; i++) noteFailure(c, { status: 400, message: 'weird' });
  ok('2 次未知还可用', isReady(c) === true, `degrade=${runtimeOf(c).degradeCount} fails=${runtimeOf(c).fails}`);
  ok('2 次未知未降级', runtimeOf(c).degradeUntil === 0);
  const r3 = noteFailure(c, { status: 400, message: 'weird' });
  ok('3 次未知触发熔断（fails 共用计数器）', isReady(c) === false);
  ok('熔断 1800s', Math.abs(r3.wait - 1800) < 2, String(r3.wait));

  // 降级单独验证：手动把 fails 压住，只看 degradeCount
  const c2 = mkAcc('c2');
  for (let i = 0; i < 5; i++) {
    runtimeOf(c2).fails = 0; // 每次先清零，隔离熔断
    noteFailure(c2, { status: 400, message: 'weird' });
  }
  ok('5 次未知触发降级', runtimeOf(c2).degradeUntil > 0, String(runtimeOf(c2).degradeUntil));
  ok('降级后不可用', isReady(c2) === false);

  // 鉴权失效
  const d = mkAcc('d1');
  noteFailure(d, { status: 401, message: 'unauthorized' });
  ok('401 后不可用', isReady(d) === false);
  ok('tokenExpired 标记', runtimeOf(d).tokenExpired === true);

  // 配额耗尽
  const e = mkAcc('e1');
  noteFailure(e, { status: 402, message: 'insufficient balance' });
  ok('402 后不可用', isReady(e) === false);
  ok('余额冷却约 1h', Math.abs(throttleWait(e) - 3600) < 5, String(throttleWait(e)));

  // 手动清冷却
  clearCooldown(a);
  ok('手动清冷却后可用', isReady(a, 'M1') === true);
}

console.log('\n\x1b[1m[5] 模型级冷却（一个模型耗尽不拖死账号）\x1b[0m');
{
  const a = mkAcc('m1');
  noteFailure(a, { status: 429, message: 'rate limit', model: 'GLM-5.2', modelScoped: true });
  ok('GLM-5.2 不可用', isReady(a, 'GLM-5.2') === false);
  ok('Kimi-K3 仍可用', isReady(a, 'Kimi-K3') === true);
  ok('账号整体没被停', runtimeOf(a).cooldownUntil === 0, String(runtimeOf(a).cooldownUntil));
  ok('模型冷却记录存在', runtimeOf(a).modelCooldowns['GLM-5.2'] > 0);

  noteSuccess(a, 'GLM-5.2');
  ok('成功后该模型恢复', isReady(a, 'GLM-5.2') === true);

  // 未验证软限流从 60s 起
  const b = mkAcc('m2');
  const r = noteFailure(b, { status: 429, message: 'rl', model: 'M', modelScoped: true });
  ok('未验证软限流 60s', Math.abs(r.wait - 60) < 2, String(r.wait));
  noteFailure(b, { status: 429, message: 'rl', model: 'M', modelScoped: true });
  ok('第二次 120s', Math.abs(throttleWait(b, 'M') - 120) < 3, String(throttleWait(b, 'M')));
}

console.log('\n\x1b[1m[6] 平滑加权轮询\x1b[0m');
{
  const a = mkAcc('w1');
  const b = mkAcc('w2');
  const c = mkAcc('w3');
  const entries = [
    { account: a, weight: 1 },
    { account: b, weight: 1 },
    { account: c, weight: 1 },
  ];
  const picks = [];
  for (let i = 0; i < 6; i++) picks.push(smoothWeightedPick(entries)?.id);
  ok('等权退化成轮询', picks.join(',') === 'w1,w2,w3,w1,w2,w3', picks.join(','));

  // 权重 3:1:0 → 3:1 分配
  const a2 = mkAcc('x1');
  const b2 = mkAcc('x2');
  const e2 = [{ account: a2, weight: 3 }, { account: b2, weight: 1 }];
  const p2 = [];
  for (let i = 0; i < 8; i++) p2.push(smoothWeightedPick(e2)?.id);
  const n1 = p2.filter((x) => x === 'x1').length;
  const n2 = p2.filter((x) => x === 'x2').length;
  ok('权重 3:1 → 6:2', n1 === 6 && n2 === 2, `${n1}:${n2}`);

  ok('空列表返回 null', smoothWeightedPick([]) === null);
}

console.log('\n\x1b[1m[7] 会话粘性\x1b[0m');
{
  const aff = createSessionAffinity({ ttlMs: 60000, history: 3 });
  ok('未绑定返回 null', aff.get('s1') === null);

  aff.bind('s1', 'acc-a');
  ok('绑定后能取回', aff.get('s1') === 'acc-a');
  ok('recent 有 1 条', aff.recent('s1').join(',') === 'acc-a');

  aff.bind('s1', 'acc-b');
  ok('新绑定排最前', aff.get('s1') === 'acc-b');
  ok('历史保留两个', aff.recent('s1').join(',') === 'acc-b,acc-a', aff.recent('s1').join(','));

  aff.demote('s1', 'acc-b');
  ok('降级后回到上一个', aff.get('s1') === 'acc-a');
  ok('被降级的还在历史里', aff.recent('s1').includes('acc-a'));

  aff.bind('s1', 'acc-c');
  aff.bind('s1', 'acc-d');
  ok('历史最多 3 条', aff.recent('s1').length <= 3, String(aff.recent('s1').length));

  const aff2 = createSessionAffinity({ ttlMs: -1 });
  aff2.bind('s2', 'x');
  ok('过期后取不到', aff2.get('s2') === null);
}

console.log('\n\x1b[1m[8] pickAccount 完整链路\x1b[0m');
{
  const a = mkAcc('p1');
  const b = mkAcc('p2');
  const c = mkAcc('p3');
  const accounts = [a, b, c];
  const aff = createSessionAffinity({ ttlMs: 60000 });

  // 无会话：轮询
  const r1 = pickAccount({ accounts });
  ok('无会话时能选到', r1 !== null);
  const seen = new Set();
  for (let i = 0; i < 6; i++) seen.add(pickAccount({ accounts })?.id);
  ok('无会话时轮询覆盖全部', seen.size === 3, [...seen].join(','));

  // 会话粘性
  aff.bind('conv-1', 'p2');
  const r2 = pickAccount({ accounts, sessionKey: 'conv-1', affinity: aff });
  ok('会话粘性命中 p2', r2?.id === 'p2', r2?.id);

  // 粘住的账号不可用 → 退到历史
  noteFailure(b, { status: 429, message: 'rl' });
  aff.bind('conv-1', 'p1');
  aff.bind('conv-1', 'p2');
  const r3 = pickAccount({ accounts, sessionKey: 'conv-1', affinity: aff });
  ok('p2 冷却后不选它', r3?.id !== 'p2', r3?.id);

  // 全部不可用
  noteFailure(a, { status: 429, message: 'rl' });
  noteFailure(c, { status: 429, message: 'rl' });
  const r4 = pickAccount({ accounts });
  ok('全部冷却返回 null', r4 === null);

  // 手动权重优先
  const d = mkAcc('q1');
  const e = mkAcc('q2');
  e.weight = 5;
  runtimeOf(e).weight = 5;
  const picks = [];
  for (let i = 0; i < 6; i++) picks.push(pickAccount({ accounts: [d, e] })?.id);
  const q2n = picks.filter((x) => x === 'q2').length;
  ok('高权重账号拿更多', q2n > 3, `${q2n}/6`);

  // 排除
  const r5 = pickAccount({ accounts: [mkAcc('z1'), mkAcc('z2')], exclude: ['z1'] });
  ok('exclude 生效', r5?.id === 'z2', r5?.id);

  // 指定账号
  const r6 = pickAccount({ accounts, ref: 'p3' });
  ok('指定账号直接返回', r6?.id === 'p3', r6?.id);
  ok('指定不存在的返回 null', pickAccount({ accounts, ref: 'nope' }) === null);

  // 模型级过滤
  const f = mkAcc('f1');
  noteFailure(f, { status: 429, message: 'rl', model: 'GLM-5.2', modelScoped: true });
  ok('该模型不可用时选不到', pickAccount({ accounts: [f], model: 'GLM-5.2' }) === null);
  ok('别的模型仍可选', pickAccount({ accounts: [f], model: 'Kimi-K3' })?.id === 'f1');
}

console.log('\n\x1b[1m[9] 调度快照（给面板）\x1b[0m');
{
  const a = mkAcc('s1');
  a.weight = 3;
  runtimeOf(a).weight = 3;
  noteFailure(a, { status: 429, message: 'rate limit' });
  const s = scheduleSnapshot(a);
  ok('ready=false', s.ready === false);
  ok('weight=3', s.weight === 3);
  ok('waitSec > 0', s.waitSec > 0, String(s.waitSec));
  ok('cooldownSec > 0', s.cooldownSec > 0, String(s.cooldownSec));
  ok('softStreak=1', s.softStreak === 1);
  ok('lastError 记录', s.lastError.includes('rate limit'), s.lastError);
  ok('modelCooldowns 是对象', typeof s.modelCooldowns === 'object');
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
