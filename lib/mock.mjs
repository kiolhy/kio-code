// 全部后端接口的模拟实现 + SSE 流式回复
import crypto from 'node:crypto';
import { summarizeOtlpJson, summarizeOtlp } from './proto.mjs';

const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const hex32 = () => crypto.randomBytes(16).toString('hex');
const hex8 = () => crypto.randomBytes(8).toString('hex');

/** 把一次推理调用记进面板用量（有 panel 才记） */
function recordUsage(ctx, { model, promptTokens, completionTokens, stream }) {
  try {
    ctx?.panel?.recordUsage({
      keyId: ctx.authKey?.id ?? null,
      keyName: ctx.authKey?.name ?? null,
      accountId: ctx.authAccount?.id ?? null,
      accountName: ctx.authAccount?.name ?? null,
      model: model ?? 'unknown',
      route: ctx?.url?.pathname?.includes('messages') ? 'anthropic.messages' : 'inferhub.chat',
      status: 200,
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      durMs: ctx?.started ? Date.now() - ctx.started : 0,
      stream: !!stream,
    });
  } catch {
    /* 记账失败不影响响应 */
  }
}

function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || (m.role !== 'user' && m.role !== 'human')) continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((p) => (typeof p === 'string' ? p : p?.text ?? (p?.type === 'image' ? '[image]' : '')))
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

function countToolDefs(body) {
  return Array.isArray(body?.tools) ? body.tools.length : 0;
}

export function buildReply(body, cfg) {
  const user = lastUserText(body);
  const model = body?.model ?? 'unknown-model';
  const msgs = Array.isArray(body?.messages) ? body.messages.length : 0;
  const tools = countToolDefs(body);
  const mode = cfg.reply?.mode ?? 'echo';

  const header =
    `${cfg.reply?.prefix ?? '[mock-hub]'} 收到 model=${model} messages=${msgs} tools=${tools}` +
    ` stream=${body?.stream === true}`;

  if (mode === 'fixed') return `${header}\n\n${cfg.reply?.text ?? 'fixed reply'}`;

  if (mode === 'script') {
    const arr = cfg.reply?.scripts ?? [];
    if (arr.length) return arr[Math.floor(Math.random() * arr.length)];
  }

  const echo = user.trim() ? user.trim().slice(0, 800) : '(空消息)';
  return (
    `${header}\n\n` +
    `${cfg.reply?.systemPromptNote ?? ''}\n\n` +
    `--- 你发来的最后一条 user 内容（回显）---\n${echo}\n--- 回显结束 ---\n\n` +
    `链路自检：如果你在 CLI 里看到这段文字，说明 CLI → mock-hub 的网关地址、鉴权头、` +
    `流式解析都已打通。`
  );
}

/** 把文本切成小块，模拟 token 流 */
function chunkText(text, size = 12) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function sseWrite(res, obj) {
  res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
}

/** OpenAI /chat/completions 流式 */
/** 工具调用触发：config.simulate.toolCall 优先，其次看用户消息里的 [[tool]] 标记 */
const TOOL_MARKER = /\[\[tool(?::([A-Za-z0-9_]+))?\]\]/i;

function defaultArgsFor(name) {
  switch (name) {
    case 'bash':
      return { command: 'echo mock-tool-ok', description: 'mock-hub 工具调用自检' };
    case 'glob':
      return { pattern: '*' };
    case 'grep':
      return { pattern: 'mock' };
    case 'todowrite':
      return { todos: [{ id: '1', content: 'mock-hub 自检', status: 'completed' }] };
    case 'task':
      return {
        description: 'mock 子任务',
        prompt: '请回答：1+1 等于几？',
        subagent_type: 'explore',
      };
    case 'CodeSemanticSearch':
      return { query: 'mock 代码检索' };
    case 'listSkills':
      return {};
    default:
      return {};
  }
}

