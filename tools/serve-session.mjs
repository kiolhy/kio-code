// 通过 serve 的 HTTP API 驱动一次会话，处理权限交互（ask → allow）。
// 用法：node tools/serve-session.mjs "你的问题" [--reject] [--port 4097]
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '--port=4097').split('=')[1]);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = 'Basic ' + Buffer.from('codearts:mockhub-test').toString('base64');
const rejectMode = process.argv.includes('--reject');
const prompt = process.argv[2] ?? '请执行 [[tool]] 自检';

const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { authorization: AUTH, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!r.ok) {
    const err = new Error(`${init.method ?? 'GET'} ${path} → ${r.status}`);
    err.body = json;
    throw err;
  }
  return json;
};

/* ---------- 1. 目录与会话 ---------- */
const dir = process.env.CLI_DIR ?? 'D:\\project\\码道\\_codearts_re\\x';
const session = await api(`/session?directory=${encodeURIComponent(dir)}`, {
  method: 'POST',
  body: JSON.stringify({ title: 'mock-hub serve 测试' }),
});
console.log(`会话  ${session.id}  slug=${session.slug}`);

/* ---------- 2. 取模型 ---------- */
const agents = await api('/agent');
const build = agents.find((a) => a.name === 'build') ?? agents[0];
console.log(`agent ${build.name}  model=${JSON.stringify(build.model ?? null)}`);

let providerID = build.model?.providerID;
let modelID = build.model?.modelID;
if (!providerID || !modelID) {
  const cfg = await api('/config');
  const prov = cfg.provider ?? {};
  for (const [pid, p] of Object.entries(prov)) {
    const m = Object.keys(p.models ?? {})[0];
    if (m) {
      providerID = pid;
      modelID = m;
      break;
    }
  }
}
console.log(`模型  ${providerID}/${modelID}`);

/* ---------- 3. 事件流 ---------- */
const seen = new Set();
const ac = new AbortController();
(async () => {
  try {
    const r = await fetch(`${BASE}/event`, {
      headers: { authorization: AUTH, accept: 'text/event-stream' },
      signal: ac.signal,
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        const t = ev.type;
        if (!t || seen.has(`${t}:${ev.properties?.id ?? ''}`)) continue;
        seen.add(`${t}:${ev.properties?.id ?? ''}`);

        if (t === 'permission.asked') {
          const p = ev.properties;
          console.log(`\n[权限请求] ${p.permission}  模式=${p.patterns?.join(',')}  id=${p.id}`);
          const reply = rejectMode ? 'reject' : 'once';
          try {
            await api(`/permission/${p.id}/reply`, { method: 'POST', body: JSON.stringify({ reply }) });
            console.log(`[权限回复] ${reply}`);
          } catch (e) {
            console.log(`[权限回复失败] ${e.message} ${JSON.stringify(e.body)}`);
          }
        } else if (t === 'message.part.updated') {
          const part = ev.properties?.part;
          if (part?.type === 'tool') {
            const st = part.state?.status;
            if (st === 'running' || st === 'completed' || st === 'error') {
              const out = part.state?.output ?? part.state?.error ?? '';
              console.log(`[工具] ${part.tool} → ${st}  ${String(out).replace(/\s+/g, ' ').slice(0, 80)}`);
            }
          } else if (part?.type === 'text' && part.text?.trim()) {
            const t2 = part.text.trim();
            if (!seen.has('text:' + t2)) {
              seen.add('text:' + t2);
              console.log(`[文本] ${t2.slice(0, 160)}`);
            }
          }
        } else if (t === 'session.error') {
          console.log(`[错误] ${JSON.stringify(ev.properties?.error).slice(0, 200)}`);
        } else if (t === 'session.idle') {
          console.log('\n[session idle]');
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.log('[事件流结束]', e.message);
  }
})();

/* ---------- 4. 发消息 ---------- */
await new Promise((r) => setTimeout(r, 800));
const body = {
  parts: [{ type: 'text', text: prompt }],
  ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
};
console.log(`\n发送：${prompt}\n`);
try {
  const res = await api(`/session/${session.id}/message?directory=${encodeURIComponent(dir)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const parts = res?.parts ?? [];
  console.log('\n=== 最终消息 ===');
  for (const p of parts) {
    if (p.type === 'text' && p.text?.trim()) console.log('[text]', p.text.trim().slice(0, 300));
    if (p.type === 'tool') console.log('[tool]', p.tool, '→', p.state?.status, String(p.state?.output ?? '').slice(0, 120));
  }
} catch (e) {
  console.log('发消息失败:', e.message, JSON.stringify(e.body).slice(0, 300));
}

await new Promise((r) => setTimeout(r, 1500));
ac.abort();
process.exit(0);
