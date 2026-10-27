/**
 * Subagent 名册初始化注入的 F1–F7 行为验收（本计划唯一新增测试文件）。
 *
 * 证据边界（不虚构、不以拼接 prompt 冒充请求）：
 * - 复用既有 `test/helpers/joint-upgrade-session.mjs`：真实 Pi 1.4 SDK、真实 SessionManager、
 *   真实 ExtensionRunner、真实 codemode/工具管线、真实 `extensionFactories`；
 * - `test/fixtures/joint-upgrade/provider-capture.mjs` 的合成 provider 只替代远端响应，
 *   本文件在其 `streamSimple` 入参边界（真实 `normalizeContext` 后的请求transcript）上做只读捕获，
 *   不改写 provider 行为、不伪造 hooks/checkpoint；
 * - admission 使用生产 `registerBuiltinAgentsViaEvents()` 读取仓库 `pi/agents/*.md`，
 *   与真实派发共用同一 `discoverAgents` 回调；GLOBAL/SHARED 使用生产 factory 与仓库真实规范文件；
 * - 不读取本机 models/auth/凭据，不发起任何真实 provider 请求，不新增 npm 依赖。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { sdk, ai, Type, openJointSession } from './helpers/joint-upgrade-session.mjs';
import { createTypedSubagentExtension } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts';
import { registerBuiltinAgentsViaEvents } from '../packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts';
import {
  createAdmittedAgentCatalog,
  formatAgentCatalog,
  projectAgentCatalog,
} from '../packages/pi-subagents-enhanced/src/subagent-dispatch/agent-catalog.ts';
import { createAgentsGlobalExtension } from '../src/agents-global/index.ts';
import { createAgentsSharedExtension } from '../src/agents-shared/index.ts';

const REPO = join(import.meta.dirname, '..');
const ADMISSION_DIR = join(REPO, 'pi');
const SYNTHETIC_PROVIDER = 'joint-synthetic';
const ADVERTISED_KEY = 'advertised_subagents';
const ROSTER_TOOL = 'subagent_roster';
/** 报告已实测的 formatter 正文字节数；本文件断言其未漂移。 */
const EXPECTED_CATALOG_BYTES = 714;
const FOREIGN_SECTION_KEY = 'foreign_extension_canary';
const FOREIGN_SECTION_TEXT = 'FOREIGN-EXTENSION-SECTION-CANARY-4c7a91';
const GLOBAL_SOURCE_LINE = '来源：PI_CODING_AGENT_DIR/AGENTS_GLOBAL.md';
const SHARED_SOURCE_LINE = '来源：PI_CODING_AGENT_DIR/AGENTS_SHARED.md';

/** 生产 admission 源：同一实例既供 catalog 初始化，也供真实派发 discovery。 */
function admissionSource() {
  const admission = registerBuiltinAgentsViaEvents({ pi: { events: { emit() {} } }, agentDir: ADMISSION_DIR });
  const calls = [];
  return {
    calls,
    discover(cwd, scope, provider) {
      const discovery = admission.discoverAgents(cwd, scope, provider);
      calls.push({ cwd, scope, agents: discovery.agents.map(({ name, description }) => ({ name, description })) });
      return discovery;
    },
    dispose() { admission.dispose(); },
  };
}

function readRepoFile(relativePath) {
  return readFile(join(REPO, relativePath), 'utf8').then((text) => text.trim());
}

/**
 * 在真实合成 provider 的 `streamSimple` 入口捕获请求：此处拿到的 `context` 已是 SDK
 * `normalizeContext()` 之后的 transcript（system 消息含 sections/toolsAdded/toolsRemoved）。
 * 只读记录，随后原样委托既有合成 provider。
 */
function captureProviderRequests(session) {
  const requests = [];
  const runtime = session.modelRuntime;
  const config = runtime.getRegisteredProviderConfig(SYNTHETIC_PROVIDER);
  assert.equal(typeof config?.streamSimple, 'function', '合成 provider 必须在 Host 边界可捕获');
  runtime.registerProvider(SYNTHETIC_PROVIDER, {
    ...config,
    streamSimple(model, context, options) {
      requests.push({
        model: { provider: model.provider, id: model.id },
        messages: structuredClone(context.messages),
      });
      return config.streamSimple(model, context, options);
    },
  });
  return requests;
}

function requestSection(request, key) {
  return ai.getCurrentSystemMessage(request.messages)?.sections?.[key];
}

