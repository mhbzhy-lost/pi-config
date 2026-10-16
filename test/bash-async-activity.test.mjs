// 统一执行计划 F3 / footer 子计划 T3 验收：bash_async 只读观察 source 与同 Host TUI publisher。
//
// 本文件是 display/observer fixture 验证：controller 用注入 operations/deferred barrier，
// 不启动真实 Host、不跑真实 sleep/子进程、不发真实模型消息；不修改 raw receipt/发送行为。
// 覆盖清单（footer 子计划 T3 步骤5）：
//   - subscribe 覆盖全部变更出口（accept/归档/reset/branch/shutdown收束），退订不abort；
//   - listener 独立 try/catch 隔离：异常不影响其他listener、执行结果与唯一send出口；
//   - late prepare 期间 shutdown：job 未注册无归档通知，旧 launch 拒绝；
//   - 极速完成：accept 与归档通知齐全且快照一致；
//   - source snapshot：稳定 key `bash_async:<jobId>`、main=active/recent=terminal、
//     label 保留原 command（截断归 renderer）、attempted/accepted 只显示 outcome、
//     suppressed-*/delivery-error 在 recent 行显式解释；
//   - detail：active 仅 launch 事实、terminal 含原 content blocks + typed outcome + delivery、
//     未命中 key 不复活、无 streaming（requestRender 不被调用）；
//   - raw 引用与内容在 snapshot/detail 前后不变（只读投影）；
//   - 64 条 history 上限不变；
//   - publisher：先 listen owner-ready 再 request、owner 缺席不注册不报 failure、
//     ready 三要素身份匹配才注册、重复 ready 同 registrationId 幂等、异身份/坏 payload 拒绝、
//     owner/publisher 任意加载顺序可握手、新 epoch exact 撤销旧注册且换新 registrationId、
//     非 TUI 模式不发布、shutdown 退订 ready + exact 撤销且不 abort 任务；
//   - Host 入口：保存 createBashAsyncExtension 返回 controller、renderer 注册保留、
//     TUI session_start 发布 source、rpc 模式撤销且不再发布。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Text } from '@earendil-works/pi-tui';
import { createBashAsyncActivityPublisher, createBashAsyncActivitySource, createBashAsyncController } from '../src/bash-async/index.ts';
import bashCwdExtension from '../pi/extensions/bash-cwd.ts';

const { BACKGROUND_ACTIVITY_CHANNELS } = await import('pi-subagents-enhanced/tui/background-activity');
const OWNER_READY = BACKGROUND_ACTIVITY_CHANNELS.ownerReady;
const OWNER_REQUEST = BACKGROUND_ACTIVITY_CHANNELS.ownerRequest;
const SOURCE_REGISTER = BACKGROUND_ACTIVITY_CHANNELS.sourceRegister;
const SOURCE_UNREGISTER = BACKGROUND_ACTIVITY_CHANNELS.sourceUnregister;

const deferred = () => Promise.withResolvers();
const native = (exit = 0, output = 'fixture') => ({ content: [{ type: 'text', text: output }], details: { fixture: true }, structuredContent: { output, exit_code: exit, wall_time_seconds: 0.1 }, ...(exit ? { isError: true } : {}) });
const request = () => ({ expanded: false, requestRender() { throw new Error('bash_async detail 不支持 streaming'); } });

function context(overrides = {}) {
  return { mode: 'rpc', cwd: '/fixture', sessionManager: { getSessionId: () => 's1', getSessionFile: () => undefined }, isIdle: () => true, ...overrides };
}
function harness({ prepare, send } = {}) {
  const calls = [], work = deferred(), began = deferred(), evidence = {};
  const c = createBashAsyncController({ prepare: prepare ?? (async () => ({ cwd: '/fixture', evidence, async execute(id, req, signal) { began.resolve({ id, request: req, signal }); return work.promise; } })), send: send ?? ((...args) => { calls.push(args); }) });
  return { c, calls, work, began, evidence };
}
async function settled(c) { await new Promise(resolve => setImmediate(resolve)); await c.cancelAll(); return c.snapshot().completed; }

