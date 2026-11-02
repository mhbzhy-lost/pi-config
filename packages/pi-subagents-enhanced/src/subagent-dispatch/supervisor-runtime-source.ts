/**
 * supervisor steer 门的 runtime 双源判定（readRuntime 第二判定源）。
 *
 * 背景（2026-11-01 生产事故）：主判定源只依赖上游 rpc.status 的 asyncSnapshot 投影，
 * 而该投影的 session-guard 在会话身份分歧时整体返回空快照（且 enhanced host 的
 * lastUiContext 刷新通道收窄），导致 running 中的 typed workflow leaf 被主链判为
 * 非 running，steer 门以 SUPERVISOR_STEER_NOT_ALLOWED 误拒。
 *
 * 双源语义（与上游对齐）：
 * - 主链判 running：原样返回，零行为变化，第二源不介入；
 * - 主链判非 running 时区分两类：
 *   1) 「显式终态」：rpc.status 成功且 details.state / 快照投影 state 为非 running
 *      字符串（complete/failed 等）——上游链明确判出终态，不经 broker 覆盖；
 *   2) 「缺源」：rpc.status 抛错/返回空，或 runtimeFromStatus 判 running=false 且
 *      无显式 state（判定依据是「证据缺席」而非「证据否定」）——此时用 broker 的
 *      生命周期登记（observeStarted 登记 + terminal proof）做二次判定；
 * - broker 视图按 running 处理的充分条件：run 在 broker 登记在册（owned/facade 均可）
 *   且无 observed terminal proof 且无 terminalConflict。terminal proof 是 broker 唯一
 *   权威终局事实：没有它就不得猜测性推断「已 complete」，与上游 steerable 默认=running
 *   的语义同构；paused/interrupt 等中间态不与「无 terminal proof 且主链缺源」组合出现，
 *   缺源场景按 running 处理即对齐上游语义。
 * - owner receipt 读取失败时现状返回 undefined 的语义不放宽：该失败不阻止第二源按
 *   在册事实放行 running，但 ownerGeneration 读不到就不合并，控制面自有围栏继续 fail-closed。
 *
 * 诊断：凡「走第二源」或「最终仍判非 running」的 readRuntime 调用，各落一条
 * supervisor-runtime-source-divergence 诊断（既有 diagnosticSink 条目格式，白名单字段，
 * 不含凭据或消息正文），使下一次 SUPERVISOR_STEER_NOT_ALLOWED 可归因。
 */
import type { RootBrokerServer } from "./root-broker-server.ts";
import { runtimeFromStatus } from "./runtime-state.ts";

/** broker 生命周期视图：登记态 + terminal 观察态（只读投影，不含凭据与消息正文）。 */
export type BrokerLifecycleView = {
  /** owned=授权在册；facade=observeStarted 登记的 facade 投影；none=未登记；unavailable=broker 不可用。 */
  registration: "owned" | "facade" | "none" | "unavailable";
  /** 是否已接受 official terminal proof（broker 唯一权威终局事实）。 */
  terminal: "observed" | "none";
  terminalConflict: boolean;
};

/** 主判定源摘要（诊断白名单字段；不含凭据或消息正文）。 */
export type PrimarySourceSummary = {
  /** rpc.status 是否成功取得（false = rpc.status 抛错，主链未产出判定）。 */
  statusOk: boolean;
  /** runtimeFromStatus 判定结果（主链未产出时为 undefined）。 */
  running: boolean | undefined;
  steerable: boolean | undefined;
  /** 显式 state（details.state 优先，其次快照投影 state；缺源时为 null）。 */
  explicitState: string | null;
  /** asyncSnapshot.runs 数量（快照缺失/为空时为 0；session-guard 分歧时整体为空）。 */
  snapshotRunCount: number;
  /** 目标 run 是否出现在快照投影中。 */
  projected: boolean;
};

export type RuntimeSourceDecision = {
  runtime: Record<string, unknown> | undefined;
  resolvedBy: "primary" | "broker" | null;
  primary: PrimarySourceSummary;
  brokerView: BrokerLifecycleView;
};