function requestSections(request) {
  return ai.getCurrentSystemMessage(request.messages)?.sections ?? {};
}

function requestPromptText(request) {
  return ai.getCurrentSystemPrompt(request.messages);
}

function requestToolCalls(request) {
  return request.messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter((part) => part?.type === 'toolCall')
    : []);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

/** formatter 对 XML 特殊字符做编码；这里只做测试侧还原，用于和 admission 原文比较。 */
function decodeCatalogText(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 其他 extension 写入的第三方 section：只用公开 `before_agent_start` 事件，不碰自有 key。 */
function foreignSectionFactory(pi) {
  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections[FOREIGN_SECTION_KEY] = FOREIGN_SECTION_TEXT;
  });
}

function mainFactories(source, { rpc = { dispose() {} }, extra = [] } = {}) {
  return [
    foreignSectionFactory,
    ...extra,
    (pi) => createAgentsGlobalExtension(pi),
    (pi) => createAgentsSharedExtension(pi, { scope: 'main' }),
    (pi) => createTypedSubagentExtension(pi, {
      cleanupStore: {},
      rpc,
      discoverAgents: source.discover,
    }),
  ];
}

function legacyRosterFactory(pi) {
  pi.registerTool({
    name: ROSTER_TOOL,
    label: 'Legacy roster',
    description: '已退役的历史 roster 工具（仅用于构造含旧声明的 transcript）',
    parameters: Type.Object({ action: Type.Optional(Type.String()) }),
    async execute() {
      return { content: [{ type: 'text', text: 'legacy roster' }], details: undefined };
    },
  });
}

/** 真实派发所需的 RPC 边界替身：只替代子进程，不替代 admission/discovery。 */
function dispatchRpc() {
  return {
    async ping() {
      return { version: 1, methods: ['spawn'], session: { sessionId: 'catalog-acceptance', sessionFile: '/tmp/catalog-acceptance.jsonl', cwd: '/repo' } };
    },
    async spawn() {
      return { details: { runId: 'catalog-acceptance-run', asyncDir: '/tmp/catalog-acceptance-run' } };
    },
    dispose() {},
  };
}

/* -------------------------------------------------------------------------- */
/* F1 + F3 + F7：首个真实请求                                                   */
/* -------------------------------------------------------------------------- */

