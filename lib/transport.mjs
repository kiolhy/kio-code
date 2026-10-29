// 出站传输层：用 node:https / node:http 直接发请求，而不是全局 fetch。
//
// 目的有三个，fetch 都做不到：
//   1. 头顺序可控（undici 会重排 / 丢大小写，WAF 侧的头序指纹就变了）；
//   2. TLS 参数可控（ALPN、cipher 顺序、曲线），尽量贴 BoringSSL 的观感；
//   3. 单请求级别的 CONNECT 代理（每账号一条出口 IP，不走进程级 env proxy）。
//
// 注意：这里不改 rejectUnauthorized，证书校验保持开启。关掉它会多出一个
// 只有中间人/调试环境才有的特征，和「不被识别」的目标正好相反。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';

const DEFAULT_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
].join(':');

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function buildTlsOptions(cfg = {}) {
  const t = cfg.stealth?.tls ?? {};
  return {
    ALPNProtocols: Array.isArray(t.alpn) && t.alpn.length ? t.alpn : ['http/1.1'],
    ciphers: t.ciphers || DEFAULT_CIPHERS,
    ecdhCurve: t.curves || 'X25519:P-256:P-384',
    minVersion: t.minVersion || 'TLSv1.2',
    maxVersion: t.maxVersion || 'TLSv1.3',
    rejectUnauthorized: t.rejectUnauthorized !== false,
  };
}

function transportError(message, code, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/**
 * 通过 HTTP(S) 代理建 CONNECT 隧道。
 * 只支持 http/https 代理；socks 需要额外依赖，本项目零依赖。
 */
export function openTunnel(proxyUrl, target, timeoutMs = 15000) {
  const p = new URL(proxyUrl);
  const secure = p.protocol === 'https:';
  const port = Number(p.port || (secure ? 443 : 80));
  const authority = `${target.hostname}:${target.port}`;
  const headers = { host: authority };
  if (p.username || p.password) {
    const cred = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
    headers['proxy-authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
  }

  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      host: p.hostname,
      port,
      method: 'CONNECT',
      path: authority,
      headers,
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(transportError(`代理 CONNECT 失败：${res.statusCode}`, 'proxy_connect_failed', { status: res.statusCode }));
        return;
      }
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(transportError('代理连接超时', 'proxy_timeout')));
    req.once('error', (e) => reject(transportError(`代理不可用：${e.message}`, 'proxy_error', { cause: e })));
    req.end();
  });
}

function decompressor(encoding) {
  const enc = String(encoding ?? '').toLowerCase().trim();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.createGunzip();
  if (enc === 'deflate') return zlib.createInflate();
  if (enc === 'br') return zlib.createBrotliDecompress();
  return null;
}

function collect(stream, limit = MAX_BUFFER_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        stream.destroy(transportError('上游响应超过大小上限', 'response_too_large'));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (e) => reject(transportError(`读取上游响应失败：${e.message}`, 'upstream_read_error', { cause: e })));
  });
}

export function createTransport(cfg = {}) {
  const tlsOptions = buildTlsOptions(cfg);
  const direct = new Map();

  const directAgent = (secure) => {
    const key = secure ? 'https' : 'http';
    if (!direct.has(key)) {
      direct.set(
        key,
        secure
          ? new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8, timeout: 60_000, ...tlsOptions })
          : new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8, timeout: 60_000 })
      );
    }
    return direct.get(key);
  };

  /**
   * @param {object} p
   * @param {string} p.url
   * @param {string} [p.method]
   * @param {object} [p.headers]
   * @param {string|Buffer} [p.body]
   * @param {number} [p.timeoutMs]      建连 + 等响应头
   * @param {number} [p.idleTimeoutMs]  响应体空闲超时（流式用，0 = 不限）
   * @param {string} [p.proxy]          http(s)://user:pass@host:port
   * @param {AbortSignal} [p.signal]
   */
  async function request({
    url,
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 300_000,
    idleTimeoutMs = 0,
    proxy = '',
    signal,
  }) {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const port = Number(u.port || (secure ? 443 : 80));
    const lib = secure ? https : http;
    const proxyUrl = proxy || cfg.stealth?.egress?.proxy || '';

    let agent;
    let tunneled = null;
    if (proxyUrl) {
      const socket = await openTunnel(proxyUrl, { hostname: u.hostname, port }, Math.min(timeoutMs, 20_000));
      agent = secure
        ? new https.Agent({
            keepAlive: false,
            maxSockets: 1,
            createConnection: () =>
              tls.connect({ socket, servername: u.hostname, ...tlsOptions }),
          })
        : new http.Agent({ keepAlive: false, maxSockets: 1, createConnection: () => socket });
      tunneled = agent;
    } else {
      agent = directAgent(secure);
    }

    const reqHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      reqHeaders[k] = v;
    }
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (payload) reqHeaders['content-length'] = String(payload.length);
    else if (method !== 'GET' && method !== 'HEAD') reqHeaders['content-length'] = '0';

    return await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const fail = (e) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        tunneled?.destroy();
        reject(e);
      };

      const req = lib.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port,
        path: u.pathname + u.search,
        method,
        headers: reqHeaders,
        agent,
        ...(secure ? { servername: u.hostname } : {}),
      });

      timer = setTimeout(() => {
        req.destroy(transportError(`上游响应超时（${timeoutMs}ms）`, 'ETIMEDOUT'));
        fail(transportError(`上游响应超时（${timeoutMs}ms）`, 'ETIMEDOUT'));
      }, timeoutMs);

      req.once('response', (res) => {
        settled = true;
        if (timer) clearTimeout(timer);

        if (idleTimeoutMs > 0) {
          res.setTimeout(idleTimeoutMs, () => {
            res.destroy(transportError(`上游响应空闲超时（${idleTimeoutMs}ms）`, 'ETIMEDOUT'));
          });
        }

        const dec = decompressor(res.headers['content-encoding']);
        const stream = dec ? res.pipe(dec) : res;
        // 保证不会被垃圾回收时静默挂住
        stream.on('error', () => res.destroy());

        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          stream,
          buffer: (limit) => collect(stream, limit),
          destroy: () => {
            res.destroy();
            if (dec) dec.destroy();
          },
        });
      });

      req.once('error', (e) => {
        const code = e?.code ?? 'upstream_error';
        fail(transportError(`上游请求失败：${e.message}`, code, { cause: e }));
      });

      if (signal) {
        if (signal.aborted) {
          req.destroy(transportError('请求已取消', 'ABORT_ERR'));
        } else {
          signal.addEventListener(
            'abort',
            () => {
              req.destroy(transportError('请求已取消', 'ABORT_ERR'));
              fail(transportError('请求已取消', 'ABORT_ERR'));
            },
            { once: true }
          );
        }
      }

      if (payload) req.end(payload);
      else req.end();
    });
  }

  function close() {
    for (const agent of direct.values()) agent.destroy();
    direct.clear();
  }

  return { request, close, tlsOptions };
}

/* 传输层实例按配置对象缓存，避免每次请求重建连接池 */
const cache = new WeakMap();

export function getTransport(cfg) {
  if (!cfg || typeof cfg !== 'object') return createTransport(cfg ?? {});
  let t = cache.get(cfg);
  if (!t) {
    t = createTransport(cfg);
    cache.set(cfg, t);
  }
  return t;
}

export { MAX_BUFFER_BYTES };
