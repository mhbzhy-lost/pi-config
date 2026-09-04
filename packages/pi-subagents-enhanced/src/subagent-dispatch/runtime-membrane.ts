const ALLOWED_REGISTRATIONS = new Set([
  "registerEntryRenderer",
  "registerMessageRenderer",
]);
const SUPERVISOR_TOOL_NAME = "subagent_supervisor";
const STARTED_EVENT = "subagent:async-started";
const COMPLETE_EVENT = "subagent:async-complete";

import { classifySubagentPresentation } from "./presentation-status.ts";

const blockedRegistration = () => undefined;

function titleSuffix(title) {
  return title ? ` [${title}]` : "";
}

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

function decorateCompletionContent(content, titleRegistry) {
  const lines = content.split("\n");
  const firstLine = lines[0] ?? "";
  const grouped = /^Background tasks completed \(\d+\): /.test(firstLine);
  const titles = [];
  lines[0] = firstLine.replace(/\*\*([^*]+)\*\*/g, (match, agent) => {
    const detail = typeof titleRegistry.takeCompletedDetail === "function"
      ? titleRegistry.takeCompletedDetail(agent)
      : undefined;
    const title = detail?.title ?? titleRegistry.takeCompleted(agent);
    if (!title) return match;
    titles.push({ agent, title, presentation: detail?.presentation });
    return `**${agent}**${titleSuffix(title)}`;
  });
  if (grouped) {
    for (let index = 0; index < titles.length; index += 1) {
      const blockPrefix = `${index + 1}. ${titles[index].agent}`;
      const lineIndex = lines.findIndex((line, candidate) => candidate > 0 && line.startsWith(blockPrefix));
      if (lineIndex >= 0) {
        lines[lineIndex] = `${blockPrefix}${titleSuffix(titles[index].title)}${lines[lineIndex].slice(blockPrefix.length)}`;
      }
    }
  }
  return {
    content: lines.join("\n"),
    titles: titles.map((entry) => entry.title),
    presentations: titles.map((entry) => entry.presentation),
  };
}

function decorateVisibleMessage(message, titleRegistry) {
  if (!message || typeof message !== "object" || !titleRegistry) return message;
  const details = message.details;
  const runId = details?.runId ?? details?.event?.runId;
  const title = typeof runId === "string" ? titleRegistry.titleFor(runId) : undefined;
  if (typeof message.content !== "string") return message;
  if (title) {
    return {
      ...message,
      content: `${message.content}${titleSuffix(title)}`,
      details: { ...(details ?? {}), title },
    };
  }
  if (message.customType === "subagent-notify") {
    const decorated = decorateCompletionContent(message.content, titleRegistry);
    return decorated.titles.length
      ? { ...message, content: decorated.content, details: { ...(details ?? {}), titles: decorated.titles, ...(decorated.presentations.some(Boolean) ? { presentations: decorated.presentations } : {}) } }
      : message;
  }
  return message;
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
} = {}) {
  if (!pi || typeof pi !== "object") {
    throw new TypeError("headless subagent runtime requires an ExtensionAPI object");
  }

  const events = pi.events && typeof pi.events === "object"
    ? new Proxy(pi.events, {
    get(target, property, receiver) {
      if (property === "emit") {
        return (type, payload) => target.emit(type, decorateLifecycle(type, payload, titleRegistry));
      }
      if (property === "on" && typeof captureEventSubscription === "function") {
        return (type, handler) => captureEventSubscription(type, (payload) => {
          if (type === COMPLETE_EVENT && suppressSuccessfulCompletion?.(payload)) return;
          handler(payload);
        });
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
          const decorated = decorateVisibleMessage(message, titleRegistry);
          const visible = forceCompletionDisplay && decorated?.customType === "subagent-notify"
            ? { ...decorated, display: true }
            : decorated;
          return target.sendMessage(visible, options);
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
