// 分析一条已记录的请求：拆出结构、工具清单、体积分布。
// 用法：
//   node tools/analyze-request.mjs              # 自动挑最大的 chat 请求
//   node tools/analyze-request.mjs <reqId>      # 指定记录
//   node tools/analyze-request.mjs <reqId> --dump   # 同时导出完整 body
import fs from 'node:fs';
import path from 'node:path';

const HUB = process.env.HUB ?? 'http://127.0.0.1:8787';
const args = process.argv.slice(2);
const wantId = args.find((a) => a.startsWith('req-'));
const doDump = args.includes('--dump');

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const short = (s, n) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n) + '…';
};

const state = await (await fetch(`${HUB}/admin/api/state`)).json();
let rec;
if (wantId) {
  rec = state.requests.find((r) => r.id === wantId);
  if (!rec) {
    console.error(`找不到记录 ${wantId}`);
    process.exit(1);
  }
} else {
  rec = state.requests
    .filter((r) => r.route === 'inferhub.chat' && (r.reqBytes ?? 0) > 1000)
    .sort((a, b) => (b.reqBytes ?? 0) - (a.reqBytes ?? 0))[0];
  if (!rec) {
    console.error('没有找到足够大的 chat 请求，先跑一次 CLI 或 simulate-cli.mjs');
    process.exit(1);
  }
}

const detail = await (await fetch(`${HUB}/admin/api/request/${rec.id}`)).json();
if (!detail.bodyText) {
  console.error('这条记录没有保留原始 body（可能已被环形缓冲淘汰）');
  process.exit(1);
}

let body;
try {
  body = JSON.parse(detail.bodyText);
} catch (e) {
  console.error(`body 不是合法 JSON：${e.message}（长度 ${detail.bodyText.length}）`);
  process.exit(1);
}

console.log('');
console.log(`\x1b[1m记录\x1b[0m ${rec.id}  ${rec.method} ${rec.path}`);
console.log(`\x1b[1m来源\x1b[0m ${rec.ingress ?? 'http'}://${rec.host ?? '127.0.0.1'}  ${rec.status}  ${rec.durMs}ms`);
console.log(`\x1b[1m体积\x1b[0m 请求 ${kb(rec.reqBytes ?? 0)}  响应 ${kb(rec.resBytes ?? 0)}`);

console.log('');
console.log('\x1b[1m── 顶层字段 ──\x1b[0m');
const rows = Object.entries(body).map(([k, v]) => {
  const size = JSON.stringify(v).length;
  const kind = Array.isArray(v) ? `[${v.length}]` : v === null ? 'null' : typeof v;
  return { 字段: k, 类型: kind, 大小: kb(size) };
});
console.table(rows);

if (Array.isArray(body.messages)) {
  console.log('\x1b[1m── messages ──\x1b[0m');
  const msgs = body.messages.map((m, i) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return {
      '#': i,
      role: m.role,
      字数: c.length,
      大小: kb(c.length),
      开头: short(c, 60),
    };
  });
  console.table(msgs);

  const sys = body.messages.find((m) => m.role === 'system');
  if (sys) {
    const text = typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content);
    console.log(`\x1b[90msystem prompt 共 ${text.length} 字 / ${kb(text.length)}\x1b[0m`);
    const sections = text.match(/^#{1,3} .+$/gm) ?? [];
    if (sections.length) {
      console.log('\x1b[90m其中小节：\x1b[0m');
      for (const s of sections.slice(0, 24)) console.log(`  ${s}`);
      if (sections.length > 24) console.log(`  …还有 ${sections.length - 24} 个`);
    }
  }
}

if (Array.isArray(body.tools)) {
  const tools = body.tools.map((t) => {
    const fn = t.function ?? t;
    const params = fn.parameters?.properties ? Object.keys(fn.parameters.properties) : [];
    return {
      名称: fn.name,
      大小: kb(JSON.stringify(t).length),
      参数数: params.length,
      描述: short(fn.description ?? '', 46),
    };
  });
  tools.sort((a, b) => parseFloat(b.大小) - parseFloat(a.大小));
  console.log(`\x1b[1m── tools（${tools.length} 个，共 ${kb(JSON.stringify(body.tools).length)}）──\x1b[0m`);
  console.table(tools);
}

if (body.tool_choice || body.tool_stream !== undefined) {
  console.log(`\x1b[90mtool_choice=${JSON.stringify(body.tool_choice)}  tool_stream=${body.tool_stream}\x1b[0m`);
}

if (doDump) {
  const dir = path.join(process.cwd(), 'data', 'samples');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${rec.id}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  console.log('');
  console.log(`\x1b[32m已导出\x1b[0m ${file}  (${kb(fs.statSync(file).size)})`);
}
console.log('');
