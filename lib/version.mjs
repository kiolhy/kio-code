// 版本与本地修订：在线更新要靠它判断「我在哪、对面是谁」
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(here, '..');

export function readPackage(rootDir = DEFAULT_ROOT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function readVersion(rootDir = DEFAULT_ROOT) {
  return readPackage(rootDir).version ?? '0.0.0';
}

/** 构建信息：镜像构建时写进 build-info.json，容器里没有 .git 也能知道自己是哪个提交 */
export function readBuildInfo(rootDir = DEFAULT_ROOT) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(rootDir, 'build-info.json'), 'utf8'));
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

function readGitHead(rootDir) {
  const gitDir = path.join(rootDir, '.git');
  let head;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
  const ref = head.replace(/^ref:\s*/, '').trim();
  try {
    const direct = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(direct)) return direct.toLowerCase();
  } catch {
    /* 走 packed-refs */
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
    }
  } catch {
    /* 没有就没有 */
  }
  return null;
}

/**
 * 本地修订信息
 * 优先 build-info.json（镜像/发布包），其次 .git，最后只能给 null
 */
export function localRevision(rootDir = DEFAULT_ROOT) {
  const info = readBuildInfo(rootDir);
  if (info?.sha && /^[0-9a-f]{7,40}$/i.test(info.sha)) {
    return {
      version: info.version ?? readVersion(rootDir),
      sha: info.sha.toLowerCase(),
      source: 'build-info',
      builtAt: info.builtAt ?? null,
    };
  }
  const gitSha = readGitHead(rootDir);
  if (gitSha) {
    return { version: readVersion(rootDir), sha: gitSha, source: 'git', builtAt: null };
  }
  return { version: readVersion(rootDir), sha: null, source: 'unknown', builtAt: null };
}

export const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : 'unknown');