function pickToolCall(ctx, body) {
  const configured = ctx?.cfg?.simulate?.toolCall;
  if (configured && configured.name) {
    return { name: configured.name, args: configured.args ?? defaultArgsFor(configured.name) };
  }

  const msgs = body?.messages ?? [];
  // 已经拿到工具结果就收敛成文本回答，否则会无限重复调用
  if (msgs.some((m) => m.role === 'tool')) return null;
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  if (!lastUser) return null;
  const text = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content ?? '');
  const m = text.match(TOOL_MARKER);
  if (!m) return null;
  const name = m[1] || 'bash';
  return { name, args: defaultArgsFor(name) };
}

export async function streamOpenAI(ctx, reply) {
  const { res, cfg, body } = ctx;
  const id = `chatcmpl-${hex32()}`;
  const model = body?.model ?? 'mock-model';
  const created = Math.floor(now() / 1000);
  const delay = Math.max(0, cfg.simulate?.streamChunkDelayMs ?? 25);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  sseWrite(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  // 工具调用模式：让 CLI 真的去执行一次工具，验证多轮链路
  const call = pickToolCall(ctx, body);
  if (call) {
    const callId = `call_${hex32().slice(0, 24)}`;
    sseWrite(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: callId, type: 'function', function: { name: call.name, arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    // 参数分片，模拟真实模型逐字吐 JSON
    const argText = JSON.stringify(call.args);
    for (const piece of chunkText(argText, 12)) {
      await sleep(delay);
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null },
        ],
      });
    }
    await sleep(delay);
    sseWrite(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: estimateTokens(body), completion_tokens: 24, total_tokens: 0 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
    recordUsage(ctx, {
      model,
      promptTokens: estimateTokens(body),
      completionTokens: Math.ceil(argText.length / 3),
      stream: true,
    });
    return;
  }

  for (const piece of chunkText(reply)) {
    await sleep(delay);
    sseWrite(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    });
  }

  await sleep(delay);
  sseWrite(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: estimateTokens(body), completion_tokens: Math.ceil(reply.length / 3), total_tokens: 0 },
  });
  res.write('data: [DONE]\n\n');
  res.end();
  recordUsage(ctx, {
    model,
    promptTokens: estimateTokens(body),
    completionTokens: Math.ceil(reply.length / 3),
    stream: true,
  });
}

/** Anthropic /v1/messages 流式 */
export async function streamAnthropic(ctx, reply) {
  const { res, cfg, body } = ctx;
  const model = body?.model ?? 'mock-model';
  const msgId = `msg_${hex32()}`;
  const delay = Math.max(0, cfg.simulate?.streamChunkDelayMs ?? 25);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  ev('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: estimateTokens(body), output_tokens: 0 },
    },
  });
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  ev('ping', { type: 'ping' });

  for (const piece of chunkText(reply)) {
    await sleep(delay);
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  }

  ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  ev('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: Math.ceil(reply.length / 3) },
  });
  ev('message_stop', { type: 'message_stop' });
  res.end();
}

