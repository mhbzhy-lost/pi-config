// 统一后台活动展示的公共协议与 registry 实现（footer 子计划 T1 / 统一执行计划 F1）。
//
// 本模块承载 package 公开出口 `pi-subagents-enhanced/tui/background-activity`：
// - ActivityRow/ActivitySource/ActivitySnapshot 等纯显示协议；
// - HostScope 身份与 scope 匹配 helper：只覆盖单 Host 注册与 token 世代（epoch），
//   不虚构事件不存在的 generation 字段，也不支持人为共享 bus 的多 Host；
// - bus channel 常量与握手 payload 类型：owner/presenter/source 的实际接线在 F6，
//   此处只冻结协议形状；
// - createActivityRegistry：内部只按 kind 持有 source/身份 handle/unsubscribe，
//   快照即时拉取 source 当前事实，异常隔离，不把任何投影写回 source；订阅回调按
//   当前注册 handle fence，被替换/已注销注册的晚到回调无效果。
//
// 边界：本模块不调度任务、不发送模型消息（不成为 messages/第二任务权威）、不读取
// session/store、不自动推断业务 sessionFile；所有精简/截断/换行属于后续 renderer 层，
// registry 只透传 raw 行对象，不改写、不复制、不按 label 去重。

import { randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** 后台活动类型；与统一左下角展示区的类型图标一一对应。 */
export type ActivityKind = "subagent" | "scheduler" | "bash_async";

/** 行位置：main 为当前活动区，recent 为最近历史（详情可达）。 */
export type ActivityPlacement = "main" | "recent";

/**
 * 统一展示行。key 由类型、source 稳定 ID 与必要 child index 组成；
 * 身份只认 key，禁止按 label 去重，也不得以显示文本复活条目。
 */
export type ActivityRow = Readonly<{
  key: string;
  kind: ActivityKind;
  label: string;
  stateLabel: string;
  placement: ActivityPlacement;
}>;

/** source 查询可用性；可用性不占任务身份。 */
export type ActivityAvailability = "available" | "unavailable" | "stale";

/**
 * source 快照。available 且 rows 为空才表示当前已确认无任务；
 * 查询失败后有上次观察值时由 source 自报 stale + 原 rows/observedAt；
 * 无历史则 unavailable + 空 rows，不虚构成功，也不创建假的错误任务行。
 */
export type ActivitySnapshot = Readonly<{
  availability: ActivityAvailability;
  rows: readonly ActivityRow[];
  observedAt?: string;
  errorLabel?: string;
}>;

/** TUI Component 兼容的最小详情接口；只读展示，不包含输入/执行能力。 */
export type DetailComponent = {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
};

/** 详情请求上下文；expanded 变化后由统一详情壳按同 key/新 epoch 重取。 */
export type DetailRequest = Readonly<{
  expanded: boolean;
  requestRender(): void;
}>;

/**
 * 后台活动观察源。snapshot 为纯拉取投影；subscribe 只宣告失效、不携带任务语义；
 * detail 由 source 领域实现并沿用其安全边界，registry/布局不代替读取。
 */
export interface ActivitySource {
  kind: ActivityKind;
  snapshot(): ActivitySnapshot;
  subscribe(invalidate: () => void): () => void;
  detail(key: string, request: DetailRequest): Promise<DetailComponent | undefined>;
}

/**
 * Host 生命周期身份。token 为 footer runtime 每次 session_start 创建的对象（闭包世代，
 * 不是 process-global Symbol）；hostKey 取当前 sessionManager 对象，同 runner 跨
 * extension 稳定，reload 后需新 token。仅用于独立 Host 及其生命周期，不保证人为
 * 共享 bus 的多 Host，也不支持共享同一 manager 的并行 Host。
 */
export type HostScope = Readonly<{
  sessionManager: object;
  sessionId: string;
  token: object;
  hostKey: object;
}>;

/** owner-request 携带的 Host 身份三要素；publisher 在 ready 前无法预知 owner token。 */
export type HostScopeIdentity = Readonly<{
  sessionManager: object;
  sessionId: string;
  hostKey: object;
}>;

/**
 * 详情壳挂载视图。createFooter 的形状直接由 SDK `ExtensionUIContext['setFooter']`
 * 推导（Pi 1.0.4 d.ts：(tui, theme, footerData) => Component & { dispose?() }）；
 * 根 presenter 只返回该 factory，不得自行调用 setFooter。
 */
export type MountedActivityView = {
  createFooter: ExtensionUIContext["setFooter"] extends (factory: infer F) => void ? NonNullable<F> : never;
  openDetails(): Promise<void>;
  dispose(): void;
};

/** 根 presenter 工厂入参；fallback 仅返回既有 standalone 视图，不加载根源码。 */
export type FooterBindings = Readonly<{
  scope: HostScope;
  registry: ActivityRegistry;
  ctx: ExtensionContext;
  fallback: () => MountedActivityView;
}>;

/** 统一 presenter 工厂；由 package footer runtime 在 owner 握手完成后调用。 */
export type ActivityPresenterFactory = (bindings: FooterBindings) => MountedActivityView;

/**
 * bus channel 常量。运行协议仅在 Host 内存 bus 传递函数，不写 session entry、
 * 不发模型消息，也不是 RPC wire 协议。
 */
export const BACKGROUND_ACTIVITY_CHANNELS = Object.freeze({
  /** footer runtime 宣布唯一 owner 就绪：{ scope, ownerRegistrationId }。 */
  ownerReady: "background-activity:owner-ready",
  /** source/presenter 请求匹配 owner 重发 ready：{ sessionManager, sessionId, hostKey }。 */
  ownerRequest: "background-activity:owner-request",
  /** source 注册：{ scope, registrationId, source }；owner 核对 token/hostKey/manager 后接入。 */
  sourceRegister: "background-activity:source-register",
  /** source 注销：{ scope, registrationId, kind }；只撤销同 scope 同 registrationId 的旧注册。 */
  sourceUnregister: "background-activity:source-unregister",
  /** presenter 注册：{ scope, registrationId, factory }；同 registrationId 幂等，不重置选中项。 */
  presenterRegister: "background-activity:presenter-register",
  /** presenter 注销：{ scope, registrationId }；只恢复 standalone，不销毁 owner 整体。 */
  presenterUnregister: "background-activity:presenter-unregister",
  /** owner 关闭：{ scope }；清当代订阅/视图，不取消真实任务。 */
  ownerClose: "background-activity:owner-close",
} as const);

/** 握手 channel 名联合。 */
export type BackgroundActivityChannel = (typeof BACKGROUND_ACTIVITY_CHANNELS)[keyof typeof BACKGROUND_ACTIVITY_CHANNELS];

export type OwnerReadyPayload = Readonly<{ scope: HostScope; ownerRegistrationId: string }>;
export type OwnerRequestPayload = HostScopeIdentity;
export type SourceRegisterPayload = Readonly<{ scope: HostScope; registrationId: string; source: ActivitySource }>;
export type SourceUnregisterPayload = Readonly<{ scope: HostScope; registrationId: string; kind: ActivityKind }>;
export type PresenterRegisterPayload = Readonly<{ scope: HostScope; registrationId: string; factory: ActivityPresenterFactory }>;
export type PresenterUnregisterPayload = Readonly<{ scope: HostScope; registrationId: string }>;
export type OwnerClosePayload = Readonly<{ scope: HostScope }>;

/** publisher 在当代 source/factory 创建时生成随机 registrationId，并在重复 ready 时复用同 ID。 */
export function createBackgroundActivityRegistrationId(): string {
  return randomUUID();
}

const ACTIVITY_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["subagent", "bash_async", "scheduler"]);

