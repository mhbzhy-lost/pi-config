export type RuntimeIdentity = {
  runId: string;
  ownerGeneration?: number;
  liveRunEpoch?: number;
  running: boolean;
  steerable: boolean;
};

/**
 * 将 0.71 status RPC 的原始投影转换为控制面身份事实。
 * async runs 的状态位于 asyncSnapshot.runs，而非 status.details.state。
 */
export function runtimeFromStatus(runId: string, status: any): RuntimeIdentity {
  const details = status?.details ?? status ?? {};
  const projected = status?.asyncSnapshot?.runs?.find((run: any) => run?.id === runId);
  const state = typeof details.state === "string" ? details.state : projected?.state;
  const running = state === "running" || details.running === true;
  const steerable = typeof details.steerable === "boolean" ? details.steerable : running;
  return {
    runId,
    ...(Number.isSafeInteger(details.ownerGeneration) ? { ownerGeneration: details.ownerGeneration } : {}),
    ...(Number.isSafeInteger(details.liveRunEpoch) ? { liveRunEpoch: details.liveRunEpoch } : {}),
    running,
    steerable,
  };
}
