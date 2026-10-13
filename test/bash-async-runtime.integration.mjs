import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createBashAsyncExtension } from '../src/bash-async/index.ts';
import { createSecurityGatesExtension } from '../src/security-gates/extension.ts';

const barrier = () => Promise.withResolvers();
function deadline(p, ms = 5000) {
  let timer; return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture deadline')), ms); })]).finally(() => clearTimeout(timer));
}
async function host({ operations, mode = 'rpc', holdReply = false, extraFactory } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bash-async-host-')));
  const agentDir = join(root, 'agent'); await mkdir(agentDir);
  const credentials = { async read() { return undefined; }, async list() { return []; }, async modify() { throw Error('禁止真实凭据写入'); }, async delete() { throw Error('禁止真实凭据删除'); } };
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 }, retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'always' });
  const tools = [], errors = [], sends = [], completions = [], sendWaiters = new Set(), completed = barrier(), replyStarted = barrier(), replyRelease = barrier();
  let controller, session, calls = 0;
  modelRuntime.registerProvider('async-bash-fixture', {
    api: 'async-bash-fixture', apiKey: 'fixture-not-a-secret', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      assert.ok(++calls < 30, 'fixture turn上限');
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const last = context.messages.findLast(m => m.role === 'user');
        const text = typeof last?.content === 'string' ? last.content : last?.content?.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
        let request; try { request = JSON.parse(text); } catch {}
        const after = context.messages.slice(context.messages.lastIndexOf(last) + 1);
        if (after.some(m => m.role === 'toolResult')) request = undefined;
        const msg = { role: 'assistant', content: request ? [{ type: 'toolCall', id: 'fixture-tool-' + calls, name: request.name, arguments: request.arguments }] : [{ type: 'text', text: 'fixture completed' }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, stopReason: request ? 'toolUse' : 'stop' };
        stream.push({ type: 'start', partial: msg });
        if (!request && holdReply && after.some(m => m.role === 'toolResult')) { replyStarted.resolve(); await replyRelease.promise; }
        if (request) {
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: msg }); stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(request.arguments), partial: msg }); stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: msg.content[0], partial: msg });
        } else { stream.push({ type: 'text_start', contentIndex: 0, partial: msg }); stream.push({ type: 'text_delta', contentIndex: 0, delta: 'fixture completed', partial: msg }); stream.push({ type: 'text_end', contentIndex: 0, content: 'fixture completed', partial: msg }); }
        stream.push({ type: 'done', reason: msg.stopReason, message: msg }); stream.end();
      });
      return stream;
    },
  });
  const factory = pi => {
    controller = createBashAsyncExtension({
      ...pi,
      registerTool(tool) { tools.push(tool); pi.registerTool(tool); },
      sendMessage(message, options) {
        sends.push({ message, options }); pi.sendMessage(message, options);
        for (const waiter of sendWaiters) if (sends.length >= waiter.count) { sendWaiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(); }
      },
    }, { workspaceRoot: root, createBashToolDefinition: sdk.createBashToolDefinition, getBashOptions: () => operations ? { operations } : {} });
    createSecurityGatesExtension(pi);
    extraFactory?.(pi);
  };
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [factory] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(root), model: modelRuntime.getModel('async-bash-fixture', 'fixture'), tools: ['bash_async'], thinkingLevel: 'off' }));
  await session.bindExtensions({ mode, onError: e => errors.push(e) });
  session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === 'bash-async-complete') { completions.push(event.message); completed.resolve(event.message); }
  });
  const services = { cwd: root, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] };
  return { root, session, controller, tools, errors, sends, completions, completed, replyStarted, replyRelease, services,
    async invoke(args) { await deadline(session.prompt(JSON.stringify({ name: 'bash_async', arguments: args }))); return session.messages.findLast(m => m.role === 'toolResult'); },
    waitSendCount(count) {
      if (sends.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { count, resolve, reject, timer: undefined };
        waiter.timer = setTimeout(() => { sendWaiters.delete(waiter); reject(Error('fixture发送回执期限')); }, 5000); sendWaiters.add(waiter);
      });
    },
    async close() {
      replyRelease.resolve(); await controller.shutdown('fixture-dispose'); await session.abort(); session.dispose();
      for (const waiter of sendWaiters) { clearTimeout(waiter.timer); waiter.reject(Error('fixture关闭')); } sendWaiters.clear();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('真实Host：native尚未结束，launch已入会话，主会话可继续；idle完成唤醒并只投一次', { timeout: 10000 }, async () => {
  const work = barrier(), started = barrier();
  const h = await host({ operations: { async exec(_command, _cwd, { onData }) { started.resolve(); await work.promise; onData(Buffer.from('native stdout\nnative stderr')); return { exitCode: 0 }; } } });
  try {
    const result = await h.invoke({ command: 'fixture-command' }); await started.promise;
    assert.equal(result.isError, false); assert.equal(result.details.kind, 'bash-async-launch'); assert.equal(h.sends.length, 0);
    await deadline(h.session.prompt('独立主会话事件')); assert.equal(h.controller.snapshot().active.length, 1);
    work.resolve(); const message = await deadline(h.completed.promise); await deadline(h.session.waitForIdle());
    assert.equal(h.sends.length, 1); assert.equal(h.completions.length, 1); assert.equal(message.details.output.structuredContent.output, 'native stdout\nnative stderr');
    assert.equal(message.details.toolCallId, result.toolCallId); assert.equal(h.errors.length, 0);
  } finally { work.resolve(); await h.close(); }
});

test('真实Host busy：followUp在本轮toolResult之后消费，快命令不补造第二toolResult', { timeout: 10000 }, async () => {
  const work = barrier();
  const h = await host({ holdReply: true, operations: { async exec(_c, _d, { onData }) { await work.promise; onData(Buffer.from('busy-output')); return { exitCode: 0 }; } } });
  try {
    const prompt = h.invoke({ command: 'fixture-command' }); await deadline(h.replyStarted.promise);
    work.resolve();
    // 发送callback是确定性barrier，不靠耗时比较。
    await h.waitSendCount(1);
    assert.equal(h.sends.length, 1); assert.equal(h.completions.length, 0); h.replyRelease.resolve();
    await prompt; await deadline(h.completed.promise); await deadline(h.session.waitForIdle());
    const messages = h.session.messages; const i = messages.findIndex(m => m.role === 'toolResult'); const j = messages.findIndex(m => m.role === 'custom');
    assert.ok(i >= 0 && j > i); assert.equal(messages.filter(m => m.role === 'toolResult').length, 1); assert.equal(h.errors.length, 0);
  } finally { work.resolve(); h.replyRelease.resolve(); await h.close(); }
});

test('真实Host极速完成先于launch工具返回，completion仍排在toolResult之后', { timeout: 10000 }, async () => {
  const h = await host({ operations: { async exec(_c, _d, { onData }) { onData(Buffer.from('instant')); return { exitCode: 0 }; } } });
  try {
    const receipt = await h.invoke({ command: 'fixture-instant' }); await deadline(h.completed.promise); await h.session.waitForIdle();
    assert.equal(receipt.details.kind, 'bash-async-launch'); assert.equal(h.sends.length, 1);
    const i = h.session.messages.findIndex(m => m.role === 'toolResult'); const j = h.session.messages.findIndex(m => m.role === 'custom');
    assert.ok(i >= 0 && j > i); assert.equal(h.completions.length, 1);
    assert.equal(h.completions[0].details.output.structuredContent.output, 'instant');
  } finally { await h.close(); }
});

test('真实Host：shell安全门禁deny时native零调用；print/json零启动', { timeout: 10000 }, async () => {
  let count = 0;
  const ops = { async exec() { count++; return { exitCode: 0 }; } };
  const h = await host({ operations: ops });
  try { const r = await h.invoke({ command: 'git reset --hard HEAD~1' }); assert.equal(r.isError, true); assert.equal(count, 0); assert.equal(h.sends.length, 0); }
  finally { await h.close(); }
  for (const mode of ['print', 'json']) {
    const x = await host({ operations: ops, mode });
    try { const r = await x.invoke({ command: 'printf fixture' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /TUI\/RPC/); assert.equal(count, 0); }
    finally { await x.close(); }
  }
});

test('原生本地Bash：success/empty/nonzero/超时/取消保留输出和进程组清理', { timeout: 15000 }, async () => {
  const h = await host();
  try {
    for (const [command, outcome, code] of [['printf fixture', 'succeeded', 0], ['true', 'succeeded', 0], ['printf failure; exit 7', 'failed', 7]]) {
      const start = h.sends.length; await h.invoke({ command });
      await h.waitSendCount(start + 1); await deadline(h.session.waitForIdle());
      const result = h.sends.at(-1).message.details; assert.equal(result.outcome, outcome); assert.equal(result.exitCode, code);
      if (command === 'true') assert.equal(result.output.content[0].text, '(no output)');
    }
    const i = h.sends.length;
    await h.invoke({ command: 'printf before-timeout; sleep 2', timeout: 0.08 });
    await h.waitSendCount(i + 1); await deadline(h.session.waitForIdle());
    const timeout = h.sends.at(-1).message.details; assert.equal(timeout.outcome, 'timed-out'); assert.match(timeout.output.error.message, /before-timeout/); assert.equal(timeout.exitCode, undefined);
    const pidFile = join(h.root, 'child-pid');
    const r = await h.invoke({ command: `sleep 30 & child=$!; printf '%s' "$child" > '${pidFile}'; wait "$child"` });
    const readyDeadline = performance.now() + 2000;
    while (true) {
      try { if ((await readFile(pidFile, 'utf8')).length) break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      assert.ok(performance.now() < readyDeadline, '本测试child必须在期限内发布PID'); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const pid = Number(await readFile(pidFile, 'utf8'));
    const cancelled = await h.controller.cancel(r.details.jobId); assert.equal(cancelled.accepted, true); await deadline(h.session.waitForIdle());
    assert.equal(h.sends.at(-1).message.details.outcome, 'aborted');
    assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
  } finally { await h.close(); }
});

test('原生输出大小/structuredOutput沿用SDK而非异步层截断', { timeout: 10000 }, async () => {
  const output = Array.from({ length: 2100 }, (_, i) => `line-${i}`).join('\n') + '\n' + 'x'.repeat(1_100_000);
  const h = await host({ operations: { async exec(_c, _d, { onData }) { onData(Buffer.from(output)); return { exitCode: 0 }; } } });
  try {
    await h.invoke({ command: 'fixture-large-output' }); const m = await deadline(h.completed.promise); await deadline(h.session.waitForIdle());
    const raw = m.details.output; assert.equal(raw.details.truncation.truncated, true); assert.ok(raw.details.fullOutputPath);
    assert.equal(raw.structuredContent.truncated, true);
    const expected = await sdk.createBashToolDefinition(h.root, { operations: { async exec(_c, _d, { onData }) { onData(Buffer.from(output)); return { exitCode: 0 }; } } }).execute('sync-baseline', { command: 'fixture-large-output' }, undefined, undefined, undefined);
    assert.equal(raw.structuredContent.output, expected.structuredContent.output);
    await rm(expected.details.fullOutputPath);
    assert.equal(await readFile(raw.details.fullOutputPath, 'utf8'), output);
    assert.deepEqual(m.content.slice(1), raw.content);
    await rm(raw.details.fullOutputPath);
  } finally { await h.close(); }
});

test('真实Host clearQueue：已提交followUp可被清掉，无第二出口或自动重试', { timeout: 10000 }, async () => {
  const work = barrier(); const h = await host({ holdReply: true, operations: { async exec() { await work.promise; return { exitCode: 0 }; } } });
  try {
    const invoke = h.invoke({ command: 'fixture' }); await deadline(h.replyStarted.promise); work.resolve();
    await h.waitSendCount(1);
    h.session.clearQueue(); h.replyRelease.resolve(); await invoke; await h.session.waitForIdle();
    assert.equal(h.sends.length, 1); assert.equal(h.completions.length, 0); assert.equal(h.errors.length, 0);
  } finally { work.resolve(); h.replyRelease.resolve(); await h.close(); }
});

test('真实Host tree导航被拒或成功均保守取消旧jobs，不依赖session_tree才恢复', { timeout: 10000 }, async () => {
  for (const reject of [true, false]) {
    let aborted = false;
    const h = await host({ operations: { async exec(_c, _d, { signal }) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true }));
    } }, extraFactory(pi) { if (reject) pi.on('session_before_tree', () => ({ cancel: true })); } });
    try {
      const start = await h.invoke({ command: 'fixture' });
      const target = h.session.sessionManager.getEntries().find(e => e.type === 'message' && e.message.role === 'user'); assert.ok(target);
      const result = await h.session.navigateTree(target.id);
      assert.equal(result.cancelled, reject); assert.ok(aborted);
      assert.equal(h.controller.snapshot().active.length, 0); assert.equal(h.sends.length, 0);
      // controller epoch已经前移，导航取消也不会把新launch永久暂停。
      assert.ok(h.controller.snapshot().completed.find(x => x.jobId === start.details.jobId).completionDelivery.startsWith('suppressed'));
    } finally { await h.close(); }
  }
});