/** 总览行顺序：subagent → bash_async → scheduler，与统一左区类型顺序一致。 */
const ACTIVITY_KIND_ORDER: readonly ActivityKind[] = ["subagent", "bash_async", "scheduler"];

function isObjectValue(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && ACTIVITY_KINDS.has(value as ActivityKind);
}

function isActivityRow(value: unknown): value is ActivityRow {
  if (!isObjectValue(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.key === "string" &&
    isActivityKind(candidate.kind) &&
    typeof candidate.label === "string" &&
    typeof candidate.stateLabel === "string" &&
    (candidate.placement === "main" || candidate.placement === "recent")
  );
}

function isActivitySnapshot(value: unknown): value is ActivitySnapshot {
  if (!isObjectValue(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.availability !== "available" &&
    candidate.availability !== "unavailable" &&
    candidate.availability !== "stale"
  ) {
    return false;
  }
  if (!Array.isArray(candidate.rows) || !candidate.rows.every(isActivityRow)) return false;
  if (candidate.observedAt !== undefined && typeof candidate.observedAt !== "string") return false;
  if (candidate.errorLabel !== undefined && typeof candidate.errorLabel !== "string") return false;
  return true;
}

/** 校验 bus 载荷中的 scope 形状；缺字段即拒绝，不做兼容拼装，不猜测业务 sessionFile。 */
export function isHostScope(value: unknown): value is HostScope {
  if (!isObjectValue(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isObjectValue(candidate.sessionManager) &&
    typeof candidate.sessionId === "string" &&
    isObjectValue(candidate.token) &&
    isObjectValue(candidate.hostKey)
  );
}

/**
 * 三要素身份匹配（不含 token）。publisher 只回答 manager/sessionId/hostKey 同时
 * 匹配的 owner-ready；hostKey 即当前 sessionManager 对象身份。
 */
export function isSameHostScopeIdentity(scope: HostScope, identity: HostScopeIdentity): boolean {
  return (
    scope.sessionManager === identity.sessionManager &&
    scope.sessionId === identity.sessionId &&
    scope.hostKey === identity.hostKey
  );
}

/**
 * 完整 scope 匹配（含 token 世代）。owner 据此接受/拒绝 register/unregister/close：
 * token 不同即跨代注册（如 reload 后的旧闭包），必须拒绝；不凭空读取事件不存在的
 * generation 字段，事件世代只存在于闭包 token 元数据中。
 */
export function isSameHostScope(scope: HostScope, other: HostScope): boolean {
  return scope.token === other.token && isSameHostScopeIdentity(scope, other);
}

/** registry 持有的单条注册：source、注册身份 handle 与退订函数。 */
interface RegisteredActivitySource {
  readonly source: ActivitySource;
  readonly handle: object;
  readonly unsubscribe: () => void;
}

/** 统一后台活动 registry：按 kind 拉取 source 事实，不做任务权威。 */
export interface ActivityRegistry {
  /**
   * 注册 source。同 kind 出现新 source 对象时释放旧订阅并换新 handle；同一 source
   * 对象重复注册（重复 ready）幂等保留原 handle 与订阅。返回的 dispose 先比对当前
   * handle 身份，旧 dispose 不能删除新注册。
   */
  register(source: ActivitySource): () => void;
  /**
   * 聚合当前已确认（available）source 的行，按类型固定顺序；stale/unavailable 的
   * 上次观察值不算当前行，经 sourceSnapshot 分辨，不推断删除/完成。
   */
  snapshot(): readonly ActivityRow[];
  /** 单 source 快照；未注册返回 undefined；保留 availability 透传，不写回 source。 */
  sourceSnapshot(kind: ActivityKind): ActivitySnapshot | undefined;
  /** 按精确 row key 反查 source；不按 label 推断，找不到返回 undefined。 */
  sourceFor(key: string): ActivitySource | undefined;
  /** 登记总览失效回调；source 失效或注册集变化时触发，registry 关闭后无效果。 */
  subscribe(invalidate: () => void): () => void;
  /** 关闭 registry：退订全部 source、清空注册；幂等，关闭后 late invalidate/register 无效果。 */
  dispose(): void;
}

function assertActivitySource(source: ActivitySource): void {
  if (
    !isObjectValue(source) ||
    !isActivityKind((source as { kind?: unknown }).kind) ||
    typeof (source as ActivitySource).snapshot !== "function" ||
    typeof (source as ActivitySource).subscribe !== "function" ||
    typeof (source as ActivitySource).detail !== "function"
  ) {
    throw new TypeError("ActivitySource 不满足协议：需要合法 kind 与 snapshot/subscribe/detail 函数");
  }
}

/** pullSnapshot 兜底 errorLabel：固定类别文案。异常正文可能携带不可信内容或秘密
 * （如底层 store/网络错误的原始报文），不属于显示层数据，不得透传到 TUI。 */
const SOURCE_QUERY_FAILED_ERROR_LABEL = "source 查询失败";
const SNAPSHOT_MALFORMED_ERROR_LABEL = "source 快照不符合协议";

/**
 * 创建 registry。owner（package footer runtime）可独立创建实例；根层只消费实例，
 * 不保留第二实现。registry 不持有 footer/editor 权限，不调用 setFooter。
 */
export function createActivityRegistry(): ActivityRegistry {
  const byKind = new Map<ActivityKind, RegisteredActivitySource>();
  const invalidationListeners = new Set<() => void>();
  let closed = false;

  const notify = (): void => {
    if (closed) return;
    for (const listener of [...invalidationListeners]) {
      try {
        listener();
      } catch {
        // 展示回调彼此隔离：单个监听者异常不给其他 source/监听者伪造状态，
        // 也不向任务执行路径传播。
      }
    }
  };

  const pullSnapshot = (source: ActivitySource): ActivitySnapshot => {
    try {
      const snapshot: unknown = source.snapshot();
      if (isActivitySnapshot(snapshot)) return snapshot;
      return { availability: "unavailable", rows: [], errorLabel: SNAPSHOT_MALFORMED_ERROR_LABEL };
    } catch {
      // 异常正文可能携带不可信内容或秘密，不属于显示层数据：只输出固定类别
      // errorLabel，不透传 exception.message。source 自身按协议返回的 errorLabel
      // 等 raw 字段仍走上面的透传路径原样返回，本 catch 不改写 raw source 错误。
      return { availability: "unavailable", rows: [], errorLabel: SOURCE_QUERY_FAILED_ERROR_LABEL };
    }
  };

  const removeIfCurrent = (kind: ActivityKind, handle: object): void => {
    const current = byKind.get(kind);
    if (!current || current.handle !== handle) return; // 旧 dispose 不能删除新注册
    byKind.delete(kind);
    try {
      current.unsubscribe();
    } catch {
      // 退订异常不阻断注销，也不向调用方传播。
    }
    notify();
  };

  // 数据来源分类（缺陷数据来源分类门禁，F1 补修）：
  // - 来源：公共协议 `ActivitySource.subscribe(invalidate)` 的回调是合法 production
  //   数据链——任何经 public register 接入的 source 都可能在 unsubscribe 之后异步调用
  //   先前已递交的 invalidate 回调（正常 unsubscribe 只保证后续不再投递，不保证撤回
  //   已入队/已被 source 捕获的回调），也可能在 subscribe 调用内同步回调。两者均可由
  //   合法 public 入口（register→source.subscribe）与正常事件顺序产生，时间与资源
  //   事实有效，不是 fixture 制造的异常数据。
  // - 首个偏离点：订阅闭包此前为无身份的 `() => notify()`，除 closed 外没有当前注册
  //   核对；被同 kind 替换或已注销的旧注册，其晚到的回调会 invalidate 新视图，违反
  //   『dispose/替换后 late invalidate 无效果』验收。
  // - 分类：类别1（预期 production 数据未被正确处理），最小修复即下方 handle fence；
  //   不新增协议字段、不改 raw、不新增 fallback 或对坏 fixture 的兼容分支。
  const register = (source: ActivitySource): (() => void) => {
    if (closed) return () => undefined; // 关闭后的 late 注册无效果
    assertActivitySource(source);
    const kind = source.kind;
    const existing = byKind.get(kind);
    if (existing && existing.source === source) {
      // 同一 source 对象重复注册（重复 ready 同 registrationId）幂等：
      // 保持原 handle 与原订阅，不重复退订/订阅，也不触发变化通知。
      const handle = existing.handle;
      return () => removeIfCurrent(kind, handle);
    }
    // handle 先于 subscribe 准备：subscribe 可在调用内同步回调 invalidate（合法
    // production 行为），回调闭包若读取尚未初始化的 handle 会抛 ReferenceError 并被
    // 下方 catch 误吞，导致订阅静默丢失。
    const handle: object = {};
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = source.subscribe(() => {
        // 订阅回调 fence：仅在当前 byKind 注册 handle 与本注册一致时通知。
        // (a) subscribe 内的同步回调发生在本注册写入 byKind 之前——注册变化本身的
        //     notify() 已覆盖视图刷新；
        // (b) 正常 unsubscribe 不保证撤回已入队回调：被同 kind 替换或已注销
        //     （removeIfCurrent/dispose）的旧注册，其晚到的 invalidate 回调不得
        //     invalidate 新视图（late invalidate 无效果）。
        const current = byKind.get(kind);
        if (!current || current.handle !== handle) return;
        notify();
      });
    } catch {
      // 订阅失败只损失推送失效；快照拉取不受影响，异常不向注册路径传播。
    }
    if (existing) {
      byKind.delete(kind);
      try {
        existing.unsubscribe(); // 同 kind 新注册释放旧订阅
      } catch {
        // 释放旧订阅异常不阻断新注册。
      }
    }
    byKind.set(kind, { source, handle, unsubscribe });
    notify();
    return () => removeIfCurrent(kind, handle);
  };

  const snapshot = (): readonly ActivityRow[] => {
    const rows: ActivityRow[] = [];
    for (const kind of ACTIVITY_KIND_ORDER) {
      const entry = byKind.get(kind);
      if (!entry) continue;
      const pulled = pullSnapshot(entry.source);
      // 过期观察不算当前 main/recent 行；旧行经 sourceSnapshot 由 renderer 单独分组。
      if (pulled.availability !== "available") continue;
      rows.push(...pulled.rows);
    }
    return rows;
  };

  const sourceSnapshot = (kind: ActivityKind): ActivitySnapshot | undefined => {
    if (!isActivityKind(kind)) return undefined;
    const entry = byKind.get(kind);
    if (!entry) return undefined;
    return pullSnapshot(entry.source);
  };

  const sourceFor = (key: string): ActivitySource | undefined => {
    if (typeof key !== "string") return undefined;
    for (const kind of ACTIVITY_KIND_ORDER) {
      const entry = byKind.get(kind);
      if (!entry) continue;
      const pulled = pullSnapshot(entry.source);
      for (const activityRow of pulled.rows) {
        if (activityRow.key === key) return entry.source; // 精确 key 匹配
      }
    }
    return undefined;
  };

  const subscribe = (invalidate: () => void): (() => void) => {
    if (closed || typeof invalidate !== "function") return () => undefined;
    invalidationListeners.add(invalidate);
    return () => {
      invalidationListeners.delete(invalidate);
    };
  };

  const dispose = (): void => {
    if (closed) return; // 清理幂等
    closed = true;
    const entries = [...byKind.values()];
    byKind.clear();
    invalidationListeners.clear();
    for (const entry of entries) {
      try {
        entry.unsubscribe();
      } catch {
        // 关闭路径逐个隔离退订异常。
      }
    }
  };

  return { register, snapshot, sourceSnapshot, sourceFor, subscribe, dispose };
}
