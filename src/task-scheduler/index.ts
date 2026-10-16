// 根 scheduler 对外观察入口（统一执行计划 F4a / footer 子计划 T4a / F4g R2 记录 §7）。
// adapter 仍是唯一 membrane 实现；本入口只导出公开观察面与 factory：
// `registerTaskSchedulerAdapter` 返回 `SchedulerActivityObserver`，既有调用方
// （含 pi/extensions/task-scheduler.ts 的 default entry）忽略返回值仍然兼容。
// `SchedulerRefreshOwner` 世代 token 仅存在于 adapter 闭包内部，永不导出；
// 闭包外（含后续 F4b source）无法观察、持有或拼装 token，只能消费 observer。

export type {
  SchedulerActivityStatus,
  SchedulerActivityRecord,
  SchedulerActivitySnapshot,
  SchedulerDetailOutcome,
  SchedulerActivityObserver,
  SchedulerRecoveryOutcome,
} from "./adapter.ts";
export {
  consumeRecoveryOutcome,
  getSchedulerAdapterDiagnostics,
  registerTaskSchedulerAdapter,
} from "./adapter.ts";
export { default } from "./adapter.ts";

// F4b：scheduler 只读 ActivitySource 与同 Host TUI publisher。根 feature（含 Host 入口）
// 只经本公开入口消费，不深引 adapter 内部；publisher 握手协议来自 package 公开出口，
// 世代 token 仍只在 adapter 闭包内部，不出现在本入口。
export {
  createSchedulerActivitySource,
  createSchedulerActivityPublisher,
  type SchedulerActivityBus,
  type SchedulerActivitySession,
  type SchedulerActivityPublisher,
} from "./activity-source.ts";
