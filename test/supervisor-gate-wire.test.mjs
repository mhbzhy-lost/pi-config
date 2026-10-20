// 自造公开control-plane/工具调用链：验证gate，不读取真实authority或会话。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSupervisorControlPlane, supervisorCanonicalDigest as digest, parseSupervisorControlIntentV1, parseSupervisorControlIntent } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts';
import { createTypedSubagentExtension } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts';
import { createSupervisorAdapter } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts';

const correlation = index => ({ asyncDir: '/fixture/async', pid: 7, lifecycleSessionId: 'fixture', processBirth: 'birth', sessionFile: '/fixture/session', childSessionId: 'child', toolCallId: `tool-${index}`, agent: 'executor', childIndex: index, reason: 'need_decision', requestBodyDigest: digest('fixture question') });
const options = extra => ({ now: () => 1000, readOwnerReceipt: async runId => ({ runId, rootSessionId: 'root', ownerGeneration: 1 }), readRuntime: async runId => ({ runId, ownerGeneration: 1, running: true, steerable: true, liveRunEpoch: 1 }), ...extra });
const intent = (kind, index, extra = {}) => ({ schemaVersion: 'supervisor-control-intent.v2', intentId: `${kind}-${index}`, rootSessionId: 'root', runId: 'run', ownerGeneration: 1, kind, childIndex: index, liveRunEpoch: 1, payloadDigest: digest(kind), ...(kind === 'reply' ? { requestId: `ask-${index}`, requestGeneration: 1 } : {}), ...extra });
async function ask(plane, index) { return plane.registerSupervisorRequest({ id: `ask-${index}`, runId: 'run', agent: 'executor', childIndex: index, correlation: correlation(index), reason: 'need_decision', expectsReply: true }, 'root'); }

test('公开register→reply queued解除本child needs-reply，不解另一child、不伪造消费', async () => {
  const plane = createSupervisorControlPlane(options());
  await ask(plane, 0); await ask(plane, 1);
  assert.equal((await plane.resolveSupervisorControl(intent('steer', 0), 'root')).code, 'SUPERVISOR_REPLY_REQUIRED');
  assert.equal((await plane.resolveSupervisorControl(intent('steer', 2), 'root')).status, 'allowed');
  const reply = await plane.commitDelivery({ intent: intent('reply', 0) }, 'root');
  assert.equal(reply.receipt.status, 'queued'); assert.equal(reply.receipt.consumed, false);
  assert.equal((await plane.resolveSupervisorControl(intent('steer', 0), 'root')).status, 'allowed');
  assert.equal((await plane.resolveSupervisorControl(intent('steer', 1), 'root')).code, 'SUPERVISOR_REPLY_REQUIRED');
  assert.equal((await plane.resolveSupervisorControl(intent('steer', 0, { payloadDigest: digest('reply') }), 'root')).code, 'STEER_DUPLICATES_REPLY');
  assert.equal(plane.findRequest('ask-0').state, 'pending');
  const consumed = await plane.observeReplyConsumption({ runId: 'run', requestId: 'ask-0', payloadDigest: digest('reply') }, 'root');
  assert.equal(consumed.receipt.consumed, true);
});

test('相同正文不同child幂等隔离，失败reply和steer都能显式重试', async () => {
  const plane = createSupervisorControlPlane(options()); await ask(plane, 0);
  const failedReply = await plane.commitDelivery({ intent: intent('reply', 0), success: false }, 'root');
  assert.equal(failedReply.receipt.status, 'failed'); assert.equal(plane.findRequest('ask-0').state, 'pending');
  assert.equal((await plane.resolveSupervisorControl(intent('reply', 0), 'root')).status, 'allowed');
  assert.equal((await plane.resolveSupervisorControl(intent('steer', 0), 'root')).code, 'SUPERVISOR_REPLY_REQUIRED');
  await plane.commitDelivery({ intent: intent('reply', 0) }, 'root');
  const steer = intent('steer', 0);
  assert.equal((await plane.commitDelivery({ intent: steer, success: false }, 'root')).receipt.status, 'failed');
  assert.equal((await plane.resolveSupervisorControl(steer, 'root')).status, 'allowed');
  await plane.commitDelivery({ intent: steer }, 'root');
  assert.equal((await plane.resolveSupervisorControl(steer, 'root')).status, 'idempotent');
  assert.equal((await plane.resolveSupervisorControl({ ...steer, childIndex: 1 }, 'root')).status, 'allowed');
});

test('v1 parser仍严格，v2允许index0，缺index/未知scope拒绝而不广播', async () => {
  const v2 = intent('steer', 0); assert.throws(() => parseSupervisorControlIntentV1(v2));
  assert.equal(parseSupervisorControlIntent(v2).childIndex, 0);
  assert.throws(() => parseSupervisorControlIntent({ ...v2, childIndex: -1 }));
  const legacy = { ...v2, schemaVersion: 'supervisor-control-intent.v1' }; delete legacy.childIndex;
  assert.throws(() => parseSupervisorControlIntentV1({ ...legacy, childIndex: 0 }));
  const plane = createSupervisorControlPlane(options());
  assert.equal((await plane.resolveSupervisorControl(legacy, 'root')).code, 'SUPERVISOR_STEER_CHILD_AMBIGUOUS');
  await plane.registerSupervisorRequest({ id: 'unscoped', runId: 'run', reason: 'need_decision' }, 'root');
  assert.equal((await plane.resolveSupervisorControl(v2, 'root')).code, 'SUPERVISOR_REQUEST_SCOPE_UNVERIFIED');
});