test('F1/F3/F7 首个真实请求：唯一且同代的名册 section 与 GLOBAL/SHARED、tool guideline 共存', { timeout: 40000 }, async (t) => {
  const source = admissionSource();
  const h = await openJointSession({ factories: mainFactories(source) });
  t.after(async () => { await h.close(); source.dispose(); });

  const requests = captureProviderRequests(h.session);
  await h.session.prompt('名册首请求验收');

  assert.equal(h.errors.length, 0, '首请求前不得出现扩展错误');
  assert.equal(requests.length, 1, '一次 prompt 只产生一次模型请求');
  const request = requests[0];
  assert.deepEqual(request.model, { provider: SYNTHETIC_PROVIDER, id: 'fixture' });

  // 唯一 section：provider 实际收到的 system prompt 里该 tag 只出现一次。
  const promptText = requestPromptText(request);
  assert.equal(countOccurrences(promptText, `<${ADVERTISED_KEY}>`), 1);
  assert.equal(countOccurrences(promptText, `</${ADVERTISED_KEY}>`), 1);

  // 同代 admission 精确相符：首请求前 catalog 只查询一次 admission。
  assert.equal(source.calls.length, 1, 'catalog 初始化是首请求前唯一的 admission 查询');
  assert.deepEqual(source.calls[0].agents.map((agent) => agent.name), ['delegate', 'executor', 'reviewer']);
  const expectedCatalog = formatAgentCatalog(projectAgentCatalog(source.calls[0].agents));
  assert.equal(requestSection(request, ADVERTISED_KEY), `<${ADVERTISED_KEY}>\n${expectedCatalog}\n</${ADVERTISED_KEY}>`);

  const parsedEntries = [...requestSection(request, ADVERTISED_KEY)
    .matchAll(/<agent name="([^"]+)"><description>([\s\S]*?)<\/description><\/agent>/g)]
    .map((match) => ({ name: match[1], description: decodeCatalogText(match[2]) }));
  assert.deepEqual(parsedEntries, source.calls[0].agents, '名册条目必须与同代 admission 的 name/完整 description 精确相符');

  // 未先调用 roster：请求内无该工具调用，注册面也没有它。
  assert.equal(requestToolCalls(request).some((call) => call.name === ROSTER_TOOL), false);
  assert.equal(h.session.getAllTools().some((tool) => tool.name === ROSTER_TOOL), false);
  assert.equal(h.session.getActiveToolNames().includes(ROSTER_TOOL), false);
  assert.equal(h.session.getCallableToolNames().includes(ROSTER_TOOL), false);

  // F3：三个自有 section 与其他 section 共存，工具指引未被遮蔽。
  const sections = requestSections(request);
  for (const key of ['preamble', 'tools', 'rules', 'docs', 'cwd', 'pi_global_instructions', 'pi_shared_instructions', FOREIGN_SECTION_KEY, ADVERTISED_KEY]) {
    assert.equal(key in sections, true, `首请求必须保留 section ${key}`);
  }
  assert.equal('pi_child_execution_boundaries' in sections, false, 'main scope 不得携带 child 边界');
  const [globalText, sharedText] = await Promise.all([
    readRepoFile('pi/AGENTS_GLOBAL.md'),
    readRepoFile('pi/AGENTS_SHARED.md'),
  ]);
  // SDK 以 section key 自动包裹外层 tag，正文只保留来源说明与文件快照。
  assert.equal(sections.pi_global_instructions, `<pi_global_instructions>\n${GLOBAL_SOURCE_LINE}\n${globalText}\n</pi_global_instructions>`);
  assert.equal(sections.pi_shared_instructions, `<pi_shared_instructions>\n${SHARED_SOURCE_LINE}\n${sharedText}\n</pi_shared_instructions>`);
  assert.equal(promptText.includes('- subagent_start:'), true, '工具清单不得被自有注入遮蔽');
  assert.equal(promptText.includes('派发必须一次携带完整任务合同'), true, '工具 guideline 不得被遮蔽');
  assert.equal(promptText.includes('处置前先调用本工具，以实时 allowed_dispositions 为唯一权威'), true, '其他工具 guideline 不得被遮蔽');
  assert.equal(promptText.includes(FOREIGN_SECTION_TEXT), true, '他人 section 不得被自有注入遮蔽');

  // F7：注入字节observation，不报告 token/cache 估计值。
  const catalogBytes = Buffer.byteLength(expectedCatalog);
  const sectionBytes = Buffer.byteLength(requestSection(request, ADVERTISED_KEY));
  const systemPromptBytes = Buffer.byteLength(promptText);
  t.diagnostic(`formatter 正文 ${catalogBytes} bytes / ${[...expectedCatalog].length} code points`);
  t.diagnostic(`formatter SHA-256 ${createHash('sha256').update(expectedCatalog).digest('hex')}`);
  t.diagnostic(`<advertised_subagents> section ${sectionBytes} bytes；首请求 system prompt ${systemPromptBytes} bytes`);
  t.diagnostic('tokenizer/provider token 与 cache 命中未在本测试测量，不据此声明收益');
  assert.equal(catalogBytes, EXPECTED_CATALOG_BYTES, 'formatter 正文字节数必须与已实测 714 bytes 一致');
  assert.equal(sectionBytes, EXPECTED_CATALOG_BYTES + Buffer.byteLength(`<${ADVERTISED_KEY}>\n\n</${ADVERTISED_KEY}>`));
});

/* -------------------------------------------------------------------------- */
/* F2 + F7：同 session 稳定、计数分离、closing 撤回                              */
/* -------------------------------------------------------------------------- */

