// bash_async 完成回执的独立只读投影：折叠态对齐仓库统一回执样式
// （dim、无框、Text padding 1/0，与 subagent 可见 completion 一致），
// 展开态按 SDK {expanded, outputPad} 显示原始 content 文本块与原生输出。
// 只读消费 message 与 typed details 做显示；不改写 raw payload，
// 不参与发送、执行、取消链路，不把 launch/delivery/空输出当成命令终态成功。
import type { MessageRenderOptions, MessageRenderer, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import type { BashAsyncOutcome, BashAsyncTerminalReceipt } from './contracts.ts';

/** Host 入口注入的 TUI 能力；本 feature src 不直接依赖 pi-tui 运行时。 */
export type BashAsyncRendererDeps = {
  Text: new (text?: string, paddingX?: number, paddingY?: number) => Component;
  truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string;
};

type CompletionMessage = Parameters<MessageRenderer>[0];

// outcome 枚举以 contracts.ts 的 typed contract 为准；集合/映射的键覆盖由类型参数在编译期校验。
const FAILURE_OUTCOMES: ReadonlySet<BashAsyncOutcome> = new Set<BashAsyncOutcome>(['failed', 'timed-out', 'aborted', 'spawn-error', 'execution-error']);
const OUTCOME_MARKS: Record<BashAsyncOutcome, string> = {
  succeeded: '✓',
  failed: '✗',
  'timed-out': '✗',
  aborted: '✗',
  'spawn-error': '✗',
  'execution-error': '✗',
};
const TOOL_TITLE = 'bash_async';
const COMMAND_PREVIEW_WIDTH = 48;
const REASON_PREVIEW_WIDTH = 64;
const SHORT_JOB_LENGTH = 8;
// 与原生 status 行（ThemedText(…,1,0)）及 subagent 可见回执左缘对齐。
const FOLDED_PADDING_X = 1;

function isTerminalReceipt(value: unknown): value is BashAsyncTerminalReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'bash-async-complete' && typeof record.outcome === 'string' && record.outcome.length > 0;
}

function shortJob(jobId: unknown): string {
  return typeof jobId === 'string' && jobId ? jobId.slice(0, SHORT_JOB_LENGTH) : '';
}

function previewCommand(command: unknown, truncate: BashAsyncRendererDeps['truncateToWidth']): string {
  if (typeof command !== 'string') return '';
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat ? truncate(flat, COMMAND_PREVIEW_WIDTH, '…') : '';
}

function formatElapsed(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(1))}s`;
  const totalSeconds = Math.round(ms / 1_000);
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`;
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
    return { text: `· ${TOOL_TITLE} 完成回执 · 详情未识别（展开查看原文）`, failed: false };
  }
  const outcome = receipt.outcome;
  const known = outcome === 'succeeded' || FAILURE_OUTCOMES.has(outcome);
  const mark = outcome === 'succeeded' ? OUTCOME_MARKS.succeeded : FAILURE_OUTCOMES.has(outcome) ? OUTCOME_MARKS[outcome] : '·';
  const segments = [
    [TOOL_TITLE, shortJob(receipt.jobId)].filter(Boolean).join(' '),
    previewCommand(receipt.command, truncate),
    known ? outcome : `${outcome}（未识别的终态）`,
  ].filter(segment => segment.length > 0);
  if (typeof receipt.exitCode === 'number') segments.push(`exit ${receipt.exitCode}`);
  const elapsed = formatElapsed(receipt.elapsedMs);
  if (elapsed) segments.push(elapsed);
  const failed = FAILURE_OUTCOMES.has(outcome);
  const lines = [`${mark} ${segments.join(' · ')}`];
  // 失败原因必须可见：error 形态输出的首行原因截断后跟随回执，原生输出全文仍在展开/raw。
  const reason = failed ? failureReason(receipt, truncate) : '';
  if (reason) lines.push(`error: ${reason}`);
  return { text: lines.join('\n'), failed };
}

function rawTextBlocks(content: CompletionMessage['content']): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
      && (block as { text: string }).text.length > 0)
    .map(block => (block as { text: string }).text);
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
      const expanded = blocks.length > 0 ? [text, '', ...blocks].join('\n') : text;
      // 展开态遵循 SDK outputPad（防非整数触发 Text repeat 异常）；原文仅做视觉换行不改写。
      return new Text(theme.fg(failed ? 'error' : 'dim', expanded), Math.max(0, Math.floor(options.outputPad ?? 1)), 0);
    }
    return new Text(theme.fg(failed ? 'error' : 'dim', text), FOLDED_PADDING_X, 0);
  };
}