function busHarness() {
  const handlers = new Map(), calls = [];
  const bus = {
    on(channel, handler) {
      calls.push({ type: 'on', channel });
      const list = handlers.get(channel) ?? [];
      handlers.set(channel, list);
      list.push(handler);
      return () => { const current = handlers.get(channel); const index = current.indexOf(handler); if (index >= 0) current.splice(index, 1); calls.push({ type: 'off', channel }); };
    },
    emit(channel, data) {
      calls.push({ type: 'emit', channel, data });
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
    },
  };
  return { bus, calls, handlers };
}
const emissionsOf = (calls, type, channel) => calls.filter(c => c.type === type && c.channel === channel);
const lastEmission = (calls, type, channel) => emissionsOf(calls, type, channel).at(-1);

// ---- controller 只读 subscribe（criterion-1） ----

test('subscribe覆盖全部变更出口：accept/归档/reset/branch/shutdown收束；退订不再通知且不abort', async () => {
  const h = harness(); await h.c.start('s1');
  const ticks = [];
  const unsubscribe = h.c.subscribe(() => ticks.push(1));
  const second = [];
  h.c.subscribe(() => second.push(1));
  assert.equal(ticks.length, 0);
  await h.c.launch('t1', { command: 'fixture' }, context());
  assert.equal(ticks.length, 1); // accept（jobs.set）
  assert.equal(second.length, 1); // 多listener各自收到
  h.work.resolve(native());
  await settled(h.c);
  assert.equal(ticks.length, 2); // 归档（jobs.delete + terminal入档一次收束通知）
  await h.c.invalidateBranch();
  assert.equal(ticks.length, 3); // branch收束
  await h.c.start('s1');
  assert.equal(ticks.length, 5); // start 内部 shutdown收束 + reset
  unsubscribe();
  const secondReceipt = await h.c.launch('t2', { command: 'fixture2' }, context());
  assert.equal(ticks.length, 5); // 退订后accept/归档均不再通知
  await settled(h.c); // work已处于resolved状态：t2立即收束归档
  // 退订不abort：任务照常执行、归档，回执照常走唯一send出口
  assert.ok(h.c.snapshot().completed.some(r => r.jobId === secondReceipt.jobId && r.completionDelivery === 'accepted'));
  assert.equal(h.calls.length, 2);
});

test('listener异常彼此隔离：不影响其他listener、执行结果与唯一send出口', async () => {
  const h = harness(); await h.c.start('s1');
  const good = [];
  h.c.subscribe(() => { throw new Error('listener爆炸'); });
  h.c.subscribe(() => good.push(1));
  await h.c.launch('t1', { command: 'fixture' }, context()); // accept触发listener抛错不传播
  assert.equal(good.length, 1);
  h.work.resolve(native());
  await settled(h.c);
  assert.equal(good.length, 2); // 抛错listener不影响其他listener收到归档通知
  assert.equal(h.calls.length, 1); // send出口未受影响
  assert.equal(h.c.snapshot().completed[0].completionDelivery, 'accepted');
});

test('late prepare期间shutdown：job未注册无归档通知，旧launch拒绝且不执行', async () => {
  const p = deferred(); let execute = 0;
  const c = createBashAsyncController({ prepare: () => p.promise, send() { assert.fail(); } });
  await c.start('s1');
  const ticks = []; c.subscribe(() => ticks.push(1));
  const launch = c.launch('t1', { command: 'fixture' }, context());
  await c.shutdown('reload');
  assert.equal(ticks.length, 1); // 仅shutdown收束；job从未set无归档通知
  p.resolve({ cwd: '/fixture', evidence: {}, async execute() { execute++; } });
  await assert.rejects(launch, /失效/);
  assert.equal(ticks.length, 1); // 拒绝路径不产生变更通知
  assert.equal(execute, 0);
  assert.equal(c.snapshot().active.length, 0);
});

test('极速完成：accept与归档通知齐全，listener读到的快照状态一致', async () => {
  const c = createBashAsyncController({
    prepare: async () => ({ cwd: '/fixture', evidence: {}, async execute() { return native(0, 'instant'); } }),
    send: () => {},
  });
  await c.start('s1');
  const observations = []; c.subscribe(() => observations.push(c.snapshot()));
  await c.launch('t1', { command: 'fixture' }, context());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observations.length, 2); // accept + 归档
  assert.equal(observations[0].active.length, 1); // 接受即见
  assert.equal(observations[0].completed.length, 0);
  assert.equal(observations[1].active.length, 0); // 完成即从main移除
  assert.equal(observations[1].completed.length, 1);
});

