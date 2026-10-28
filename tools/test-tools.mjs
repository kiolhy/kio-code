// 新增能力回归：工具调用流、codebase 全套、session 路由、MCP 工具目录。
import http from 'node:http';

const HUB = process.env.HUB ?? 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  }
};

const json = async (path, init) => {
  const r = await fetch(HUB + path, init);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
};

const post = (path, body) =>
  json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const sse = async (path, body) => {
  const r = await fetch(HUB + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const chunks = text
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { status: r.status, chunks };
};

await fetch(`${HUB}/admin/api/reset`, { method: 'POST' });

console.log('\n\x1b[1m[1] 会话路由\x1b[0m');
{
  const c = await post('/v1/sessions', { client_type: 'CodeArts Agent CLI' });
  ok('POST /v1/sessions 200', c.status === 200, `status=${c.status}`);
  ok('返回 data.session_id', !!c.body?.data?.session_id, c.body?.data?.session_id ?? '');
  ok('status 字段为 0（活跃）', c.body?.data?.status === 0);

  const g = await json('/v1/sessions?page=1&page_size=10');
  ok('GET /v1/sessions 200', g.status === 200);
  ok('sessions[0].status === 0', g.body?.data?.sessions?.[0]?.status === 0);
}

console.log('\n\x1b[1m[2] 工具调用流（OpenAI 格式）\x1b[0m');
{
  const r = await sse('/api/v2/chat/completions', {
    model: 'mock-thinking',
    stream: true,
    messages: [{ role: 'user', content: '请执行 [[tool]]' }],
  });
  ok('200 且是 SSE', r.status === 200 && r.chunks.length > 0, `${r.chunks.length} 块`);

  const tc = r.chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
  ok('含 tool_calls 增量块', tc.length > 0, `${tc.length} 块`);

  const first = tc[0]?.choices?.[0]?.delta?.tool_calls?.[0];
  ok('首块带 id 和函数名', !!first?.id && first?.function?.name === 'bash', `${first?.function?.name}`);
  ok('首块 arguments 为空（分片开始）', first?.function?.arguments === '');

  const args = tc.map((c) => c.choices[0].delta.tool_calls[0].function?.arguments ?? '').join('');
  let parsed = null;
  try {
    parsed = JSON.parse(args);
  } catch {
    /* ignore */
  }
  ok('参数分片能拼成合法 JSON', parsed !== null, args.slice(0, 60));
  ok('bash 参数含 command', typeof parsed?.command === 'string', parsed?.command ?? '');

  const last = r.chunks.at(-1);
  ok('finish_reason 是 tool_calls', last?.choices?.[0]?.finish_reason === 'tool_calls', last?.choices?.[0]?.finish_reason);
}

console.log('\n\x1b[1m[3] 工具调用收敛（有 tool 结果后回文本）\x1b[0m');
{
  const r = await sse('/api/v2/chat/completions', {
    model: 'mock-thinking',
    stream: true,
    messages: [
      { role: 'user', content: '请执行 [[tool]]' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'mock-tool-ok' },
    ],
  });
  const tc = r.chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
  ok('不再返回 tool_calls', tc.length === 0, `${tc.length} 块`);
  const last = r.chunks.at(-1);
  ok('finish_reason 是 stop', last?.choices?.[0]?.finish_reason === 'stop', last?.choices?.[0]?.finish_reason);
}

console.log('\n\x1b[1m[4] codebase 接口\x1b[0m');
{
  const list = await json('/codebaseservice/v1/codebases?repo_url=x&type=TEAM');
  ok('codebases 200', list.status === 200);
  ok('status === "ok"', list.body?.status === 'ok', String(list.body?.status));
  ok('httpStatusCode 200', list.body?.httpStatusCode === 200);
  ok('result 是非空数组', Array.isArray(list.body?.result) && list.body.result.length > 0);
  ok('result[0].codebaseId 存在', !!list.body?.result?.[0]?.codebaseId, list.body?.result?.[0]?.codebaseId ?? '');
  ok('result[0].branch 存在', !!list.body?.result?.[0]?.branch);
  ok('result[0].isIndexed === true', list.body?.result?.[0]?.isIndexed === true);

  const search = await post('/codebaseservice/v1/codebases/mock-codebase-0001/codenodes/search', {
    query: 'mock',
    top_k: 3,
    type: 'VECTOR',
  });
  ok('codenodes/search 200', search.status === 200);
  ok('返回代码片段', Array.isArray(search.body?.result) && search.body.result.length > 0, `${search.body?.result?.length} 条`);
  ok('片段含 file_path', !!search.body?.result?.[0]?.file_path, search.body?.result?.[0]?.file_path ?? '');
  ok('片段含 content', typeof search.body?.result?.[0]?.content === 'string');

  const graph = await post('/codebaseservice/v1/codebases/mock-codebase-0001/graph/search', { query: 'mock' });
  ok('graph/search 200', graph.status === 200);
  ok('返回调用链', Array.isArray(graph.body?.result?.chains), `${graph.body?.result?.chains?.length} 条`);

  const emb = await post('/codebaseservice/v1/codebases/vector/embedding', { input: ['a', 'b'] });
  ok('embedding 200', emb.status === 200);
  ok('向量数与输入数一致', emb.body?.result?.length === 2, `${emb.body?.result?.length}`);

  const rr = await post('/codebaseservice/v1/codebases/vector/rerank', { documents: ['x', 'y', 'z'] });
  ok('rerank 200', rr.status === 200);
  ok('重排结果数一致', rr.body?.result?.length === 3, `${rr.body?.result?.length}`);
  ok('带 relevance_score', typeof rr.body?.result?.[0]?.relevance_score === 'number');
}

console.log('\n\x1b[1m[5] 插件下载\x1b[0m');
{
  const r = await fetch(HUB + '/codearts/codeAgentPlugin/ripgrep/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip');
  const buf = Buffer.from(await r.arrayBuffer());
  ok('200', r.status === 200);
  ok('是 ZIP（PK 头）', buf.slice(0, 2).toString() === 'PK', buf.slice(0, 2).toString());
  ok('标注来源', !!r.headers.get('x-mock-plugin'), r.headers.get('x-mock-plugin') ?? '');
  ok('体积合理', buf.length > 100 && buf.length < 100000, `${buf.length}B`);
}

console.log('\n\x1b[1m[7] codebase 索引创建链路\x1b[0m');
{
  const create = await post('/codebaseservice/v1/codebases', {
    type: 'PERSONAL',
    repo_url: 'D:\\test\\repo',
    repo_name: 'repo',
    branch: 'master',
    source: 'codebase',
    languages: 'TS',
    commit_id: 'deadbeef',
  });
  ok('POST 创建索引 200', create.status === 200);
  ok('result 是对象不是数组', !Array.isArray(create.body?.result) && typeof create.body?.result === 'object');
  ok('result.codebase_id 存在', !!create.body?.result?.codebase_id, create.body?.result?.codebase_id ?? '');
  ok('result.task_id 存在', !!create.body?.result?.task_id, create.body?.result?.task_id ?? '');

  const prog = await json('/codebaseservice/v1/codebases/mock-codebase-0001/tasks/mock-task-0001/progress');
  ok('taskProgress 200', prog.status === 200);
  ok('status 为 ok', String(prog.body?.status).toLowerCase() === 'ok');
  ok('result.files 存在（CLI 强依赖）', Array.isArray(prog.body?.result?.files));
  ok('result.finished_count 存在', prog.body?.result?.finished_count !== undefined);
  ok('result.task_status 为 INDEXED', prog.body?.result?.task_status === 'INDEXED', prog.body?.result?.task_status ?? '');

  const files = await json('/codebaseservice/v1/codebases/mock-codebase-0001/tasks/mock-task-0001/files');
  ok('taskFiles 200 且带 status', files.status === 200 && !!files.body?.status);
  ok('taskFiles 带 total', files.body?.total !== undefined, String(files.body?.total));

  const up = await post('/codebaseservice/v1/codebases/mock-codebase-0001/tasks/mock-task-0001/index', { files: [] });
  ok('uploadIndex 200', up.status === 200);
}

console.log('\n\x1b[1m[8] 流水记录完整性\x1b[0m');
{
  const state = await (await fetch(`${HUB}/admin/api/state`)).json();
  const routes = new Set(state.requests.map((r) => r.route));
  for (const want of ['session.create', 'session.check', 'codebase.list', 'codebase.search', 'codebase.graphSearch', 'codebase.embedding', 'codebase.rerank', 'plugin.download', 'inferhub.chat']) {
    ok(`记录到 ${want}`, routes.has(want));
  }
  const unmatched = state.requests.filter((r) => r.route === 'unmatched');
  ok('没有 unmatched', unmatched.length === 0, `${unmatched.length} 条`);
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
