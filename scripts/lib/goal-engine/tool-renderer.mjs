const TOOL_NAMES = [
  "goal_init", "goal_status", "goal_dispatch", "goal_settle",
  "goal_integrate", "goal_accept", "goal_amend", "goal_finalize",
];
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const WORD_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

function safe(value, pattern = ID_RE, fallback = "?") {
  return typeof value === "string" && pattern.test(value) ? value : fallback;
}
function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : "0"; }
function length(value) { return Array.isArray(value) ? String(value.length) : "0"; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function lineComponent(line) {
  return {
    render(width) {
      const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : line.length;
      if (limit === 0) return [];
      if (line.length <= limit) return [line];
      return [limit === 1 ? "~" : `${line.slice(0, limit - 1)}~`];
    },
    invalidate() {},
  };
}

function callSummary(name, args) {
  const a = object(args);
  switch (name) {
    case "goal_init": {
      const execution = object(a.execution);
      if (execution.schema === "goal-runtime.v1") return `${name} | runtime | tasks ${length(execution.tasks)} | conditions ${length(execution.conditions)}`;
      return `${name} | planned | tasks ${length(a.tasks)}`;
    }
    case "goal_status":
      if (a.list_cwd_goals === true) return `${name} | list`;
      if (Object.hasOwn(a, "transfer_challenge_id")) return `${name} | transfer ${safe(a.transfer_challenge_id)}`;
      return `${name} | goal ${safe(a.goal_id)}`;
    case "goal_dispatch": return `${name} | task ${safe(a.task_id)}`;
    case "goal_settle": return `${name} | task ${safe(a.task_id)} | ${safe(a.outcome, WORD_RE, "pending")}`;
    case "goal_integrate": return `${name} | task ${safe(a.task_id)} | ${safe(a.action ?? a.strategy, WORD_RE, "apply")}`;
    case "goal_accept": return `${name} | task ${safe(a.task_id)}`;
    case "goal_amend": {
      const changes = object(a.changes);
      const updates = Array.isArray(changes.update_tasks) ? changes.update_tasks.length : Object.keys(object(a.update_tasks)).length;
      return `${name} | ${safe(a.operation, WORD_RE, "update")} | add ${length(a.add_tasks)} | remove ${length(a.remove_tasks)} | update ${updates}`;
    }
    case "goal_finalize": return `${name} | goal ${safe(a.goal_id)}`;
    default: return name;
  }
}

function parsedValue(result) {
  const details = object(result?.details);
  if (Object.hasOwn(details, "value")) {
    const value = details.value;
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  const text = result?.content?.find((part) => part?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
function errorCode(result, value) {
  return safe(object(result?.error).code ?? object(value?.error).code ?? value?.code, WORD_RE, "");
}
function resultSummary(name, result, options, context) {
  const value = parsedValue(result);
  const code = errorCode(result, value);
  if (context?.isError || result?.isError || result?.error || value?.status === "error" || value?.runtimeState === "error" || code) return `${name} | error${code ? ` | ${code}` : ""}`;
  const bits = [];
  if (options?.isPartial || result?.isPartial) bits.push("running");
  else {
    const state = value?.status ?? value?.runtimeState ?? value?.lifecycle;
    if (typeof state === "string" && WORD_RE.test(state)) bits.push(state === "partial" ? "running" : state);
  }
  const action = value?.machineAction?.tool;
  if (typeof action === "string" && WORD_RE.test(action)) bits.push(`next ${action}`);
  const task = value?.task_id ?? value?.taskId;
  if (typeof task === "string" && ID_RE.test(task)) bits.push(`task ${task}`);
  if (Array.isArray(value?.runnable)) bits.push(`run ${value.runnable.length}`);
  else if (Number.isSafeInteger(value?.runnable_count) && value.runnable_count >= 0) bits.push(`run ${nonnegative(value.runnable_count)}`);
  if (Array.isArray(value?.blocking)) bits.push(`block ${value.blocking.length}`);
  else if (Number.isSafeInteger(value?.blocking_count) && value.blocking_count >= 0) bits.push(`block ${nonnegative(value.blocking_count)}`);
  return `${name} | ${bits.length ? bits.join(" | ") : "done"}`;
}

export function createGoalToolRenderers() {
  return Object.fromEntries(TOOL_NAMES.map((name) => [name, {
    renderCall(args, _theme, _context) { return lineComponent(callSummary(name, args)); },
    renderResult(result, options, _theme, context) { return lineComponent(resultSummary(name, result, options, context)); },
  }]));
}

export { callSummary, resultSummary };
