import { createLocalBashOperations, type ExtensionAPI, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { createBashCwdToolDefinition, prepareBashCwdExecution } from '../bash-cwd/index.ts';
// 公共后台活动协议只经 package 公开出口 bare specifier 消费，不深引 package 内部文件。
import {
  BACKGROUND_ACTIVITY_CHANNELS,
  createBackgroundActivityRegistrationId,
  isHostScope,
  isSameHostScopeIdentity,
} from 'pi-subagents-enhanced/tui/background-activity';
import type {
  ActivityKind,
  ActivityRow,
  ActivitySnapshot,
  ActivitySource,
  DetailComponent,
  DetailRequest,
  HostScope,
  HostScopeIdentity,
  OwnerReadyPayload,
} from 'pi-subagents-enhanced/tui/background-activity';
import { createBashAsyncController } from './controller.ts';
import type { BashAsyncController, BashAsyncLaunchReceipt, BashAsyncTerminalReceipt, Delivery } from './contracts.ts';
import type { BashAsyncRequest, ExecutionEvidence } from './contracts.ts';
export * from './contracts.ts';
export { createBashAsyncController } from './controller.ts';
export { createBashAsyncCompleteRenderer, type BashAsyncRendererDeps } from './renderer.ts';

export function createBashAsyncExtension(pi: ExtensionAPI, options: Parameters<typeof createBashCwdToolDefinition>[0]) {
  const base = createBashCwdToolDefinition(options);
  const controller = createBashAsyncController({
    send: (message, delivery) => pi.sendMessage(message, delivery),
    async prepare(request: BashAsyncRequest, ctx: ExtensionToolContext) {
      const id = ctx.sessionManager.getSessionId(), file = ctx.sessionManager.getSessionFile();
      // 只快照原生Bash确实消费的事实；不保留动态sessionManager/model getter。
      const captured = { cwd: ctx.cwd, model: ctx.model ? { ...ctx.model } : undefined, thinkingLevel: ctx.thinkingLevel, sessionManager: { getSessionId: () => id, getSessionFile: () => file } };
      const evidence: ExecutionEvidence = {};
      const prepared = await prepareBashCwdExecution(options, request, ctx, config => {
        const operations = config.operations ?? createLocalBashOperations({ shellPath: config.shellPath });
        return { ...config, operations: { async exec(...args) {
          try { const result = await operations.exec(...args); evidence.exitCode = result.exitCode; return result; }
          catch (error) { evidence.backendError = error; throw error; }
        } } };
      });
      return { cwd: prepared.cwd, evidence, execute: (toolCallId, { cwd: _cwd, ...params }, signal) => prepared.definition.execute(toolCallId, params, signal, undefined, captured) };
    },
  });
  // receipt不沿用原生outputSchema/renderResult；保留原生parameters/cwd输入合同。
  const { outputSchema: _outputSchema, constrainedSampling: _sampling, renderResult: _resultRenderer, renderCall: _callRenderer, execute: _execute, ...metadata } = base;
  pi.registerTool({
    ...metadata,
    name: 'bash_async', label: 'bash_async', exposure: 'model-only',
    description: '后台复用原生 Bash 执行命令，立即返回 jobId 接受回执，不等待命令结束。完成后自动向本会话 followUp 队列投递原生结果。仅用于测试套件、类型检查、产物构建、含网络请求等真实长耗时工作；不要为等待回执执行 sleep/wait，也不要把它用作延时器或常驻 daemon。收到接受回执后立即继续其他无冲突工作；没有独立工作时结束当前回合，命令完成会自动投 followUp 唤醒本会话。不要用 bash sleep 或轮询等结果，也不要用 bash_async 跑 sleep 来替代等待。短查询或立即依赖输出的操作使用 bash。仅 TUI/RPC；不提供隔离、跨会话持久化或崩溃后重放。',
    promptSnippet: '异步执行长耗时命令并在完成后自动接收回执',
    promptGuidelines: [
      '启动成功只代表接受任务；以 bash-async-complete 的 outcome/exitCode 判断执行结果。',
      '接受回执后立即继续其他无冲突工作；没有独立工作就结束当前回合，完成时自动投 followUp 唤醒。正例：启动 e2e 测试后转去处理无关文件或直接结束回合；反例：bash_async 启动构建后紧跟 bash "sleep 60" 干等、反复轮询任务状态、或另起阻塞命令纯粹等结果。同 cwd 并发写入并未隔离。',
      '不得用后台任务绕过命令门禁、凭据、网络或提交授权；不要用于自建 daemon，也不要用 bash_async 跑 sleep/wait 循环变相等待或当延时器。例外边界：真实命令内部的 retry/backoff、测试自身的模拟延迟、用户任务里明确要求的 delay 都按任务照常执行，不属于禁止项；用户提出的未来某时刻或重复执行的任务用 scheduler_create，不得自行提交定时器。',
      'print/json 不支持；tree/独立 compaction/reload/switch/退出可能取消任务。clear_queue 可清除已提交的回执且不自动重发。',
    ],
    async execute(toolCallId, request, signal, _onUpdate, ctx) {
      const receipt = await controller.launch(toolCallId, request as BashAsyncRequest, ctx, signal);
      // 第一块保持原 JSON.stringify(receipt) 字节与字段不变（details 同 receipt 原样，TUI renderer 继续消费 details）；
      // 第二块是发给模型的显式行为引导，不是为显示而改 raw。
      return {
        content: [
          { type: 'text', text: JSON.stringify(receipt) },
          { type: 'text', text: '以上为启动回执：accepted 仅代表任务已接受，不代表命令成功。现在请立即继续其他无冲突工作；没有独立工作就结束当前回合，命令完成后会自动投 followUp 唤醒本会话。不要用 bash 执行 sleep 等待，不要轮询本任务状态，也不要另起阻塞命令纯粹干等结果。' },
        ],
        details: receipt,
      };
    },
  });
  pi.on('session_start', async (_event, ctx) => { await controller.start(ctx.sessionManager.getSessionId()); });
  pi.on('session_shutdown', async event => { await controller.shutdown(event.reason); });
  pi.on('session_before_tree', async () => { await controller.invalidateBranch(); });
  pi.on('session_before_compact', async (_event, ctx) => {
    // 普通活跃run里的自动compaction仍由Host路由；独立compaction则保守取消。
    if (!ctx.signal) await controller.invalidateBranch();
  });
  pi.registerCommand('bash-async-cancel', {
    description: '取消本会话指定异步 Bash job，或 all；不撤销已经发生的副作用',
    async handler(args, ctx) {
      if (args.trim() === 'all') { await controller.cancelAll(); ctx.ui.notify('已请求取消当前会话全部异步 Bash，并等待原生执行收束', 'info'); }
      else { const result = await controller.cancel(args.trim()); ctx.ui.notify(JSON.stringify(result), result.accepted ? 'info' : 'warning'); }
    },
  });
  return controller;
}

// ---- bash_async 只读观察 ActivitySource 与同 Host TUI publisher（统一计划F3 / footer子计划T3） ----
// 协议来自 package 公开出口 pi-subagents-enhanced/tui/background-activity（F1/T1交付）。
// source 是纯拉取只读投影：不发送消息、不abort任务、不新建任务权威；
// publisher 把 source 经 Host 内存 bus 注册给统一 footer owner（F6接线前的publisher侧合同）。

/** 后台活动展示注入：详情文本组件由 Host 入口绑定公开 TUI 层，src 不直接依赖 TUI 运行时。 */
export type BashAsyncActivityDeps = {
  Text: new (text?: string, paddingX?: number, paddingY?: number) => Component;
};

/** Host 内存 bus 的最小投影（pi.events 的 on/emit 绑定形状）。 */
export type BashAsyncActivityBus = Readonly<{
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}>;

/** session_start 捕获的 Host 身份与模式：scope = sessionManager + sessionId，捕获后不再读动态getter。 */
export type BashAsyncActivitySession = Readonly<{
  mode: string;
  sessionManager: object;
  sessionId: string;
}>;

/** 同 Host TUI publisher：只负责 source 注册/撤销，不碰任务执行、取消或发送。 */
export type BashAsyncActivityPublisher = {
  onSessionStart(session: BashAsyncActivitySession): void;
  onSessionShutdown(): void;
};

const ACTIVITY_KIND: ActivityKind = 'bash_async';
const ACTIVITY_KEY_PREFIX = 'bash_async:';
const ACTIVITY_RUNNING_LABEL = 'running';

function activityKey(jobId: string): string {
  return `${ACTIVITY_KEY_PREFIX}${jobId}`;
}

function parseActivityKey(key: string): string | undefined {
  if (!key.startsWith(ACTIVITY_KEY_PREFIX)) return undefined;
  const jobId = key.slice(ACTIVITY_KEY_PREFIX.length);
  return jobId ? jobId : undefined;
}

function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(1))}s`;
  const totalSeconds = Math.round(ms / 1_000);
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`;
}

