// 代理池：批量添加、分组、健康检查、按账号绑定
//
// 支持的代理写法（统一归一化成 { url, protocol, host, port, username, password, label }）：
//   http://host:port
//   http://user:pass@host:port
//   https://host:port
//   socks5://user:pass@host:port
//   socks4://host:port
//   host:port                       （裸写，默认 http）
//   host:port:user:pass             （常见代理商格式）
//   user:pass@host:port
//
// 批量添加时一行一个，支持 # 注释与空行。

export const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];

const DEFAULT_PORTS = { http: 80, https: 443, socks4: 1080, socks5: 1080 };

/** 解析一行代理，失败返回 { error } */
export function parseProxyLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw || raw.startsWith('#')) return null;

  let protocol = 'http';
  let rest = raw;
  let username = '';
  let password = '';

  // 协议前缀
  const m = /^([a-z0-9]+):\/\/(.+)$/i.exec(raw);
  if (m) {
    protocol = m[1].toLowerCase();
    rest = m[2];
  }
  if (!PROXY_PROTOCOLS.includes(protocol)) {
    return { error: `不支持的协议 ${protocol}` };
  }

  // user:pass@host:port
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const cred = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const ci = cred.indexOf(':');
    if (ci >= 0) {
      username = decodeURIComponent(cred.slice(0, ci));
      password = decodeURIComponent(cred.slice(ci + 1));
    } else {
      username = decodeURIComponent(cred);
    }
  }

  // host:port 或 host:port:user:pass
  const parts = rest.split(':');
  if (parts.length < 2) return { error: '缺少端口' };
  const host = parts[0].trim();
  const port = Number(parts[1]);
  if (!host) return { error: '缺少主机' };
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: `端口无效 ${parts[1]}` };

  // host:port:user:pass 形式
  if (parts.length >= 4 && !username) {
    username = decodeURIComponent(parts[2]);
    password = decodeURIComponent(parts.slice(3).join(':'));
  }

  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  const url = `${protocol}://${auth}${host}:${port}`;
  return {
    url,
    protocol,
    host,
    port,
    username,
    password,
    label: `${host}:${port}`,
  };
}

/** 批量解析：返回 { ok: [...], errors: [{ line, error }] } */
export function parseProxyList(text) {
  const ok = [];
  const errors = [];
  const seen = new Set();
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, i) => {
    const p = parseProxyLine(line);
    if (!p) return;
    if (p.error) {
      errors.push({ line: i + 1, text: String(line).trim(), error: p.error });
      return;
    }
    if (seen.has(p.url)) return; // 同批次去重
    seen.add(p.url);
    ok.push(p);
  });
  return { ok, errors };
}

/** 生成代理 id（稳定：同 url 同 id） */
export function proxyId(url) {
  let h = 2166136261;
  const s = String(url);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'px_' + (h >>> 0).toString(36);
}

/** 打码显示（隐藏密码） */
export function maskProxyUrl(url) {
  if (!url) return '';
  return String(url).replace(/\/\/([^:@/]+):([^@/]+)@/, (m, u, p) => `//${u}:${'*'.repeat(Math.min(String(p).length, 6))}@`);
}

/** 从一组代理里挑一个可用且未过期的（轮询） */
export function pickProxy(proxies, { cursor = 0, exclude = [] } = {}) {
  const skip = new Set(exclude);
  const usable = (proxies ?? []).filter((p) => p.enabled !== false && !skip.has(p.id));
  if (!usable.length) return null;
  return usable[cursor % usable.length];
}

/**
 * 健康检查：用代理发一个轻量请求，看能否连通。
 * @param {object} p
 * @param {object} p.proxy  { url, protocol, ... }
 * @param {string} [p.testUrl] 默认打 https://www.huaweicloud.com
 * @param {number} [p.timeoutMs]
 * @param {Function} [p.transportFactory] 注入 transport（测试用）
 */
export async function checkProxy({ proxy, testUrl = 'https://www.huaweicloud.com', timeoutMs = 8000, transportFactory }) {
  const started = Date.now();
  try {
    const t = transportFactory ? transportFactory() : (await import('./transport.mjs')).getTransport({});
    const resp = await t.request({
      url: testUrl,
      method: 'GET',
      headers: { 'user-agent': 'curl/8.5.0' },
      timeoutMs,
      proxy: proxy.url,
    });
    const buf = await resp.buffer(1024 * 256).catch(() => Buffer.alloc(0));
    return {
      ok: resp.status > 0 && resp.status < 500,
      status: resp.status,
      durMs: Date.now() - started,
      bytes: buf.length,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      durMs: Date.now() - started,
      bytes: 0,
      error: String(e?.message ?? e),
    };
  }
}