test('source.subscribe透传controller失效通知，退订不abort任务', async () => {
  const h = harness(); await h.c.start('s1');
  const source = createBashAsyncActivitySource(h.c, { Text });
  const ticks = [];
  const off = source.subscribe(() => ticks.push(1));
  await h.c.launch('t1', { command: 'fixture' }, context());
  assert.equal(ticks.length, 1);
  off();
  h.work.resolve(native());
  await settled(h.c);
  assert.equal(ticks.length, 1); // 退订后不再通知
  assert.equal(h.c.snapshot().completed.length, 1); // 任务照常归档
  assert.equal(h.calls.length, 1); // send照常
});

// ---- ActivitySource snapshot/detail（criterion-2） ----

test('source snapshot：稳定key、main=active/recent=terminal、label保留原command、accepted不显示ACK', async () => {
  const h = harness(); await h.c.start('s1');
  const source = createBashAsyncActivitySource(h.c, { Text });
  const empty = source.snapshot();
  assert.equal(empty.availability, 'available');
  assert.deepEqual(empty.rows, []);
  assert.equal(typeof empty.observedAt, 'string');
  const long = `echo ${'长'.repeat(120)}`;
  const receipt = await h.c.launch('ta', { command: long }, context());
  const active = source.snapshot();
  assert.equal(active.rows.length, 1);
  assert.equal(active.rows[0].key, `bash_async:${receipt.jobId}`);
  assert.equal(active.rows[0].kind, 'bash_async');
  assert.equal(active.rows[0].label, long); // 原command全文，截断归renderer
  assert.equal(active.rows[0].stateLabel, 'running');
  assert.equal(active.rows[0].placement, 'main');
  h.work.resolve(native(3, 'partial\nout'));
  await settled(h.c);
  const done = source.snapshot();
  assert.equal(done.rows.length, 1);
  assert.equal(done.rows[0].placement, 'recent'); // 完成即从main移除进recent
  assert.equal(done.rows[0].key, `bash_async:${receipt.jobId}`);
  assert.equal(done.rows[0].stateLabel, 'failed'); // accepted只显示outcome，不显示投递/ACK声明
  assert.ok(!done.rows[0].stateLabel.includes('accepted'));
});

test('suppressed与delivery-error在recent行显式解释，attempted/accepted只显示outcome', async () => {
  // suppressed-shutdown
  const h = harness(); await h.c.start('s1');
  const source = createBashAsyncActivitySource(h.c, { Text });
  await h.c.launch('t1', { command: 'fixture' }, context());
  const closing = h.c.shutdown('quit'); h.work.reject(new Error('Command aborted')); await closing;
  assert.equal(source.snapshot().rows[0].stateLabel, 'aborted · suppressed-shutdown');
  // suppressed-stale（branch换代）
  const b = harness(); await b.c.start('s1');
  const bSource = createBashAsyncActivitySource(b.c, { Text });
  await b.c.launch('t2', { command: 'fixture' }, context());
  const branching = b.c.invalidateBranch(); b.work.reject(new Error('Command aborted')); await branching;
  assert.equal(bSource.snapshot().rows[0].stateLabel, 'aborted · suppressed-stale');
  // suppressed-unsafe-context
  const u = harness(); await u.c.start('s1');
  const uSource = createBashAsyncActivitySource(u.c, { Text });
  await u.c.launch('t3', { command: 'fixture' }, context({ isIdle: () => false, signal: undefined }));
  u.work.resolve(native()); await settled(u.c);
  assert.equal(uSource.snapshot().rows[0].stateLabel, 'succeeded · suppressed-unsafe-context');
  assert.equal(u.calls.length, 0); // 抑制路径send未被调用
  // delivery-error（send失败不重试）
  const q = harness({ send() { throw new Error('fixture delivery failure'); } }); await q.c.start('s1');
  const qSource = createBashAsyncActivitySource(q.c, { Text });
  await q.c.launch('t4', { command: 'fixture' }, context());
  q.work.resolve(native()); await settled(q.c);
  assert.equal(qSource.snapshot().rows[0].stateLabel, 'succeeded · delivery-error');
});

