import { createLocalBashOperations, type ExtensionAPI, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createBashCwdToolDefinition, prepareBashCwdExecution } from '../bash-cwd/index.ts';
import { createBashAsyncController } from './controller.ts';
import type { BashAsyncController, BashAsyncLaunchReceipt, BashAsyncTerminalReceipt } from './contracts.ts';
import type { BashAsyncRequest, ExecutionEvidence } from './contracts.ts';
import { createBashActivitySource } from '../tui/feature-sources.ts';
import { registerActivitySource } from '../tui/background-activity.ts';
export * from './contracts.ts';
export { createBashAsyncController } from './controller.ts';
export { createBashAsyncCompleteRenderer, type BashAsyncRendererDeps } from './renderer.ts';

export function registerBashAsyncActivitySource(pi: ExtensionAPI, controller: BashAsyncController): () => void {
  return registerActivitySource(pi, 'bash_async', createBashActivitySource(controller));
}

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
      'bash_async 启动成功只代表接受任务；以 bash-async-complete 的 outcome/exitCode 判断执行结果。',
      'bash_async 接受回执后立即继续其他无冲突工作；没有独立工作就结束当前回合，完成时自动投 followUp 唤醒。正例：启动 e2e 测试后转去处理无关文件或直接结束回合；反例：bash_async 启动构建后紧跟 bash "sleep 60" 干等、反复轮询任务状态、或另起阻塞命令纯粹等结果。同 cwd 并发写入并未隔离。',
      '不得用 bash_async 绕过命令门禁、凭据、网络或提交授权；不要用于自建 daemon，也不要用 bash_async 跑 sleep/wait 循环变相等待或当延时器。例外边界：真实命令内部的 retry/backoff、测试自身的模拟延迟、用户任务里明确要求的 delay 都按任务照常执行，不属于禁止项；用户提出的未来某时刻或重复执行的任务用 scheduler_create，不得自行提交定时器。',
      // S5：只限定 clear_queue 的主体——它是 Host/RPC 控制面操作，不是 bash_async 可传参数；
      // 其余 Host/RPC 事实与 sleep 合法载荷（retry/backoff/测试模拟延迟/用户 delay）例外合同逐字保留。
      'bash_async 不支持 print/json；tree/独立 compaction/reload/switch/退出可能取消任务。clear_queue 是 Host/RPC 侧操作、不是 bash_async 参数，可清除已提交的回执且不自动重发。',
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
