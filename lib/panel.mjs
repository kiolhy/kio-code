// 面板层：持久化设置、PBKDF2 面板密码、会话、账号池、API Key、用量统计。
// 对齐 workbuddy2api-hub 的产品结构，但保持零依赖（只用 node 内置模块）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PBKDF2_ITER = 210000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const DEFAULT_PASSWORD = 'admin';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

export function hashPassword(password, salt, iterations = PBKDF2_ITER) {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
}

export function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const got = hashPassword(password, record.salt, record.iterations ?? PBKDF2_ITER);
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* 账号 / Key 的工具函数                                                */
/* ------------------------------------------------------------------ */

export const maskSecret = (v) => {
  const s = String(v ?? '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
};

/** 代理地址对外可见形态：只留 host:port，账号密码打码 */
export const maskProxy = (v) => {
  const s = String(v ?? '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return maskSecret(s);
  }
};

/** 账号对外可见形态：密钥只留掩码，另附 hasSecret 标记 */
export function publicAccount(acc) {
  // note 里可能存着 refresh_token / dpop 私钥（码道 OAuth），对外只给摘要 + 是否可续期
  let meta = null;
  try {
    meta = acc.note ? JSON.parse(acc.note) : null;
  } catch {
    meta = null;
  }
  const canRefresh = !!(meta && meta.refresh && meta.dpop);
  const noteText = meta
    ? `来源：${meta.source ?? 'oauth'}${canRefresh ? '（可自动续期）' : ''}`
    : (acc.note ?? '');
  return {
    id: acc.id,
    ref: acc.ref,
    name: acc.name,
    region: acc.region,
    authType: acc.authType,
    accessKeyIdMasked: maskSecret(acc.accessKeyId),
    hasSecret: !!acc.secretAccessKey,
    hasToken: !!acc.securityToken,
    domainId: acc.domainId ?? '',
    userId: acc.userId ?? '',
    userName: acc.userName ?? '',
    department: acc.department ?? '',
    proxy: maskProxy(acc.proxy),
    enabled: acc.enabled !== false,
    note: noteText,
    canRefresh,
    expiresAt: acc.expiresAt ?? null,
    expired: acc.expiresAt ? new Date(acc.expiresAt).getTime() < Date.now() : false,
    createdAt: acc.createdAt,
    lastUsedAt: acc.lastUsedAt ?? null,
  };
}

export function publicKey(k) {
  return {
    id: k.id,
    name: k.name,
    key: k.key,
    keyMasked: `${String(k.key).slice(0, 6)}…${String(k.key).slice(-4)}`,
    enabled: k.enabled !== false,
    accountRef: k.accountRef ?? null,
    models: k.models ?? ['*'],
    note: k.note ?? '',
    createdAt: k.createdAt,
    deletedAt: k.deletedAt ?? null,
  };
}

/** 生成形如 mh-xxxx 的 API Key */
export function generateKey() {
  return `mh-${crypto.randomBytes(24).toString('base64url')}`;
}

/* ------------------------------------------------------------------ */
/* 主体                                                                */
/* ------------------------------------------------------------------ */

export function createPanel({ dataDir }) {
  const file = path.join(dataDir, 'settings.json');
  const usageFile = path.join(dataDir, 'usage.jsonl');
  const sessions = new Map(); // token -> { expiresAt }
  const usage = []; // 内存环形，最多 20000 条

  const ensure = () => fs.mkdirSync(dataDir, { recursive: true });

  const freshPanel = () => {
    const salt = rand(16);
    return {
      salt,
      hash: hashPassword(DEFAULT_PASSWORD, salt),
      iterations: PBKDF2_ITER,
      changed: false,
      updatedAt: new Date().toISOString(),
    };
  };

  const defaults = () => ({
    version: 1,
    panel: freshPanel(),
    accounts: [],
    apiKeys: [],
    settings: {
      region: 'cn',
      accountsTab: false,
      enforceKeys: false,
      requestTimeoutMs: 120000,
      maxPayloadBytes: 67108864,
      logLevel: 'INFO',
    },
  });

  let state = defaults();

  const load = () => {
    ensure();
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        state = {
          ...defaults(),
          ...raw,
          panel: { ...defaults().panel, ...(raw.panel ?? {}) },
          settings: { ...defaults().settings, ...(raw.settings ?? {}) },
          accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
          apiKeys: Array.isArray(raw.apiKeys) ? raw.apiKeys : [],
        };
      } else {
        save();
      }
    } catch {
      state = defaults();
    }
    return state;
  };

  const save = () => {
    ensure();
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  };

  const loadUsage = () => {
    ensure();
    if (!fs.existsSync(usageFile)) return;
    try {
      const lines = fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-20000)) {
        try {
          usage.push(JSON.parse(line));
        } catch {
          /* 跳过坏行 */
        }
      }
    } catch {
      /* 忽略 */
    }
  };

  load();
  loadUsage();

  /* ---------- 会话 ---------- */

  const createSession = () => {
    const token = rand(32);
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  };

  const checkSession = (token) => {
    if (!token) return false;
    const s = sessions.get(token);
    if (!s) return false;
    if (s.expiresAt < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  const dropSession = (token) => sessions.delete(token);

  const pruneSessions = () => {
    const now = Date.now();
    for (const [t, s] of sessions) if (s.expiresAt < now) sessions.delete(t);
  };

  /* ---------- 密码 ---------- */

  const setPassword = (password) => {
    if (!password || String(password).length < 4) {
      throw new Error('密码至少 4 位');
    }
    const salt = rand(16);
    state.panel = {
      salt,
      hash: hashPassword(password, salt),
      iterations: PBKDF2_ITER,
      changed: true,
      updatedAt: new Date().toISOString(),
    };
    save();
    return true;
  };

  /* ---------- 账号 ---------- */

  const addAccount = (input) => {
    const acc = {
      id: `acc_${rand(8)}`,
      ref: input.ref || input.accessKeyId?.slice(0, 8) || `acc_${rand(4)}`,
      name: input.name || '未命名账号',
      region: input.region || state.settings.region || 'cn',
      authType: input.authType || 'aksk',
      accessKeyId: input.accessKeyId ?? '',
      secretAccessKey: input.secretAccessKey ?? '',
      securityToken: input.securityToken ?? '',
      domainId: input.domainId ?? '',
      userId: input.userId ?? '',
      userName: input.userName ?? '',
      department: input.department ?? '',
      proxy: input.proxy ?? '',
      enabled: input.enabled !== false,
      note: input.note ?? '',
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    state.accounts.push(acc);
    save();
    return acc;
  };

  const updateAccount = (id, patch) => {
    const acc = state.accounts.find((a) => a.id === id || a.ref === id);
    if (!acc) return null;
    const allow = [
      'name', 'region', 'authType', 'accessKeyId', 'secretAccessKey', 'securityToken',
      'domainId', 'userId', 'userName', 'department', 'proxy', 'enabled', 'note', 'expiresAt', 'ref',
    ];
    for (const k of allow) if (patch[k] !== undefined) acc[k] = patch[k];
    save();
    return acc;
  };

  const deleteAccount = (id) => {
    const i = state.accounts.findIndex((a) => a.id === id || a.ref === id);
    if (i < 0) return false;
    state.accounts.splice(i, 1);
    save();
    return true;
  };

  const findAccount = (ref) => {
    if (!ref) return null;
    return (
      state.accounts.find((a) => a.id === ref) ||
      state.accounts.find((a) => a.ref === ref) ||
      state.accounts.find((a) => a.accessKeyId === ref) ||
      state.accounts.find((a) => a.accessKeyId?.slice(0, 8) === ref) ||
      state.accounts.find((a) => a.name === ref) ||
      null
    );
  };

  /** 轮询取一个可用账号 */
  let rrIndex = 0;
  const pickAccount = (ref) => {
    if (ref) {
      const a = findAccount(ref);
      return a && a.enabled !== false ? a : null;
    }
    const usable = state.accounts.filter((a) => a.enabled !== false);
    if (usable.length === 0) return null;
    const a = usable[rrIndex % usable.length];
    rrIndex = (rrIndex + 1) % usable.length;
    a.lastUsedAt = new Date().toISOString();
    return a;
  };

  /* ---------- API Key ---------- */

  const addKey = (input) => {
    const k = {
      id: `key_${rand(8)}`,
      name: input.name || '未命名 Key',
      key: input.key || generateKey(),
      enabled: input.enabled !== false,
      accountRef: input.accountRef ?? null,
      models: Array.isArray(input.models) && input.models.length ? input.models : ['*'],
      note: input.note ?? '',
      createdAt: new Date().toISOString(),
      deletedAt: null,
    };
    state.apiKeys.push(k);
    save();
    return k;
  };

  const updateKey = (id, patch) => {
    const k = state.apiKeys.find((x) => x.id === id || x.key === id);
    if (!k) return null;
    for (const f of ['name', 'enabled', 'accountRef', 'models', 'note']) {
      if (patch[f] !== undefined) k[f] = patch[f];
    }
    save();
    return k;
  };

  /** 软删除：保留历史用量归因 */
  const deleteKey = (id) => {
    const k = state.apiKeys.find((x) => x.id === id || x.key === id);
    if (!k) return false;
    k.enabled = false;
    k.deletedAt = new Date().toISOString();
    save();
    return true;
  };

  const findKey = (raw) => {
    if (!raw) return null;
    return state.apiKeys.find((k) => k.key === raw && !k.deletedAt) ?? null;
  };

  /** 校验 Key + 模型白名单 */
  const authorize = (rawKey, model) => {
    if (state.apiKeys.length === 0) return { ok: true, key: null, anonymous: true };
    const k = findKey(rawKey);
    if (!k) return { ok: false, code: 'invalid_api_key', message: 'API Key 无效或已删除' };
    if (k.enabled === false) return { ok: false, code: 'key_disabled', message: 'API Key 已停用' };
    if (model && Array.isArray(k.models) && !k.models.includes('*')) {
      const hit = k.models.some((pat) => {
        const p = String(pat).trim();
        if (!p) return false;
        if (p.includes('*')) {
          const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
          return re.test(model);
        }
        return p === model;
      });
      if (!hit) {
        return { ok: false, code: 'model_not_allowed', message: `该 Key 不允许使用模型 ${model}` };
      }
    }
    return { ok: true, key: k, anonymous: false };
  };

  /* ---------- 用量 ---------- */

  const recordUsage = (entry) => {
    const row = {
      ts: new Date().toISOString(),
      keyId: entry.keyId ?? null,
      keyName: entry.keyName ?? null,
      accountId: entry.accountId ?? null,
      accountName: entry.accountName ?? null,
      model: entry.model ?? 'unknown',
      route: entry.route ?? 'inferhub.chat',
      status: entry.status ?? 200,
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      cachedTokens: entry.cachedTokens ?? 0,
      stream: !!entry.stream,
      durMs: entry.durMs ?? 0,
    };
    usage.push(row);
    if (usage.length > 20000) usage.splice(0, usage.length - 20000);
    try {
      ensure();
      fs.appendFileSync(usageFile, JSON.stringify(row) + '\n');
    } catch {
      /* 落盘失败不影响主流程 */
    }
    return row;
  };

  const rangeStart = (range, from, to) => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (range) {
      case 'today':
        return midnight.getTime();
      case 'week': {
        const d = new Date(midnight);
        const dow = (d.getDay() + 6) % 7; // 周一为 0
        d.setDate(d.getDate() - dow);
        return d.getTime();
      }
      case 'month':
        return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      case 'custom':
        return from ? new Date(from).getTime() : 0;
      case 'all':
      default:
        return 0;
    }
  };

  const aggregate = ({ range = 'today', from, to } = {}) => {
    const start = rangeStart(range, from, to);
    const end = range === 'custom' && to ? new Date(to).getTime() + 86400000 : Infinity;
    const rows = usage.filter((r) => {
      const t = new Date(r.ts).getTime();
      return t >= start && t <= end;
    });

    const kpi = {
      requests: rows.length,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      avgDurMs: 0,
      errors: 0,
    };
    const byModel = new Map();
    const byAccount = new Map();
    const byKey = new Map();
    const byDay = new Map();
    let durSum = 0;

    for (const r of rows) {
      kpi.promptTokens += r.promptTokens;
      kpi.completionTokens += r.completionTokens;
      kpi.cachedTokens += r.cachedTokens ?? 0;
      if (r.status >= 400) kpi.errors++;
      durSum += r.durMs ?? 0;

      const bump = (map, name, extra = {}) => {
        const e = map.get(name) ?? { name, requests: 0, promptTokens: 0, completionTokens: 0, ...extra };
        e.requests++;
        e.promptTokens += r.promptTokens;
        e.completionTokens += r.completionTokens;
        map.set(name, e);
      };
      bump(byModel, r.model);
      bump(byAccount, r.accountName ?? r.accountId ?? '(未指定)');
      bump(byKey, r.keyName ?? r.keyId ?? '(匿名)');

      const day = String(r.ts).slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }

    kpi.totalTokens = kpi.promptTokens + kpi.completionTokens;
    kpi.avgDurMs = rows.length ? Math.round(durSum / rows.length) : 0;

    const table = (map) =>
      [...map.values()]
        .map((e) => ({ ...e, totalTokens: e.promptTokens + e.completionTokens }))
        .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);

    return {
      range,
      from: start ? new Date(start).toISOString() : null,
      to: end === Infinity ? null : new Date(end).toISOString(),
      kpi,
      models: table(byModel),
      accounts: table(byAccount),
      keys: table(byKey),
      days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, n]) => ({ day, requests: n })),
      recent: rows.slice(-200).reverse(),
    };
  };

  /* ---------- 对外 ---------- */

  return {
    get state() {
      return state;
    },
    load,
    save,
    file,

    createSession,
    checkSession,
    dropSession,
    pruneSessions,
    verifyPassword: (pwd) => verifyPassword(pwd, state.panel),
    setPassword,
    passwordChanged: () => !!state.panel.changed,

    accounts: () => state.accounts,
    publicAccounts: () => state.accounts.map(publicAccount),
    addAccount,
    updateAccount,
    deleteAccount,
    findAccount,
    pickAccount,

    keys: () => state.apiKeys,
    publicKeys: () => state.apiKeys.map(publicKey),
    addKey,
    updateKey,
    deleteKey,
    findKey,
    authorize,
    generateKey,

    settings: () => state.settings,
    updateSettings: (patch) => {
      state.settings = { ...state.settings, ...patch };
      save();
      return state.settings;
    },

    recordUsage,
    aggregate,
    usageRows: () => usage,
    usageCount: () => usage.length,
  };
}
