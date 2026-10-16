// 统一后台活动 scheduler source 与同 Host TUI publisher（统一执行计划 F4b / footer 子计划 T4b）。
//
// 本模块只消费 F4a 交付的 scheduler 只读 observer（`registerTaskSchedulerAdapter` 返回值，
// 公开面见 ./index.ts）：snapshot 是 observer 缓存的纯投影，subscribe 只转发失效通知，
// detail 只经 `observer.detail(id)` 受控结局。世代 token 只存在于 adapter 闭包内部，
// 本模块不接触、不持有、不拼装 token。
// 协议经 package 公开出口 bare specifier `pi-subagents-enhanced/tui/background-activity`
// 消费（F1），不深引 package 内部文件；publisher 握手能力模式参考 F3 bash_async 的公开
// 入口（src/bash-async/index.ts），不复用其内部实现。
//
// 边界：不新增 timer/轮询、不读写任务 store 文件、不反解析有界 JSON、不发送消息、
// 不触发任务动作（create/delete/run-now）；availability 与 observedAt 原样透传，
// 不做跨 Host 新鲜度升级；observer raw 记录只读不写回，ANSI/control 清理归 renderer。

import { Text } from "@earendil-works/pi-tui";
import {
  BACKGROUND_ACTIVITY_CHANNELS,
  createBackgroundActivityRegistrationId,
  isHostScope,
  isSameHostScopeIdentity,
} from "pi-subagents-enhanced/tui/background-activity";
import type {
  ActivityKind,
  ActivityPlacement,
  ActivityRow,
  ActivitySnapshot,
  ActivitySource,
  DetailComponent,
  DetailRequest,
  HostScope,
  HostScopeIdentity,
  OwnerReadyPayload,
} from "pi-subagents-enhanced/tui/background-activity";
import type { SchedulerActivityObserver, SchedulerActivityRecord, SchedulerDetailOutcome } from "./adapter.ts";

const ACTIVITY_KIND: ActivityKind = "scheduler";
const ACTIVITY_KEY_PREFIX = "scheduler:";

// footer 计划状态词表（footer 计划「状态样例」+ F4g R2 §4.5 投影）：观察事实直译，
// 不做语义升级——running 仅表示该次查询观察到投递中，success 是 runner 投递结果
// 而非业务完成，enabled 表示有计划而非模型正在执行。
const STATE_PENDING = "等待触发";
const STATE_RUNNING = "观察到投递中";
const STATE_SUCCESS = "上次投递成功";
const STATE_ERROR = "上次投递失败";
const STATE_DISABLED = "已禁用";

// 受控 get 结果不含可读文本时的固定事实文案（不虚构任务结果、不透出错误原因正文）。
const EMPTY_DETAIL_TEXT = "（受控详情未携带可读文本）";

/** 行 key：kind + 上游任务 id（`scheduler:<id>`），扁平列表无 child index，不按 label 去重。 */
export function schedulerActivityKey(id: string): string {
  return `${ACTIVITY_KEY_PREFIX}${id}`;
}

/** 从 row key 反解受控 get 所需的精确任务 id；前缀不符或空 id 一律拒绝，不猜测。 */
function parseSchedulerActivityKey(key: string): string | undefined {
  if (typeof key !== "string" || !key.startsWith(ACTIVITY_KEY_PREFIX)) return undefined;
  const id = key.slice(ACTIVITY_KEY_PREFIX.length);
  return id ? id : undefined;
}

/** 行 label：完整 name（截断归 renderer），无 name 回退「type schedule」。 */
function schedulerActivityLabel(record: SchedulerActivityRecord): string {
  if (typeof record.name === "string" && record.name) return record.name;
  return `${record.type} ${record.schedule}`;
}

/** 行状态文案：禁用且未观察到投递中显示已禁用；其余按 lastStatus 观察事实投影
 * （lastStatus 类型可选，缺省按 pending=等待首次触发呈现，不做语义升级）。 */
function schedulerStateLabel(record: SchedulerActivityRecord): string {
  if (record.enabled === false && record.lastStatus !== "running") return STATE_DISABLED;
  switch (record.lastStatus) {
    case "running": return STATE_RUNNING;
    case "success": return STATE_SUCCESS;
    case "error": return STATE_ERROR;
    default: return STATE_PENDING;
  }
}

