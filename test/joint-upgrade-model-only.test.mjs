import assert from 'node:assert/strict';
import test from 'node:test';
import { sdk, Type, openJointSession } from './helpers/joint-upgrade-session.mjs';
import { createTypedSubagentExtension } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts';
import { createSubagentWorkspaceTool } from '../packages/pi-subagents-enhanced/src/workspace/tool.ts';
import { createSupervisorAdapter, createSupervisorTool } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts';
import { createSubagentIntegrationTool } from '../packages/pi-subagents-enhanced/child-extensions/integration-queue.ts';
import { registerTaskSchedulerAdapter } from '../src/task-scheduler/adapter.ts';

// 捕获production遗漏model-only，使控制definition在真正codemode/nested工具管线可执行。
test('所有控制工具保持模型声明但codemode与executeTool均不可调用', { timeout: 20000 }, async t => {
 const h = await openJointSession({ factories: [sdk.createCodemodeExtension({ models: false }), pi => {
  createTypedSubagentExtension(pi, { cleanupStore: {}, rpc: { dispose() {} }, discoverAgents: () => ({ agents: [] }) });
  const adapter = createSupervisorAdapter(); adapter.bind(async () => ({ content: [{ type: 'text', text: 'pending' }], details: undefined }));
  pi.registerTool(createSupervisorTool(adapter));
  pi.registerTool(createSubagentIntegrationTool({ coordinator: {}, resolveBinding: () => ({ runId: 'fixture' }) }));
  registerTaskSchedulerAdapter(pi, { env: { XDG_STATE_HOME: '/tmp' }, upstreamExtension(api) {
    for (const name of ['scheduler_create', 'scheduler_list', 'scheduler_get', 'scheduler_delete']) api.registerTool({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'fixture' }], details: undefined }) });
  } });
 }] }); t.after(() => h.close());
 const names = ['subagent', 'subagent_worktree', 'subagent_supervisor', 'subagent_integration', 'scheduler_create', 'scheduler_list', 'scheduler_get', 'scheduler_delete'];
 for (const name of names) {
  assert.ok(h.session.getActiveToolNames().includes(name), name + ': 保留模型声明');
  assert.equal(h.session.getCallableToolNames().includes(name), false, name + ': nested不可调用');
  const result = await h.invoke('codemode', { code: `await tools.${name}({action:"status"});` });
  assert.equal(result.isError, true, name);
 }
 const result = await h.invoke('subagent_supervisor', { action: 'pending' }); assert.equal(result.isError, false, result.content.map(c => c.text ?? '').join('\n'));
 assert.equal(result.content[0].text, 'pending');
 assert.ok(!h.session.getAllTools().some(tool => tool.name === 'tool_search'));
 const modelResult = await h.invoke('codemode', { code: 'await models.getModelsOfType("image");' }); assert.equal(modelResult.isError, true, '不启用模型sandbox');
});