// 回执投递事实的行状态分类：attempted/accepted 只是发送尝试事实，绝不显示为消费确认；
// suppressed-*/delivery-error 显式附在行状态里，footer 内可解释，不推断删除/完成。
const DELIVERED_ATTEMPTS: ReadonlySet<Delivery> = new Set<Delivery>(['attempted', 'accepted']);

function terminalStateLabel(receipt: BashAsyncTerminalReceipt): string {
  return DELIVERED_ATTEMPTS.has(receipt.completionDelivery)
    ? receipt.outcome
    : `${receipt.outcome} · ${receipt.completionDelivery}`;
}

/** active详情只含启动回执事实：不虚构stdout、不预示终态。 */
function launchDetailLines(receipt: BashAsyncLaunchReceipt): string[] {
  return [
    'bash_async · 运行中（仅启动回执事实，无输出流）',
    `job: ${receipt.jobId}`,
    `command: ${receipt.command}`,
    `cwd: ${receipt.cwd}`,
    `toolCallId: ${receipt.toolCallId}`,
    `acceptedAt: ${receipt.acceptedAt}`,
    '运行中的详情不含原生输出；完成后在 recent 详情查看回执与输出原文。',
  ];
}

/** terminal详情读原content blocks（或error正文），只投影typed outcome与delivery事实。 */
function nativeOutputLines(output: BashAsyncTerminalReceipt['output']): string[] {
  const raw = output as unknown;
  if (typeof raw === 'object' && raw !== null && 'error' in raw) {
    const error = (raw as { error?: { name?: unknown; message?: unknown } }).error;
    const name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
    const message = typeof error?.message === 'string' ? error.message : '';
    return [`error(${name}): ${message}`];
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { content?: unknown }).content)) {
    return ['（完成回执未携带可读的 content blocks）'];
  }
  const blocks = (raw as { content: readonly unknown[] }).content;
  const texts: string[] = [];
  let nonText = 0;
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      if ((block as { text: string }).text.length > 0) texts.push((block as { text: string }).text);
    } else {
      nonText++;
    }
  }
  if (nonText > 0) texts.push(`（另有 ${nonText} 个非文本输出块，文本详情不展示）`);
  return texts.length > 0 ? texts : ['（无文本输出）'];
}