/** 行位置：启用中的计划或观察到投递中的任务进 main；禁用且非投递中只进 recent
 * （recent 历史仅详情可达，等同「只在详情中显示」的布局规则）。 */
function schedulerPlacement(record: SchedulerActivityRecord): ActivityPlacement {
  return record.enabled || record.lastStatus === "running" ? "main" : "recent";
}

/** observer typed records → ActivityRows 纯投影：每条记录生成全新 row 对象（不共享、
 * 不写回 observer raw），上游字段名（lastStatus/enabled/prompt）不得原样进入 rows，
 * 行顺序保持 observer 快照顺序，不因渲染重排。 */
function projectSchedulerRecords(records: readonly SchedulerActivityRecord[]): ActivityRow[] {
  return records.map((record) => ({
    key: schedulerActivityKey(record.id),
    kind: ACTIVITY_KIND,
    label: schedulerActivityLabel(record),
    stateLabel: schedulerStateLabel(record),
    placement: schedulerPlacement(record),
  }));
}

/** 受控 get 结局的 content → 文本行：只挑 text block 原文（含不可信边界头），不反解析
 * 有界 JSON、不读取 store 文件、不把失败原因伪造成结果。 */
function detailTextLines(result: Extract<SchedulerDetailOutcome, { ok: true }>["result"]): string[] {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (
      block && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts;
}

/**
 * 创建 scheduler 只读观察 ActivitySource（统一计划 F4b / footer 计划 T4b 冻结签名）：
 * - snapshot 即时读取 observer 当代缓存：availability/observedAt/errorLabel 原样透传
 *   （stale 携带原 rows/observedAt，unavailable 空 rows），不缓存、不升级跨 Host 新鲜度；
 * - subscribe 只转发 observer 失效通知（缓存已更新，不是刷新请求，不驱动 listing），
 *   订阅/退订异常隔离，不向注册路径传播；
 * - detail 只经 observer.detail(id) 受控 get（同模型侧安全门），ok:false 一律 undefined，
 *   ok:true 用原 AgentToolResult content 的 Text renderer 显示；未命中 key 不复活任务。
 */
export function createSchedulerActivitySource(observer: SchedulerActivityObserver): ActivitySource {
  const snapshot = (): ActivitySnapshot => {
    const observed = observer.snapshot();
    return {
      availability: observed.availability,
      rows: projectSchedulerRecords(observed.records),
      ...(observed.observedAt !== undefined ? { observedAt: observed.observedAt } : {}),
      ...(observed.errorLabel !== undefined ? { errorLabel: observed.errorLabel } : {}),
    };
  };
  const subscribe = (invalidate: () => void): (() => void) => {
    let unsubscribe: () => void;
    try {
      unsubscribe = observer.subscribe(invalidate); // observer 侧已做逐 listener 异常隔离
    } catch {
      return () => undefined; // 订阅失败只损失推送失效，不向注册路径传播
    }
    return () => { try { unsubscribe(); } catch { /* 退订异常不向调用方传播 */ } };
  };
  const detail = async (key: string, _request: DetailRequest): Promise<DetailComponent | undefined> => {
    const taskId = parseSchedulerActivityKey(key);
    if (!taskId) return undefined;
    const outcome = await observer.detail(taskId);
    if (!outcome || outcome.ok !== true) return undefined; // token-stale/no-detail-tool/get-failed 不伪造成结果
    const texts = detailTextLines(outcome.result);
    return new Text(texts.length > 0 ? texts.join("\n") : EMPTY_DETAIL_TEXT, 1, 0);
  };
  return { kind: ACTIVITY_KIND, snapshot, subscribe, detail };
}

/** Host 内存 bus 的最小投影（pi.events 的 on/emit 绑定形状）。 */
export type SchedulerActivityBus = Readonly<{
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}>;

/** session_start 捕获的同 Host 身份：scope = sessionManager + sessionId，捕获后不再读动态 getter。 */
export type SchedulerActivitySession = Readonly<{
  mode: string;
  sessionManager: object;
  sessionId: string;
}>;

/** 同 Host TUI publisher：只负责 source 注册/撤销，不碰任务执行与既有 RPC status。 */
export type SchedulerActivityPublisher = {
  onSessionStart(session: SchedulerActivitySession): void;
  onSessionShutdown(): void;
};

/** 单个 publisher epoch：session_start 捕获的身份、当代 source 与注册身份。 */
interface SchedulerPublisherEpoch {
  readonly identity: HostScopeIdentity;
  readonly registrationId: string;
  readonly source: ActivitySource;
  readonly unsubscribeReady: () => void;
  registered: { scope: HostScope; registrationId: string } | undefined;
}

function isOwnerReadyPayload(value: unknown): value is OwnerReadyPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isHostScope(candidate.scope) && typeof candidate.ownerRegistrationId === "string";
}