test('真实Host独立compaction取消旧job，compact被拒也不发送旧completion', { timeout: 10000 }, async () => {
  let aborted = false;
  const h = await host({ operations: { async exec(_c, _d, { signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true })); } }, extraFactory(pi) { pi.on('session_before_compact', () => ({ cancel: true })); } });
  try {
    await h.invoke({ command: 'fixture' });
    await assert.rejects(h.session.compact(), /cancelled/i);
    assert.ok(aborted); assert.equal(h.sends.length, 0); assert.equal(h.controller.snapshot().active.length, 0);
  } finally { await h.close(); }
});

test('真实Host reload关闭旧代并重建controller，不向新代投递旧completion', { timeout: 10000 }, async () => {
  let aborted = false;
  const h = await host({ operations: { async exec(_c, _d, { signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true })); } } });
  try { await h.invoke({ command: 'fixture' }); await h.session.reload(); assert.ok(aborted); assert.equal(h.sends.length, 0); assert.equal(h.controller.snapshot().active.length, 0); }
  finally { await h.close(); }
});

test('真实runtime成功new/fork/quit才shutdown；拒绝切换与拒绝fork不取消jobs', { timeout: 15000 }, async () => {
  for (const action of ['new-denied', 'fork-denied', 'new', 'fork', 'quit']) {
    let aborted = false;
    const h = await host({ operations: { async exec(_c, _d, { signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true })); } }, extraFactory(pi) {
      if (action === 'new-denied') pi.on('session_before_switch', () => ({ cancel: true }));
      if (action === 'fork-denied') pi.on('session_before_fork', () => ({ cancel: true }));
    } });
    const runtime = new sdk.AgentSessionRuntime(h.session, h.services, async ({ sessionManager, sessionStartEvent }) => {
      const { session } = await sdk.createAgentSession({ cwd: h.root, agentDir: h.services.agentDir, modelRuntime: h.services.modelRuntime, settingsManager: h.services.settingsManager, resourceLoader: h.services.resourceLoader, sessionManager, sessionStartEvent, model: h.services.modelRuntime.getModel('async-bash-fixture', 'fixture'), tools: ['bash_async'] });
      await session.bindExtensions({ mode: 'rpc' }); return { session, services: h.services, diagnostics: [] };
    });
    try {
      await h.invoke({ command: 'fixture' });
      if (action === 'quit') await runtime.dispose();
      else {
        const target = h.session.sessionManager.getEntries().find(e => e.type === 'message' && e.message.role === 'user');
        const result = action.startsWith('fork') ? await runtime.fork(target.id) : await runtime.newSession();
        assert.equal(result.cancelled, action.endsWith('denied'));
      }
      assert.equal(aborted, !action.endsWith('denied')); assert.equal(h.sends.length, 0);
    } finally { await runtime.dispose(); await h.close(); }
  }
});

