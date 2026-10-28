// 最小 MCP stdio 服务器：JSON-RPC over stdin/stdout。
// 用途：验证码道 CLI 接入 MCP 后工具是否出现在请求里。
// 用法：node tools/mcp-server.mjs
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'mock_echo',
    description: 'mock-hub 提供的测试工具：原样返回输入',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'mock_time',
    description: 'mock-hub 提供的测试工具：返回当前时间',
    inputSchema: { type: 'object', properties: {} },
  },
];

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try {
    req = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = req;

  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      reply({
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-hub-mcp', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      reply({ tools: TOOLS });
      break;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'mock_echo') {
        reply({ content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] });
      } else if (name === 'mock_time') {
        reply({ content: [{ type: 'text', text: new Date().toISOString() }] });
      } else {
        fail(-32602, `unknown tool: ${name}`);
      }
      break;
    }

    case 'ping':
      reply({});
      break;

    default:
      if (id !== undefined) fail(-32601, `method not found: ${method}`);
  }
});
