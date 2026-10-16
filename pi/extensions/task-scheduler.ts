// Project entry point for the thin, in-process upstream scheduler membrane.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  consumeRecoveryOutcome,
  createSchedulerActivityPublisher,
  registerTaskSchedulerAdapter,
  type SchedulerActivityObserver,
  type SchedulerRecoveryOutcome,
} from "../../src/task-scheduler/index.ts";

/** Public runtime bridge: the scheduler never imports recovery implementation or storage. */
export type SchedulerRecoveryBridge = {
  recoverySource?: () => SchedulerRecoveryOutcome | Promise<SchedulerRecoveryOutcome>;
  onRecoveryOutcome?: (result: ReturnType<typeof consumeRecoveryOutcome>) => void;
};

export default function taskSchedulerExtension(pi: ExtensionAPI, bridge: SchedulerRecoveryBridge = {}): void {
  // 入口保存 adapter 返回的只读 observer（F4b）：source/publisher 只消费它的
  // snapshot/subscribe/detail，世代 token 只存在于 adapter 闭包内部，不出现在入口。
  const observer: SchedulerActivityObserver = registerTaskSchedulerAdapter(pi);
  // SDK ExtensionAPI.events 是必需公开边界（Pi 1.0.4 types.d.ts:1371 非可选；loader.js
  // createExtensionAPI 恒为每个扩展工厂构建 events bus），入口无条件接线 publisher，不为
  // 缺方法 mock 增加 production 兼容；bus 失效由 publisher 内部握手隔离（订阅/emit 各自
  // try/catch），不构成 scheduler 执行失败；RPC 由 mode 门禁不发布（adapter 既有
  // `pi-scheduler` status 保留）。
  const publisher = createSchedulerActivityPublisher(observer, {
    on: (channel, handler) => pi.events.on(channel, handler),
    emit: (channel, data) => pi.events.emit(channel, data),
  });
  // 注册顺序即执行顺序：adapter 的 session_start handler 先清空 listeners、完成 initial
  // refresh 并建立唯一 timer；本 handler 在其后为当代 session 重建 source/bus 订阅——
  // 不在 start 前长期订阅 observer（session_start 会清场），initial 状态由注册方即时
  // 拉取 snapshot 补齐。缺 session 身份时不发布 source，也不向 scheduler 链路报告失败。
  pi.on("session_start", async (_event, ctx) => {
    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      return;
    }
    if (!sessionId) return;
    publisher.onSessionStart({ mode: ctx.mode, sessionManager: ctx.sessionManager, sessionId });
  });
  pi.on("session_shutdown", async () => { publisher.onSessionShutdown(); });
  if (typeof bridge.recoverySource === "function") {
    let phase = "recoverySource";
    void Promise.resolve().then(() => bridge.recoverySource!()).then((outcome) => {
      phase = "consumeRecoveryOutcome";
      const result = consumeRecoveryOutcome(outcome);
      phase = "onRecoveryOutcome";
      bridge.onRecoveryOutcome?.(result);
    }).catch((error) => {
      try {
        console.error(`[task-scheduler recovery] ${phase} failed`, error);
      } catch (diagnosticError) {
        process.emitWarning(new AggregateError([error, diagnosticError], `task-scheduler recovery diagnostic failed (${phase})`, { cause: error }));
      }
    });
  }
}
