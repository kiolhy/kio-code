// 代理池：解析 / 批量添加 / 绑定 / 健康检查
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseProxyLine, parseProxyList, proxyId, maskProxyUrl, pickProxy } from '../lib/proxy-pool.mjs';
import { createPanel } from '../lib/panel.mjs';

let pass = 0;
let fail = 0;
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? '  \x1b[90m' + d + '\x1b[0m' : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d}`); }
};

console.log('\n\x1b[1m[1] 单行解析\x1b[0m');
{
  const a = parseProxyLine('http://1.2.3.4:8080');
  ok('http 裸地址', a?.protocol === 'http' && a.host === '1.2.3.4' && a.port === 8080, JSON.stringify(a));

  const b = parseProxyLine('http://user:p%40ss@1.2.3.4:8080');
  ok('带认证', b?.username === 'user' && b.password === 'p@ss', JSON.stringify({ u: b?.username, p: b?.password }));
  ok('url 里密码被编码', b?.url.includes('p%40ss'), b?.url);

  const c = parseProxyLine('socks5://5.6.7.8:1080');
  ok('socks5', c?.protocol === 'socks5' && c.port === 1080);

  const d = parseProxyLine('1.2.3.4:3128');
  ok('裸 host:port 默认 http', d?.protocol === 'http' && d.port === 3128);

  const e = parseProxyLine('1.2.3.4:3128:admin:secret');
  ok('host:port:user:pass', e?.username === 'admin' && e.password === 'secret', JSON.stringify({ u: e?.username, p: e?.password }));

  const f = parseProxyLine('user:pass@1.2.3.4:8080');
  ok('user:pass@host:port', f?.username === 'user' && f.port === 8080);

  ok('空行返回 null', parseProxyLine('') === null && parseProxyLine('   ') === null);
  ok('注释返回 null', parseProxyLine('# 这是注释') === null);
  ok('缺端口报错', !!parseProxyLine('1.2.3.4')?.error, parseProxyLine('1.2.3.4')?.error);
  ok('端口非法报错', !!parseProxyLine('1.2.3.4:99999')?.error);
  ok('协议不支持报错', !!parseProxyLine('ftp://1.2.3.4:21')?.error);
}

console.log('\n\x1b[1m[2] 批量解析\x1b[0m');
{
  const text = `
# 我的代理
http://1.2.3.4:8080
socks5://user:pass@5.6.7.8:1080