test('F2/F7 同 session 重复请求名册稳定，catalog 初始化与真实派发 discovery 分开计量', { timeout: 40000 }, async (t) => {
  const source = admissionSource();
  const h = await openJointSession({ factories: mainFactories(source, { rpc: dispatchRpc() }) });
  t.after(async () => { await h.close(); source.dispose(); });

  const requests = captureProviderRequests(h.session);
  await h.session.prompt('第一轮验收');
  const firstSection = requestSection(requests.at(-1), ADVERTISED_KEY);
  assert.equal(typeof firstSection, 'string');
  assert.equal(source.calls.length, 1, 'catalog snapshot 只初始化一次');

  await h.session.prompt('第二轮验收');
  assert.equal(requests.length, 2, '第二轮同样产生一次请求');
  assert.equal(requestSection(requests.at(-1), ADVERTISED_KEY), firstSection, '同代 section 文本必须逐字节稳定');
  assert.equal(source.calls.length, 1, '重复请求不得重新初始化 catalog');

  // 真实派发入口仍按每次派发执行原 discovery 查询；该增量不是 catalog 初始化。
  const beforeDispatchRequests = requests.length;
  const result = await h.invoke('subagent_start', {
    agent: 'executor',
    task: '只验证 admission 查询次数，不写入任何文件。Known facts: 无。Decisions: 无。Relevant files: 无。',
    output: false,
  });
  assert.equal(result?.toolName, 'subagent_start', '派发必须真实进入 subagent_start 执行路径');
  assert.equal(source.calls.length, 2, '真实派发独立查询一次 admission');
  assert.equal(source.calls[1].cwd, h.cwd, '派发查询使用当前 session cwd');
  assert.ok(requests.length > beforeDispatchRequests);

  await h.session.prompt('派发后再验收');
  assert.equal(requestSection(requests.at(-1), ADVERTISED_KEY), firstSection, '派发不得触发 catalog 重建或文本漂移');
  assert.equal(source.calls.length, 2, '派发后仍是 1 次 catalog 初始化 + 1 次派发查询');

  // closing：session_shutdown 入口同步失效，旧目录不得继续发布。
  await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  await h.session.prompt('关闭后验收');
  const closed = requests.at(-1);
  const closedSections = requestSections(closed);
  assert.equal(ADVERTISED_KEY in closedSections, false, 'closing 期间必须撤回名册 section');
  assert.equal('pi_global_instructions' in closedSections, true);
  assert.equal('pi_shared_instructions' in closedSections, true);
  assert.equal(countOccurrences(requestPromptText(closed), `<${ADVERTISED_KEY}>`), 0);
  assert.equal(source.calls.length, 2, 'closing 后不得重新初始化 catalog');
});

/* -------------------------------------------------------------------------- */
/* F4 + F2（resume 新代）：旧 roster declaration 的 removed delta               */
/* -------------------------------------------------------------------------- */

test('F4/F2 含旧 roster declaration 的历史会话 resume 后首请求出现 removed delta 且名册为当前代', { timeout: 60000 }, async (t) => {
  const source = admissionSource();
  const rpc = dispatchRpc();
  const factories = (withLegacyRoster) => mainFactories(source, {
    rpc,
    extra: withLegacyRoster ? [legacyRosterFactory] : [],
  });

  const host = await openJointSession({ factories: factories(true), persistent: true });
  const requests = captureProviderRequests(host.session);
  let resumed;
  t.after(async () => {
    try { await resumed?.abort(); } catch { /* already disposed */ }
    try { resumed?.dispose(); } catch { /* already disposed */ }
    await rm(host.temp, { recursive: true, force: true });
    source.dispose();
  });

  await host.session.prompt('历史轮次');
  assert.equal(requestToolCalls(requests[0]).some((call) => call.name === ROSTER_TOOL), false);
  const historicalDeclarations = requests[0].messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.toolsAdded ?? [])
    .map((tool) => tool.name);
  assert.equal(historicalDeclarations.includes(ROSTER_TOOL), true, '历史 transcript 必须真实声明旧 roster 工具');
  assert.equal(historicalDeclarations.includes('subagent_start'), true);
  assert.equal(host.session.getActiveToolNames().includes(ROSTER_TOOL), true);

  const sessionFile = host.session.sessionManager.getSessionFile();
  assert.equal(typeof sessionFile, 'string');
  const sessionsDir = join(host.agentDir, 'sessions');
  const catalogCallsBeforeResume = source.calls.length;
  await host.session.abort();
  await host.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  host.session.dispose();

  // resume = 新 Host 实例、新 resource loadout（不含旧 roster factory）、同一 session 文件。
  const loader = new sdk.DefaultResourceLoader({
    cwd: host.cwd,
    agentDir: host.agentDir,
    settingsManager: host.session.settingsManager,
    eventBus: sdk.createEventBus(),
    extensionFactories: factories(false),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const resumedManager = sdk.SessionManager.open(sessionFile, sessionsDir, host.cwd);
  const resumeErrors = [];
  ({ session: resumed } = await sdk.createAgentSession({
    cwd: host.cwd,
    agentDir: host.agentDir,
    settingsManager: host.session.settingsManager,
    modelRuntime: host.session.modelRuntime,
    model: host.session.model,
    resourceLoader: loader,
    thinkingLevel: 'off',
    sessionManager: resumedManager,
  }));
  await resumed.bindExtensions({ mode: 'print', onError: (error) => resumeErrors.push(error) });
  assert.deepEqual(resumeErrors, []);

  const beforeResumeRequests = requests.length;
  await resumed.prompt('resume 后首请求验收');
  assert.equal(requests.length, beforeResumeRequests + 1, 'resume 后一次 prompt 产生一次请求');
  const resumedRequest = requests.at(-1);
  const removed = resumedRequest.messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.toolsRemoved ?? [])
    .map((tool) => tool.name);
  assert.deepEqual(removed, [ROSTER_TOOL], 'resume 首请求只能报告旧 roster 的 removed delta');

  const activeTools = ai.getCurrentTools(resumedRequest.messages).map((tool) => tool.name);
  assert.equal(activeTools.includes(ROSTER_TOOL), false, 'replay 后的 tool loadout 不得含 roster');
  assert.equal(resumed.getAllTools().some((tool) => tool.name === ROSTER_TOOL), false);
  assert.equal(resumed.getActiveToolNames().includes(ROSTER_TOOL), false);
  assert.equal(resumed.getCallableToolNames().includes(ROSTER_TOOL), false);

  // 新代重建：resume 后 catalog 重新初始化一次，section 与同代 admission 相符。
  assert.equal(source.calls.length, catalogCallsBeforeResume + 1, 'resume 触发新 generation 重建');
  const expectedCatalog = formatAgentCatalog(projectAgentCatalog(source.calls.at(-1).agents));
  assert.equal(requestSection(resumedRequest, ADVERTISED_KEY), `<${ADVERTISED_KEY}>\n${expectedCatalog}\n</${ADVERTISED_KEY}>`);
  assert.equal(countOccurrences(requestPromptText(resumedRequest), `<${ADVERTISED_KEY}>`), 1);
  assert.equal('pi_global_instructions' in requestSections(resumedRequest), true);
  assert.equal('pi_shared_instructions' in requestSections(resumedRequest), true);
});