test('detail：active仅launch事实不虚构输出；terminal含原content blocks+typed outcome+delivery；未命中key不复活', async () => {
  const h = harness(); await h.c.start('s1');
  const source = createBashAsyncActivitySource(h.c, { Text });
  const receipt = await h.c.launch('t1', { command: 'echo hi' }, context());
  const activeDetail = await source.detail(`bash_async:${receipt.jobId}`, request());
  assert.ok(activeDetail);
  assert.equal(typeof activeDetail.render, 'function');
  assert.equal(typeof activeDetail.invalidate, 'function');
  const activeText = activeDetail.render(160).map(line => line.trim()).join('\n');
  for (const expected of ['echo hi', receipt.jobId, 't1', '/fixture', '运行中']) assert.ok(activeText.includes(expected), `active详情缺少 ${expected}：${activeText}`);
  for (const forbidden of ['succeeded', 'failed', 'exit:', 'native-raw-stdout']) assert.ok(!activeText.includes(forbidden), `active详情不应包含 ${forbidden}：${activeText}`);
  h.work.resolve(native(7, 'native-raw-stdout'));
  await settled(h.c);
  const terminalDetail = await source.detail(`bash_async:${receipt.jobId}`, request());
  const terminalText = terminalDetail.render(200).map(line => line.trimEnd()).join('\n');
  for (const expected of ['failed', 'exit: 7', 'delivery: accepted', 'native-raw-stdout', '不代表模型已消费']) assert.ok(terminalText.includes(expected), `terminal详情缺少 ${expected}：${terminalText}`);
  // 未命中/畸形key不按label复活
  assert.equal(await source.detail('bash_async:missing', request()), undefined);
  assert.equal(await source.detail('subagent:whatever', request()), undefined);
  assert.equal(await source.detail('', request()), undefined);
  assert.equal(await source.detail('bash_async:', request()), undefined);
});

test('detail：error形态输出显示原始error正文；requestRender不被调用（无streaming）', async () => {
  const h = harness(); await h.c.start('s1');
  const source = createBashAsyncActivitySource(h.c, { Text });
  const receipt = await h.c.launch('t1', { command: 'fixture' }, context());
  h.evidence.backendError = new Error('timeout:0.1');
  h.work.reject(new Error('累计日志\n第二行'));
  await settled(h.c);
  const detail = await source.detail(`bash_async:${receipt.jobId}`, request()); // request()的requestRender若被调用会抛错
  const text = detail.render(200).map(line => line.trim()).join('\n');
  assert.ok(text.includes('timed-out'));
  assert.ok(text.includes('error(Error): 累计日志'));
  assert.ok(text.includes('第二行')); // 原文完整可达
});

test('source只读：snapshot/detail不改写raw receipt与output引用', async () => {
  const h = harness(); await h.c.start('s1');
  const source = createBashAsyncActivitySource(h.c, { Text });
  const receipt = await h.c.launch('t1', { command: 'fixture' }, context());
  h.work.resolve(native(0, 'raw-body'));
  await settled(h.c);
  const before = h.c.snapshot();
  const beforeOutput = before.completed[0].output;
  const rawBlocks = before.completed[0].output.content;
  const snap = source.snapshot();
  assert.equal(snap.rows[0].label, 'fixture');
  const detail = await source.detail(`bash_async:${receipt.jobId}`, request());
  detail.render(80); detail.invalidate(); detail.render(40); // 渲染/invalidate循环不改raw
  const after = h.c.snapshot();
  assert.equal(after.completed[0].output, beforeOutput); // 引用不变
  assert.equal(after.completed[0].output.content, rawBlocks);
  assert.deepEqual(after, before); // 内容不变
});

