import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';

export type BashAsyncRequest = { command: string; timeout?: number; cwd?: string };
export type BashAsyncLaunchReceipt = {
  kind: 'bash-async-launch'; jobId: string; toolCallId: string; sessionId: string;
  generation: number; branchEpoch: number; command: string; cwd: string; acceptedAt: string;
};
export type BashAsyncOutcome = 'succeeded' | 'failed' | 'timed-out' | 'aborted' | 'spawn-error' | 'execution-error';
export type Delivery = 'attempted' | 'accepted' | 'suppressed-stale' | 'suppressed-shutdown' | 'suppressed-unsafe-context' | 'delivery-error';
export type NativeResult = AgentToolResult<unknown> & { structuredContent?: Record<string, unknown>; isError?: boolean };
export type BashAsyncTerminalReceipt = Omit<BashAsyncLaunchReceipt, 'kind'> & {
  kind: 'bash-async-complete'; outcome: BashAsyncOutcome; exitCode?: number;
  elapsedMs: number; output: NativeResult | { error: { name: string; message: string } };
  completionDelivery: Delivery; deliveryError?: string;
};
export type ExecutionEvidence = { exitCode?: number | null; backendError?: unknown };
export type PreparedExecution = {
  cwd: string;
  execute(toolCallId: string, request: BashAsyncRequest, signal: AbortSignal): Promise<NativeResult>;
  evidence: ExecutionEvidence;
};
export type BashAsyncController = {
  start(sessionId: string): Promise<void>;
  launch(toolCallId: string, request: BashAsyncRequest, context: ExtensionToolContext, signal?: AbortSignal): Promise<BashAsyncLaunchReceipt>;
  cancel(jobId: string): Promise<{ jobId: string; accepted: boolean }>;
  cancelAll(): Promise<void>;
  invalidateBranch(): Promise<void>;
  shutdown(reason: string): Promise<void>;
  snapshot(): { active: BashAsyncLaunchReceipt[]; completed: BashAsyncTerminalReceipt[] };
};