/* -------------------------------------------------------------------------- */
/* F5：真实 compact                                                             */
/* -------------------------------------------------------------------------- */

test('F5 真实 compact：system checkpoint 与下一请求保留名册与 GLOBAL/SHARED，无重复普通消息', { timeout: 60000 }, async (t) => {
  const source = admissionSource();
  const h = await openJointSession({ factories: mainFactories(source) });
  t.after(async () => { await h.close(); source.dispose(); });

  const requests = captureProviderRequests(h.session);
  await h.session.prompt('compact 前第一轮');
  const beforeCompactSection = requestSection(requests.at(-1), ADVERTISED_KEY);
  assert.equal(typeof beforeCompactSection, 'string');
  await h.session.prompt('compact 前第二轮');
  assert.equal(source.calls.length, 1);

  // 小会话要达到真实 cut point：只调整 compaction 阈值，压缩代码路径不变。
  h.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
  const compactionResult = await h.session.compact();
  assert.equal(typeof compactionResult.summary, 'string');
  const compactionEntry = h.session.sessionManager.getBranch().find((entry) => entry.type === 'compaction');
  assert.ok(compactionEntry, '真实 compact 必须写入 compaction entry');
  assert.equal(compactionEntry.systemMessage?.sections?.[ADVERTISED_KEY], beforeCompactSection, '当前名册 section 必须进入 system checkpoint');
  assert.equal(typeof compactionEntry.systemMessage.sections.pi_global_instructions, 'string');
  assert.equal(typeof compactionEntry.systemMessage.sections.pi_shared_instructions, 'string');
  assert.equal(source.calls.length, 1, 'compact 不得重新初始化 catalog');

  const beforeNext = requests.length;
  await h.session.prompt('compact 后验收');
  assert.equal(requests.length, beforeNext + 1);
  const resumedRequest = requests.at(-1);
  const sections = requestSections(resumedRequest);
  assert.equal(sections[ADVERTISED_KEY], beforeCompactSection, 'compact 后下一请求仍有当前名册');
  assert.equal(typeof sections.pi_global_instructions, 'string');
  assert.equal(typeof sections.pi_shared_instructions, 'string');
  const promptText = requestPromptText(resumedRequest);
  for (const key of [ADVERTISED_KEY, 'pi_global_instructions', 'pi_shared_instructions', 'rules', 'tools']) {
    assert.equal(countOccurrences(promptText, `<${key}>`), 1, `compact 后 <${key}> 不得重复或丢失`);
  }

  const userTexts = resumedRequest.messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => part?.text ?? '').join('')));
  assert.equal(userTexts.length, 2, 'compact 后只应有 compaction summary 与新提示两条普通 user 消息');
  assert.equal(userTexts.filter((text) => text.includes('compact 后验收')).length, 1);
  assert.equal(userTexts.filter((text) => text.includes('<summary>')).length, 1, 'compaction summary 只出现一次');
  assert.equal(userTexts.some((text) => text.includes('compact 前第一轮')), false, '压缩前普通消息不得重复保留');
  assert.equal(userTexts.some((text) => text.includes('compact 前第二轮')), false);
  assert.equal(source.calls.length, 1, 'compact 后请求不得重新初始化 catalog');
});

