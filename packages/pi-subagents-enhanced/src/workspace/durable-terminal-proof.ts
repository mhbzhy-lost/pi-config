import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseProcessTerminal, terminalProofId } from "../subagent-dispatch/root-broker-protocol.ts";

/**
 * durable 终局事实到 7 字段 terminal proof 的唯一解析入口。
 *
 * 背景（审计 #9 / P3）：Host 侧 status 的 terminalProofProvider 解析 broker 的
 * 异步事实，而 coordinator 侧只有 durable ledger record，于是同一 run 的
 * 「证明是否可观察」出现两个权威视角：status 说 release 可用、coordinator 侧
 * release 拒绝。这里把 durable 事实（run.asyncDir 下官方 process-terminal.json）
 * 收敛成与 broker 完全同形的 proof（同一 terminalProofId 算法、同一
 * parseProcessTerminal 文法），供 coordinator 的 workspace service 消费。
 *
 * fail-closed 语义：文件缺失、非规范文件、身份与 record.run 不一致、非
 * observed、或 proofId 无法复算时一律返回 undefined，调用方保持原有拒绝路径，
 * 绝不用「无法确认」推断出「已观察」。
 */

type DurableRun = { runId?: unknown; asyncDir?: unknown } | null | undefined;

function safeStat(stat: ReturnType<typeof lstatSync>) {
  const mode = Number(stat.mode) & 0o777;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (mode !== 0o600 && mode !== 0o644)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("durable terminal artifact is unsafe");
  }
}

/** 与 Root Broker 的 readOfficialTerminalArtifact 同一安全边界，同步形态。 */
function readOfficialTerminalArtifact(asyncDir: string) {
  const file = path.join(asyncDir, "process-terminal.json");
  const before = lstatSync(file);
  safeStat(before);
  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  let opened: ReturnType<typeof fstatSync>;
  try {
    opened = fstatSync(descriptor);
    safeStat(opened);
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(file);
  safeStat(after);
  if (before.dev !== opened.dev || before.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino
      || opened.size !== bytes.length) {
    throw new Error("durable terminal artifact changed while reading");
  }
  return JSON.parse(bytes.toString("utf8"));
}

export function readDurableObservedTerminalProof(input: { run?: DurableRun; rootSessionId?: unknown; onDiagnostic?: (entry: unknown) => void } = {}) {
  // INV-EXIT（矩阵 #9）：本函数是 coordinator 侧「证明是否可观察」的唯一解析入口，
  // 每个 fail-closed 返回都必须能被归因（reason）并给出 next，否则 coordinator 侧的
  // release/integration 拒绝会再次变成「说不行、不说去哪」。诊断只走调用方的
  // diagnosticSink，不改任何解析判定。
  const unresolved = (reason: string, next: string, detail: Record<string, unknown> = {}) => {
    try { input.onDiagnostic?.({ version: 1, phase: "durable-terminal-proof-unresolved", reason, next, ...detail }); }
    catch (diagnosticError) { console.error("[durable-terminal-proof] diagnostic sink failed", diagnosticError); }
    return undefined;
  };
  const record = (run: DurableRun) => ({ runId: (run as any)?.runId, asyncDir: (run as any)?.asyncDir });
  const run = input.run;
  if (!run || typeof run.runId !== "string" || !run.runId) {
    return unresolved("durable-run-identity-unavailable", "workspace record 缺 runId：先用 workspace status/审计核对记录，再重试 release；不要用别的 run 的证明代替。", record(run));
  }
  if (typeof run.asyncDir !== "string" || !path.isAbsolute(run.asyncDir)) {
    return unresolved("durable-run-asyncdir-unavailable", "workspace record 的 run.asyncDir 不是绝对路径：核对 ledger 记录与派发绑定；证明链不可达时按阻断上报，不要手工补路径。", record(run));
  }
  if (typeof input.rootSessionId !== "string" || !input.rootSessionId) {
    return unresolved("durable-owner-scope-unavailable", "owner scope 不可用：先按 workspace 记录的 owner.rootSessionId 重新发起（owner 身份只来自 runtime），不要用当前会话身份猜测。", record(run));
  }
  let value: any;
  try { value = readOfficialTerminalArtifact(run.asyncDir); }
  catch (error) {
    return unresolved("durable-artifact-unreadable", "run.asyncDir 下没有可安全读取的官方 process-terminal.json：确认 child 已终止并产出终局制品，然后重跑 coordinator 启动对账（reconcileProofDebts/服务 reconcile）；仍缺失按阻断上报并保留现场。", { ...record(run), error: error instanceof Error ? error.message : String(error) });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return unresolved("durable-artifact-shape-invalid", "process-terminal.json 形状非法：按数据损坏上报并保留原文件现场，不要改写制品或伪造证明。", record(run));
  }
  const { runId, ...terminal } = value;
  // 身份核对：官方制品自述的 runId 必须就是 ledger record 绑定的 run。
  if (runId !== run.runId) {
    return unresolved("durable-artifact-run-mismatch", "制品自述 runId 与 workspace 绑定的 run 不一致：确认证明来源后按阻断上报，跨 run 的证明不得用于该 workspace。", { ...record(run), artifactRunId: runId });
  }
  try { parseProcessTerminal(terminal); }
  catch (error) {
    return unresolved("durable-terminal-invalid", "官方终局事实不符合 parseProcessTerminal 文法：按数据损坏上报并保留制品现场，不要放宽文法。", { ...record(run), error: error instanceof Error ? error.message : String(error) });
  }
  if (terminal.state !== "observed") {
    return unresolved("durable-terminal-not-observed", `终局事实尚未 observed（当前 state=${String(terminal.state)}）：等 child 真正终止后再重试，或先 preserve 后人工处置；不要用 pending/中间态证明换取 release。`, { ...record(run), state: terminal.state });
  }
  return {
    state: "observed" as const,
    conflict: false,
    runId,
    rootSessionId: input.rootSessionId,
    asyncDir: run.asyncDir,
    // 与 broker.recordTerminalProof 的构造一致：runnerProcessInstanceId 是官方
    // 制品里的进程实例身份，不接受 record 或调用方自报的 pid。
    processInstance: terminal.runnerProcessInstanceId,
    // 与 broker 接受的官方证明同一身份算法（含 runId 的完整制品）。
    proofId: terminalProofId(value),
  };
}