test('64条history上限不变：第65条归档后最早一条滚出，detail不复活', async () => {
  const c = createBashAsyncController({
    prepare: async () => ({ cwd: '/fixture', evidence: {}, async execute() { return native(); } }),
    send: () => {},
  });
  await c.start('s1');
  const source = createBashAsyncActivitySource(c, { Text });
  const ids = [];
  for (let i = 0; i < 65; i++) ids.push((await c.launch(`t${i}`, { command: `cmd-${i}` }, context())).jobId);
  await new Promise(resolve => setImmediate(resolve));
  await c.cancelAll();
  assert.equal(c.snapshot().completed.length, 64);
  assert.equal(source.snapshot().rows.length, 64);
  assert.ok(source.snapshot().rows.every(row => row.placement === 'recent'));
  assert.equal(await source.detail(`bash_async:${ids[0]}`, request()), undefined); // 最早的已滚出，不复活
  assert.ok(await source.detail(`bash_async:${ids[64]}`, request()) !== undefined); // 最新一条可达
});

// ---- 同Host TUI publisher（criterion-3） ----

test('publisher先listen owner-ready再request；owner缺席不注册不报failure', () => {
  const h = harness(); const { bus, calls } = busHarness();
  const publisher = createBashAsyncActivityPublisher(h.c, { Text }, bus);
  const manager = { getSessionId: () => 's1' };
  publisher.onSessionStart({ mode: 'tui', sessionManager: manager, sessionId: 's1' });
  const onIndex = calls.findIndex(c => c.type === 'on' && c.channel === OWNER_READY);
  const requestIndex = calls.findIndex(c => c.type === 'emit' && c.channel === OWNER_REQUEST);
  assert.ok(onIndex >= 0, '应订阅owner-ready');
  assert.ok(requestIndex > onIndex, '必须先listen ready再emit request（任意加载顺序）');
  assert.deepEqual(calls[requestIndex].data, { sessionManager: manager, sessionId: 's1', hostKey: manager });
  assert.equal(emissionsOf(calls, 'emit', SOURCE_REGISTER).length, 0); // owner缺席：不注册
  publisher.onSessionShutdown(); // 无注册：不emit unregister、不抛错
  assert.equal(emissionsOf(calls, 'emit', SOURCE_UNREGISTER).length, 0);
});

test('ready三要素身份匹配才注册；重复ready同registrationId幂等；异身份/坏payload拒绝', async () => {
  const h = harness(); const { bus, calls } = busHarness();
  const publisher = createBashAsyncActivityPublisher(h.c, { Text }, bus);
  const manager = { getSessionId: () => 's1' };
  publisher.onSessionStart({ mode: 'tui', sessionManager: manager, sessionId: 's1' });
  const scope = { sessionManager: manager, sessionId: 's1', token: { generation: 1 }, hostKey: manager };
  bus.emit(OWNER_READY, { scope, ownerRegistrationId: 'owner-1' });
  const registers = emissionsOf(calls, 'emit', SOURCE_REGISTER);
  assert.equal(registers.length, 1);
  assert.equal(registers[0].data.scope, scope); // exact scope对象
  assert.equal(registers[0].data.source.kind, 'bash_async');
  assert.equal(typeof registers[0].data.registrationId, 'string');
  // 注册的source真实读取controller事实
  await h.c.start('s1');
  await h.c.launch('t1', { command: 'fixture' }, context());
  assert.equal(registers[0].data.source.snapshot().rows.length, 1);
  assert.equal(registers[0].data.source.snapshot().rows[0].placement, 'main');
  // 重复ready：同registrationId幂等
  bus.emit(OWNER_READY, { scope, ownerRegistrationId: 'owner-1' });
  assert.equal(emissionsOf(calls, 'emit', SOURCE_REGISTER).length, 2);
  assert.equal(lastEmission(calls, 'emit', SOURCE_REGISTER).data.registrationId, registers[0].data.registrationId);
  // 异session/异manager/缺token的scope：拒绝
  bus.emit(OWNER_READY, { scope: { ...scope, sessionId: 'other' }, ownerRegistrationId: 'o' });
  bus.emit(OWNER_READY, { scope: { sessionManager: {}, sessionId: 's1', token: {}, hostKey: {} }, ownerRegistrationId: 'o' });
  bus.emit(OWNER_READY, { scope: { sessionManager: manager, sessionId: 's1', hostKey: manager }, ownerRegistrationId: 'o' });
  // 坏payload：缺scope/非对象
  bus.emit(OWNER_READY, { ownerRegistrationId: 'o' });
  bus.emit(OWNER_READY, undefined);
  bus.emit(OWNER_READY, { scope, ownerRegistrationId: 42 });
  assert.equal(emissionsOf(calls, 'emit', SOURCE_REGISTER).length, 2);
});

