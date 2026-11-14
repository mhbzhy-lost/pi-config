import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// bash_async 完成回执的投递协调器，移植自 pi-subagents 的 parent-wake（shared/parent-wake.js）。
// 纯内存：held 标志 + 进程内 reservation WeakMap，不落盘、不复制 unstartedWakes/shutdown replay（补投）。
// 作用：让回执获得与 subagent 一致的 Esc 生存性——
//   busy 正常 → triggerTurn:true（Host steer，回合中途 drain 进 transcript）；
//   idle → triggerTurn:true（Host _startRun 立即落盘）；
//   Esc 后 held → triggerTurn:false（Host pending custom message，避开被 clearQueue 清掉的
//     steering/followUp 队列，回合收束时 flush 进 transcript）。
// 注意：回执最终按普通 custom message 写入 transcript 是正常持久化，不是「完全不落盘」；
// held 且已 idle 时 triggerTurn:false 直接 append，不会自动起新 LLM turn（不因 Esc 自动重启）。

const WAKE_PENDING_MS = 10_000;
// 与 pi-subagents 共享同一 session 的 idle wake reservation，协调避免多个 completion 各自起 idle run。
// 代价（已记录）：扩展间耦合；若另一 wake 已 reservation 但最终未启动，bash 回执可能被 triggerTurn:false
// append 而不单独唤醒——拒绝 replay 下属可接受残余风险。
const reservationsSymbol = Symbol.for('pi.idle-wake.v1');
type Reservation = { sessionId: string; sentAt?: number };
const wakeGlobal = globalThis as Record<symbol, unknown>;
const reservations = (wakeGlobal[reservationsSymbol] ??= new WeakMap<object, Reservation>()) as WeakMap<object, Reservation>;

type WakeMessage = Parameters<ExtensionAPI['sendMessage']>[0];

export type BashAsyncWake = {
  // 唯一 send 出口的策略层：controller 只传 {triggerTurn:true}，由此决定 idle 触发/busy steer/held 降级。
  sendMessage(message: WakeMessage, options: { triggerTurn: true }): boolean;
  bindSession(ctx: ExtensionContext): void;
  agentStarted(): void;
  userAborted(): void;
  releaseHold(): void;
  isHeld(): boolean;
  sessionShutdown(reason?: string): void;
};

export function createBashAsyncWake(pi: ExtensionAPI, now: () => number = Date.now): BashAsyncWake {
  // 在 bindSession 捕获 ctx：Pi 的旧 ExtensionContext 失效后其 getter 会抛错。
  // controller 的唯一 send 出口已由 contextSafe/epoch 守卫保证会话有效，这里沿用 parent-wake 语义。
  let ctx: ExtensionContext | undefined;
  let session: { manager: object; id: string } | undefined;
  let held = false;
  // 每次访问都查 reservation：另一扩展可能已为本 session 建立条目。
  const reservation = (): Reservation => {
    if (!session) return { sessionId: '' };
    const current = reservations.get(session.manager);
    if (current?.sessionId === session.id) return current;
    const next: Reservation = { sessionId: session.id };
    reservations.set(session.manager, next);
    return next;
  };
  const reserved = (): boolean => {
    const { sentAt } = reservation();
    return sentAt !== undefined && now() - sentAt < WAKE_PENDING_MS;
  };
  return {
    sendMessage(message, options) {
      if (options?.triggerTurn !== true) {
        pi.sendMessage(message, options);
        return false;
      }
      if (held || (ctx?.isIdle() && reserved())) {
        // 现在 append，或在一个仍在收束的 run 末尾 append；都不触发 extension message_start。
        pi.sendMessage(message, { triggerTurn: false });
        return true;
      }
      if (ctx?.isIdle()) reservation().sentAt = now();
      pi.sendMessage(message, options);
      return false;
    },
    bindSession(context) {
      ctx = context;
      session = { manager: context.sessionManager, id: context.sessionManager.getSessionId() };
      held = false;
    },
    agentStarted() {
      reservation().sentAt = undefined;
      held = false;
    },
    userAborted() {
      held = true;
    },
    releaseHold() {
      held = false;
    },
    isHeld() {
      return held;
    },
    sessionShutdown(reason) {
      if (reason !== 'reload') reservation().sentAt = undefined;
    },
  };
}