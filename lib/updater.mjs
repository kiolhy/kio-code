// 在线更新：检测 GitHub 上的提交 → 下载 tarball → 校验 → 备份 → 换文件 → 可回滚
// 只动代码文件；config.json / data/ 永远不覆盖
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGithub, GithubError } from './gh.mjs';
import { extractTarGz, stripTopDir, safeJoin } from './tar.mjs';
import { DEFAULT_ROOT, localRevision, readPackage } from './version.mjs';

// 会被更新覆盖的路径（顺序无所谓，目录会整体替换）
const SYNC_PATHS = [
  'server.mjs',
  'lib',
  'public',
  'tools',
  'docs',
  '.github',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'Dockerfile',
  'docker-compose.yml',
  'config.example.json',
  'build-info.json',
];

const REQUIRED = ['server.mjs', 'package.json', 'lib/gateway.mjs', 'public/dashboard.html'];
const MAX_FILES = 4000;

export class UpdateError extends Error {
  constructor(message, { code = 'update_error', status = 400, detail } = {}) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function createUpdater({ cfg = {}, rootDir = DEFAULT_ROOT, dataDir, log = () => {} } = {}) {
  const updateCfg = cfg.update ?? {};
  const gh = createGithub({ cfg, dataDir, log });
  const stateDir = path.join(dataDir, 'update');
  const stateFile = path.join(stateDir, 'state.json');
  const stagingRoot = path.join(stateDir, 'staging');

  let busy = false;
  let last = null;

  const enabled = updateCfg.enabled !== false;

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeState(state) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  function status() {
    const local = localRevision(rootDir);
    const t = gh.readToken();
    return {
      enabled,
      repo: gh.repo,
      branch: gh.branch,
      current: { ...local, short: local.sha ? local.sha.slice(0, 7) : null },
      auth: {
        configured: !!t,
        source: t?.source ?? null,
        masked: gh.maskedToken(),
        login: t?.login ?? null,
        clientId: !!gh.clientId,
      },
      lastCheck: last,
      state: readState(),
    };
  }

  async function check() {
    if (!enabled) throw new UpdateError('在线更新已关闭', { code: 'update_disabled', status: 409 });
    const local = localRevision(rootDir);
    let commits;
    try {
      commits = await gh.latestCommits(Math.max(5, Math.min(Number(updateCfg.checkCommits ?? 10), 30)));
    } catch (e) {
      const msg = e instanceof GithubError ? e.message : String(e?.message ?? e);
      throw new UpdateError(`检查更新失败：${msg}`, { code: 'check_failed', status: 502, detail: msg });
    }
    if (!Array.isArray(commits) || !commits.length) {
      throw new UpdateError('仓库没有提交或分支名不对', { code: 'empty_repo', status: 502 });
    }
    const latest = commits[0];
    const idx = local.sha ? commits.findIndex((c) => c.sha === local.sha) : -1;
    const behind = local.sha ? idx !== 0 : true;
    const pending = idx === -1 ? commits.slice(0, 10) : commits.slice(0, idx);

    last = {
      checkedAt: new Date().toISOString(),
      current: local.sha,
      latest: latest.sha,
      behind,
      count: pending.length,
    };

    return {
      ok: true,
      current: { ...local, short: local.sha ? local.sha.slice(0, 7) : null },
      latest: {
        sha: latest.sha,
        short: latest.sha.slice(0, 7),
        message: (latest.commit?.message ?? '').split('\n')[0],
        author: latest.commit?.author?.name ?? null,
        date: latest.commit?.committer?.date ?? latest.commit?.author?.date ?? null,
        url: latest.html_url ?? null,
      },
      behind,
      ahead: local.sha ? idx > 0 : false,
      unknownRevision: !local.sha,
      commits: pending.map((c) => ({
        sha: c.sha,
        short: c.sha.slice(0, 7),
        message: (c.commit?.message ?? '').split('\n')[0],
        author: c.commit?.author?.name ?? null,
        date: c.commit?.committer?.date ?? c.commit?.author?.date ?? null,
      })),
      checkedAt: last.checkedAt,
    };
  }

  function validateStaging(stagingDir) {
    for (const rel of REQUIRED) {
      if (!fs.existsSync(path.join(stagingDir, rel))) {
        throw new UpdateError(`更新包缺文件：${rel}`, { code: 'invalid_package', status: 502 });
      }
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(stagingDir, 'package.json'), 'utf8'));
    if (!pkg.name || !pkg.version) {
      throw new UpdateError('更新包的 package.json 不完整', { code: 'invalid_package', status: 502 });
    }
    // 语法检查：宁可更新失败，也不要换上一堆跑不起来的 .mjs
    const bad = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name === 'data') continue;
          walk(full);
        } else if (ent.name.endsWith('.mjs')) {
          const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8', timeout: 20000 });
          if (r.status !== 0) bad.push(`${path.relative(stagingDir, full)}: ${(r.stderr || '').split('\n')[0]}`);
        }
      }
    };
    walk(stagingDir);
    if (bad.length) {
      throw new UpdateError(`更新包里有语法错误：${bad[0]}`, { code: 'syntax_error', status: 502, detail: bad.slice(0, 5) });
    }
    return pkg;
  }

  function backupCurrent(backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    const saved = [];
    for (const rel of SYNC_PATHS) {
      const src = path.join(rootDir, rel);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      saved.push(rel);
    }
    return saved;
  }

  function swapIn(stagingDir) {
    const applied = [];
    for (const rel of SYNC_PATHS) {
      const src = path.join(stagingDir, rel);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(rootDir, rel);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      applied.push(rel);
    }
    return applied;
  }

  /** 真正的换文件流程：拿到 tarball 字节后走这里（apply / applyFromUrl 共用） */
  async function doApply(tarBuf, target, { source = 'update' } = {}) {
    const t0 = Date.now();
    const local = localRevision(rootDir);
    if (local.sha && target === local.sha) {
      return { ok: true, alreadyLatest: true, current: local, target };
    }

    log('info', `开始更新 ${local.sha ?? 'unknown'} → ${target}`);
    const entries = stripTopDir(extractTarGz(tarBuf));
    if (!entries.length) throw new UpdateError('更新包是空的', { code: 'empty_package', status: 502 });
    if (entries.length > MAX_FILES) throw new UpdateError(`更新包文件太多：${entries.length}`, { code: 'too_many_files', status: 502 });

    const stagingDir = path.join(stagingRoot, String(target).replace(/[^\w.-]/g, '_'));
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    for (const e of entries) {
      const dest = safeJoin(stagingDir, e.path);
      if (e.type === 'dir') {
        fs.mkdirSync(dest, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, e.data);
      }
    }

    const pkg = validateStaging(stagingDir);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(stateDir, `backup-${stamp}`);
    const saved = backupCurrent(backupDir);
    const applied = swapIn(stagingDir);

    // 覆盖 build-info.json，让没有 .git 的部署也能认出自己
    fs.writeFileSync(
      path.join(rootDir, 'build-info.json'),
      JSON.stringify({ sha: target, version: pkg.version, builtAt: new Date().toISOString(), source }, null, 2)
    );

    const state = {
      from: local.sha,
      to: target,
      version: pkg.version,
      appliedAt: new Date().toISOString(),
      backup: backupDir,
      applied,
      saved,
      durationMs: Date.now() - t0,
    };
    writeState(state);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    log('info', `更新完成 ${String(target).slice(0, 7)}（${applied.length} 项，备份 ${path.basename(backupDir)}）`);

    return {
      ok: true,
      from: local.sha,
      to: target,
      version: pkg.version,
      backup: backupDir,
      restartRequired: true,
      durationMs: state.durationMs,
    };
  }

  async function apply({ sha } = {}) {
    if (!enabled) throw new UpdateError('在线更新已关闭', { code: 'update_disabled', status: 409 });
    if (updateCfg.allowApply === false) throw new UpdateError('面板更新已禁用（update.allowApply=false）', { code: 'apply_disabled', status: 403 });
    if (busy) throw new UpdateError('已有更新在进行中', { code: 'busy', status: 409 });
    busy = true;
    try {
      const local = localRevision(rootDir);
      const target = sha || (await check()).latest.sha;
      if (local.sha && target === local.sha) {
        return { ok: true, alreadyLatest: true, current: local, target };
      }
      const tarBuf = await gh.downloadTarball(target);
      return await doApply(tarBuf, target, { source: 'update' });
    } finally {
      busy = false;
    }
  }

  /**
   * 从任意 URL 更新：GitHub API 连不上时用（镜像 / 自建对象存储 / 内网文件服务）。
   * URL 指向一个 tar.gz（顶层目录会被自动剥掉），校验与备份流程和 apply 完全一致。
   */
  async function applyFromUrl({ url, sha } = {}) {
    if (!enabled) throw new UpdateError('在线更新已关闭', { code: 'update_disabled', status: 409 });
    if (updateCfg.allowApply === false) throw new UpdateError('面板更新已禁用（update.allowApply=false）', { code: 'apply_disabled', status: 403 });
    if (busy) throw new UpdateError('已有更新在进行中', { code: 'busy', status: 409 });
    const u = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(u)) throw new UpdateError('更新包 URL 必须以 http:// 或 https:// 开头', { code: 'bad_url', status: 400 });
    busy = true;
    try {
      let tarBuf;
      try {
        tarBuf = await gh.downloadFrom(u);
      } catch (e) {
        const msg = e instanceof GithubError ? e.message : String(e?.message ?? e);
        throw new UpdateError(`下载更新包失败：${msg}`, { code: 'download_failed', status: 502, detail: msg });
      }
      const fromUrl = u.match(/[0-9a-f]{40}/i)?.[0] ?? null;
      const target = (sha && /^[0-9a-f]{7,40}$/i.test(String(sha).trim()) ? String(sha).trim() : null) ?? fromUrl ?? `url-${Date.now()}`;
      return await doApply(tarBuf, target, { source: 'from-url' });
    } finally {
      busy = false;
    }
  }

  function rollback() {
    if (busy) throw new UpdateError('已有更新在进行中', { code: 'busy', status: 409 });
    const state = readState();
    if (!state?.backup) throw new UpdateError('没有可回滚的备份', { code: 'no_backup', status: 404 });
    if (!fs.existsSync(state.backup)) throw new UpdateError('备份目录已不存在', { code: 'no_backup', status: 404 });

    for (const rel of SYNC_PATHS) {
      const src = path.join(state.backup, rel);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(rootDir, rel);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    }

    const rolledBackAt = new Date().toISOString();
    writeState({ ...state, rolledBackAt, rolledBackTo: state.from });
    log('warn', `已回滚到 ${String(state.from).slice(0, 7)}`);
    return { ok: true, restored: state.from, from: state.to, backup: state.backup, restartRequired: true };
  }

  return {
    enabled,
    repo: gh.repo,
    branch: gh.branch,
    github: gh,
    status,
    check,
    apply,
    applyFromUrl,
    rollback,
    readState,
    get lastCheck() {
      return last;
    },
    get busy() {
      return busy;
    },
    version: () => readPackage(rootDir).version ?? '0.0.0',
  };
}