test('加载顺序无关：owner先就绪（request触发重发ready）与publisher先启动（owner后announce）均可握手', () => {
  // 顺序一：owner先就绪并自行announce（publisher未监听），publisher启动listen+request，owner重发ready
  {
    const h = harness(); const { bus, calls } = busHarness();
    const manager = { getSessionId: () => 's1' };
    const scope = { sessionManager: manager, sessionId: 's1', token: {}, hostKey: manager };
    // owner：监听request并重发ready；启动时已自行announce过一次（publisher不在场）
    bus.on(OWNER_REQUEST, () => bus.emit(OWNER_READY, { scope, ownerRegistrationId: 'owner' }));
    bus.emit(OWNER_READY, { scope, ownerRegistrationId: 'owner' }); // publisher缺席，无人收到
    const publisher = createBashAsyncActivityPublisher(h.c, { Text }, bus);
    publisher.onSessionStart({ mode: 'tui', sessionManager: manager, sessionId: 's1' });
    assert.equal(emissionsOf(calls, 'emit', SOURCE_REGISTER).length, 1); // request→ready→注册
  }
  // 顺序二：publisher先启动（request无人应答），owner后加载自行announce ready
  {
    const h = harness(); const { bus, calls } = busHarness();
    const manager = { getSessionId: () => 's1' };
    const scope = { sessionManager: manager, sessionId: 's1', token: {}, hostKey: manager };
    const publisher = createBashAsyncActivityPublisher(h.c, { Text }, bus);
    publisher.onSessionStart({ mode: 'tui', sessionManager: manager, sessionId: 's1' });
    assert.equal(emissionsOf(calls, 'emit', SOURCE_REGISTER).length, 0); // owner缺席
    bus.emit(OWNER_READY, { scope, ownerRegistrationId: 'owner' }); // owner加载后announce
    assert.equal(emissionsOf(calls, 'emit', SOURCE_REGISTER).length, 1); // 已在监听，注册成立
  }
});

test('新epoch：exact撤销旧注册（同scope+旧registrationId），换新registrationId；shutdown退订ready并exact撤销', () => {
  const h = harness(); const { bus, calls } = busHarness();
  const publisher = createBashAsyncActivityPublisher(h.c, { Text }, bus);
  const manager = { getSessionId: () => 's1' };
  publisher.onSessionStart({ mode: 'tui', sessionManager: manager, sessionId: 's1' });
  const scope1 = { sessionManager: manager, sessionId: 's1', token: { generation: 1 }, hostKey: manager };
  bus.emit(OWNER_READY, { scope: scope1, ownerRegistrationId: 'owner' });
  const first = lastEmission(calls, 'emit', SOURCE_REGISTER).data;
  // 新epoch（同manager新session id）
  publisher.onSessionStart({ mode: 'tui', sessionManager: manager, sessionId: 's2' });
  const unregisters = emissionsOf(calls, 'emit', SOURCE_UNREGISTER);
  assert.equal(unregisters.length, 1);
  assert.equal(unregisters[0].data.scope, scope1); // exact scope
  assert.equal(unregisters[0].data.registrationId, first.registrationId); // exact旧registrationId
  assert.equal(unregisters[0].data.kind, 'bash_async');
  assert.ok(calls.some(c => c.type === 'off' && c.channel === OWNER_READY)); // 旧epoch已退订ready
  // 新epoch注册新source，registrationId不同
  const scope2 = { sessionManager: manager, sessionId: 's2', token: { generation: 2 }, hostKey: manager };
  bus.emit(OWNER_READY, { scope: scope2, ownerRegistrationId: 'owner' });
  const second = lastEmission(calls, 'emit', SOURCE_REGISTER).data;
  assert.notEqual(second.registrationId, first.registrationId);
  assert.equal(second.scope, scope2);
  // 旧epoch的ready（旧session身份）不再被回答
  bus.emit(OWNER_READY, { scope: scope1, ownerRegistrationId: 'owner' });
  assert.equal(emissionsOf(calls, 'emit', SOURCE_REGISTER).length, 2);
  // shutdown：退订ready + exact撤销最后注册
  publisher.onSessionShutdown();
  const finalUnregister = lastEmission(calls, 'emit', SOURCE_UNREGISTER);
  assert.equal(finalUnregister.data.scope, scope2);
  assert.equal(finalUnregister.data.registrationId, second.registrationId);
  assert.equal(finalUnregister.data.kind, 'bash_async');
  // ready已退订：再emit ready无注册
  bus.emit(OWNER_READY, { scope: scope2, ownerRegistrationId: 'owner' });
  assert.equal(emissionsOf(calls, 'emit', SOURCE_REGISTER).length, 2);
});