function estimateTokens(body) {
  const s = JSON.stringify(body?.messages ?? '');
  return Math.max(1, Math.ceil(s.length / 3));
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/* ------------------------------------------------------------------ */
/* 各后端接口的响应体                                                   */
/* ------------------------------------------------------------------ */

export function buildHandlers(cfg, store) {
  const id = cfg.identity ?? {};

  const modelsForXCenter = () =>
    (cfg.models ?? []).map((m) => ({
      model_name: m.model_name,
      model_type: m.model_type ?? 'admin',
      model_parameters: m.model_parameters,
      credit: m.credit ?? [],
    }));

  const modelIds = () => (cfg.models ?? []).map((m) => m.model_parameters?.model_id).filter(Boolean);

  return {
    /* ---------- inferhub / 模型网关 ---------- */

    'inferhub.chat': (ctx) => {
      const reply = buildReply(ctx.body, cfg);
      if (ctx.body?.stream === true) return { stream: 'openai', reply };
      recordUsage(ctx, {
        model: ctx.body?.model,
        promptTokens: estimateTokens(ctx.body),
        completionTokens: Math.ceil(reply.length / 3),
        stream: false,
      });
      return {
        json: {
          id: `chatcmpl-${hex32()}`,
          object: 'chat.completion',
          created: Math.floor(now() / 1000),
          model: ctx.body?.model ?? 'mock-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
          ],
          usage: {
            prompt_tokens: estimateTokens(ctx.body),
            completion_tokens: Math.ceil(reply.length / 3),
            total_tokens: estimateTokens(ctx.body) + Math.ceil(reply.length / 3),
          },
        },
      };
    },

    'anthropic.messages': (ctx) => {
      const reply = buildReply(ctx.body, cfg);
      if (ctx.body?.stream === true) return { stream: 'anthropic', reply };
      return {
        json: {
          id: `msg_${hex32()}`,
          type: 'message',
          role: 'assistant',
          model: ctx.body?.model ?? 'mock-model',
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: estimateTokens(ctx.body), output_tokens: Math.ceil(reply.length / 3) },
        },
      };
    },

    'inferhub.models': () => ({
      json: {
        object: 'list',
        data: modelIds().map((m) => ({
          id: m,
          object: 'model',
          created: Math.floor(now() / 1000),
          owned_by: 'mock-hub',
        })),
      },
    }),

    'inferhub.thinkingVariants': (ctx) => {
      const names = ctx.body?.model_names ?? [];
      return {
        json: {
          code: '0000',
          data: {
            models: names.map((n) => ({ model_name: n, variants_key: n, variants: [] })),
          },
        },
      };
    },

    /* ---------- agent-center ---------- */

    'agentCenter.list': () => ({
      json: {
        total: 1,
        agents: [
          {
            agent_id: id.agentId,
            original_id: id.codeAgentId,
            name: 'Mock CodeAgent',
            description: 'mock-hub 提供的假 CodeAgent',
            status: 'active',
            model_type: 'admin',
          },
        ],
      },
    }),

    'agentCenter.detail': (ctx) => {
      const agentId = ctx.url.searchParams.get('agent_id') ?? id.agentId;
      return {
        json: {
          agent_id: agentId,
          original_id: id.codeAgentId,
          name: 'Mock CodeAgent',
          description: 'mock-hub 提供的假 CodeAgent',
          gpts: {
            models: modelsForXCenter(),
          },
          tools: [],
          prompt: 'You are a mock agent served by mock-hub.',
        },
      };
    },

    /* ---------- 会话（CLI 启动时创建 + 定时轮询状态） ---------- */

    'session.create': (ctx) => ({
      json: {
        code: '0000',
        message: 'ok',
        data: {
          session_id: 'mock-session-0001',
          client_type: 'CodeArts Agent CLI',
          status: 0,
          created_at: new Date().toISOString(),
        },
      },
    }),

    'session.check': () => ({
      json: {
        code: '0000',
        message: 'ok',
        data: {
          total: 1,
          sessions: [
            {
              session_id: 'mock-session-0001',
              client_type: 'CodeArts Agent CLI',
              status: 0,
              created_at: new Date().toISOString(),
            },
          ],
        },
      },
    }),

    'agentCenter.builtinTools': () => ({ json: { tools: [] } }),

    'agentCenter.skillsRules': () => ({ json: { code: '0000', data: { rules: [], list: [] } } }),

    'agentCenter.gatewayConfig': () => ({
      json: {
        code: '0000',
        data: {
          enabled: true,
          name: 'mock-switch',
          value: true,
        },
      },
    }),

    'agentCenter.skillsQuery': () => ({ json: { code: '0000', data: { skills: [], total: 0 } } }),

    'agentCenter.skillsLink': (ctx) => {
      const skillId = ctx.url.searchParams.get('skillId') ?? 'mock-skill';
      return {
        json: {
          code: '0000',
          data: {
            downloadUrl: `http://${cfg.host}:${cfg.port}/mock-download/${encodeURIComponent(skillId)}.zip`,
          },
        },
      };
    },

    /* ---------- benefit-service ---------- */

    'benefit.claim': () => ({
      json: {
        error_code: '0000',
        result: { claimed: cfg.benefit?.claimable !== false, daily_limit: 100 },
      },
    }),

    'benefit.balance': () => ({
      json: { error_code: '0000', result: { balance: cfg.benefit?.balance ?? 999999, unit: 'token' } },
    }),

    'benefit.gatewayConfig': () => ({
      json: {
        error_code: '0000',
        result: {
          endpoint: `http://${cfg.host}:${cfg.port}/api/v2/`,
          models: modelsForXCenter().map((m) => ({
            model_id: m.model_parameters.model_id,
            model_name: m.model_name,
            context_window: m.model_parameters.context_window,
            max_tokens: m.model_parameters.max_tokens,
          })),
        },
      },
    }),

    /* ---------- snap-manager ---------- */

    'snap.currentUser': () => ({
      json: {
        user_id: id.userId,
        domain_id: id.domainId,
        user_name: id.userName,
        name: id.userName,
        department: id.department,
        station_type: id.stationType,
        account: { type: 'mock', balance: cfg.benefit?.balance ?? 999999 },
      },
    }),

    'snap.privacy': () => ({ json: { collect_data: cfg.privacy?.collect_data === true } }),

    'snap.heartbeat': (ctx) => ({
      json: {
        code: '0000',
        data: {
          session_id: ctx.headers['user-session-id'] ?? uuid(),
          status: ctx.body?.status ?? 'running',
          server_time: now(),
        },
      },
    }),

    'snap.pluginStatistics': () => ({
      json: { code: '0000', data: { plugin_count: 0, installed: 0, updated_at: now() } },
    }),

    'snap.skillPublish': (ctx) => {
      const files = ctx.body?.files ?? [];
      return {
        json: {
          code: '0000',
          urls: files.map((f, i) => ({
            fileName: f.fileName ?? `file-${i}`,
            url: `http://${cfg.host}:${cfg.port}/mock-obs/${encodeURIComponent(ctx.body?.skillName ?? 'skill')}/${encodeURIComponent(f.fileName ?? `file-${i}`)}`,
          })),
        },
      };
    },

    'snap.skillComplete': () => ({
      json: { code: '0000', data: { skill_id: `mock-skill-${hex8()}`, status: 'published' } },
    }),

    'snap.skillSubmissions': () => ({
      json: { code: '0000', data: { total: 0, submissions: [], page: 1, page_size: 10 } },
    }),

    /* ---------- prompt-center ---------- */

    'prompt.builtinModel': () => ({
      json: {
        code: '0000',
        data: {
          builtinModels: [cfg.multimodalModel].filter(Boolean),
          defaultModel: cfg.multimodalModel,
        },
      },
    }),

    'prompt.retrieve': () => ({
      json: { code: '0000', data: { prompts: [], total: 0 } },
    }),

    'prompt.featureToggle': () => ({
      json: { code: '0000', data: { ...cfg.featureSwitches } },
    }),

    /* ---------- memory ---------- */

    'memory.listPreferences': () => ({
      json: { preferences: [], total: 0, limit: 200, offset: 0 },
    }),
    'memory.addPreference': () => ({ json: { id: `pref-${hex8()}`, code: '0000' } }),
    'memory.getPreference': (ctx) => ({
      json: { id: ctx.url.pathname.split('/').pop(), type: 'general', content: '', remark: '' },
    }),
    'memory.updatePreference': () => ({ json: { code: '0000' } }),
    'memory.deletePreference': () => ({ json: { code: '0000' } }),

    /* ---------- 其它 ---------- */

    'release.latest': () => ({
      json: {
        version: '26.10.9-mock',
        downloadUrl: '',
        notes: 'mock-hub 不发版',
        forceUpdate: false,
      },
    }),

    'oauth.tokens': () => ({
      json: {
        access_token: `mock-at-${hex32()}`,
        refresh_token: `mock-rt-${hex32()}`,
        token_type: 'Bearer',
        expires_in: 86400,
      },
    }),

    'ops.creditUsage': () => ({
      json: { code: '0000', data: { used: 0, total: cfg.benefit?.balance ?? 999999, unit: 'token' } },
    }),

    /* ---------- codebase（索引 + 语义检索） ---------- */

    // CLI 要的是 { status:'ok', httpStatusCode, result:[...] }，不是 code/data
    'codebase.list': (ctx) => {
      const repoUrl = ctx.url.searchParams.get('repo_url') ?? '';
      return {
        json: {
          status: 'ok',
          httpStatusCode: 200,
          result: [
            {
              codebaseId: 'mock-codebase-0001',
              codebase_id: 'mock-codebase-0001',
              codebaseBranchId: 'mock-branch-0001',
              branch: 'main',
              repo_url: repoUrl || 'https://example.invalid/mock-repo.git',
              isIndexed: true,
              taskId: 'mock-task-0001',
              status: 'completed',
              indexStatus: 'completed',
              progress: 100,
            },
          ],
        },
      };
    },

    'codebase.branches': () => ({
      json: { status: 'ok', httpStatusCode: 200, result: [{ branch: 'main', isDefault: true }] },
    }),

    // POST 是"创建索引任务"，result 必须是对象且带 codebase_id / task_id
    'codebase.create': (ctx) => {
      const body = ctx.body ?? {};
      return {
        json: {
          status: 'ok',
          httpStatusCode: 200,
          result: {
            codebase_id: 'mock-codebase-0001',
            codebaseId: 'mock-codebase-0001',
            task_id: 'mock-task-0001',
            taskId: 'mock-task-0001',
            codebase_branch_id: 'mock-branch-0001',
            branch: body.branch ?? 'main',
            branch_name: body.branch ?? 'main',
            repo_url: body.repo_url ?? '',
            commit_id: body.commit_id ?? '',
            task_status: 'INDEXED',
            is_parsed: true,
          },
        },
      };
    },

    // 索引任务进度：CLI 用 result.full.task_status === "INDEXED" 判断完成
    'codebase.taskProcess': () => ({
      json: {
        status: 'ok',
        httpStatusCode: 200,
        result: {
          full: {
            files: [],
            finished_count: 2,
            task_status: 'INDEXED',
            progress: '100',
            file_total: 2,
            lastUpdateTime: new Date().toISOString(),
            hugeRepo: false,
          },
          increment: {
            files: [],
            finished_count: 0,
            task_status: 'INDEXED',
            progress: '100',
            file_total: -1,
            lastUpdateTime: new Date().toISOString(),
            hugeRepo: false,
          },
        },
      },
    }),

    // 远端任务进度（refreshProcessFromRemote）
    // 注意：CLI 会检查 result.files / result.finished_count / result.task_status 三者都存在
    'codebase.taskProgress': () => ({
      json: {
        status: 'ok',
        httpStatusCode: 200,
        result: {
          files: [],
          task_status: 'INDEXED',
          progress: '100',
          finished_count: 2,
          file_total: 2,
          start_time: new Date().toISOString(),
          create_time: new Date().toISOString(),
          lastUpdateTime: new Date().toISOString(),
          hugeRepo: false,
        },
      },
    }),

    // 已索引文件列表（queryIndexedFiles）：必须带 status 和 total
    'codebase.taskFiles': () => ({
      json: { status: 'ok', httpStatusCode: 200, result: [], total: 0 },
    }),

    // 文件上传：分片上传，收下就返回 ok
    'codebase.uploadIndex': (ctx) => ({
      json: {
        status: 'ok',
        httpStatusCode: 200,
        result: { uploaded: true, received: ctx.rawBody?.length ?? 0 },
      },
    }),

    'codebase.index': () => ({ json: { status: 'ok', message: 'codebase index successfully' } }),

    'codebase.search': (ctx) => {
      const body = ctx.body ?? {};
      const topK = Number(body.top_k ?? 3);
      const items = Array.from({ length: Math.min(topK, 5) }, (_, i) => ({
        codebaseId: 'mock-codebase-0001',
        file_path: `src/mock/module${i + 1}.ts`,
        name: `mockSymbol${i + 1}`,
        type: 'function',
        start_line: 10 * (i + 1),
        end_line: 10 * (i + 1) + 8,
        content: `// mock-hub 返回的假代码片段 ${i + 1}\nexport function mockSymbol${i + 1}() {\n  return 'mock';\n}`,
        score: 0.9 - i * 0.1,
      }));
      return { json: { status: 'ok', httpStatusCode: 200, result: items } };
    },

    'codebase.graphSearch': () => ({
      json: {
        status: 'ok',
        httpStatusCode: 200,
        result: {
          chains: [
            {
              chain_id: 'mock-chain-0001',
              summary: 'mock-hub 返回的假调用链',
              nodes: [
                { name: 'mockEntry', file_path: 'src/mock/entry.ts', start_line: 1, end_line: 12 },
                { name: 'mockSymbol1', file_path: 'src/mock/module1.ts', start_line: 10, end_line: 18 },
              ],
            },
          ],
        },
      },
    }),

    'codebase.embedding': (ctx) => {
      const input = ctx.body?.input ?? ctx.body?.texts ?? [];
      const n = Array.isArray(input) ? input.length : 1;
      return {
        json: {
          status: 'ok',
          httpStatusCode: 200,
          result: Array.from({ length: n }, () => Array.from({ length: 8 }, (_, i) => Number((0.1 * (i + 1)).toFixed(3)))),
        },
      };
    },

    'codebase.rerank': (ctx) => {
      const docs = ctx.body?.documents ?? [];
      return {
        json: {
          status: 'ok',
          httpStatusCode: 200,
          result: (Array.isArray(docs) ? docs : []).map((d, i) => ({
            index: i,
            relevance_score: Number((0.95 - i * 0.05).toFixed(3)),
          })),
        },
      };
    },

    'skills.list': () => ({ json: { skills: [], total: 0 } }),
  };
}

