import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelSelection, resolveModelCandidates } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts';
const models = [
 { provider: 'fixture', id: 'virtual', api: 'pi-virtual' },
 { provider: 'fixture', id: 'chat', api: 'openai-completions' },
];
for (const input of [{ requestedModel: 'fixture/virtual' }, { requestedModel: 'virtual', agentModels: ['fixture/virtual'] }, { requestedModel: 'virtual' }]) {
 test('typed选择拒绝virtual而非悄悄重选：' + JSON.stringify(input), () => {
  assert.throws(() => resolveModelSelection({ ...input, agentName: 'executor', availableModels: models }), e => e.code === 'VIRTUAL_MODEL_UNSUPPORTED_BY_DISPATCH');
 });
}
test('profile默认与fallback完整链拒绝virtual，正常chain不丢api事实', () => {
 assert.throws(() => resolveModelCandidates({ agentName: 'executor', models: ['fixture/virtual', 'fixture/chat'], availableModels: models }), e => e.code === 'VIRTUAL_MODEL_UNSUPPORTED_BY_DISPATCH');
 assert.equal(resolveModelSelection({ agentName: 'executor', requestedModel: 'fixture/chat', availableModels: models }).resolvedApi, 'openai-completions');
});
test('已匹配模型api缺失不得作为chat放行', () => {
 assert.throws(() => resolveModelSelection({ agentName: 'executor', requestedModel: 'fixture/broken', availableModels: [{ provider: 'fixture', id: 'broken' }] }), e => e.code === 'MODEL_API_UNAVAILABLE');
});
