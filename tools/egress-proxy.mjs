// 出站代理：把 CLI 发往官方域名的流量截到本地捕获端口，其余一律拒绝。
// 作用等价于 hosts 隔离，但不需要管理员权限，且能捕获内容。
//
// 用法：
//   node tools/egress-proxy.mjs                 # 默认 8889，capture 模式
//   node tools/egress-proxy.mjs --port 8890
//   node tools/egress-proxy.mjs --mode block    # 只记录并拒绝，不转发
//   node tools/egress-proxy.mjs --allow example.com   # 额外放行（直连）
//
// CLI 侧：
//   $env:HTTPS_PROXY = "http://127.0.0.1:8889"
//   $env:HTTP_PROXY  = "http://127.0.0.1:8889"
//   $env:NO_PROXY    = "127.0.0.1,localhost"
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(getArg('port', 8889));
const HOST = getArg('host', '127.0.0.1');
const MODE = getArg('mode', 'capture'); // capture | block
const CAPTURE_PORT = Number(getArg('capture-port', 443));
const ALLOW = args.reduce((acc, a, i) => (a === '--allow' && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_PATH = path.join(ROOT, 'data', 'egress.log');

// 这些域名一律截到本地捕获端口
const CAPTURE_HOSTS = [
  'collector-agents-access.cn-north-4.myhuaweicloud.com',
  'collector-agents-access.ap-southeast-1.myhuaweicloud.com',
  'beta-collector-agents-apig.cn-north-7.ulanqab.huawei.com',
  'beta-hk-collector-agents-apig.cn-north-7.ulanqab.huawei.com',
  'mammoth.opentelemetry.endpoint.tools.huawei.com',
  'mammoth.opentelemetry.endpoint.gamma.tools.huawei.com',
  'snap-access.cn-north-4.myhuaweicloud.com',
  'snapengine-apig.cn-north-7.myhuaweicloud.com',
  'opengw.developer.huaweicloud.com',
  'skills.huaweicloud.com',
  'skillstest.developer.huaweicloud.com',
  'rnd-idea-api.huawei.com',
  'cmc-nkg-artifactory.cmc.tools.huawei.com',
  'sts.cn-north-4.myhuaweicloud.com',
  'ide.cn-north-4.myhuaweicloud.com',
  'codearts.huaweicloud.com',
  'open.codehub.huawei.com',
  'codehub-g.huawei.com',
  'codehub-y.huawei.com',
  'gamma.codehub.huawei.com',
  'cr-y.codehub.huawei.com',
  'cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com',
  'codearts-agent-obs-cdn.huaweicloud.com',
];

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

function logLine(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_PATH, line + '\n');
  const mark = entry.action === 'capture' ? '\x1b[35m⇅\x1b[0m' : entry.action === 'allow' ? '\x1b[32m→\x1b[0m' : '\x1b[31m✕\x1b[0m';
  console.log(`${mark} ${entry.method} ${entry.host}:${entry.port} ${entry.action}${entry.reason ? ' (' + entry.reason + ')' : ''}`);
}

const stats = { capture: 0, allow: 0, block: 0 };

function classify(host) {
  const h = host.toLowerCase();
  if (CAPTURE_HOSTS.includes(h)) return 'capture';
  if (ALLOW.some((a) => h === a.toLowerCase() || h.endsWith('.' + a.toLowerCase()))) return 'allow';
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return 'allow';
  return 'block';
}

const server = http.createServer((req, res) => {
  // 绝对形式请求行（明文 HTTP 代理）
  let host = '';
  let port = 80;
  try {
    const u = new URL(req.url);
    host = u.hostname;
    port = Number(u.port || 80);
  } catch {
    /* CONNECT 之外的异常请求 */
  }

  const kind = host ? classify(host) : 'block';
  if (kind === 'capture') {
    // 明文没法转 TLS，只能拒绝；正常 CLI 走的是 CONNECT
    stats.block++;
    logLine({ method: req.method, host, port, action: 'block', reason: 'plain-http-to-tls-host' });
    res.writeHead(403, { 'content-type': 'text/plain' });
    return void res.end('blocked: use CONNECT');
  }
  if (kind === 'block') {
    stats.block++;
    logLine({ method: req.method, host, port, action: 'block', reason: 'not-in-allowlist' });
    res.writeHead(403, { 'content-type': 'text/plain' });
    return void res.end('blocked by mock-hub egress proxy');
  }

  stats.allow++;
  logLine({ method: req.method, host, port, action: 'allow' });
  const up = http.request(
    { host, port, path: req.url, method: req.method, headers: req.headers },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    }
  );
  up.on('error', () => {
    res.writeHead(502);
    res.end('upstream error');
  });
  req.pipe(up);
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr || 443);
  const kind = classify(host);

  if (kind === 'block') {
    stats.block++;
    logLine({ method: 'CONNECT', host, port, action: 'block', reason: 'not-in-allowlist' });
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  const targetHost = kind === 'capture' ? '127.0.0.1' : host;
  const targetPort = kind === 'capture' ? CAPTURE_PORT : port;

  const upstream = net.connect(targetPort, targetHost, () => {
    stats[kind]++;
    logLine({ method: 'CONNECT', host, port, action: kind, to: `${targetHost}:${targetPort}` });
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (e) => {
    stats.block++;
    logLine({ method: 'CONNECT', host, port, action: 'block', reason: `connect-failed: ${e.code ?? e.message}` });
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });

  clientSocket.on('error', () => upstream.destroy());
  upstream.on('close', () => clientSocket.destroy());
  clientSocket.on('close', () => upstream.destroy());
});

// 客户端半路断开是常态，不能让单个 socket 打死整个代理
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  else socket.destroy();
});

process.on('uncaughtException', (e) => {
  if (e?.code === 'ECONNRESET' || e?.code === 'EPIPE') return;
  console.error('[uncaught]', e?.message ?? e);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', e?.message ?? e);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  出站代理   http://${HOST}:${PORT}   模式=${MODE}`);
  console.log(`  捕获目标   127.0.0.1:${CAPTURE_PORT}`);
  console.log(`  拦截清单   ${CAPTURE_HOSTS.length} 个域名 → 本地捕获`);
  if (ALLOW.length) console.log(`  额外放行   ${ALLOW.join(', ')}`);
  console.log(`  日志       ${LOG_PATH}`);
  console.log('');
  console.log('  CLI 侧环境变量：');
  console.log(`    $env:HTTPS_PROXY = "http://${HOST}:${PORT}"`);
  console.log(`    $env:HTTP_PROXY  = "http://${HOST}:${PORT}"`);
  console.log(`    $env:NO_PROXY    = "127.0.0.1,localhost"`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log('');
  console.log(`统计：捕获 ${stats.capture} / 放行 ${stats.allow} / 拦截 ${stats.block}`);
  process.exit(0);
});