/**
 * 创建同 Host TUI publisher：把 scheduler source 注册给统一后台活动 footer owner。
 * - 先 listen owner-ready 再 emit owner-request：owner/publisher 任意加载顺序均可握手；
 * - 只回答 manager/sessionId/hostKey 三要素同时匹配的 ready；重复 ready 复用同
 *   registrationId，幂等；新 session_start 换新 registrationId，旧 epoch 按
 *   同 scope（含 owner token）+ 旧 registrationId exact 撤销；
 * - shutdown 退订 ready 并 exact 撤销最后注册；owner 缺席或 bus 失效不构成执行失败；
 * - RPC/print 模式不发布（adapter 既有 `pi-scheduler` status 保留）。
 */
export function createSchedulerActivityPublisher(observer: SchedulerActivityObserver, bus: SchedulerActivityBus): SchedulerActivityPublisher {
  let epoch: SchedulerPublisherEpoch | undefined;
  const emitOrIgnore = (channel: string, data: unknown): void => {
    try { bus.emit(channel, data); } catch { /* owner 缺席/bus 失效不是 scheduler 执行失败 */ }
  };
  const teardown = (): void => {
    const current = epoch;
    epoch = undefined;
    if (!current) return;
    try { current.unsubscribeReady(); } catch { /* 退订异常不阻断清理 */ }
    if (current.registered) {
      // exact 撤销：只携带同 scope（含 owner token）+ 同 registrationId；旧 unregister 不删新注册。
      emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.sourceUnregister, {
        scope: current.registered.scope,
        registrationId: current.registered.registrationId,
        kind: ACTIVITY_KIND,
      });
    }
  };
  return {
    onSessionStart({ mode, sessionManager, sessionId }) {
      teardown(); // 新 epoch 先 exact 撤销旧注册，避免双注册
      if (mode !== "tui") return; // 统一 footer 是 TUI-only 展示；RPC 保留 adapter 既有 status
      const identity: HostScopeIdentity = { sessionManager, sessionId, hostKey: sessionManager };
      const registrationId = createBackgroundActivityRegistrationId();
      // 当代 source 在 session_start 内创建：adapter 的 session_start handler 先清空
      // listeners 并完成 initial refresh，本 source 由注册方在注册时即时拉取 snapshot
      // 补 initial；不在 start 前长期订阅 observer（会被 session_start 清场）。
      const source = createSchedulerActivitySource(observer);
      const handleReady = (data: unknown): void => {
        const current = epoch;
        if (!current || current.registrationId !== registrationId) return; // 旧 epoch 闭包守卫
        if (!isOwnerReadyPayload(data)) return; // 缺字段 fail closed，不猜测 payload
        const { scope } = data;
        if (!isSameHostScopeIdentity(scope, identity)) return; // 只回答同 Host 身份的 owner
        current.registered = { scope, registrationId }; // 重复 ready 复用同 registrationId，幂等
        emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.sourceRegister, { scope, registrationId, source });
      };
      let unsubscribeReady: () => void = () => undefined;
      try {
        unsubscribeReady = bus.on(BACKGROUND_ACTIVITY_CHANNELS.ownerReady, handleReady); // 先 listen ready
      } catch { /* 订阅失败保持未注册，不报执行 failure */ }
      epoch = { identity, registrationId, source, unsubscribeReady, registered: undefined };
      emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.ownerRequest, identity); // 再 request：请匹配 owner 重发 ready
    },
    onSessionShutdown() { teardown(); },
  };
}
