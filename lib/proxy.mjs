// 真实上游转发（反代模式）
import { Readable } from 'node:stream';
import { signRequest, parseAuthorization } from './sign.mjs';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/**
 * @param {object} ctx  { req, res, url, method, rawBody, headers }
 * @param {object} cfg
 * @returns {Promise<{status:number, proxied:boolean}>}
 */
export async function proxyToUpstream(ctx, cfg) {
  const up = cfg.upstream ?? {};
  if (!up.baseUrl) return { status: 502, proxied: false };

  const base = new URL(up.baseUrl);
  const target = new URL(base.toString());
  target.pathname = joinPath(base.pathname, ctx.url.pathname);
  target.search = ctx.url.search;

  const headers = {};
  for (const [k, v] of Object.entries(ctx.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'authorization') continue; // 下面重签或按需透传
    headers[k] = v;
  }

  // 鉴权策略：优先用本地 AK/SK 重签；否则透传客户端签名；再否则用配置的 token
  const clientAuth = parseAuthorization(ctx.headers.authorization);
  if (up.ak && up.sk) {
    const signed = signRequest({
      method: ctx.method,
      url: target.toString(),
      headers,
      body: ctx.rawBody,
      ak: up.ak,
      sk: up.sk,
    });
    Object.assign(headers, signed.headers);
  } else if (clientAuth) {
    headers.authorization = ctx.headers.authorization;
  } else if (up.authToken) {
    headers['x-auth-token'] = up.authToken;
  }
  if (up.apiKey && !headers.authorization) headers.authorization = `Bearer ${up.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), up.timeoutMs ?? 120000);

  let upstreamRes;
  try {
    upstreamRes = await fetch(target, {
      method: ctx.method,
      headers,
      body: ['GET', 'HEAD'].includes(ctx.method) ? undefined : ctx.rawBody,
      signal: controller.signal,
      redirect: 'manual',
      // 上游若是自签证书（内部网关常见）
      ...(up.tlsInsecure ? { dispatcher: undefined } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    return { status: 502, proxied: true, error: String(err?.message ?? err) };
  }
  clearTimeout(timer);

  const outHeaders = {};
  upstreamRes.headers.forEach((v, k) => {
    if (HOP_BY_HOP.has(k.toLowerCase())) return;
    outHeaders[k] = v;
  });

  const isStream = String(upstreamRes.headers.get('content-type') ?? '').includes('event-stream');
  if (isStream) {
    outHeaders['cache-control'] = 'no-cache, no-transform';
    outHeaders['x-accel-buffering'] = 'no';
  }

  ctx.res.writeHead(upstreamRes.status, outHeaders);
  if (upstreamRes.body) {
    Readable.fromWeb(upstreamRes.body).pipe(ctx.res);
    await new Promise((r) => ctx.res.on('close', r).on('finish', r));
  } else {
    ctx.res.end();
  }
  return { status: upstreamRes.status, proxied: true };
}

function joinPath(a, b) {
  const left = a.endsWith('/') ? a.slice(0, -1) : a;
  const right = b.startsWith('/') ? b : `/${b}`;
  return `${left}${right}` || '/';
}
