// 反代模式与 absolute-form 兼容性验证
import http from 'node:http';

const HUB = 'http://127.0.0.1:8787';

// 1) 起一个假上游
const up = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        upstream: true,
        method: req.method,
        url: req.url,
        auth: req.headers.authorization ? 'present' : 'absent',
        body: Buffer.concat(chunks).toString('utf8').slice(0, 120),
      })
    );
  });
});
await new Promise((r) => up.listen(8899, '127.0.0.1', r));
console.log('假上游 127.0.0.1:8899 已起');

// 2) 切到 proxy 模式
const patch = async (body) => {
  const r = await fetch(HUB + '/admin/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};

await patch({ mode: 'proxy', upstream: { baseUrl: 'http://127.0.0.1:8899', timeoutMs: 5000 } });
console.log('已切到 proxy 模式 → 127.0.0.1:8899');

// 3) 走一次 chat，看是否被转发
{
  const r = await fetch(HUB + '/api/v2/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': 't' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'proxy test' }] }),
  });
  const t = await r.text();
  const ok = r.status === 200 && t.includes('"upstream":true') && t.includes('/api/v2/chat/completions');
  console.log(`${ok ? '✓' : '✗'} 反代转发 chat → ${r.status} ${t.slice(0, 150)}`);
  if (!ok) process.exitCode = 1;
}

// 4) SSE 是否原样透传
{
  const sseUp = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"a":1}\n\n');
    setTimeout(() => {
      res.write('data: [DONE]\n\n');
      res.end();
    }, 30);
  });
  await new Promise((r) => sseUp.listen(8898, '127.0.0.1', r));
  await patch({ upstream: { baseUrl: 'http://127.0.0.1:8898' } });
  const r = await fetch(HUB + '/api/v2/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true }),
  });
  const t = await r.text();
  const ok = r.headers.get('content-type')?.includes('event-stream') && t.includes('[DONE]');
  console.log(`${ok ? '✓' : '✗'} 反代透传 SSE → ${r.status} ${JSON.stringify(t)}`);
  if (!ok) process.exitCode = 1;
  sseUp.close();
}

// 5) absolute-form 请求行（被当 HTTP 代理直连时）
{
  await patch({ mode: 'mock' });
  const status = await new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 8787,
        method: 'POST',
        path: 'http://127.0.0.1:8787/api/v2/chat/completions', // 绝对 URL 作为 request-target
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.end(JSON.stringify({ model: 'mock-flagship', messages: [{ role: 'user', content: 'absolute form' }] }));
  });
  const ok = status.status === 200 && status.body.includes('mock-hub');
  console.log(`${ok ? '✓' : '✗'} absolute-form 请求行 → ${status.status} ${status.body.slice(0, 100)}`);
  if (!ok) process.exitCode = 1;
}

up.close();
console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
