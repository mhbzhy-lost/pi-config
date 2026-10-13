import { createLocalBashOperations, type ExtensionAPI, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createBashCwdToolDefinition, prepareBashCwdExecution } from '../bash-cwd/index.ts';
import { createBashAsyncController } from './controller.ts';
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
    description: '后台复用原生 Bash 执行命令，立即返回 jobId 接受回执，不等待命令结束。完成后自动向本会话 followUp 队列投递原生结果。用于测试套件、类型检查、产物构建、含网络请求等长耗时操作；短查询或立即依赖输出的操作使用 bash。仅 TUI/RPC；不提供隔离、跨会话持久化或崩溃后重放。',
    promptSnippet: '异步执行长耗时命令并在完成后自动接收回执',
    promptGuidelines: [
      '启动成功只代表接受任务；以 bash-async-complete 的 outcome/exitCode 判断执行结果。',
      '启动后继续无冲突工作，不 sleep 或轮询等待；同 cwd 并发写入并未隔离。',
      '不得用后台任务绕过命令门禁、凭据、网络或提交授权；不要用于自建 daemon。',
      'print/json 不支持；tree/独立 compaction/reload/switch/退出可能取消任务。clear_queue 可清除已提交的回执且不自动重发。',
    ],
    async execute(toolCallId, request, signal, _onUpdate, ctx) {
      const receipt = await controller.launch(toolCallId, request as BashAsyncRequest, ctx, signal);
      return { content: [{ type: 'text', text: JSON.stringify(receipt) }], details: receipt };
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