/* -------------------------------------------------------------------------- */
/* F2：两个 Host / cwd 变化，无跨 Host 缓存                                     */
/* -------------------------------------------------------------------------- */

test('F2 第二个 Host 与不同 cwd 各建新代，旧 Host 的失效不污染另一个 Host', { timeout: 60000 }, async (t) => {
  const firstSource = admissionSource();
  const secondSource = admissionSource();
  const first = await openJointSession({ factories: mainFactories(firstSource) });
  const second = await openJointSession({ factories: mainFactories(secondSource) });
  t.after(async () => { await second.close(); firstSource.dispose(); });
  t.after(async () => { await first.close(); secondSource.dispose(); });

  const firstRequests = captureProviderRequests(first.session);
  const secondRequests = captureProviderRequests(second.session);
  assert.notEqual(first.cwd, second.cwd, '两个 Host 必须是不同的 cwd');
  assert.notEqual(first.session.sessionManager, second.session.sessionManager);

  await first.session.prompt('Host A 验收');
  await second.session.prompt('Host B 验收');
  const expectedFirst = formatAgentCatalog(projectAgentCatalog(firstSource.calls[0].agents));
  const expectedSecond = formatAgentCatalog(projectAgentCatalog(secondSource.calls[0].agents));
  assert.equal(requestSection(firstRequests.at(-1), ADVERTISED_KEY), `<${ADVERTISED_KEY}>\n${expectedFirst}\n</${ADVERTISED_KEY}>`);
  assert.equal(requestSection(secondRequests.at(-1), ADVERTISED_KEY), `<${ADVERTISED_KEY}>\n${expectedSecond}\n</${ADVERTISED_KEY}>`);
  assert.equal(firstSource.calls.length, 1, 'Host A 只初始化自己的 catalog');
  assert.equal(secondSource.calls.length, 1, 'Host B 只初始化自己的 catalog');
  assert.equal(firstSource.calls[0].cwd, first.cwd);
  assert.equal(secondSource.calls[0].cwd, second.cwd);

  // Host B 关闭不影响 Host A：没有跨 Host 的实例缓存或失效传播。
  await second.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  await second.session.prompt('Host B 关闭后验收');
  assert.equal(requestSection(secondRequests.at(-1), ADVERTISED_KEY), undefined, '关闭的 Host 不得继续发布名册');
  await first.session.prompt('Host A 复验收');
  assert.equal(requestSection(firstRequests.at(-1), ADVERTISED_KEY), `<${ADVERTISED_KEY}>\n${expectedFirst}\n</${ADVERTISED_KEY}>`);
  assert.equal(firstSource.calls.length, 1);
  assert.equal(secondSource.calls.length, 1);
});

/* -------------------------------------------------------------------------- */
/* F6：fresh child 边界                                                         */
/* -------------------------------------------------------------------------- */

test('F6 fresh child scope：只有 SHARED 与 child 边界，无 GLOBAL、名册与父级操作工具', { timeout: 40000 }, async (t) => {
  const h = await openJointSession({
    factories: [(pi) => createAgentsSharedExtension(pi, { scope: 'child' })],
  });
  t.after(async () => { await h.close(); });

  const requests = captureProviderRequests(h.session);
  await h.session.prompt('child 首请求验收');
  assert.equal(h.errors.length, 0);
  const request = requests.at(-1);
  const sections = requestSections(request);
  assert.equal('pi_shared_instructions' in sections, true, 'child 必须收到 SHARED');
  assert.equal('pi_child_execution_boundaries' in sections, true, 'child 必须收到子执行边界');
  assert.equal('pi_global_instructions' in sections, false, 'child 不得收到 GLOBAL');
  assert.equal(ADVERTISED_KEY in sections, false, 'fresh child 不得收到父级名册');
  const promptText = requestPromptText(request);
  assert.equal(countOccurrences(promptText, '<pi_global_instructions>'), 0);
  assert.equal(countOccurrences(promptText, `<${ADVERTISED_KEY}>`), 0);
  assert.ok(sections.pi_child_execution_boundaries.includes('来源：runtime'));
  assert.ok(sections.pi_child_execution_boundaries.includes('不得新增委派'));
  assert.ok(sections.pi_child_execution_boundaries.includes('contact_supervisor'));

  const activeTools = h.session.getActiveToolNames();
  const parentTools = ['subagent_start', 'subagent_run_status', 'subagent_run_steer', 'subagent_run_interrupt',
    'subagent_run_resume', 'subagent_run_stop', 'subagent_supervisor', 'subagent_integration',
    'managed_workspace_list', 'managed_workspace_status', 'managed_workspace_dispose', 'managed_workspace_release'];
  for (const name of parentTools) {
    assert.equal(activeTools.includes(name), false, `fresh child 不得获得父级工具 ${name}`);
    assert.equal(h.session.getAllTools().some((tool) => tool.name === name), false, `fresh child 不得注册 ${name}`);
  }
});

