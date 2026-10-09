import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

// 隔离stdio fixture只记录自己的启动与调用，不访问模型、网络或凭据。
const [capture] = process.argv.slice(2);
const record = (value) => appendFileSync(capture, JSON.stringify(value) + '\n');
record({ type: 'start', pid: process.pid });
const input = readline.createInterface({ input: process.stdin });
const tools = ['echo', 'forbidden', 'fail_data'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } }));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
input.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'joint-fixture', version: '1' } });
  if (m.method === 'tools/list') return reply(m.id, { tools });
  if (m.method === 'resources/list') return reply(m.id, { resources: [{ uri: 'fixture://one', name: 'one' }] });
  if (m.method === 'resources/templates/list') return reply(m.id, { resourceTemplates: [] });
  if (m.method === 'resources/read') { record({ type: 'resource' }); return reply(m.id, { contents: [{ uri: 'fixture://one', text: 'one' }] }); }
  if (m.method === 'tools/call') {
    record({ type: 'call', name: m.params.name });
    return reply(m.id, { content: [{ type: 'text', text: m.params.arguments?.value ?? m.params.name }], structuredContent: { value: m.params.arguments?.value ?? m.params.name }, ...(m.params.name === 'fail_data' ? { isError: true } : {}) });
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not found' } }) + '\n');
});