export type SupervisorRuntimeReaderDeps = {
  /** broker 就绪标志（getter 以兼容 host 内可变状态）。 */
  brokerReady: () => boolean;
  broker: () => RootBrokerServer | undefined;
  /** 上游 0.71 typed rpc 的 status 查询（与既有 readRuntime 同源）。 */
  status: (args: { id: string }) => Promise<any>;
  /** 既有 diagnosticSink（dispatch trace 同通道）；getter 以兼容延迟装配。 */
  diagnosticSink?: () => (((entry: unknown) => void) & { dispose?: () => void }) | undefined;
};

/**
 * broker 只读生命周期投影：组合既有导出面 inspectExecutionProof（owned）/
 * inspectFacadeTerminalProof（facade），不新增 broker 写面、不改任何登记状态。
 */
export function brokerLifecycleView(broker: RootBrokerServer | undefined, runId: string): BrokerLifecycleView {
  if (!broker) return { registration: "unavailable", terminal: "none", terminalConflict: false };
  const owned = broker.inspectExecutionProof(runId);
  if (owned) {
    return {
      registration: "owned",
      terminal: owned.terminal ? "observed" : "none",
      terminalConflict: owned.terminalConflict === true,
    };
  }
  const facade = broker.inspectFacadeTerminalProof(runId);
  if (facade) {
    return {
      registration: "facade",
      terminal: facade.state === "observed" ? "observed" : "none",
      terminalConflict: facade.conflict === true,
    };
  }
  return { registration: "none", terminal: "none", terminalConflict: false };
}

/**
 * broker 视图是否支持「按 running 处理」：登记在册（owned/facade 均可）且无 observed
 * terminal proof 且无 terminalConflict。没有 terminal proof 时不得做任何猜测性终局推断。
 */
export function brokerViewSaysRunning(view: BrokerLifecycleView): boolean {
  return (view.registration === "owned" || view.registration === "facade")
    && view.terminal !== "observed" && view.terminalConflict !== true;
}

/**
 * 主源「显式终态」判定。state 提取顺序与 runtimeFromStatus 完全一致
 * （details.state 优先，其次快照投影 state）：调用点已保证主链判非 running
 * （state !== "running" 且 details.running !== true），故此处 state 为字符串
 * 即「上游链明确判出非 running 终态」，不是缺源。
 */
export function primaryStatusExplicitTerminal(runId: string, status: any): boolean {
  const details = status?.details ?? status ?? {};
  const projected = status?.asyncSnapshot?.runs?.find((run: any) => run?.id === runId);
  const state = typeof details.state === "string" ? details.state : projected?.state;
  return typeof state === "string" && state !== "running";
}

/** 主判定源结果摘要（供诊断落盘；仅白名单字段）。 */
export function summarizePrimarySource(runId: string, status: any, runtime: { running?: boolean; steerable?: boolean } | undefined): PrimarySourceSummary {
  const details = status?.details ?? status ?? {};
  const projected = status?.asyncSnapshot?.runs?.find((run: any) => run?.id === runId);
  const state = typeof details.state === "string" ? details.state : projected?.state;
  return {
    statusOk: status !== undefined,
    running: runtime?.running,
    steerable: runtime?.steerable,
    explicitState: typeof state === "string" ? state : null,
    snapshotRunCount: Array.isArray(status?.asyncSnapshot?.runs) ? status.asyncSnapshot.runs.length : 0,
    projected: !!projected,
  };
}

/**
 * 构造 supervisor 控制面的 readRuntime（双源判定版）。
 * 与既有内联实现的行为差异只有两类，其余逐分支保持原语义：
 * 1) 主链缺源且 broker 在册无 terminal proof 时按 running 处理（本修复目标）；
 * 2) 「走第二源或最终仍判非 running」路径补 supervisor-runtime-source-divergence 诊断。
 */
