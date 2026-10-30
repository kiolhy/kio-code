// OpenAI Responses API（POST /v1/responses）转换测试
//
// 上游只认 chat/completions，/v1/responses 靠 responsesToOpenAI /
// openAIToResponses 双向翻译。这里覆盖请求形态、响应形态、错误路径。
import { responsesToOpenAI, openAIToResponses, responsesStreamEvents } from '../lib/gateway.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

/* ---------------- [1] 请求转换 ---------------- */
console.log('\n\x1b[1m[1] responsesToOpenAI 请求转换\x1b[0m');
{
  const r = responsesToOpenAI({ model: 'kimi-k3', input: '你好' });
  ok('字符串 input → user 消息', r.messages.length === 1 && r.messages[0].role === 'user' && r.messages[0].content === '你好');
  ok('model 透传', r.model === 'kimi-k3');
  ok('默认非流式', r.stream === false);

  const r2 = responsesToOpenAI({ model: 'm', input: 'hi', instructions: '你是助手' });
  ok('instructions → system', r2.messages[0].role === 'system' && r2.messages[0].content === '你是助手');
  ok('system 在 user 前', r2.messages[1].role === 'user');

  const r3 = responsesToOpenAI({
    model: 'm',
    input: [{ role: 'user', content: [{ type: 'input_text', text: '北京天气' }] }],
  });
  ok('content 数组 → 文本', r3.messages[0].content === '北京天气');

  const r4 = responsesToOpenAI({
    model: 'm',
    input: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'output_text', text: '在的' }] },
      { role: 'user', content: '继续' },
    ],
  });
  ok('多轮对话保序', r4.messages.length === 3 && r4.messages[1].role === 'assistant' && r4.messages[1].content === '在的');

  const r5 = responsesToOpenAI({
    model: 'm',
    input: [{ role: 'developer', content: '规则' }],
  });
  ok('developer → system', r5.messages[0].role === 'system');

  const r6 = responsesToOpenAI({ model: 'm', input: 'hi', max_output_tokens: 256 });
  ok('max_output_tokens → max_tokens', r6.max_tokens === 256);

  const r7 = responsesToOpenAI({ model: 'm', input: 'hi', max_tokens: 128 });
  ok('max_tokens 也认', r7.max_tokens === 128);

  const r8 = responsesToOpenAI({ model: 'm', input: 'hi', temperature: 0.3, top_p: 0.9 });
  ok('temperature 透传', r8.temperature === 0.3);
  ok('top_p 透传', r8.top_p === 0.9);

  // 工具：Responses 扁平 → chat 嵌套
  const r9 = responsesToOpenAI({
    model: 'm',
    input: 'hi',
    tools: [{ type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
  });
  ok('工具扁平 → 嵌套', r9.tools?.[0]?.type === 'function' && r9.tools[0].function.name === 'get_weather');
  ok('工具 parameters 保留', r9.tools[0].function.parameters.properties.city.type === 'string');
  ok('有工具时带 tool_choice', r9.tool_choice === 'auto');

  // 非 function 类型的工具（web_search 等）上游不支持，丢掉
  const r10 = responsesToOpenAI({ model: 'm', input: 'hi', tools: [{ type: 'web_search' }] });
  ok('非 function 工具被丢弃', !r10.tools);

  // 工具调用往返
  const r11 = responsesToOpenAI({
    model: 'm',
    input: [
      { role: 'user', content: '北京天气' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '晴 25 度' },
    ],
  });
  const asst = r11.messages.find((m) => m.role === 'assistant');
  ok('function_call → assistant.tool_calls', asst?.tool_calls?.[0]?.id === 'call_1');
  ok('arguments 原样保留', asst?.tool_calls?.[0]?.function?.arguments === '{"city":"北京"}');
  const tool = r11.messages.find((m) => m.role === 'tool');
  ok('function_call_output → role:tool', tool?.tool_call_id === 'call_1' && tool?.content === '晴 25 度');

  // text.format → response_format
  const r12 = responsesToOpenAI({ model: 'm', input: 'hi', text: { format: { type: 'json_object' } } });
  ok('text.format → response_format', r12.response_format?.type === 'json_object');

  // 空 input 不炸
  const r13 = responsesToOpenAI({ model: 'm' });
  ok('无 input 时 messages 为空', Array.isArray(r13.messages) && r13.messages.length === 0);
}

/* ---------------- [2] 响应转换 ---------------- */
console.log('\n\x1b[1m[2] openAIToResponses 响应转换\x1b[0m');
{
  const chat = {
    id: 'chatcmpl-abc',
    created: 1793000000,
    model: 'kimi-k3',
    choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 4 } },
  };
  const r = openAIToResponses(chat, { model: 'kimi-k3' });
  ok('object=response', r.object === 'response');
  ok('status=completed', r.status === 'completed');
  ok('output_text 拼好', r.output_text === '你好');
  ok('output[0].type=message', r.output[0].type === 'message');
  ok('content 是 output_text 块', r.output[0].content[0].type === 'output_text');
  ok('annotations 是空数组', Array.isArray(r.output[0].content[0].annotations));
  ok('usage.input_tokens', r.usage.input_tokens === 12);
  ok('usage.output_tokens', r.usage.output_tokens === 8);
  ok('usage.total_tokens', r.usage.total_tokens === 20);
  ok('cached_tokens 搬到 input_tokens_details', r.usage.input_tokens_details.cached_tokens === 4);
  ok('reasoning_tokens 有值', r.usage.output_tokens_details.reasoning_tokens === 0);
  ok('id 带 resp_ 前缀', r.id.startsWith('resp_'));
  ok('created_at 保留', r.created_at === 1793000000);

  // 工具调用
  const t = {
    id: 'c2',
    model: 'GLM-5.2',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
  };
  const rt = openAIToResponses(t, { model: 'GLM-5.2' });
  const fc = rt.output.find((o) => o.type === 'function_call');
  ok('tool_calls → function_call item', !!fc);
  ok('function_call.call_id', fc?.call_id === 'call_1');
  ok('function_call.name', fc?.name === 'get_weather');
  ok('function_call.arguments 是字符串', fc?.arguments === '{"city":"北京"}');
  ok('纯工具调用时 output_text 为空', rt.output_text === '');

  // 空响应兜底
  const empty = openAIToResponses({ id: 'x', model: 'm', choices: [{}], usage: {} }, { model: 'm' });
  ok('空响应也有 output', empty.output.length === 1);
  ok('空响应 output_text 为空串', empty.output_text === '');
  ok('空 usage 归零', empty.usage.input_tokens === 0 && empty.usage.output_tokens === 0);

  // 上游给 input_tokens/output_tokens 命名（部分兼容层这么写）
  const alt = openAIToResponses({ id: 'y', model: 'm', choices: [{ message: { content: 'x' } }], usage: { input_tokens: 5, output_tokens: 3 } });
  ok('兼容 input_tokens 命名', alt.usage.input_tokens === 5 && alt.usage.output_tokens === 3);

  // model 回落
  const noModel = openAIToResponses({ id: 'z', choices: [{ message: { content: 'x' } }] }, { model: 'fallback' });
  ok('model 回落到请求值', noModel.model === 'fallback');
}

