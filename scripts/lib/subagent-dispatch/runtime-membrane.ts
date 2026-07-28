const ALLOWED_REGISTRATIONS = new Set([
  "registerEntryRenderer",
  "registerMessageRenderer",
]);
const SUPERVISOR_TOOL_NAME = "subagent_supervisor";
const STARTED_EVENT = "subagent:async-started";
const COMPLETE_EVENT = "subagent:async-complete";

const blockedRegistration = () => undefined;

function titleSuffix(title) {
  return title ? ` [${title}]` : "";
}

function decorateLifecycle(type, payload, titleRegistry) {
  if (!payload || typeof payload !== "object" || !titleRegistry) return payload;
  if (type === STARTED_EVENT) {
    const title = titleRegistry.started(payload);
    return title ? { ...payload, title } : payload;
  }
  if (type === COMPLETE_EVENT) {
    const title = titleRegistry.completed(payload);
    return title ? { ...payload, title } : payload;
  }
  return payload;
}

function decorateCompletionContent(content, titleRegistry) {
  const lines = content.split("\n");
  const firstLine = lines[0] ?? "";
  const grouped = /^Background tasks completed \(\d+\): /.test(firstLine);
  const titles = [];
  lines[0] = firstLine.replace(/\*\*([^*]+)\*\*/g, (match, agent) => {
    const title = titleRegistry.takeCompleted(agent);
    if (!title) return match;
    titles.push({ agent, title });
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
  return { content: lines.join("\n"), titles: titles.map((entry) => entry.title) };
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
      ? { ...message, content: decorated.content, details: { ...(details ?? {}), titles: decorated.titles } }
      : message;
  }
  return message;
}

export function createHeadlessSubagentApi(pi, {
  supervisorAdapter,
  titleRegistry,
  suppressCompletionNotifications = false,
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
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  })
    : undefined;

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "events") return events;
      if (property === "sendMessage") {
        return (message, options) => {
          if (suppressCompletionNotifications && message?.customType === "subagent-notify") return undefined;
          return target.sendMessage(decorateVisibleMessage(message, titleRegistry), options);
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