/* ------------------------------------------------------------------ */
/* 遥测接收                                                             */
/* ------------------------------------------------------------------ */

export function handleOtlp(ctx, kind, cfg, store) {
  const ct = String(ctx.headers['content-type'] ?? '');
  let record;

  if (ct.includes('json')) {
    let parsed = null;
    try {
      parsed = JSON.parse(ctx.rawBody.toString('utf8'));
    } catch {
      parsed = null;
    }
    record = parsed
      ? { ts: new Date().toISOString(), path: ctx.url.pathname, format: 'json', ...summarizeOtlpJson(parsed, kind) }
      : { ts: new Date().toISOString(), path: ctx.url.pathname, format: 'json', parseError: true, raw: ctx.rawBody.toString('utf8').slice(0, 4000) };
  } else {
    const summary = summarizeOtlp(ctx.rawBody, kind);
    record = { ts: new Date().toISOString(), path: ctx.url.pathname, format: 'protobuf', ...summary };
  }

  // 记下这条上报是从哪个域名进来的（capture 模式下 443 接住的官方域名）
  if (ctx.host) {
    record.host = ctx.host;
    record.ingress = ctx.ingress ?? 'https';
  }

  store.recordTelemetry(record);
  return { status: 200, json: { partialSuccess: {} } };
}

export const otlpExportResponse = () => ({
  status: 200,
  json: { partialSuccess: {}, rejectedLogRecords: 0, rejectedSpans: 0 },
});
