// 配额主动扫描
import { createQuotaScanner, QUOTA } from '../lib/quota-scan.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

const mkAcc = (id) => ({ id, name: id, enabled: true });

/** 可控时钟 */
function clock(start = 1_700_000_000) {
  let t = start;
  return { now: () => t, advance: (s) => { t += s; }, get t() { return t; } };
}

const PAST_FIRST = QUOTA.FIRST_DELAY + QUOTA.FIRST_STAGGER * 8 + 1;

console.log('\n\x1b[1m[1] 首次登记排开\x1b[0m');
{
  const c = clock();
  const q = createQuotaScanner({ now: c.now });
  const accounts = [mkAcc('a'), mkAcc('b')];
  const models = ['M1', 'M2'];

  const due0 = q.dueTargets(accounts, models);
  ok('首次登记立刻有记录', q.size === 4, String(q.size));
  ok('刚登记时不该查', due0.length === 0, String(due0.length));

  c.advance(PAST_FIRST);
  const due1 = q.dueTargets(accounts, models);
  ok('到点后能查到', due1.length > 0, String(due1.length));
  ok('第一条是 a/M1', due1[0].uid === 'a' && due1[0].model === 'M1', `${due1[0].uid}/${due1[0].model}`);
}

console.log('\n\x1b[1m[2] 扫描结果分类\x1b[0m');
{
  const c = clock();
  const responses = {
    'a/M1': { status: 200 },
    'a/M2': { status: 429, resetAt: c.t + 3600 },
    'b/M1': { status: 500, error: 'boom' },
    'b/M2': { status: 200 },
  };
  const q = createQuotaScanner({
    now: c.now,
    probe: async ({ account, model }) => responses[`${account.id}/${model}`],
  });
  const accounts = [mkAcc('a'), mkAcc('b')];
  const models = ['M1', 'M2'];
  q.dueTargets(accounts, models);
  c.advance(PAST_FIRST);

  const r = await q.runDue(accounts, models, { limit: 10 });
  ok('查了 4 条', r.scanned === 4, String(r.scanned));
  ok('2 条正常', r.ok === 2, String(r.ok));
  ok('1 条到限', r.throttled === 1, String(r.throttled));
  ok('1 条失败', r.failed === 1, String(r.failed));

  const snap = q.snapshot();
  const m2 = snap.find((x) => x.uid === 'a' && x.model === 'M2');
  ok('到限记录 lastResult=throttled', m2?.lastResult === 'throttled', m2?.lastResult);
  ok('到限记录有 resetAt', m2?.resetAt > 0, String(m2?.resetAt));
}

console.log('\n\x1b[1m[3] 到限的线不再主动查\x1b[0m');
{
  const c = clock();
  let calls = 0;
  const q = createQuotaScanner({
    now: c.now,
    probe: async () => { calls++; return { status: 429, resetAt: c.t + 3600 }; },
  });
  const accounts = [mkAcc('a')];
  const models = ['M1'];
  q.dueTargets(accounts, models);
  c.advance(PAST_FIRST);

  await q.runDue(accounts, models);
  ok('第一次查了', calls === 1, String(calls));

  c.advance(10);
  const r2 = await q.runDue(accounts, models);
  ok('窗口内不再查', r2.scanned === 0, String(r2.scanned));
  ok('probe 没被再调用', calls === 1, String(calls));

  c.advance(3601);
  const r3 = await q.runDue(accounts, models);
  ok('窗口过后恢复查询', r3.scanned === 1, String(r3.scanned));
  ok('probe 又被调用', calls === 2, String(calls));
}

console.log('\n\x1b[1m[4] 失败重试与放弃\x1b[0m');
{
  const c = clock();
  let calls = 0;
  const q = createQuotaScanner({
    now: c.now,
    probe: async () => { calls++; return { status: 500, error: 'boom' }; },
  });
  const accounts = [mkAcc('a')];
  const models = ['M1'];
  q.dueTargets(accounts, models);
  c.advance(PAST_FIRST);

  await q.runDue(accounts, models);
  ok('第一次失败', calls === 1);
  let row = q.snapshot()[0];
  ok('attempts=1', row.attempts === 1, String(row.attempts));
  ok('lastScan 没推进（不算查过）', row.lastScan === null, String(row.lastScan));
  ok('nextAt 是重试时刻', row.dueIn > 0, String(row.dueIn));

  c.advance(10);
  const r2 = await q.runDue(accounts, models);
  ok('重试间隔内不查', r2.scanned === 0, String(r2.scanned));

  c.advance(QUOTA.RETRY_DELAY);
  await q.runDue(accounts, models);
  ok('重试时刻到了会查', calls === 2, String(calls));

  for (let i = 0; i < QUOTA.MAX_ATTEMPTS; i++) {
    c.advance(QUOTA.RETRY_DELAY + 1);
    await q.runDue(accounts, models);
  }
  row = q.snapshot()[0];
  ok('到上限后 attempts 归零', row.attempts === 0, String(row.attempts));
  ok('到上限后 lastScan 推进（推到下一周期）', row.lastScan !== null, String(row.lastScan));
}

