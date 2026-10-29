// 出站指纹层：让网关发往上游的请求在「头集合 / 头值 / 会话维度」上跟真 CLI 保持一致。
//
// 依据：docs/codearts-reverse-engineering.md §5.2 getInferhubHcHeaders()、
// §5.3 公共头，以及 data/requests.jsonl 里 CLI 实测的 SignedHeaders 组成。
//
// 设计原则（按收益排序）：
//   1. 不出现任何自证身份的头（UA / x-*），这是最廉价的一眼假；
//   2. 头部组合与真 CLI 同构：该有的都有，不该有的都没有；
//   3. 会话级 id 稳定（一个 CLI 会话一套 trace/session），请求级 id 每请求更新；
//   4. 所有值都由配置推导，不写死 mock 值（`*-mock` 之类）。
import crypto from 'node:crypto';
import os from 'node:os';

/** 真 CLI 的默认画像；版本号取自随包运行时（Bun 1.3.14）与 CLI 版本 26.10.9 */
export const DEFAULT_PROFILE = {
  userAgent: 'Bun/1.3.14',
  accept: '*/*',
  acceptEncoding: 'gzip, deflate',
  pluginName: 'codearts-cli',
  pluginVersion: '26.10.9',
  ideName: 'codearts',
  ideVersion: '26.10.9',
  kernelVersion: '26.10.9',
  clientType: 'DevMate',
  otClientType: 'CLI',
  otClientVersion: '26.10.9',
  otFunction: 'agent-tui',
  agentType: 'CodeAgent',
  referer: 'CodeBase',
  appId: 'CodeAgent3.0',
  maasType: 'benefit',
  isConfidential: 'false',
  language: 'zh-cn',
  // auto = 用本机私网 IPv4；显式给值就原样发；空串 = 不发这个头
  clientIp: 'auto',
  // 留空则依次回落到账号 userName / config.identity.department
  currentUser: '',
  department: '',
};

/** 头名字顺序对齐 CLI 的构造顺序；h1 收到时顺序就是这里写的顺序 */
export const HEADER_ORDER = [
  'host',
  'content-type',
  'x-security-token',
  'x-auth-token',
  'x-ot-trace-id',
  'x-ot-span-id',
  'x-snap-traceid',
  'x-ot-session-id',
  'x-ot-parent-session-id',
  'user-session-id',
  'x-ot-function',
  'x-language',
  'user-msg-id',
  'created-time',
  'model-id',
  'model-name',
  'x-ot-client-type',
  'x-ot-client-version',
  'plugin-name',
  'plugin-version',
  'ide-name',
  'ide-version',
  'kernel-version',
  'client-ip',
  'is_confidential',
  'app-id',
  'maas_type',
  'depart',
  'x-current-user',
  'agent-type',
  'x-referer',
  'x-client-type',
];

/** 网关自己的痕迹，一个都不许出现在出站请求里 */
export const FORBIDDEN_MARKERS = [
  'kio-code-gateway',
  'mock-hub',
  'mockhub',
  'mock_flagship',
  'gateway/1.0',
  'undici',
];

/**
 * 解析出站身份档案。
 * @param {object} cfg
 * @param {object} [opts]
 * @param {string} [opts.maasType] 覆盖 maas_type（按账号的套餐状态选）
 */
export function resolveProfile(cfg = {}, opts = {}) {
  const st = cfg.stealth ?? {};
  const override = st.profile ?? {};
  const p = { ...DEFAULT_PROFILE, ...override };
  if (override.otClientVersion === undefined) p.otClientVersion = p.pluginVersion;
  for (const [k, v] of Object.entries(DEFAULT_PROFILE)) {
    if (p[k] === undefined || p[k] === null) p[k] = v;
  }
  // 注意：空串是有效值，表示「不发这个头」，不能用 if (opts.maasType) 判断
  if (opts.maasType !== undefined && opts.maasType !== null) p.maasType = opts.maasType;
  return p;
}

/**
 * 按账号的套餐状态选 maas_type。
 *
 * 上游用这个头选计费通道（实测 2026-10-29）：
 *   不发       → 200，走默认通道
 *   benefit    → 200，免费权益套餐通道（没有套餐的账号会 4004 benefit not found）
 *   default    → 503 Service Unavailable（这个值上游不认）
 *   pay        → 400（未开通）
 *
 * 所以只有「确实有 benefit 套餐」时才发 benefit，其余情况**整个头不发**。
 * 发 default 或空串都会让上游 503。
 *
 * @param {object} account
 * @returns {'benefit'|''}  '' 表示不发这个头
 */
export function maasTypeFor(account) {
  const info = account?.info;
  if (!info) return 'benefit'; // 没探测过，按原来的默认走
  let parsed = info;
  if (typeof info === 'string') {
    try { parsed = JSON.parse(info); } catch { return 'benefit'; }
  }
  const benefit = parsed?.benefit;
  if (!benefit) return 'benefit';
  return benefit.enabled === true ? 'benefit' : '';
}

/**
 * 上游并发会话上限（实测 3）。超了回 400 + TM.00001041，
 * 不是 429，所以调度器的限流分类抓不到它，需要单独识别。
 */
export const CONCURRENCY_LIMIT_CODE = 'TM.00001041';