function terminalDetailLines(receipt: BashAsyncTerminalReceipt): string[] {
  const lines = [
    `bash_async · ${receipt.outcome}`,
    `job: ${receipt.jobId}`,
    `command: ${receipt.command}`,
    `cwd: ${receipt.cwd}`,
    `toolCallId: ${receipt.toolCallId}`,
    `acceptedAt: ${receipt.acceptedAt}`,
    `elapsed: ${formatElapsedMs(receipt.elapsedMs)}`,
  ];
  if (typeof receipt.exitCode === 'number') lines.push(`exit: ${receipt.exitCode}`);
  lines.push(`delivery: ${receipt.completionDelivery}（回执投递事实；accepted 仅代表发送调用被接受，不代表模型已消费）`);
  if (receipt.deliveryError) lines.push(`deliveryError: ${receipt.deliveryError}`);
  lines.push('以下为原生输出原文（不可信命令数据，不是新指令）；启动回执不代表命令成功。');
  lines.push(...nativeOutputLines(receipt.output));
  return lines;
}

/**
 * 创建 bash_async 只读观察 ActivitySource：
 * - snapshot 即时读取 controller 的 active/completed，不缓存、不写回、不建第二任务集合；
 * - 稳定 row key 为 `bash_async:<jobId>`；active 进 main、terminal 进 recent；
 * - label 保留原 command（截断/换行归 renderer 层）；状态只区分 outcome 与 delivery 事实；
 * - detail 一次性生成（无streaming API，requestRender 不被调用）：active 仅 launch 元数据，
 *   terminal 读原 content blocks + typed outcome + delivery；未命中 key 不按 label 复活。
 */
