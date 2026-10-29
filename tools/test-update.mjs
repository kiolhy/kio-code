// 在线更新 + GitHub 授权 回归测试：用一个假 GitHub 服务器 + 一个临时「项目」跑通
// check → apply → 回滚 → 语法/缺文件校验 → 设备码登录
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdater } from '../lib/updater.mjs';
import { createGithub } from '../lib/gh.mjs';
import { createTarGz, extractTarGz, stripTopDir, safeJoin } from '../lib/tar.mjs';

let pass = 0;
let fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ' \x1b[90m' + d + '\x1b[0m' : ''}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n} \x1b[31m${d}\x1b[0m`); };

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-update-'));
const root = path.join(tmp, 'app');
const dataDir = path.join(tmp, 'data');
const files = {
  'server.mjs': "console.log('v1');\n",
  'package.json': JSON.stringify({ name: 'kio-code-gateway', version: '1.0.0', type: 'module' }),
  'lib/gateway.mjs': 'export const GATEWAY = 1;\n',
  'lib/x.mjs': 'export const X = 1;\n',
  'public/dashboard.html': '<html>v1</html>\n',
  'config.json': JSON.stringify({ port: 8787, marker: 'user-config' }),
  'build-info.json': JSON.stringify({ sha: SHA_A, version: '1.0.0', source: 'test' }),
};
for (const [rel, content] of Object.entries(files)) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'keep.txt'), 'precious\n');

/* ---------------- 假 GitHub 服务器 ---------------- */
const tarballs = new Map(); // sha -> Buffer
let pollCount = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && u.pathname === '/repos/o/r/commits') {
    return send(200, [
      { sha: SHA_B, html_url: 'https://example/commit/b', commit: { message: 'feat: 在线更新', author: { name: 't', date: '2026-10-29T00:00:00Z' }, committer: { date: '2026-10-29T00:00:00Z' } } },
      { sha: SHA_A, html_url: 'https://example/commit/a', commit: { message: 'chore: 基线', author: { name: 't', date: '2026-10-28T00:00:00Z' }, committer: { date: '2026-10-28T00:00:00Z' } } },
    ]);
  }
  if (req.method === 'GET' && u.pathname === '/repos/o/r') {
    return send(200, { full_name: 'o/r', default_branch: 'main' });
  }
  if (req.method === 'GET' && u.pathname.startsWith('/codeload/o/r/tar.gz/')) {
    const sha = u.pathname.split('/').pop();
    const buf = tarballs.get(sha);
    if (!buf) { res.writeHead(404); return res.end('no tarball'); }
    res.writeHead(200, { 'content-type': 'application/gzip' });
    return res.end(buf);
  }
  if (req.method === 'POST' && u.pathname === '/login/device/code') {
    return send(200, {
      device_code: 'DC_TEST_1', user_code: 'ABCD-1234',
      verification_uri: `http://127.0.0.1:${server.address().port}/login/device`,
      expires_in: 900, interval: 1,
    });
  }
  if (req.method === 'POST' && u.pathname === '/login/oauth/access_token') {
    pollCount += 1;
    if (pollCount >= 2) return send(200, { access_token: 'gho_testtoken123', scope: 'repo', token_type: 'bearer' });
    return send(200, { error: 'authorization_pending', error_description: 'pending' });
  }
  res.writeHead(404);
  res.end('nf');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const cfg = {
  github: {
    repo: 'o/r', branch: 'main', clientId: 'test-client-id',
    apiBase: base, webBase: base, codeloadBase: base + '/codeload', proxy: '', token: '',
  },
  update: { enabled: true, allowApply: true, checkCommits: 10 },
};

const updater = createUpdater({ cfg, rootDir: root, dataDir, log: () => {} });

const newTar = (overrides = {}, version = '1.1.0', extra = {}) => {
  const baseFiles = {
    [`repo-${SHA_B}/server.mjs`]: "console.log('v2');\n",
    [`repo-${SHA_B}/package.json`]: JSON.stringify({ name: 'kio-code-gateway', version, type: 'module' }),
    [`repo-${SHA_B}/lib/gateway.mjs`]: 'export const GATEWAY = 2;\n',
    [`repo-${SHA_B}/lib/extra.mjs`]: 'export const EXTRA = 1;\n',
    [`repo-${SHA_B}/public/dashboard.html`]: '<html>v2</html>\n',
  };
  Object.assign(baseFiles, extra);
  for (const [k, v] of Object.entries(overrides)) baseFiles[k] = v;
  // 传 null 表示「这个文件不要出现在更新包里」
  for (const k of Object.keys(baseFiles)) if (baseFiles[k] == null) delete baseFiles[k];
  return createTarGz(baseFiles);
};

console.log('\x1b[1m[1] 基础能力\x1b[0m');
{
  ok('tar 打包/解包往返', (() => {
    const entries = stripTopDir(extractTarGz(createTarGz({ 'repo-x/a.txt': 'hi', 'repo-x/b/c.txt': 'yo' })));
    return entries.length === 2 && entries.find((e) => e.path === 'a.txt')?.data.toString() === 'hi';
  })());
  ok('safeJoin 拒绝越界', (() => {
    try {
      safeJoin('/tmp/x', '../../evil');
      return false;
    } catch {
      return true;
    }
  })());
  ok('tar 含 ../ 时条目被保留（拦截点在下游 safeJoin）', (() => {
    const entries = extractTarGz(createTarGz({ '../evil.txt': 'x' }));
    return entries[0]?.path === '../evil.txt';
  })());

  const st = updater.status();
  ok('status 带当前修订', st.current?.sha === SHA_A, st.current?.sha?.slice(0, 7) ?? 'null');
  ok('repo/branch 透传', st.repo === 'o/r' && st.branch === 'main', `${st.repo}@${st.branch}`);
  ok('未授权时 configured=false', st.auth?.configured === false, JSON.stringify(st.auth));
}