/* ---------------- [3] 流式事件 ---------------- */
console.log('\n\x1b[1m[3] responsesStreamEvents 事件序列\x1b[0m');
{
  const evs = responsesStreamEvents({ responseId: 'resp_t', model: 'kimi-k3', text: '你好', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } });
  const names = evs.map((e) => e.event);
  ok('首事件 response.created', names[0] === 'response.created');
  ok('次事件 response.in_progress', names[1] === 'response.in_progress');
  ok('有 output_item.added', names.includes('response.output_item.added'));
  ok('有 content_part.added', names.includes('response.content_part.added'));
  ok('有 output_text.delta', names.includes('response.output_text.delta'));
  ok('有 output_text.done', names.includes('response.output_text.done'));
  ok('有 output_item.done', names.includes('response.output_item.done'));
  ok('末事件 response.completed', names[names.length - 1] === 'response.completed');

  const delta = evs.find((e) => e.event === 'response.output_text.delta');
  ok('delta 带文本', delta?.data?.delta === '你好');
  ok('delta 带 response_id', delta?.data?.response_id === 'resp_t');

  const done = evs.find((e) => e.event === 'response.completed');
  ok('completed 带 usage', done?.data?.response?.usage?.total_tokens === 7);
  ok('completed 带 output_text', done?.data?.response?.output_text === '你好');

  // 无文本时不该发 delta
  const evs2 = responsesStreamEvents({ responseId: 'r2', model: 'm', text: '', usage: null });
  const n2 = evs2.map((e) => e.event);
  ok('无文本时不发 delta', !n2.includes('response.output_text.delta'));
  ok('无文本时仍有 completed', n2[n2.length - 1] === 'response.completed');
}

console.log('');
const color = fail === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}结果：${pass} 通过\x1b[0m，${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