/** 判断一条上游错误是不是「并发会话数已达上限」 */
export function isConcurrencyLimit(text) {
  const s = String(text ?? '');
  return s.includes(CONCURRENCY_LIMIT_CODE) || /并发会话数已达上限/.test(s);
}

/* ------------------------------------------------------------------ */
/* 本机私网地址（client-ip 头用）                                       */
/* ------------------------------------------------------------------ */

let cachedIp;

/**
 * 真 CLI 的 client-ip 是自己那台机器的私网地址。
 * 容器里默认网桥是 172.17.0.0/16，拿它当 client-ip 等于自报「我在容器里」，
 * 所以自动模式下跳过 172.17.*，没有合适的就干脆不发。
 */
export function detectLanIp(ifaces = os.networkInterfaces()) {
  if (cachedIp !== undefined) return cachedIp;
  const picked = [];
  for (const list of Object.values(ifaces ?? {})) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('172.17.')) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) picked.push(ni.address);
    }
  }
  cachedIp = picked[0] ?? '';
  return cachedIp;
}

export function resetLanIpCache() {
  cachedIp = undefined;
}

/* ------------------------------------------------------------------ */
/* 会话（一个 CLI 会话 = 一套稳定的 session id）                          */
/* ------------------------------------------------------------------ */

const sessions = new Map();

export function sessionFor(account, ttlMs = 60 * 60 * 1000, now = Date.now()) {
  const key = account?.id ?? account?.ref ?? 'config';
  let s = sessions.get(key);
  if (!s || now - s.createdAt > ttlMs) {
    s = { id: crypto.randomUUID(), createdAt: now, requests: 0 };
    sessions.set(key, s);
  }
  s.requests++;
  s.lastUsedAt = now;
  return s;
}

export function resetSessions() {
  sessions.clear();
}

/* ------------------------------------------------------------------ */
/* 头构造                                                              */
/* ------------------------------------------------------------------ */

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

/**
 * 参与签名的那批头。返回顺序即发送顺序（host 由传输层补，不在这里）。
 * @param {object} p
 * @param {object} p.cfg
 * @param {object|null} p.account
 * @param {string} [p.model]
 * @param {object} p.session
 * @param {string} [p.token]  账号的 securityToken / 授权 token
 */
export function buildSignableHeaders({ cfg = {}, account = null, model = '', session, token = '', profile } = {}) {
  const prof = profile ?? resolveProfile(cfg);
  const s = session ?? sessionFor(account, cfg?.stealth?.sessionTtlMs);
  const now = Date.now();
  const department = prof.department || cfg.identity?.department || '';
  const currentUser = prof.currentUser || account?.userName || '';

  const raw = {
    'content-type': 'application/json',
    'x-security-token': token || account?.securityToken || '',
    'x-ot-trace-id': hex(16),
    'x-ot-span-id': hex(8),
    'x-snap-traceid': hex(16),
    'x-ot-session-id': s.id,
    'x-ot-parent-session-id': '',
    'user-session-id': s.id,
    'x-ot-function': prof.otFunction,
    'x-language': prof.language,
    'user-msg-id': crypto.randomUUID(),
    'created-time': String(now),
    'model-id': model ?? '',
    'model-name': model ?? '',
    'x-ot-client-type': prof.otClientType,
    'x-ot-client-version': prof.otClientVersion,
    'plugin-name': prof.pluginName,
    'plugin-version': prof.pluginVersion,
    'ide-name': prof.ideName,
    'ide-version': prof.ideVersion,
    'kernel-version': prof.kernelVersion,
    'client-ip': prof.clientIp === 'auto' ? detectLanIp() : prof.clientIp,
    is_confidential: prof.isConfidential,
    'app-id': prof.appId,
    maas_type: prof.maasType,
    depart: department ? encodeURIComponent(department) : '',
    'x-current-user': currentUser,
    'agent-type': prof.agentType,
    'x-referer': prof.referer,
    'x-client-type': prof.clientType,
  };

  // 空值只保留 CLI 自己也会带的两个（父会话 / 部门），其余直接不发，
  // 免得 SignedHeaders 里出现一串真 CLI 不会签的空头。
  const keepEmpty = new Set(['x-ot-parent-session-id']);
  const out = {};
  for (const key of HEADER_ORDER) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (v === '' && !keepEmpty.has(key)) continue;
    out[key] = v;
  }
  return out;
}

/** 不参与签名的传输层头（真 CLI 也不签这些） */
export function buildTransportHeaders(profile) {
  const prof = profile ?? DEFAULT_PROFILE;
  return {
    accept: prof.accept,
    'accept-encoding': prof.acceptEncoding,
    'user-agent': prof.userAgent,
  };
}

/**
 * 检查一批出站头里有没有自证身份的值。
 * 只做断言用（测试 / 启动自检），不改变请求。
 */
export function findIdentityLeaks(headers) {
  const hits = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = String(k).toLowerCase();
    const val = String(v ?? '');
    if (/^(x-kio|x-gateway|x-proxy)/.test(key)) hits.push(`${key}: 头名带网关前缀`);
    for (const marker of FORBIDDEN_MARKERS) {
      if (val.includes(marker)) hits.push(`${key}: 含 "${marker}"`);
    }
    if (key === 'user-agent' && !/^Bun\/[\d.]+$|^Mozilla\//.test(val)) hits.push(`user-agent: ${val}`);
  }
  return [...new Set(hits)];
}
