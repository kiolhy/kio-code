// 最小 tar / tar.gz 读写：只做在线更新需要的那部分（ustar + pax 路径 + GNU longname）
// 不引第三方依赖，解包时强制路径安全（拒绝绝对路径与 .. 穿越）
import zlib from 'node:zlib';
import path from 'node:path';

const BLOCK = 512;

const cstr = (buf, start, len) => {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
};

function parseSize(field) {
  if (field[0] & 0x80) {
    // base-256（GNU 大文件），按大端整数读
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  const s = cstr(field, 0, field.length).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = parseInt(data.subarray(i, space).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(space + 1, i + len - 1).toString('utf8'); // 去掉结尾 \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** 安全拼接：任何绝对路径 / 越界路径直接抛错 */
export function safeJoin(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`tar 路径越界：${rel}`);
  }
  return target;
}

/**
 * 解 tar.gz → [{ path, type:'file'|'dir', data, size }]
 * 链接类条目（符号链接/硬链接）直接跳过：更新包不需要它们，跳过比跟随安全。
 */
export function extractTarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  const entries = [];
  let off = 0;
  let longName = null;
  let paxPath = null;

  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break;

    const name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    const size = parseSize(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = off + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      const pax = parsePax(data);
      if (pax.path) paxPath = pax.path;
      continue;
    }
    if (type === 'g') continue; // 全局 pax，忽略
    if (type === 'L') {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === 'K') continue; // GNU longlink

    let rel = longName ?? (prefix ? `${prefix}/${name}` : name);
    if (paxPath) rel = paxPath;
    longName = null;
    paxPath = null;

    if (type === '5') {
      entries.push({ path: rel.replace(/\/+$/, ''), type: 'dir', data: null, size: 0 });
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') continue; // 链接/设备/未知类型：跳过
    entries.push({ path: rel, type: 'file', data: Buffer.from(data), size: data.length });
  }

  return entries;
}

/** GitHub tarball 外面套了一层 `<repo>-<sha>/`，这里统一剥掉 */
export function stripTopDir(entries) {
  const roots = new Set();
  for (const e of entries) roots.add(e.path.split('/')[0]);
  if (roots.size !== 1) return entries;
  const [root] = roots;
  return entries
    .map((e) => {
      const rest = e.path.slice(root.length).replace(/^\/+/, '');
      return rest ? { ...e, path: rest } : null;
    })
    .filter(Boolean);
}

function octal(value, len) {
  const s = Math.max(0, value).toString(8);
  return s.padStart(len - 1, '0') + '\0';
}

function headerFor({ name, size, mode = 0o644, mtime = Math.floor(Date.now() / 1000) }) {
  const buf = Buffer.alloc(BLOCK, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(base) > 100) {
    // 拆成 prefix/name，都塞进 ustar 字段
    const parts = base.split('/');
    base = parts.pop();
    while (parts.length && Buffer.byteLength(parts.join('/')) > 155) parts.shift();
    prefix = parts.join('/');
    if (Buffer.byteLength(base) > 100 || !prefix) throw new Error(`路径过长，无法写入 ustar：${name}`);
  }
  buf.write(base, 0, 100, 'utf8');
  buf.write(octal(mode, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii');
  buf.write(octal(0, 8), 116, 8, 'ascii');
  buf.write(octal(size, 12), 124, 12, 'ascii');
  buf.write(octal(mtime, 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // 校验和先按空格
  buf.write('0', 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

/** 反向：files: Map<string, Buffer|string> 或 {path: content} → tar.gz，测试与打包用 */
export function createTarGz(files, { mtime = Math.floor(Date.now() / 1000) } = {}) {
  const list = files instanceof Map ? [...files.entries()] : Object.entries(files ?? {});
  const chunks = [];
  for (const [name, content] of list) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    chunks.push(headerFor({ name, size: data.length, mtime }));
    chunks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(chunks));
}