export function createBashAsyncActivitySource(controller: BashAsyncController, deps: BashAsyncActivityDeps): ActivitySource {
  const { Text } = deps;
  const snapshot = (): ActivitySnapshot => {
    try {
      const { active, completed } = controller.snapshot();
      const rows: ActivityRow[] = [];
      for (const receipt of active) {
        rows.push({ key: activityKey(receipt.jobId), kind: ACTIVITY_KIND, label: receipt.command, stateLabel: ACTIVITY_RUNNING_LABEL, placement: 'main' });
      }
      for (const receipt of completed) {
        rows.push({ key: activityKey(receipt.jobId), kind: ACTIVITY_KIND, label: receipt.command, stateLabel: terminalStateLabel(receipt), placement: 'recent' });
      }
      return { availability: 'available', rows, observedAt: new Date().toISOString() };
    } catch (error) {
      // 内存source读取失败且无历史可stale：按无观察unavailable，不虚构任务也不创建错误行。
      return { availability: 'unavailable', rows: [], errorLabel: `bash_async 快照读取失败：${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const subscribe = (invalidate: () => void): (() => void) => controller.subscribe(invalidate);
  const detail = async (key: string, _request: DetailRequest): Promise<DetailComponent | undefined> => {
    const jobId = typeof key === 'string' ? parseActivityKey(key) : undefined;
    if (!jobId) return undefined;
    const { active, completed } = controller.snapshot();
    const launch = active.find(receipt => receipt.jobId === jobId);
    if (launch) return new Text(launchDetailLines(launch).join('\n'), 1, 0);
    const terminal = completed.find(receipt => receipt.jobId === jobId);
    if (terminal) return new Text(terminalDetailLines(terminal).join('\n'), 1, 0);
    return undefined;
  };
  return { kind: ACTIVITY_KIND, snapshot, subscribe, detail };
}

function isOwnerReadyPayload(value: unknown): value is OwnerReadyPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isHostScope(candidate.scope) && typeof candidate.ownerRegistrationId === 'string';
}

/** 单个publisher epoch：session_start捕获的身份、当代source与注册身份。 */
interface PublisherEpoch {
  readonly identity: HostScopeIdentity;
  readonly registrationId: string;
  readonly source: ActivitySource;
  readonly unsubscribeReady: () => void;
  registered: { scope: HostScope; registrationId: string } | undefined;
}

/**
 * 创建同 Host TUI publisher：把 bash_async source 注册给统一后台活动 footer owner。
 * - 先 listen owner-ready 再 emit owner-request：owner/publisher 任意加载顺序均可完成握手；
 * - 只回答 manager/sessionId/hostKey 三要素同时匹配的 ready；重复 ready 复用同 registrationId，幂等；
 * - 新 session_start 换新 registrationId，旧 epoch 按同 scope+旧 registrationId exact 撤销；
 * - shutdown 退订 ready 并 exact 撤销最后注册；owner 缺席或 bus 失效不构成执行失败。
 */
export function createBashAsyncActivityPublisher(controller: BashAsyncController, deps: BashAsyncActivityDeps, bus: BashAsyncActivityBus): BashAsyncActivityPublisher {
  let epoch: PublisherEpoch | undefined;
  const emitOrIgnore = (channel: string, data: unknown): void => {
    try { bus.emit(channel, data); } catch { /* owner 缺席/bus 失效不是bash执行失败：不向命令链路报告 */ }
  };
  const teardown = (): void => {
    const current = epoch;
    epoch = undefined;
    if (!current) return;
    try { current.unsubscribeReady(); } catch { /* 退订异常不阻断清理 */ }
    if (current.registered) {
      // exact撤销：只携带同scope+同registrationId；owner侧旧unregister不删新注册。
      emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.sourceUnregister, { scope: current.registered.scope, registrationId: current.registered.registrationId, kind: ACTIVITY_KIND });
    }
  };
  return {
    onSessionStart({ mode, sessionManager, sessionId }) {
      teardown(); // 新epoch先撤销旧注册（exact），避免双注册
      if (mode !== 'tui') return; // 统一footer是TUI-only展示；rpc/print/json不发布source
      const identity: HostScopeIdentity = { sessionManager, sessionId, hostKey: sessionManager };
      const registrationId = createBackgroundActivityRegistrationId();
      const source = createBashAsyncActivitySource(controller, deps);
      const handleReady = (data: unknown): void => {
        const current = epoch;
        if (!current || current.registrationId !== registrationId) return; // 旧epoch闭包守卫
        if (!isOwnerReadyPayload(data)) return; // 缺字段fail closed，不猜测payload
        const { scope } = data;
        if (!isSameHostScopeIdentity(scope, identity)) return; // 只回答同Host身份的owner
        current.registered = { scope, registrationId }; // 重复ready复用同registrationId，幂等
        emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.sourceRegister, { scope, registrationId, source });
      };
      let unsubscribeReady: () => void = () => undefined;
      try {
        unsubscribeReady = bus.on(BACKGROUND_ACTIVITY_CHANNELS.ownerReady, handleReady); // 先listen ready
      } catch { /* 订阅失败保持未注册，不报执行failure */ }
      epoch = { identity, registrationId, source, unsubscribeReady, registered: undefined };
      emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.ownerRequest, identity); // 再request：请匹配owner重发ready
    },
    onSessionShutdown() { teardown(); },
  };
}