test('非TUI模式不发布：rpc session_start撤销旧epoch后无ready订阅、无request', () => {
  const h = harness(); const { bus, calls } = busHarness();
  const publisher = createBashAsyncActivityPublisher(h.c, { Text }, bus);
  const manager = { getSessionId: () => 's1' };
  publisher.onSessionStart({ mode: 'tui', sessionManager: manager, sessionId: 's1' });
  const scope = { sessionManager: manager, sessionId: 's1', token: {}, hostKey: manager };
  bus.emit(OWNER_READY, { scope, ownerRegistrationId: 'owner' });
  publisher.onSessionStart({ mode: 'rpc', sessionManager: manager, sessionId: 's1' });
  assert.equal(emissionsOf(calls, 'emit', SOURCE_UNREGISTER).length, 1); // 旧epoch被exact撤销
  assert.equal(emissionsOf(calls, 'on', OWNER_READY).length, 1); // 只有第一次订阅过
  assert.equal(emissionsOf(calls, 'emit', OWNER_REQUEST).length, 1); // 只发过一次request
});

test('publisher shutdown只撤销注册与退订，不abort任务、不影响send', async () => {
  const h = harness(); const { bus } = busHarness();
  const publisher = createBashAsyncActivityPublisher(h.c, { Text }, bus);
  const manager = { getSessionId: () => 's1' };
  publisher.onSessionStart({ mode: 'tui', sessionManager: manager, sessionId: 's1' });
  await h.c.start('s1');
  await h.c.launch('t1', { command: 'fixture' }, context());
  publisher.onSessionShutdown();
  assert.equal(h.c.snapshot().active.length, 1); // 任务不受publisher shutdown影响
  h.work.resolve(native());
  await settled(h.c);
  assert.equal(h.calls.length, 1); // send照常走唯一出口
});

// ---- Host 入口绑定（criterion-3/criterion-4 入口侧） ----

