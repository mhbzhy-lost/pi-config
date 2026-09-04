const TOOL_NAMES = [
  "goal_init", "goal_status", "goal_dispatch", "goal_settle",
  "goal_integrate", "goal_accept", "goal_amend", "goal_finalize",
];
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const WORD_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

const WORDS = Object.freeze({
  runtime: "运行时", planned: "计划", tasks: "任务", conditions: "条件", goal: "目标", list: "列表", transfer: "转移",
  add: "新增", remove: "移除", update: "更新", error: "错误", running: "运行中", next: "下一步", run: "可运行", block: "阻塞", done: "完成",
  active: "活跃", queued: "排队", pending: "待处理", dispatched: "已派发", settling: "结算中", disposing: "处理中", draft: "草稿", suspended: "已暂停",
  succeeded: "成功", failed: "失败", blocked: "阻塞", completed: "已完成", cancelled: "已取消", ready: "就绪", accepted: "已验收", superseded: "已替代", inactive: "未激活", passed: "通过",
  needs_clarification: "需澄清", environment_blocked: "环境受阻", unsafe_to_run: "不宜运行", calibrating: "校准中",
  partial: "运行中", apply: "应用", discard: "丢弃", preserve: "保留", integrated: "已整合", discarded: "已丢弃", preserved: "已保留",
});

function safe(value, pattern = ID_RE, fallback = "?") {
  return typeof value === "string" && pattern.test(value) ? value : fallback;
}
function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : "0"; }
function length(value) { return Array.isArray(value) ? String(value.length) : "0"; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function localized(value) { return WORDS[value] ?? value; }

// Terminal columns, rather than JavaScript UTF-16 code units. This is the same
// visible-width model used by terminal UIs: combining marks are zero-width and
// East Asian wide characters occupy two columns.
function characterWidth(char) {
  const point = char.codePointAt(0);
  if (point === 0 || (point >= 0x300 && point <= 0x36f) || (point >= 0xfe00 && point <= 0xfe0f)) return 0;
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
    (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe19) || (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x20000 && point <= 0x3fffd)
  ) ? 2 : 1;
}
function visibleWidth(text) { return [...text].reduce((width, char) => width + characterWidth(char), 0); }
function truncateToWidth(text, width, ellipsis = "…") {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  if (width <= ellipsisWidth) return [...ellipsis].reduce((out, char) => visibleWidth(out) + characterWidth(char) <= width ? out + char : out, "");
  let out = "";
  for (const char of text) {
    if (visibleWidth(out) + characterWidth(char) > width - ellipsisWidth) break;
    out += char;
  }
  return `${out}${ellipsis}`;
}
function lineComponent(line) {
  return {
    render(width) {
      const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : visibleWidth(line);
      return limit === 0 ? [] : [truncateToWidth(line, limit)];
    },
    invalidate() {},
  };
}

function callSummary(name, args) {
  const a = object(args);
  switch (name) {
    case "goal_init": {
      const execution = object(a.execution);
      if (execution.schema === "goal-runtime.v1") return `${name} | ${WORDS.runtime} | ${WORDS.tasks} ${length(execution.tasks)} | ${WORDS.conditions} ${length(execution.conditions)}`;
      return `${name} | ${WORDS.planned} | ${WORDS.tasks} ${length(a.tasks)}`;
    }
    case "goal_status":
      if (a.list_cwd_goals === true) return `${name} | ${WORDS.list}`;
      if (Object.hasOwn(a, "transfer_challenge_id")) return `${name} | ${WORDS.transfer} ${safe(a.transfer_challenge_id)}`;
      return `${name} | ${WORDS.goal} ${safe(a.goal_id)}`;
    case "goal_dispatch": return `${name} | ${WORDS.tasks} ${safe(a.task_id)}`;
    case "goal_settle": return `${name} | ${WORDS.tasks} ${safe(a.task_id)} | ${localized(safe(a.outcome, WORD_RE, "pending"))}`;
    case "goal_integrate": return `${name} | ${WORDS.tasks} ${safe(a.task_id)} | ${localized(safe(a.action ?? a.strategy, WORD_RE, "apply"))}`;
    case "goal_accept": return `${name} | ${WORDS.tasks} ${safe(a.task_id)}`;
    case "goal_amend": {
      const changes = object(a.changes);
      const updates = Array.isArray(changes.update_tasks) ? changes.update_tasks.length : Object.keys(object(a.update_tasks)).length;
      return `${name} | ${safe(a.operation, WORD_RE, "update")} | ${WORDS.add} ${length(a.add_tasks)} | ${WORDS.remove} ${length(a.remove_tasks)} | ${WORDS.update} ${updates}`;
    }
    case "goal_finalize": return `${name} | ${WORDS.goal} ${safe(a.goal_id)}`;
    default: return name;
  }
}

function parsedValue(result) {
  const details = object(result?.details);
  if (Object.hasOwn(details, "value")) {
    const value = details.value;
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
  }
  const text = result?.content?.find((part) => part?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
function errorCode(result, value) { return safe(object(result?.error).code ?? object(value?.error).code ?? value?.code, WORD_RE, ""); }
function resultSummary(name, result, options, context) {
  const value = parsedValue(result);
  const code = errorCode(result, value);
  if (context?.isError || result?.isError || result?.error || value?.status === "error" || value?.runtimeState === "error" || code) return `${name} | ${WORDS.error}${code ? ` | ${code}` : ""}`;
  const bits = [];
  if (options?.isPartial || result?.isPartial) bits.push(WORDS.running);
  else {
    const state = value?.status ?? value?.runtimeState ?? value?.lifecycle ?? value?.readiness;
    if (typeof state === "string" && WORD_RE.test(state)) bits.push(localized(state));
  }
  const action = value?.machineAction?.tool;
  if (typeof action === "string" && WORD_RE.test(action)) bits.push(`${WORDS.next} ${action}`);
  const task = value?.task_id ?? value?.taskId;
  if (typeof task === "string" && ID_RE.test(task)) bits.push(`${WORDS.tasks} ${task}`);
  if (Array.isArray(value?.runnable)) bits.push(`${WORDS.run} ${value.runnable.length}`);
  else if (Number.isSafeInteger(value?.runnable_count) && value.runnable_count >= 0) bits.push(`${WORDS.run} ${nonnegative(value.runnable_count)}`);
  if (Array.isArray(value?.blocking)) bits.push(`${WORDS.block} ${value.blocking.length}`);
  else if (Number.isSafeInteger(value?.blocking_count) && value.blocking_count >= 0) bits.push(`${WORDS.block} ${nonnegative(value.blocking_count)}`);
  return `${name} | ${bits.length ? bits.join(" | ") : WORDS.done}`;
}

export function createGoalToolRenderers() {
  return Object.fromEntries(TOOL_NAMES.map((name) => [name, {
    renderCall(args, _theme, _context) { return lineComponent(callSummary(name, args)); },
    renderResult(result, options, _theme, context) { return lineComponent(resultSummary(name, result, options, context)); },
  }]));
}

export { callSummary, resultSummary };
