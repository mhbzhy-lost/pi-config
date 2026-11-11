// Scheduler 的公开适配器与只读观察面；不再向自定义 TUI 投影活动。

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