/* -------------------------------------------------------------------------- */
/* F6：start 不可用 / admission 未就绪时撤回                                     */
/* -------------------------------------------------------------------------- */

test('F6 start 不可用或 admission 未就绪时撤回名册 section，不返回硬编码角色', { timeout: 60000 }, async (t) => {
  const source = admissionSource();
  const available = await openJointSession({ factories: mainFactories(source) });
  t.after(async () => { await available.close(); source.dispose(); });
  const requests = captureProviderRequests(available.session);
  await available.session.prompt('start 可用');
  assert.equal(typeof requestSection(requests.at(-1), ADVERTISED_KEY), 'string');

  // start 不可用：真实 Host 关闭该工具的模型声明，catalog 必须撤回自有 section。
  available.session.setActiveToolsByName(['read', 'bash', 'edit', 'write', 'subagent_run_status']);
  await available.session.prompt('start 不可用');
  const withoutStart = requests.at(-1);
  assert.equal(available.session.getActiveToolNames().includes('subagent_start'), false);
  assert.equal(ADVERTISED_KEY in requestSections(withoutStart), false, 'start 不可用时必须撤回名册');
  const retractions = withoutStart.messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => Object.entries(message.sections ?? {}))
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  assert.deepEqual(retractions, [ADVERTISED_KEY], '撤回必须由自有 section 的 null delta 表达');
  assert.equal('pi_global_instructions' in requestSections(withoutStart), true);
  assert.equal('pi_shared_instructions' in requestSections(withoutStart), true);
  assert.equal(source.calls.length, 1, '撤回不重新初始化 catalog');

  // 恢复 start 后同一代文本回归。
  available.session.setActiveToolsByName([...available.session.getActiveToolNames(), 'subagent_start']);
  await available.session.prompt('start 恢复');
  assert.equal(typeof requestSection(requests.at(-1), ADVERTISED_KEY), 'string');
  assert.equal(source.calls.length, 1);

  // admission 未就绪：ready 失败记录扩展错误，catalog 不发布任何目录，也不使用硬编码三角色。
  const unavailable = await openJointSession({
    factories: [
      (pi) => createAgentsGlobalExtension(pi),
      (pi) => createAgentsSharedExtension(pi, { scope: 'main' }),
      (pi) => createTypedSubagentExtension(pi, {
        cleanupStore: {},
        rpc: { dispose() {} },
        discoverAgents: async () => {
          throw Object.assign(new Error('AGENT_ADMISSION_UNAVAILABLE'), { code: 'AGENT_ADMISSION_UNAVAILABLE' });
        },
      }),
    ],
  });
  t.after(async () => { await unavailable.close(); });
  const unavailableRequests = captureProviderRequests(unavailable.session);
  await unavailable.session.prompt('admission 未就绪');
  assert.equal(unavailable.errors.length, 1, 'catalog 初始化失败必须进入既有扩展错误诊断');
  assert.ok(String(unavailable.errors[0].error).includes('AGENT_ADMISSION_UNAVAILABLE'));
  assert.equal(unavailable.errors[0].event, 'session_start');
  const failed = unavailableRequests.at(-1);
  assert.equal(ADVERTISED_KEY in requestSections(failed), false, 'admission 未就绪时不得发布名册');
  assert.equal(countOccurrences(requestPromptText(failed), '<agent name='), 0, '不得以硬编码角色兜底');
  assert.equal('pi_global_instructions' in requestSections(failed), true);
  assert.equal('pi_shared_instructions' in requestSections(failed), true);
});