test('Host入口：保存controller绑定TUI publisher；renderer注册保留；rpc模式撤销且不再发布', async () => {
  const tools = [], renderers = new Map(), commands = [], eventHandlers = new Map();
  const busHandlers = new Map(), emissions = [];
  const pi = {
    registerTool: t => tools.push(t),
    on: (k, h) => { if (!eventHandlers.has(k)) eventHandlers.set(k, []); eventHandlers.get(k).push(h); },
    registerCommand: name => commands.push(name),
    registerMessageRenderer: (customType, renderer) => renderers.set(customType, renderer),
    sendMessage: () => assert.fail('绑定阶段不应发送消息'),
    events: {
      on(channel, handler) {
        const list = busHandlers.get(channel) ?? [];
        busHandlers.set(channel, list);
        list.push(handler);
        return () => { const current = busHandlers.get(channel); const index = current.indexOf(handler); if (index >= 0) current.splice(index, 1); };
      },
      emit(channel, data) {
        emissions.push({ channel, data });
        for (const handler of [...(busHandlers.get(channel) ?? [])]) handler(data);
      },
    },
  };
  bashCwdExtension(pi);
  assert.deepEqual([...renderers.keys()], ['bash-async-complete']); // renderer注册保留
  assert.deepEqual(tools.map(t => t.name), ['bash', 'bash_async']); // 既有tool注册不变
  assert.deepEqual(commands, ['bash-async-cancel']);
  // TUI session_start：controller.start + publisher发布
  const manager = { getSessionId: () => 's1', getSessionFile: () => undefined };
  const ctx = { mode: 'tui', cwd: '/fixture', sessionManager: manager, isIdle: () => true };
  for (const handler of eventHandlers.get('session_start')) await handler({}, ctx);
  const ownerRequest = emissions.find(e => e.channel === OWNER_REQUEST);
  assert.ok(ownerRequest, 'TUI session_start应发出owner-request');
  assert.deepEqual(ownerRequest.data, { sessionManager: manager, sessionId: 's1', hostKey: manager });
  // owner-ready匹配 → 注册入口保存的controller所驱动的source
  const scope = { sessionManager: manager, sessionId: 's1', token: {}, hostKey: manager };
  pi.events.emit(OWNER_READY, { scope, ownerRegistrationId: 'owner' });
  const register = emissions.find(e => e.channel === SOURCE_REGISTER);
  assert.ok(register, '匹配ready应注册source');
  assert.equal(register.data.scope, scope);
  assert.equal(register.data.source.kind, 'bash_async');
  assert.equal(register.data.source.snapshot().availability, 'available'); // controller已由入口保存并接线
  // rpc模式session_start：撤销旧epoch、不再发布
  for (const handler of eventHandlers.get('session_start')) await handler({}, { ...ctx, mode: 'rpc' });
  assert.equal(emissions.filter(e => e.channel === OWNER_REQUEST).length, 1);
  const unregister = emissions.find(e => e.channel === SOURCE_UNREGISTER);
  assert.ok(unregister, '非TUI session_start应exact撤销旧注册');
  assert.equal(unregister.data.scope, scope);
  assert.equal(unregister.data.registrationId, register.data.registrationId);
  assert.equal(unregister.data.kind, 'bash_async');
  // session_shutdown：publisher退订ready（controller.shutdown同事件照常运行）
  for (const handler of eventHandlers.get('session_shutdown')) await handler({ type: 'session_shutdown', reason: 'quit' });
  assert.equal(busHandlers.get(OWNER_READY)?.length ?? 0, 0); // ready已退订
});

test('Host入口：session_start缺session身份（getSessionId抛错或空）不发布不报failure', async () => {
  const tools = [], eventHandlers = new Map(), emissions = [];
  const busHandlers = new Map();
  const pi = {
    registerTool: t => tools.push(t),
    on: (k, h) => { if (!eventHandlers.has(k)) eventHandlers.set(k, []); eventHandlers.get(k).push(h); },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage() {},
    events: {
      on(channel, handler) { const list = busHandlers.get(channel) ?? []; busHandlers.set(channel, list); list.push(handler); return () => { const current = busHandlers.get(channel); const index = current.indexOf(handler); if (index >= 0) current.splice(index, 1); }; },
      emit(channel, data) { emissions.push({ channel, data }); for (const handler of [...(busHandlers.get(channel) ?? [])]) handler(data); },
    },
  };
  bashCwdExtension(pi);
  // 按runner真实语义逐handler隔离错误（runner.js emit：单handler异常不阻断其他handler）
  const runSessionStart = async ctx => {
    for (const handler of eventHandlers.get('session_start')) {
      try { await handler({}, ctx); } catch { /* runner隔离单handler错误，不阻断后续 */ }
    }
  };
  const failing = { mode: 'tui', cwd: '/fixture', sessionManager: { getSessionId: () => { throw new Error('stale context'); }, getSessionFile: () => undefined }, isIdle: () => true };
  await runSessionStart(failing);
  assert.equal(emissions.filter(e => e.channel === OWNER_REQUEST).length, 0); // 抛错：不发布
  const empty = { mode: 'tui', cwd: '/fixture', sessionManager: { getSessionId: () => '', getSessionFile: () => undefined }, isIdle: () => true };
  await runSessionStart(empty);
  assert.equal(emissions.filter(e => e.channel === OWNER_REQUEST).length, 0); // 空id：fail closed不发布
  assert.equal(emissions.length, 0);
});
