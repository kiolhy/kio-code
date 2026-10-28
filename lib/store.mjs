// 落盘 + 内存环形缓冲 + 脱敏
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SENSITIVE = [
  'x-auth-token',
  'x-security-token',
  'authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'proxy-authorization',
];

export function maskValue(name, value) {
  const lower = String(name).toLowerCase();
  if (!SENSITIVE.includes(lower)) return value;
  const s = String(value ?? '');
  if (!s) return s;
  // SDK-HMAC 签名保留结构，只留 AK 与签名前 12 位，便于比对
  if (lower === 'authorization' && s.startsWith('SDK-HMAC-SHA256')) {
    return s.replace(/Signature=([0-9a-f]{12})[0-9a-f]*/i, 'Signature=$1…');
  }
  if (s.length <= 10) return '***';
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length})`;
}

export function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = maskValue(k, v);
  return out;
}

class Ring {
  constructor(limit) {
    this.limit = limit;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    return item;
  }
  list() {
    return this.items;
  }
  get size() {
    return this.items.length;
  }
}

class Jsonl {
  constructor(file) {
    this.file = file;
    ensureDir(path.dirname(file));
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }
  write(obj) {
    try {
      this.stream.write(JSON.stringify(obj) + '\n');
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }
}

export function createStore({ dataDir, maxRecords = 5000 }) {
  ensureDir(dataDir);
  const requests = new Ring(maxRecords);
  const telemetry = new Ring(maxRecords);
  const credentials = new Map();
  // 重放用：保留未脱敏的原始头与 body，只在内存里，不落盘
  const rawById = new Map();
  const rawOrder = [];
  const RAW_LIMIT = Math.min(maxRecords, 500);
  const RAW_BODY_MAX = 1024 * 1024; // 1MB 以上不保留，重放时会提示
  const counters = { requests: 0, chats: 0, telemetry: 0, errors: 0, bytesIn: 0, bytesOut: 0 };
  const byPath = new Map();

  const reqLog = new Jsonl(path.join(dataDir, 'requests.jsonl'));
  const telLog = new Jsonl(path.join(dataDir, 'telemetry.jsonl'));
  const credFile = path.join(dataDir, 'credentials.json');

  if (fs.existsSync(credFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(credFile, 'utf8'));
      for (const [k, v] of Object.entries(raw)) credentials.set(k, v);
    } catch {
      /* ignore */
    }
  }

  let credFlushTimer = null;
  function flushCredentials() {
    if (credFlushTimer) return;
    credFlushTimer = setTimeout(() => {
      credFlushTimer = null;
      try {
        fs.writeFileSync(credFile, JSON.stringify(Object.fromEntries(credentials), null, 2));
      } catch {
        /* ignore */
      }
    }, 500);
    credFlushTimer.unref?.();
  }

  return {
    dataDir,
    counters,
    recordRequest(entry, raw) {
      counters.requests++;
      counters.bytesIn += entry.reqBytes ?? 0;
      counters.bytesOut += entry.resBytes ?? 0;
      if (entry.status >= 400) counters.errors++;
      const key = `${entry.method} ${entry.route}`;
      byPath.set(key, (byPath.get(key) ?? 0) + 1);
      if (raw && (entry.reqBytes ?? 0) <= RAW_BODY_MAX) {
        rawById.set(entry.id, raw);
        rawOrder.push(entry.id);
        while (rawOrder.length > RAW_LIMIT) {
          const old = rawOrder.shift();
          if (old !== entry.id) rawById.delete(old);
        }
      }
      const rec = requests.push(entry);
      reqLog.write(entry);
      return rec;
    },
    /** 按 id 找脱敏记录 */
    findRequest(id) {
      return requests.list().find((r) => r.id === id) ?? null;
    },
    /** 按 id 找原始头/body（重放用） */
    findRaw(id) {
      return rawById.get(id) ?? null;
    },
    /** 是否还能重放 */
    canReplay(id) {
      return rawById.has(id);
    },
    /** 找最近一条由 id 重放产生的记录 */
    latestReplayOf(id) {
      const items = requests.list();
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].replayOf === id) return items[i];
      }
      return null;
    },
    recordTelemetry(entry) {
      counters.telemetry++;
      telemetry.push(entry);
      telLog.write(entry);
      return entry;
    },
    recordCredential(kind, value, meta = {}) {
      if (!value) return;
      const key = `${kind}:${value}`;
      const prev = credentials.get(key);
      credentials.set(key, {
        kind,
        value,
        masked: maskValue(kind, value),
        firstSeen: prev?.firstSeen ?? new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        hits: (prev?.hits ?? 0) + 1,
        ...meta,
      });
      flushCredentials();
    },
    snapshot() {
      return {
        counters: { ...counters },
        byPath: Object.fromEntries([...byPath.entries()].sort((a, b) => b[1] - a[1])),
        requests: requests.list().slice(-400).reverse(),
        telemetry: telemetry.list().slice(-200).reverse(),
        credentials: [...credentials.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1)),
        uptimeSec: Math.round(process.uptime()),
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
      };
    },
    reset() {
      requests.items.length = 0;
      telemetry.items.length = 0;
      rawById.clear();
      rawOrder.length = 0;
      for (const k of Object.keys(counters)) counters[k] = 0;
      byPath.clear();
    },
  };
}
