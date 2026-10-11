const ALLOWED_REGISTRATIONS = new Set([
  "registerEntryRenderer",
  "registerMessageRenderer",
]);
const SUPERVISOR_TOOL_NAME = "subagent_supervisor";
const STARTED_EVENT = "subagent:async-started";
const COMPLETE_EVENT = "subagent:async-complete";

import { classifySubagentPresentation } from "./presentation-status.ts";

const blockedRegistration = () => undefined;

type HeadlessApiOptions = {
  supervisorAdapter?: { bind(execute: unknown): unknown };
  titleRegistry?: unknown;
  suppressCompletionNotifications?: boolean;
  suppressSuccessfulCompletion?: (payload: unknown) => boolean;
  forceCompletionDisplay?: boolean;
  captureSessionShutdown?: (handler: unknown) => unknown;
  captureSessionStart?: (handler: unknown) => unknown;
  captureEventSubscription?: (type: unknown, handler: unknown) => unknown;
  workingStateTrace?: (entry: unknown) => void;
  getHostIdentity?: () => { hostSessionId?: string | null; completionOwnerId?: string } | undefined;
};

// 完成通知的 title 解析职责已移到 TUI 显示层（compact-rendering.ts）：membrane
// 不再按 agent 消费 completed 队列（先于 async-complete 事件消费会取到上一任务
// 的 title），也不再改写 sendMessage 的原始 message/content/details（TUI raw 边
// 界）。显示层按通知 correlation 行中的稳定 run 标识只读查询 titleRegistry。

function decorateLifecycle(type, payload, titleRegistry) {
  if (!payload || typeof payload !== "object") return payload;
  if (type === STARTED_EVENT && titleRegistry) {
    const title = titleRegistry.started(payload);
    return title ? { ...payload, title } : payload;
  }
  if (type === COMPLETE_EVENT) {
    const presentation = classifySubagentPresentation(payload);
    const title = titleRegistry?.completed?.({ ...payload, presentation });
    return { ...payload, presentation, ...(title ? { title } : {}) };
  }
  return payload;
}

function traceMonotonicMs() {
  return Math.floor(Number(process.hrtime.bigint() / 1_000_000n));
}

function completionDecision(payload, identity) {
  const source = payload?.source === "foreground" ? "foreground" : "async";
  const sessionMatches = payload?.sessionId === identity?.hostSessionId;
  if (source === "foreground") {
    return {
      source,
      accepted: sessionMatches,
      ownershipDecision: sessionMatches ? "foreground-session-match" : "foreground-session-mismatch",
    };
  }
  const ownerMatches = typeof payload?.completionOwnerId === "string"
    && payload.completionOwnerId === identity?.completionOwnerId;
  return {
    source,
    accepted: sessionMatches && ownerMatches,
    ownershipDecision: sessionMatches && ownerMatches
      ? "async-session-and-owner-match"
      : "async-session-and-owner-mismatch",
  };
}

