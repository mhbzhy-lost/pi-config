// bash_async 完成回执的独立只读投影：折叠态对齐仓库统一回执样式
// （dim、无框、Text padding 1/0，与 subagent 可见 completion 一致），
// 展开态按 SDK {expanded, outputPad} 显示原始 content 文本块与原生输出。
// 只读消费 message 与 typed details 做显示；不改写 raw payload，
// 不参与发送、执行、取消链路，不把 launch/delivery/空输出当成命令终态成功。
import type { MessageRenderOptions, MessageRenderer, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import type { BashAsyncOutcome, BashAsyncTerminalReceipt } from './contracts.ts';
import { formatStandardReceipt } from '../async-receipt/format.ts';

/** Host 入口注入的 TUI 能力；本 feature src 不直接依赖 pi-tui 运行时。 */
export type BashAsyncRendererDeps = {
  Text: new (text?: string, paddingX?: number, paddingY?: number) => Component;
  truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string;
};

type CompletionMessage = Parameters<MessageRenderer>[0];

// outcome 枚举以 contracts.ts 的 typed contract 为准；集合/映射的键覆盖由类型参数在编译期校验。
const FAILURE_OUTCOMES: ReadonlySet<BashAsyncOutcome> = new Set<BashAsyncOutcome>(['failed', 'timed-out', 'aborted', 'spawn-error', 'execution-error']);
const TOOL_TITLE = 'bash_async';
const COMMAND_PREVIEW_WIDTH = 48;
const REASON_PREVIEW_WIDTH = 64;
// 与原生 status 行（ThemedText(…,1,0)）及 subagent 可见回执左缘对齐。
const FOLDED_PADDING_X = 1;

function isTerminalReceipt(value: unknown): value is BashAsyncTerminalReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'bash-async-complete' && typeof record.outcome === 'string' && record.outcome.length > 0;
}

function previewCommand(command: unknown, truncate: BashAsyncRendererDeps['truncateToWidth']): string {
  if (typeof command !== 'string') return '';
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat ? truncate(flat, COMMAND_PREVIEW_WIDTH, '…') : '';
}

function failureReason(receipt: BashAsyncTerminalReceipt, truncate: BashAsyncRendererDeps['truncateToWidth']): string {
  const output = receipt.output as unknown;
  if (typeof output !== 'object' || output === null || !('error' in output)) return '';
  const message = (output as { error?: { message?: unknown } }).error?.message;
  if (typeof message !== 'string') return '';
  const firstLine = message.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
  return firstLine ? truncate(firstLine, REASON_PREVIEW_WIDTH, '…') : '';
}

function foldedProjection(receipt: BashAsyncTerminalReceipt | undefined, truncate: BashAsyncRendererDeps['truncateToWidth']): { text: string; failed: boolean } {
  if (!receipt) {
    // 详情结构未识别：中性保留可见信息，不猜测成功；原文完整保存在 content，可展开查看。
    return { text: `✗ ${TOOL_TITLE} 完成回执 · 详情未识别（展开查看原文）`, failed: true };
  }
  const outcome = FAILURE_OUTCOMES.has(receipt.outcome) || receipt.outcome === 'succeeded'
    ? receipt.outcome
    : `${receipt.outcome}（未识别的终态）`;
  return formatStandardReceipt({
    toolTitle: TOOL_TITLE,
    id: receipt.jobId,
    preview: previewCommand(receipt.command, truncate),
    outcome,
    exitCode: receipt.exitCode,
    elapsedMs: receipt.elapsedMs,
    failureReason: failureReason(receipt, truncate),
  }, truncate);
}

function rawTextBlocks(content: CompletionMessage['content']): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.map(block => {
    if (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      const record = block as unknown as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.every(key => key === 'type' || key === 'text')) return record.text as string;
      return `${record.text as string}\ncontentBlock:\n${JSON.stringify(block, null, 2)}`;
    }
    const serialized = JSON.stringify(block, null, 2);
    return serialized === undefined ? String(block) : serialized;
  });
}

/**
 * 创建 bash-async-complete 的 MessageRenderer：
 * 折叠态输出统一 dim 回执（失败用 error 色保持清晰可见），
 * 展开态附原始文本块；终态只读 typed details 的 outcome/exitCode/elapsedMs。
 */
export function createBashAsyncCompleteRenderer({ Text, truncateToWidth }: BashAsyncRendererDeps): MessageRenderer {
  return (message, options: MessageRenderOptions, theme: Theme): Component | undefined => {
    if (!message) return undefined;
    const receipt = isTerminalReceipt(message.details) ? message.details : undefined;
    const { text, failed } = foldedProjection(receipt, truncateToWidth);
    if (options.expanded) {
      const blocks = rawTextBlocks(message.content);
      const details = message.details === undefined ? [] : [`details:\n${JSON.stringify(message.details, null, 2)}`];
      const structuredContent = (message as CompletionMessage & { structuredContent?: unknown }).structuredContent;
      const structured = structuredContent === undefined ? [] : [`structuredContent:\n${JSON.stringify(structuredContent, null, 2)}`];
      const expanded = [text, ...blocks, ...details, ...structured].join('\n\n');
      // 展开态遵循 SDK outputPad（防非整数触发 Text repeat 异常）；原文仅做视觉换行不改写。
      return new Text(theme.fg(failed ? 'error' : 'dim', expanded), Math.max(0, Math.floor(options.outputPad ?? 1)), 0);
    }
    return new Text(theme.fg(failed ? 'error' : 'dim', text), FOLDED_PADDING_X, 0);
  };
}
