import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolvePiHostPackageEntry } from './pi-host.mjs';

const root = process.env.PI_TEST_CODING_AGENT_ROOT?.trim()
  || join(import.meta.dirname, '../../node_modules/@earendil-works/pi-coding-agent');
assert.ok(root.startsWith('/'), '联合测试必须使用绝对physical Host路径');
// 生产 main 会话的 agentDir 下始终存在 pi/extensions/agents-shared.ts：runtime 主入口
// 无条件把它注册为 required child extension，注册时按 realpath 归一化并要求文件存在。
// 合成 agentDir 必须补齐同一真实入口，否则 required 注册在生产语义下按设计失败。
// 用指向仓内权威 binding（pi/extensions/agents-shared.ts）的 symlink：realpath 后
// 注册快照与生产完全一致，child 加载同一物理文件并经 src/agents-shared 默认锚读仓内
// canonical pi/AGENTS_SHARED.md，不伪造 dummy entry、不绕过真实 required 注册。
const repoRoot = join(import.meta.dirname, '../..');
const agentsSharedBinding = join(repoRoot, 'pi/extensions/agents-shared.ts');
export const sdk = await import(pathToFileURL(resolvePiHostPackageEntry(root, '@earendil-works/pi-coding-agent')));
export const ai = await import(pathToFileURL(resolvePiHostPackageEntry(root, '@earendil-works/pi-ai')));
export const Type = (await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('typebox')))).Type;

// 合成provider只将测试输入变成规范assistant事件；真实tool pipeline/registry/extension由官方SDK负责。
export async function openJointSession({ factories = [], files, defaultTools = ['+codemode'], persistent = false, customTools } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'joint-session-'));
  const agentDir = join(temp, 'agent'); const cwd = join(temp, 'cwd');
  await mkdir(agentDir); await mkdir(cwd);
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await symlink(agentsSharedBinding, join(agentDir, 'extensions/agents-shared.ts'), 'file');
  await files?.({ temp, agentDir, cwd });
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools, defaultProjectTrust: 'always', enableInstallTelemetry: false, retry: { enabled: false }, compaction: { enabled: false } });
  const events = sdk.createEventBus();
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus: events, extensionFactories: factories, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  let calls = 0;
  modelRuntime.registerProvider('joint-synthetic', {
    api: 'joint-synthetic', apiKey: 'fixture-not-a-secret', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      if (++calls > 64) throw new Error('fixture provider turn budget exhausted');
      const stream = ai.createAssistantMessageEventStream();
      const user = context.messages.findLast(m => m.role === 'user');
      const text = user?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';

      const after = context.messages.slice(context.messages.lastIndexOf(user) + 1);
      let parsed; try { parsed = JSON.parse(text); } catch {}
      const requested = after.some(m => m.role === 'toolResult') ? undefined : parsed;
      const content = requested ? [{ type: 'toolCall', id: 'joint-' + user.timestamp, name: requested.name, arguments: requested.arguments }] : [{ type: 'text', text: 'done' }];
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage, stopReason: requested ? 'toolUse' : 'stop' };
      stream.push({ type: 'start', partial: message });
      if (requested) {
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
        stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(requested.arguments), partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message });
      } else {
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'done', partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: 'done', partial: message });
      }
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
    },
  });
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, model: modelRuntime.getModel('joint-synthetic', 'fixture'), resourceLoader, customTools, thinkingLevel: 'off', sessionManager: persistent ? sdk.SessionManager.create(cwd, join(agentDir, 'sessions')) : sdk.SessionManager.inMemory(cwd) });
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  return { session, events, temp, agentDir, cwd, errors,
    async invoke(name, args = {}) { const timer = setTimeout(() => session.abort(), 8000); try { await session.prompt(JSON.stringify({ name, arguments: args })); } finally { clearTimeout(timer); } return session.messages.findLast(m => m.role === 'toolResult'); },
    async close() { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); await new Promise(resolve => setTimeout(resolve, 50)); await rm(temp, { recursive: true, force: true }); },
  };
}
