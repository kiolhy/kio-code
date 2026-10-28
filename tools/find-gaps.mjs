// 找出 mock-hub 还缺哪些接口。
// 用法：
//   node tools/find-gaps.mjs             # 看当前流水里的缺口
//   node tools/find-gaps.mjs --reset     # 先清空再等（配合真 CLI 跑一轮）
//   node tools/find-gaps.mjs --all       # 连已命中的路由也列出来
const HUB = process.env.HUB ?? 'http://127.0.0.1:8787';
const args = process.argv.slice(2);

if (args.includes('--reset')) {
  const r = await fetch(`${HUB}/admin/api/reset`, { method: 'POST' });
  console.log(`已清空：${r.status}`);
}

const state = await (await fetch(`${HUB}/admin/api/state`)).json();
const reqs = state.requests ?? [];

const key = (r) => `${(r.method ?? '?').toUpperCase()} ${r.path}`;

/* ---------- 1. 未匹配的 ---------- */
const unmatched = new Map();
for (const r of reqs) {
  if (r.route !== 'unmatched' && r.status !== 404) continue;
  const k = key(r);
  const e = unmatched.get(k) ?? { ...r, hits: 0 };
  e.hits++;
  unmatched.set(k, e);
}

console.log('');
if (unmatched.size === 0) {
  console.log('\x1b[32m✓ 没有未覆盖的接口\x1b[0m');
} else {
  console.log(`\x1b[31m✗ 未覆盖 ${unmatched.size} 个接口\x1b[0m`);
  console.log('');
  const rows = [...unmatched.values()]
    .sort((a, b) => b.hits - a.hits)
    .map((r) => ({
      次数: r.hits,
      方法: (r.method ?? '').toUpperCase(),
      路径: r.path.length > 74 ? r.path.slice(0, 74) + '…' : r.path,
      来源: r.host ?? '-',
    }));
  console.table(rows);
}

/* ---------- 2. 非 2xx ---------- */
const bad = reqs.filter((r) => r.status >= 400 && r.route !== 'unmatched');
if (bad.length) {
  console.log(`\x1b[33m⚠ ${bad.length} 条已匹配但返回错误\x1b[0m`);
  const rows = bad.slice(0, 20).map((r) => ({
    状态: r.status,
    方法: (r.method ?? '').toUpperCase(),
    路径: r.path.length > 60 ? r.path.slice(0, 60) + '…' : r.path,
    路由: r.route,
  }));
  console.table(rows);
}

/* ---------- 3. 路由覆盖 ---------- */
const hitRoutes = new Set(reqs.map((r) => r.route).filter((x) => x && x !== 'unmatched'));
const declared = new Set(
  Object.keys(state.routes ?? {}).length ? Object.keys(state.routes) : []
);
if (declared.size === 0 && state.routeIds) for (const id of state.routeIds) declared.add(id);

console.log('');
console.log(`\x1b[1m本轮命中路由 ${hitRoutes.size} 个\x1b[0m`);
console.log([...hitRoutes].sort().join(', '));

if (declared.size) {
  const never = [...declared].filter((r) => !hitRoutes.has(r)).sort();
  console.log('');
  console.log(`\x1b[90m声明了但本轮没被调用：${never.length} 个\x1b[0m`);
  if (args.includes('--all')) console.log(never.join(', '));
}

/* ---------- 4. 按来源域名分组 ---------- */
const byHost = new Map();
for (const r of reqs) {
  const h = r.host ?? '(direct)';
  byHost.set(h, (byHost.get(h) ?? 0) + 1);
}
console.log('');
console.log('\x1b[1m按来源域名\x1b[0m');
console.table([...byHost.entries()].map(([域名, 次数]) => ({ 域名, 次数 })).sort((a, b) => b.次数 - a.次数));

console.log('');
console.log(`共 ${reqs.length} 条请求，${(state.telemetry ?? []).length} 条遥测`);