export function createHeadlessSubagentApi(pi, {
  supervisorAdapter,
  titleRegistry,
  suppressCompletionNotifications = false,
  suppressSuccessfulCompletion,
  forceCompletionDisplay = false,
  captureSessionShutdown,
  captureSessionStart,
  captureEventSubscription,
  workingStateTrace,
  getHostIdentity,
}: HeadlessApiOptions = {}) {
  if (!pi || typeof pi !== "object") {
    throw new TypeError("headless subagent runtime requires an ExtensionAPI object");
  }

  const traceWorkingState = (event, fields = {}) => {
    if (typeof workingStateTrace !== "function") return;
    try {
      const identity = typeof getHostIdentity === "function" ? getHostIdentity() : undefined;
      workingStateTrace({
        version: 1,
        hostSessionId: identity?.hostSessionId,
        completionOwnerId: identity?.completionOwnerId,
        event,
        monotonicMs: traceMonotonicMs(),
        ...fields,
      });
    } catch {
      // 诊断输出不得影响 completion、事件或 TUI。
    }
  };
  const observeEvent = (type, payload) => {
    if (type !== "subagent:async-complete" && type !== "subagent:foreground-complete") return;
    const identity = typeof getHostIdentity === "function" ? getHostIdentity() : undefined;
    const decision = completionDecision(payload, identity);
    const fields = {
      source: decision.source,
      ...(typeof payload?.runId === "string" ? { runId: payload.runId } : {}),
      ...(typeof payload?.sessionId === "string" ? { eventSessionId: payload.sessionId } : {}),
      ...(typeof payload?.completionOwnerId === "string" ? { eventCompletionOwnerId: payload.completionOwnerId } : {}),
    };
    traceWorkingState("completion-received", fields);
    traceWorkingState(decision.accepted ? "ownership-match" : "ownership-mismatch", {
      ...fields,
      ownershipDecision: decision.ownershipDecision,
    });
  };
  const events = pi.events && typeof pi.events === "object"
    ? new Proxy(pi.events, {
    get(target, property, receiver) {
      if (property === "emit") {
        return (type, payload) => target.emit(type, decorateLifecycle(type, payload, titleRegistry));
      }
      if (property === "on") {
        return (type, handler) => {
          if (typeof workingStateTrace !== "function" && typeof suppressSuccessfulCompletion !== "function") {
            return typeof captureEventSubscription === "function"
              ? captureEventSubscription(type, handler)
              : target.on(type, handler);
          }
          const observedHandler = (payload) => {
            observeEvent(type, payload);
            if (type === COMPLETE_EVENT && suppressSuccessfulCompletion?.(payload)) return;
            return handler(payload);
          };
          if (typeof captureEventSubscription === "function") return captureEventSubscription(type, observedHandler);
          return target.on(type, observedHandler);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  })
    : undefined;

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "events") return events;
      if (property === "on" && (typeof captureSessionShutdown === "function" || typeof captureSessionStart === "function")) {
        return (type, handler) => {
          if (type === "session_shutdown" && typeof captureSessionShutdown === "function") return captureSessionShutdown(handler);
          if (type === "session_start" && typeof captureSessionStart === "function") return captureSessionStart(handler);
          return target.on(type, handler);
        };
      }
      if (property === "sendMessage") {
        return (message, options) => {
          if (suppressCompletionNotifications && message?.customType === "subagent-notify") return undefined;
          // 原样传递 message（TUI raw 边界）：仅保留 display gating 既有语义
          //（forceCompletionDisplay 只浅拷贝翻转 display 字段），不加 title、
          // 不改 content/details。
          const visible = forceCompletionDisplay && message?.customType === "subagent-notify"
            ? { ...message, display: true }
            : message;
          const fields = {
            ...(typeof visible?.customType === "string" ? { customType: visible.customType } : {}),
            ...(typeof options?.triggerTurn === "boolean" ? { triggerTurn: options.triggerTurn } : {}),
            ...(typeof visible?.display === "boolean" ? { display: visible.display } : {}),
          };
          const result = target.sendMessage(visible, options);
          traceWorkingState("send-message", fields);
          return result;
        };
      }
      if (property === "registerTool") {
        return (definition) => {
          if (definition?.name !== SUPERVISOR_TOOL_NAME || !supervisorAdapter) return undefined;
          if (typeof definition.execute !== "function") {
            const error = new Error("SUPERVISOR_TARGET_INVALID");
            error.code = "SUPERVISOR_TARGET_INVALID";
            throw error;
          }
          supervisorAdapter.bind(definition.execute.bind(definition));
          return undefined;
        };
      }
      if (property === "getAllTools" && supervisorAdapter) {
        return () => target.getAllTools().filter((tool) => tool?.name !== SUPERVISOR_TOOL_NAME);
      }
      if (
        typeof property === "string"
        && property.startsWith("register")
        && !ALLOWED_REGISTRATIONS.has(property)
      ) {
        return blockedRegistration;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
