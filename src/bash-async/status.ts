// bash_async_status 的只读状态投影：消费 controller.snapshot() 的权威内存快照，
// 不建立第二任务集合，不取消、不等待、不修改任务，也不返回命令输出全文
// （完整原生输出只存在于 bash-async-complete 完成回执消息中）。
import type { BashAsyncLaunchReceipt, BashAsyncTerminalReceipt } from './contracts.ts';

export type BashAsyncActiveSummary = {
  jobId: string; toolCallId: string; command: string; cwd: string; acceptedAt: string;
};
export type BashAsyncCompletedSummary = BashAsyncActiveSummary & {
  outcome: BashAsyncTerminalReceipt['outcome']; exitCode?: number; elapsedMs: number;
  completionDelivery: BashAsyncTerminalReceipt['completionDelivery']; deliveryError?: string;
};
export type BashAsyncStatusReport = {
  /** 本会话当前活跃（已接受、未收束）任务总数；始终是全局计数，不受 jobId 过滤影响。 */
  activeCount: number;
  /** 已收束归档条数（controller 只保留最近 64 条）；始终是全局计数。 */
  completedCount: number;
  active: BashAsyncActiveSummary[];
  completed: BashAsyncCompletedSummary[];
  /** 仅当调用方传入 jobId 时出现：过滤条件与该 jobId 是否命中。 */
  jobId?: string;
  found?: boolean;
};

function activeSummary(receipt: Pick<BashAsyncLaunchReceipt, 'jobId' | 'toolCallId' | 'command' | 'cwd' | 'acceptedAt'>): BashAsyncActiveSummary {
  return { jobId: receipt.jobId, toolCallId: receipt.toolCallId, command: receipt.command, cwd: receipt.cwd, acceptedAt: receipt.acceptedAt };
}
function completedSummary(receipt: BashAsyncTerminalReceipt): BashAsyncCompletedSummary {
  return {
    ...activeSummary(receipt), outcome: receipt.outcome,
    ...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
    elapsedMs: receipt.elapsedMs, completionDelivery: receipt.completionDelivery,
    ...(receipt.deliveryError !== undefined ? { deliveryError: receipt.deliveryError } : {}),
  };
}

export function createBashAsyncStatusResult(
  snapshot: { active: BashAsyncLaunchReceipt[]; completed: BashAsyncTerminalReceipt[] },
  jobId?: string,
): { content: [{ type: 'text'; text: string }]; details: BashAsyncStatusReport } {
  const active = snapshot.active.map(activeSummary);
  const completed = snapshot.completed.map(completedSummary);
  const report: BashAsyncStatusReport = {
    activeCount: active.length, completedCount: completed.length,
    active: jobId ? active.filter(job => job.jobId === jobId) : active,
    completed: jobId ? completed.filter(job => job.jobId === jobId) : completed,
    ...(jobId ? { jobId, found: active.some(job => job.jobId === jobId) || completed.some(job => job.jobId === jobId) } : {}),
  };
  const header = `本会话 bash_async 状态：活跃 ${report.activeCount} 个，已收束归档 ${report.completedCount} 个（归档最多保留最近 64 条）。`
    + (jobId ? (report.found ? `jobId ${jobId} 已命中，详见 JSON。` : `未找到 jobId ${jobId}：可能不属于本会话，或已超出归档上限。`) : '')
    + '命令输出全文不在本结果中，以 bash-async-complete 完成回执为准。';
  return { content: [{ type: 'text', text: `${header}\n${JSON.stringify(report)}` }], details: report };
}