1.2.3.4:8080
9.9.9.9:9999:u:p
badline
`;
  const r = parseProxyList(text);
  // http://1.2.3.4:8080 与裸写 1.2.3.4:8080 归一化后相同，批内去重 → 3 条
  ok('解析出 3 条（批内去重）', r.ok.length === 3, String(r.ok.length));
  ok('去重（1.2.3.4:8080 重复）', r.ok.filter((x) => x.host === '1.2.3.4').length === 1);
  ok('记录错误行', r.errors.length === 1, JSON.stringify(r.errors));
  ok('错误行号正确', r.errors[0]?.line === 8, String(r.errors[0]?.line));
}

console.log('\n\x1b[1m[3] 工具函数\x1b[0m');
{
  ok('id 稳定', proxyId('http://1.2.3.4:8080') === proxyId('http://1.2.3.4:8080'));
  ok('不同 url 不同 id', proxyId('http://1.2.3.4:8080') !== proxyId('http://1.2.3.4:8081'));
  ok('id 前缀', proxyId('http://x:1').startsWith('px_'));

  const m = maskProxyUrl('http://user:secret123@1.2.3.4:8080');
  ok('密码被打码', m.includes('******') && !m.includes('secret123'), m);
  ok('用户名保留', m.includes('user'));
  ok('无认证不变', maskProxyUrl('http://1.2.3.4:8080') === 'http://1.2.3.4:8080');

  const pool = [{ id: 'a', enabled: true }, { id: 'b', enabled: false }, { id: 'c', enabled: true }];
  ok('跳过停用的', pickProxy(pool, { cursor: 0 })?.id === 'a');
  ok('轮询到下一个', pickProxy(pool, { cursor: 1 })?.id === 'c');
  ok('排除指定', pickProxy(pool, { cursor: 0, exclude: ['a'] })?.id === 'c');
  ok('全停用返回 null', pickProxy([{ id: 'x', enabled: false }]) === null);
}

console.log('\n\x1b[1m[4] 面板集成\x1b[0m');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-px-'));
  const panel = createPanel({ dataDir: dir });
  panel.load();

  const r = panel.addProxies('http://1.2.3.4:8080\nsocks5://u:p@5.6.7.8:1080\n1.2.3.4:8080');
  // 第三行归一化成 http://1.2.3.4:8080，与第一行同批重复 → 批内去重，不算 skipped
  ok('新增 2 条', r.added.length === 2, String(r.added.length));
  ok('批内重复不算 skipped', r.skipped.length === 0, JSON.stringify(r.skipped));
  ok('面板里 2 条', panel.proxies().length === 2);

  const again = panel.addProxies('http://1.2.3.4:8080');
  ok('再次添加全跳过', again.added.length === 0 && again.skipped.length === 1);

  const list = panel.publicProxies();
  ok('publicProxies 打码', list[1].maskedUrl.includes('*') && !list[1].maskedUrl.includes(':p@'), list[1].maskedUrl);
  ok('hasAuth 标记', list[1].hasAuth === true && list[0].hasAuth === false);
  ok('usedBy 初始为空', list[0].usedBy.length === 0);

  // 账号绑定代理
  const acc = panel.addAccount({
    name: 'acc1',
    accessKeyId: 'HSTAAK',
    secretAccessKey: 'SKSECRET',
    securityToken: 'TOK',
  });
  const pid = list[0].id;
  const bound = panel.setAccountProxy(acc.id, pid);
  ok('绑定成功', bound?.proxy === list[0].url, bound?.proxy);
  ok('usedBy 有记录', panel.publicProxies()[0].usedBy.includes('acc1'), JSON.stringify(panel.publicProxies()[0].usedBy));

  // 解绑
  panel.setAccountProxy(acc.id, '');
  ok('解绑成功', panel.findAccount(acc.id)?.proxy === '', panel.findAccount(acc.id)?.proxy);

  // 绑定不存在的代理
  ok('绑定不存在的代理返回 null', panel.setAccountProxy(acc.id, 'px_nope') === null);

  // 删除代理时自动解绑
  panel.setAccountProxy(acc.id, pid);
  panel.deleteProxy(pid);
  ok('删除后账号自动解绑', panel.findAccount(acc.id)?.proxy === '', panel.findAccount(acc.id)?.proxy);
  ok('代理数减 1', panel.proxies().length === 1);

  // 持久化
  const panel2 = createPanel({ dataDir: dir });
  panel2.load();
  ok('重启后代理还在', panel2.proxies().length === 1, String(panel2.proxies().length));
  ok('重启后字段完整', panel2.proxies()[0].host === '5.6.7.8', panel2.proxies()[0].host);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n\x1b[1m[5] 健康检查（真实 HTTP 代理）\x1b[0m');
{
  // 起一个极简 HTTP 代理：收到 CONNECT 就返回 200
  const proxySrv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('proxy-ok');
  });
  proxySrv.on('connect', (req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.end();
  });
  await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r));
  const pPort = proxySrv.address().port;

  // 目标服务器
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello-from-target');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const tPort = target.address().port;

  const { checkProxy } = await import('../lib/proxy-pool.mjs');
  const good = await checkProxy({
    proxy: { url: `http://127.0.0.1:${pPort}` },
    testUrl: `http://127.0.0.1:${tPort}/`,
    timeoutMs: 5000,
  });
  ok('可用代理检查通过', good.ok === true, JSON.stringify(good));
  ok('拿到状态码', good.status === 200, String(good.status));
  ok('记录了耗时', typeof good.durMs === 'number' && good.durMs >= 0);

  // 不可用代理（端口没人监听）
  const bad = await checkProxy({
    proxy: { url: 'http://127.0.0.1:1' },
    testUrl: `http://127.0.0.1:${tPort}/`,
    timeoutMs: 2000,
  });
  ok('坏代理检查失败', bad.ok === false, JSON.stringify(bad));
  ok('坏代理有错误信息', typeof bad.error === 'string' && bad.error.length > 0, bad.error);

  proxySrv.close();
  target.close();
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
