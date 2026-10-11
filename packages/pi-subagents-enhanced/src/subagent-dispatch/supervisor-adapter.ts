export const SUPERVISOR_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { enum: ["reply", "pending", "status"] },
    to: { type: "string" },
    message: { type: "string" },
    replyTo: { type: "string" },
  },
});

export const SUPERVISOR_DESCRIPTION = "Read pending child requests, inspect supervisor status, or reply to a child that needs a decision.";

function targetError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createSupervisorAdapter() {
  let executeTarget;

  return Object.freeze({
    bind(execute) {
      if (typeof execute !== "function") throw targetError("SUPERVISOR_TARGET_INVALID");
      if (executeTarget) throw targetError("SUPERVISOR_TARGET_ALREADY_BOUND");
      executeTarget = execute;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!executeTarget) throw targetError("SUPERVISOR_TARGET_UNAVAILABLE");
      return executeTarget(toolCallId, params, signal, onUpdate, ctx);
    },
    dispose() {
      executeTarget = undefined;
    },
    isBound() {
      return typeof executeTarget === "function";
    },
  });
}

export function createSupervisorTool(adapter, { name = "subagent_supervisor", label = "Subagent Supervisor", renderCall, renderResult }: {
  name?: string;
  label?: string;
  renderCall?: unknown;
  renderResult?: unknown;
} = {}) {
  if (!adapter || typeof adapter.execute !== "function") {
    throw new TypeError("supervisor tool requires an adapter");
  }
  if (typeof name !== "string" || name.length === 0 || typeof label !== "string" || label.length === 0) {
    throw new TypeError("supervisor tool requires a name and label");
  }

  return Object.freeze({
    name,
    exposure: "model-only" as const,
    label,
    description: SUPERVISOR_DESCRIPTION,
    // M05B：单工具提示；reply 针对实际 request，writeReply 本侧提交不证明投递或 child 消费。
    promptSnippet: "查看子代理待决请求（pending）、检查状态（status），并针对具体请求回复决策（reply）。",
    promptGuidelines: [
      "reply 要针对实际 request 的原始问题作答，replyTo 对应具体待决请求，不泛泛回复。",
      "writeReply 本侧已提交只代表提交已记录，不代表 child 已收到、已消费或理解；以独立 delivery/consumption 事实与 child 实际产出为准。",
    ],
    parameters: SUPERVISOR_PARAMETERS,
    ...(typeof renderCall === "function" ? { renderCall } : {}),
    ...(typeof renderResult === "function" ? { renderResult } : {}),
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return adapter.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
