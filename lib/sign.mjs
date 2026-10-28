// SDK-HMAC-SHA256 —— 与码道 CLI 内 f4 类（bun_section 偏移 ≈15.53M）逐字节对齐的实现。
// 用途：mock-hub 校验 CLI 发来的签名，或反过来为出站请求签名。
import crypto from 'node:crypto';

export const ALGORITHM = 'SDK-HMAC-SHA256';
export const HEADER_X_DATE = 'X-Sdk-Date';
export const HEADER_HOST = 'host';
export const HEADER_CONTENT_SHA256 = 'X-Sdk-Content-Sha256';
export const EMPTY_BODY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const NO_ESCAPE = new Set(
  "-_.~".split('').concat('0123456789'.split('')).concat(
    'abcdefghijklmnopqrstuvwxyz'.split('')
  ).concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
);

export function urlEncode(str) {
  let out = '';
  for (const ch of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(ch);
    out += NO_ESCAPE.has(c) ? c : '%' + ch.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

/** 2026-10-28T05:20:30.000Z -> 20261028T052030Z */
export function formatDate(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** 每段单独 encode，且强制以 "/" 结尾 —— 与 canonicalURI 一致 */
export function canonicalURI(pathname) {
  if (!pathname) return '/';
  const out = pathname.split('/').map(urlEncode).join('/');
  return out.endsWith('/') ? out : out + '/';
}

/** key 升序、值 encode、同名 key 值升序；空值也要保留 "k=" */
export function canonicalQueryString(searchParams) {
  const pairs = [];
  for (const [k, v] of searchParams.entries()) pairs.push([urlEncode(k), urlEncode(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalHeaders(headers) {
  const keys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const uniq = [...new Set(keys)];
  return {
    text: uniq.map((k) => `${k}:${String(headers[findKey(headers, k)] ?? '').trim()}\n`).join(''),
    signedHeaders: uniq.join(';'),
  };
}

function findKey(headers, lower) {
  return Object.keys(headers).find((k) => k.toLowerCase() === lower) ?? lower;
}

function isDefaultPort(protocol, port) {
  if (!port) return true;
  if (protocol === 'https:' && String(port) === '443') return true;
  if (protocol === 'http:' && String(port) === '80') return true;
  return false;
}

/**
 * 计算签名。
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.url            完整 URL
 * @param {object} p.headers        原始请求头（大小写不敏感）
 * @param {Buffer|string} [p.body]
 * @param {string} p.ak
 * @param {string} p.sk
 * @returns {{authorization:string, headers:object, stringToSign:string, canonicalRequest:string}}
 */
export function signRequest({ method, url, headers = {}, body = '', ak, sk }) {
  const u = new URL(url);
  const hdrs = {};
  for (const [k, v] of Object.entries(headers)) hdrs[k] = v;

  let xDate = headers[HEADER_X_DATE] ?? headers[HEADER_X_DATE.toLowerCase()];
  if (xDate) {
    // 已经是 SDK 格式（20261028T132000Z）就原样用；只对 ISO/Date 做一次归一化，
    // 否则 new Date("20261028T132000Z") 是 Invalid Date，会把 canonicalHeaders 带成 NaN。
    const s = String(xDate).trim();
    xDate = /^\d{8}T\d{6}Z$/.test(s) ? s : formatDate(new Date(s));
  } else {
    xDate = formatDate(new Date());
  }
  hdrs[HEADER_X_DATE] = xDate;

  let host = u.hostname;
  if (u.port && !isDefaultPort(u.protocol, u.port)) host = `${host}:${u.port}`;
  const hostOverride = headers[HEADER_HOST] ?? headers[HEADER_HOST.toUpperCase()];
  if (hostOverride) host = hostOverride;
  hdrs.Host = host;

  const merged = { ...hdrs };
  const { text: chText, signedHeaders } = canonicalHeaders(merged);

  const payloadHash =
    merged[HEADER_CONTENT_SHA256] && String(merged[HEADER_CONTENT_SHA256]).toUpperCase() === UNSIGNED_PAYLOAD
      ? UNSIGNED_PAYLOAD
      : sha256Hex(Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8'));

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalURI(u.pathname),
    canonicalQueryString(u.searchParams),
    chText,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [ALGORITHM, xDate, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmacSha256Hex(sk, stringToSign);

  return {
    headers: { ...merged, Authorization: `${ALGORITHM} Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
    authorization: `${ALGORITHM} Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    stringToSign,
    canonicalRequest,
    signature,
  };
}

/** 解析 Authorization 头 */
export function parseAuthorization(value) {
  if (!value || typeof value !== 'string') return null;
  const m = /^SDK-HMAC-SHA256\s+Access=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/i.exec(
    value.trim()
  );
  if (!m) return null;
  return { algorithm: ALGORITHM, ak: m[1].trim(), signedHeaders: m[2].trim(), signature: m[3].trim() };
}

/**
 * 校验签名。CLI 侧 SK 不会发送，所以需要外部提供 skOf(ak) 回调。
 * @returns {{ok:boolean, reason?:string, ak?:string, detail?:object}}
 */
export function verifyRequest({ method, url, headers = {}, body = '', skOf }) {
  const authHeader =
    headers.authorization ?? headers.Authorization ?? headers['AUTHORIZATION'];
  const parsed = parseAuthorization(authHeader);
  if (!parsed) return { ok: false, reason: 'authorization_missing_or_malformed' };

  const sk = skOf ? skOf(parsed.ak) : null;
  if (!sk) return { ok: false, reason: 'unknown_ak', ak: parsed.ak };

  // 只取 SignedHeaders 声明过的头参与重算，否则 fetch/网关自动加的
  // accept / user-agent / content-length 会把 canonicalHeaders 带偏。
  const signedNames = parsed.signedHeaders.split(';').map((s) => s.trim().toLowerCase());
  const subset = {};
  for (const name of signedNames) {
    const realKey = Object.keys(headers).find((k) => k.toLowerCase() === name);
    if (realKey !== undefined) subset[realKey] = headers[realKey];
  }
  if (!signedNames.includes('host')) {
    const hostKey = Object.keys(headers).find((k) => k.toLowerCase() === 'host');
    if (hostKey) subset[hostKey] = headers[hostKey];
  }

  const signed = signRequest({ method, url, headers: subset, body, ak: parsed.ak, sk });
  const expected = signed.signature;
  const ok = timingSafeEqualHex(expected, parsed.signature);
  return {
    ok,
    ak: parsed.ak,
    reason: ok ? undefined : 'signature_mismatch',
    detail: {
      expected,
      received: parsed.signature,
      signedHeaders: parsed.signedHeaders,
      canonicalRequest: signed.canonicalRequest,
      stringToSign: signed.stringToSign,
    },
  };
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 从请求头里抽取 CLI 元信息（对应 getInferhubHcHeaders 构造的那一堆） */
export const CLI_HEADER_KEYS = [
  'x-auth-token',
  'x-security-token',
  'authorization',
  'x-ot-trace-id',
  'x-ot-span-id',
  'x-snap-traceid',
  'x-ot-session-id',
  'x-ot-parent-session-id',
  'user-session-id',
  'x-ot-function',
  'x-ot-client-type',
  'x-ot-client-version',
  'user-msg-id',
  'created-time',
  'model-id',
  'model-name',
  'x-current-user',
  'depart',
  'agent-type',
  'x-referer',
  'is_confidential',
  'app-id',
  'maas_type',
  'plugin-name',
  'plugin-version',
  'ide-name',
  'ide-version',
  'kernel-version',
  'client-ip',
  'x-language',
  'x-client-type',
];