/* -------------------------------------------------------------------------- */
/* F2/F7：名册 module 合同（generation / cwd / tool 门禁 / 不可变投影）            */
/* -------------------------------------------------------------------------- */

test('F2/F7 名册 module：稳定排序与不可变投影、generation/cwd 失效、selectedTools 门禁', async () => {
  const agents = [
    { name: 'reviewer', description: '审阅角色', metadata: { tools: ['read'] }, systemPrompt: '不应出现' },
    { name: 'delegate', description: '实现\t角色\n第二行' },
  ];
  const projected = projectAgentCatalog(agents);
  assert.deepEqual(projected, [
    { name: 'delegate', description: '实现\t角色\n第二行' },
    { name: 'reviewer', description: '审阅角色' },
  ]);
  assert.notEqual(projected[0], agents[1], '投影必须是新对象，不暴露 admission 引用');
  assert.equal(Object.keys(projected[1]).join(','), 'name,description');
  assert.equal(agents.order, undefined);
  const formatted = formatAgentCatalog(projected);
  assert.ok(formatted.indexOf('delegate') < formatted.indexOf('reviewer'), '按 canonical name 稳定排序');
  assert.ok(formatted.includes('实现\t角色\n第二行'), 'description 原文保留');
  assert.ok(formatted.includes('subagent_start'));
  assert.ok(formatted.includes('默认不传 model'));
  const hostile = formatAgentCatalog(projectAgentCatalog([{ name: 'x', description: 'a<b&c">\u001b[31m' }]));
  assert.ok(hostile.includes('a&lt;b&amp;c&quot;&gt;'), 'XML 特殊字符必须编码');
  assert.equal(hostile.includes('\u001b'), false, '终端控制符必须清理');

  const ctxA = { sessionManager: { getSessionId: () => 'session-a' }, cwd: '/repo/a' };
  const ctxB = { sessionManager: { getSessionId: () => 'session-b' }, cwd: '/repo/b' };
  let reads = 0;
  const catalog = createAdmittedAgentCatalog({
    readAdmittedAgents() {
      reads += 1;
      return { admission: 'repository-configured', agents };
    },
  });
  const options = () => ({ sections: {}, selectedTools: ['read', 'subagent_start'] });

  await catalog.initialize(ctxA);
  assert.equal(reads, 1);
  await catalog.initialize(ctxA);
  assert.equal(reads, 1, '同代重复 initialize 复用同一 snapshot');
  const first = options();
  catalog.apply({ systemPromptOptions: first }, ctxA);
  assert.equal(first.sections[ADVERTISED_KEY], formatted);

  // cwd/session 变化即新 generation：旧代回调不得写新代。
  await catalog.initialize(ctxB);
  assert.equal(reads, 2, '新 cwd/session 必须重建 snapshot');
  const stale = options();
  catalog.apply({ systemPromptOptions: stale }, ctxA);
  assert.equal(ADVERTISED_KEY in stale.sections, false, '旧代 ctx 不得发布当前代名册');
  const current = options();
  catalog.apply({ systemPromptOptions: current }, ctxB);
  assert.equal(current.sections[ADVERTISED_KEY], formatted);

  // selectedTools 门禁：没有 subagent_start 时撤回自有 key。
  const disabled = { sections: { [ADVERTISED_KEY]: 'stale' }, selectedTools: ['read'] };
  catalog.apply({ systemPromptOptions: disabled }, ctxB);
  assert.equal(ADVERTISED_KEY in disabled.sections, false);

  // invalidate 让迟到结果失效；dispose 幂等且不再初始化。
  catalog.invalidate();
  const afterInvalidate = options();
  catalog.apply({ systemPromptOptions: afterInvalidate }, ctxB);
  assert.equal(ADVERTISED_KEY in afterInvalidate.sections, false);
  catalog.dispose();
  catalog.dispose();
  await catalog.initialize(ctxB);
  assert.equal(reads, 2, 'dispose 后不得再读取 admission');

  // 非 repository-configured 或读取失败：初始化失败并保持 unavailable，不回退硬编码角色。
  const failing = createAdmittedAgentCatalog({
    readAdmittedAgents: () => ({ admission: 'unavailable', agents }),
  });
  await assert.rejects(() => failing.initialize(ctxA), /repository-configured/);
  const unavailableOptions = options();
  failing.apply({ systemPromptOptions: unavailableOptions }, ctxA);
  assert.equal(ADVERTISED_KEY in unavailableOptions.sections, false);
});