test('真实Host裸session.dispose不会shutdown，但stale context完成禁止重投', { timeout: 10000 }, async () => {
  const work = barrier(); const h = await host({ operations: { async exec() { await work.promise; return { exitCode: 0 }; } } });
  try {
    await h.invoke({ command: 'fixture' }); h.session.dispose(); work.resolve();
    await new Promise(resolve => setImmediate(resolve)); await h.controller.cancelAll();
    assert.equal(h.sends.length, 0); assert.equal(h.controller.snapshot().completed[0].completionDelivery, 'suppressed-unsafe-context');
  } finally { work.resolve(); await h.close(); }
});

test('真实runtime resume关闭旧controller；拒绝resume不触碰旧jobs', { timeout: 15000 }, async () => {
  for (const denied of [true, false]) {
    let aborted = false;
    const h = await host({ operations: { async exec(_c, _d, { signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true })); } }, extraFactory(pi) { if (denied) pi.on('session_before_switch', () => ({ cancel: true })); } });
    const runtime = new sdk.AgentSessionRuntime(h.session, h.services, async ({ sessionManager, sessionStartEvent }) => {
      const { session } = await sdk.createAgentSession({ cwd: h.root, agentDir: h.services.agentDir, modelRuntime: h.services.modelRuntime, settingsManager: h.services.settingsManager, resourceLoader: h.services.resourceLoader, sessionManager, sessionStartEvent, model: h.services.modelRuntime.getModel('async-bash-fixture', 'fixture'), tools: ['bash_async'] });
      await session.bindExtensions({ mode: 'rpc' }); return { session, services: h.services, diagnostics: [] };
    });
    try {
      await h.invoke({ command: 'fixture' });
      // public SessionManager在本次隔离root生成目标session，不造projection或访问真实history。
      const target = sdk.SessionManager.create(h.root, join(h.root, 'sessions'));
      target.appendMessage({ role: 'user', content: 'fixture resume target', timestamp: Date.now() });
      const result = await runtime.switchSession(target.getSessionFile()); assert.equal(result.cancelled, denied);
      assert.equal(aborted, !denied); assert.equal(h.sends.length, 0);
    } finally { await runtime.dispose(); await h.close(); }
  }
});