export function createSupervisorRuntimeReader({ brokerReady, broker, status: readStatus, diagnosticSink }: SupervisorRuntimeReaderDeps) {
  const emitDivergence = (entry: Record<string, unknown>) => {
    try { diagnosticSink?.()?.({ version: 1, phase: "supervisor-runtime-source-divergence", ...entry }); }
    catch (diagnosticError) { console.error("[subagent-runtime] supervisor runtime divergence diagnostic sink failed", diagnosticError); }
  };
  const errorSummary = (error: unknown) => ({ code: (error as any)?.code ?? null, message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
  // 与既有 readRuntime 完全一致的 ownerGeneration 合并语义。
  const mergeOwnerGeneration = (owner: any) => ({ ...(owner?.ownerGeneration !== undefined ? { ownerGeneration: owner.ownerGeneration } : {}) });
  return async function readRuntime(runId: string): Promise<Record<string, unknown> | undefined> {
    if (!brokerReady()) return undefined;
    let status: any;
    try {
      status = await readStatus({ id: runId });
      const owner = broker() ? await broker()!.readOwnerReceipt(runId) : undefined;
      const runtime = runtimeFromStatus(runId, status);
      // 现有链判 running：原样返回，零行为变化（第二源不介入、不落诊断）。
      if (runtime.running) {
        return { ...runtime, ...mergeOwnerGeneration(owner) };
      }
      const primary = summarizePrimarySource(runId, status, runtime);
      if (primaryStatusExplicitTerminal(runId, status)) {
        // 上游链明确判出终态：不经 broker 覆盖，维持现有返回；落诊断便于拒绝归因。
        emitDivergence({ runId, primarySource: primary, brokerView: brokerLifecycleView(broker(), runId), resolvedBy: "primary" });
        return { ...runtime, ...mergeOwnerGeneration(owner) };
      }
      // 缺源场景：主链判非 running 只是「证据缺席」。broker 登记在册且无 terminal
      // proof 时按 running 处理；否则维持现有返回。
      const view = brokerLifecycleView(broker(), runId);
      if (brokerViewSaysRunning(view)) {
        emitDivergence({ runId, primarySource: primary, brokerView: view, resolvedBy: "broker" });
        return { runId, running: true, steerable: true, ...mergeOwnerGeneration(owner) };
      }
      emitDivergence({ runId, primarySource: primary, brokerView: view, resolvedBy: null });
      return { ...runtime, ...mergeOwnerGeneration(owner) };
    } catch (error) {
      // 现状语义保持：rpc.status 抛错或 owner receipt 读取失败时返回 undefined，不放宽。
      // 仅当缺源发生在 rpc.status（status 未成功取得）且 broker 登记在册且无 terminal
      // proof 时，第二判定源才按 running 处理；ownerGeneration 读不到就不合并，
      // 控制面 owner 围栏（SUPERVISOR_STALE_OWNER/OWNER_UNAVAILABLE）继续 fail-closed。
      const currentBroker = broker();
      const view = brokerLifecycleView(currentBroker, runId);
      const statusFailed = status === undefined;
      if (statusFailed && brokerViewSaysRunning(view)) {
        let ownerGeneration: number | undefined;
        try { ownerGeneration = currentBroker ? (await currentBroker.readOwnerReceipt(runId))?.ownerGeneration : undefined; }
        catch { /* 与现状一致：owner 读不到不伪造，只放弃合并。 */ }
        emitDivergence({ runId, primarySource: { statusOk: false, running: undefined, steerable: undefined, explicitState: null, snapshotRunCount: 0, projected: false, error: errorSummary(error) }, brokerView: view, resolvedBy: "broker" });
        return { runId, running: true, steerable: true, ...(ownerGeneration !== undefined ? { ownerGeneration } : {}) };
      }
      emitDivergence({
        runId,
        primarySource: { ...summarizePrimarySource(runId, status, undefined), error: errorSummary(error), failedAt: statusFailed ? "rpc.status" : "readOwnerReceipt" },
        brokerView: view,
        resolvedBy: null,
      });
      if (process.env.T11B1_DEBUG === "1") console.error(`[t11b1-debug] runtime-read error=${error instanceof Error ? error.message : String(error)} runId=${runId}`);
      return undefined;
    }
  };
}