console.log('\n\x1b[1m[5] 冷却中的模型跳过\x1b[0m');
{
  const c = clock();
  const q = createQuotaScanner({ now: c.now, probe: async () => ({ status: 200 }) });
  const accounts = [mkAcc('a')];
  const models = ['M1', 'M2'];
  q.dueTargets(accounts, models);
  c.advance(PAST_FIRST);

  const r = await q.runDue(accounts, models, { isCooling: (uid, model) => model === 'M1' });
  ok('冷却的模型被跳过', r.scanned === 1, String(r.scanned));
  ok('只查了 M2', r.results[0].model === 'M2', r.results[0].model);
}

console.log('\n\x1b[1m[6] 到限回调\x1b[0m');
{
  const c = clock();
  const seen = [];
  const q = createQuotaScanner({
    now: c.now,
    probe: async () => ({ status: 429, resetAt: c.t + 1800 }),
  });
  const accounts = [mkAcc('a')];
  q.dueTargets(accounts, ['M1']);
  c.advance(PAST_FIRST);

  await q.runDue(accounts, ['M1'], { onThrottled: (info) => seen.push(info) });
  ok('回调被触发', seen.length === 1, String(seen.length));
  ok('回调带账号', seen[0].account.id === 'a', seen[0].account.id);
  ok('回调带模型', seen[0].model === 'M1', seen[0].model);
  ok('回调带重置时刻', seen[0].resetAt > c.t, String(seen[0].resetAt - c.t));
}

console.log('\n\x1b[1m[7] 并发保护\x1b[0m');
{
  const c = clock();
  let inflight = 0;
  let maxInflight = 0;
  const q = createQuotaScanner({
    now: c.now,
    probe: async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight--;
      return { status: 200 };
    },
  });
  const accounts = [mkAcc('a')];
  const models = ['M1', 'M2', 'M3'];
  q.dueTargets(accounts, models);
  c.advance(PAST_FIRST);

  const [r1, r2] = await Promise.all([
    q.runDue(accounts, models, { limit: 3 }),
    q.runDue(accounts, models, { limit: 3 }),
  ]);
  ok('一轮被挡下', r1.skipped === 'busy' || r2.skipped === 'busy', `${r1.skipped}/${r2.skipped}`);
  ok('probe 不并发', maxInflight === 1, String(maxInflight));
}

console.log('\n\x1b[1m[8] 快照与清理\x1b[0m');
{
  const c = clock();
  const q = createQuotaScanner({ now: c.now, probe: async () => ({ status: 200 }) });
  const accounts = [mkAcc('a')];
  q.dueTargets(accounts, ['M1', 'M2']);
  c.advance(PAST_FIRST);
  await q.runDue(accounts, ['M1', 'M2']);

  const snap = q.snapshot();
  ok('快照 2 条', snap.length === 2, String(snap.length));
  ok('快照有 lastScan', snap[0].lastScan !== null);
  ok('快照有 dueIn', typeof snap[0].dueIn === 'number');

  q.drop('a', 'M1');
  ok('drop 后少一条', q.snapshot().length === 1, String(q.snapshot().length));

  q.reset();
  ok('reset 清空', q.size === 0, String(q.size));
}

console.log('\n\x1b[1m[9] 停用的账号不扫\x1b[0m');
{
  const c = clock();
  const q = createQuotaScanner({ now: c.now, probe: async () => ({ status: 200 }) });
  const accounts = [{ id: 'a', enabled: false }, mkAcc('b')];
  q.dueTargets(accounts, ['M1']);
  c.advance(PAST_FIRST);
  const r = await q.runDue(accounts, ['M1'], { limit: 10 });
  ok('只扫启用的账号', r.scanned === 1, String(r.scanned));
  ok('扫的是 b', r.results[0].uid === 'b', r.results[0].uid);
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
