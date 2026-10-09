import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { loadChildToolCeilingConfig, registerConfiguredChildToolCeiling } = await import('../packages/pi-subagents-enhanced/src/subagent-dispatch/child-tool-policy.ts');

async function agentDir(t, config) {
  const root = await mkdtemp(join(tmpdir(), 'joint-ceiling-'));
  await mkdir(join(root, 'extensions', 'subagent'), { recursive: true });
  if (config !== undefined) await writeFile(join(root, 'extensions', 'subagent', 'config.json'), JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('无childToolCeiling配置时不注册并保持缺省行为', async (t) => {
  const root = await agentDir(t);
  assert.equal(loadChildToolCeilingConfig(root), undefined);
  let calls = 0;
  assert.equal(registerConfiguredChildToolCeiling({ agentDir: root, sessionId: 'session-1', register() { calls += 1; } }), undefined);
  assert.equal(calls, 0);
});

test('显式childToolCeiling只注册精确opt-in策略', async (t) => {
  const root = await agentDir(t, { childToolCeiling: { allowedTools: ['read', 'contact_supervisor'], allowedAgents: ['reviewer'] } });
  let received;
  const handle = registerConfiguredChildToolCeiling({ agentDir: root, sessionId: 'session-1', register(options) { received = options; return { dispose() {} }; } });
  assert.deepEqual(received, { sessionId: 'session-1', source: 'typed-subagent-runtime', ceiling: { allowedTools: ['contact_supervisor', 'read'], allowedAgents: ['reviewer'] } });
  assert.ok(handle);
});

test('空allowedTools表示显式拒绝全部，非法配置在注册前失败', async (t) => {
  const root = await agentDir(t, { childToolCeiling: { allowedTools: [] } });
  assert.deepEqual(loadChildToolCeilingConfig(root), { allowedTools: [] });
  const malformed = await agentDir(t, { childToolCeiling: { allowedTools: ['unknown tool'] } });
  let calls = 0;
  assert.throws(() => registerConfiguredChildToolCeiling({ agentDir: malformed, sessionId: 'session-1', register() { calls += 1; } }), /allowedTools/);
  assert.equal(calls, 0);
});
