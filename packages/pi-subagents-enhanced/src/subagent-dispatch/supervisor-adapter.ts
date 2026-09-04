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

export function createSupervisorTool(adapter, { name = "subagent_supervisor", label = "Subagent Supervisor" } = {}) {
  if (!adapter || typeof adapter.execute !== "function") {
    throw new TypeError("supervisor tool requires an adapter");
  }
  if (typeof name !== "string" || name.length === 0 || typeof label !== "string" || label.length === 0) {
    throw new TypeError("supervisor tool requires a name and label");
  }

  return Object.freeze({
    name,
    label,
    description: SUPERVISOR_DESCRIPTION,
    parameters: SUPERVISOR_PARAMETERS,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return adapter.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