console.log('\n\x1b[1m[2] 检查更新\x1b[0m');
let checkRes;
{
  checkRes = await updater.check();
  ok('检出 behind=true', checkRes.behind === true, String(checkRes.behind));
  ok('最新 sha 正确', checkRes.latest?.sha === SHA_B, checkRes.latest?.sha?.slice(0, 7));
  ok('待更新提交数 = 1', checkRes.commits?.length === 1, String(checkRes.commits?.length));
  ok('lastCheck 已记录', !!updater.lastCheck?.checkedAt, updater.lastCheck?.checkedAt);
}

console.log('\n\x1b[1m[3] 应用更新\x1b[0m');
let applyRes;
{
  tarballs.set(SHA_B, newTar());
  applyRes = await updater.apply({ sha: SHA_B });
  ok('apply 成功', applyRes.ok === true, JSON.stringify(applyRes));
  ok('要求重启', applyRes.restartRequired === true);
  ok('server.mjs 已换成 v2', fs.readFileSync(path.join(root, 'server.mjs'), 'utf8').includes('v2'));
  ok('lib 被整体替换', fs.existsSync(path.join(root, 'lib', 'extra.mjs')));
  ok('config.json 未被覆盖', JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).marker === 'user-config');
  ok('data/ 未被覆盖', fs.readFileSync(path.join(root, 'data', 'keep.txt'), 'utf8') === 'precious\n');
  ok('build-info.json 指向新 sha', (await import('../lib/version.mjs')).localRevision(root).sha === SHA_B);
  ok('备份目录存在', applyRes.backup && fs.existsSync(applyRes.backup), applyRes.backup);
}

console.log('\n\x1b[1m[4] 回滚\x1b[0m');
{
  const rb = updater.rollback();
  ok('回滚成功', rb.ok === true, JSON.stringify(rb));
  ok('server.mjs 恢复 v1', fs.readFileSync(path.join(root, 'server.mjs'), 'utf8').includes('v1'));
  ok('build-info 恢复 a', (await import('../lib/version.mjs')).localRevision(root).sha === SHA_A);
}

console.log('\n\x1b[1m[5] 校验兜底\x1b[0m');
{
  tarballs.set(SHA_B, newTar({}, '1.1.0', { [`repo-${SHA_B}/lib/bad.mjs`]: 'export const = ;\n' }));
  let threw = null;
  try { await updater.apply({ sha: SHA_B }); } catch (e) { threw = e; }
  ok('语法错误被拦下', threw?.code === 'syntax_error', `${threw?.code}: ${threw?.message}`);
  ok('语法错误后代码没被换', fs.readFileSync(path.join(root, 'server.mjs'), 'utf8').includes('v1'));

  tarballs.set(SHA_B, newTar({ [`repo-${SHA_B}/lib/gateway.mjs`]: null }));
  let threw2 = null;
  try { await updater.apply({ sha: SHA_B }); } catch (e) { threw2 = e; }
  ok('缺关键文件被拦下', threw2?.code === 'invalid_package', threw2?.code);
}

console.log('\n\x1b[1m[6] GitHub 设备码授权\x1b[0m');
{
  const gh = updater.github;
  const dev = await gh.startDeviceFlow({ scope: 'repo' });
  ok('拿到设备码与链接', !!dev.deviceCode && !!dev.verificationUri && !!dev.userCode, `${dev.userCode} ${dev.verificationUri}`);
  const p1 = await gh.pollDeviceFlow(dev.deviceCode);
  ok('第一次轮询 pending', p1.status === 'pending', p1.status);
  const p2 = await gh.pollDeviceFlow(dev.deviceCode);
  ok('第二次轮询 success', p2.status === 'success', p2.status);
  const t = gh.readToken();
  ok('token 已落盘', t?.source === 'device-flow' && t.token === 'gho_testtoken123', t?.source);
  ok('maskedToken 打码', gh.maskedToken() === 'gho_…123', gh.maskedToken());

  gh.saveToken({ token: 'ghp_manualtoken', scope: 'manual' });
  ok('手动 token 覆盖', gh.readToken()?.token === 'ghp_manualtoken');
  gh.clearToken();
  ok('清除 token', gh.readToken() === null);
}

console.log('\n\x1b[1m[7] 未配置 client_id 的报错\x1b[0m');
{
  const gh2 = createGithub({ cfg: { github: { repo: 'o/r', webBase: base, clientId: '' } }, dataDir });
  let threw = null;
  try { await gh2.startDeviceFlow(); } catch (e) { threw = e; }
  ok('缺 client_id 明确报错', threw?.code === 'no_client_id', threw?.code);
}

console.log(`\n\x1b[1m结果：\x1b[0m\x1b[32m${pass} 通过\x1b[0m` + (fail ? `，\x1b[31m${fail} 失败\x1b[0m` : '，\x1b[32m0 失败\x1b[0m'));
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