test('v1合法public链迁移：diagnostics不写，首次mutation写v2，fresh恢复与旧消费都有效', async t => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-g2-migration-')); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = options({ persistenceRoot: root }); const plane = createSupervisorControlPlane(settings);
  await ask(plane, 0);
  const file = join(root, `supervisor-${createHash('sha256').update('root').digest('hex')}.json`);
  const wrapped = JSON.parse(await readFile(file, 'utf8'));
  // 由public register生成合法身份，再显式编码旧版本fixture以验证读取迁移；不是生产故障证据。
  const body = { ...wrapped.value, schemaVersion: 'supervisor-state.v1', requests: wrapped.value.requests.map(({ childIndex, ...request }) => ({ ...request, schemaVersion: 'supervisor-request.v1' })) };
  delete body.stateDigest; wrapped.value = { ...body, stateDigest: digest(body) }; await writeFile(file, JSON.stringify(wrapped), { mode: 0o600 });
  const bytes = await readFile(file, 'utf8'); const fresh = createSupervisorControlPlane(settings);
  assert.equal((await fresh.readDiagnostics('root')).availability, 'available'); assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal(await fresh.ready('root'), true); assert.equal(await readFile(file, 'utf8'), bytes);
  const oldReply = { ...intent('reply', 0), schemaVersion: 'supervisor-control-intent.v1' }; delete oldReply.childIndex;
  await fresh.commitDelivery({ intent: oldReply }, 'root');
  const saved = JSON.parse(await readFile(file, 'utf8')); assert.equal(saved.value.schemaVersion, 'supervisor-state.v2');
  assert.equal(saved.value.requests[0].childIndex, 0);
  const reloaded = createSupervisorControlPlane(settings); assert.equal(await reloaded.ready('root'), true);
  assert.equal((await reloaded.resolveSupervisorControl(intent('steer', 0), 'root')).status, 'allowed');
  assert.equal((await reloaded.observeReplyConsumption({ runId: 'run', requestId: 'ask-0', payloadDigest: oldReply.payloadDigest }, 'root')).receipt.status, 'delivered');
});

function harness(steer, reply) {
  const tools = [], handlers = new Map();
  const pi = { registerTool: tool => tools.push(tool), on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); }, events: { on() { return () => {}; }, emit() {} }, sendMessage() {} };
  const adapter = createSupervisorAdapter(); adapter.bind(reply);
  const plane = createSupervisorControlPlane(options());
  createTypedSubagentExtension(pi, { rpc: { steer, dispose() {} }, cleanupStore: {}, supervisorAdapter: adapter, supervisorControlPlane: plane, resolveRootSessionId: () => 'root' });
  return { tools, plane, ctx: { cwd: '/fixture', sessionManager: { getSessionId: () => 'root' } } };
}
for (const kind of ['steer', 'reply']) for (const failure of ['isError', 'throw']) test(`工具公开链${kind} ${failure}不记queued，失败后可重试，raw不变`, async () => {
  let fails = true; const native = Object.freeze({ isError: true, content: Object.freeze([{ type: 'text', text: 'fixture rejected' }]), details: Object.freeze({ code: 'FIXTURE_REJECTED' }) });
  const run = async () => { if (fails) { if (failure === 'throw') throw new Error('fixture failure'); return native; } return { text: 'ok', content: [{ type: 'text', text: 'ok' }] }; };
  const h = harness(run, run); if (kind === 'reply') await ask(h.plane, 0);
  // S4后旧union不再注册；测试必须走当前公开独立操作入口，而非恢复旧alias。
  const tool = h.tools.find(tool => tool.name === (kind === 'reply' ? 'supervisor_request_reply' : 'subagent_run_steer'));
  assert.ok(tool, '当前独立工具必须已注册');
  const args = kind === 'reply' ? { replyTo: 'ask-0', message: 'approved' } : { runId: 'run', index: 0, message: 'continue' };
  if (failure === 'throw' && kind === 'reply') await assert.rejects(tool.execute('call_first|fc_first', args, undefined, undefined, h.ctx), /fixture failure/);
  else {
    // 原typed subagent工具将异常投影为失败结果；supervisor adapter则保留原异常。
    const result = await tool.execute('call_first|fc_first', args, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
    if (kind === 'reply') assert.equal(result, native);
    if (failure === 'throw') assert.match(JSON.stringify(result.content), /fixture failure/);
  }
  const diagnostics = await h.plane.readDiagnostics('root'); assert.equal(diagnostics.receipts[0].status, 'failed'); assert.equal(diagnostics.receipts[0].consumed, false);
  fails = false; assert.notEqual((await tool.execute('call_retry|fc_retry', args, undefined, undefined, h.ctx)).isError, true);
  assert.equal((await h.plane.readDiagnostics('root')).receipts[0].status, 'queued');
});
