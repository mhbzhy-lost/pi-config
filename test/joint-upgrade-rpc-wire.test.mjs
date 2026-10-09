import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildWorkflowSpawn } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts';

test('typed builder发送0.75公开script，leaf与长窗口保持', async () => {
  const request = buildWorkflowSpawn({ workflowKey: 'joint-1', agent: 'reviewer', task: '检查合法公开协议', cwd: '/repo', context: 'fresh', child: { timeoutMs: 2147000000 } });
  assert.equal(typeof request.script, 'string');
  assert.equal(Object.hasOwn(request, 'workflowScript'), false);
  const leaf = await runInNewContext(`(async()=>{${request.script}})()`, { runs: { run: async (key, params) => ({ key, ...params }) } });
  assert.equal(leaf.key, 'joint-1');
  assert.equal(leaf.timeoutMs, 2147000000);
  assert.equal(leaf.worktree, false);
});
